// ================================================================
// 暑期班課程卡生成器 — code.js  (Figma 沙盒後端)
// 注意：此環境不能使用 fetch()、window、localStorage
// 所有網路請求必須由 ui.html 發出，再透過 postMessage 傳回
// ================================================================

figma.showUI(__html__, { width: 440, height: 620, title: '暑期班課程卡生成器' });

// ── 初始化：載入 clientStorage 已儲存的設定、Notion 快取及組件快取 ──
(async () => {
  const config      = (await figma.clientStorage.getAsync('plugin_config'))    || {};
  const notionCache = (await figma.clientStorage.getAsync('notion_data_cache')) || null;
  const compCache   = (await figma.clientStorage.getAsync('comp_data_cache'))   || null;
  figma.ui.postMessage({ type: 'saved-config', config, notionCache, compCache });
})();

// ── 停止同步旗標 ─────────────────────────────────────────────
let _stopSync = false;

// ── 主訊息處理器 ─────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  try {
    switch (msg.type) {
      case 'save-config':
        await figma.clientStorage.setAsync('plugin_config', msg.config);
        figma.ui.postMessage({ type: 'config-saved' });
        break;

      case 'save-notion-data':
        await figma.clientStorage.setAsync('notion_data_cache', {
          courses: msg.courses,
          savedAt: msg.savedAt,
        });
        break;

      case 'clear-notion-data':
        await figma.clientStorage.deleteAsync('notion_data_cache');
        break;

      case 'save-comp-data':
        await figma.clientStorage.setAsync('comp_data_cache', msg.data);
        break;

      case 'scan-component':
        handleScanComponent(msg.role);
        break;

      case 'stop-sync':
        _stopSync = true;
        break;

      case 'sync-cards':
        _stopSync = false;
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
  let node = sel[0];

  // 若選取的係子節點（如 TEXT），向上尋找最近的 COMPONENT / INSTANCE / FRAME
  if (node.type !== 'COMPONENT' && node.type !== 'INSTANCE' && node.type !== 'COMPONENT_SET' && node.type !== 'FRAME') {
    let parent = node.parent;
    while (parent && parent.type !== 'PAGE') {
      if (parent.type === 'COMPONENT' || parent.type === 'INSTANCE' || parent.type === 'COMPONENT_SET' || parent.type === 'FRAME') {
        node = parent;
        break;
      }
      parent = parent.parent;
    }
  }

  // 若選取的係 Instance，自動切換到 main component
  if (node.type === 'INSTANCE') {
    const main = node.mainComponent;
    if (!main) {
      return figma.ui.postMessage({
        type: 'error',
        message: '無法取得此 Instance 的 Main Component，請直接選取 COMPONENT 節點'
      });
    }
    node = main;
  }

  // COMPONENT_SET：取第一個子 COMPONENT（variant）
  if (node.type === 'COMPONENT_SET') {
    const first = node.children.find(function(c) { return c.type === 'COMPONENT'; });
    if (first) node = first;
  }

  // 接受 COMPONENT 或 FRAME（例如已 detach 的 frame 亦可掃描）
  if (node.type !== 'COMPONENT' && node.type !== 'FRAME') {
    return figma.ui.postMessage({
      type: 'error',
      message: '請選取 Component 或其 Instance（目前選取：' + node.type + '）'
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
  const CARD_GAP    = 48;
  const ROW_GAP     = 200;
  const PLACEMENT_Y = 200;

  // ── 判斷是否啟用按星期分行排列（排序已在 ui.html 完成）────
  var hasWeekGroups = courses.some(function(c) { return !!c._weekGroup; });

  var startX    = 120;
  var nextX     = hasWeekGroups ? startX : computeNextX();
  var currentY  = PLACEMENT_Y;
  var curWeek   = null;
  var rowHeight = 0;

  for (let i = 0; i < courses.length; i++) {
    if (_stopSync) {
      figma.ui.postMessage({ type: 'sync-stopped', created, updated });
      return;
    }
    const course = courses[i];

    figma.ui.postMessage({
      type: 'sync-progress',
      current: i + 1,
      total: courses.length,
      message: course.title || ('課程 ' + (i + 1))
    });

    // ── 按星期換行：遇到新星期就另起一行 ──────────────────
    if (hasWeekGroups && course._weekGroup !== curWeek) {
      if (curWeek !== null) {
        currentY += rowHeight + ROW_GAP;
        rowHeight = 0;
      }
      curWeek = course._weekGroup;
      nextX = startX;
    }

    // 保留 instance（不 detach），讓用戶可整體編輯 master component
    const existing = findByPluginData('notion_course_id', course.courseId);
    var inst;
    if (existing) {
      // 原地更新：保留 instance，只更新 overrides
      inst = existing;
      updated++;
      if (hasWeekGroups) {
        inst.x = nextX;
        inst.y = currentY;
      }
    } else {
      // 新建 instance（不 detach）
      inst = courseComp.createInstance();
      inst.setPluginData('notion_course_id', course.courseId);
      if (hasWeekGroups) {
        inst.x = nextX;
        inst.y = currentY;
      } else {
        inst.x = nextX;
        inst.y = PLACEMENT_Y;
      }
      figma.currentPage.appendChild(inst);
      created++;
    }

    // 更新下一張卡的 X 及目前行高
    if (hasWeekGroups) {
      nextX += inst.width + CARD_GAP;
      if (inst.height > rowHeight) rowHeight = inst.height;
    } else if (!existing) {
      nextX += inst.width + CARD_GAP;
    }

    // 圖層名 #X → boolean: show/hide；其餘: 填文字（TEXT 圖層）
    for (var li = 0; li < courseLayers.length; li++) {
      var layerName = courseLayers[li];
      var propName  = layerName.slice(1);
      var value     = course.props && course.props[propName] != null ? course.props[propName] : '';
      var boolVal   = toBooleanIfBool(value);
      if (boolVal !== null) {
        // Boolean 欄位：直接 show/hide
        setVisible(inst, layerName, boolVal);
      } else {
        await setText(inst, layerName, value);
        // 非 TEXT 圖層（Frame/Group）：有值則顯示，無值則隱藏
        var txtNode = inst.findOne(function(n) { return n.name === layerName && n.type === 'TEXT'; });
        if (!txtNode) setVisible(inst, layerName, !!value);
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
  // workContainer 預設直接用 container；若 appendChild 失敗（instance 內部限制），才 detach
  var workContainer = container;
  var workInst = courseInst;

  const existing = new Map();
  for (const child of [...workContainer.children]) {
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
      try {
        workContainer.appendChild(classInst);
      } catch (e) {
        // instance 內部不可直接 appendChild，先 detach courseInst
        if (workInst.type === 'INSTANCE') {
          console.warn('[syncClassCards] instance 限制，改為 detach：', e.message);
          const savedId = workInst.getPluginData('notion_course_id'); // 先儲存，detach 後舊 ref 失效
          const detached = workInst.detachInstance();
          detached.setPluginData('notion_course_id', savedId);
          workInst = detached;
          workContainer = detached.findOne(function(n) { return n.name === 'ClassesContainer'; });
          if (!workContainer) { console.warn('[syncClassCards] ClassesContainer 消失'); return; }
          workContainer.appendChild(classInst);
        } else {
          console.warn('[syncClassCards] 無法 appendChild：', e.message);
        }
      }
    }

    // 圖層名 #X → boolean: show/hide；其餘: 填文字（TEXT 圖層）
    for (var li = 0; li < classLayers.length; li++) {
      var layerName = classLayers[li];
      var propName  = layerName.slice(1);
      var value     = cls.props && cls.props[propName] != null ? cls.props[propName] : '';
      var boolVal   = toBooleanIfBool(value);
      if (boolVal !== null) {
        setVisible(classInst, layerName, boolVal);
      } else {
        await setText(classInst, layerName, value);
        // 非 TEXT 圖層（Frame/Group）：有值則顯示，無值則隱藏
        var txtNode = classInst.findOne(function(n) { return n.name === layerName && n.type === 'TEXT'; });
        if (!txtNode) setVisible(classInst, layerName, !!value);
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
    if (v && v.resolvedType !== resolvedType) {
      // 類型不符，刪除舊變數再重建
      v.remove();
      varCache.delete(name);
      v = null;
    }
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
      const raw     = props[propName];
      const boolVal = toBooleanIfBool(raw);
      // boolean → STRING "是"/"否"
      const val     = boolVal !== null ? (boolVal ? '是' : '否') : raw;
      const numVal  = parseFloat(val);
      const isNum   = val !== '' && !isNaN(numVal);
      const safeKey = propName.replace(/\//g, '_');
      upsertVar(p + '/' + safeKey, isNum ? 'FLOAT' : 'STRING', isNum ? numVal : val);
      totalVars++;
    }

    for (const cls of (course.classes || [])) {
      const cp = p + '/class-' + cls.classId.slice(-4);
      const clsProps = cls.props || {};
      for (const propName in clsProps) {
        const raw     = clsProps[propName];
        const boolVal = toBooleanIfBool(raw);
        const val     = boolVal !== null ? (boolVal ? '是' : '否') : raw;
        const numVal  = parseFloat(val);
        const isNum   = val !== '' && !isNaN(numVal);
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

// 判斷值是否 boolean（包括字串 "true"/"false"），是則回傳 boolean，否則回傳 null
function toBooleanIfBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true')  return true;
  if (value === 'false') return false;
  return null;
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
