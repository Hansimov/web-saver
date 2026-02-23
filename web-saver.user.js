// ==UserScript==
// @name         Web Saver
// @namespace    http://tampermonkey.net/
// @version      2026-02-23
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
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    "use strict";

    // =====================================================================
    // 日志
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
    const HASH_STORE_KEY = "ws_hash_store";
    const HASH_STORE_MAX = 5000;           // 哈希存储最大条目数
    const MIN_IMAGE_SIZE_DEFAULT = 50;

    const VALID_IMAGE_EXTS = [
        "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "avif", "ico",
    ];
    const OUTPUT_FORMATS = ["original", "png", "jpg", "webp"];

    // =====================================================================
    // GM_* API 安全封装
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
        try { if (typeof GM_addStyle === "function") { GM_addStyle(css); return; } } catch (_) { }
        const s = document.createElement("style");
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }

    function gmRegisterMenuCommand(label, fn) {
        try { if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand(label, fn); } catch (_) { }
    }

    function gmDownload(opts) {
        if (typeof GM_download === "function") {
            try { GM_download(opts); return true; } catch (_) { }
        }
        return false;
    }

    /** 通过 GM_xmlhttpRequest 获取图片二进制数据（可跨域） */
    function gmFetchBinary(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === "function") {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    responseType: "arraybuffer",
                    onload: (resp) => {
                        if (resp.status >= 200 && resp.status < 400) {
                            resolve(resp.response);
                        } else {
                            reject(new Error("HTTP " + resp.status));
                        }
                    },
                    onerror: (e) => reject(new Error(e?.error || "请求失败")),
                    ontimeout: () => reject(new Error("请求超时")),
                });
            } else {
                // 降级：使用 fetch（受 CORS 限制）
                fetch(url).then(r => {
                    if (!r.ok) throw new Error("HTTP " + r.status);
                    return r.arrayBuffer();
                }).then(resolve).catch(reject);
            }
        });
    }

    // =====================================================================
    // 工具函数
    // =====================================================================

    /** 从 URL 提取图片扩展名，默认 jpg */
    function getExtFromUrl(url) {
        try {
            const pathname = new URL(url, window.location.href).pathname;
            const m = pathname.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
            if (m) {
                let ext = m[1].toLowerCase();
                if (ext === "jpeg") ext = "jpg";
                if (VALID_IMAGE_EXTS.includes(ext)) return ext;
            }
        } catch (_) { }
        return "jpg";
    }

    /** 清理文件名中的非法字符（仅用于文件名，不可用于路径） */
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

    /**
     * 测试 URL 路径是否匹配 glob 模式。
     * 模式中 * 匹配任意字符（包括 /），用于 URL 排除规则。
     */
    function urlMatchesGlob(url, pattern) {
        if (!url || !pattern) return false;
        try {
            const pathname = new URL(url, window.location.href).pathname;
            const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            const regexStr = escaped.replace(/\*/g, '.*');
            return new RegExp(regexStr, 'i').test(pathname);
        } catch (_) {
            return false;
        }
    }

    /**
     * 计算二进制数据的内容哈希（cyrb53 算法，53 位精度）
     * 返回 base36 字符串
     */
    function computeHash(buffer) {
        const view = new Uint8Array(buffer);
        const len = view.length;
        let h1 = 0xdeadbeef ^ len;
        let h2 = 0x41c6ce57 ^ len;
        for (let i = 0; i < len; i++) {
            h1 = Math.imul(h1 ^ view[i], 2654435761);
            h2 = Math.imul(h2 ^ view[i], 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    /** 获取图片的内容哈希。如获取失败，降级为 URL 哈希。 */
    async function computeImageHash(url) {
        try {
            const buffer = await gmFetchBinary(url);
            const hash = computeHash(buffer);
            log("图片哈希:", hash, "←", url.substring(0, 80));
            return hash;
        } catch (e) {
            warn("无法获取图片计算哈希，降级为 URL 哈希:", e.message);
            // URL 的简单哈希作为降级
            let h = 0;
            for (let i = 0; i < url.length; i++) {
                h = Math.imul(31, h) + url.charCodeAt(i) | 0;
            }
            return "url-" + (h >>> 0).toString(36);
        }
    }

    // =====================================================================
    // 图片评分 —— 多维度启发式算法，识别页面中真正展示的主图
    // =====================================================================
    class ImageScorer {
        constructor() {
            this._vpWidth = 0;
            this._vpHeight = 0;
            this._vpArea = 0;
            this._vpCenterX = 0;
            this._vpCenterY = 0;
        }

        /** 刷新视口尺寸 */
        _refresh() {
            this._vpWidth = window.innerWidth || document.documentElement.clientWidth || 1;
            this._vpHeight = window.innerHeight || document.documentElement.clientHeight || 1;
            this._vpArea = this._vpWidth * this._vpHeight;
            this._vpCenterX = this._vpWidth / 2;
            this._vpCenterY = this._vpHeight / 2;
        }

        /** 对所有图片进行评分 */
        scoreAll(images) {
            this._refresh();
            for (const img of images) {
                img.score = this.score(img);
            }
            return images;
        }

        /**
         * 对单张图片进行多维度评分（0-100）
         * 评分越高 → 越可能是用户想要保存的主图
         */
        score(imageInfo) {
            let total = 0;
            const el = imageInfo.element;
            if (!el) return total;
            try {
                total += this._visibilityScore(el);
                total += this._prominenceScore(el);
                total += this._semanticScore(el);
                total += this._contentScore(el, imageInfo);
                total += this._resolutionScore(imageInfo);
                total += this._urlScore(imageInfo);
                total += this._overlayBonus(el);
                total -= this._occlusionPenalty(el);
            } catch (e) {
                warn("图片评分异常:", e);
            }
            return Math.max(0, Math.round(total));
        }

        /**
         * 视口可见性 + 中心距离（0-25 分）
         * 当前视口中可见且居中的图片得分最高
         */
        _visibilityScore(el) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return 0;
            const visLeft = Math.max(rect.left, 0);
            const visTop = Math.max(rect.top, 0);
            const visRight = Math.min(rect.right, this._vpWidth);
            const visBottom = Math.min(rect.bottom, this._vpHeight);
            if (visRight <= visLeft || visBottom <= visTop) return 0;
            const visArea = (visRight - visLeft) * (visBottom - visTop);
            const elArea = rect.width * rect.height;
            const visRatio = elArea > 0 ? visArea / elArea : 0;
            let score = visRatio * 15;
            const elCenterX = (rect.left + rect.right) / 2;
            const elCenterY = (rect.top + rect.bottom) / 2;
            const distX = Math.abs(elCenterX - this._vpCenterX) / this._vpWidth;
            const distY = Math.abs(elCenterY - this._vpCenterY) / this._vpHeight;
            const centerDist = Math.sqrt(distX * distX + distY * distY);
            score += Math.max(0, (1 - centerDist * 2)) * 10;
            return score;
        }

        /**
         * 视觉显著性 —— 渲染面积占视口比例（0-25 分）
         */
        _prominenceScore(el) {
            const rect = el.getBoundingClientRect();
            const renderedArea = rect.width * rect.height;
            if (renderedArea <= 0 || this._vpArea <= 0) return 0;
            return Math.min((renderedArea / this._vpArea) * 50, 25);
        }

        /**
         * 语义上下文（0-20 分）
         * 遍历父元素链，检查内容容器、灯箱、画廊等
         */
        _semanticScore(el) {
            let score = 0;
            let node = el;
            for (let i = 0; i < 10 && node && node !== document.body; i++) {
                const tag = (node.tagName || "").toLowerCase();
                const cls = (typeof node.className === "string" ? node.className : "").toLowerCase();
                const role = (node.getAttribute?.("role") || "").toLowerCase();
                if (tag === "main" || role === "main") score += 6;
                if (tag === "article") score += 5;
                if (tag === "figure") score += 5;
                if (tag === "picture") score += 4;
                if (/lightbox|fancybox|modal|overlay|viewer|gallery.?main|photo.?detail|image.?view|swiper.?slide/i.test(cls)) {
                    score += 8;
                }
                if (role === "dialog") score += 4;
                if (/\b(content|post|entry|detail|artwork|illustration)\b/i.test(cls)) {
                    score += 3;
                }
                node = node.parentElement;
            }
            return Math.min(score, 20);
        }

        /**
         * 内容信号（0-15 分）
         * 判断是内容图片还是装饰元素
         */
        _contentScore(el, imageInfo) {
            let score = 0;
            const tag = (el.tagName || "").toLowerCase();
            const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
            const alt = (el.alt || "").toLowerCase();
            const src = (imageInfo.url || "").toLowerCase();
            if (tag === "img" && el.alt && el.alt.length > 3) score += 3;
            if (/\b(icon|logo|avatar|profile|badge|emoji|spinner|loading)\b/i.test(cls)) score -= 10;
            if (/\b(icon|logo|avatar|profile|badge|emoji)\b/i.test(alt)) score -= 5;
            if (/\b(icon|logo|avatar|favicon|emoji|sprite|placeholder)\b/i.test(src)) score -= 5;
            const w = imageInfo.width || 1;
            const h = imageInfo.height || 1;
            const ratio = Math.max(w / h, h / w);
            if (ratio <= 2.5) score += 4;
            else if (ratio > 5) score -= 3;
            if (imageInfo.type === "img") score += 3;
            else if (imageInfo.type === "lazy") score += 2;
            if (w >= 200 && h >= 200) score += 3;
            if (w >= 400 && h >= 400) score += 2;
            return Math.min(Math.max(score, 0), 15);
        }

        /**
         * 原始分辨率（0-15 分）
         * 高分辨率图片更可能是内容主图
         */
        _resolutionScore(imageInfo) {
            const area = imageInfo.area || 0;
            if (area >= 1000000) return 15;
            if (area >= 500000) return 12;
            if (area >= 250000) return 9;
            if (area >= 100000) return 6;
            if (area >= 40000) return 3;
            return 0;
        }

        /**
         * URL 模式评分（-10 到 +10 分）
         * 根据 URL 路径特征判断是否为内容图片
         */
        _urlScore(imageInfo) {
            const url = (imageInfo.url || '');
            let score = 0;
            try {
                const pathname = new URL(url, window.location.href).pathname.toLowerCase();
                // 有明确图片扩展名 → 更可能是内容图片
                if (/\.(jpe?g|png|gif|webp|avif|bmp|tiff|svg)$/i.test(pathname)) {
                    score += 5;
                }
                // 无任何文件扩展名（API 端点、动态路径）→ 降分
                else if (!/\.\w{1,5}$/.test(pathname)) {
                    score -= 5;
                }
                // 图片服务路径加分
                if (/\/(images?|uploads?|photos?|media|gallery|pictures?|artworks?)\//i.test(pathname)) {
                    score += 3;
                }
                // 用户/头像相关路径降分
                if (/\/(users?|avatars?|profiles?|accounts?)\//i.test(pathname)) {
                    score -= 5;
                }
                // 以通用端点名结尾降分
                if (/\/(content|data|blob|file|thumbnail|thumb)$/i.test(pathname)) {
                    score -= 3;
                }
            } catch (_) { }
            return Math.min(Math.max(score, -10), 10);
        }

        /**
         * 覆盖层加成（0-20 分）
         * 如果图片位于高 z-index 的覆盖层/模态框/灯箱中，大幅加分。
         * 这使得用户打开灯箱查看大图时，灯箱中的图片会自动成为最佳候选。
         */
        _overlayBonus(el) {
            let score = 0;
            let node = el;
            for (let i = 0; i < 15 && node && node !== document.body; i++) {
                try {
                    const style = getComputedStyle(node);
                    const pos = style.position;
                    const zIndex = parseInt(style.zIndex, 10) || 0;

                    // 高 z-index + fixed/absolute 定位 = 覆盖层
                    if ((pos === 'fixed' || pos === 'absolute') && zIndex >= 100) {
                        const rect = node.getBoundingClientRect();
                        const coversViewport = rect.width >= this._vpWidth * 0.5 &&
                            rect.height >= this._vpHeight * 0.5;
                        if (coversViewport) {
                            score = Math.max(score, zIndex >= 1000 ? 20 : 15);
                        } else {
                            score = Math.max(score, 10);
                        }
                    }

                    // role="dialog" 标记
                    const role = (node.getAttribute?.('role') || '').toLowerCase();
                    if (role === 'dialog') score = Math.max(score, 15);

                    // <dialog> 元素（HTML5 原生对话框）
                    if ((node.tagName || '').toLowerCase() === 'dialog' && node.open) {
                        score = Math.max(score, 15);
                    }
                } catch (_) { }
                node = node.parentElement;
            }
            return Math.min(score, 20);
        }

        /**
         * 遮挡惩罚（0-20 分）
         * 如果图片被覆盖层遮挡（不是顶层可见元素），扣分。
         * 当灯箱/模态框打开时，背景中的图片将被大幅惩罚。
         */
        _occlusionPenalty(el) {
            try {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return 20;

                // 取图片中心点
                const cx = (rect.left + rect.right) / 2;
                const cy = (rect.top + rect.bottom) / 2;

                // 确保中心点在视口内（视口外的图片不做遮挡检测）
                if (cx < 0 || cx >= this._vpWidth || cy < 0 || cy >= this._vpHeight) return 0;

                const topEl = document.elementFromPoint(cx, cy);
                if (!topEl) return 0;

                // 如果顶层元素是图片自身、或互为祖先/后代，则未被遮挡
                if (topEl === el || el.contains(topEl) || topEl.contains(el)) return 0;

                // 被遮挡 → 惩罚
                return 20;
            } catch (_) {
                return 0;
            }
        }
    }

    // =====================================================================
    // 原图 URL 解析 —— 尝试从缩略图/展示图找到最高分辨率原图
    // =====================================================================
    class OriginalUrlResolver {
        /**
         * 对给定图片信息，尝试解析出原始/高分辨率 URL。
         * 返回最佳候选 URL；无法解析则返回原始 URL。
         */
        resolve(imageInfo) {
            const candidates = [];
            const el = imageInfo.element;
            const currentUrl = imageInfo.url;
            if (el) {
                this._fromParentLink(el, candidates);
                this._fromDataAttributes(el, candidates);
                this._fromSrcset(el, candidates);
                this._fromPictureSource(el, candidates);
            }
            this._fromUrlPatterns(currentUrl, candidates);
            const seen = new Set([currentUrl]);
            for (const c of candidates) {
                if (c && !seen.has(c)) return c;
            }
            return currentUrl;
        }

        /** 检查父级 <a> 是否链接到高分辨率图片 */
        _fromParentLink(el, out) {
            let node = el.parentElement;
            for (let i = 0; i < 3 && node; i++) {
                if ((node.tagName || "").toLowerCase() === "a") {
                    const href = node.href;
                    if (href && this._looksLikeImageUrl(href)) out.push(href);
                    break;
                }
                node = node.parentElement;
            }
        }

        /** 从 data-* 属性中提取高分辨率 URL */
        _fromDataAttributes(el, out) {
            const attrs = [
                "data-original", "data-src-full", "data-zoom-src",
                "data-full-src", "data-large-src", "data-hi-res-src",
                "data-raw-src", "data-original-src", "data-max-src",
                "data-high-res", "data-zoom", "data-orig",
            ];
            for (const attr of attrs) {
                const val = el.getAttribute(attr);
                if (val) out.push(this._toAbsolute(val));
            }
        }

        /** 从 srcset 中提取最高分辨率变体 */
        _fromSrcset(el, out) {
            const srcset = el.getAttribute("srcset");
            if (!srcset) return;
            const best = this._parseSrcsetBest(srcset);
            if (best) out.push(this._toAbsolute(best));
        }

        /** 从 <picture> 的 <source> 中提取最高分辨率变体 */
        _fromPictureSource(el, out) {
            const picture = el.closest?.("picture");
            if (!picture) return;
            for (const source of picture.querySelectorAll("source")) {
                const srcset = source.getAttribute("srcset");
                if (!srcset) continue;
                const candidate = this._parseSrcsetBest(srcset);
                if (candidate) out.push(this._toAbsolute(candidate));
            }
        }

        /** 通过 URL 模式替换尝试获取原图 */
        _fromUrlPatterns(url, out) {
            try {
                const u = new URL(url, window.location.href);
                const resizeParams = [
                    "w", "h", "width", "height", "resize", "size",
                    "fit", "quality", "q", "auto", "dpr", "tw", "th", "sw", "sh",
                ];
                let modified = false;
                for (const p of resizeParams) {
                    if (u.searchParams.has(p)) {
                        u.searchParams.delete(p);
                        modified = true;
                    }
                }
                if (modified) out.push(u.href);
                const pathname = u.pathname;
                const patterns = [
                    [/(_thumb|_small|_medium|_s|_m|_t)(\.[a-z]+)$/i, "$2"],
                    [/\/thumb(nail)?s?\//i, "/originals/"],
                    [/\/resize\/\d+x?\d*\//i, "/"],
                    [/-\d+x\d+(\.[a-z]+)$/i, "$1"],
                    [/\/[wh]_\d+(?:,[wh]_\d+)*\//gi, "/"],
                    [/\/(small|medium|thumbnail)\//i, "/large/"],
                ];
                for (const [regex, replacement] of patterns) {
                    if (regex.test(pathname)) {
                        const newPath = pathname.replace(regex, replacement);
                        if (newPath !== pathname) {
                            const newUrl = new URL(u.href);
                            newUrl.pathname = newPath;
                            out.push(newUrl.href);
                        }
                    }
                }
            } catch (_) { }
        }

        /** 解析 srcset 属性，返回最大尺寸的 URL */
        _parseSrcsetBest(srcset) {
            let best = null;
            let bestSize = 0;
            for (const entry of srcset.split(",")) {
                const parts = entry.trim().split(/\s+/);
                if (parts.length < 1 || !parts[0]) continue;
                const url = parts[0];
                let size = 1;
                if (parts[1]) {
                    const m = parts[1].match(/^(\d+)[wx]$/i);
                    if (m) size = parseInt(m[1], 10);
                }
                if (size > bestSize) {
                    bestSize = size;
                    best = url;
                }
            }
            return best;
        }

        _looksLikeImageUrl(url) {
            if (!url) return false;
            try {
                const pathname = new URL(url, window.location.href).pathname.toLowerCase();
                return /\.(jpe?g|png|gif|webp|svg|bmp|avif|tiff)(\?|$)/i.test(pathname);
            } catch (_) { return false; }
        }

        _toAbsolute(url) {
            try { return new URL(url, window.location.href).href; }
            catch (_) { return url; }
        }
    }

    // =====================================================================
    // DOM 监视器 —— 检测页面动态变化（灯箱/模态框/覆盖层等）
    // =====================================================================
    class DOMWatcher {
        /**
         * @param {Function} callback 当检测到显著 DOM 变化时调用
         */
        constructor(callback) {
            this._callback = callback;
            this._observer = null;
            this._debounceTimer = null;
            this._lastNotify = 0;
        }

        /** 开始监视 DOM 变化 */
        start() {
            if (this._observer) return;
            const target = document.body || document.documentElement;
            if (!target) {
                warn("DOM 监视器：无法找到监视目标");
                return;
            }
            try {
                this._observer = new MutationObserver((mutations) => {
                    if (this._isSignificantChange(mutations)) {
                        this._debouncedNotify();
                    }
                });
                this._observer.observe(target, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['style', 'class', 'src', 'data-src', 'srcset'],
                });
                log("DOM 监视器已启动");
            } catch (e) {
                warn("DOM 监视器启动失败:", e);
            }
        }

        /**
         * 判断一组 DOM 变化是否"显著"——是否可能影响最佳下载图片。
         * 仅关注：新增图片/覆盖层、图片 src 变化、覆盖层显隐。
         */
        _isSignificantChange(mutations) {
            for (const m of mutations) {
                // 新增节点：检查是否包含图片或是覆盖层
                if (m.type === 'childList') {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        // 跳过脚本自身的 UI 元素
                        if ((node.tagName || '').toLowerCase() === 'ws-root') continue;
                        // 新增了图片相关元素
                        if (node.tagName === 'IMG' || node.querySelector?.('img')) return true;
                        if (node.tagName === 'PICTURE' || node.tagName === 'VIDEO') return true;
                        // 新增了可能是覆盖层的元素
                        try {
                            const style = getComputedStyle(node);
                            if ((style.position === 'fixed' || style.position === 'absolute') &&
                                (parseInt(style.zIndex, 10) || 0) >= 50) {
                                return true;
                            }
                        } catch (_) { }
                        // 检查 role/class 是否暗示对话框/灯箱
                        const role = (node.getAttribute?.('role') || '').toLowerCase();
                        if (role === 'dialog') return true;
                        const cls = (typeof node.className === 'string' ? node.className : '').toLowerCase();
                        if (/lightbox|fancybox|modal|overlay|viewer|gallery|image.?view/i.test(cls)) return true;
                    }
                }

                // 属性变化：检查 src 变化或样式变化（可能是覆盖层显隐）
                if (m.type === 'attributes') {
                    const el = m.target;
                    // 跳过脚本自身的 UI 元素
                    if ((el.tagName || '').toLowerCase() === 'ws-root') continue;
                    if (el.tagName === 'IMG' && (m.attributeName === 'src' || m.attributeName === 'srcset')) return true;
                    if (m.attributeName === 'style' || m.attributeName === 'class') {
                        try {
                            const style = getComputedStyle(el);
                            if ((style.position === 'fixed' || style.position === 'absolute') &&
                                (parseInt(style.zIndex, 10) || 0) >= 50) {
                                return true;
                            }
                        } catch (_) { }
                        const role = (el.getAttribute?.('role') || '').toLowerCase();
                        if (role === 'dialog') return true;
                        const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
                        if (/lightbox|fancybox|modal|overlay|viewer|gallery|image.?view/i.test(cls)) return true;
                    }
                }
            }
            return false;
        }

        /** 防抖通知——在变化平息后触发回调，最小间隔 300ms */
        _debouncedNotify() {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                const now = Date.now();
                if (now - this._lastNotify < 300) return;
                this._lastNotify = now;
                try {
                    this._callback();
                } catch (e) {
                    warn("DOM 变化回调异常:", e);
                }
            }, 200);
        }

        /** 停止监视 */
        stop() {
            if (this._observer) {
                this._observer.disconnect();
                this._observer = null;
            }
            clearTimeout(this._debounceTimer);
        }
    }

    // =====================================================================
    // 哈希存储（持久化，跨会话）
    // =====================================================================
    class HashStore {
        constructor() {
            this._store = {};
            this.load();
        }

        load() {
            try {
                const raw = gmGetValue(HASH_STORE_KEY, null);
                if (raw) {
                    this._store = typeof raw === "string" ? JSON.parse(raw) : raw;
                }
            } catch (e) {
                warn("加载哈希存储失败:", e);
                this._store = {};
            }
        }

        save() {
            gmSetValue(HASH_STORE_KEY, JSON.stringify(this._store));
        }

        has(hash) {
            return hash in this._store;
        }

        get(hash) {
            return this._store[hash] || null;
        }

        set(hash, info) {
            this._store[hash] = { ...info, savedAt: Date.now() };
            this._prune();
            this.save();
        }

        /** 超过上限时删除最旧的条目 */
        _prune() {
            const keys = Object.keys(this._store);
            if (keys.length <= HASH_STORE_MAX) return;
            const sorted = keys.sort((a, b) =>
                (this._store[a].savedAt || 0) - (this._store[b].savedAt || 0)
            );
            const toRemove = sorted.slice(0, keys.length - HASH_STORE_MAX);
            for (const k of toRemove) delete this._store[k];
        }

        get size() {
            return Object.keys(this._store).length;
        }

        clear() {
            this._store = {};
            this.save();
            log("哈希存储已清空");
        }
    }

    // =====================================================================
    // 设置
    // =====================================================================
    class Settings {
        static DEFAULTS = {
            saveMode: "single",
            sortBy: "relevance",
            imageFormat: "original",
            nameTemplate: "{yyyy}-{mm}-{dd}-{hh}{MM}{ss}",
            defaultSavePath: "",
            domainPaths: {},
            conflictAction: "uniquify",
            duplicateAction: "skip",         // 'skip' | 'latest'
            domainExcludes: {},             // { "domain": "pattern1\npattern2" }
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
        set(key, value) { this._data[key] = value; this.save(); }
        getAll() { return { ...this._data }; }

        setAll(obj) {
            Object.assign(this._data, obj);
            this.save();
        }

        getSavePath() {
            const domain = window.location.hostname;
            const dp = this._data.domainPaths || {};
            return normalizePath(dp[domain] || this._data.defaultSavePath || "");
        }

        /** 获取当前域名的 URL 排除模式列表 */
        getExcludePatterns() {
            const domain = window.location.hostname;
            const de = this._data.domainExcludes || {};
            const raw = de[domain] || '';
            return raw.split('\n').map(p => p.trim()).filter(p => p.length > 0);
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

        generate(context = {}) {
            const template = this.settings.get("nameTemplate");
            const now = new Date();
            const title = sanitizeFilename(document.title).substring(0, 100);

            const map = {
                "{title}": title,
                "{domain}": window.location.hostname,
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
        constructor(settings) {
            this.settings = settings;
            this.scorer = new ImageScorer();
            this.resolver = new OriginalUrlResolver();
        }

        collect() {
            const images = [];
            const seen = new Set();
            const minSize = this.settings.get("minImageSize") || MIN_IMAGE_SIZE_DEFAULT;

            // 1. <img> 元素
            document.querySelectorAll("img").forEach((img, idx) => {
                const url = img.currentSrc || img.src;
                if (!url || seen.has(url)) return;
                if (url.startsWith("data:") && url.length < 200) return;
                const w = img.naturalWidth || img.width;
                const h = img.naturalHeight || img.height;
                if (w < minSize && h < minSize) return;
                seen.add(url);
                images.push({ url, width: w, height: h, area: w * h, element: img, domIndex: idx, type: "img" });
            });

            // 2. 懒加载图片
            document.querySelectorAll("img[data-src], img[data-original], img[data-lazy-src]").forEach((img, idx) => {
                const url = img.dataset.src || img.dataset.original || img.dataset.lazySrc;
                if (!url || seen.has(url)) return;
                seen.add(url);
                const w = img.naturalWidth || img.width || 0;
                const h = img.naturalHeight || img.height || 0;
                images.push({ url, width: w, height: h, area: w * h, element: img, domIndex: 100000 + idx, type: "lazy" });
            });

            // 3. CSS 背景图片
            const allEls = document.querySelectorAll("*");
            if (allEls.length < 5000) {
                allEls.forEach((el, idx) => {
                    try {
                        const bg = getComputedStyle(el).backgroundImage;
                        if (!bg || bg === "none") return;
                        for (const m of bg.matchAll(/url\(["']?(.+?)["']?\)/g)) {
                            const url = m[1];
                            if (!url || seen.has(url) || url.startsWith("data:")) continue;
                            seen.add(url);
                            images.push({ url, width: el.offsetWidth, height: el.offsetHeight, area: el.offsetWidth * el.offsetHeight, element: el, domIndex: 200000 + idx, type: "bg" });
                        }
                    } catch (_) { }
                });
            }

            // 4. <video poster>
            document.querySelectorAll("video[poster]").forEach((video, idx) => {
                const url = video.poster;
                if (!url || seen.has(url)) return;
                seen.add(url);
                const w = video.videoWidth || video.offsetWidth;
                const h = video.videoHeight || video.offsetHeight;
                images.push({ url, width: w, height: h, area: w * h, element: video, domIndex: 300000 + idx, type: "poster" });
            });

            // 5. URL 排除过滤
            const excludePatterns = this.settings.getExcludePatterns();
            if (excludePatterns.length > 0) {
                for (let i = images.length - 1; i >= 0; i--) {
                    if (excludePatterns.some(p => urlMatchesGlob(images[i].url, p))) {
                        log("URL 排除:", images[i].url.substring(0, 80));
                        images.splice(i, 1);
                    }
                }
            }

            // 6. 评分 & 原图 URL 解析
            this.scorer.scoreAll(images);
            for (const img of images) {
                img.originalUrl = this.resolver.resolve(img);
                if (img.originalUrl !== img.url) {
                    log("发现原图:", img.originalUrl.substring(0, 80), "←", img.url.substring(0, 60));
                }
            }

            log(`收集到 ${images.length} 张图片`);
            return images;
        }

        sort(images) {
            const sortBy = this.settings.get("sortBy");
            if (sortBy === "relevance") return [...images].sort((a, b) => (b.score || 0) - (a.score || 0));
            if (sortBy === "size") return [...images].sort((a, b) => b.area - a.area);
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

    // =====================================================================
    // 图片保存
    // =====================================================================
    class ImageSaver {
        constructor(settings, fileNamer, hashStore) {
            this.settings = settings;
            this.fileNamer = fileNamer;
            this.hashStore = hashStore;
            this._sessionNames = new Set();
        }

        async save(images) {
            const results = [];
            const savePath = this.settings.getSavePath();
            const conflictAction = this.settings.get("conflictAction");
            const dupAction = this.settings.get("duplicateAction") || "skip";
            const format = this.settings.get("imageFormat");

            for (let i = 0; i < images.length; i++) {
                const image = images[i];
                const downloadSrc = image.originalUrl || image.url;
                if (downloadSrc !== image.url) {
                    log("使用原图 URL:", downloadSrc.substring(0, 80));
                }

                // —— 基于内容哈希的重复检测 ——
                let hash = null;
                try {
                    hash = await computeImageHash(downloadSrc);
                } catch (e) {
                    warn("哈希计算失败:", e.message);
                }

                if (hash && this.hashStore.has(hash)) {
                    const prev = this.hashStore.get(hash);
                    if (dupAction === "skip") {
                        log("重复图片已跳过 (哈希匹配):", hash, "→", prev.filename);
                        results.push({ filename: prev.filename, status: "skipped-dup" });
                        continue;
                    }
                    // 'latest' → 继续下载
                }

                let ext = getExtFromUrl(downloadSrc);
                if (format !== "original") ext = format;

                let filename = this.fileNamer.generate({ index: i + 1, ext });

                if (conflictAction === "uniquify") {
                    filename = this._uniquify(filename);
                }

                const fullPath = savePath + filename;

                if (conflictAction === "skip" && this._sessionNames.has(fullPath)) {
                    results.push({ filename: fullPath, status: "skipped" });
                    continue;
                }

                let downloadUrl = downloadSrc;
                if (format !== "original") {
                    try { downloadUrl = await this._convertImage(downloadSrc, format); }
                    catch (e) { warn("格式转换失败，使用原格式:", e); }
                }

                try {
                    await this._download(downloadUrl, fullPath, conflictAction);
                    this._sessionNames.add(fullPath);
                    // 持久化哈希记录
                    if (hash) {
                        this.hashStore.set(hash, { filename: fullPath, url: downloadSrc });
                    }
                    results.push({ filename: fullPath, status: "success" });
                    log("已保存:", fullPath);
                } catch (e) {
                    results.push({ filename: fullPath, status: "error", error: e.message });
                    error("下载失败:", fullPath, e.message);
                }
            }
            return results;
        }

        _uniquify(filename) {
            if (!this._sessionNames.has(filename)) return filename;
            const dot = filename.lastIndexOf(".");
            const base = dot > 0 ? filename.slice(0, dot) : filename;
            const ext = dot > 0 ? filename.slice(dot) : "";
            let n = 1;
            while (this._sessionNames.has(`${base}-${n}${ext}`)) n++;
            return `${base}-${n}${ext}`;
        }

        _download(url, name, conflictAction) {
            log("下载:", name);
            return new Promise((resolve, reject) => {
                const gmAction = conflictAction === "skip" ? "uniquify" : conflictAction;
                const ok = gmDownload({
                    url, name, conflictAction: gmAction,
                    onload: () => resolve(),
                    onerror: (e) => reject(new Error(e?.error || e?.details || "下载失败")),
                    ontimeout: () => reject(new Error("下载超时")),
                });
                if (!ok) {
                    log("GM_download 不可用，使用 <a> 降级");
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

        _convertImage(url, format) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    try {
                        const c = document.createElement("canvas");
                        c.width = img.naturalWidth; c.height = img.naturalHeight;
                        c.getContext("2d").drawImage(img, 0, 0);
                        resolve(c.toDataURL(`image/${format === "jpg" ? "jpeg" : format}`, 0.95));
                    } catch (e) { reject(e); }
                };
                img.onerror = () => reject(new Error("图片加载失败"));
                img.src = url;
            });
        }
    }

    // =====================================================================
    // UI 管理器 —— 使用 Shadow DOM 隔离确保在任何页面上都能正确显示
    // =====================================================================
    class UIManager {
        constructor(settings, hashStore) {
            this.settings = settings;
            this.hashStore = hashStore;
            this._settingsBtn = null;
            this._saveBtn = null;
            this._toastContainer = null;
            this._panelEl = null;
            this._onSave = null;
            this._onCollect = null;
            this._previewEl = null;
            this._previewTimer = null;
            this._highlightStyleInjected = false;
            this._host = null;
            this._shadow = null;
            this._imgDownloadBtn = null;
            this._hoveredImg = null;
            this._hoverHideTimer = null;
            this._onSaveSingle = null;
        }

        init() {
            this._ensureHost();
            this._injectGlobalCSS();
            this._createToastContainer();
            this._createFab();
            this._initImageHoverDownload();
            log("UI 已初始化 (Shadow DOM)");
        }

        /**
         * 用 !important 设置内联样式，作为 Shadow DOM 之外的额外防御层。
         */
        _s(el, styles) {
            for (const [prop, val] of Object.entries(styles)) {
                el.style.setProperty(prop, val, 'important');
            }
        }

        /** 创建 Shadow DOM 宿主元素，提供完全的样式隔离 */
        _ensureHost() {
            if (this._host && this._host.isConnected) return;

            const host = document.createElement('ws-root');
            host.setAttribute('style', [
                'all: initial',
                'position: fixed',
                'top: 0',
                'left: 0',
                'width: 0',
                'height: 0',
                'overflow: visible',
                'pointer-events: none',
                'z-index: 2147483646',
            ].map(s => s + ' !important').join('; ') + ';');

            let shadow;
            try {
                shadow = host.attachShadow({ mode: 'closed' });
            } catch (e) {
                warn("Shadow DOM 不可用，使用降级方案:", e);
                shadow = host;
            }
            this._shadow = shadow;

            // 将 keyframe 动画注入 Shadow Root（页面 CSS 无法影响）
            const style = document.createElement('style');
            style.textContent = `
                @keyframes ws-toast-slide-in {
                    from { transform: translateX(100%); opacity: 0; }
                    to   { transform: translateX(0);    opacity: 1; }
                }
            `;
            this._shadow.appendChild(style);

            // 挂载到 DOM（优先 body，降级到 documentElement）
            this._mountHost(host);
            this._host = host;

            // 监视移除并自动重新附加（应对 SPA 页面替换 body 内容）
            this._watchHost();
        }

        /** 挂载宿主元素到 DOM */
        _mountHost(host) {
            const target = document.body || document.documentElement;
            try {
                target.appendChild(host);
            } catch (e) {
                error("无法挂载 UI 容器:", e);
            }
        }

        /** 监视宿主元素是否被页面脚本移除，如被移除则重新附加 */
        _watchHost() {
            try {
                const observer = new MutationObserver(() => {
                    if (this._host && !this._host.isConnected) {
                        log("UI 容器被移除，正在重新附加...");
                        this._mountHost(this._host);
                    }
                });
                observer.observe(document.documentElement, { childList: true, subtree: true });
            } catch (e) {
                warn("MutationObserver 不可用:", e);
            }
        }

        /** 注入页面级 CSS（仅图片高亮样式，需作用于页面 DOM 元素） */
        _injectGlobalCSS() {
            gmAddStyle(`
                .ws-img-highlight {
                    outline: 3px solid #4CAF50 !important;
                    outline-offset: 2px;
                    box-shadow: 0 0 12px rgba(76,175,80,.5) !important;
                    transition: outline .3s, box-shadow .3s;
                }
            `);
            this._highlightStyleInjected = true;
        }

        // ---- Toast 容器 ----
        _createToastContainer() {
            const c = document.createElement("div");
            this._s(c, {
                'position': 'fixed',
                'bottom': '80px',
                'right': '20px',
                'display': 'flex',
                'flex-direction': 'column-reverse',
                'gap': '8px',
                'pointer-events': 'none',
                'z-index': '2147483646',
                'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'box-sizing': 'border-box',
                'margin': '0',
                'padding': '0',
            });
            this._shadow.appendChild(c);
            this._toastContainer = c;
        }

        // ---- FAB 浮动按钮 ----
        _createFab() {
            const FAB_BASE = {
                'position': 'fixed',
                'width': '44px',
                'height': '44px',
                'border-radius': '50%',
                'border': 'none',
                'cursor': 'pointer',
                'box-shadow': '0 2px 8px rgba(0,0,0,.3)',
                'z-index': '2147483646',
                'display': 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                'user-select': 'none',
                'pointer-events': 'auto',
                'transition': 'transform .2s, box-shadow .2s, opacity .3s',
                'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'padding': '0',
                'margin': '0',
                'box-sizing': 'border-box',
                'outline': 'none',
                'overflow': 'visible',
                'opacity': '0.6',
                'color': '#fff',
                'line-height': '44px',
                'text-align': 'center',
                'visibility': 'visible',
                'background-image': 'none',
                'min-width': '0',
                'min-height': '0',
                'text-decoration': 'none',
                'text-transform': 'none',
                'letter-spacing': 'normal',
                'text-indent': '0',
                'text-shadow': 'none',
                'float': 'none',
                'clear': 'none',
            };
            const HOVER_ON = {
                'transform': 'scale(1.12)',
                'opacity': '1',
                'box-shadow': '0 4px 16px rgba(0,0,0,.4)',
            };
            const HOVER_OFF = {
                'transform': 'scale(1)',
                'opacity': '0.6',
                'box-shadow': '0 2px 8px rgba(0,0,0,.3)',
            };

            // ⚙ 设置按钮
            const sBtn = document.createElement("button");
            this._s(sBtn, {
                ...FAB_BASE,
                'bottom': '20px',
                'right': '72px',
                'background': '#607D8B',
                'background-color': '#607D8B',
                'font-size': '18px',
            });
            sBtn.textContent = "⚙";
            sBtn.title = "打开设置 (Ctrl+Alt+O)";
            sBtn.addEventListener("mouseenter", () => this._s(sBtn, HOVER_ON));
            sBtn.addEventListener("mouseleave", () => this._s(sBtn, HOVER_OFF));
            sBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.showSettings();
            });
            this._shadow.appendChild(sBtn);
            this._settingsBtn = sBtn;

            // 📷 保存按钮
            const saveBtn = document.createElement("button");
            this._s(saveBtn, {
                ...FAB_BASE,
                'bottom': '20px',
                'right': '20px',
                'background': '#4CAF50',
                'background-color': '#4CAF50',
                'font-size': '20px',
            });
            saveBtn.textContent = "📷";
            saveBtn.title = "保存图片 (Ctrl+Alt+I)";
            saveBtn.addEventListener("mouseenter", () => {
                this._s(saveBtn, HOVER_ON);
                this._previewTimer = setTimeout(() => this._showPreview(), 300);
            });
            saveBtn.addEventListener("mouseleave", () => {
                this._s(saveBtn, HOVER_OFF);
                clearTimeout(this._previewTimer);
                this._hidePreview();
            });
            saveBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (this._onSave) this._onSave();
            });
            this._shadow.appendChild(saveBtn);
            this._saveBtn = saveBtn;

            log("FAB 按钮已创建并添加到页面");
        }

        // ---- 缩略图预览 ----
        _showPreview() {
            if (this._previewEl) return;
            const allImages = this._onCollect ? this._onCollect() : [];
            if (allImages.length === 0) return;

            const isSingle = this.settings.get("saveMode") === "single";
            const selectedUrls = new Set(
                isSingle ? [allImages[0]?.url] : allImages.map(img => img.url)
            );

            const panel = document.createElement("div");
            this._s(panel, {
                'position': 'fixed',
                'bottom': '74px',
                'right': '20px',
                'background': '#fff',
                'border-radius': '10px',
                'box-shadow': '0 4px 20px rgba(0,0,0,.2)',
                'padding': '10px',
                'display': 'grid',
                'grid-template-columns': 'repeat(3, 1fr)',
                'gap': '6px',
                'max-width': '300px',
                'max-height': '340px',
                'overflow-y': 'auto',
                'pointer-events': 'auto',
                'opacity': '0',
                'transform': 'translateY(8px)',
                'transition': 'opacity .2s, transform .2s',
                'z-index': '2147483646',
                'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'box-sizing': 'border-box',
                'margin': '0',
            });

            const maxShow = 9;
            allImages.slice(0, maxShow).forEach((img) => {
                const thumb = document.createElement("img");
                thumb.src = img.url;
                const isSel = selectedUrls.has(img.url);
                this._s(thumb, {
                    'width': '84px',
                    'height': '84px',
                    'object-fit': 'cover',
                    'border-radius': '6px',
                    'border': isSel ? '2px solid #4CAF50' : '2px solid #e0e0e0',
                    'background': '#f5f5f5',
                    'box-shadow': isSel ? '0 0 6px rgba(76,175,80,.4)' : 'none',
                    'box-sizing': 'border-box',
                    'display': 'block',
                });
                thumb.title = `${img.width || "?"}×${img.height || "?"} ${img.type}`;
                thumb.loading = "lazy";
                thumb.onerror = () => {
                    thumb.style.setProperty('display', 'none', 'important');
                };
                panel.appendChild(thumb);
            });

            const info = document.createElement("div");
            this._s(info, {
                'grid-column': '1 / -1',
                'text-align': 'center',
                'font-size': '12px',
                'color': '#888',
                'padding': '4px 0 0',
            });
            const willSave = isSingle ? 1 : allImages.length;
            info.textContent = allImages.length > maxShow
                ? `显示前 ${maxShow} 张，共 ${allImages.length} 张 · 将保存 ${willSave} 张`
                : `共 ${allImages.length} 张图片 · 将保存 ${willSave} 张`;
            panel.appendChild(info);

            this._shadow.appendChild(panel);
            this._previewEl = panel;
            // 强制 reflow 后触发 transition
            void panel.offsetHeight;
            this._s(panel, { 'opacity': '1', 'transform': 'translateY(0)' });
        }

        _hidePreview() {
            if (this._previewEl) {
                this._previewEl.remove();
                this._previewEl = null;
            }
        }

        setSaveHandler(fn) { this._onSave = fn; }
        setCollectHandler(fn) { this._onCollect = fn; }
        setSaveSingleHandler(fn) { this._onSaveSingle = fn; }

        // ---- 图片悬停下载按钮 ----
        _initImageHoverDownload() {
            const btn = document.createElement("button");
            this._s(btn, {
                'position': 'fixed',
                'width': '28px',
                'height': '28px',
                'border-radius': '50%',
                'border': 'none',
                'background': 'rgba(76,175,80,0.85)',
                'background-color': 'rgba(76,175,80,0.85)',
                'color': '#fff',
                'font-size': '14px',
                'line-height': '28px',
                'text-align': 'center',
                'cursor': 'pointer',
                'z-index': '2147483647',
                'pointer-events': 'auto',
                'box-shadow': '0 2px 6px rgba(0,0,0,.3)',
                'display': 'none',
                'align-items': 'center',
                'justify-content': 'center',
                'padding': '0',
                'margin': '0',
                'box-sizing': 'border-box',
                'transition': 'transform .15s, background .15s',
                'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'user-select': 'none',
            });
            btn.textContent = "⬇";
            btn.title = "下载此图片";

            btn.addEventListener("mouseenter", () => {
                clearTimeout(this._hoverHideTimer);
                this._s(btn, { 'transform': 'scale(1.15)', 'background': 'rgba(67,160,71,1)' });
            });
            btn.addEventListener("mouseleave", () => {
                this._s(btn, { 'transform': 'scale(1)', 'background': 'rgba(76,175,80,0.85)' });
                this._hoverHideTimer = setTimeout(() => this._hideDownloadBtn(), 200);
            });
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (this._hoveredImg && this._onSaveSingle) {
                    this._onSaveSingle(this._hoveredImg);
                }
            });

            this._shadow.appendChild(btn);
            this._imgDownloadBtn = btn;

            // 事件委托：监听页面图片的鼠标悬停
            document.addEventListener("mouseover", (e) => {
                const img = e.target;
                if (!img || img.tagName !== 'IMG') return;
                if (img.closest?.('ws-root')) return;
                const rect = img.getBoundingClientRect();
                if (rect.width < 80 || rect.height < 80) return;
                clearTimeout(this._hoverHideTimer);
                this._hoveredImg = img;
                this._showDownloadBtn(rect);
            }, true);

            document.addEventListener("mouseout", (e) => {
                if (e.target && e.target.tagName === 'IMG') {
                    this._hoverHideTimer = setTimeout(() => this._hideDownloadBtn(), 250);
                }
            }, true);
        }

        _showDownloadBtn(rect) {
            if (!this._imgDownloadBtn) return;
            this._s(this._imgDownloadBtn, {
                'display': 'flex',
                'top': (rect.top + 4) + 'px',
                'left': (rect.left + 4) + 'px',
            });
        }

        _hideDownloadBtn() {
            if (this._imgDownloadBtn) {
                this._s(this._imgDownloadBtn, { 'display': 'none' });
            }
            this._hoveredImg = null;
        }

        /** 刷新预览面板（如果正在显示），用于 DOM 变化后更新 */
        refreshPreview() {
            if (this._previewEl) {
                this._hidePreview();
                this._showPreview();
            }
        }

        // ---- Toast ----
        toast(message, type = "info", duration = 3000) {
            log(`[toast:${type}]`, message);
            if (!this._toastContainer) {
                warn("toast 容器未初始化，跳过显示");
                return;
            }
            const borderColors = {
                success: '#4CAF50',
                error: '#f44336',
                info: '#2196F3',
            };
            const el = document.createElement("div");
            this._s(el, {
                'background': '#323232',
                'color': '#fff',
                'padding': '10px 18px',
                'border-radius': '8px',
                'font-size': '13px',
                'line-height': '1.4',
                'box-shadow': '0 4px 12px rgba(0,0,0,.3)',
                'pointer-events': 'auto',
                'max-width': '360px',
                'word-break': 'break-word',
                'border-left': `4px solid ${borderColors[type] || borderColors.info}`,
                'animation': 'ws-toast-slide-in .25s ease-out',
                'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'margin': '0',
                'box-sizing': 'border-box',
                'visibility': 'visible',
                'opacity': '1',
                'display': 'block',
            });
            el.textContent = message;
            this._toastContainer.appendChild(el);
            setTimeout(() => {
                el.style.setProperty('opacity', '0', 'important');
                el.style.setProperty('transition', 'opacity .3s', 'important');
                setTimeout(() => el.remove(), 300);
            }, duration);
        }

        // ---- 图片高亮 ----
        highlightImages(images, duration = 1200) {
            if (!this._highlightStyleInjected) {
                gmAddStyle(`
                    .ws-img-highlight {
                        outline: 3px solid #4CAF50 !important;
                        outline-offset: 2px;
                        box-shadow: 0 0 12px rgba(76,175,80,.5) !important;
                        transition: outline .3s, box-shadow .3s;
                    }
                `);
                this._highlightStyleInjected = true;
            }
            for (const img of images) {
                if (img.element) {
                    img.element.classList.add("ws-img-highlight");
                    setTimeout(() => img.element.classList.remove("ws-img-highlight"), duration);
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
            const domainExclude = (data.domainExcludes || {})[domain] || "";

            // 全屏遮罩层
            const overlay = document.createElement("div");
            this._s(overlay, {
                'position': 'fixed',
                'inset': '0',
                'background': 'rgba(0,0,0,.45)',
                'display': 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                'z-index': '2147483647',
                'pointer-events': 'auto',
                'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'margin': '0',
                'padding': '0',
                'box-sizing': 'border-box',
            });

            // 面板容器
            const panel = document.createElement("div");
            const panelId = "ws-settings-" + Date.now();
            panel.id = panelId;
            this._s(panel, {
                'background': '#fff',
                'border-radius': '12px',
                'width': '480px',
                'max-height': '90vh',
                'overflow-y': 'auto',
                'box-shadow': '0 8px 30px rgba(0,0,0,.25)',
                'padding': '24px 28px',
                'color': '#222',
                'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'box-sizing': 'border-box',
                'text-align': 'left',
                'font-size': '13px',
                'line-height': '1.5',
                'pointer-events': 'auto',
            });

            // 面板内部样式（通过 <style> 标签，以面板 ID 作用域隔离）
            const styleTag = document.createElement("style");
            styleTag.textContent = `
                #${panelId} * {
                    box-sizing: border-box !important;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                }
                #${panelId} h2 {
                    margin: 0 0 18px !important; font-size: 18px !important; font-weight: 600 !important;
                    display: flex !important; align-items: center !important; gap: 8px !important;
                    color: #222 !important; line-height: 1.4 !important; padding: 0 !important;
                    border: none !important; background: transparent !important;
                }
                #${panelId} label {
                    display: block !important; font-size: 13px !important; font-weight: 500 !important;
                    margin: 14px 0 4px !important; color: #555 !important; padding: 0 !important;
                }
                #${panelId} input[type="text"],
                #${panelId} input[type="number"],
                #${panelId} select,
                #${panelId} textarea {
                    width: 100% !important; padding: 7px 10px !important;
                    border: 1px solid #d0d0d0 !important; border-radius: 6px !important;
                    font-size: 13px !important; box-sizing: border-box !important;
                    outline: none !important; background: #fff !important; color: #222 !important;
                    margin: 0 !important; height: auto !important; line-height: 1.4 !important;
                    appearance: auto !important; -webkit-appearance: auto !important;
                }
                #${panelId} textarea {
                    font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace !important;
                    resize: vertical !important;
                }
                #${panelId} input:focus, #${panelId} select:focus, #${panelId} textarea:focus {
                    border-color: #4CAF50 !important;
                }
                #${panelId} .ws-radio-group {
                    display: flex !important; gap: 14px !important; margin: 4px 0 !important;
                    font-size: 13px !important; flex-wrap: wrap !important; padding: 0 !important;
                }
                #${panelId} .ws-radio-group label {
                    display: inline-flex !important; align-items: center !important; gap: 4px !important;
                    font-weight: 400 !important; color: #333 !important; margin: 0 !important;
                    cursor: pointer !important; font-size: 13px !important;
                }
                #${panelId} .ws-radio-group input[type="radio"] {
                    width: auto !important; height: auto !important; margin: 0 !important;
                    padding: 0 !important; border: initial !important; appearance: auto !important;
                    -webkit-appearance: auto !important;
                }
                #${panelId} .ws-hint {
                    font-size: 11px !important; color: #999 !important; margin: 2px 0 0 !important;
                    padding: 0 !important;
                }
                #${panelId} .ws-actions {
                    display: flex !important; justify-content: flex-end !important; gap: 10px !important;
                    margin-top: 22px !important; padding-top: 14px !important;
                    border-top: 1px solid #eee !important; flex-wrap: wrap !important;
                }
                #${panelId} button {
                    padding: 7px 18px !important; border: none !important; border-radius: 6px !important;
                    font-size: 13px !important; cursor: pointer !important; font-weight: 500 !important;
                    line-height: 1.4 !important; display: inline-block !important;
                    text-align: center !important; text-decoration: none !important;
                    height: auto !important; width: auto !important; margin: 0 !important;
                }
                #${panelId} .ws-btn-primary   { background: #4CAF50 !important; color: #fff !important; }
                #${panelId} .ws-btn-primary:hover { background: #43A047 !important; }
                #${panelId} .ws-btn-secondary { background: #e0e0e0 !important; color: #333 !important; }
                #${panelId} .ws-btn-secondary:hover { background: #d0d0d0 !important; }
                #${panelId} .ws-btn-danger    { background: transparent !important; color: #f44336 !important; margin-right: auto !important; }
                #${panelId} .ws-btn-danger:hover { background: #ffebee !important; }
                #${panelId} .ws-btn-warning   { background: #FF9800 !important; color: #fff !important; }
                #${panelId} .ws-btn-warning:hover { background: #F57C00 !important; }
            `;
            overlay.appendChild(styleTag);

            panel.innerHTML = `
                <h2><span>⚙</span> ${SCRIPT_NAME} 设置</h2>

                <label>保存模式</label>
                <div class="ws-radio-group">
                    <label><input type="radio" name="ws-saveMode" value="single" ${data.saveMode === "single" ? "checked" : ""}> 单张图片</label>
                    <label><input type="radio" name="ws-saveMode" value="multiple" ${data.saveMode === "multiple" ? "checked" : ""}> 所有图片</label>
                </div>

                <label>排序方式</label>
                <div class="ws-radio-group">
                    <label><input type="radio" name="ws-sortBy" value="relevance" ${data.sortBy === "relevance" ? "checked" : ""}> 智能推荐</label>
                    <label><input type="radio" name="ws-sortBy" value="size" ${data.sortBy === "size" ? "checked" : ""}> 尺寸（从大到小）</label>
                    <label><input type="radio" name="ws-sortBy" value="time" ${data.sortBy === "time" ? "checked" : ""}> 页面顺序</label>
                </div>
                <div class="ws-hint">智能推荐：综合可见性、位置、语义上下文和分辨率，自动识别页面主图</div>

                <label>图片格式</label>
                <select id="ws-imageFormat">
                    ${OUTPUT_FORMATS.map(f => `<option value="${f}" ${data.imageFormat === f ? "selected" : ""}>${f === "original" ? "原始格式" : f.toUpperCase()}</option>`).join("")}
                </select>

                <label>命名模板</label>
                <input type="text" id="ws-nameTemplate" value="${data.nameTemplate}">
                <div class="ws-hint">占位符: {title} {domain} {url} {yyyy} {mm} {dd} {hh} {MM} {ss} {index} {ext}</div>

                <label>默认保存路径</label>
                <input type="text" id="ws-defaultSavePath" value="${data.defaultSavePath}" placeholder="例如: artworks/arts">
                <div class="ws-hint">路径相对于浏览器下载目录。Tampermonkey 设置 → 高级 → 下载(Beta) → 浏览器 API 可支持子目录。</div>

                <label>当前域名 <b>${domain}</b> 的保存路径</label>
                <input type="text" id="ws-domainPath" value="${domainPath}" placeholder="留空则使用默认路径">

                <label>当前域名 <b>${domain}</b> 的 URL 排除模式</label>
                <textarea id="ws-domainExclude" rows="3" placeholder="每行一个模式，使用 * 匹配任意字符&#10;例如: users/*/content*">${domainExclude}</textarea>
                <div class="ws-hint">匹配的图片 URL 路径将被排除，不参与收集和下载。* 匹配任意字符。</div>

                <label>文件冲突处理</label>
                <div class="ws-radio-group">
                    <label><input type="radio" name="ws-conflict" value="uniquify" ${data.conflictAction === "uniquify" ? "checked" : ""}> 添加编号</label>
                    <label><input type="radio" name="ws-conflict" value="overwrite" ${data.conflictAction === "overwrite" ? "checked" : ""}> 覆盖</label>
                    <label><input type="radio" name="ws-conflict" value="skip" ${data.conflictAction === "skip" ? "checked" : ""}> 跳过</label>
                    <label><input type="radio" name="ws-conflict" value="prompt" ${data.conflictAction === "prompt" ? "checked" : ""}> 询问</label>
                </div>

                <label>重复图片处理（基于内容哈希）</label>
                <div class="ws-radio-group">
                    <label><input type="radio" name="ws-dupAction" value="skip" ${(data.duplicateAction || "skip") === "skip" ? "checked" : ""}> 跳过（不重复下载）</label>
                    <label><input type="radio" name="ws-dupAction" value="latest" ${data.duplicateAction === "latest" ? "checked" : ""}> 重新下载</label>
                </div>
                <div class="ws-hint">已记录 ${this.hashStore.size} 张图片的下载历史</div>

                <label>最小图片尺寸（像素）</label>
                <input type="number" id="ws-minImageSize" value="${data.minImageSize}" min="0" max="1000" style="width:100px !important;">

                <div class="ws-actions">
                    <button class="ws-btn-danger" id="ws-btn-reset">重置设置</button>
                    <button class="ws-btn-warning" id="ws-btn-clear-history">清除下载历史</button>
                    <button class="ws-btn-secondary" id="ws-btn-cancel">取消</button>
                    <button class="ws-btn-primary" id="ws-btn-save">保存</button>
                </div>
            `;

            overlay.appendChild(panel);
            this._shadow.appendChild(overlay);
            this._panelEl = overlay;

            // ---- 事件绑定 ----
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) this.hideSettings();
            });

            const escHandler = (e) => {
                if (e.key === "Escape") {
                    this.hideSettings();
                    document.removeEventListener("keydown", escHandler, true);
                }
            };
            document.addEventListener("keydown", escHandler, true);

            panel.querySelector("#ws-btn-cancel").addEventListener("click", () => this.hideSettings());

            panel.querySelector("#ws-btn-reset").addEventListener("click", () => {
                if (confirm("确定重置所有设置为默认值？")) {
                    this.settings.reset();
                    this.hideSettings();
                    this.toast("设置已重置为默认值", "info");
                }
            });

            panel.querySelector("#ws-btn-clear-history").addEventListener("click", () => {
                if (confirm(`确定清除下载历史？（共 ${this.hashStore.size} 条记录）\n清除后，之前下载过的图片将被重新下载。`)) {
                    this.hashStore.clear();
                    this.toast("下载历史已清除", "info");
                    const hints = panel.querySelectorAll(".ws-hint");
                    hints.forEach(h => {
                        if (h.textContent.includes("已记录")) {
                            h.textContent = "已记录 0 张图片的下载历史";
                        }
                    });
                }
            });

            panel.querySelector("#ws-btn-save").addEventListener("click", () => {
                const newData = {
                    saveMode: panel.querySelector('input[name="ws-saveMode"]:checked')?.value || "single",
                    sortBy: panel.querySelector('input[name="ws-sortBy"]:checked')?.value || "size",
                    imageFormat: panel.querySelector("#ws-imageFormat").value,
                    nameTemplate: panel.querySelector("#ws-nameTemplate").value || Settings.DEFAULTS.nameTemplate,
                    defaultSavePath: panel.querySelector("#ws-defaultSavePath").value.trim(),
                    conflictAction: panel.querySelector('input[name="ws-conflict"]:checked')?.value || "uniquify",
                    duplicateAction: panel.querySelector('input[name="ws-dupAction"]:checked')?.value || "skip",
                    minImageSize: parseInt(panel.querySelector("#ws-minImageSize").value, 10) || MIN_IMAGE_SIZE_DEFAULT,
                    firstRun: false,
                };

                const domainPaths = { ...(this.settings.get("domainPaths") || {}) };
                const dp = panel.querySelector("#ws-domainPath").value.trim();
                if (dp) { domainPaths[domain] = dp; }
                else { delete domainPaths[domain]; }
                newData.domainPaths = domainPaths;

                const domainExcludes = { ...(this.settings.get("domainExcludes") || {}) };
                const de = panel.querySelector("#ws-domainExclude").value.trim();
                if (de) { domainExcludes[domain] = de; }
                else { delete domainExcludes[domain]; }
                newData.domainExcludes = domainExcludes;

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

            try { this.settings = new Settings(); } catch (e) {
                error("设置初始化失败:", e);
                this.settings = {
                    _data: {}, get: (k) => Settings.DEFAULTS[k],
                    set: () => { }, getAll: () => ({ ...Settings.DEFAULTS }),
                    setAll: () => { }, getSavePath: () => "", reset: () => { },
                };
            }

            this.hashStore = new HashStore();
            this.fileNamer = new FileNamer(this.settings);
            this.collector = new ImageCollector(this.settings);
            this.saver = new ImageSaver(this.settings, this.fileNamer, this.hashStore);
            this.ui = new UIManager(this.settings, this.hashStore);

            try { this.ui.init(); } catch (e) { error("UI 初始化失败:", e); }

            this.ui.setSaveHandler(() => this.saveImages());
            this.ui.setCollectHandler(() => {
                const all = this.collector.collect();
                return this.collector.select(all);
            });
            this.ui.setSaveSingleHandler((imgEl) => this.saveSingleImage(imgEl));

            this._bindHotkeys();
            this._registerMenu();
            this._checkFirstRun();

            // 启动 DOM 监视器，自动检测灯箱/模态框/覆盖层等页面动态变化
            this._domWatcher = new DOMWatcher(() => this._onDomChange());
            this._domWatcher.start();

            log("初始化完成。按 Ctrl+Alt+I 保存图片，或点击右下角 📷 按钮。");
        }

        /** DOM 发生显著变化时调用 —— 刷新预览面板，使评分保持最新 */
        _onDomChange() {
            log("检测到页面动态变化（可能出现灯箱/模态框）");
            this.ui.refreshPreview();
        }

        /** 保存单张指定图片（由页面上的悬停下载按钮触发） */
        async saveSingleImage(imgEl) {
            if (!imgEl) return;
            const url = imgEl.currentSrc || imgEl.src;
            if (!url) {
                this.ui.toast("未找到图片 URL", "error");
                return;
            }
            const imageInfo = {
                url,
                width: imgEl.naturalWidth || imgEl.width,
                height: imgEl.naturalHeight || imgEl.height,
                area: (imgEl.naturalWidth || imgEl.width) * (imgEl.naturalHeight || imgEl.height),
                element: imgEl,
                type: 'img',
            };
            imageInfo.originalUrl = this.collector.resolver.resolve(imageInfo);

            log("单张下载:", (imageInfo.originalUrl || url).substring(0, 80));
            this.ui.highlightImages([imageInfo]);
            this.ui.toast(`正在下载图片...`, "info", 2000);

            const results = await this.saver.save([imageInfo]);
            const r = results[0];
            if (r.status === "success") {
                this.ui.toast(`✓ 已保存: ${r.filename}`, "success", 3000);
            } else if (r.status === "skipped-dup") {
                this.ui.toast(`⊘ 重复图片已跳过`, "info", 3000);
            } else if (r.status === "error") {
                this.ui.toast(`✗ 下载失败: ${r.error}`, "error", 4000);
            }
        }

        /** 绑定快捷键 —— 简洁且健壮 */
        _bindHotkeys() {
            const self = this;
            let lastFired = 0; // 时间戳去重，防止 document/window 双触发

            function handler(e) {
                // 跳过输入法编辑状态
                if (e.isComposing) return;
                // 必须同时按下 Ctrl + Alt，不能有 Shift 或 Meta
                if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return;

                // 调试日志：帮助诊断快捷键问题
                log("检测到 Ctrl+Alt 按键:", JSON.stringify({
                    code: e.code, key: e.key, keyCode: e.keyCode,
                    type: e.type, target: e.target?.tagName
                }));

                // 时间戳去重（100ms 内只触发一次）
                const now = Date.now();
                if (now - lastFired < 100) return;

                // 匹配 I 键：code → key → keyCode（三重兜底）
                const isI = e.code === "KeyI" || e.key === "i" || e.key === "I" || e.keyCode === 73;
                const isO = e.code === "KeyO" || e.key === "o" || e.key === "O" || e.keyCode === 79;

                if (isI) {
                    lastFired = now;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    log("快捷键 Ctrl+Alt+I 触发 → 保存图片");
                    self.saveImages();
                } else if (isO) {
                    lastFired = now;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    log("快捷键 Ctrl+Alt+O 触发 → 设置");
                    self.ui.showSettings();
                }
            }

            // 在多个目标上注册捕获阶段监听，最大化兼容性
            document.addEventListener("keydown", handler, true);

            try {
                // window 在有些环境中是沙箱对象，尝试注册
                if (window !== document) {
                    window.addEventListener("keydown", handler, true);
                }
            } catch (_) { }

            try {
                // 在 Tampermonkey 沙箱环境中，unsafeWindow 可能指向真实页面 window
                if (typeof unsafeWindow !== "undefined" && unsafeWindow !== window) {
                    unsafeWindow.addEventListener("keydown", handler, true);
                    log("已在 unsafeWindow 上注册快捷键监听");
                }
            } catch (_) { }

            log("快捷键已绑定 (Ctrl+Alt+I = 保存, Ctrl+Alt+O = 设置)");
        }

        _registerMenu() {
            gmRegisterMenuCommand("📷 保存图片", () => this.saveImages());
            gmRegisterMenuCommand("⚙ 设置", () => this.ui.showSettings());
            log("菜单命令已注册");
        }

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

            const mode = this.settings.get("saveMode");
            this.ui.toast(
                mode === "single"
                    ? `正在检查图片 (${selected[0].width}×${selected[0].height})...`
                    : `正在检查 ${selected.length} 张图片...`,
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
                    `⊘ 已跳过 ${skippedDup.length} 张重复图片（内容相同）`,
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
    // 初始化
    // =====================================================================
    try {
        new WebSaver();
    } catch (e) {
        error("初始化严重错误:", e);
        try {
            const div = document.createElement("div");
            div.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;"
                + "background:#f44336;color:#fff;padding:12px 18px;border-radius:8px;"
                + "font:13px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);pointer-events:auto;";
            div.textContent = `${SCRIPT_NAME}: 初始化错误 — 请按 F12 查看控制台`;
            document.body.appendChild(div);
            setTimeout(() => div.remove(), 8000);
        } catch (_) { }
    }
})();
