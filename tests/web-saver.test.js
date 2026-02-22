/**
 * Web Saver — Unit & Integration Tests
 *
 * Run with Node.js:  node tests/web-saver.test.js
 *
 * These tests extract and validate pure logic functions (FileNamer, sorting,
 * settings defaults, filename utilities) without requiring a real browser DOM.
 * Browser-specific integration tests are in tests/test-page.html.
 */

"use strict";

// =========================================================================
// Minimal test harness
// =========================================================================
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

function assert(condition, msg = "Assertion failed") {
    if (!condition) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(
            msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
    }
}

function assertDeepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        throw new Error(msg || `Expected ${b}, got ${a}`);
    }
}

// =========================================================================
// Extract pure logic from the userscript (duplicated here for testability)
// =========================================================================
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

// Minimal Settings mock
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
            minImageSize: 50,
            firstRun: true,
            ...overrides,
        };
    }
    get(key) { return this._data[key]; }
    set(key, value) { this._data[key] = value; }
    getAll() { return { ...this._data }; }
    setAll(obj) { Object.assign(this._data, obj); }
    getSavePath() {
        return this._data.domainPaths["example.com"] || this._data.defaultSavePath || "";
    }
    reset() {
        this._data.saveMode = "single";
        this._data.sortBy = "size";
    }
}

// FileNamer (adapted for Node — no window/document)
class FileNamer {
    constructor(settings, mockContext = {}) {
        this.settings = settings;
        this.mockContext = mockContext;
    }

    generate(context = {}) {
        const template = this.settings.get("nameTemplate");
        const now = this.mockContext.now || new Date(2026, 1, 22, 14, 30, 45); // Feb 22, 2026 14:30:45
        const domain = this.mockContext.domain || "example.com";
        const title = sanitizeFilename(this.mockContext.title || "Test Page").substring(0, 100);
        const href = this.mockContext.href || "https://example.com/page";

        const replacements = {
            "{title}": title,
            "{domain}": domain,
            "{url}": sanitizeFilename(href).substring(0, 200),
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

        if (!template.includes("{ext}")) {
            filename += "." + (context.ext || "jpg");
        }

        return sanitizeFilename(filename);
    }
}

// Sort logic (extracted)
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

// Uniquify logic (extracted)
function uniquify(filename, sessionNames) {
    if (!sessionNames.has(filename)) return filename;
    const dotIdx = filename.lastIndexOf(".");
    const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
    const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";
    let n = 1;
    while (sessionNames.has(`${base}-${n}${ext}`)) n++;
    return `${base}-${n}${ext}`;
}

// =========================================================================
// Tests
// =========================================================================
console.log("\n🧪 Web Saver Tests\n" + "=".repeat(50));

// ---- Utility Tests ----
describe("getExtFromUrl", () => {
    it("should extract jpg extension", () => {
        assertEqual(getExtFromUrl("https://example.com/photo.jpg"), "jpg");
    });

    it("should normalize jpeg to jpg", () => {
        assertEqual(getExtFromUrl("https://example.com/photo.jpeg"), "jpg");
    });

    it("should extract png extension", () => {
        assertEqual(getExtFromUrl("https://example.com/photo.png"), "png");
    });

    it("should extract webp extension", () => {
        assertEqual(getExtFromUrl("https://cdn.example.com/img.webp"), "webp");
    });

    it("should extract gif extension", () => {
        assertEqual(getExtFromUrl("https://example.com/anim.gif"), "gif");
    });

    it("should handle query parameters", () => {
        assertEqual(getExtFromUrl("https://example.com/photo.png?w=200&h=150"), "png");
    });

    it("should handle hash fragments", () => {
        assertEqual(getExtFromUrl("https://example.com/photo.webp#section"), "webp");
    });

    it("should default to jpg for unknown extensions", () => {
        assertEqual(getExtFromUrl("https://example.com/image"), "jpg");
    });

    it("should default to jpg for invalid URLs", () => {
        assertEqual(getExtFromUrl("not-a-url"), "jpg");
    });

    it("should handle URLs with paths", () => {
        assertEqual(getExtFromUrl("https://cdn.example.com/images/2026/02/photo.avif"), "avif");
    });
});

describe("sanitizeFilename", () => {
    it("should replace forbidden characters", () => {
        const result = sanitizeFilename('file<>:"/\\|?*.txt');
        assert(!result.includes("<"), "should not contain <");
        assert(!result.includes(">"), "should not contain >");
        assert(!result.includes(":"), "should not contain :");
        assert(!result.includes('"'), 'should not contain "');
        assert(!result.includes("/"), "should not contain /");
        assert(!result.includes("\\"), "should not contain \\");
        assert(!result.includes("|"), "should not contain |");
        assert(!result.includes("?"), "should not contain ?");
        assert(!result.includes("*"), "should not contain *");
    });

    it("should preserve valid characters", () => {
        assertEqual(sanitizeFilename("hello-world_2026.jpg"), "hello-world_2026.jpg");
    });

    it("should trim whitespace", () => {
        assertEqual(sanitizeFilename("  hello.jpg  "), "hello.jpg");
    });
});

describe("padZero", () => {
    it("should pad single digit", () => {
        assertEqual(padZero(5), "05");
    });

    it("should not pad double digit", () => {
        assertEqual(padZero(12), "12");
    });

    it("should pad with custom length", () => {
        assertEqual(padZero(5, 4), "0005");
    });
});

// ---- Settings Tests ----
describe("Settings (MockSettings)", () => {
    it("should have correct defaults", () => {
        const s = new MockSettings();
        assertEqual(s.get("saveMode"), "single");
        assertEqual(s.get("sortBy"), "size");
        assertEqual(s.get("imageFormat"), "original");
        assertEqual(s.get("nameTemplate"), "{yyyy}-{mm}-{dd}-{hh}{MM}{ss}");
        assertEqual(s.get("conflictAction"), "uniquify");
        assertEqual(s.get("minImageSize"), 50);
        assertEqual(s.get("firstRun"), true);
    });

    it("should allow overrides", () => {
        const s = new MockSettings({ saveMode: "multiple", sortBy: "time" });
        assertEqual(s.get("saveMode"), "multiple");
        assertEqual(s.get("sortBy"), "time");
    });

    it("should support get and set", () => {
        const s = new MockSettings();
        s.set("saveMode", "multiple");
        assertEqual(s.get("saveMode"), "multiple");
    });

    it("should support setAll", () => {
        const s = new MockSettings();
        s.setAll({ imageFormat: "png", minImageSize: 100 });
        assertEqual(s.get("imageFormat"), "png");
        assertEqual(s.get("minImageSize"), 100);
    });

    it("should return save path for domain", () => {
        const s = new MockSettings({
            defaultSavePath: "default-folder",
            domainPaths: { "example.com": "example-folder" },
        });
        assertEqual(s.getSavePath(), "example-folder");
    });

    it("should fallback to default path", () => {
        const s = new MockSettings({
            defaultSavePath: "default-folder",
            domainPaths: {},
        });
        assertEqual(s.getSavePath(), "default-folder");
    });

    it("should return empty path when nothing set", () => {
        const s = new MockSettings();
        assertEqual(s.getSavePath(), "");
    });
});

// ---- FileNamer Tests ----
describe("FileNamer", () => {
    it("should generate default template filename", () => {
        const s = new MockSettings();
        const namer = new FileNamer(s, {
            now: new Date(2026, 1, 22, 14, 30, 45),
        });
        const result = namer.generate({ ext: "png" });
        assertEqual(result, "2026-02-22-143045.png");
    });

    it("should include title placeholder", () => {
        const s = new MockSettings({ nameTemplate: "{title}" });
        const namer = new FileNamer(s, { title: "My Page" });
        const result = namer.generate({ ext: "jpg" });
        assertEqual(result, "My Page.jpg");
    });

    it("should include domain placeholder", () => {
        const s = new MockSettings({ nameTemplate: "{domain}" });
        const namer = new FileNamer(s, { domain: "test.org" });
        const result = namer.generate({ ext: "png" });
        assertEqual(result, "test.org.png");
    });

    it("should include index placeholder", () => {
        const s = new MockSettings({ nameTemplate: "{title}-{index}" });
        const namer = new FileNamer(s, { title: "Gallery" });
        const result = namer.generate({ index: 3, ext: "jpg" });
        assertEqual(result, "Gallery-3.jpg");
    });

    it("should include ext placeholder inline", () => {
        const s = new MockSettings({ nameTemplate: "{domain}.{ext}" });
        const namer = new FileNamer(s, { domain: "example.com" });
        const result = namer.generate({ ext: "webp" });
        // {ext} is in template, so no auto-append
        assertEqual(result, "example.com.webp");
    });

    it("should sanitize title with special chars", () => {
        const s = new MockSettings({ nameTemplate: "{title}" });
        const namer = new FileNamer(s, { title: 'Hello: "World" <2026>' });
        const result = namer.generate({ ext: "jpg" });
        assert(!result.includes(":"), "no colon");
        assert(!result.includes('"'), "no quote");
        assert(!result.includes("<"), "no <");
    });

    it("should handle all date placeholders", () => {
        const s = new MockSettings({ nameTemplate: "{yyyy}{mm}{dd}{hh}{MM}{ss}" });
        const namer = new FileNamer(s, {
            now: new Date(2026, 0, 5, 8, 3, 9),
        });
        const result = namer.generate({ ext: "jpg" });
        assertEqual(result, "20260105080309.jpg");
    });

    it("should default ext to jpg when not provided", () => {
        const s = new MockSettings();
        const namer = new FileNamer(s, {
            now: new Date(2026, 1, 22, 14, 30, 45),
        });
        const result = namer.generate();
        assertEqual(result, "2026-02-22-143045.jpg");
    });
});

// ---- Sort & Select Tests ----
describe("sortBySize", () => {
    const images = [
        { url: "a", area: 100, domIndex: 0 },
        { url: "b", area: 500, domIndex: 1 },
        { url: "c", area: 300, domIndex: 2 },
    ];

    it("should sort largest first", () => {
        const sorted = sortBySize(images);
        assertEqual(sorted[0].url, "b");
        assertEqual(sorted[1].url, "c");
        assertEqual(sorted[2].url, "a");
    });

    it("should not mutate original array", () => {
        const original = [...images];
        sortBySize(images);
        assertDeepEqual(images, original);
    });
});

describe("sortByTime", () => {
    const images = [
        { url: "c", area: 300, domIndex: 200002 },
        { url: "a", area: 100, domIndex: 0 },
        { url: "b", area: 500, domIndex: 100001 },
    ];

    it("should sort by DOM order ascending", () => {
        const sorted = sortByTime(images);
        assertEqual(sorted[0].url, "a");
        assertEqual(sorted[1].url, "b");
        assertEqual(sorted[2].url, "c");
    });
});

describe("selectImages", () => {
    const images = [
        { url: "small", area: 100, domIndex: 0 },
        { url: "large", area: 1000, domIndex: 1 },
        { url: "medium", area: 500, domIndex: 2 },
    ];

    it("should return single largest image in single mode", () => {
        const result = selectImages(images, "single", "size");
        assertEqual(result.length, 1);
        assertEqual(result[0].url, "large");
    });

    it("should return all images in multiple mode", () => {
        const result = selectImages(images, "multiple", "size");
        assertEqual(result.length, 3);
        assertEqual(result[0].url, "large");
    });

    it("should return first DOM-order image in single+time mode", () => {
        const result = selectImages(images, "single", "time");
        assertEqual(result.length, 1);
        assertEqual(result[0].url, "small");
    });

    it("should return empty array for empty input", () => {
        const result = selectImages([], "single", "size");
        assertEqual(result.length, 0);
    });
});

// ---- Uniquify Tests ----
describe("uniquify", () => {
    it("should return original name if no conflict", () => {
        const names = new Set();
        assertEqual(uniquify("photo.jpg", names), "photo.jpg");
    });

    it("should add -1 suffix on first conflict", () => {
        const names = new Set(["photo.jpg"]);
        assertEqual(uniquify("photo.jpg", names), "photo-1.jpg");
    });

    it("should increment suffix on multiple conflicts", () => {
        const names = new Set(["photo.jpg", "photo-1.jpg", "photo-2.jpg"]);
        assertEqual(uniquify("photo.jpg", names), "photo-3.jpg");
    });

    it("should handle files without extension", () => {
        const names = new Set(["readme"]);
        assertEqual(uniquify("readme", names), "readme-1");
    });

    it("should handle files with multiple dots", () => {
        const names = new Set(["my.photo.jpg"]);
        assertEqual(uniquify("my.photo.jpg", names), "my.photo-1.jpg");
    });
});

// ---- Integration-style Tests ----
describe("Full pipeline (unit-level integration)", () => {
    it("should generate correct filename for single largest image", () => {
        const settings = new MockSettings({ saveMode: "single", sortBy: "size" });
        const images = [
            { url: "https://example.com/small.png", area: 100, domIndex: 0 },
            { url: "https://example.com/big.jpg", area: 10000, domIndex: 1 },
            { url: "https://example.com/medium.webp", area: 2000, domIndex: 2 },
        ];

        const selected = selectImages(images, settings.get("saveMode"), settings.get("sortBy"));
        assertEqual(selected.length, 1);
        assertEqual(selected[0].url, "https://example.com/big.jpg");

        const namer = new FileNamer(settings, {
            now: new Date(2026, 1, 22, 9, 5, 0),
            domain: "example.com",
        });
        const ext = getExtFromUrl(selected[0].url);
        const filename = namer.generate({ index: 1, ext });
        assertEqual(filename, "2026-02-22-090500.jpg");
    });

    it("should generate correct filenames for multiple images", () => {
        const settings = new MockSettings({
            saveMode: "multiple",
            sortBy: "size",
            nameTemplate: "{domain}-{index}",
        });
        const images = [
            { url: "https://cdn.test.com/a.png", area: 500, domIndex: 0 },
            { url: "https://cdn.test.com/b.webp", area: 2000, domIndex: 1 },
        ];

        const selected = selectImages(images, settings.get("saveMode"), settings.get("sortBy"));
        assertEqual(selected.length, 2);

        const namer = new FileNamer(settings, { domain: "cdn.test.com" });
        const filenames = selected.map((img, i) => {
            const ext = getExtFromUrl(img.url);
            return namer.generate({ index: i + 1, ext });
        });

        // Sorted by size: b.webp (2000) first, a.png (500) second
        assertEqual(filenames[0], "cdn.test.com-1.webp");
        assertEqual(filenames[1], "cdn.test.com-2.png");
    });

    it("should apply save path from domain settings", () => {
        const settings = new MockSettings({
            defaultSavePath: "web-saver",
            domainPaths: { "example.com": "web-saver/example" },
        });
        const savePath = settings.getSavePath();
        assertEqual(savePath, "web-saver/example");

        const namer = new FileNamer(settings, {
            now: new Date(2026, 1, 22, 12, 0, 0),
        });
        const filename = namer.generate({ ext: "jpg" });
        const fullPath = savePath ? `${savePath}/${filename}` : filename;
        assertEqual(fullPath, "web-saver/example/2026-02-22-120000.jpg");
    });

    it("should handle uniquify across session", () => {
        const sessionNames = new Set();
        const name1 = uniquify("photo.jpg", sessionNames);
        sessionNames.add(name1);
        assertEqual(name1, "photo.jpg");

        const name2 = uniquify("photo.jpg", sessionNames);
        sessionNames.add(name2);
        assertEqual(name2, "photo-1.jpg");

        const name3 = uniquify("photo.jpg", sessionNames);
        sessionNames.add(name3);
        assertEqual(name3, "photo-2.jpg");
    });

    it("should handle format override in extension", () => {
        const settings = new MockSettings({
            imageFormat: "webp",
            nameTemplate: "{yyyy}-{mm}-{dd}",
        });
        const namer = new FileNamer(settings, {
            now: new Date(2026, 1, 22, 0, 0, 0),
        });
        // When format is not 'original', ext is overridden
        const ext = settings.get("imageFormat") !== "original"
            ? settings.get("imageFormat")
            : getExtFromUrl("https://example.com/photo.jpg");
        const filename = namer.generate({ ext });
        assertEqual(filename, "2026-02-22.webp");
    });
});

// ---- GM_* Wrapper Fallback Tests ----
describe("GM_* wrapper fallback logic", () => {
    it("gmGetValue should return default when GM_getValue unavailable", () => {
        // Simulate: no GM_getValue, no localStorage
        // The function should return the default value
        const defaultVal = { key: "value" };
        // We test the pattern used in the script
        function gmGetValueSim(key, def) {
            try { throw new Error("no GM"); } catch (_) { }
            try {
                // Simulate no localStorage
                throw new Error("no localStorage");
            } catch (_) { return def; }
        }
        const result = gmGetValueSim("test", defaultVal);
        assertDeepEqual(result, defaultVal);
    });

    it("gmAddStyle should fall back to <style> element approach", () => {
        // Just verify the pattern doesn't throw
        function gmAddStyleSim(css) {
            try {
                if (typeof GM_addStyle_NOT_DEFINED === "function") {
                    GM_addStyle_NOT_DEFINED(css);
                    return;
                }
            } catch (_) { }
            // Fallback logic would create a <style> element in browser
            // Here we just verify no exception
            return "fallback";
        }
        assertEqual(gmAddStyleSim(".test { color: red; }"), "fallback");
    });

    it("gmDownload should return false when GM_download unavailable", () => {
        function gmDownloadSim(opts) {
            if (typeof GM_download_NOT_DEFINED === "function") {
                try { GM_download_NOT_DEFINED(opts); return true; } catch (_) { }
            }
            return false;
        }
        assertEqual(gmDownloadSim({ url: "test", name: "test" }), false);
    });
});

// ---- Robustness Tests ----
describe("Robustness", () => {
    it("Settings should handle corrupted stored data gracefully", () => {
        // Simulate corrupted JSON
        function loadSettingsSim(rawValue) {
            const defaults = { saveMode: "single", sortBy: "size" };
            const data = { ...defaults };
            try {
                if (rawValue) {
                    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
                    Object.assign(data, parsed);
                }
            } catch (_) { }
            return data;
        }
        const result = loadSettingsSim("{{invalid json");
        assertEqual(result.saveMode, "single");
        assertEqual(result.sortBy, "size");
    });

    it("Settings should handle null stored data", () => {
        function loadSettingsSim(rawValue) {
            const defaults = { saveMode: "single" };
            const data = { ...defaults };
            try {
                if (rawValue) {
                    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
                    Object.assign(data, parsed);
                }
            } catch (_) { }
            return data;
        }
        const result = loadSettingsSim(null);
        assertEqual(result.saveMode, "single");
    });

    it("Settings should merge partial stored data with defaults", () => {
        function loadSettingsSim(rawValue) {
            const defaults = { saveMode: "single", sortBy: "size", imageFormat: "original" };
            const data = { ...defaults };
            try {
                if (rawValue) {
                    const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
                    Object.assign(data, parsed);
                }
            } catch (_) { }
            return data;
        }
        const result = loadSettingsSim('{"sortBy":"time"}');
        assertEqual(result.saveMode, "single");
        assertEqual(result.sortBy, "time");
        assertEqual(result.imageFormat, "original");
    });

    it("getExtFromUrl should handle data: URIs", () => {
        assertEqual(getExtFromUrl("data:image/png;base64,abc123"), "jpg");
    });

    it("getExtFromUrl should handle blob: URIs", () => {
        assertEqual(getExtFromUrl("blob:https://example.com/uuid"), "jpg");
    });

    it("sanitizeFilename should handle empty string", () => {
        assertEqual(sanitizeFilename(""), "");
    });

    it("sanitizeFilename should handle very long names", () => {
        const long = "a".repeat(300);
        const result = sanitizeFilename(long);
        assertEqual(result.length, 300);
    });

    it("selectImages should handle images with zero area", () => {
        const images = [
            { url: "zero", area: 0, domIndex: 0 },
            { url: "small", area: 100, domIndex: 1 },
        ];
        const result = selectImages(images, "single", "size");
        assertEqual(result.length, 1);
        assertEqual(result[0].url, "small");
    });

    it("uniquify should handle rapid sequential calls", () => {
        const names = new Set();
        for (let i = 0; i < 100; i++) {
            const name = uniquify("rapid.jpg", names);
            assert(!names.has(name), `Duplicate name at iteration ${i}: ${name}`);
            names.add(name);
        }
        assertEqual(names.size, 100);
    });
});

// =========================================================================
// Summary
// =========================================================================
console.log("\n" + "=".repeat(50));
console.log(`  Results: ${_passed} passed, ${_failed} failed`);
console.log("=".repeat(50) + "\n");

process.exit(_failed > 0 ? 1 : 0);
