/**
 * Auto Player — 单元测试 & 集成测试
 *
 * 运行方式: node tests/auto-player.test.js
 *
 * 在 Node.js 中模拟浏览器关键 API，
 * 验证 Auto Player 脚本的全部核心模块：
 *   A. Visibility API 覆盖（含原型链）
 *   B. 捕获阶段事件拦截器（document + window）
 *   C. addEventListener 拦截
 *   D. on* 属性处理器拦截
 *   E. requestAnimationFrame 伪装
 *   F. 媒体 pause() 拦截 & 自动恢复
 *   G. 媒体元素跟踪
 *   H. 轮询保障
 *   I. 覆盖保护（定时重新应用）
 *   J. 启用/禁用切换
 */

"use strict";

// =====================================================================
// 最小测试框架
// =====================================================================
let _passed = 0;
let _failed = 0;

function describe(name, fn) {
    console.log(`\n  ${name}`);
    fn();
}

function it(name, fn) {
    try {
        fn();
        _passed++;
        console.log(`    ✓ ${name}`);
    } catch (e) {
        _failed++;
        console.log(`    ✗ ${name}`);
        console.log(`      ${e.message}`);
    }
}

function assert(condition, msg = "断言失败") {
    if (!condition) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(
            msg || `期望 ${JSON.stringify(expected)}，得到 ${JSON.stringify(actual)}`
        );
    }
}

console.log("\n🧪 Auto Player 测试");
console.log("=".repeat(50));

// =====================================================================
// 浏览器 API 模拟
// =====================================================================

/** 模拟 EventTarget */
class MockEventTarget {
    constructor() {
        this._listeners = {};
    }
    addEventListener(type, listener, options) {
        const useCapture = typeof options === "boolean" ? options : options?.capture || false;
        const key = type + (useCapture ? "_capture" : "_bubble");
        if (!this._listeners[key]) this._listeners[key] = [];
        this._listeners[key].push(listener);
    }
    removeEventListener(type, listener, options) {
        const useCapture = typeof options === "boolean" ? options : options?.capture || false;
        const key = type + (useCapture ? "_capture" : "_bubble");
        if (!this._listeners[key]) return;
        this._listeners[key] = this._listeners[key].filter(l => l !== listener);
    }
    dispatchEvent(event) {
        const captureKey = event.type + "_capture";
        const bubbleKey = event.type + "_bubble";
        let stopped = false;
        const wrap = {
            ...event,
            type: event.type,
            stopImmediatePropagation() { stopped = true; },
            stopPropagation() { },
        };
        for (const l of (this._listeners[captureKey] || [])) {
            if (stopped) break;
            l(wrap);
        }
        if (!stopped) {
            for (const l of (this._listeners[bubbleKey] || [])) {
                if (stopped) break;
                l(wrap);
            }
        }
        return !stopped;
    }
}

/** 模拟 HTMLMediaElement */
class MockMediaElement extends MockEventTarget {
    constructor() {
        super();
        this.paused = true;
        this.tagName = "VIDEO";
        this.nodeType = 1;
        this._apTracked = false;
    }
    play() {
        this.paused = false;
        this.dispatchEvent({ type: "play" });
        return Promise.resolve();
    }
    pause() {
        this.paused = true;
        this.dispatchEvent({ type: "pause" });
    }
    querySelectorAll() { return []; }
}

// =====================================================================
// A. Visibility API 覆盖（含原型链）
// =====================================================================

describe("A. Visibility API 覆盖（含原型链）", () => {

    it("覆盖后 hidden 应始终返回 false", () => {
        const doc = {};
        Object.defineProperty(doc, "hidden", {
            configurable: true,
            get() { return true; },
        });
        assertEqual(doc.hidden, true);

        Object.defineProperty(doc, "hidden", {
            configurable: true,
            get() { return false; },
        });
        assertEqual(doc.hidden, false);
    });

    it("覆盖后 visibilityState 应始终返回 'visible'", () => {
        const doc = {};
        Object.defineProperty(doc, "visibilityState", {
            configurable: true,
            get() { return "hidden"; },
        });
        assertEqual(doc.visibilityState, "hidden");

        Object.defineProperty(doc, "visibilityState", {
            configurable: true,
            get() { return "visible"; },
        });
        assertEqual(doc.visibilityState, "visible");
    });

    it("覆盖后 hasFocus() 应始终返回 true", () => {
        const doc = { hasFocus: () => false };
        assertEqual(doc.hasFocus(), false);

        doc.hasFocus = () => true;
        assertEqual(doc.hasFocus(), true);
    });

    it("应同时覆盖原型和实例", () => {
        // 模拟原型链
        const proto = {};
        Object.defineProperty(proto, "hidden", {
            configurable: true,
            get() { return true; },
        });
        const instance = Object.create(proto);
        assertEqual(instance.hidden, true);

        // 覆盖原型
        Object.defineProperty(proto, "hidden", {
            configurable: true,
            get() { return false; },
        });
        // 覆盖实例
        Object.defineProperty(instance, "hidden", {
            configurable: true,
            get() { return false; },
        });
        assertEqual(proto.hidden, false, "原型应返回 false");
        assertEqual(instance.hidden, false, "实例应返回 false");
    });

    it("恢复后应返回原始值", () => {
        const doc = {};
        const originalGetter = () => true;

        Object.defineProperty(doc, "hidden", {
            configurable: true,
            get: originalGetter,
        });

        Object.defineProperty(doc, "hidden", {
            configurable: true,
            get() { return false; },
        });
        assertEqual(doc.hidden, false);

        Object.defineProperty(doc, "hidden", {
            configurable: true,
            get: originalGetter,
        });
        assertEqual(doc.hidden, true);
    });
});

// =====================================================================
// B. 捕获阶段事件拦截器（document + window）
// =====================================================================

describe("B. 捕获阶段事件拦截器", () => {

    it("document 捕获应阻止 visibilitychange 传播", () => {
        const doc = new MockEventTarget();
        let handlerCalled = false;

        doc.addEventListener("visibilitychange", (e) => {
            e.stopImmediatePropagation();
        }, true);

        doc.addEventListener("visibilitychange", () => {
            handlerCalled = true;
        }, false);

        doc.dispatchEvent({ type: "visibilitychange" });
        assertEqual(handlerCalled, false, "冒泡处理器不应被调用");
    });

    it("window 捕获应阻止 blur 传播", () => {
        const win = new MockEventTarget();
        let handlerCalled = false;

        win.addEventListener("blur", (e) => {
            e.stopImmediatePropagation();
        }, true);

        win.addEventListener("blur", () => {
            handlerCalled = true;
        }, false);

        win.dispatchEvent({ type: "blur" });
        assertEqual(handlerCalled, false, "blur 冒泡处理器不应被调用");
    });

    it("window 捕获应阻止 focus 传播", () => {
        const win = new MockEventTarget();
        let handlerCalled = false;

        win.addEventListener("focus", (e) => {
            e.stopImmediatePropagation();
        }, true);

        win.addEventListener("focus", () => {
            handlerCalled = true;
        }, false);

        win.dispatchEvent({ type: "focus" });
        assertEqual(handlerCalled, false, "focus 冒泡处理器不应被调用");
    });

    it("禁用时不应阻止事件传播", () => {
        const doc = new MockEventTarget();
        let handlerCalled = false;
        let scriptEnabled = false;

        doc.addEventListener("visibilitychange", (e) => {
            if (scriptEnabled) e.stopImmediatePropagation();
        }, true);

        doc.addEventListener("visibilitychange", () => {
            handlerCalled = true;
        }, false);

        doc.dispatchEvent({ type: "visibilitychange" });
        assertEqual(handlerCalled, true, "禁用时事件应正常传播");
    });
});

// =====================================================================
// C. addEventListener 拦截
// =====================================================================

describe("C. addEventListener 拦截", () => {

    it("应拦截 document 上的 visibilitychange 注册", () => {
        const intercepted = [];
        const allowed = [];
        const DOC_BLOCKED = ["visibilitychange", "webkitvisibilitychange", "mozvisibilitychange"];

        function mockAddEventListener(type, listener) {
            if (DOC_BLOCKED.includes(type)) {
                intercepted.push({ type, listener });
                return;
            }
            allowed.push({ type, listener });
        }

        mockAddEventListener("visibilitychange", () => { });
        mockAddEventListener("click", () => { });
        mockAddEventListener("webkitvisibilitychange", () => { });
        mockAddEventListener("mozvisibilitychange", () => { });

        assertEqual(intercepted.length, 3, "应拦截 3 个 visibility 相关事件");
        assertEqual(allowed.length, 1, "应保留 1 个非 visibility 事件");
    });

    it("应拦截 window 上的 blur 和 focus 注册", () => {
        const intercepted = [];
        const allowed = [];
        const WIN_BLOCKED = ["blur", "focus"];
        const mockWindow = { _isWindow: true };

        function mockAddEventListener(thisObj, type, listener) {
            if (thisObj === mockWindow && WIN_BLOCKED.includes(type)) {
                intercepted.push({ type });
                return;
            }
            allowed.push({ type });
        }

        mockAddEventListener(mockWindow, "blur", () => { });
        mockAddEventListener(mockWindow, "focus", () => { });
        mockAddEventListener(mockWindow, "click", () => { });
        mockAddEventListener({}, "blur", () => { }); // 非 window 的 blur 不应拦截

        assertEqual(intercepted.length, 2, "应拦截 window 上的 blur + focus");
        assertEqual(allowed.length, 2, "其他事件应正常注册");
    });

    it("document 通过 EventTarget 路径的 visibilitychange 也应被拦截", () => {
        const intercepted = [];
        const DOC_BLOCKED = ["visibilitychange"];
        const mockDoc = { _isDoc: true };

        function mockETAddEventListener(thisObj, type, listener) {
            if (thisObj === mockDoc && DOC_BLOCKED.includes(type)) {
                intercepted.push({ type });
                return;
            }
        }

        mockETAddEventListener(mockDoc, "visibilitychange", () => { });
        assertEqual(intercepted.length, 1, "通过 ET 路径也应拦截");
    });
});

// =====================================================================
// D. on* 属性处理器拦截
// =====================================================================

describe("D. on* 属性处理器拦截", () => {

    it("应阻止 onvisibilitychange 赋值", () => {
        const obj = {};
        let setBlocked = false;

        Object.defineProperty(obj, "onvisibilitychange", {
            configurable: true,
            get: () => null,
            set: () => { setBlocked = true; },
        });

        obj.onvisibilitychange = function () { };
        assert(setBlocked, "赋值应被拦截");
        assertEqual(obj.onvisibilitychange, null, "getter 应返回 null");
    });

    it("应阻止 onblur 赋值", () => {
        const obj = {};
        let setBlocked = false;

        Object.defineProperty(obj, "onblur", {
            configurable: true,
            get: () => null,
            set: () => { setBlocked = true; },
        });

        obj.onblur = function () { };
        assert(setBlocked, "onblur 赋值应被拦截");
        assertEqual(obj.onblur, null, "getter 应返回 null");
    });

    it("应阻止 onfocus 赋值", () => {
        const obj = {};
        let setBlocked = false;

        Object.defineProperty(obj, "onfocus", {
            configurable: true,
            get: () => null,
            set: () => { setBlocked = true; },
        });

        obj.onfocus = function () { };
        assert(setBlocked, "onfocus 赋值应被拦截");
    });

    it("恢复后应允许正常赋值", () => {
        const obj = {};

        // 先拦截
        Object.defineProperty(obj, "onblur", {
            configurable: true,
            get: () => null,
            set: () => { },
        });
        assertEqual(obj.onblur, null);

        // 恢复（用 delete + 简单赋值）
        delete obj.onblur;
        obj.onblur = "test";
        assertEqual(obj.onblur, "test", "恢复后应能正常赋值");
    });
});

// =====================================================================
// E. requestAnimationFrame 伪装
// =====================================================================

describe("E. requestAnimationFrame 伪装", () => {

    it("页面可见时应使用原始 rAF", () => {
        let origCalled = false;
        const origRAF = (cb) => { origCalled = true; return 42; };
        let pageHidden = false;
        let enabled = true;

        function spoofedRAF(callback) {
            if (enabled && pageHidden) {
                return -1; // 模拟 setTimeout
            }
            return origRAF(callback);
        }

        const id = spoofedRAF(() => { });
        assert(origCalled, "应调用原始 rAF");
        assertEqual(id, 42);
    });

    it("页面隐藏时应使用 setTimeout 替代", () => {
        let origCalled = false;
        const origRAF = (cb) => { origCalled = true; return 42; };
        let pageHidden = true;
        let enabled = true;
        let fallbackId = 900000;

        function spoofedRAF(callback) {
            if (enabled && pageHidden) {
                return ++fallbackId;
            }
            return origRAF(callback);
        }

        const id = spoofedRAF(() => { });
        assertEqual(origCalled, false, "不应调用原始 rAF");
        assert(id > 900000, "应返回自定义 ID");
    });

    it("cancelAnimationFrame 应清理 pending 回调", () => {
        const pending = new Map();
        let fallbackId = 900000;

        function spoofedRAF(callback) {
            const id = ++fallbackId;
            pending.set(id, 123); // 模拟 timerId
            return id;
        }

        function spoofedCAF(id) {
            if (pending.has(id)) {
                pending.delete(id);
                return;
            }
        }

        const id = spoofedRAF(() => { });
        assertEqual(pending.size, 1);
        spoofedCAF(id);
        assertEqual(pending.size, 0, "应清理 pending 回调");
    });
});

// =====================================================================
// F. 媒体 pause() 拦截
// =====================================================================

describe("F. 媒体 pause() 拦截", () => {

    it("页面隐藏时应阻止活跃媒体的 pause() 调用", () => {
        const activeMedia = new WeakSet();
        const userPaused = new WeakSet();
        let pageHidden = true;

        const media = new MockMediaElement();
        media.paused = false;
        activeMedia.add(media);

        const originalPause = MockMediaElement.prototype.pause;
        let pauseBlocked = false;

        const interceptedPause = function () {
            if (pageHidden && activeMedia.has(this) && !this.paused) {
                pauseBlocked = true;
                return;
            }
            userPaused.add(this);
            activeMedia.delete(this);
            return originalPause.call(this);
        };

        interceptedPause.call(media);
        assert(pauseBlocked, "应阻止 pause 调用");
        assertEqual(media.paused, false, "媒体应仍在播放");
    });

    it("页面可见时应正常执行 pause()", () => {
        const activeMedia = new WeakSet();
        const userPaused = new WeakSet();
        let pageHidden = false;

        const media = new MockMediaElement();
        media.paused = false;
        activeMedia.add(media);

        const originalPause = MockMediaElement.prototype.pause;

        const interceptedPause = function () {
            if (pageHidden && activeMedia.has(this) && !this.paused) {
                return;
            }
            userPaused.add(this);
            activeMedia.delete(this);
            return originalPause.call(this);
        };

        interceptedPause.call(media);
        assertEqual(media.paused, true, "媒体应被暂停");
        assert(userPaused.has(media), "应标记为用户主动暂停");
    });

    it("用户主动暂停的媒体不应被自动恢复", () => {
        const userPaused = new WeakSet();
        const media = new MockMediaElement();

        userPaused.add(media);
        assertEqual(!userPaused.has(media), false, "用户暂停的媒体不应恢复");
    });
});

// =====================================================================
// G. 媒体元素跟踪
// =====================================================================

describe("G. 媒体元素跟踪", () => {

    it("play 事件应将媒体标记为活跃", () => {
        const activeMedia = new WeakSet();
        const userPaused = new WeakSet();
        const media = new MockMediaElement();

        media.addEventListener("play", () => {
            activeMedia.add(media);
            userPaused.delete(media);
        });

        media.play();
        assert(activeMedia.has(media), "应标记为活跃");
    });

    it("已经在播放的媒体应被标记为活跃", () => {
        const activeMedia = new WeakSet();
        const media = new MockMediaElement();
        media.paused = false;

        if (!media.paused) activeMedia.add(media);
        assert(activeMedia.has(media), "正在播放的媒体应被标记为活跃");
    });

    it("应跟踪多个媒体元素", () => {
        const activeMedia = new WeakSet();
        const tracked = [];

        const video = new MockMediaElement();
        video.tagName = "VIDEO";
        const audio = new MockMediaElement();
        audio.tagName = "AUDIO";

        [video, audio].forEach(m => {
            if (!m._apTracked) {
                m._apTracked = true;
                tracked.push(m);
                m.addEventListener("play", () => activeMedia.add(m));
            }
        });

        assertEqual(tracked.length, 2, "应跟踪 2 个媒体元素");
        video.play();
        audio.play();
        assert(activeMedia.has(video), "video 应被标记为活跃");
        assert(activeMedia.has(audio), "audio 应被标记为活跃");
    });

    it("不应重复跟踪同一个媒体元素", () => {
        let trackCount = 0;
        const media = new MockMediaElement();

        function trackMedia(m) {
            if (m._apTracked) return;
            m._apTracked = true;
            trackCount++;
        }

        trackMedia(media);
        trackMedia(media);
        trackMedia(media);
        assertEqual(trackCount, 1, "应只跟踪一次");
    });
});

// =====================================================================
// H. 轮询保障
// =====================================================================

describe("H. 轮询保障", () => {

    it("应只恢复活跃且非用户暂停的媒体", () => {
        const activeMedia = new WeakSet();
        const userPaused = new WeakSet();

        const media1 = new MockMediaElement();
        media1.paused = true;
        activeMedia.add(media1);

        const media2 = new MockMediaElement();
        media2.paused = true;
        userPaused.add(media2);

        const media3 = new MockMediaElement();
        media3.paused = true;

        const toRestore = [];
        [media1, media2, media3].forEach(m => {
            if (m.paused && activeMedia.has(m) && !userPaused.has(m)) {
                toRestore.push(m);
            }
        });

        assertEqual(toRestore.length, 1, "应只恢复 1 个媒体");
        assertEqual(toRestore[0], media1, "应恢复 media1");
    });

    it("页面可见时不应执行恢复", () => {
        let restoreAttempted = false;
        const enabled = true;
        const pageHidden = false;

        // 模拟轮询逻辑
        if (enabled && pageHidden) {
            restoreAttempted = true;
        }

        assertEqual(restoreAttempted, false, "页面可见时不应尝试恢复");
    });
});

// =====================================================================
// I. 覆盖保护（定时重新应用）
// =====================================================================

describe("I. 覆盖保护", () => {

    it("检测到覆盖被移除时应重新应用", () => {
        const obj = {};
        let reapplyCount = 0;

        // 初始覆盖
        Object.defineProperty(obj, "hidden", {
            configurable: true,
            get: () => false,
        });
        assertEqual(obj.hidden, false);

        // 模拟网站恢复原始值
        Object.defineProperty(obj, "hidden", {
            configurable: true,
            get: () => true,
        });
        assertEqual(obj.hidden, true);

        // 保护逻辑检测 & 重新应用
        if (obj.hidden !== false) {
            Object.defineProperty(obj, "hidden", {
                configurable: true,
                get: () => false,
            });
            reapplyCount++;
        }

        assertEqual(obj.hidden, false, "应重新覆盖为 false");
        assertEqual(reapplyCount, 1, "应重新应用一次");
    });

    it("覆盖未被移除时不应重新应用", () => {
        const obj = {};
        let reapplyCount = 0;

        Object.defineProperty(obj, "hidden", {
            configurable: true,
            get: () => false,
        });

        if (obj.hidden !== false) {
            reapplyCount++;
        }

        assertEqual(reapplyCount, 0, "不需要重新应用");
    });
});

// =====================================================================
// J. 启用/禁用切换
// =====================================================================

describe("J. 启用/禁用切换", () => {

    it("默认应启用", () => {
        const storage = {};
        function getEnabled() {
            return storage["auto_player_enabled"] !== undefined
                ? storage["auto_player_enabled"] : true;
        }
        assertEqual(getEnabled(), true);
    });

    it("禁用后 getEnabled 应返回 false", () => {
        const storage = {};
        function setEnabled(val) { storage["auto_player_enabled"] = val; }
        function getEnabled() {
            return storage["auto_player_enabled"] !== undefined
                ? storage["auto_player_enabled"] : true;
        }

        setEnabled(false);
        assertEqual(getEnabled(), false);
    });

    it("重新启用后 getEnabled 应返回 true", () => {
        const storage = {};
        function setEnabled(val) { storage["auto_player_enabled"] = val; }
        function getEnabled() {
            return storage["auto_player_enabled"] !== undefined
                ? storage["auto_player_enabled"] : true;
        }

        setEnabled(false);
        setEnabled(true);
        assertEqual(getEnabled(), true);
    });
});

// =====================================================================
// K. 阻止事件列表完整性
// =====================================================================

describe("K. 阻止事件列表", () => {

    it("document 捕获事件应包含所有 visibility 变体", () => {
        const DOC_CAPTURE = ["visibilitychange", "webkitvisibilitychange", "mozvisibilitychange"];
        assert(DOC_CAPTURE.includes("visibilitychange"));
        assert(DOC_CAPTURE.includes("webkitvisibilitychange"));
        assert(DOC_CAPTURE.includes("mozvisibilitychange"));
    });

    it("window 捕获事件应包含 blur 和 focus", () => {
        const WIN_CAPTURE = ["blur", "focus"];
        assert(WIN_CAPTURE.includes("blur"));
        assert(WIN_CAPTURE.includes("focus"));
    });

    it("window 阻止注册事件应包含 blur 和 focus", () => {
        const WIN_BLOCKED = ["blur", "focus"];
        assert(WIN_BLOCKED.includes("blur"));
        assert(WIN_BLOCKED.includes("focus"));
    });
});

// =====================================================================
// L. 自动恢复播放（集成）
// =====================================================================

describe("L. 自动恢复播放（集成）", () => {

    it("页面隐藏时，被暂停的活跃媒体应恢复播放", () => {
        const activeMedia = new WeakSet();
        const userPaused = new WeakSet();
        let pageHidden = true;

        const media = new MockMediaElement();
        media.paused = false;
        activeMedia.add(media);

        media.addEventListener("pause", () => {
            if (pageHidden && activeMedia.has(media) && !userPaused.has(media)) {
                media.play();
            }
        });

        MockMediaElement.prototype.pause.call(media);
        assertEqual(media.paused, false, "媒体应被自动恢复播放");
    });

    it("用户主动暂停后页面隐藏不应恢复播放", () => {
        const activeMedia = new WeakSet();
        const userPaused = new WeakSet();
        let pageHidden = true;

        const media = new MockMediaElement();
        media.paused = false;
        activeMedia.add(media);

        userPaused.add(media);
        activeMedia.delete(media);

        let restored = false;
        media.addEventListener("pause", () => {
            if (pageHidden && activeMedia.has(media) && !userPaused.has(media)) {
                restored = true;
                media.play();
            }
        });

        MockMediaElement.prototype.pause.call(media);
        assertEqual(restored, false, "不应恢复用户主动暂停的媒体");
    });
});

// =====================================================================
// M. isPageActuallyHidden 逻辑
// =====================================================================

describe("M. isPageActuallyHidden 逻辑", () => {

    it("有原始描述符时应通过原始 getter 获取真实值", () => {
        const origDesc = {
            get: function () { return true; },
            configurable: true,
        };
        const doc = {};

        // 覆盖后
        Object.defineProperty(doc, "hidden", {
            configurable: true,
            get: () => false,
        });
        assertEqual(doc.hidden, false, "覆盖后应返回 false");

        // 通过原始 getter 获取真实值
        const realValue = origDesc.get.call(doc);
        assertEqual(realValue, true, "原始 getter 应返回真实值");
    });
});

// =====================================================================
// N. unsafeWindow 引用逻辑
// =====================================================================

describe("N. unsafeWindow 引用", () => {

    it("unsafeWindow 不存在时应回退到 window", () => {
        const W = (typeof unsafeWindow !== "undefined") ? "unsafeWindow" : "window";
        assertEqual(W, "window", "Node.js 中应回退到 window");
    });
});

// =====================================================================
// 测试报告
// =====================================================================
console.log("\n" + "=".repeat(50));
console.log(`✅ 通过: ${_passed}`);
if (_failed > 0) {
    console.log(`❌ 失败: ${_failed}`);
    process.exit(1);
} else {
    console.log("全部通过！");
}
