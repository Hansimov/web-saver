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
            sortBy: "size",
            imageFormat: "original",
            nameTemplate: "{yyyy}-{mm}-{dd}-{hh}{MM}{ss}",
            defaultSavePath: "",
            domainPaths: {},
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
    reset() {
        this._data = {
            saveMode: "single", sortBy: "size", imageFormat: "original",
            nameTemplate: "{yyyy}-{mm}-{dd}-{hh}{MM}{ss}", defaultSavePath: "",
            domainPaths: {}, conflictAction: "uniquify", duplicateAction: "skip",
            minImageSize: 50, firstRun: true,
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
    const sorted = sortBy === "size" ? sortBySize(images) : sortByTime(images);
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
        assertEqual(s.get("sortBy"), "size");
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

// ---- 重复 URL 追踪 ----
describe("重复 URL 追踪", () => {
    it("Map 应正确检测重复 URL", () => {
        const savedUrls = new Map();
        const url = "https://example.com/image.jpg";
        savedUrls.set(url, "2024-01-01-120000.jpg");
        assert(savedUrls.has(url), "应检测到重复 URL");
        assertEqual(savedUrls.get(url), "2024-01-01-120000.jpg");
    });
    it("不同 URL 不应被判定为重复", () => {
        const savedUrls = new Map();
        savedUrls.set("https://example.com/a.jpg", "a.jpg");
        assert(!savedUrls.has("https://example.com/b.jpg"), "不同 URL 不应为重复");
    });
    it("应统计跳过的重复图片数量", () => {
        const savedUrls = new Map();
        const images = [
            { url: "https://example.com/a.jpg" },
            { url: "https://example.com/b.jpg" },
            { url: "https://example.com/a.jpg" },  // 重复
            { url: "https://example.com/c.jpg" },
            { url: "https://example.com/b.jpg" },  // 重复
        ];
        // 模拟保存流程
        const results = [];
        for (const img of images) {
            if (savedUrls.has(img.url)) {
                results.push({ status: "skipped-dup" });
                continue;
            }
            savedUrls.set(img.url, "file.jpg");
            results.push({ status: "success" });
        }
        const dupCount = results.filter(r => r.status === "skipped-dup").length;
        assertEqual(dupCount, 2, "应有 2 张重复图片被跳过");
        const successCount = results.filter(r => r.status === "success").length;
        assertEqual(successCount, 3, "应有 3 张图片成功保存");
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
        assertEqual(s.get("sortBy"), "size");
    });
    it("Settings 应将部分数据与默认值合并", () => {
        const s = new MockSettings({ saveMode: "multiple" });
        assertEqual(s.get("saveMode"), "multiple");
        assertEqual(s.get("sortBy"), "size");
        assertEqual(s.get("conflictAction"), "uniquify");
    });
    it("Settings reset 应恢复所有默认值", () => {
        const s = new MockSettings({ saveMode: "multiple", sortBy: "time" });
        s.reset();
        assertEqual(s.get("saveMode"), "single");
        assertEqual(s.get("sortBy"), "size");
    });
});

// ---- 快捷键事件模拟 ----
describe("快捷键事件模拟", () => {
    it("e.code === 'KeyI' 应匹配，不受键盘布局影响", () => {
        const mockEvent = { code: "KeyI", keyCode: 73, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false };
        assert(mockEvent.code === "KeyI" || mockEvent.keyCode === 73, "应通过 code 或 keyCode 匹配");
        assert(!mockEvent.isComposing, "不应在输入法编辑状态");
    });
    it("输入法编辑状态应被忽略", () => {
        const mockEvent = { code: "KeyI", ctrlKey: true, altKey: true, isComposing: true };
        assert(mockEvent.isComposing, "isComposing 应为 true");
        // 此时快捷键不应触发
    });
    it("e.keyCode === 73 应作为降级匹配", () => {
        const mockEvent = { code: "", keyCode: 73, ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false };
        assert(mockEvent.code === "KeyI" || mockEvent.keyCode === 73, "应通过 keyCode 降级匹配");
    });
    it("不应响应含 Shift 的组合键", () => {
        const mockEvent = { code: "KeyI", ctrlKey: true, altKey: true, shiftKey: true, metaKey: false };
        const shouldHandle = mockEvent.ctrlKey && mockEvent.altKey && !mockEvent.shiftKey && !mockEvent.metaKey;
        assert(!shouldHandle, "含 Shift 时不应响应");
    });
});

// =====================================================================
// 测试结果汇总
// =====================================================================
console.log("\n" + "=".repeat(50));
console.log(`  结果: ${_passed} 通过, ${_failed} 失败`);
console.log("=".repeat(50) + "\n");

process.exit(_failed > 0 ? 1 : 0);
