# Web Saver

A Tampermonkey userscript that automatically collects images from web pages and saves them with a single hotkey.

## Features

- **One-key save** — Press `Ctrl+Alt+I` to instantly save the largest image on the page
- **Floating button** — A 📷 button in the bottom-left corner provides quick access to save and settings
- **Smart image collection** — Finds images from `<img>`, CSS background images, lazy-loaded `data-src`, and `<video poster>`
- **Flexible sorting** — Sort by size (area, largest first) or DOM order
- **Single or batch save** — Save just the biggest image, or all images at once
- **Format conversion** — Save as original format, or convert to PNG / JPG / WebP
- **Custom naming** — Template-based filenames with date, page title, domain, and index placeholders
- **Per-domain save paths** — Configure different download subfolders for different websites
- **Conflict handling** — Auto-increment, overwrite, skip, or prompt on filename collision
- **Visual feedback** — Highlights selected images and shows toast notifications with console logging
- **Settings panel** — Clean in-page UI (`Ctrl+Alt+O`) to configure all options; opens automatically on first install
- **Robust initialization** — Graceful fallbacks when GM_* APIs aren't available; visible error reporting

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Create a new userscript and paste the contents of `web-saver.user.js`, **or** click the raw file link if hosted on a supported platform.
3. Save and enable the script.

## Usage

| Action            | Trigger                                  |
|-------------------|------------------------------------------|
| Save image(s)     | `Ctrl + Alt + I`                         |
| Open settings     | `Ctrl + Alt + O` or 📷 button → Settings |
| Save via button   | Click 📷 button → Save Image(s)          |
| Save via menu     | Tampermonkey menu → **📷 Save Image(s)** |
| Settings via menu | Tampermonkey menu → **⚙ Settings**       |

On first install the settings panel opens automatically so you can configure preferences.

## Configuration

All settings are persisted via `GM_setValue` and survive page reloads / browser restarts.

| Setting               | Default                         | Description                                                |
|-----------------------|---------------------------------|------------------------------------------------------------|
| **Save Mode**         | `single`                        | `single` saves the top-ranked image; `multiple` saves all  |
| **Sort By**           | `size`                          | `size` = largest area first; `time` = DOM order            |
| **Image Format**      | `original`                      | Keep original format, or convert to `png` / `jpg` / `webp` |
| **Name Template**     | `{yyyy}-{mm}-{dd}-{hh}{MM}{ss}` | Filename pattern (see placeholders below)                  |
| **Default Save Path** | *(empty)*                       | Subfolder under the browser downloads directory            |
| **Domain Save Path**  | *(empty)*                       | Per-domain override for save path                          |
| **Conflict Action**   | `uniquify`                      | `uniquify` / `overwrite` / `skip` / `prompt`               |
| **Min Image Size**    | `50` px                         | Images smaller than this (w **and** h) are ignored         |

## Name Template Placeholders

| Placeholder | Description                                  | Example                    |
|-------------|----------------------------------------------|----------------------------|
| `{title}`   | Page title (sanitized)                       | `My_Page_Title`            |
| `{domain}`  | Hostname                                     | `example.com`              |
| `{url}`     | Full URL (sanitized, truncated to 200 chars) | `https___example.com_page` |
| `{yyyy}`    | 4-digit year                                 | `2026`                     |
| `{mm}`      | 2-digit month                                | `02`                       |
| `{dd}`      | 2-digit day                                  | `22`                       |
| `{hh}`      | 2-digit hour (24h)                           | `14`                       |
| `{MM}`      | 2-digit minute                               | `30`                       |
| `{ss}`      | 2-digit second                               | `45`                       |
| `{index}`   | Image index (1-based, useful in multi-save)  | `3`                        |
| `{ext}`     | File extension                               | `jpg`                      |

> If `{ext}` is **not** included in the template, the extension is appended automatically (e.g. `2026-02-22-143045.jpg`).

## Conflict Handling

| Mode                        | Behaviour                                                                |
|-----------------------------|--------------------------------------------------------------------------|
| **Add number** (`uniquify`) | Appends `-1`, `-2`, … to the filename                                    |
| **Overwrite**               | Replaces the existing file                                               |
| **Skip**                    | Skips saving if a file with the same name was already saved this session |
| **Prompt**                  | Lets the browser/Tampermonkey ask the user                               |

## Project Structure

```
web-saver.user.js        # Main Tampermonkey userscript
tests/
  web-saver.test.js      # Unit tests (Node.js, no dependencies)
  test-page.html         # Browser integration test page
README.md                # This file
```

## Development & Testing

### Unit tests

```bash
node tests/web-saver.test.js
```

No external dependencies required — uses a built-in minimal test harness.

### Browser integration tests

1. Install the userscript in Tampermonkey.
2. Open `tests/test-page.html` in a browser.
3. Press `Ctrl+Alt+I` to verify image saving works.
4. Click **Run DOM Tests** on the page to validate image collection logic.

## Permissions

The script requests these Tampermonkey grants:

| Grant                         | Purpose                                      |
|-------------------------------|----------------------------------------------|
| `GM_setValue` / `GM_getValue` | Persist settings                             |
| `GM_download`                 | Download images with conflict handling       |
| `GM_notification`             | (reserved for future notifications)          |
| `GM_registerMenuCommand`      | Add entries to the Tampermonkey context menu |
| `GM_addStyle`                 | Inject CSS for toast & settings UI           |

## License

MIT
