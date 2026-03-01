# Auto Player

阻止网页在用户离开标签页时暂停音视频播放的油猴脚本。

## 功能概述

当用户切换标签页或最小化窗口时，许多视频/音频网站会检测到页面失焦并暂停播放。Auto Player 通过多层防御机制阻止这些检测，确保媒体持续播放。

## 防御模块

脚本采用 **9 层递进防御**，覆盖网站常用的所有失焦检测手段：

| 模块 | 名称 | 防御目标 |
|------|------|----------|
| A | Visibility API 覆盖 | `document.hidden`、`visibilityState`、`hasFocus()` — 含原型链 |
| B | 捕获阶段拦截器 | `visibilitychange`（document）、`blur`/`focus`（window） |
| C | addEventListener 拦截 | 阻止页面注册失焦相关事件监听器 |
| D | on* 属性处理器拦截 | `document.onvisibilitychange`、`window.onblur`、`window.onfocus` |
| E | requestAnimationFrame 伪装 | 隐藏标签页时用 setTimeout(16ms) 模拟 rAF |
| F | 媒体 pause() 拦截 | 区分用户暂停 vs 脚本暂停，阻止后者 |
| G | MutationObserver 监控 | 自动跟踪动态添加的媒体元素 |
| H | 定时轮询保障 | 每 500ms 检查并恢复被意外暂停的活跃媒体 |
| I | 覆盖保护 | 每 2s 检测覆盖是否被网站移除，自动重新应用 |

## 网站检测机制 vs 防御对照

| 网站检测方式 | 防御模块 |
|---|---|
| `document.addEventListener("visibilitychange", ...)` | B (捕获拦截) + C (注册拦截) |
| `document.onvisibilitychange = fn` | D (属性拦截) |
| `document.hidden` / `visibilityState` 轮询 | A (API 覆盖) |
| `document.hasFocus()` 轮询 | A (API 覆盖) |
| `Document.prototype.hidden` 原型链读取 | A (原型级覆盖) |
| `window.addEventListener("blur", ...)` | B (捕获拦截) + C (注册拦截) |
| `window.onblur = fn` | D (属性拦截) |
| `requestAnimationFrame` 停止检测 | E (rAF 伪装) |
| 直接调用 `video.pause()` | F (pause 拦截) + H (轮询恢复) |

## 使用方式

1. 在 Tampermonkey 中安装 `auto-player.user.js`
2. 脚本默认启用，页面右下角显示 ▶ 指示器
3. 点击指示器或通过 Tampermonkey 菜单切换启用/禁用

## 关键设计

- **`unsafeWindow`**：通过 `unsafeWindow` 修改页面真实的 DOM API，避免油猴沙箱隔离导致覆盖无效
- **`@run-at document-start`**：在页面脚本执行前注入，确保拦截器先于网站代码安装
- **幂等性**：所有模块支持重复调用 `activate()` 而不会叠加副作用
- **用户暂停尊重**：通过 `userPaused` WeakSet 区分用户主动暂停和脚本暂停，不干扰用户操作

## 测试

```bash
# 运行单元测试（40 个测试用例）
node tests/auto-player.test.js

# 打开集成测试页面（在浏览器中配合 Tampermonkey 使用）
# tests/auto-player-test-page.html
```

测试页面包含 9 种独立的检测器（A-I）和综合攻击模拟，可逐项验证每个防御模块的效果。

## 文件结构

```
auto-player.user.js              # 主脚本
docs/auto-player.md              # 本文档
tests/auto-player.test.js        # 单元测试（Node.js）
tests/auto-player-test-page.html # 集成测试页面（浏览器）
```