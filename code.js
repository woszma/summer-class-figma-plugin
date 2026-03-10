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
      case 'save-config':
        await figma.clientStorage.setAsync('plugin_config', msg.config);
        figma.ui.postMessage({ type: 'config-saved' });
        break;

      case 'scan-component':
        handleScanComponent(msg.role);
        break;

      case 'sync-cards':
        await handleSync(msg.courses, msg.config);
        break;

      case 'sync-variables':
        await handleSyncVariables(msg.courses);
        break;

      case 'rename-layer':
        handleRenameLayer(msg.nodeId, msg.newName, msg.role);
        break;

      case 'set-image':
        await handleSetImage(msg);
        break;
    }
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};

// ================================================================
// 掃描選取組件的 # 開頭圖層
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
      message: '選取的節點類型為「' + node.type + '」，請選取 COMPONENT 類型的節點'
    });
  }

  const layers = [];
  function scan(n, depth) {
    if (n.name.startsWith('#')) {
      layers.push({ id: n.id, name: n.name, type: n.type, depth });
    }
    if ('children' in n) n.children.forEach(function(c) { scan(c, depth + 1); });
  }
  scan(node, 0);

  const hasContainer = role === 'course'
    ? !!node.findOne(function(n) { return n.name === 'ClassesContainer'; })
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
// 取得組件內所有 # 開頭 TEXT 圖層的名稱
// ================================================================
function getHashLayers(comp) {
  var names = [];
  function scan(n) {
    if (n.name.startsWith('#')) names.push(n.name);
    if ('children' in n) n.children.forEach(scan);
  }
  scan(comp);
  return names;
}

// ================================================================
// 方案 A：主要同步邏輯
// 圖層命名規則：#<Notion欄位名稱>  → 自動填入對應欄位值
// ================================================================
async function handleSync(courses, config) {
  const courseComp = figma.getNodeById(config.courseComponentId);
  const classComp  = figma.getNodeById(config.classComponentId);

  if (!courseComp || courseComp.type !== 'COMPONENT')
    throw new Error('找不到課程卡組件，請重新在步驟 3 掃描');
  if (!classComp || classComp.type !== 'COMPONENT')
    throw new Error('找不到班別卡組件，請重新在步驟 3 掃描');

  // 從組件掃描 # 圖層，直接對應 Notion 欄位名稱
  const courseLayers = getHashLayers(courseComp);
  const classLayers  = getHashLayers(classComp);

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
      message: course.title || ('課程 ' + (i + 1))
    });

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

    // 圖層名 #X → boolean: show/hide；其餘: 填文字（TEXT 圖層）
    for (var li = 0; li < courseLayers.length; li++) {
      var layerName = courseLayers[li];
      var propName  = layerName.slice(1);
      var value     = course.props && course.props[propName] != null ? course.props[propName] : '';
      if (typeof value === 'boolean') {
        setVisible(inst, layerName, value);
      } else {
        await setText(inst, layerName, value);
      }
    }

    if (course.classes && course.classes.length) {
      await syncClassCards(inst, course.classes, classComp, classLayers);
    }
  }

  figma.ui.postMessage({ type: 'sync-done', created, updated });
}

// ================================================================
// 班別子卡片同步（新增 / 更新 / 刪除）
// ================================================================
async function syncClassCards(courseInst, classes, classComp, classLayers) {
  const container = courseInst.findOne(function(n) { return n.name === 'ClassesContainer'; });
  if (!container) {
    console.warn('[syncClassCards] 課程組件缺少 ClassesContainer 節點');
    return;
  }

  const existing = new Map();
  for (const child of [...container.children]) {
    const id = child.getPluginData('notion_class_id');
    if (id) existing.set(id, child);
  }

  const currentIds = new Set(classes.map(function(c) { return c.classId; }));
  for (const [id, node] of existing) {
    if (!currentIds.has(id)) {
      node.remove();
      existing.delete(id);
    }
  }

  for (const cls of classes) {
    let classInst = existing.get(cls.classId);
    if (!classInst) {
      classInst = classComp.createInstance();
      classInst.setPluginData('notion_class_id', cls.classId);
      container.appendChild(classInst);
    }

    // 圖層名 #X → boolean: show/hide；其餘: 填文字（TEXT 圖層）
    for (var li = 0; li < classLayers.length; li++) {
      var layerName = classLayers[li];
      var propName  = layerName.slice(1);
      var value     = cls.props && cls.props[propName] != null ? cls.props[propName] : '';
      if (typeof value === 'boolean') {
        setVisible(classInst, layerName, value);
      } else {
        await setText(classInst, layerName, value);
      }
    }
  }
}

// ================================================================
// 方案 D：建立 / 更新 Figma Variables
// ================================================================
async function handleSyncVariables(courses) {
  const allCollections = figma.variables.getLocalVariableCollections();
  let collection = allCollections.find(function(c) { return c.name === '暑期班資料'; });
  if (!collection) {
    collection = figma.variables.createVariableCollection('暑期班資料');
  }
  const modeId = collection.defaultModeId;

  const allLocalVars = figma.variables.getLocalVariables();
  const varCache = new Map(
    allLocalVars
      .filter(function(v) { return v.variableCollectionId === collection.id; })
      .map(function(v) { return [v.name, v]; })
  );

  function upsertVar(name, resolvedType, value) {
    let v = varCache.get(name);
    if (!v) {
      v = figma.variables.createVariable(name, collection.id, resolvedType);
      varCache.set(name, v);
    }
    const safeValue = value != null ? value : (resolvedType === 'FLOAT' ? 0 : '');
    v.setValueForMode(modeId, safeValue);
  }

  let totalVars = 0;

  for (const course of courses) {
    const p = 'course/' + course.courseId.slice(-8);
    const props = course.props || {};

    for (const propName in props) {
      const val    = props[propName];
      const numVal = parseFloat(val);
      const isNum  = val !== '' && !isNaN(numVal);
      // '/' 在 Variable 名稱中有特殊意義（分層），欄位名稱內的斜線用底線替代
      const safeKey = propName.replace(/\//g, '_');
      upsertVar(p + '/' + safeKey, isNum ? 'FLOAT' : 'STRING', isNum ? numVal : val);
      totalVars++;
    }

    for (const cls of (course.classes || [])) {
      const cp = p + '/class-' + cls.classId.slice(-4);
      const clsProps = cls.props || {};
      for (const propName in clsProps) {
        const val    = clsProps[propName];
        const numVal = parseFloat(val);
        const isNum  = val !== '' && !isNaN(numVal);
        const safeKey = propName.replace(/\//g, '_');
        upsertVar(cp + '/' + safeKey, isNum ? 'FLOAT' : 'STRING', isNum ? numVal : val);
        totalVars++;
      }
    }
  }

  figma.ui.postMessage({
    type: 'variables-done',
    totalVars,
    message: '已在「暑期班資料」集合建立/更新 ' + totalVars + ' 個變數（' + courses.length + ' 個課程）'
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

// 重命名圖層
function handleRenameLayer(nodeId, newName, role) {
  const node = figma.getNodeById(nodeId);
  if (!node) {
    figma.ui.postMessage({ type: 'error', message: '找不到圖層，請重新掃描組件' });
    return;
  }
  node.name = newName;
  figma.ui.postMessage({ type: 'layer-renamed', nodeId, newName, role });
}

// 控制任意類型圖層（Group、Frame、Component、Text...）的 show/hide
function setVisible(parent, layerName, visible) {
  const node = parent.findOne(function(n) { return n.name === layerName; });
  if (!node) return;
  node.visible = visible;
}

async function setText(parent, layerName, value) {
  const node = parent.findOne(function(n) { return n.name === layerName && n.type === 'TEXT'; });
  if (!node) return;
  try {
    await figma.loadFontAsync(node.fontName);
    node.characters = value == null ? '' : String(value);
  } catch (e) {
    console.warn('[setText] 無法更新 "' + layerName + '":', e);
  }
}

function findByPluginData(key, value) {
  return figma.currentPage.findOne(function(n) { return n.getPluginData(key) === value; });
}

function computeNextX() {
  const cards = figma.currentPage.findAll(function(n) {
    return n.getPluginData('notion_course_id') !== '' &&
      n.parent && n.parent.type === 'PAGE';
  });
  if (!cards.length) return 120;
  return Math.max.apply(null, cards.map(function(n) {
    return 'x' in n ? n.x + (n.width != null ? n.width : 0) : 0;
  })) + 48;
}
