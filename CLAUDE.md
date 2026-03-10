# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install       # Install dev dependencies (TypeScript + Figma typings)
npm run build     # Type-check code.js (tsc --noEmit)
npm run watch     # Watch mode for TypeScript
```

`code.js` is plain JavaScript — no build step required. Edit `code.js` or `ui.html` directly and reload the plugin in Figma to pick up changes.

## Installing into Figma

Plugins → Development → Import plugin from manifest → select `manifest.json`.

## Architecture

Two-file Figma plugin with postMessage IPC between a sandbox backend and an iframe UI:

```
ui.html  ──postMessage──▶  code.js
(fetch, browser APIs)      (figma.* API, no fetch)
```

### `code.js` — Figma sandbox

Handles all canvas operations. Cannot use `fetch()`, `window`, or `localStorage`.

| Message received | Handler | What it does |
|---|---|---|
| `save-config` | — | Persist config to `figma.clientStorage` |
| `scan-component` | `handleScanComponent(role)` | Recursively find `#`-prefixed TEXT layers in selected component |
| `sync-cards` | `handleSync()` | **Plan A** — create/update CourseCard instances; fill text via `setText()`; sync nested ClassCards |
| `sync-variables` | `handleSyncVariables()` | **Plan D** — upsert Figma Variable Collection `暑期班資料` |

Instance identity is tracked via `pluginData`: `notion_course_id` on CourseCard instances, `notion_class_id` on ClassCard instances (enables idempotent re-sync).

### `ui.html` — Plugin UI

Runs in iframe. All Notion API calls happen here. Posts `pluginMessage` objects to `code.js`; listens for replies in `window.onmessage`.

**4-step wizard state machine** (global `state` object):
1. **設定** — Collect Notion token, DB IDs, optional field name overrides → post `save-config`
2. **資料** — `fetchNotionData()` → paginated Notion queries → build `state.courses: CourseCardData[]`
3. **組件** — Select component on canvas → post `scan-component` → display scanned `#` layers
4. **同步** — Post `sync-cards` (Plan A), then on `sync-done` post `sync-variables` (Plan D) if enabled

### Data structures

```js
// CourseCardData
{ courseId, title, category, instructor, dates, description, notes, classes: ClassData[] }

// ClassData
{ classId, name, code, target, quota, time, location, fee, materialFee }

// Config (persisted to figma.clientStorage)
{
  token, coursesDb, classesDb,
  fields: {
    course: { title, category, instructor, dates, desc, notes, relation },
    cls:    { name, code, target, quota, time, location, fee, material, relation }
  }
}
```

### Figma component requirements

Layers prefixed with `#` are the fillable text nodes scanned by the plugin.

**CourseCard** must contain:
- TEXT layers: `#course-title`, `#course-category`, `#course-instructor`, `#course-dates`, `#course-description`, `#course-notes`
- Frame: `ClassesContainer` (Auto Layout vertical) — holds nested ClassCard instances

**ClassCard** must contain:
- TEXT layers: `#class-name`, `#class-id`, `#class-target`, `#class-quota`, `#class-time`, `#class-location`, `#class-fee`

### Notion API

- Endpoint: `POST https://api.notion.com/v1/databases/{id}/query`
- Pagination: 100 results/page via `start_cursor` / `has_more`
- Headers: `Authorization: Bearer {token}`, `Notion-Version: 2022-06-28`
- Token must start with `secret_` or `ntn_`
- Default Notion property names (overridable in Step 1): `課程名稱`, `類別`, `導師`, `上課日期`, `課程描述`, `備註`, `相關班別`, `班別名稱`, `編號`, `對象`, `名額`, `時間`, `地點`, `費用`, `材料費`, `所屬課程`

### Plan D variable naming

```
course/{courseId-last8chars}/title
course/{courseId-last8chars}/category
course/{courseId-last8chars}/class-{code}/fee
```
STRING type for text fields, FLOAT for numbers.
