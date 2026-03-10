// ================================================================
// 暑期班課程卡生成器 — code.js  (Figma 沙盒後端)
// 注意：此環境不能使用 fetch()、window、localStorage
// 所有網路請求必須由 ui.html 發出，再透過 postMessage 傳回
// ================================================================

figma.showUI(__html__, { width: 440, height: 620, title: '暑期班課程卡生成器' });

// ── 初始化：載入 clientStorage 已儲存的設定 ──────────────────
(async () => {
  const config = (await figma.clientStorage.getAsync('plugin_config')) || {};
  figma.ui.postMessage({ type: 'saved-config', config });
})();

// ── 主訊息處理器 ─────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  try {
    switch (msg.type) {

      // ── 儲存設定 ──
      case 'save-config':
        await figma.clientStorage.setAsync('plugin_config', msg.config);
        figma.ui.postMessage({ type: 'config-saved' });
        break;

      // ── 掃描選取的 Figma 組件圖層 ──
      case 'scan-component':
        handleScanComponent(msg.role);
        break;

      // ── 方案 A：直接同步文字到 Figma 畫布 ──
      case 'sync-cards':
        await handleSync(msg.courses, msg.config);
        break;

      // ── 方案 D：建立 / 更新 Figma Variables ──
      case 'sync-variables':
        await handleSyncVariables(msg.courses);
        break;

      // ── 設定圖片（預留擴充）──
      case 'set-image':
        await handleSetImage(msg);
        break;
    }
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};

// ================================================================
// 掃描選取組件的 # 開頭圖層
// role: 'course' | 'class'
// ================================================================
function handleScanComponent(role) {
  const sel = figma.currentPage.selection;
  if (!sel.length) {
    return figma.ui.postMessage({
      type: 'error',
      message: '請先在 Figma 畫布上選取一個 Component（組件）'
    });
  }
  const node = sel[0];
  if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') {
    return figma.ui.postMessage({
      type: 'error',
      message: `選取的節點類型為「${node.type}」，請選取 COMPONENT 類型的節點`
    });
  }

  // 遞迴找出所有以 # 開頭的圖層
  const layers = [];
  function scan(n, depth) {
    if (n.name.startsWith('#')) {
      layers.push({ id: n.id, name: n.name, type: n.type, depth });
    }
    if ('children' in n) n.children.forEach(c => scan(c, depth + 1));
  }
  scan(node, 0);

  // 同時確認 ClassesContainer 是否存在（課程卡需要）
  const hasContainer = role === 'course'
    ? !!node.findOne(n => n.name === 'ClassesContainer')
    : true;

  figma.ui.postMessage({
    type: 'component-scanned',
    role,
    componentId: node.id,
    componentName: node.name,
    layers,
    hasContainer
  });
}

// ================================================================
// 方案 A：主要同步邏輯
// ================================================================
async function handleSync(courses, config) {
  const { courseComponentId, classComponentId } = config;

  const courseComp = figma.getNodeById(courseComponentId);
  const classComp  = figma.getNodeById(classComponentId);

  if (!courseComp || courseComp.type !== 'COMPONENT')
    throw new Error('找不到課程卡組件，請重新在步驟 3 掃描');
  if (!classComp || classComp.type !== 'COMPONENT')
    throw new Error('找不到班別卡組件，請重新在步驟 3 掃描');

  let created = 0, updated = 0;
  let nextX = computeNextX();
  const PLACEMENT_Y = 200;
  const CARD_GAP = 48;

  for (let i = 0; i < courses.length; i++) {
    const course = courses[i];

    figma.ui.postMessage({
      type: 'sync-progress',
      current: i + 1,
      total: courses.length,
      message: course.title || `課程 ${i + 1}`
    });

    // 查找或建立課程卡 Instance
    let inst = findByPluginData('notion_course_id', course.courseId);

    if (inst) {
      updated++;
    } else {
      inst = courseComp.createInstance();
      inst.setPluginData('notion_course_id', course.courseId);
      inst.x = nextX;
      inst.y = PLACEMENT_Y;
      figma.currentPage.appendChild(inst);
      nextX += inst.width + CARD_GAP;
      created++;
    }

    // 填入課程標頭欄位
    await setText(inst, '#course-title',       course.title);
    await setText(inst, '#course-category',    course.category);
    await setText(inst, '#course-instructor',  course.instructor);
    await setText(inst, '#course-dates',       course.dates);
    await setText(inst, '#course-description', course.description);
    await setText(inst, '#course-notes',       course.notes);

    // 同步班別子卡片
    if (course.classes?.length) {
      await syncClassCards(inst, course.classes, classComp);
    }
  }

  figma.ui.postMessage({ type: 'sync-done', created, updated });
}

// ================================================================
// 班別子卡片同步（新增 / 更新 / 刪除）
// ================================================================
async function syncClassCards(courseInst, classes, classComp) {
  // 在課程 Instance 中尋找 ClassesContainer
  const container = courseInst.findOne(n => n.name === 'ClassesContainer');
  if (!container) {
    console.warn('[syncClassCards] 課程組件缺少 ClassesContainer 節點');
    return;
  }

  // 建立現有班別子卡的 Map
  const existing = new Map();
  for (const child of [...container.children]) {
    const id = child.getPluginData('notion_class_id');
    if (id) existing.set(id, child);
  }

  // 刪除 Notion 中已移除的班別
  const currentIds = new Set(classes.map(c => c.classId));
  for (const [id, node] of existing) {
    if (!currentIds.has(id)) {
      node.remove();
      existing.delete(id);
    }
  }

  // 新增或更新班別卡（依 Notion 順序）
  for (const cls of classes) {
    let classInst = existing.get(cls.classId);
    if (!classInst) {
      classInst = classComp.createInstance();
      classInst.setPluginData('notion_class_id', cls.classId);
      container.appendChild(classInst);
    }

    const feeText = cls.materialFee
      ? `$${cls.fee ?? ''}（包$${cls.materialFee}材料費）`
      : `$${cls.fee ?? ''}`;

    await setText(classInst, '#class-name',     cls.name);
    await setText(classInst, '#class-id',       String(cls.code ?? ''));
    await setText(classInst, '#class-target',   cls.target);
    await setText(classInst, '#class-quota',    cls.quota ? `${cls.quota}人` : '');
    await setText(classInst, '#class-time',     cls.time);
    await setText(classInst, '#class-location', cls.location);
    await setText(classInst, '#class-fee',      feeText);
  }
}

// ================================================================
// 方案 D：建立 / 更新 Figma Variables
// 在「暑期班資料」Variable Collection 中為每個欄位建立變數
// 設計師可在 Figma 中將文字節點綁定到這些變數，
// 日後只需更新變數值即可全域刷新版面
// ================================================================
async function handleSyncVariables(courses) {
  // 取得或建立 Variable Collection
  const allCollections = figma.variables.getLocalVariableCollections();
  let collection = allCollections.find(c => c.name === '暑期班資料');
  if (!collection) {
    collection = figma.variables.createVariableCollection('暑期班資料');
  }
  const modeId = collection.defaultModeId;

  // 建立現有 variables 的快取 Map
  const allLocalVars = figma.variables.getLocalVariables();
  const varCache = new Map(
    allLocalVars
      .filter(v => v.variableCollectionId === collection.id)
      .map(v => [v.name, v])
  );

  function upsertVar(name, resolvedType, value) {
    let v = varCache.get(name);
    if (!v) {
      v = figma.variables.createVariable(name, collection.id, resolvedType);
      varCache.set(name, v);
    }
    const safeValue = value ?? (resolvedType === 'FLOAT' ? 0 : '');
    v.setValueForMode(modeId, safeValue);
    return v;
  }

  let totalVars = 0;

  for (const course of courses) {
    // 用 courseId 尾 8 碼避免名稱過長
    const p = `course/${course.courseId.slice(-8)}`;

    upsertVar(`${p}/title`,       'STRING', course.title);
    upsertVar(`${p}/category`,    'STRING', course.category);
    upsertVar(`${p}/instructor`,  'STRING', course.instructor);
    upsertVar(`${p}/dates`,       'STRING', course.dates);
    upsertVar(`${p}/description`, 'STRING', course.description);
    upsertVar(`${p}/notes`,       'STRING', course.notes);
    totalVars += 6;

    for (const cls of course.classes ?? []) {
      const cp = `${p}/class-${cls.code || cls.classId.slice(-4)}`;
      upsertVar(`${cp}/name`,        'STRING', cls.name);
      upsertVar(`${cp}/code`,        'STRING', String(cls.code ?? ''));
      upsertVar(`${cp}/target`,      'STRING', cls.target);
      upsertVar(`${cp}/quota`,       'FLOAT',  Number(cls.quota) || 0);
      upsertVar(`${cp}/time`,        'STRING', cls.time);
      upsertVar(`${cp}/location`,    'STRING', cls.location);
      upsertVar(`${cp}/fee`,         'FLOAT',  Number(cls.fee) || 0);
      upsertVar(`${cp}/materialFee`, 'FLOAT',  Number(cls.materialFee) || 0);
      totalVars += 8;
    }
  }

  figma.ui.postMessage({
    type: 'variables-done',
    totalVars,
    message: `已在「暑期班資料」集合建立/更新 ${totalVars} 個變數（${courses.length} 個課程）`
  });
}

// ================================================================
// 設定圖片填充（預留）
// ================================================================
async function handleSetImage(msg) {
  const node = figma.getNodeById(msg.nodeId);
  if (!node || !('fills' in node)) return;
  const imgHash = figma.createImage(new Uint8Array(msg.imageData)).hash;
  node.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: imgHash }];
  figma.ui.postMessage({ type: 'image-set', nodeId: msg.nodeId });
}

// ================================================================
// 工具函式
// ================================================================

// 安全更新文字節點（自動載入字型）
async function setText(parent, layerName, value) {
  const node = parent.findOne(n => n.name === layerName && n.type === 'TEXT');
  if (!node) return;
  try {
    await figma.loadFontAsync(node.fontName);
    node.characters = value == null ? '' : String(value);
  } catch (e) {
    console.warn(`[setText] 無法更新 "${layerName}":`, e);
  }
}

// 在整個頁面中以 pluginData 查找節點
function findByPluginData(key, value) {
  return figma.currentPage.findOne(n => n.getPluginData(key) === value);
}

// 計算新課程卡的初始放置 X 座標（放在最右側現有卡片右邊）
function computeNextX() {
  const cards = figma.currentPage.findAll(n =>
    n.getPluginData('notion_course_id') !== '' &&
    n.parent?.type === 'PAGE'
  );
  if (!cards.length) return 120;
  return Math.max(...cards.map(n => ('x' in n ? n.x + (n.width ?? 0) : 0))) + 48;
}
