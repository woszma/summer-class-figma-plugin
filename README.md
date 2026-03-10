# 暑期班課程卡生成器 — Figma Plugin

從 Notion「暑期班(課程及班別)」資料庫自動生成並同步 Figma 課程卡版面。

## 實作方案

| 方案 | 說明 |
|------|------|
| **A（預設啟用）** | 直接呼叫 Notion API，將資料填入 Figma Instance 的文字圖層 |
| **D（可選）** | 同時在 Figma 建立「暑期班資料」Variable Collection，供設計師做變數綁定 |

---

## 快速開始

### 1. 在 Figma 建立組件

在 Figma 畫布中建立兩個 Component：

#### CourseCard（課程主卡）
Auto Layout（垂直）的 Frame，內含：
- `#course-title` (Text) — 課程名稱
- `#course-category` (Text) — 類別
- `#course-instructor` (Text) — 導師
- `#course-dates` (Text) — 上課日期
- `#course-description` (Text) — 課程描述
- `#course-notes` (Text) — 備註
- `ClassesContainer` (Frame, Auto Layout 垂直) — **班別卡放置容器**

#### ClassCard（班別子卡）
Auto Layout（垂直）的 Frame，內含：
- `#class-name` (Text) — 班別名稱（C班、D班）
- `#class-id` (Text) — 編號
- `#class-target` (Text) — 對象
- `#class-quota` (Text) — 名額
- `#class-time` (Text) — 時間
- `#class-location` (Text) — 地點
- `#class-fee` (Text) — 費用

> 重要：ClassesContainer 設為 Auto Layout（垂直），班別卡數量不同時會自動撐開高度。

### 2. 在 Notion 設定 Integration

1. 前往 [notion.so/my-integrations](https://www.notion.so/my-integrations) 建立 Integration
2. 複製 Token（以 `secret_` 或 `ntn_` 開頭）
3. 在 Notion 資料庫設定頁面，將 Integration 加入「連結」

### 3. 安裝插件到 Figma

1. 在 Figma 選單：Plugins → Development → Import plugin from manifest
2. 選取本資料夾中的 `manifest.json`

### 4. 使用插件

1. **步驟① 設定**：輸入 Notion Token + 兩個資料庫 ID
2. **步驟② 資料**：點「獲取課程資料」，確認資料正確
3. **步驟③ 組件**：分別選取 CourseCard 和 ClassCard 組件後讀取
4. **步驟④ 同步**：選擇方案（A / D / 兩者），點「開始同步」

---

## Notion 資料庫欄位預設名稱

### 課程資料庫
| 欄位 | 預設 Notion 屬性名 | 類型 |
|------|-------------------|------|
| 課程名稱 | `課程名稱` (或 Title) | Title |
| 類別 | `類別` | Select |
| 導師 | `導師` | Rich Text |
| 上課日期 | `上課日期` | Rich Text / Multi-select |
| 課程描述 | `課程描述` | Rich Text |
| 備註 | `備註` | Rich Text |
| 班別關聯 | `相關班別` | Relation |

### 班別資料庫
| 欄位 | 預設 Notion 屬性名 | 類型 |
|------|-------------------|------|
| 班別名稱 | `班別名稱` (或 Title) | Title |
| 編號 | `編號` | Number / Text |
| 對象 | `對象` | Rich Text |
| 名額 | `名額` | Number |
| 時間 | `時間` | Rich Text |
| 地點 | `地點` | Select / Text |
| 費用 | `費用` | Number |
| 材料費 | `材料費` | Number |
| 所屬課程 | `所屬課程` | Relation |

如名稱不同，可在插件步驟①「進階設定」中修改。

---

## 方案 D：Figma Variables 使用方式

同步完成後，打開 Figma 的 **Variables** 面板，會見到「暑期班資料」集合，
包含結構如：
```
course/{courseId-尾8碼}/title
course/{courseId-尾8碼}/category
course/{courseId-尾8碼}/class-3090/fee
...
```

在 Figma 中，選取文字節點 → Edit Variable Binding → 選取對應變數，
日後只需重新執行插件的「方案 D」，所有綁定的節點就會自動更新。

---

## 檔案結構

```
summer-class-figma-plugin/
├── manifest.json   # 插件宣告
├── code.js         # Figma 沙盒後端（操作畫布）
├── ui.html         # 插件 UI（Notion API 呼叫在此）
├── package.json    # 開發依賴（TypeScript 可選）
└── README.md
```
