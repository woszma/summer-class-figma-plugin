# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dev dependencies (TypeScript + Figma typings)
npm install

# Type-check code.js (if converted to TypeScript)
npm run build

# Watch mode for TypeScript
npm run watch
```

Note: `code.js` is plain JavaScript. The TypeScript setup is optional scaffolding for if you convert the codebase to `.ts`.

## Installing into Figma

1. Open Figma → Plugins → Development → **Import plugin from manifest**
2. Select `manifest.json` from this folder

No build step is required when editing `code.js` or `ui.html` directly — changes are picked up on next plugin run.

## Architecture

This is a two-file Figma plugin:

### `code.js` — Figma sandbox (backend)
Runs in the Figma plugin sandbox. Has access to the Figma API (`figma.*`) but **cannot use `fetch()`, `window`, or `localStorage`**. Communicates with the UI via `figma.ui.postMessage()` / `figma.ui.onmessage`.

Key responsibilities:
- Load/save config via `figma.clientStorage`
- Scan selected components for `#`-prefixed layers (`scan-component`)
- **Plan A** (`sync-cards`): Create/update CourseCard instances on the canvas, filling text layers via `setText()`, and sync nested ClassCard instances inside `ClassesContainer`
- **Plan D** (`sync-variables`): Create/update a Figma Variable Collection named `暑期班資料` with course/class data
- Nodes are tracked by `pluginData`: `notion_course_id` on course instances, `notion_class_id` on class instances

### `ui.html` — Plugin UI (frontend)
Runs in an iframe with full browser APIs including `fetch()`. All Notion API calls happen here. Communicates with `code.js` via `parent.postMessage({ pluginMessage: ... }, '*')`.

4-step wizard flow:
1. **設定** — Enter Notion token + DB IDs + optional field name overrides
2. **資料** — Fetch courses/classes from Notion, build `CourseCardData[]` in `state.courses`
3. **組件** — Select and scan CourseCard + ClassCard Figma components
4. **同步** — Trigger Plan A (direct text sync) and/or Plan D (Variables)

### Data flow
```
ui.html (fetch Notion API) → state.courses[]
  → postMessage sync-cards → code.js handleSync()
      → creates/updates Figma instances
      → postMessage sync-done → ui.html
  → postMessage sync-variables → code.js handleSyncVariables()
      → creates Figma Variables in "暑期班資料" collection
```

### Figma component requirements
- **CourseCard**: Must contain `#course-title`, `#course-category`, `#course-instructor`, `#course-dates`, `#course-description`, `#course-notes` (TEXT layers), and a frame named `ClassesContainer` (Auto Layout vertical)
- **ClassCard**: Must contain `#class-name`, `#class-id`, `#class-target`, `#class-quota`, `#class-time`, `#class-location`, `#class-fee` (TEXT layers)
- Layer naming convention: `#`-prefix identifies fillable text layers; `ClassesContainer` is the special container for nested class cards

### Variable naming (Plan D)
```
course/{courseId-last8chars}/title
course/{courseId-last8chars}/class-{code}/fee
...
```
