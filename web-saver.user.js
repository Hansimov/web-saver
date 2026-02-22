// ==UserScript==
// @name         Web Saver
// @namespace    http://tampermonkey.net/
// @version      2026-02-22
// @description  网页图片一键收集保存工具
// @author       Hansimov
// @match        *://*/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%234CAF50' d='M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z'/%3E%3C/svg%3E
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    "use strict";

    // =====================================================================
    // 日志 —— 始终显示在 DevTools 控制台
    // =====================================================================
    const LOG_PREFIX = "[Web Saver]";
    const log = (...a) => console.log(LOG_PREFIX, ...a);
    const warn = (...a) => console.warn(LOG_PREFIX, ...a);
    const error = (...a) => console.error(LOG_PREFIX, ...a);

    log("脚本启动于", window.location.href);

    // =====================================================================
    // 常量
    // =====================================================================
    const SCRIPT_NAME = "Web Saver";
    const SETTINGS_KEY = "web_saver_settings";
    const MIN_IMAGE_SIZE_DEFAULT = 50;

    const VALID_IMAGE_EXTS = [
        "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "avif", "ico",
    ];

    const OUTPUT_FORMATS = ["original", "png", "jpg", "webp"];

    // =====================================================================
    // GM_* API 安全封装（不可用时优雅降级）
    // =====================================================================
    function gmGetValue(key, defaultVal) {
        try { return GM_getValue(key, defaultVal); } catch (_) { }
        try {
            const v = localStorage.getItem("ws_" + key);
            return v !== null ? JSON.parse(v) : defaultVal;
        } catch (_) { return defaultVal; }
    }

    function gmSetValue(key, val) {
        try { GM_setValue(key, val); return; } catch (_) { }
        try { localStorage.setItem("ws_" + key, JSON.stringify(val)); } catch (_) { }
    }

    function gmAddStyle(css) {
        try {
            if (typeof GM_addStyle === "function") { GM_addStyle(css); return; }
        } catch (_) { }
        // 降级：注入 <style> 元素
        const style = document.createElement("style");
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function gmRegisterMenuCommand(label, fn) {
        try {
            if (typeof GM_registerMenuCommand === "function") {
                GM_registerMenuCommand(label, fn);
            }
        } catch (_) { }
    }

    function gmDownload(opts) {
        if (typeof GM_download === "function") {
            try { GM_download(opts); return true; } catch (_) { }
        }
        return false;
    }

    // =====================================================================
    // 工具函数
    // =====================================================================

    /** 从 URL 提取图片扩展名，默认 jpg */
    function getExtFromUrl(url) {
        try {
            const pathname = new URL(url, window.location.href).pathname;
            const match = pathname.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
            if (match) {
                let ext = match[1].toLowerCase();
                if (ext === "jpeg") ext = "jpg";
                if (VALID_IMAGE_EXTS.includes(ext)) return ext;
            }
        } catch (_) { }
        return "jpg";
    }

    /** 清理文件名中的非法字符（仅作用于文件名，不可用于路径） */
    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    }

    /** 数字前补零 */
    function padZero(n, len = 2) {
        return String(n).padStart(len, "0");
    }

    /**
     * 规范化保存路径（目录部分）：
     *  - 反斜杠 → 正斜杠
     *  - 确保末尾有 /
     *  - 不做字符清理（路径中可以包含 : 和 /）
     */
    function normalizePath(p) {
        if (!p) return "";
        p = p.trim().replace(/\\/g, "/");
        if (p && !p.endsWith("/")) p += "/";
        return p;
    }

    // =====================================================================
    // 设置
    // =====================================================================
    class Settings {
        static DEFAULTS = {
            saveMode: "single",      // 'single' | 'multiple'
            sortBy: "size",         // 'size' | 'time'
            imageFormat: "original",     // 'original' | 'png' | 'jpg' | 'webp'
            nameTemplate: "{yyyy}-{mm}-{dd}-{hh}{MM}{ss}",
            defaultSavePath: "",            // 浏览器下载目录下的子文件夹
            domainPaths: {},            // { hostname: path }
            conflictAction: "uniquify",    // uniquify | overwrite | skip | prompt
            duplicateAction: "skip",        // 'skip' | 'latest' —— 同一 URL 图片的处理方式
            minImageSize: MIN_IMAGE_SIZE_DEFAULT,
            firstRun: true,
        };

        constructor() {
            this._data = { ...Settings.DEFAULTS };
            this.load();
        }

        load() {
            try {
                const raw = gmGetValue(SETTINGS_KEY, null);
                if (raw) {
                    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                    Object.assign(this._data, parsed);
                }
                log("设置已加载:", JSON.stringify(this._data));
            } catch (e) {
                warn("加载设置失败，使用默认值:", e);
            }
        }

        save() { gmSetValue(SETTINGS_KEY, JSON.stringify(this._data)); }

        get(key) { return this._data[key]; }

        set(key, value) {
            this._data[key] = value;
            this.save();
        }

        getAll() { return { ...this._data }; }

        setAll(obj) {
            Object.assign(this._data, obj);
            this.save();
        }

        /** 获取当前域名对应的保存路径（已规范化） */
        getSavePath() {
            const domain = window.location.hostname;
            const domainPaths = this._data.domainPaths || {};
            const raw = domainPaths[domain] || this._data.defaultSavePath || "";
            return normalizePath(raw);
        }

        setDomainPath(domain, path) {
            if (!this._data.domainPaths) this._data.domainPaths = {};
            if (path) { this._data.domainPaths[domain] = path; }
            else { delete this._data.domainPaths[domain]; }
            this.save();
        }

        reset() {
            this._data = { ...Settings.DEFAULTS };
            this.save();
        }
    }

    // =====================================================================
    // 文件命名
    // =====================================================================
    class FileNamer {
        constructor(settings) { this.settings = settings; }

        /** 根据模板生成文件名 */
        generate(context = {}) {
            const template = this.settings.get("nameTemplate");
            const now = new Date();
            const domain = window.location.hostname;
            const title = sanitizeFilename(document.title).substring(0, 100);

            const map = {
                "{title}": title,
                "{domain}": domain,
                "{url}": sanitizeFilename(window.location.href).substring(0, 200),
                "{yyyy}": String(now.getFullYear()),
                "{mm}": padZero(now.getMonth() + 1),
                "{dd}": padZero(now.getDate()),
                "{hh}": padZero(now.getHours()),
                "{MM}": padZero(now.getMinutes()),
                "{ss}": padZero(now.getSeconds()),
                "{index}": String(context.index ?? 0),
                "{ext}": context.ext || "jpg",
            };

            let filename = template;
            for (const [ph, val] of Object.entries(map)) {
                filename = filename.replaceAll(ph, val);
            }

            // 模板中没有 {ext} 则自动追加扩展名
            if (!template.includes("{ext}")) {
                filename += "." + (context.ext || "jpg");
            }

            return sanitizeFilename(filename);
        }
    }

    // =====================================================================
    // 图片收集
    // =====================================================================
    class ImageCollector {
        constructor(settings) { this.settings = settings; }

        /** 扫描页面中的所有图片源 */
        collect() {
            const images = [];
            const seen = new Set();
            const minSize = this.settings.get("minImageSize") || MIN_IMAGE_SIZE_DEFAULT;

            // 1. <img> 元素（含 <picture> 的 currentSrc）
            document.querySelectorAll("img").forEach((img, idx) => {
                const url = img.currentSrc || img.src;
                if (!url || seen.has(url)) return;
                if (url.startsWith("data:") && url.length < 200) return;

                const w = img.naturalWidth || img.width;
                const h = img.naturalHeight || img.height;
                if (w < minSize && h < minSize) return;

                seen.add(url);
                images.push({
                    url, width: w, height: h, area: w * h,
                    element: img, domIndex: idx, type: "img",
                });
            });

            // 2. 懒加载图片（data-src / data-original / data-lazy-src）
            document.querySelectorAll(
                "img[data-src], img[data-original], img[data-lazy-src]"
            ).forEach((img, idx) => {
                const url = img.dataset.src || img.dataset.original || img.dataset.lazySrc;
                if (!url || seen.has(url)) return;
                seen.add(url);
                images.push({
                    url,
                    width: img.naturalWidth || img.width || 0,
                    height: img.naturalHeight || img.height || 0,
                    area: (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0),
                    element: img, domIndex: 100000 + idx, type: "lazy",
                });
            });

            // 3. CSS 背景图片（页面元素不超过 5000 个时才扫描，避免性能问题）
            const allEls = document.querySelectorAll("*");
            if (allEls.length < 5000) {
                allEls.forEach((el, idx) => {
                    try {
                        const bg = getComputedStyle(el).backgroundImage;
                        if (!bg || bg === "none") return;
                        const matches = bg.matchAll(/url\(["']?(.+?)["']?\)/g);
                        for (const m of matches) {
                            const url = m[1];
                            if (!url || seen.has(url) || url.startsWith("data:")) continue;
                            seen.add(url);
                            images.push({
                                url,
                                width: el.offsetWidth, height: el.offsetHeight,
                                area: el.offsetWidth * el.offsetHeight,
                                element: el, domIndex: 200000 + idx, type: "bg",
                            });
                        }
                    } catch (_) { }
                });
            }

            // 4. <video poster>
            document.querySelectorAll("video[poster]").forEach((video, idx) => {
                const url = video.poster;
                if (!url || seen.has(url)) return;
                seen.add(url);
                images.push({
                    url,
                    width: video.videoWidth || video.offsetWidth,
                    height: video.videoHeight || video.offsetHeight,
                    area: (video.videoWidth || video.offsetWidth) * (video.videoHeight || video.offsetHeight),
                    element: video, domIndex: 300000 + idx, type: "poster",
                });
            });

            log(`收集到 ${images.length} 张图片`);
            return images;
        }

        /** 按设置排序图片 */
        sort(images) {
            const sortBy = this.settings.get("sortBy");
            if (sortBy === "size") {
                return [...images].sort((a, b) => b.area - a.area);
            }
            return [...images].sort((a, b) => a.domIndex - b.domIndex);
        }

        /** 根据保存模式选择图片 */
        select(images) {
            const sorted = this.sort(images);
            if (this.settings.get("saveMode") === "single") {
                return sorted.length > 0 ? [sorted[0]] : [];
            }
            return sorted;
        }
    }

    // =====================================================================
    // 图片保存
    // =====================================================================
    class ImageSaver {
        constructor(settings, fileNamer) {
            this.settings = settings;
            this.fileNamer = fileNamer;
            this._sessionNames = new Set();
            this._savedUrls = new Map();   // url → 已保存文件名（用于去重）
        }

        /** 保存图片列表，返回结果数组 */
        async save(images) {
            const results = [];
            const savePath = this.settings.getSavePath();   // 已规范化
            const conflictAction = this.settings.get("conflictAction");
            const duplicateAction = this.settings.get("duplicateAction") || "skip";
            const format = this.settings.get("imageFormat");

            for (let i = 0; i < images.length; i++) {
                const image = images[i];

                // —— 重复 URL 检测 ——
                if (this._savedUrls.has(image.url)) {
                    if (duplicateAction === "skip") {
                        log("重复图片已跳过:", image.url);
                        results.push({
                            filename: this._savedUrls.get(image.url),
                            status: "skipped-dup",
                        });
                        continue;
                    }
                    // 'latest' → 继续下载（覆盖）
                }

                let ext = getExtFromUrl(image.url);
                if (format !== "original") ext = format;

                let filename = this.fileNamer.generate({ index: i + 1, ext });

                // 会话级文件名去重
                if (conflictAction === "uniquify") {
                    filename = this._uniquify(filename);
                }

                // 拼合路径（savePath 末尾已有 / 或为空）
                const fullPath = savePath + filename;

                // 会话内已保存过则跳过
                if (conflictAction === "skip" && this._sessionNames.has(fullPath)) {
                    results.push({ filename: fullPath, status: "skipped" });
                    continue;
                }

                let downloadUrl = image.url;

                // 格式转换（通过 canvas）
                if (format !== "original") {
                    try {
                        downloadUrl = await this._convertImage(image.url, format);
                    } catch (e) {
                        warn("格式转换失败，使用原格式:", e);
                    }
                }

                try {
                    await this._download(downloadUrl, fullPath, conflictAction);
                    this._sessionNames.add(fullPath);
                    this._savedUrls.set(image.url, fullPath);
                    results.push({ filename: fullPath, status: "success" });
                    log("已保存:", fullPath);
                } catch (e) {
                    results.push({ filename: fullPath, status: "error", error: e.message });
                    error("下载失败:", fullPath, e.message);
                }
            }
            return results;
        }

        /** 在会话内对文件名去重（加 -1、-2 后缀） */
        _uniquify(filename) {
            if (!this._sessionNames.has(filename)) return filename;
            const dotIdx = filename.lastIndexOf(".");
            const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
            const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";
            let n = 1;
            while (this._sessionNames.has(`${base}-${n}${ext}`)) n++;
            return `${base}-${n}${ext}`;
        }

        /** 下载文件：优先 GM_download，降级为 <a> 点击 */
        _download(url, name, conflictAction) {
            log("下载参数: name =", name);
            return new Promise((resolve, reject) => {
                const gmAction = conflictAction === "skip" ? "uniquify" : conflictAction;
                const success = gmDownload({
                    url,
                    name,
                    conflictAction: gmAction,
                    onload: () => resolve(),
                    onerror: (err) => reject(new Error(err?.error || err?.details || "下载失败")),
                    ontimeout: () => reject(new Error("下载超时")),
                });

                if (!success) {
                    // 降级：不可见 <a> 标签点击下载
                    log("GM_download 不可用，使用备用下载方式");
                    try {
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = name.split("/").pop();
                        a.style.display = "none";
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(() => { a.remove(); resolve(); }, 300);
                    } catch (e) { reject(e); }
                }
            });
        }

        /** 通过 canvas 进行格式转换 */
        _convertImage(url, format) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    try {
                        const c = document.createElement("canvas");
                        c.width = img.naturalWidth;
                        c.height = img.naturalHeight;
                        c.getContext("2d").drawImage(img, 0, 0);
                        const mime = `image/${format === "jpg" ? "jpeg" : format}`;
                        resolve(c.toDataURL(mime, 0.95));
                    } catch (e) { reject(e); }
                };
                img.onerror = () => reject(new Error("无法加载图片进行格式转换"));
                img.src = url;
            });
        }
    }

    // =====================================================================
    // 样式（所有 UI 样式集中管理）
    // =====================================================================
    const CSS = `
        /* —— 提示条 Toast —— */
        .ws-toast-container {
            position: fixed; bottom: 80px; right: 20px;
            z-index: 2147483647;
            display: flex; flex-direction: column-reverse; gap: 8px;
            pointer-events: none;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .ws-toast {
            background: #323232; color: #fff;
            padding: 10px 18px; border-radius: 8px;
            font-size: 13px; line-height: 1.4;
            box-shadow: 0 4px 12px rgba(0,0,0,.3);
            animation: ws-slide-in .25s ease-out;
            pointer-events: auto; max-width: 360px; word-break: break-word;
        }
        .ws-toast.ws-success { border-left: 4px solid #4CAF50; }
        .ws-toast.ws-error   { border-left: 4px solid #f44336; }
        .ws-toast.ws-info    { border-left: 4px solid #2196F3; }
        @keyframes ws-slide-in {
            from { transform: translateX(100%); opacity: 0; }
            to   { transform: translateX(0);    opacity: 1; }
        }

        /* —— 图片高亮 —— */
        .ws-img-highlight {
            outline: 3px solid #4CAF50 !important;
            outline-offset: 2px;
            box-shadow: 0 0 12px rgba(76,175,80,.5);
            transition: outline .3s, box-shadow .3s;
        }

        /* —— 右下角浮动按钮组 —— */
        .ws-fab-container {
            position: fixed; bottom: 20px; right: 20px;
            z-index: 2147483645;
            display: flex; flex-direction: column;
            align-items: flex-end; gap: 8px;
            pointer-events: none;
        }
        .ws-fab-container > * { pointer-events: auto; }

        .ws-fab-buttons {
            display: flex; gap: 8px;
        }
        .ws-fab {
            width: 42px; height: 42px;
            border-radius: 50%;
            background: #4CAF50; color: #fff;
            border: none; cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,.3);
            font-size: 20px; line-height: 42px; text-align: center;
            transition: transform .2s, box-shadow .2s, opacity .3s;
            opacity: 0.55; user-select: none;
        }
        .ws-fab:hover {
            transform: scale(1.1);
            box-shadow: 0 4px 16px rgba(0,0,0,.4);
            opacity: 1;
        }
        .ws-fab-settings { background: #607D8B; font-size: 18px; }

        /* —— 缩略图预览面板 —— */
        .ws-preview-panel {
            background: #fff; border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,.2);
            padding: 10px;
            display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
            max-width: 300px; max-height: 340px; overflow-y: auto;
            opacity: 0; transform: translateY(8px);
            transition: opacity .2s, transform .2s;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .ws-preview-panel.ws-visible {
            opacity: 1; transform: translateY(0);
        }
        .ws-preview-thumb {
            width: 84px; height: 84px;
            object-fit: cover; border-radius: 6px;
            border: 2px solid #e0e0e0;
            transition: border-color .15s;
            background: #f5f5f5;
        }
        .ws-preview-thumb.ws-selected {
            border-color: #4CAF50;
            box-shadow: 0 0 6px rgba(76,175,80,.4);
        }
        .ws-preview-info {
            grid-column: 1 / -1;
            text-align: center; font-size: 12px; color: #888;
            padding: 4px 0 0; margin: 0;
        }

        @keyframes ws-fade-in {
            from { opacity: 0; transform: translateY(8px); }
            to   { opacity: 1; transform: translateY(0); }
        }

        /* —— 设置面板 —— */
        .ws-overlay {
            position: fixed; inset: 0;
            background: rgba(0,0,0,.45);
            z-index: 2147483646;
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .ws-panel {
            background: #fff; border-radius: 12px;
            width: 480px; max-height: 90vh; overflow-y: auto;
            box-shadow: 0 8px 30px rgba(0,0,0,.25);
            padding: 24px 28px; color: #222;
        }
        .ws-panel h2 {
            margin: 0 0 18px; font-size: 18px; font-weight: 600;
            display: flex; align-items: center; gap: 8px;
        }
        .ws-panel label {
            display: block; font-size: 13px; font-weight: 500;
            margin: 14px 0 4px; color: #555;
        }
        .ws-panel input[type="text"],
        .ws-panel input[type="number"],
        .ws-panel select {
            width: 100%; padding: 7px 10px;
            border: 1px solid #d0d0d0; border-radius: 6px;
            font-size: 13px; box-sizing: border-box;
            outline: none; transition: border-color .2s;
        }
        .ws-panel input:focus, .ws-panel select:focus { border-color: #4CAF50; }
        .ws-panel .ws-radio-group {
            display: flex; gap: 14px; margin: 4px 0;
            font-size: 13px; flex-wrap: wrap;
        }
        .ws-panel .ws-radio-group label {
            display: inline-flex; align-items: center; gap: 4px;
            font-weight: 400; color: #333; margin: 0; cursor: pointer;
        }
        .ws-panel .ws-hint {
            font-size: 11px; color: #999; margin: 2px 0 0;
        }
        .ws-panel .ws-actions {
            display: flex; justify-content: flex-end; gap: 10px;
            margin-top: 22px; padding-top: 14px; border-top: 1px solid #eee;
        }
        .ws-panel button {
            padding: 7px 18px; border: none; border-radius: 6px;
            font-size: 13px; cursor: pointer; font-weight: 500;
            transition: background .15s;
        }
        .ws-panel .ws-btn-primary   { background: #4CAF50; color: #fff; }
        .ws-panel .ws-btn-primary:hover { background: #43A047; }
        .ws-panel .ws-btn-secondary { background: #e0e0e0; color: #333; }
        .ws-panel .ws-btn-secondary:hover { background: #d0d0d0; }
        .ws-panel .ws-btn-danger    { background: transparent; color: #f44336; margin-right: auto; }
        .ws-panel .ws-btn-danger:hover { background: #ffebee; }
    `;

    // =====================================================================
    // UI 管理器
    // =====================================================================
    class UIManager {
        constructor(settings) {
            this.settings = settings;
            this._panelEl = null;
            this._toastContainer = null;
            this._fabContainer = null;
            this._previewEl = null;
            this._previewTimer = null;
            this._onSave = null;   // 保存回调
            this._onCollect = null;   // 收集图片回调（用于预览）
        }

        /** 初始化 UI（注入样式 + 创建浮动按钮） */
        init() {
            this._injectStyles();
            this._createFab();
            log("UI 已初始化");
        }

        _injectStyles() { gmAddStyle(CSS); }

        // ---- 浮动按钮组（右下角） ----
        _createFab() {
            const container = document.createElement("div");
            container.className = "ws-fab-container";

            const btnRow = document.createElement("div");
            btnRow.className = "ws-fab-buttons";

            // 设置按钮
            const settingsBtn = document.createElement("button");
            settingsBtn.className = "ws-fab ws-fab-settings";
            settingsBtn.textContent = "⚙";
            settingsBtn.title = "打开设置 (Ctrl+Alt+O)";
            settingsBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.showSettings();
            });

            // 保存按钮
            const saveBtn = document.createElement("button");
            saveBtn.className = "ws-fab";
            saveBtn.textContent = "📷";
            saveBtn.title = "保存图片 (Ctrl+Alt+I)";
            saveBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (this._onSave) this._onSave();
            });

            // 悬浮预览
            saveBtn.addEventListener("mouseenter", () => {
                this._previewTimer = setTimeout(() => this._showPreview(), 300);
            });
            saveBtn.addEventListener("mouseleave", () => {
                clearTimeout(this._previewTimer);
                this._hidePreview();
            });

            btnRow.appendChild(settingsBtn);
            btnRow.appendChild(saveBtn);
            container.appendChild(btnRow);
            document.body.appendChild(container);
            this._fabContainer = container;
        }

        // ---- 缩略图预览 ----
        _showPreview() {
            if (this._previewEl) return;
            const allImages = this._onCollect ? this._onCollect() : [];
            if (allImages.length === 0) return;

            // 取要保存的子集（用于高亮）
            const isSingle = this.settings.get("saveMode") === "single";
            const selectedUrls = new Set(
                isSingle ? [allImages[0]?.url] : allImages.map(img => img.url)
            );

            const panel = document.createElement("div");
            panel.className = "ws-preview-panel";

            const maxShow = 9;
            const toShow = allImages.slice(0, maxShow);

            toShow.forEach((img) => {
                const thumb = document.createElement("img");
                thumb.src = img.url;
                thumb.className = "ws-preview-thumb";
                if (selectedUrls.has(img.url)) {
                    thumb.classList.add("ws-selected");
                }
                thumb.title = `${img.width || "?"}×${img.height || "?"} ${img.type}`;
                thumb.loading = "lazy";
                thumb.onerror = () => { thumb.style.display = "none"; };
                panel.appendChild(thumb);
            });

            // 信息行
            const info = document.createElement("div");
            info.className = "ws-preview-info";
            const willSave = isSingle ? 1 : allImages.length;
            info.textContent = allImages.length > maxShow
                ? `显示前 ${maxShow} 张，共 ${allImages.length} 张 · 将保存 ${willSave} 张`
                : `共 ${allImages.length} 张图片 · 将保存 ${willSave} 张`;
            panel.appendChild(info);

            // 插入到按钮行上方
            this._fabContainer.insertBefore(panel, this._fabContainer.firstChild);
            this._previewEl = panel;
            // 触发重排后添加可见类以启动动画
            void panel.offsetHeight;
            panel.classList.add("ws-visible");
        }

        _hidePreview() {
            if (this._previewEl) {
                this._previewEl.remove();
                this._previewEl = null;
            }
        }

        /** 设置"保存"回调 */
        setSaveHandler(fn) { this._onSave = fn; }
        /** 设置"收集图片"回调（用于预览） */
        setCollectHandler(fn) { this._onCollect = fn; }

        // ---- 提示条 Toast ----
        _ensureToastContainer() {
            if (!this._toastContainer || !this._toastContainer.isConnected) {
                this._toastContainer = document.createElement("div");
                this._toastContainer.className = "ws-toast-container";
                document.body.appendChild(this._toastContainer);
            }
            return this._toastContainer;
        }

        toast(message, type = "info", duration = 3000) {
            log(`[toast:${type}]`, message);
            const container = this._ensureToastContainer();
            const el = document.createElement("div");
            el.className = `ws-toast ws-${type}`;
            el.textContent = message;
            container.appendChild(el);
            setTimeout(() => {
                el.style.opacity = "0";
                el.style.transition = "opacity .3s";
                setTimeout(() => el.remove(), 300);
            }, duration);
        }

        // ---- 图片高亮 ----
        highlightImages(images, duration = 1200) {
            for (const img of images) {
                if (img.element) {
                    img.element.classList.add("ws-img-highlight");
                    setTimeout(() => {
                        img.element.classList.remove("ws-img-highlight");
                    }, duration);
                }
            }
        }

        // ---- 设置面板 ----
        showSettings(onSave) {
            if (this._panelEl) return;
            log("打开设置面板");
            const data = this.settings.getAll();
            const domain = window.location.hostname;
            const domainPath = (data.domainPaths || {})[domain] || "";

            const overlay = document.createElement("div");
            overlay.className = "ws-overlay";
            overlay.innerHTML = `
                <div class="ws-panel">
                    <h2><span>⚙</span> ${SCRIPT_NAME} 设置</h2>

                    <label>保存模式</label>
                    <div class="ws-radio-group">
                        <label><input type="radio" name="ws-saveMode" value="single" ${data.saveMode === "single" ? "checked" : ""}> 单张图片</label>
                        <label><input type="radio" name="ws-saveMode" value="multiple" ${data.saveMode === "multiple" ? "checked" : ""}> 所有图片</label>
                    </div>

                    <label>排序方式</label>
                    <div class="ws-radio-group">
                        <label><input type="radio" name="ws-sortBy" value="size" ${data.sortBy === "size" ? "checked" : ""}> 尺寸（从大到小）</label>
                        <label><input type="radio" name="ws-sortBy" value="time" ${data.sortBy === "time" ? "checked" : ""}> 页面顺序</label>
                    </div>

                    <label>图片格式</label>
                    <select id="ws-imageFormat">
                        ${OUTPUT_FORMATS.map(f => `<option value="${f}" ${data.imageFormat === f ? "selected" : ""}>${f === "original" ? "原始格式" : f.toUpperCase()}</option>`).join("")}
                    </select>

                    <label>命名模板</label>
                    <input type="text" id="ws-nameTemplate" value="${data.nameTemplate}">
                    <div class="ws-hint">占位符: {title} {domain} {url} {yyyy} {mm} {dd} {hh} {MM} {ss} {index} {ext}</div>

                    <label>默认保存路径</label>
                    <input type="text" id="ws-defaultSavePath" value="${data.defaultSavePath}" placeholder="例如: artworks/arts">
                    <div class="ws-hint">路径相对于浏览器下载目录。如需保存到指定位置，请在浏览器设置中更改下载目录。<br>在 Tampermonkey 设置 → 通用 → 配置模式 → 高级 → 下载(Beta) → 模式 → 选择「浏览器 API」可支持子目录。</div>

                    <label>当前域名 <b>${domain}</b> 的保存路径</label>
                    <input type="text" id="ws-domainPath" value="${domainPath}" placeholder="留空则使用默认路径">

                    <label>文件冲突处理</label>
                    <div class="ws-radio-group">
                        <label><input type="radio" name="ws-conflict" value="uniquify" ${data.conflictAction === "uniquify" ? "checked" : ""}> 添加编号</label>
                        <label><input type="radio" name="ws-conflict" value="overwrite" ${data.conflictAction === "overwrite" ? "checked" : ""}> 覆盖</label>
                        <label><input type="radio" name="ws-conflict" value="skip" ${data.conflictAction === "skip" ? "checked" : ""}> 跳过</label>
                        <label><input type="radio" name="ws-conflict" value="prompt" ${data.conflictAction === "prompt" ? "checked" : ""}> 询问</label>
                    </div>

                    <label>重复图片处理（相同 URL）</label>
                    <div class="ws-radio-group">
                        <label><input type="radio" name="ws-dupAction" value="skip" ${(data.duplicateAction || "skip") === "skip" ? "checked" : ""}> 跳过（不重复下载）</label>
                        <label><input type="radio" name="ws-dupAction" value="latest" ${data.duplicateAction === "latest" ? "checked" : ""}> 重新下载</label>
                    </div>

                    <label>最小图片尺寸（像素）</label>
                    <input type="number" id="ws-minImageSize" value="${data.minImageSize}" min="0" max="1000" style="width:100px;">

                    <div class="ws-actions">
                        <button class="ws-btn-danger" id="ws-btn-reset">重置</button>
                        <button class="ws-btn-secondary" id="ws-btn-cancel">取消</button>
                        <button class="ws-btn-primary" id="ws-btn-save">保存</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);
            this._panelEl = overlay;

            // 点击遮罩关闭
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) this.hideSettings();
            });

            // Escape 关闭
            const escHandler = (e) => {
                if (e.key === "Escape") {
                    this.hideSettings();
                    document.removeEventListener("keydown", escHandler, true);
                }
            };
            document.addEventListener("keydown", escHandler, true);

            // 取消
            overlay.querySelector("#ws-btn-cancel").addEventListener("click",
                () => this.hideSettings());

            // 重置
            overlay.querySelector("#ws-btn-reset").addEventListener("click", () => {
                if (confirm("确定重置所有设置为默认值？")) {
                    this.settings.reset();
                    this.hideSettings();
                    this.toast("设置已重置为默认值", "info");
                }
            });

            // 保存
            overlay.querySelector("#ws-btn-save").addEventListener("click", () => {
                const newData = {
                    saveMode: overlay.querySelector('input[name="ws-saveMode"]:checked')?.value || "single",
                    sortBy: overlay.querySelector('input[name="ws-sortBy"]:checked')?.value || "size",
                    imageFormat: overlay.querySelector("#ws-imageFormat").value,
                    nameTemplate: overlay.querySelector("#ws-nameTemplate").value || Settings.DEFAULTS.nameTemplate,
                    defaultSavePath: overlay.querySelector("#ws-defaultSavePath").value.trim(),
                    conflictAction: overlay.querySelector('input[name="ws-conflict"]:checked')?.value || "uniquify",
                    duplicateAction: overlay.querySelector('input[name="ws-dupAction"]:checked')?.value || "skip",
                    minImageSize: parseInt(overlay.querySelector("#ws-minImageSize").value, 10) || MIN_IMAGE_SIZE_DEFAULT,
                    firstRun: false,
                };

                // 保留已有 domainPaths，更新当前域名
                const domainPaths = { ...(this.settings.get("domainPaths") || {}) };
                const dp = overlay.querySelector("#ws-domainPath").value.trim();
                if (dp) { domainPaths[domain] = dp; }
                else { delete domainPaths[domain]; }
                newData.domainPaths = domainPaths;

                this.settings.setAll(newData);
                this.hideSettings();
                this.toast("设置已保存", "success");
                if (onSave) onSave();
            });
        }

        hideSettings() {
            if (this._panelEl) {
                this._panelEl.remove();
                this._panelEl = null;
                log("设置面板已关闭");
            }
        }

        isSettingsOpen() { return !!this._panelEl; }
    }

    // =====================================================================
    // WebSaver —— 主控制器
    // =====================================================================
    class WebSaver {
        constructor() {
            log("正在初始化...");

            // 1. 设置
            try {
                this.settings = new Settings();
            } catch (e) {
                error("设置初始化失败:", e);
                this.settings = {
                    _data: {}, get: (k) => Settings.DEFAULTS[k],
                    set: () => { }, getAll: () => ({ ...Settings.DEFAULTS }),
                    setAll: () => { }, getSavePath: () => "", reset: () => { },
                };
            }

            // 2. 核心模块
            this.fileNamer = new FileNamer(this.settings);
            this.collector = new ImageCollector(this.settings);
            this.saver = new ImageSaver(this.settings, this.fileNamer);
            this.ui = new UIManager(this.settings);

            // 3. UI 初始化（隔离错误）
            try { this.ui.init(); } catch (e) { error("UI 初始化失败:", e); }

            // 4. 回调绑定
            this.ui.setSaveHandler(() => this.saveImages());
            this.ui.setCollectHandler(() => {
                const all = this.collector.collect();
                return this.collector.select(all);
            });

            // 5. 快捷键 & 菜单
            this._bindHotkeys();
            this._registerMenu();
            this._checkFirstRun();

            log("初始化完成。按 Ctrl+Alt+I 保存图片。");
        }

        /** 绑定快捷键 */
        _bindHotkeys() {
            // 同时在 document 和 window 上注册捕获阶段监听，最大化兼容性
            const handler = (e) => {
                // 忽略输入法编辑状态
                if (e.isComposing) return;
                if (!e.ctrlKey || !e.altKey) return;
                if (e.shiftKey || e.metaKey) return;

                // 使用 e.code（不受键盘布局和输入法影响）+ e.keyCode 兜底
                if (e.code === "KeyI" || e.keyCode === 73) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    log("快捷键 Ctrl+Alt+I 触发");
                    this.saveImages();
                } else if (e.code === "KeyO" || e.keyCode === 79) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    log("快捷键 Ctrl+Alt+O 触发（设置）");
                    this.ui.showSettings();
                }
            };

            document.addEventListener("keydown", handler, true);
            window.addEventListener("keydown", handler, true);

            // 防止重复触发的标志
            let _fired = false;
            const safeHandler = (e) => {
                if (_fired) return;
                _fired = true;
                handler(e);
                setTimeout(() => { _fired = false; }, 50);
            };

            // 替换为安全版本
            document.removeEventListener("keydown", handler, true);
            window.removeEventListener("keydown", handler, true);
            document.addEventListener("keydown", safeHandler, true);
            window.addEventListener("keydown", safeHandler, true);

            log("快捷键已绑定 (Ctrl+Alt+I = 保存, Ctrl+Alt+O = 设置)");
        }

        /** 注册 Tampermonkey 菜单项 */
        _registerMenu() {
            gmRegisterMenuCommand("📷 保存图片", () => this.saveImages());
            gmRegisterMenuCommand("⚙ 设置", () => this.ui.showSettings());
            log("菜单命令已注册");
        }

        /** 首次运行检测 */
        _checkFirstRun() {
            if (this.settings.get("firstRun")) {
                log("首次运行 —— 显示欢迎信息");
                setTimeout(() => {
                    this.ui.toast(
                        `${SCRIPT_NAME} 已安装！按 Ctrl+Alt+I 保存图片，或点击右下角 📷 按钮。`,
                        "info", 6000
                    );
                    setTimeout(() => this.ui.showSettings(), 2000);
                }, 1500);
            }
        }

        /** 保存图片主流程 */
        async saveImages() {
            if (this.ui.isSettingsOpen()) return;

            log("保存触发 —— 正在收集图片...");
            const allImages = this.collector.collect();
            if (allImages.length === 0) {
                this.ui.toast("此页面未找到图片", "info");
                return;
            }

            const selected = this.collector.select(allImages);
            if (selected.length === 0) {
                this.ui.toast("没有符合条件的图片", "info");
                return;
            }

            log(`已选择 ${selected.length} 张图片`);
            this.ui.highlightImages(selected);

            // —— 先检查是否全部为重复图片 ——
            const duplicateAction = this.settings.get("duplicateAction") || "skip";
            if (duplicateAction === "skip") {
                const allDup = selected.every(img => this.saver._savedUrls.has(img.url));
                if (allDup) {
                    this.ui.toast(`⊘ 已跳过 ${selected.length} 张图片（重复，之前已保存过）`, "info", 3000);
                    log("全部为重复图片，已跳过");
                    return;
                }
            }

            const mode = this.settings.get("saveMode");
            this.ui.toast(
                mode === "single"
                    ? `正在保存图片 (${selected[0].width}×${selected[0].height})...`
                    : `正在保存 ${selected.length} 张图片...`,
                "info", 2000
            );

            const results = await this.saver.save(selected);

            const succeeded = results.filter(r => r.status === "success");
            const failed = results.filter(r => r.status === "error");
            const skipped = results.filter(r => r.status === "skipped");
            const skippedDup = results.filter(r => r.status === "skipped-dup");

            if (succeeded.length > 0) {
                this.ui.toast(
                    `✓ 已保存 ${succeeded.length} 张图片: ${succeeded.map(r => r.filename).join(", ")}`,
                    "success", 4000
                );
            }
            if (skippedDup.length > 0) {
                this.ui.toast(
                    `⊘ 已跳过 ${skippedDup.length} 张重复图片`,
                    "info", 3000
                );
            }
            if (skipped.length > 0) {
                this.ui.toast(
                    `⊘ 已跳过 ${skipped.length} 张图片（会话内已保存）`,
                    "info", 3000
                );
            }
            if (failed.length > 0) {
                this.ui.toast(
                    `✗ ${failed.length} 张下载失败: ${failed.map(r => `${r.filename}: ${r.error}`).join("; ")}`,
                    "error", 5000
                );
            }
        }
    }

    // =====================================================================
    // 初始化 —— 全局 try-catch 兜底
    // =====================================================================
    try {
        const webSaver = new WebSaver();
    } catch (e) {
        error("初始化严重错误:", e);
        try {
            const div = document.createElement("div");
            div.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;"
                + "background:#f44336;color:#fff;padding:12px 18px;border-radius:8px;"
                + "font:13px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);";
            div.textContent = `${SCRIPT_NAME}: 初始化错误 — 请按 F12 查看控制台`;
            document.body.appendChild(div);
            setTimeout(() => div.remove(), 8000);
        } catch (_) { }
    }
})();
