// ==UserScript==
// @name         Web Saver
// @namespace    http://tampermonkey.net/
// @version      2026-02-22
// @description  Auto collect web contents and save with hot-key
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

    // =========================================================================
    // Logger — always visible in DevTools console
    // =========================================================================
    const LOG_PREFIX = "[Web Saver]";
    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);
    const error = (...args) => console.error(LOG_PREFIX, ...args);

    log("Script starting on", window.location.href);

    // =========================================================================
    // Constants
    // =========================================================================
    const SCRIPT_NAME = "Web Saver";
    const SETTINGS_KEY = "web_saver_settings";
    const MIN_IMAGE_SIZE_DEFAULT = 50;

    const VALID_IMAGE_EXTS = [
        "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "avif", "ico",
    ];

    const OUTPUT_FORMATS = ["original", "png", "jpg", "webp"];

    // =========================================================================
    // GM_* API safe wrappers (graceful fallback if unavailable)
    // =========================================================================
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
        // Fallback: inject <style> element
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

    // =========================================================================
    // Utilities
    // =========================================================================
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

    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    }

    function padZero(n, len = 2) {
        return String(n).padStart(len, "0");
    }

    // =========================================================================
    // Settings
    // =========================================================================
    class Settings {
        static DEFAULTS = {
            saveMode: "single",           // 'single' | 'multiple'
            sortBy: "size",               // 'size' | 'time'
            imageFormat: "original",      // 'original' | 'png' | 'jpg' | 'webp'
            nameTemplate: "{yyyy}-{mm}-{dd}-{hh}{MM}{ss}",
            defaultSavePath: "",          // subfolder under downloads
            domainPaths: {},              // { hostname: path }
            conflictAction: "uniquify",   // uniquify | overwrite | skip | prompt
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
                log("Settings loaded:", JSON.stringify(this._data));
            } catch (e) {
                warn("Failed to load settings, using defaults:", e);
            }
        }

        save() {
            gmSetValue(SETTINGS_KEY, JSON.stringify(this._data));
        }

        get(key) {
            return this._data[key];
        }

        set(key, value) {
            this._data[key] = value;
            this.save();
        }

        getAll() {
            return { ...this._data };
        }

        setAll(obj) {
            Object.assign(this._data, obj);
            this.save();
        }

        getSavePath() {
            const domain = window.location.hostname;
            const domainPaths = this._data.domainPaths || {};
            return domainPaths[domain] || this._data.defaultSavePath || "";
        }

        setDomainPath(domain, path) {
            if (!this._data.domainPaths) this._data.domainPaths = {};
            if (path) {
                this._data.domainPaths[domain] = path;
            } else {
                delete this._data.domainPaths[domain];
            }
            this.save();
        }

        reset() {
            this._data = { ...Settings.DEFAULTS };
            this.save();
        }
    }

    // =========================================================================
    // FileNamer
    // =========================================================================
    class FileNamer {
        constructor(settings) {
            this.settings = settings;
        }

        generate(context = {}) {
            const template = this.settings.get("nameTemplate");
            const now = new Date();
            const domain = window.location.hostname;
            const title = sanitizeFilename(document.title).substring(0, 100);

            const replacements = {
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
            for (const [ph, val] of Object.entries(replacements)) {
                filename = filename.replaceAll(ph, val);
            }

            // Append extension if template does not include {ext}
            if (!template.includes("{ext}")) {
                filename += "." + (context.ext || "jpg");
            }

            return sanitizeFilename(filename);
        }
    }

    // =========================================================================
    // ImageCollector
    // =========================================================================
    class ImageCollector {
        constructor(settings) {
            this.settings = settings;
        }

        collect() {
            const images = [];
            const seen = new Set();
            const minSize = this.settings.get("minImageSize") || MIN_IMAGE_SIZE_DEFAULT;

            // 1. <img> elements (including <picture> via currentSrc)
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

            // 2. Lazy-loaded images (data-src, data-original, data-lazy-src)
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

            // 3. CSS background images (skip large pages to avoid perf issues)
            const allElements = document.querySelectorAll("*");
            if (allElements.length < 5000) {
                allElements.forEach((el, idx) => {
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

            log(`Collected ${images.length} images`);
            return images;
        }

        sort(images) {
            const sortBy = this.settings.get("sortBy");
            if (sortBy === "size") {
                return [...images].sort((a, b) => b.area - a.area);
            }
            return [...images].sort((a, b) => a.domIndex - b.domIndex);
        }

        select(images) {
            const sorted = this.sort(images);
            if (this.settings.get("saveMode") === "single") {
                return sorted.length > 0 ? [sorted[0]] : [];
            }
            return sorted;
        }
    }

    // =========================================================================
    // ImageSaver
    // =========================================================================
    class ImageSaver {
        constructor(settings, fileNamer) {
            this.settings = settings;
            this.fileNamer = fileNamer;
            this._sessionNames = new Set();
        }

        async save(images) {
            const results = [];
            const savePath = this.settings.getSavePath();
            const conflictAction = this.settings.get("conflictAction");
            const format = this.settings.get("imageFormat");

            for (let i = 0; i < images.length; i++) {
                const image = images[i];
                let ext = getExtFromUrl(image.url);
                if (format !== "original") ext = format;

                let filename = this.fileNamer.generate({ index: i + 1, ext });

                // Session-level uniquify
                if (conflictAction === "uniquify") {
                    filename = this._uniquify(filename);
                }

                const fullPath = savePath ? `${savePath}/${filename}` : filename;

                // Skip if already saved this session
                if (conflictAction === "skip" && this._sessionNames.has(fullPath)) {
                    results.push({ filename: fullPath, status: "skipped" });
                    continue;
                }

                let downloadUrl = image.url;

                // Format conversion via canvas
                if (format !== "original") {
                    try {
                        downloadUrl = await this._convertImage(image.url, format);
                    } catch (e) {
                        warn("Format conversion failed, using original:", e);
                    }
                }

                try {
                    await this._download(downloadUrl, fullPath, conflictAction);
                    this._sessionNames.add(fullPath);
                    results.push({ filename: fullPath, status: "success" });
                    log("Saved:", fullPath);
                } catch (e) {
                    results.push({ filename: fullPath, status: "error", error: e.message });
                    error("Download failed:", fullPath, e.message);
                }
            }
            return results;
        }

        _uniquify(filename) {
            if (!this._sessionNames.has(filename)) return filename;
            const dotIdx = filename.lastIndexOf(".");
            const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
            const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";
            let n = 1;
            while (this._sessionNames.has(`${base}-${n}${ext}`)) n++;
            return `${base}-${n}${ext}`;
        }

        _download(url, name, conflictAction) {
            return new Promise((resolve, reject) => {
                const gmAction = conflictAction === "skip" ? "uniquify" : conflictAction;
                const success = gmDownload({
                    url,
                    name,
                    conflictAction: gmAction,
                    onload: () => resolve(),
                    onerror: (err) => reject(new Error(err?.error || err?.details || "Download failed")),
                    ontimeout: () => reject(new Error("Download timeout")),
                });

                if (!success) {
                    // Fallback: invisible <a> click
                    log("GM_download unavailable, using <a> fallback");
                    try {
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = name.split("/").pop();
                        a.style.display = "none";
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(() => { a.remove(); resolve(); }, 300);
                    } catch (e) {
                        reject(e);
                    }
                }
            });
        }

        _convertImage(url, format) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    try {
                        const canvas = document.createElement("canvas");
                        canvas.width = img.naturalWidth;
                        canvas.height = img.naturalHeight;
                        const ctx = canvas.getContext("2d");
                        ctx.drawImage(img, 0, 0);
                        const mime = `image/${format === "jpg" ? "jpeg" : format}`;
                        resolve(canvas.toDataURL(mime, 0.95));
                    } catch (e) {
                        reject(e);
                    }
                };
                img.onerror = () => reject(new Error("Failed to load image for conversion"));
                img.src = url;
            });
        }
    }

    // =========================================================================
    // CSS Styles (all UI styles in one place)
    // =========================================================================
    const CSS = `
        /* Toast */
        .ws-toast-container {
            position: fixed; bottom: 20px; right: 20px;
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

        /* Image highlight */
        .ws-img-highlight {
            outline: 3px solid #4CAF50 !important;
            outline-offset: 2px;
            box-shadow: 0 0 12px rgba(76,175,80,.5);
            transition: outline .3s, box-shadow .3s;
        }

        /* Floating FAB button */
        .ws-fab {
            position: fixed; bottom: 20px; left: 20px;
            z-index: 2147483645;
            width: 42px; height: 42px;
            border-radius: 50%;
            background: #4CAF50; color: #fff;
            border: none; cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,.3);
            font-size: 20px; line-height: 42px; text-align: center;
            transition: transform .2s, box-shadow .2s, opacity .3s;
            opacity: 0.55;
            user-select: none;
        }
        .ws-fab:hover {
            transform: scale(1.1);
            box-shadow: 0 4px 16px rgba(0,0,0,.4);
            opacity: 1;
        }
        .ws-fab-menu {
            position: fixed; bottom: 70px; left: 20px;
            z-index: 2147483645;
            background: #fff; border-radius: 10px;
            box-shadow: 0 4px 16px rgba(0,0,0,.2);
            padding: 6px 0; min-width: 180px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            animation: ws-fade-in .15s ease-out;
        }
        .ws-fab-menu-item {
            display: block; width: 100%; padding: 9px 16px;
            border: none; background: none; cursor: pointer;
            font-size: 13px; text-align: left; color: #333;
            transition: background .1s;
        }
        .ws-fab-menu-item:hover { background: #f0f0f0; }
        .ws-fab-menu-item .ws-shortcut {
            float: right; color: #aaa; font-size: 11px; margin-left: 12px;
        }
        @keyframes ws-fade-in {
            from { opacity: 0; transform: translateY(8px); }
            to   { opacity: 1; transform: translateY(0); }
        }

        /* Settings panel */
        .ws-overlay {
            position: fixed; inset: 0;
            background: rgba(0,0,0,.45);
            z-index: 2147483646;
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .ws-panel {
            background: #fff; border-radius: 12px;
            width: 460px; max-height: 90vh; overflow-y: auto;
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
        .ws-panel .ws-hint { font-size: 11px; color: #999; margin: 2px 0 0; }
        .ws-panel .ws-actions {
            display: flex; justify-content: flex-end; gap: 10px;
            margin-top: 22px; padding-top: 14px; border-top: 1px solid #eee;
        }
        .ws-panel button {
            padding: 7px 18px; border: none; border-radius: 6px;
            font-size: 13px; cursor: pointer; font-weight: 500;
            transition: background .15s;
        }
        .ws-panel .ws-btn-primary { background: #4CAF50; color: #fff; }
        .ws-panel .ws-btn-primary:hover { background: #43A047; }
        .ws-panel .ws-btn-secondary { background: #e0e0e0; color: #333; }
        .ws-panel .ws-btn-secondary:hover { background: #d0d0d0; }
        .ws-panel .ws-btn-danger { background: transparent; color: #f44336; margin-right: auto; }
        .ws-panel .ws-btn-danger:hover { background: #ffebee; }
    `;

    // =========================================================================
    // UIManager
    // =========================================================================
    class UIManager {
        constructor(settings) {
            this.settings = settings;
            this._panelEl = null;
            this._toastContainer = null;
            this._fabEl = null;
            this._fabMenuEl = null;
        }

        init() {
            this._injectStyles();
            this._createFab();
            log("UI initialized");
        }

        _injectStyles() {
            gmAddStyle(CSS);
        }

        // ---- Floating Action Button ----
        _createFab() {
            // FAB button — visible indicator that the script is active
            const fab = document.createElement("button");
            fab.className = "ws-fab";
            fab.textContent = "📷";
            fab.title = `${SCRIPT_NAME} — Click for menu`;
            fab.addEventListener("click", (e) => {
                e.stopPropagation();
                this._toggleFabMenu();
            });
            document.body.appendChild(fab);
            this._fabEl = fab;

            // Close menu on outside click
            document.addEventListener("click", () => this._closeFabMenu());
        }

        _toggleFabMenu() {
            if (this._fabMenuEl) {
                this._closeFabMenu();
                return;
            }
            const menu = document.createElement("div");
            menu.className = "ws-fab-menu";
            menu.innerHTML = `
                <button class="ws-fab-menu-item" data-action="save">
                    📷 Save Image(s)<span class="ws-shortcut">Ctrl+Alt+I</span>
                </button>
                <button class="ws-fab-menu-item" data-action="settings">
                    ⚙ Settings
                </button>
            `;
            menu.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = e.target.closest("[data-action]")?.dataset.action;
                if (action === "save") {
                    this._closeFabMenu();
                    if (this._onSave) this._onSave();
                } else if (action === "settings") {
                    this._closeFabMenu();
                    this.showSettings();
                }
            });
            document.body.appendChild(menu);
            this._fabMenuEl = menu;
        }

        _closeFabMenu() {
            if (this._fabMenuEl) {
                this._fabMenuEl.remove();
                this._fabMenuEl = null;
            }
        }

        // Caller sets this so FAB "Save" triggers the real save
        setSaveHandler(fn) {
            this._onSave = fn;
        }

        // ---- Toasts ----
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

        // ---- Image Highlight ----
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

        // ---- Settings Panel ----
        showSettings(onSave) {
            if (this._panelEl) return;
            log("Opening settings panel");
            const data = this.settings.getAll();
            const domain = window.location.hostname;
            const domainPath = (data.domainPaths || {})[domain] || "";

            const overlay = document.createElement("div");
            overlay.className = "ws-overlay";
            overlay.innerHTML = `
                <div class="ws-panel">
                    <h2><span>⚙</span> ${SCRIPT_NAME} Settings</h2>

                    <label>Save Mode</label>
                    <div class="ws-radio-group">
                        <label><input type="radio" name="ws-saveMode" value="single" ${data.saveMode === "single" ? "checked" : ""}> Single image</label>
                        <label><input type="radio" name="ws-saveMode" value="multiple" ${data.saveMode === "multiple" ? "checked" : ""}> All images</label>
                    </div>

                    <label>Sort By</label>
                    <div class="ws-radio-group">
                        <label><input type="radio" name="ws-sortBy" value="size" ${data.sortBy === "size" ? "checked" : ""}> Size (largest first)</label>
                        <label><input type="radio" name="ws-sortBy" value="time" ${data.sortBy === "time" ? "checked" : ""}> DOM order</label>
                    </div>

                    <label>Image Format</label>
                    <select id="ws-imageFormat">
                        ${OUTPUT_FORMATS.map(f => `<option value="${f}" ${data.imageFormat === f ? "selected" : ""}>${f === "original" ? "Original" : f.toUpperCase()}</option>`).join("")}
                    </select>

                    <label>Name Template</label>
                    <input type="text" id="ws-nameTemplate" value="${data.nameTemplate}">
                    <div class="ws-hint">Placeholders: {title} {domain} {url} {yyyy} {mm} {dd} {hh} {MM} {ss} {index} {ext}</div>

                    <label>Default Save Path (subfolder in downloads)</label>
                    <input type="text" id="ws-defaultSavePath" value="${data.defaultSavePath}" placeholder="e.g. web-saver">

                    <label>Save Path for <b>${domain}</b></label>
                    <input type="text" id="ws-domainPath" value="${domainPath}" placeholder="Leave empty to use default">

                    <label>Conflict Handling</label>
                    <div class="ws-radio-group">
                        <label><input type="radio" name="ws-conflict" value="uniquify" ${data.conflictAction === "uniquify" ? "checked" : ""}> Add number</label>
                        <label><input type="radio" name="ws-conflict" value="overwrite" ${data.conflictAction === "overwrite" ? "checked" : ""}> Overwrite</label>
                        <label><input type="radio" name="ws-conflict" value="skip" ${data.conflictAction === "skip" ? "checked" : ""}> Skip</label>
                        <label><input type="radio" name="ws-conflict" value="prompt" ${data.conflictAction === "prompt" ? "checked" : ""}> Prompt</label>
                    </div>

                    <label>Min Image Size (px)</label>
                    <input type="number" id="ws-minImageSize" value="${data.minImageSize}" min="0" max="1000" style="width:100px;">

                    <div class="ws-actions">
                        <button class="ws-btn-danger" id="ws-btn-reset">Reset</button>
                        <button class="ws-btn-secondary" id="ws-btn-cancel">Cancel</button>
                        <button class="ws-btn-primary" id="ws-btn-save">Save</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);
            this._panelEl = overlay;

            // Close on backdrop click
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) this.hideSettings();
            });

            // Close on Escape
            const escHandler = (e) => {
                if (e.key === "Escape") {
                    this.hideSettings();
                    document.removeEventListener("keydown", escHandler, true);
                }
            };
            document.addEventListener("keydown", escHandler, true);

            // Cancel
            overlay.querySelector("#ws-btn-cancel").addEventListener("click", () => this.hideSettings());

            // Reset
            overlay.querySelector("#ws-btn-reset").addEventListener("click", () => {
                if (confirm("Reset all settings to default?")) {
                    this.settings.reset();
                    this.hideSettings();
                    this.toast("Settings reset to defaults", "info");
                }
            });

            // Save
            overlay.querySelector("#ws-btn-save").addEventListener("click", () => {
                const newData = {
                    saveMode: overlay.querySelector('input[name="ws-saveMode"]:checked')?.value || "single",
                    sortBy: overlay.querySelector('input[name="ws-sortBy"]:checked')?.value || "size",
                    imageFormat: overlay.querySelector("#ws-imageFormat").value,
                    nameTemplate: overlay.querySelector("#ws-nameTemplate").value || Settings.DEFAULTS.nameTemplate,
                    defaultSavePath: overlay.querySelector("#ws-defaultSavePath").value.trim(),
                    conflictAction: overlay.querySelector('input[name="ws-conflict"]:checked')?.value || "uniquify",
                    minImageSize: parseInt(overlay.querySelector("#ws-minImageSize").value, 10) || MIN_IMAGE_SIZE_DEFAULT,
                    firstRun: false,
                };

                // Preserve existing domainPaths, update current domain
                const domainPaths = { ...(this.settings.get("domainPaths") || {}) };
                const dp = overlay.querySelector("#ws-domainPath").value.trim();
                if (dp) { domainPaths[domain] = dp; } else { delete domainPaths[domain]; }
                newData.domainPaths = domainPaths;

                this.settings.setAll(newData);
                this.hideSettings();
                this.toast("Settings saved", "success");
                if (onSave) onSave();
            });
        }

        hideSettings() {
            if (this._panelEl) {
                this._panelEl.remove();
                this._panelEl = null;
                log("Settings panel closed");
            }
        }

        isSettingsOpen() {
            return !!this._panelEl;
        }
    }

    // =========================================================================
    // WebSaver — Main Orchestrator
    // =========================================================================
    class WebSaver {
        constructor() {
            log("Initializing...");
            try {
                this.settings = new Settings();
            } catch (e) {
                error("Settings init failed:", e);
                this.settings = { _data: {}, get: (k) => Settings.DEFAULTS[k], set: () => { }, getAll: () => ({ ...Settings.DEFAULTS }), setAll: () => { }, getSavePath: () => "", reset: () => { } };
            }

            this.fileNamer = new FileNamer(this.settings);
            this.collector = new ImageCollector(this.settings);
            this.saver = new ImageSaver(this.settings, this.fileNamer);
            this.ui = new UIManager(this.settings);

            // Initialize UI (styles + FAB) — separate from constructor to isolate errors
            try {
                this.ui.init();
            } catch (e) {
                error("UI init failed:", e);
            }

            this.ui.setSaveHandler(() => this.saveImages());

            this._bindHotkeys();
            this._registerMenu();
            this._checkFirstRun();
            log("Initialized successfully. Press Ctrl+Alt+I to save images.");
        }

        _bindHotkeys() {
            // Use capture phase on window to intercept before page handlers
            window.addEventListener("keydown", (e) => {
                if (e.ctrlKey && e.altKey && (e.key === "i" || e.key === "I")) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    log("Hotkey Ctrl+Alt+I triggered");
                    this.saveImages();
                }
                // Ctrl+Alt+O — open settings
                if (e.ctrlKey && e.altKey && (e.key === "o" || e.key === "O")) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    log("Hotkey Ctrl+Alt+O triggered (settings)");
                    this.ui.showSettings();
                }
            }, true); // ← capture phase
            log("Hotkeys bound (Ctrl+Alt+I = save, Ctrl+Alt+O = settings)");
        }

        _registerMenu() {
            gmRegisterMenuCommand("⚙ Settings", () => this.ui.showSettings());
            gmRegisterMenuCommand("📷 Save Image(s)", () => this.saveImages());
            log("Menu commands registered");
        }

        _checkFirstRun() {
            if (this.settings.get("firstRun")) {
                log("First run detected — showing welcome");
                setTimeout(() => {
                    this.ui.toast(
                        `${SCRIPT_NAME} installed! Press Ctrl+Alt+I to save images, or click the 📷 button.`,
                        "info", 6000
                    );
                    setTimeout(() => this.ui.showSettings(), 2000);
                }, 1500);
            }
        }

        async saveImages() {
            if (this.ui.isSettingsOpen()) return;

            log("Save triggered — collecting images...");
            const allImages = this.collector.collect();
            if (allImages.length === 0) {
                this.ui.toast("No images found on this page", "info");
                return;
            }

            const selected = this.collector.select(allImages);
            if (selected.length === 0) {
                this.ui.toast("No images matched the criteria", "info");
                return;
            }

            log(`Selected ${selected.length} image(s) for saving`);
            this.ui.highlightImages(selected);

            const mode = this.settings.get("saveMode");
            this.ui.toast(
                mode === "single"
                    ? `Saving image (${selected[0].width}×${selected[0].height})...`
                    : `Saving ${selected.length} images...`,
                "info", 2000
            );

            const results = await this.saver.save(selected);

            const succeeded = results.filter((r) => r.status === "success");
            const failed = results.filter((r) => r.status === "error");
            const skipped = results.filter((r) => r.status === "skipped");

            if (succeeded.length > 0) {
                this.ui.toast(
                    `✓ Saved ${succeeded.length} image(s): ${succeeded.map((r) => r.filename).join(", ")}`,
                    "success", 4000
                );
            }
            if (skipped.length > 0) {
                this.ui.toast(`⊘ Skipped ${skipped.length} image(s) (already saved)`, "info", 3000);
            }
            if (failed.length > 0) {
                this.ui.toast(
                    `✗ Failed: ${failed.map((r) => `${r.filename}: ${r.error}`).join("; ")}`,
                    "error", 5000
                );
            }
        }
    }

    // =========================================================================
    // Initialize — wrapped in try-catch with error reporting
    // =========================================================================
    try {
        const webSaver = new WebSaver();
    } catch (e) {
        error("Fatal initialization error:", e);
        // Even if main init fails, try to show a visible error
        try {
            const errDiv = document.createElement("div");
            errDiv.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#f44336;color:#fff;padding:12px 18px;border-radius:8px;font:13px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);";
            errDiv.textContent = `${SCRIPT_NAME}: Init error — check console (F12)`;
            document.body.appendChild(errDiv);
            setTimeout(() => errDiv.remove(), 8000);
        } catch (_) { }
    }
})();