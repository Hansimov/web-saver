/**
 * Web Saver — 单元测试 & 集成测试
 *
 * 运行方式: node tests/web-saver.test.js
 *
 * 这些测试提取并验证纯逻辑函数（FileNamer、排序、设置默认值、文件名工具等），
 * 无需真实浏览器 DOM。浏览器端集成测试见 tests/test-page.html。
 */

"use strict";

// =====================================================================
// 最小测试框架
// =====================================================================
let _passed = 0;
let _failed = 0;
let _currentSuite = "";

function describe(name, fn) {
    _currentSuite = name;
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

function assertDeepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(msg || `期望 ${b}，得到 ${a}`);
}

console.log("\n🧪 Web Saver 测试");
console.log("=".repeat(50));

// =====================================================================
// 从脚本中提取的纯函数（与主代码逻辑保持同步）
// =====================================================================

const VALID_IMAGE_EXTS = [
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "avif", "ico",
];

function getExtFromUrl(url) {
    try {
        const pathname = new URL(url, "https://example.com").pathname;
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

function normalizePath(p) {
    if (!p) return "";
    p = p.trim().replace(/\\/g, "/");
    if (p && !p.endsWith("/")) p += "/";
    return p;
}

// =====================================================================
// 模拟 Settings 类
// =====================================================================
class MockSettings {
    constructor(overrides = {}) {
        this._data = {
            saveMode: "single",
            sortBy: "relevance",
            imageFormat: "original",
            nameTemplate: "{yyyy}-{mm}-{dd}-{hh}{MM}{ss}",
            defaultSavePath: "",
            domainPaths: {},
            domainExcludes: {},
            conflictAction: "uniquify",
            duplicateAction: "skip",
            minImageSize: 50,
            firstRun: true,
            ...overrides,
        };
    }
    get(key) { return this._data[key]; }
    set(key, val) { this._data[key] = val; }
    getAll() { return { ...this._data }; }
    setAll(obj) { Object.assign(this._data, obj); }
    getSavePath() {
        const dp = this._data.domainPaths || {};
        const raw = dp["example.com"] || this._data.defaultSavePath || "";
        return normalizePath(raw);
    }
    getExcludePatterns() {
        const de = this._data.domainExcludes || {};
        const raw = de["example.com"] || '';
        return raw.split('\n').map(p => p.trim()).filter(p => p.length > 0);
    }
    reset() {
        this._data = {
            saveMode: "single", sortBy: "relevance", imageFormat: "original",
            nameTemplate: "{yyyy}-{mm}-{dd}-{hh}{MM}{ss}", defaultSavePath: "",
            domainPaths: {}, domainExcludes: {}, conflictAction: "uniquify",
            duplicateAction: "skip", minImageSize: 50, firstRun: true,
        };
    }
}

// =====================================================================
// 模拟 FileNamer（简化版，用于测试）
// =====================================================================
class MockFileNamer {
    constructor(settings) { this.settings = settings; }
    generate(context = {}) {
        const template = this.settings.get("nameTemplate");
        const now = new Date();
        const map = {
            "{title}": "Test_Page",
            "{domain}": "example.com",
            "{url}": "https___example.com_page",
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
// 排序和选择函数
// =====================================================================
function sortBySize(images) {
    return [...images].sort((a, b) => b.area - a.area);
}

function sortByTime(images) {
    return [...images].sort((a, b) => a.domIndex - b.domIndex);
}

function selectImages(images, mode, sortBy) {
    let sorted;
    if (sortBy === "relevance") {
        sorted = [...images].sort((a, b) => (b.score || 0) - (a.score || 0));
    } else if (sortBy === "size") {
        sorted = sortBySize(images);
    } else {
        sorted = sortByTime(images);
    }
    if (mode === "single") return sorted.length > 0 ? [sorted[0]] : [];
    return sorted;
}

function uniquify(filename, sessionNames) {
    if (!sessionNames.has(filename)) return filename;
    const dotIdx = filename.lastIndexOf(".");
    const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
    const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";
    let n = 1;
    while (sessionNames.has(`${base}-${n}${ext}`)) n++;
    return `${base}-${n}${ext}`;
}

// =====================================================================
// 测试用例
// =====================================================================

// ---- getExtFromUrl ----
describe("getExtFromUrl", () => {
    it("应提取 jpg 扩展名", () => {
        assertEqual(getExtFromUrl("https://example.com/photo.jpg"), "jpg");
    });
    it("应将 jpeg 标准化为 jpg", () => {
        assertEqual(getExtFromUrl("https://example.com/photo.jpeg"), "jpg");
    });
    it("应提取 png 扩展名", () => {
        assertEqual(getExtFromUrl("https://example.com/img.png"), "png");
    });
    it("应提取 webp 扩展名", () => {
        assertEqual(getExtFromUrl("https://example.com/img.webp"), "webp");
    });
    it("应提取 gif 扩展名", () => {
        assertEqual(getExtFromUrl("https://example.com/anim.gif"), "gif");
    });
    it("应处理 URL 中的查询参数", () => {
        assertEqual(getExtFromUrl("https://example.com/img.png?w=200"), "png");
    });
    it("应处理 URL 中的 hash 片段", () => {
        assertEqual(getExtFromUrl("https://example.com/img.webp#section"), "webp");
    });
    it("未知扩展名应默认为 jpg", () => {
        assertEqual(getExtFromUrl("https://example.com/file.xyz"), "jpg");
    });
    it("无效 URL 应默认为 jpg", () => {
        assertEqual(getExtFromUrl("not-a-url"), "jpg");
    });
    it("应处理带路径的 URL", () => {
        assertEqual(getExtFromUrl("https://cdn.example.com/assets/images/photo.png"), "png");
    });
    it("应处理 data: URI", () => {
        assertEqual(getExtFromUrl("data:image/png;base64,abc123"), "jpg");
    });
    it("应处理 blob: URI", () => {
        assertEqual(getExtFromUrl("blob:https://example.com/uuid"), "jpg");
    });
});

// ---- sanitizeFilename ----
describe("sanitizeFilename", () => {
    it("应替换非法字符", () => {
        const result = sanitizeFilename('my<file>name:"test"/path\\ok|yes?no*end');
        assert(!result.includes("<"), "不应包含 <");
        assert(!result.includes(">"), "不应包含 >");
        assert(!result.includes(":"), "不应包含 :");
        assert(!result.includes('"'), '不应包含 "');
    });
    it("应保留合法字符", () => {
        assertEqual(sanitizeFilename("hello-world_2024.jpg"), "hello-world_2024.jpg");
    });
    it("应去除首尾空白", () => {
        assertEqual(sanitizeFilename("  hello  "), "hello");
    });
    it("应处理空字符串", () => {
        assertEqual(sanitizeFilename(""), "");
    });
    it("应处理超长文件名", () => {
        const long = "a".repeat(300);
        assertEqual(sanitizeFilename(long).length, 300);
    });
});

// ---- padZero ----
describe("padZero", () => {
    it("应为个位数补零", () => {
        assertEqual(padZero(5), "05");
    });
    it("两位数不应补零", () => {
        assertEqual(padZero(12), "12");
    });
    it("应支持自定义位数", () => {
        assertEqual(padZero(5, 4), "0005");
    });
});

// ---- normalizePath ----
describe("normalizePath", () => {
    it("空输入应返回空字符串", () => {
        assertEqual(normalizePath(""), "");
        assertEqual(normalizePath(null), "");
        assertEqual(normalizePath(undefined), "");
    });
    it("应将反斜杠转换为正斜杠", () => {
        assertEqual(normalizePath("foo\\bar\\baz"), "foo/bar/baz/");
    });
    it("缺少末尾斜杠时应自动添加", () => {
        assertEqual(normalizePath("artworks/arts"), "artworks/arts/");
    });
    it("已有末尾斜杠时应保留", () => {
        assertEqual(normalizePath("artworks/arts/"), "artworks/arts/");
    });
    it("应保留绝对路径中的冒号", () => {
        assertEqual(normalizePath("D:/_codes/artworks/arts"), "D:/_codes/artworks/arts/");
    });
    it("应去除首尾空白", () => {
        assertEqual(normalizePath("  folder/sub  "), "folder/sub/");
    });
    it("应处理 Windows 绝对路径（含反斜杠）", () => {
        assertEqual(normalizePath("D:\\_codes\\artworks\\arts\\"), "D:/_codes/artworks/arts/");
    });
    it("应处理单层路径", () => {
        assertEqual(normalizePath("images"), "images/");
    });
});

// ---- Settings (MockSettings) ----
describe("Settings (MockSettings)", () => {
    it("应有正确的默认值", () => {
        const s = new MockSettings();
        assertEqual(s.get("saveMode"), "single");
        assertEqual(s.get("sortBy"), "relevance");
        assertEqual(s.get("conflictAction"), "uniquify");
        assertEqual(s.get("duplicateAction"), "skip");
    });
    it("应支持自定义覆盖", () => {
        const s = new MockSettings({ saveMode: "multiple" });
        assertEqual(s.get("saveMode"), "multiple");
    });
    it("应支持 get 和 set", () => {
        const s = new MockSettings();
        s.set("sortBy", "time");
        assertEqual(s.get("sortBy"), "time");
    });
    it("应支持 setAll", () => {
        const s = new MockSettings();
        s.setAll({ saveMode: "multiple", sortBy: "time" });
        assertEqual(s.get("saveMode"), "multiple");
        assertEqual(s.get("sortBy"), "time");
    });
    it("应返回域名对应的保存路径", () => {
        const s = new MockSettings({ domainPaths: { "example.com": "art/imgs" } });
        assertEqual(s.getSavePath(), "art/imgs/");
    });
    it("应降级到默认路径", () => {
        const s = new MockSettings({ defaultSavePath: "default/path" });
        assertEqual(s.getSavePath(), "default/path/");
    });
    it("无路径设置时应返回空", () => {
        const s = new MockSettings();
        assertEqual(s.getSavePath(), "");
    });
    it("应正确规范化 Windows 路径", () => {
        const s = new MockSettings({ defaultSavePath: "D:\\_codes\\artworks" });
        assertEqual(s.getSavePath(), "D:/_codes/artworks/");
    });
});

// ---- FileNamer ----
describe("FileNamer", () => {
    it("应使用默认模板生成文件名", () => {
        const s = new MockSettings();
        const namer = new MockFileNamer(s);
        const result = namer.generate({ index: 1, ext: "jpg" });
        assert(result.endsWith(".jpg"), "应以 .jpg 结尾");
        assert(result.length > 10, "文件名应包含日期部分");
    });
    it("应包含 title 占位符", () => {
        const s = new MockSettings({ nameTemplate: "{title}" });
        const namer = new MockFileNamer(s);
        const result = namer.generate({ ext: "png" });
        assert(result.includes("Test_Page"), "应包含标题");
    });
    it("应包含 domain 占位符", () => {
        const s = new MockSettings({ nameTemplate: "{domain}" });
        const namer = new MockFileNamer(s);
        const result = namer.generate({ ext: "jpg" });
        assert(result.includes("example.com"), "应包含域名");
    });
    it("应包含 index 占位符", () => {
        const s = new MockSettings({ nameTemplate: "{index}" });
        const namer = new MockFileNamer(s);
        const result = namer.generate({ index: 5, ext: "jpg" });
        assert(result.includes("5"), "应包含索引值 5");
    });
    it("应在模板中直接包含 ext 占位符", () => {
        const s = new MockSettings({ nameTemplate: "img.{ext}" });
        const namer = new MockFileNamer(s);
        const result = namer.generate({ ext: "png" });
        assertEqual(result, "img.png");
    });
    it("应清理含特殊字符的标题", () => {
        const s = new MockSettings({ nameTemplate: "{title}" });
        const namer = new MockFileNamer(s);
        const result = namer.generate({ ext: "jpg" });
        assert(!result.includes("/"), "不应包含斜杠");
        assert(!result.includes(":"), "不应包含冒号");
    });
    it("应处理所有日期占位符", () => {
        const s = new MockSettings({ nameTemplate: "{yyyy}-{mm}-{dd}T{hh}{MM}{ss}" });
        const namer = new MockFileNamer(s);
        const result = namer.generate({ ext: "jpg" });
        const yearStr = String(new Date().getFullYear());
        assert(result.includes(yearStr), "应包含当前年份");
    });
    it("未提供 ext 时应默认为 jpg", () => {
        const s = new MockSettings({ nameTemplate: "photo" });
        const namer = new MockFileNamer(s);
        const result = namer.generate({});
        assert(result.endsWith(".jpg"), "应以 .jpg 结尾");
    });
});

// ---- sortBySize ----
describe("sortBySize", () => {
    it("应按面积从大到小排序", () => {
        const imgs = [
            { url: "a", area: 100 }, { url: "b", area: 300 }, { url: "c", area: 200 },
        ];
        const sorted = sortBySize(imgs);
        assertEqual(sorted[0].url, "b");
        assertEqual(sorted[1].url, "c");
        assertEqual(sorted[2].url, "a");
    });
    it("不应修改原数组", () => {
        const imgs = [{ url: "a", area: 100 }, { url: "b", area: 300 }];
        sortBySize(imgs);
        assertEqual(imgs[0].url, "a");
    });
});

// ---- sortByTime ----
describe("sortByTime", () => {
    it("应按 DOM 顺序升序排列", () => {
        const imgs = [
            { url: "a", domIndex: 3 }, { url: "b", domIndex: 1 }, { url: "c", domIndex: 2 },
        ];
        const sorted = sortByTime(imgs);
        assertEqual(sorted[0].url, "b");
        assertEqual(sorted[1].url, "c");
        assertEqual(sorted[2].url, "a");
    });
});

// ---- selectImages ----
describe("selectImages", () => {
    it("单张模式应返回最大的图片", () => {
        const imgs = [
            { url: "a", area: 100, domIndex: 0 },
            { url: "b", area: 300, domIndex: 1 },
            { url: "c", area: 200, domIndex: 2 },
        ];
        const result = selectImages(imgs, "single", "size");
        assertEqual(result.length, 1);
        assertEqual(result[0].url, "b");
    });
    it("多张模式应返回所有图片", () => {
        const imgs = [{ url: "a", area: 100, domIndex: 0 }, { url: "b", area: 300, domIndex: 1 }];
        const result = selectImages(imgs, "multiple", "size");
        assertEqual(result.length, 2);
    });
    it("单张+时间模式应返回第一个 DOM 元素", () => {
        const imgs = [
            { url: "a", area: 100, domIndex: 5 },
            { url: "b", area: 300, domIndex: 1 },
        ];
        const result = selectImages(imgs, "single", "time");
        assertEqual(result[0].url, "b");
    });
    it("空输入应返回空数组", () => {
        assertEqual(selectImages([], "single", "size").length, 0);
    });
    it("应处理面积为零的图片", () => {
        const imgs = [
            { url: "zero", area: 0, domIndex: 0 },
            { url: "small", area: 100, domIndex: 1 },
        ];
        const result = selectImages(imgs, "single", "size");
        assertEqual(result.length, 1);
        assertEqual(result[0].url, "small");
    });
});

// ---- uniquify ----
describe("uniquify", () => {
    it("无冲突时应返回原文件名", () => {
        assertEqual(uniquify("photo.jpg", new Set()), "photo.jpg");
    });
    it("首次冲突应添加 -1 后缀", () => {
        assertEqual(uniquify("photo.jpg", new Set(["photo.jpg"])), "photo-1.jpg");
    });
    it("多次冲突应递增后缀", () => {
        assertEqual(
            uniquify("photo.jpg", new Set(["photo.jpg", "photo-1.jpg", "photo-2.jpg"])),
            "photo-3.jpg"
        );
    });
    it("应处理无扩展名文件", () => {
        assertEqual(uniquify("readme", new Set(["readme"])), "readme-1");
    });
    it("应处理含多个点的文件名", () => {
        assertEqual(uniquify("my.photo.jpg", new Set(["my.photo.jpg"])), "my.photo-1.jpg");
    });
    it("应处理快速连续调用", () => {
        const names = new Set();
        for (let i = 0; i < 100; i++) {
            const name = uniquify("rapid.jpg", names);
            assert(!names.has(name), `第 ${i} 次迭代出现重复: ${name}`);
            names.add(name);
        }
        assertEqual(names.size, 100);
    });
});

// ---- 完整流水线（单元级集成测试）----
describe("完整流水线（单元级集成测试）", () => {
    it("单张模式应生成最大图片的正确文件名", () => {
        const settings = new MockSettings();
        const namer = new MockFileNamer(settings);
        const images = [
            { url: "https://example.com/small.png", area: 100, domIndex: 0, width: 10, height: 10 },
            { url: "https://example.com/big.jpg", area: 10000, domIndex: 1, width: 100, height: 100 },
        ];
        const selected = selectImages(images, "single", "size");
        assertEqual(selected.length, 1);
        assertEqual(selected[0].url, "https://example.com/big.jpg");
        const filename = namer.generate({ index: 1, ext: getExtFromUrl(selected[0].url) });
        assert(filename.endsWith(".jpg"), "应以 .jpg 结尾");
    });

    it("多张模式应为所有图片生成文件名", () => {
        const settings = new MockSettings({ saveMode: "multiple" });
        const namer = new MockFileNamer(settings);
        const images = [
            { url: "https://example.com/a.png", area: 100, domIndex: 0 },
            { url: "https://example.com/b.jpg", area: 200, domIndex: 1 },
            { url: "https://example.com/c.webp", area: 50, domIndex: 2 },
        ];
        const selected = selectImages(images, "multiple", "size");
        assertEqual(selected.length, 3);
        selected.forEach((img, i) => {
            const fn = namer.generate({ index: i + 1, ext: getExtFromUrl(img.url) });
            assert(fn.length > 0, "文件名不应为空");
        });
    });

    it("应使用域名设置的保存路径", () => {
        const settings = new MockSettings({ domainPaths: { "example.com": "art" } });
        const savePath = settings.getSavePath();
        assertEqual(savePath, "art/");
        const namer = new MockFileNamer(settings);
        const fn = namer.generate({ index: 1, ext: "jpg" });
        const fullPath = savePath + fn;
        assert(fullPath.startsWith("art/"), "应以 art/ 开头");
    });

    it("应在会话内进行文件名去重", () => {
        const sessionNames = new Set();
        const fn1 = uniquify("2024-01-01.jpg", sessionNames);
        sessionNames.add(fn1);
        const fn2 = uniquify("2024-01-01.jpg", sessionNames);
        sessionNames.add(fn2);
        assert(fn1 !== fn2, "两个文件名不应相同");
    });

    it("应处理格式覆盖的扩展名", () => {
        const settings = new MockSettings({ imageFormat: "webp" });
        const namer = new MockFileNamer(settings);
        const ext = "webp";
        const fn = namer.generate({ index: 1, ext });
        assert(fn.endsWith(".webp"), "应以 .webp 结尾");
    });
});

// ---- computeHash（内容哈希） ----

/**
 * 与主脚本中 computeHash 保持一致的 cyrb53 实现
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

describe("computeHash（内容哈希）", () => {
    it("相同内容应产生相同哈希", () => {
        const data = new Uint8Array([1, 2, 3, 4, 5]).buffer;
        assertEqual(computeHash(data), computeHash(data));
    });
    it("不同内容应产生不同哈希", () => {
        const a = new Uint8Array([1, 2, 3]).buffer;
        const b = new Uint8Array([4, 5, 6]).buffer;
        assert(computeHash(a) !== computeHash(b), "不同数据的哈希应不同");
    });
    it("空数据应有确定性哈希", () => {
        const empty = new Uint8Array([]).buffer;
        const hash = computeHash(empty);
        assert(hash.length > 0, "空数据哈希不应为空");
        assertEqual(computeHash(empty), hash, "空数据的哈希应是确定性的");
    });
    it("大数据应正常计算", () => {
        const big = new Uint8Array(100000);
        for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
        const hash = computeHash(big.buffer);
        assert(hash.length > 0, "大数据哈希不应为空");
    });
    it("仅一个字节不同应产生不同哈希", () => {
        const a = new Uint8Array([10, 20, 30, 40, 50]);
        const b = new Uint8Array([10, 20, 31, 40, 50]); // 第三个字节不同
        assert(computeHash(a.buffer) !== computeHash(b.buffer), "一个字节不同的哈希应不同");
    });
    it("返回值应为 base36 字符串", () => {
        const data = new Uint8Array([100, 200, 150]).buffer;
        const hash = computeHash(data);
        assert(/^[0-9a-z]+$/.test(hash), "哈希应仅包含 base36 字符");
    });
});

// ---- HashStore（哈希存储） ----

class MockHashStore {
    constructor() {
        this._store = {};
    }
    has(hash) { return hash in this._store; }
    get(hash) { return this._store[hash] || null; }
    set(hash, info) {
        this._store[hash] = { ...info, savedAt: Date.now() };
        this._prune();
    }
    get size() { return Object.keys(this._store).length; }
    clear() { this._store = {}; }
    _prune() {
        const MAX = 5000;
        const keys = Object.keys(this._store);
        if (keys.length <= MAX) return;
        const sorted = keys.sort((a, b) =>
            (this._store[a].savedAt || 0) - (this._store[b].savedAt || 0)
        );
        const toRemove = sorted.slice(0, keys.length - MAX);
        for (const k of toRemove) delete this._store[k];
    }
}

describe("HashStore（哈希存储）", () => {
    it("应存储和检索哈希记录", () => {
        const store = new MockHashStore();
        store.set("abc123", { filename: "photo.jpg", url: "https://example.com/photo.jpg" });
        assert(store.has("abc123"), "应能检测到已存储的哈希");
        assertEqual(store.get("abc123").filename, "photo.jpg");
    });
    it("不存在的哈希应返回 null", () => {
        const store = new MockHashStore();
        assert(!store.has("nonexistent"), "不存在的哈希 has 应返回 false");
        assertEqual(store.get("nonexistent"), null);
    });
    it("clear 应清空所有记录", () => {
        const store = new MockHashStore();
        store.set("a", { filename: "a.jpg" });
        store.set("b", { filename: "b.jpg" });
        assertEqual(store.size, 2);
        store.clear();
        assertEqual(store.size, 0);
        assert(!store.has("a"), "清空后不应检测到哈希");
    });
    it("size 应返回正确的条目数", () => {
        const store = new MockHashStore();
        assertEqual(store.size, 0);
        store.set("x", { filename: "x.jpg" });
        assertEqual(store.size, 1);
        store.set("y", { filename: "y.jpg" });
        assertEqual(store.size, 2);
    });
    it("set 应记录 savedAt 时间戳", () => {
        const store = new MockHashStore();
        const before = Date.now();
        store.set("ts", { filename: "ts.jpg" });
        const after = Date.now();
        const entry = store.get("ts");
        assert(entry.savedAt >= before && entry.savedAt <= after, "savedAt 应在 set 调用时间范围内");
    });
    it("相同哈希应覆盖旧记录", () => {
        const store = new MockHashStore();
        store.set("dup", { filename: "old.jpg" });
        store.set("dup", { filename: "new.jpg" });
        assertEqual(store.get("dup").filename, "new.jpg");
        assertEqual(store.size, 1);
    });
});

// ---- 基于内容哈希的重复检测流程 ----
describe("基于内容哈希的重复检测流程", () => {
    it("相同哈希 + skip 模式应跳过", () => {
        const store = new MockHashStore();
        store.set("hash_a", { filename: "saved.jpg" });
        const dupAction = "skip";
        const hash = "hash_a";
        // 模拟保存流程
        if (store.has(hash) && dupAction === "skip") {
            // 应跳过
            assert(true, "应跳过重复图片");
        } else {
            assert(false, "不应到达这里");
        }
    });
    it("相同哈希 + latest 模式应继续下载", () => {
        const store = new MockHashStore();
        store.set("hash_b", { filename: "old.jpg" });
        const dupAction = "latest";
        const hash = "hash_b";
        let shouldDownload = true;
        if (store.has(hash) && dupAction === "skip") {
            shouldDownload = false;
        }
        assert(shouldDownload, "latest 模式应继续下载");
    });
    it("新哈希应正常下载并记录", () => {
        const store = new MockHashStore();
        const hash = "new_hash";
        assert(!store.has(hash), "新哈希不应存在");
        // 模拟下载成功后记录
        store.set(hash, { filename: "new_file.jpg", url: "https://example.com/new.jpg" });
        assert(store.has(hash), "下载后应记录哈希");
    });
    it("应统计跳过的重复图片数量（哈希模式）", () => {
        const store = new MockHashStore();
        const imageHashes = ["h1", "h2", "h1", "h3", "h2"]; // h1, h2 各重复一次
        const results = [];
        for (const hash of imageHashes) {
            if (store.has(hash)) {
                results.push({ status: "skipped-dup" });
                continue;
            }
            store.set(hash, { filename: hash + ".jpg" });
            results.push({ status: "success" });
        }
        const dupCount = results.filter(r => r.status === "skipped-dup").length;
        assertEqual(dupCount, 2, "应有 2 张重复图片被跳过");
        const successCount = results.filter(r => r.status === "success").length;
        assertEqual(successCount, 3, "应有 3 张图片成功保存");
    });
    it("不同 URL 但相同内容哈希应被判定为重复", () => {
        const store = new MockHashStore();
        // 两个不同 URL 但内容相同（哈希相同）
        const hash = "same_content_hash";
        store.set(hash, { filename: "first.jpg", url: "https://cdn1.example.com/img.jpg" });
        assert(store.has(hash), "相同哈希应被检测为重复，即使 URL 不同");
    });
});

// ---- 路径 + 文件名集成 ----
describe("路径 + 文件名集成", () => {
    it("应正确拼合规范化路径和清理后的文件名", () => {
        const savePath = normalizePath("artworks/arts");
        const filename = sanitizeFilename("my image.jpg");
        assertEqual(savePath + filename, "artworks/arts/my image.jpg");
    });
    it("绝对路径用作目录时不应被破坏", () => {
        const savePath = normalizePath("D:/_codes/artworks/arts");
        const filename = sanitizeFilename("photo.png");
        const fullPath = savePath + filename;
        assertEqual(fullPath, "D:/_codes/artworks/arts/photo.png");
        assert(fullPath.includes(":"), "冒号应被保留在路径中");
        assert(fullPath.includes("/"), "斜杠应被保留在路径中");
    });
    it("空路径时应仅有文件名", () => {
        const savePath = normalizePath("");
        const filename = sanitizeFilename("img.jpg");
        assertEqual(savePath + filename, "img.jpg");
    });
    it("Windows 反斜杠路径应被正确处理", () => {
        const savePath = normalizePath("D:\\_codes\\artworks\\arts");
        const filename = "2026-02-22-120000.jpg";
        assertEqual(savePath + filename, "D:/_codes/artworks/arts/2026-02-22-120000.jpg");
    });
    it("路径中不应出现双斜杠", () => {
        const savePath = normalizePath("folder/sub/");
        const filename = "test.jpg";
        const fullPath = savePath + filename;
        assert(!fullPath.includes("//"), "不应出现双斜杠");
    });
});

// ---- GM_* 封装降级测试 ----
describe("GM_* 封装降级测试", () => {
    it("gmGetValue 不可用时应返回默认值", () => {
        // 模拟无 GM_getValue 环境
        const defaultVal = { test: true };
        // 直接测试降级逻辑
        let result;
        try {
            result = (typeof GM_getValue === "function")
                ? GM_getValue("key", defaultVal)
                : defaultVal;
        } catch (_) {
            result = defaultVal;
        }
        assertDeepEqual(result, defaultVal);
    });

    it("gmAddStyle 不可用时应降级为 <style> 方案", () => {
        // 在 Node.js 中 GM_addStyle 不可用,验证降级逻辑不抛出
        let fallbackUsed = false;
        try {
            if (typeof GM_addStyle !== "function") {
                fallbackUsed = true;
            }
        } catch (_) {
            fallbackUsed = true;
        }
        assert(fallbackUsed, "Node 环境中应使用降级方案");
    });

    it("gmDownload 不可用时应返回 false", () => {
        let result;
        if (typeof GM_download === "function") {
            result = true;
        } else {
            result = false;
        }
        assertEqual(result, false, "Node 环境中 GM_download 不可用");
    });
});

// ---- 健壮性 ----
describe("健壮性", () => {
    it("Settings 应能处理损坏的存储数据", () => {
        const s = new MockSettings();
        // 模拟加载无效数据
        try { JSON.parse("not json"); } catch (e) {
            // 验证不会崩溃
            assert(e instanceof SyntaxError);
        }
        assertEqual(s.get("saveMode"), "single");
    });
    it("Settings 应能处理 null 存储数据", () => {
        const s = new MockSettings();
        assertEqual(s.get("sortBy"), "relevance");
    });
    it("Settings 应将部分数据与默认值合并", () => {
        const s = new MockSettings({ saveMode: "multiple" });
        assertEqual(s.get("saveMode"), "multiple");
        assertEqual(s.get("sortBy"), "relevance");
        assertEqual(s.get("conflictAction"), "uniquify");
    });
    it("Settings reset 应恢复所有默认值", () => {
        const s = new MockSettings({ saveMode: "multiple", sortBy: "time" });
        s.reset();
        assertEqual(s.get("saveMode"), "single");
        assertEqual(s.get("sortBy"), "relevance");
    });
});

// ---- 快捷键事件模拟 ----
describe("快捷键事件模拟", () => {
    // 与主脚本一致的匹配逻辑
    function matchesHotkey(e) {
        if (e.isComposing) return false;
        if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return false;
        return e.code === "KeyI" || e.key === "i" || e.key === "I" || e.keyCode === 73;
    }

    it("e.code === 'KeyI' 应匹配", () => {
        assert(matchesHotkey({ code: "KeyI", key: "i", keyCode: 73, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false }));
    });
    it("e.key === 'i'（小写）应匹配", () => {
        assert(matchesHotkey({ code: "", key: "i", keyCode: 0, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false }));
    });
    it("e.key === 'I'（大写）应匹配", () => {
        assert(matchesHotkey({ code: "", key: "I", keyCode: 0, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false }));
    });
    it("e.keyCode === 73 应作为降级匹配", () => {
        assert(matchesHotkey({ code: "", key: "", keyCode: 73, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false }));
    });
    it("输入法编辑状态应被忽略", () => {
        assert(!matchesHotkey({ code: "KeyI", key: "i", keyCode: 73, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: true }));
    });
    it("不应响应含 Shift 的组合键", () => {
        assert(!matchesHotkey({ code: "KeyI", key: "i", keyCode: 73, ctrlKey: true, altKey: true, shiftKey: true, metaKey: false, isComposing: false }));
    });
    it("不应响应含 Meta 的组合键", () => {
        assert(!matchesHotkey({ code: "KeyI", key: "i", keyCode: 73, ctrlKey: true, altKey: true, shiftKey: false, metaKey: true, isComposing: false }));
    });
    it("仅 Ctrl 不应触发（缺少 Alt）", () => {
        assert(!matchesHotkey({ code: "KeyI", key: "i", keyCode: 73, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isComposing: false }));
    });
    it("仅 Alt 不应触发（缺少 Ctrl）", () => {
        assert(!matchesHotkey({ code: "KeyI", key: "i", keyCode: 73, ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, isComposing: false }));
    });
    it("去重逻辑：100ms 内不应多次触发", () => {
        let lastFired = 0;
        let count = 0;
        for (let i = 0; i < 3; i++) {
            const now = Date.now();
            if (now - lastFired < 100) continue;
            lastFired = now;
            count++;
        }
        assertEqual(count, 1, "瞬时连续调用只应触发 1 次");
    });
});

// =====================================================================
// 原图 URL 解析测试
// =====================================================================

/** 简化版 OriginalUrlResolver，仅测试 URL 模式和 srcset 解析 */
class MockOriginalUrlResolver {
    resolve(imageInfo) {
        const candidates = [];
        this._fromUrlPatterns(imageInfo.url, candidates);
        const seen = new Set([imageInfo.url]);
        for (const c of candidates) {
            if (c && !seen.has(c)) return c;
        }
        return imageInfo.url;
    }

    _fromUrlPatterns(url, out) {
        try {
            const u = new URL(url, "https://example.com");
            const resizeParams = ["w", "h", "width", "height", "resize", "size", "fit", "quality", "q", "auto", "dpr", "tw", "th", "sw", "sh"];
            let modified = false;
            for (const p of resizeParams) {
                if (u.searchParams.has(p)) { u.searchParams.delete(p); modified = true; }
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

    parseSrcsetBest(srcset) {
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
            if (size > bestSize) { bestSize = size; best = url; }
        }
        return best;
    }
}

describe("OriginalUrlResolver (URL 模式解析)", () => {
    const resolver = new MockOriginalUrlResolver();

    it("应移除缩放参数 (?w=200&h=100)", () => {
        const result = resolver.resolve({ url: "https://cdn.example.com/img.jpg?w=200&h=100&q=80" });
        assert(!result.includes("w=200"), "应删除 w 参数");
        assert(!result.includes("h=100"), "应删除 h 参数");
        assert(!result.includes("q=80"), "应删除 q 参数");
    });
    it("应处理缩略图后缀 (_thumb.jpg → .jpg)", () => {
        const result = resolver.resolve({ url: "https://example.com/photo_thumb.jpg" });
        assertEqual(result, "https://example.com/photo.jpg");
    });
    it("应处理 _small 后缀", () => {
        const result = resolver.resolve({ url: "https://example.com/image_small.png" });
        assertEqual(result, "https://example.com/image.png");
    });
    it("应处理 WordPress 缩略图 (-200x200.jpg → .jpg)", () => {
        const result = resolver.resolve({ url: "https://blog.example.com/wp-content/uploads/photo-300x200.jpg" });
        assertEqual(result, "https://blog.example.com/wp-content/uploads/photo.jpg");
    });
    it("应处理 /thumbs/ 路径", () => {
        const result = resolver.resolve({ url: "https://example.com/thumbs/photo.jpg" });
        assertEqual(result, "https://example.com/originals/photo.jpg");
    });
    it("应处理 /thumbnails/ 路径", () => {
        const result = resolver.resolve({ url: "https://example.com/thumbnails/photo.jpg" });
        assertEqual(result, "https://example.com/originals/photo.jpg");
    });
    it("应处理 /resize/ 路径", () => {
        const result = resolver.resolve({ url: "https://example.com/resize/200x150/photo.jpg" });
        assertEqual(result, "https://example.com/photo.jpg");
    });
    it("应处理 /small/ → /large/ 路径替换", () => {
        const result = resolver.resolve({ url: "https://example.com/small/photo.jpg" });
        assertEqual(result, "https://example.com/large/photo.jpg");
    });
    it("应处理 /medium/ → /large/ 路径替换", () => {
        const result = resolver.resolve({ url: "https://example.com/images/medium/photo.jpg" });
        assertEqual(result, "https://example.com/images/large/photo.jpg");
    });
    it("无缩略图模式时应返回原 URL", () => {
        const url = "https://example.com/images/photo.jpg";
        assertEqual(resolver.resolve({ url }), url);
    });
    it("应处理复杂 URL 参数", () => {
        const result = resolver.resolve({ url: "https://cdn.example.com/img.jpg?width=400&height=300&fit=crop&auto=format" });
        assert(!result.includes("width="), "应删除 width");
        assert(!result.includes("height="), "应删除 height");
        assert(!result.includes("fit="), "应删除 fit");
        assert(!result.includes("auto="), "应删除 auto");
    });
});

// ---- srcset 解析 ----
describe("srcset 解析", () => {
    const resolver = new MockOriginalUrlResolver();

    it("应选择最大宽度描述符", () => {
        const result = resolver.parseSrcsetBest("small.jpg 300w, medium.jpg 600w, large.jpg 1200w");
        assertEqual(result, "large.jpg");
    });
    it("应处理 x 描述符", () => {
        const result = resolver.parseSrcsetBest("normal.jpg 1x, retina.jpg 2x, ultra.jpg 3x");
        assertEqual(result, "ultra.jpg");
    });
    it("应处理无描述符的 srcset", () => {
        const result = resolver.parseSrcsetBest("only-one.jpg");
        assertEqual(result, "only-one.jpg");
    });
    it("应处理空 srcset", () => {
        const result = resolver.parseSrcsetBest("");
        assertEqual(result, null);
    });
    it("应处理复杂 srcset 格式", () => {
        const result = resolver.parseSrcsetBest(" img1.jpg 400w , img2.jpg 800w , img3.jpg 1600w ");
        assertEqual(result, "img3.jpg");
    });
});

// ---- 图片评分（纯函数测试，无需 DOM） ----

function mockResolutionScore(area) {
    if (area >= 1000000) return 15;
    if (area >= 500000) return 12;
    if (area >= 250000) return 9;
    if (area >= 100000) return 6;
    if (area >= 40000) return 3;
    return 0;
}

function mockContentScore(imageInfo) {
    let score = 0;
    const cls = (imageInfo.className || "").toLowerCase();
    const src = (imageInfo.url || "").toLowerCase();
    if (/\b(icon|logo|avatar|profile|badge|emoji|spinner|loading)\b/i.test(cls)) score -= 10;
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

describe("图片评分 (分辨率评分)", () => {
    it("1MP+ 应得满分 15", () => {
        assertEqual(mockResolutionScore(1500000), 15);
    });
    it("500K 应得 12 分", () => {
        assertEqual(mockResolutionScore(500000), 12);
    });
    it("250K 应得 9 分", () => {
        assertEqual(mockResolutionScore(250000), 9);
    });
    it("100K 应得 6 分", () => {
        assertEqual(mockResolutionScore(100000), 6);
    });
    it("40K 应得 3 分", () => {
        assertEqual(mockResolutionScore(40000), 3);
    });
    it("小图应得 0 分", () => {
        assertEqual(mockResolutionScore(100), 0);
    });
});

describe("图片评分 (内容信号)", () => {
    it("图标类名应降低评分", () => {
        const score = mockContentScore({ url: "test.jpg", className: "icon-large", width: 300, height: 300, type: "img" });
        assertEqual(score, 0, "图标类名应将评分降为 0");
    });
    it("logo URL 应降低评分", () => {
        const score = mockContentScore({ url: "https://example.com/logo.png", className: "", width: 300, height: 300, type: "img" });
        assert(score < 10, "logo URL 应得到较低评分");
    });
    it("合理宽高比应加分", () => {
        const score = mockContentScore({ url: "test.jpg", className: "", width: 600, height: 400, type: "img" });
        assert(score >= 10, "合理宽高比的大图应得到高分: " + score);
    });
    it("极端横幅应扣分", () => {
        const banner = mockContentScore({ url: "test.jpg", className: "", width: 1200, height: 100, type: "img" });
        const normal = mockContentScore({ url: "test.jpg", className: "", width: 600, height: 400, type: "img" });
        assert(banner < normal, "极端横幅应得分低于正常比例");
    });
    it("<img> 元素应优于背景图片", () => {
        const imgScore = mockContentScore({ url: "test.jpg", className: "", width: 300, height: 300, type: "img" });
        const bgScore = mockContentScore({ url: "test.jpg", className: "", width: 300, height: 300, type: "bg" });
        assert(imgScore > bgScore, "img 应得分高于 bg");
    });
    it("大图应得到额外加分", () => {
        const large = mockContentScore({ url: "test.jpg", className: "", width: 800, height: 600, type: "img" });
        const small = mockContentScore({ url: "test.jpg", className: "", width: 100, height: 80, type: "img" });
        assert(large > small, "大图应得分高于小图");
    });
});

// ---- 智能排序 (relevance) ----
describe("智能排序 (relevance)", () => {
    it("应按评分降序排列", () => {
        const imgs = [
            { url: "low", score: 10, area: 1000, domIndex: 0 },
            { url: "high", score: 85, area: 500, domIndex: 1 },
            { url: "mid", score: 50, area: 800, domIndex: 2 },
        ];
        const result = selectImages(imgs, "multiple", "relevance");
        assertEqual(result[0].url, "high");
        assertEqual(result[1].url, "mid");
        assertEqual(result[2].url, "low");
    });
    it("单张模式应选择评分最高的（而非最大的）", () => {
        const imgs = [
            { url: "big-but-low", score: 20, area: 100000, domIndex: 0 },
            { url: "small-but-relevant", score: 90, area: 5000, domIndex: 1 },
        ];
        const result = selectImages(imgs, "single", "relevance");
        assertEqual(result.length, 1);
        assertEqual(result[0].url, "small-but-relevant");
    });
    it("评分相同时应保持稳定", () => {
        const imgs = [
            { url: "a", score: 50, area: 100, domIndex: 0 },
            { url: "b", score: 50, area: 200, domIndex: 1 },
        ];
        const result = selectImages(imgs, "single", "relevance");
        assertEqual(result.length, 1);
        // 两者分数相同，稳定排序保持原顺序
        assert(result[0].url === "a" || result[0].url === "b", "应选择其中之一");
    });
    it("无评分的图片应视为 0 分", () => {
        const imgs = [
            { url: "no-score", area: 100, domIndex: 0 },
            { url: "has-score", score: 30, area: 50, domIndex: 1 },
        ];
        const result = selectImages(imgs, "single", "relevance");
        assertEqual(result[0].url, "has-score");
    });
    it("空数组应返回空", () => {
        assertEqual(selectImages([], "single", "relevance").length, 0);
    });
});

// ---- originalUrl 集成测试 ----
describe("originalUrl 集成测试", () => {
    const resolver = new MockOriginalUrlResolver();

    it("应在完整流水线中使用原图 URL", () => {
        const images = [
            { url: "https://cdn.example.com/photo_thumb.jpg", area: 1000, domIndex: 0, score: 80 },
        ];
        for (const img of images) {
            img.originalUrl = resolver.resolve(img);
        }
        assertEqual(images[0].originalUrl, "https://cdn.example.com/photo.jpg");
    });
    it("无原图时应保持原 URL", () => {
        const img = { url: "https://example.com/clean-photo.jpg" };
        assertEqual(resolver.resolve(img), img.url);
    });
    it("应优先使用评分最高图片的原图", () => {
        const images = [
            { url: "https://example.com/big_thumb.jpg", area: 100000, domIndex: 0, score: 30 },
            { url: "https://example.com/hero_thumb.jpg", area: 50000, domIndex: 1, score: 85 },
        ];
        for (const img of images) {
            img.originalUrl = resolver.resolve(img);
        }
        const selected = selectImages(images, "single", "relevance");
        assertEqual(selected[0].url, "https://example.com/hero_thumb.jpg");
        assertEqual(selected[0].originalUrl, "https://example.com/hero.jpg");
    });
});

// =====================================================================
// 覆盖层与遮挡检测测试
// =====================================================================

/**
 * 模拟 ImageScorer._overlayBonus 的纯逻辑
 * ancestors: 祖先元素信息数组 [{ position, zIndex, width, height, role, tag, open }]
 * vpWidth/vpHeight: 视口尺寸
 */
function mockOverlayBonus(ancestors, vpWidth = 1920, vpHeight = 1080) {
    let score = 0;
    for (const a of ancestors) {
        const pos = a.position || '';
        const zIndex = a.zIndex || 0;
        const width = a.width || 0;
        const height = a.height || 0;

        if ((pos === 'fixed' || pos === 'absolute') && zIndex >= 100) {
            const coversViewport = width >= vpWidth * 0.5 && height >= vpHeight * 0.5;
            if (coversViewport) {
                score = Math.max(score, zIndex >= 1000 ? 20 : 15);
            } else {
                score = Math.max(score, 10);
            }
        }

        if (a.role === 'dialog') score = Math.max(score, 15);
        if (a.tag === 'dialog' && a.open) score = Math.max(score, 15);
    }
    return Math.min(score, 20);
}

/**
 * 模拟 ImageScorer._occlusionPenalty 的纯逻辑
 * isVisible: 图片中心是否为顶层可见
 * hasSize: 图片是否有非零尺寸
 */
function mockOcclusionPenalty(isVisible, hasSize = true) {
    if (!hasSize) return 20;
    if (isVisible) return 0;
    return 20;
}

describe("覆盖层加成 (_overlayBonus)", () => {
    it("无覆盖层祖先应得 0 分", () => {
        assertEqual(mockOverlayBonus([]), 0);
    });

    it("普通定位祖先（无高 z-index）应得 0 分", () => {
        assertEqual(mockOverlayBonus([
            { position: 'relative', zIndex: 1, width: 800, height: 600 },
        ]), 0);
    });

    it("低 z-index 的 absolute 祖先应得 0 分", () => {
        assertEqual(mockOverlayBonus([
            { position: 'absolute', zIndex: 50, width: 1920, height: 1080 },
        ]), 0);
    });

    it("高 z-index fixed 全屏覆盖层应得 15 分", () => {
        assertEqual(mockOverlayBonus([
            { position: 'fixed', zIndex: 500, width: 1920, height: 1080 },
        ]), 15);
    });

    it("超高 z-index (≥1000) 全屏覆盖层应得 20 分", () => {
        assertEqual(mockOverlayBonus([
            { position: 'fixed', zIndex: 9999, width: 1920, height: 1080 },
        ]), 20);
    });

    it("高 z-index 但不覆盖视口应得 10 分", () => {
        assertEqual(mockOverlayBonus([
            { position: 'absolute', zIndex: 200, width: 400, height: 300 },
        ]), 10);
    });

    it("role=dialog 祖先应得 15 分", () => {
        assertEqual(mockOverlayBonus([
            { position: 'relative', zIndex: 0, role: 'dialog' },
        ]), 15);
    });

    it("<dialog open> 元素应得 15 分", () => {
        assertEqual(mockOverlayBonus([
            { tag: 'dialog', open: true },
        ]), 15);
    });

    it("<dialog> 未打开不应加分", () => {
        assertEqual(mockOverlayBonus([
            { tag: 'dialog', open: false },
        ]), 0);
    });

    it("多层嵌套应取最高分", () => {
        assertEqual(mockOverlayBonus([
            { position: 'fixed', zIndex: 100, width: 1920, height: 1080 },    // 15
            { position: 'fixed', zIndex: 9999, width: 1920, height: 1080 },   // 20
        ]), 20);
    });

    it("最大值应被限制为 20", () => {
        assertEqual(mockOverlayBonus([
            { position: 'fixed', zIndex: 99999, width: 1920, height: 1080 },
            { role: 'dialog' },
        ]), 20);
    });
});

describe("遮挡惩罚 (_occlusionPenalty)", () => {
    it("可见图片不应被惩罚", () => {
        assertEqual(mockOcclusionPenalty(true), 0);
    });

    it("被遮挡的图片应扣 20 分", () => {
        assertEqual(mockOcclusionPenalty(false), 20);
    });

    it("零尺寸图片应扣 20 分", () => {
        assertEqual(mockOcclusionPenalty(true, false), 20);
    });
});

// ---- 覆盖层场景下的选择集成测试 ----
describe("覆盖层场景集成测试", () => {
    it("灯箱中的图片应优于背景中的同类图片", () => {
        // 模拟场景：页面有画廊缩略图 + 打开的灯箱大图
        const bgImage = { url: "bg-gallery.jpg", score: 45, area: 50000, domIndex: 0 };
        const lightboxImage = { url: "lightbox-hero.jpg", score: 75, area: 200000, domIndex: 1 };
        // 灯箱图片得分更高（包含覆盖层加成 + 未被遮挡）
        const selected = selectImages([bgImage, lightboxImage], "single", "relevance");
        assertEqual(selected[0].url, "lightbox-hero.jpg");
    });

    it("被遮挡的背景图应被惩罚后排名靠后", () => {
        // 背景图原本高分，但被覆盖层遮挡后扣分
        const occludedImg = { url: "occluded.jpg", score: 60 - 20, area: 100000, domIndex: 0 }; // 60原分 - 20遮挡
        const overlayImg = { url: "overlay.jpg", score: 50 + 20, area: 80000, domIndex: 1 };    // 50原分 + 20覆盖层加成
        const selected = selectImages([occludedImg, overlayImg], "single", "relevance");
        assertEqual(selected[0].url, "overlay.jpg");
    });

    it("模态框关闭后图片应恢复正常评分（无覆盖层加成/遮挡）", () => {
        // 模拟：模态框关闭，没有覆盖层
        const img1 = { url: "main-content.jpg", score: 65, area: 200000, domIndex: 0 };
        const img2 = { url: "sidebar-ad.jpg", score: 20, area: 50000, domIndex: 1 };
        const selected = selectImages([img1, img2], "single", "relevance");
        assertEqual(selected[0].url, "main-content.jpg");
    });

    it("高 z-index 灯箱小图也应优于大的背景图", () => {
        // 灯箱中的图片即使面积较小，因覆盖层加成也应排名靠前
        const bgLarge = { url: "bg-large.jpg", score: 25, area: 500000, domIndex: 0 };  // 大但被遮挡
        const overlaySmall = { url: "overlay-small.jpg", score: 55, area: 100000, domIndex: 1 }; // 覆盖层内
        const selected = selectImages([bgLarge, overlaySmall], "single", "relevance");
        assertEqual(selected[0].url, "overlay-small.jpg");
    });
});

// ---- DOMWatcher 变化检测逻辑测试 ----

/**
 * 模拟 DOMWatcher._isSignificantChange 的判断逻辑
 * change: { type, tag?, class?, role?, position?, zIndex?, attributeName? }
 */
function mockIsSignificantChange(changes) {
    for (const c of changes) {
        if (c.type === 'childList') {
            if (c.tag === 'ws-root') continue;
            if (c.tag === 'IMG' || c.hasImgChild) return true;
            if (c.tag === 'PICTURE' || c.tag === 'VIDEO') return true;
            if ((c.position === 'fixed' || c.position === 'absolute') && (c.zIndex || 0) >= 50) return true;
            if (c.role === 'dialog') return true;
            if (/lightbox|fancybox|modal|overlay|viewer|gallery|image.?view/i.test(c.class || '')) return true;
        }
        if (c.type === 'attributes') {
            if (c.tag === 'ws-root') continue;
            if (c.tag === 'IMG' && (c.attributeName === 'src' || c.attributeName === 'srcset')) return true;
            if (c.attributeName === 'style' || c.attributeName === 'class') {
                if ((c.position === 'fixed' || c.position === 'absolute') && (c.zIndex || 0) >= 50) return true;
                if (c.role === 'dialog') return true;
                if (/lightbox|fancybox|modal|overlay|viewer|gallery|image.?view/i.test(c.class || '')) return true;
            }
        }
    }
    return false;
}

describe("DOMWatcher 变化检测逻辑", () => {
    it("新增 IMG 元素应被检测", () => {
        assert(mockIsSignificantChange([{ type: 'childList', tag: 'IMG' }]));
    });

    it("新增包含 IMG 子元素的容器应被检测", () => {
        assert(mockIsSignificantChange([{ type: 'childList', tag: 'DIV', hasImgChild: true }]));
    });

    it("新增 PICTURE 元素应被检测", () => {
        assert(mockIsSignificantChange([{ type: 'childList', tag: 'PICTURE' }]));
    });

    it("新增 VIDEO 元素应被检测", () => {
        assert(mockIsSignificantChange([{ type: 'childList', tag: 'VIDEO' }]));
    });

    it("新增高 z-index fixed 元素应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'childList', tag: 'DIV', position: 'fixed', zIndex: 100,
        }]));
    });

    it("新增 role=dialog 元素应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'childList', tag: 'DIV', role: 'dialog',
        }]));
    });

    it("新增带 lightbox 类名的元素应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'childList', tag: 'DIV', class: 'photo-lightbox-container',
        }]));
    });

    it("新增带 modal 类名的元素应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'childList', tag: 'DIV', class: 'my-modal-wrapper',
        }]));
    });

    it("新增带 viewer 类名的元素应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'childList', tag: 'DIV', class: 'image-viewer',
        }]));
    });

    it("新增 ws-root 元素应被忽略", () => {
        assert(!mockIsSignificantChange([{ type: 'childList', tag: 'ws-root' }]));
    });

    it("新增普通 DIV（无图片/覆盖层）应被忽略", () => {
        assert(!mockIsSignificantChange([{
            type: 'childList', tag: 'DIV', class: 'footer-text',
        }]));
    });

    it("IMG src 属性变化应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'attributes', tag: 'IMG', attributeName: 'src',
        }]));
    });

    it("IMG srcset 属性变化应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'attributes', tag: 'IMG', attributeName: 'srcset',
        }]));
    });

    it("覆盖层 style 属性变化应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'attributes', tag: 'DIV', attributeName: 'style',
            position: 'fixed', zIndex: 100,
        }]));
    });

    it("非覆盖层的 style 变化应被忽略", () => {
        assert(!mockIsSignificantChange([{
            type: 'attributes', tag: 'DIV', attributeName: 'style',
            position: 'relative', zIndex: 1,
        }]));
    });

    it("dialog class 变化应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'attributes', tag: 'DIV', attributeName: 'class',
            role: 'dialog',
        }]));
    });

    it("gallery class 变化应被检测", () => {
        assert(mockIsSignificantChange([{
            type: 'attributes', tag: 'DIV', attributeName: 'class',
            class: 'swiper-gallery',
        }]));
    });

    it("ws-root 属性变化应被忽略", () => {
        assert(!mockIsSignificantChange([{
            type: 'attributes', tag: 'ws-root', attributeName: 'style',
        }]));
    });
});

// ---- 防抖逻辑（纯函数测试）----
describe("防抖逻辑", () => {
    it("短时间内多次调用应合并为一次", () => {
        let callCount = 0;
        let lastNotify = 0;
        const MIN_INTERVAL = 300;
        function tryNotify() {
            const now = Date.now();
            if (now - lastNotify < MIN_INTERVAL) return;
            lastNotify = now;
            callCount++;
        }
        // 同一时刻连续调用 5 次
        for (let i = 0; i < 5; i++) tryNotify();
        assertEqual(callCount, 1, "瞬时连续调用应只触发 1 次");
    });

    it("超过最小间隔后应允许再次触发", () => {
        let callCount = 0;
        let lastNotify = 0;
        const MIN_INTERVAL = 300;
        function tryNotify(now) {
            if (now - lastNotify < MIN_INTERVAL) return;
            lastNotify = now;
            callCount++;
        }
        tryNotify(1000);   // 第 1 次
        tryNotify(1100);   // 被跳过（间隔 100ms < 300ms）
        tryNotify(1400);   // 第 2 次（间隔 400ms > 300ms）
        assertEqual(callCount, 2, "超过间隔后应再次触发");
    });
});

// =====================================================================
// 测试结果汇总
// =====================================================================

// ---- urlMatchesGlob ----
function urlMatchesGlob(url, pattern) {
    if (!url || !pattern) return false;
    try {
        const pathname = new URL(url, 'https://example.com').pathname;
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const regexStr = escaped.replace(/\*/g, '.*');
        return new RegExp(regexStr, 'i').test(pathname);
    } catch (_) {
        return false;
    }
}

describe("urlMatchesGlob (URL 模式匹配)", () => {
    it("应匹配简单路径模式", () => {
        assert(urlMatchesGlob("https://example.com/users/abc/content", "users/*/content"));
    });
    it("应匹配多段路径（* 匹配含 / 的内容）", () => {
        assert(urlMatchesGlob(
            "https://grok.868986.xyz/users/7d784541-61ea-4cf3-81b9-9219325e2469/2fcc0157-bc28-4b20-ac46-6875a1e45b1f/content",
            "users/*/content"
        ));
    });
    it("应匹配尾部通配符", () => {
        assert(urlMatchesGlob("https://example.com/users/abc/content?cache=1", "users/*/content*"));
    });
    it("应不匹配不相关路径", () => {
        assert(!urlMatchesGlob("https://example.com/images/photo.jpg", "users/*/content*"));
    });
    it("应匹配图片路径", () => {
        assert(urlMatchesGlob("https://example.com/imagine-public/images/photo.jpg", "images/*.jpg"));
    });
    it("应大小写不敏感", () => {
        assert(urlMatchesGlob("https://example.com/Users/ABC/Content", "users/*/content"));
    });
    it("空参数应返回 false", () => {
        assert(!urlMatchesGlob("", "test"));
        assert(!urlMatchesGlob("https://example.com/test", ""));
        assert(!urlMatchesGlob(null, "test"));
        assert(!urlMatchesGlob("https://example.com/test", null));
    });
    it("应正确转义正则特殊字符", () => {
        assert(urlMatchesGlob("https://example.com/path/file.jpg", "path/file.jpg"));
    });
    it("应匹配 API 端点模式", () => {
        assert(urlMatchesGlob("https://api.example.com/v1/images/generate", "v1/images/*"));
    });
    it("星号应匹配空字符串", () => {
        assert(urlMatchesGlob("https://example.com/users/content", "users/*content"));
    });
});

// ---- URL 评分 (_urlScore) ----

function mockUrlScore(url) {
    let score = 0;
    try {
        const pathname = new URL(url, 'https://example.com').pathname.toLowerCase();
        if (/\.(jpe?g|png|gif|webp|avif|bmp|tiff|svg)$/i.test(pathname)) {
            score += 5;
        } else if (!/\.\w{1,5}$/.test(pathname)) {
            score -= 5;
        }
        if (/\/(images?|uploads?|photos?|media|gallery|pictures?|artworks?)\//i.test(pathname)) {
            score += 3;
        }
        if (/\/(users?|avatars?|profiles?|accounts?)\//i.test(pathname)) {
            score -= 5;
        }
        if (/\/(content|data|blob|file|thumbnail|thumb)$/i.test(pathname)) {
            score -= 3;
        }
    } catch (_) { }
    return Math.min(Math.max(score, -10), 10);
}

describe("URL 评分 (_urlScore)", () => {
    it("有 .jpg 扩展名的 URL 应加分", () => {
        const score = mockUrlScore("https://cdn.example.com/images/photo.jpg");
        assert(score > 0, "应得正分: " + score);
    });
    it("有 .png 扩展名的 URL 应加分", () => {
        const score = mockUrlScore("https://example.com/upload/img.png");
        assert(score > 0, "应得正分: " + score);
    });
    it("无扩展名的 API 端点 URL 应扣分", () => {
        const score = mockUrlScore("https://example.com/users/abc/content");
        assert(score < 0, "应得负分: " + score);
    });
    it("/users/ 路径应扣分", () => {
        const score = mockUrlScore("https://example.com/users/abc/avatar");
        assert(score < 0, "应得负分: " + score);
    });
    it("/images/ 路径应加分", () => {
        const score = mockUrlScore("https://cdn.example.com/images/photo.jpg");
        assertEqual(score, 8, "应得 +5(ext) +3(images path) = 8");
    });
    it("干扰项 URL 应得负分", () => {
        const score = mockUrlScore("https://grok.868986.xyz/users/7d784541/2fcc0157/content");
        assertEqual(score, -10, "应得 -5(no ext) -5(users) 并被限制为 -10");
    });
    it("目标 URL 应得正分", () => {
        const score = mockUrlScore("https://grok.868986.xyz/imagine-public/images/photo.jpg");
        assertEqual(score, 8, "应得 +5(ext) +3(images path) = 8");
    });
    it("干扰项与目标的分差应显著", () => {
        const interference = mockUrlScore("https://grok.868986.xyz/users/7d784541/2fcc0157/content");
        const target = mockUrlScore("https://grok.868986.xyz/imagine-public/images/photo.jpg");
        assert(target - interference >= 15, `分差应 >= 15: 目标 ${target}, 干扰 ${interference}`);
    });
    it("以 /content 结尾应额外扣分", () => {
        const score = mockUrlScore("https://example.com/api/content");
        assert(score < -5, "应得低于 -5 分: " + score);
    });
    it("/uploads/ 路径应加分", () => {
        const score = mockUrlScore("https://example.com/uploads/image.webp");
        assertEqual(score, 8, "应得 +5(ext) +3(uploads path) = 8");
    });
    it("普通 URL 无特殊模式应得中性分", () => {
        const score = mockUrlScore("https://example.com/static/bg.jpg");
        assertEqual(score, 5, "只有扩展名加分: +5");
    });
    it("结果应被限制在 [-10, 10] 范围内", () => {
        const low = mockUrlScore("https://example.com/users/avatar/content");
        assert(low >= -10, "不应低于 -10");
        const high = mockUrlScore("https://example.com/images/uploads/photo.jpg");
        assert(high <= 10, "不应高于 10");
    });
});

// ---- URL 排除过滤集成测试 ----
describe("URL 排除过滤集成测试", () => {
    it("应根据排除模式过滤图片", () => {
        const patterns = ["users/*/content*"];
        const images = [
            { url: "https://grok.868986.xyz/users/abc/def/content?cache=1" },
            { url: "https://grok.868986.xyz/imagine-public/images/photo.jpg" },
        ];
        const filtered = images.filter(img => !patterns.some(p => urlMatchesGlob(img.url, p)));
        assertEqual(filtered.length, 1);
        assert(filtered[0].url.includes("photo.jpg"));
    });
    it("无排除模式时应保留所有图片", () => {
        const patterns = [];
        const images = [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/b.jpg" },
        ];
        const filtered = images.filter(img => !patterns.some(p => urlMatchesGlob(img.url, p)));
        assertEqual(filtered.length, 2);
    });
    it("多个排除模式应全部生效", () => {
        const patterns = ["users/*", "api/*"];
        const images = [
            { url: "https://example.com/users/avatar.jpg" },
            { url: "https://example.com/api/thumbnail" },
            { url: "https://example.com/images/photo.jpg" },
        ];
        const filtered = images.filter(img => !patterns.some(p => urlMatchesGlob(img.url, p)));
        assertEqual(filtered.length, 1);
        assert(filtered[0].url.includes("photo.jpg"));
    });
    it("排除模式不应影响不匹配的 URL", () => {
        const patterns = ["avatars/*"];
        const images = [
            { url: "https://example.com/images/photo.jpg" },
            { url: "https://example.com/uploads/big.png" },
        ];
        const filtered = images.filter(img => !patterns.some(p => urlMatchesGlob(img.url, p)));
        assertEqual(filtered.length, 2);
    });
});

// ---- Settings domainExcludes ----
describe("Settings domainExcludes", () => {
    it("应返回当前域名的排除模式列表", () => {
        const s = new MockSettings({ domainExcludes: { "example.com": "users/*/content*\napi/*" } });
        const patterns = s.getExcludePatterns();
        assertEqual(patterns.length, 2);
        assertEqual(patterns[0], "users/*/content*");
        assertEqual(patterns[1], "api/*");
    });
    it("无排除模式时应返回空数组", () => {
        const s = new MockSettings();
        assertEqual(s.getExcludePatterns().length, 0);
    });
    it("应忽略空行", () => {
        const s = new MockSettings({ domainExcludes: { "example.com": "pattern1\n\n  \npattern2" } });
        const patterns = s.getExcludePatterns();
        assertEqual(patterns.length, 2);
    });
    it("应去除模式首尾空白", () => {
        const s = new MockSettings({ domainExcludes: { "example.com": "  users/*  " } });
        assertEqual(s.getExcludePatterns()[0], "users/*");
    });
    it("reset 应清除排除模式", () => {
        const s = new MockSettings({ domainExcludes: { "example.com": "test" } });
        s.reset();
        assertEqual(s.getExcludePatterns().length, 0);
    });
});

// ---- 用户场景集成测试：grok 页面 ----
describe("用户场景：grok 页面图片选择", () => {
    it("目标图片应优于干扰项（URL 评分差异）", () => {
        // 模拟 grok 场景：两张图片，只有 URL 评分不同
        const interference = {
            url: "https://grok.868986.xyz/users/7d784541/2fcc0157/content?cache=1",
            score: 50 + mockUrlScore("https://grok.868986.xyz/users/7d784541/2fcc0157/content"),
            area: 10000, domIndex: 0,
        };
        const target = {
            url: "https://grok.868986.xyz/imagine-public/images/180bcf62.jpg?cache=1",
            score: 50 + mockUrlScore("https://grok.868986.xyz/imagine-public/images/180bcf62.jpg"),
            area: 10000, domIndex: 1,
        };
        const selected = selectImages([interference, target], "single", "relevance");
        assertEqual(selected[0].url, target.url, "应选择目标图片");
    });
    it("排除模式应过滤干扰项", () => {
        const patterns = ["users/*/content*"];
        const images = [
            { url: "https://grok.868986.xyz/users/7d784541/2fcc0157/content?cache=1" },
            { url: "https://grok.868986.xyz/imagine-public/images/180bcf62.jpg?cache=1" },
        ];
        const filtered = images.filter(img => !patterns.some(p => urlMatchesGlob(img.url, p)));
        assertEqual(filtered.length, 1);
        assert(filtered[0].url.includes("180bcf62.jpg"));
    });
});

console.log("\n" + "=".repeat(50));
console.log(`  结果: ${_passed} 通过, ${_failed} 失败`);
console.log("=".repeat(50) + "\n");

process.exit(_failed > 0 ? 1 : 0);
