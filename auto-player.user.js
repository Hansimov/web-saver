// ==UserScript==
// @name         Auto Player
// @namespace    http://tampermonkey.net/
// @version      2026-03-01
// @description  阻止网页在用户离开标签页时暂停音视频播放
// @author       Hansimov
// @match        *://*/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23FF9800' d='M8 5v14l11-7z'/%3E%3C/svg%3E
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    "use strict";

    // =====================================================================
    // 日志
    // =====================================================================
    const LOG_PREFIX = "[Auto Player]";
    const log = (...a) => console.log(LOG_PREFIX, ...a);
    const warn = (...a) => console.warn(LOG_PREFIX, ...a);

    // =====================================================================
    // 设置持久化
    // =====================================================================
    const SETTINGS_KEY = "auto_player_enabled";

    function getEnabled() {
        try { return GM_getValue(SETTINGS_KEY, true); } catch (_) { }
        try {
            const v = localStorage.getItem("ap_" + SETTINGS_KEY);
            return v !== null ? JSON.parse(v) : true;
        } catch (_) { return true; }
    }

    function setEnabled(val) {
        try { GM_setValue(SETTINGS_KEY, val); return; } catch (_) { }
        try { localStorage.setItem("ap_" + SETTINGS_KEY, JSON.stringify(val)); } catch (_) { }
    }

    let enabled = getEnabled();

    // =====================================================================
    // 页面上下文引用
    // =====================================================================
    // 使用 unsafeWindow 确保修改的是页面真实对象，而非油猴沙箱代理
    const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
    const D = W.document;

    // =====================================================================
    // 保存原始 API 引用（在任何修改之前）
    // =====================================================================
    const Orig = {
        // 属性描述符
        docHiddenDesc: Object.getOwnPropertyDescriptor(W.Document.prototype, "hidden"),
        docVisStateDesc: Object.getOwnPropertyDescriptor(W.Document.prototype, "visibilityState"),
        // 方法
        docHasFocus: W.Document.prototype.hasFocus,
        docAddListener: W.Document.prototype.addEventListener,
        docRemoveListener: W.Document.prototype.removeEventListener,
        etAddListener: W.EventTarget.prototype.addEventListener,
        etRemoveListener: W.EventTarget.prototype.removeEventListener,
        // 媒体
        mediaPause: W.HTMLMediaElement.prototype.pause,
        mediaPlay: W.HTMLMediaElement.prototype.play,
        // requestAnimationFrame
        rAF: W.requestAnimationFrame,
        cAF: W.cancelAnimationFrame,
    };

    // =====================================================================
    // 菜单命令：切换启用/禁用
    // =====================================================================
    function registerMenu() {
        try {
            if (typeof GM_registerMenuCommand === "function") {
                GM_registerMenuCommand(
                    enabled ? "🔊 Auto Player: 已启用（点击禁用）" : "🔇 Auto Player: 已禁用（点击启用）",
                    () => {
                        enabled = !enabled;
                        setEnabled(enabled);
                        if (enabled) {
                            activate();
                            log("已启用");
                        } else {
                            deactivate();
                            log("已禁用");
                        }
                        location.reload();
                    }
                );
            }
        } catch (_) { }
    }

    // =====================================================================
    // 工具：检查页面是否真的隐藏（绕过覆盖）
    // =====================================================================
    function isPageActuallyHidden() {
        try {
            if (Orig.docHiddenDesc && Orig.docHiddenDesc.get) {
                return Orig.docHiddenDesc.get.call(D);
            }
        } catch (_) { }
        return false;
    }

    // =====================================================================
    // 模块 A：Visibility API 覆盖
    // =====================================================================
    // 同时覆盖 Document.prototype（原型链）和 document 实例，
    // 确保无论网站通过哪条路径访问都返回"可见"状态

    function overrideVisibilityAPI() {
        const targets = [W.Document.prototype, D];
        for (const t of targets) {
            Object.defineProperty(t, "hidden", {
                configurable: true,
                get: () => false,
            });
            Object.defineProperty(t, "visibilityState", {
                configurable: true,
                get: () => "visible",
            });
        }
        W.Document.prototype.hasFocus = function () { return true; };
        D.hasFocus = function () { return true; };
        log("Visibility API 已覆盖（含原型链）");
    }

    function restoreVisibilityAPI() {
        if (Orig.docHiddenDesc) {
            Object.defineProperty(W.Document.prototype, "hidden", Orig.docHiddenDesc);
        }
        if (Orig.docVisStateDesc) {
            Object.defineProperty(W.Document.prototype, "visibilityState", Orig.docVisStateDesc);
        }
        W.Document.prototype.hasFocus = Orig.docHasFocus;
        // 删除实例覆盖，恢复原型链
        try { delete D.hidden; } catch (_) { }
        try { delete D.visibilityState; } catch (_) { }
        try { delete D.hasFocus; } catch (_) { }
        log("Visibility API 已恢复");
    }

    // =====================================================================
    // 模块 B：捕获阶段事件拦截器
    // =====================================================================
    // 这是最关键的防御：以捕获阶段注册拦截器，
    // 利用 stopImmediatePropagation 阻止所有后续监听器收到事件，
    // 无论这些监听器何时注册、以何种方式注册。

    /** document 上要拦截的事件 */
    const DOC_CAPTURE_EVENTS = [
        "visibilitychange", "webkitvisibilitychange", "mozvisibilitychange",
    ];

    /** window 上要拦截的事件 */
    const WIN_CAPTURE_EVENTS = [
        "blur", "focus",
    ];

    const captureHandlers = { doc: null, win: null };

    function installCaptureBlockers() {
        if (captureHandlers.doc) return; // 幂等

        captureHandlers.doc = function (e) {
            if (enabled) {
                e.stopImmediatePropagation();
                e.stopPropagation();
            }
        };
        captureHandlers.win = function (e) {
            if (enabled) {
                e.stopImmediatePropagation();
                e.stopPropagation();
            }
        };

        for (const evt of DOC_CAPTURE_EVENTS) {
            Orig.docAddListener.call(D, evt, captureHandlers.doc, true);
        }
        for (const evt of WIN_CAPTURE_EVENTS) {
            Orig.etAddListener.call(W, evt, captureHandlers.win, true);
        }
        log("捕获阶段拦截器已安装（document + window）");
    }

    function removeCaptureBlockers() {
        if (captureHandlers.doc) {
            for (const evt of DOC_CAPTURE_EVENTS) {
                Orig.docRemoveListener.call(D, evt, captureHandlers.doc, true);
            }
        }
        if (captureHandlers.win) {
            for (const evt of WIN_CAPTURE_EVENTS) {
                Orig.etRemoveListener.call(W, evt, captureHandlers.win, true);
            }
        }
        captureHandlers.doc = null;
        captureHandlers.win = null;
        log("捕获阶段拦截器已移除");
    }

    // =====================================================================
    // 模块 C：addEventListener 拦截
    // =====================================================================
    // 替换 addEventListener，阻止页面脚本注册失焦相关的监听器。
    // 作为捕获拦截器的辅助防线：即使未拦截到，事件也不会有处理器接收。

    /** document 上阻止注册的事件 */
    const DOC_BLOCKED_EVENTS = [
        "visibilitychange", "webkitvisibilitychange", "mozvisibilitychange",
    ];

    /** window 上阻止注册的事件 */
    const WIN_BLOCKED_EVENTS = [
        "blur", "focus",
    ];

    let addEventListenersIntercepted = false;

    function interceptAddEventListeners() {
        if (addEventListenersIntercepted) return;
        addEventListenersIntercepted = true;

        W.Document.prototype.addEventListener = function (type, listener, options) {
            if (enabled && DOC_BLOCKED_EVENTS.includes(type)) {
                log(`拦截 document.addEventListener("${type}")`);
                return;
            }
            return Orig.docAddListener.call(this, type, listener, options);
        };

        W.EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (enabled) {
                if (this === W && WIN_BLOCKED_EVENTS.includes(type)) {
                    log(`拦截 window.addEventListener("${type}")`);
                    return;
                }
                // document 也可能通过 EventTarget 路径调用
                if (this === D && DOC_BLOCKED_EVENTS.includes(type)) {
                    log(`拦截 document.addEventListener("${type}") [via EventTarget]`);
                    return;
                }
            }
            return Orig.etAddListener.call(this, type, listener, options);
        };
        log("addEventListener 拦截已安装");
    }

    function restoreAddEventListeners() {
        if (!addEventListenersIntercepted) return;
        W.Document.prototype.addEventListener = Orig.docAddListener;
        W.EventTarget.prototype.addEventListener = Orig.etAddListener;
        addEventListenersIntercepted = false;
        log("addEventListener 拦截已恢复");
    }

    // =====================================================================
    // 模块 D：on* 属性处理器拦截
    // =====================================================================
    // 阻止网页通过 window.onblur = fn / document.onvisibilitychange = fn
    // 等属性赋值方式注册事件处理器。

    const savedOnHandlerDescs = {};
    let onHandlersOverridden = false;

    function overrideOnHandlers() {
        if (onHandlersOverridden) return;
        onHandlersOverridden = true;

        const overrides = [
            [D, "doc", ["onvisibilitychange"]],
            [W, "win", ["onblur", "onfocus"]],
        ];

        for (const [target, prefix, props] of overrides) {
            for (const prop of props) {
                const key = prefix + "." + prop;
                savedOnHandlerDescs[key] = {
                    target,
                    prop,
                    desc: Object.getOwnPropertyDescriptor(target, prop)
                        || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), prop),
                };
                Object.defineProperty(target, prop, {
                    configurable: true,
                    get: () => null,
                    set: (v) => { log(`拦截 ${key} 属性设置`); },
                });
            }
        }
        log("on* 属性处理器拦截已安装");
    }

    function restoreOnHandlers() {
        if (!onHandlersOverridden) return;
        for (const [key, { target, prop, desc }] of Object.entries(savedOnHandlerDescs)) {
            if (desc) {
                try { Object.defineProperty(target, prop, desc); } catch (_) { }
            } else {
                try { delete target[prop]; } catch (_) { }
            }
        }
        onHandlersOverridden = false;
        log("on* 属性处理器拦截已恢复");
    }

    // =====================================================================
    // 模块 E：requestAnimationFrame 伪装
    // =====================================================================
    // 浏览器在标签页隐藏时暂停 rAF 回调。
    // 某些网站利用 rAF 停止来检测标签页隐藏状态。
    // 当页面实际隐藏时，用 setTimeout(16ms) 模拟 ~60fps 的 rAF。

    let rAFSpoofed = false;
    let rAFIdCounter = 900000; // 高起始值，避免与真实 rAF ID 冲突
    const rAFPending = new Map();

    function spoofRAF() {
        if (rAFSpoofed) return;
        rAFSpoofed = true;

        W.requestAnimationFrame = function (callback) {
            if (enabled && isPageActuallyHidden()) {
                const id = ++rAFIdCounter;
                const tid = setTimeout(() => {
                    rAFPending.delete(id);
                    try { callback(performance.now()); } catch (_) { }
                }, 16);
                rAFPending.set(id, tid);
                return id;
            }
            return Orig.rAF.call(W, callback);
        };

        W.cancelAnimationFrame = function (id) {
            if (rAFPending.has(id)) {
                clearTimeout(rAFPending.get(id));
                rAFPending.delete(id);
                return;
            }
            return Orig.cAF.call(W, id);
        };
        log("requestAnimationFrame 伪装已启用");
    }

    function restoreRAF() {
        if (!rAFSpoofed) return;
        W.requestAnimationFrame = Orig.rAF;
        W.cancelAnimationFrame = Orig.cAF;
        rAFPending.forEach((tid) => clearTimeout(tid));
        rAFPending.clear();
        rAFSpoofed = false;
        log("requestAnimationFrame 伪装已恢复");
    }

    // =====================================================================
    // 模块 F：媒体保护
    // =====================================================================
    // 跟踪媒体播放状态，拦截由页面隐藏引起的 pause() 调用，
    // 并在媒体被意外暂停时自动恢复播放。

    const activeMedia = new WeakSet();   // 正在播放
    const userPaused = new WeakSet();    // 用户主动暂停

    let pauseIntercepted = false;

    function interceptMediaPause() {
        if (pauseIntercepted) return;
        pauseIntercepted = true;

        W.HTMLMediaElement.prototype.pause = function () {
            if (enabled && isPageActuallyHidden()) {
                if (activeMedia.has(this) && !this.paused) {
                    log("阻止了页面隐藏引起的 pause() 调用");
                    return;
                }
            }
            userPaused.add(this);
            activeMedia.delete(this);
            return Orig.mediaPause.call(this);
        };
        log("媒体 pause() 拦截已启用");
    }

    function restoreMediaPause() {
        if (!pauseIntercepted) return;
        W.HTMLMediaElement.prototype.pause = Orig.mediaPause;
        pauseIntercepted = false;
        log("媒体 pause() 拦截已恢复");
    }

    /** 跟踪一个媒体元素的 play/pause 状态 */
    function trackMedia(el) {
        if (el._apTracked) return;
        el._apTracked = true;

        el.addEventListener("play", () => {
            activeMedia.add(el);
            userPaused.delete(el);
        });

        el.addEventListener("pause", () => {
            if (enabled && isPageActuallyHidden()
                && activeMedia.has(el) && !userPaused.has(el)) {
                log("检测到活跃媒体被暂停，尝试恢复播放");
                setTimeout(() => {
                    if (el.paused && !userPaused.has(el)) {
                        Orig.mediaPlay.call(el).catch(() => { });
                    }
                }, 50);
            }
        });

        if (!el.paused) {
            activeMedia.add(el);
        }
    }

    /** 扫描页面上已有的媒体元素 */
    function scanMedia() {
        const els = D.querySelectorAll("video, audio");
        els.forEach(trackMedia);
        if (els.length > 0) {
            log(`已跟踪 ${els.length} 个媒体元素`);
        }
    }

    // =====================================================================
    // 模块 G：MutationObserver 监控新增媒体元素
    // =====================================================================
    let mediaObserver = null;

    function startMediaObserver() {
        if (mediaObserver) return;

        mediaObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
                        trackMedia(node);
                    }
                    node.querySelectorAll?.("video, audio")?.forEach(trackMedia);
                }
            }
        });

        const root = D.documentElement || D.body;
        if (root) {
            mediaObserver.observe(root, { childList: true, subtree: true });
            log("媒体元素监控已启动");
        }
    }

    function stopMediaObserver() {
        if (mediaObserver) {
            mediaObserver.disconnect();
            mediaObserver = null;
            log("媒体元素监控已停止");
        }
    }

    // =====================================================================
    // 模块 H：定时轮询保障
    // =====================================================================
    let pollTimer = null;
    const POLL_INTERVAL = 500;

    function startPollGuard() {
        if (pollTimer) return;

        pollTimer = setInterval(() => {
            if (!enabled || !isPageActuallyHidden()) return;

            D.querySelectorAll("video, audio").forEach((el) => {
                trackMedia(el);
                if (el.paused && activeMedia.has(el) && !userPaused.has(el)) {
                    log("轮询恢复：活跃媒体被暂停，恢复播放");
                    Orig.mediaPlay.call(el).catch(() => { });
                }
            });
        }, POLL_INTERVAL);

        log("轮询保障已启动");
    }

    function stopPollGuard() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
            log("轮询保障已停止");
        }
    }

    // =====================================================================
    // 模块 I：覆盖保护（定时重新应用）
    // =====================================================================
    // 某些网站可能尝试恢复原始 API，定时检测并重新应用覆盖。
    let protectTimer = null;

    function startOverrideProtection() {
        if (protectTimer) return;

        protectTimer = setInterval(() => {
            if (!enabled) return;
            try {
                if (D.hidden !== false || D.visibilityState !== "visible") {
                    overrideVisibilityAPI();
                    log("检测到覆盖被移除，已重新应用");
                }
            } catch (_) { }
        }, 2000);
    }

    function stopOverrideProtection() {
        if (protectTimer) {
            clearInterval(protectTimer);
            protectTimer = null;
        }
    }

    // =====================================================================
    // 状态指示器（UI 反馈）
    // =====================================================================
    let indicator = null;

    function createIndicator() {
        if (indicator) return;

        indicator = D.createElement("div");
        indicator.id = "auto-player-indicator";
        indicator.textContent = "▶";
        indicator.title = "Auto Player 已启用";

        const style = `
            #auto-player-indicator {
                position: fixed;
                bottom: 10px;
                right: 10px;
                width: 28px;
                height: 28px;
                line-height: 28px;
                text-align: center;
                font-size: 14px;
                background: rgba(255, 152, 0, 0.85);
                color: #fff;
                border-radius: 50%;
                z-index: 2147483647;
                cursor: pointer;
                user-select: none;
                transition: opacity 0.3s;
                opacity: 0.6;
                pointer-events: auto;
            }
            #auto-player-indicator:hover {
                opacity: 1;
            }
        `;

        try {
            if (typeof GM_addStyle === "function") {
                GM_addStyle(style);
            } else {
                const s = D.createElement("style");
                s.textContent = style;
                (D.head || D.documentElement).appendChild(s);
            }
        } catch (_) {
            const s = D.createElement("style");
            s.textContent = style;
            (D.head || D.documentElement).appendChild(s);
        }

        indicator.addEventListener("click", () => {
            enabled = !enabled;
            setEnabled(enabled);
            updateIndicator();
            if (enabled) {
                activate();
            } else {
                deactivate();
            }
        });

        D.body.appendChild(indicator);
    }

    function updateIndicator() {
        if (!indicator) return;
        if (enabled) {
            indicator.textContent = "▶";
            indicator.title = "Auto Player 已启用（点击禁用）";
            indicator.style.background = "rgba(255, 152, 0, 0.85)";
        } else {
            indicator.textContent = "⏸";
            indicator.title = "Auto Player 已禁用（点击启用）";
            indicator.style.background = "rgba(158, 158, 158, 0.85)";
        }
    }

    function removeIndicator() {
        if (indicator && indicator.parentNode) {
            indicator.parentNode.removeChild(indicator);
            indicator = null;
        }
    }

    // =====================================================================
    // 激活 / 停用
    // =====================================================================
    function activate() {
        overrideVisibilityAPI();        // A: 覆盖 Visibility API（含原型链）
        installCaptureBlockers();       // B: 捕获阶段拦截器（document + window）
        interceptAddEventListeners();   // C: addEventListener 拦截
        overrideOnHandlers();           // D: on* 属性处理器拦截
        spoofRAF();                     // E: requestAnimationFrame 伪装
        interceptMediaPause();          // F: 媒体 pause 拦截

        if (D.readyState === "loading") {
            Orig.docAddListener.call(D, "DOMContentLoaded", onDomReady);
        } else {
            onDomReady();
        }

        log("已激活");
    }

    function onDomReady() {
        scanMedia();                    // 扫描已有媒体
        startMediaObserver();           // G: 监控新增媒体
        startPollGuard();               // H: 轮询保障
        startOverrideProtection();      // I: 覆盖保护
        createIndicator();
        updateIndicator();
    }

    function deactivate() {
        restoreVisibilityAPI();
        removeCaptureBlockers();
        restoreAddEventListeners();
        restoreOnHandlers();
        restoreRAF();
        restoreMediaPause();
        stopMediaObserver();
        stopPollGuard();
        stopOverrideProtection();
        updateIndicator();

        log("已停用");
    }

    // =====================================================================
    // 入口
    // =====================================================================
    registerMenu();

    if (enabled) {
        activate();
    }

    log("脚本初始化完成，状态:", enabled ? "启用" : "禁用");
})();
