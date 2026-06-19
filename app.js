/* ==========================================================
   JSON 阅读器 — 核心逻辑
   纯前端 SPA · Hash 路由 · localStorage 持久化 · 零依赖
   ========================================================== */

// ============================================================
// 状态
// ============================================================
const state = {
  items: [],      // 解析后的条目列表
  fileName: '',   // 当前文件名
  sortOrder: 'asc', // 'asc' | 'desc'
  fontSize: 'medium', // 'small' | 'medium' | 'large' | 'xlarge'
  filterMode: 'all', // 'all' | 'ph'
  highlights: [],    // [{ itemIdx, source, start, end, color }]
};

// 记录列表滚动位置，返回时恢复
let listScrollPos = null;

// 当前详情页上下文（荧光笔用）
let detailCtx = { idx: -1 };

// ============================================================
// DOM 快捷引用
// ============================================================
const $ = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

const dom = {
  fileInput:      $('#file-input'),
  importBtn:      $('#import-btn'),
  reimportBtn:    $('#reimport-btn'),
  clearBtn:       $('#clear-btn'),
  backBtn:        $('#back-btn'),
  menuBtn:        $('#menu-btn'),
  themeBtn:       $('#theme-btn'),
  navTitle:       $('#nav-title'),
  toast:          $('#toast'),
  listWrap:       $('#list-wrap'),
  listCount:      $('#list-count'),
  detailWrap:     $('#detail-wrap'),
  modalOverlay:   $('#modal-overlay'),
  modalBody:      $('#modal-body'),
  settingsOverlay:$('#settings-overlay'),
  settingsBody:   $('#settings-body'),
  scrollTopBtn:   $('#scroll-top-btn'),
  backupInput:    $('#backup-input'),
  hlBtn:          $('#hl-float-btn'),
};

// ============================================================
// 持久化存储（IndexedDB + localStorage 双方案）
// ============================================================

// IndexedDB 连接（模块级单例）
let _idb = null;
function getIDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('jsonReader', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) {
        // 简单的键值对存储，不用 keyPath
        db.createObjectStore('kv');
      }
    };
    req.onsuccess = (e) => { _idb = e.target.result; resolve(_idb); };
    req.onerror   = () => { _idb = null; reject(req.error); };
  });
}

const Storage = {
  KEY: 'main',

  // ── gzip 压缩/解压 ──
  async _compress(str) {
    const bytes   = new TextEncoder().encode(str);
    const cs      = new CompressionStream('gzip');
    const writer  = cs.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const blob  = await new Response(cs.readable).blob();
    const buf   = await blob.arrayBuffer();
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  },
  async _decompress(base64) {
    const bytes  = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const ds     = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const blob = await new Response(ds.readable).blob();
    return await blob.text();
  },

  async _idbPut(key, value) {
    const db = await getIDB();
    await new Promise((resolve, reject) => {
      const tx  = db.transaction('kv', 'readwrite');
      const req = tx.objectStore('kv').put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },
  async _idbGet(key) {
    const db = await getIDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.value ?? null);
      req.onerror   = () => reject(req.error);
    });
  },
  async _idbDel(key) {
    const db = await getIDB();
    await new Promise((resolve, reject) => {
      const tx  = db.transaction('kv', 'readwrite');
      const req = tx.objectStore('kv').delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  },

  // ── 保存 ──
  async save(data) {
    const raw = JSON.stringify(data);

    // 1. 普通 localStorage
    try {
      localStorage.setItem('jsonReaderData', raw);
      localStorage.removeItem('jsonReaderData_c');
      localStorage.removeItem('jsonReader_storageType');
      console.log(`[存储] ✅ localStorage: ${data.items?.length || 0} 条`);
      return;
    } catch (e) {
      if (e.name !== 'QuotaExceededError') throw e;
    }

    // 2. 压缩后 localStorage
    try {
      const compressed = await this._compress(raw);
      localStorage.setItem('jsonReaderData_c', compressed);
      localStorage.removeItem('jsonReaderData');
      localStorage.removeItem('jsonReader_storageType');
      const orig = (raw.length / 1024).toFixed(1);
      const comp = (compressed.length / 1024).toFixed(1);
      console.log(`[存储] ✅ 压缩 localStorage: ${orig}KB → ${comp}KB`);
      return;
    } catch (e) {
      if (e.name !== 'QuotaExceededError') throw e;
      console.log('[存储] 压缩后仍超出，回退 IndexedDB');
    }

    // 3. IndexedDB（兜底）
    localStorage.setItem('jsonReader_storageType', 'idb');
    await this._idbPut(this.KEY, data);
    console.log(`[存储] ✅ IndexedDB: ${data.items?.length || 0} 条`);
  },

  // ── 加载 ──
  async load() {
    const type = localStorage.getItem('jsonReader_storageType');

    // IndexedDB 模式
    if (type === 'idb') {
      const data = await this._idbGet(this.KEY);
      if (data) { console.log(`[存储] IndexedDB 加载: ${data.items?.length || 0} 条`); return data; }
      // IndexedDB 读不到 → 可能是被清理了，检查 localStorage 有无残留
      console.log('[存储] IndexedDB 无数据，检查 localStorage 残留…');
    }

    // 普通 localStorage
    const raw = localStorage.getItem('jsonReaderData');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        console.log(`[存储] localStorage 加载: ${data.items?.length || 0} 条`);
        return data;
      } catch (e) { console.warn('[存储] localStorage 解析失败'); }
    }

    // 压缩 localStorage
    const comp = localStorage.getItem('jsonReaderData_c');
    if (comp) {
      try {
        const text = await this._decompress(comp);
        const data = JSON.parse(text);
        console.log(`[存储] 压缩数据加载: ${data.items?.length || 0} 条`);
        return data;
      } catch (e) { console.warn('[存储] 压缩数据解析失败'); }
    }

    // 最后再试一次 IndexedDB（前面 type 不匹配的情况）
    if (type !== 'idb') {
      const data = await this._idbGet(this.KEY);
      if (data) { console.log(`[存储] IndexedDB 加载: ${data.items?.length || 0} 条`); return data; }
    }

    console.log('[存储] 无数据');
    return null;
  },

  async clear() {
    localStorage.removeItem('jsonReaderData');
    localStorage.removeItem('jsonReaderData_c');
    localStorage.removeItem('jsonReader_storageType');
    try { await this._idbDel(this.KEY); } catch (_) {}
    console.log('[存储] 已清空');
  },
};

// ============================================================
// 存储连通性测试（诊断用）
// ============================================================
async function testStorage() {
  try {
    const testVal = { items: [{ bookmark: null, userContent: '诊断测试', assistantContent: 'ok' }], fileName: 'test.json' };
    await Storage.save(testVal);
    const loaded = await Storage.load();
    if (loaded && loaded.items && loaded.items[0].userContent === '诊断测试') {
      showToast('✅ 存储正常');
      await Storage.clear();
      console.log('[存储] 诊断测试通过');
      return true;
    } else {
      showToast('❌ 存储异常，连电脑看 Console');
      console.error('[存储] 诊断失败: 读出:', loaded);
      return false;
    }
  } catch (err) {
    showToast('❌ 存储错误: ' + err.message);
    console.error('[存储] 诊断异常:', err);
    return false;
  }
}

// ============================================================
// 状态持久化辅助
// ============================================================
async function saveState() {
  await Storage.save({
    items: state.items,
    fileName: state.fileName,
    sortOrder: state.sortOrder,
    fontSize: state.fontSize,
    filterMode: state.filterMode,
    highlights: state.highlights,
  });
}

async function clearState() {
  state.items    = [];
  state.fileName = '';
  state.sortOrder = 'asc';
  state.fontSize  = 'medium';
  state.filterMode = 'all';
  state.highlights = [];
  await Storage.clear();
}

// ============================================================
// 解析器：chatData.history → items[]
// 支持普通配对、连续 AI 消息（Case 2）、ph 标注（Case 3）
// ============================================================
function parseChatJSON(json) {
  const items = [];
  const history = json?.chatData?.history;
  if (!Array.isArray(history)) return items;

  for (const entry of history) {
    const sharedHistory = entry?.payload?.sharedHistory;
    if (!Array.isArray(sharedHistory) || sharedHistory.length === 0) continue;

    // ── Case 3：检测 ph 标注（最后一条是 user content "ph"）──
    const last = sharedHistory[sharedHistory.length - 1];
    const hasPHMarker = last?.role === 'user' && last?.content === 'ph';

    // 剔除 ph 标注消息
    const messages = hasPHMarker ? sharedHistory.slice(0, -1) : sharedHistory;

    // 找 user 和所有 assistant 消息
    const userMsg  = messages.find(m => m.role === 'user');
    const asstMsgs = messages.filter(m => m.role === 'assistant');
    if (!userMsg && asstMsgs.length === 0) continue;

    // ── 书签提取（user 消息的第一个 \n）──
    const raw = userMsg?.content || '';
    let bookmark = null;
    let body = raw;
    const nl = raw.indexOf('\n');
    if (nl !== -1) {
      const before = raw.substring(0, nl).trim();
      if (before) bookmark = before;
      body = raw.substring(nl + 1).trim();
    }

    const hasMultiple = asstMsgs.length > 1;

    items.push({
      bookmark,
      userContent:           nl === -1 ? raw : body,
      assistantContent:      hasMultiple ? asstMsgs.map(m => m.content || '') : (asstMsgs[0]?.content || '[无内容]'),
      assistantList:         asstMsgs.map(m => m.content || ''),
      hasMultipleAssistant:  hasMultiple,
      timestamp:             entry.timestamp || null,
      hasPHMarker,
    });
  }
  return items;
}

// ============================================================
// 文件处理（含覆盖 / 追加逻辑）
// ============================================================
function handleFile(file) {
  const reader = new FileReader();

  reader.onload = async (e) => {
    try {
      const json  = JSON.parse(e.target.result);
      const items = parseChatJSON(json);
      if (items.length === 0) {
        showToast('未找到聊天记录，请检查 JSON 格式');
        return;
      }

      // ── 已有数据 → 询问覆盖还是追加 ──
      if (state.items.length > 0) {
        const action = await showImportOptions(state.items.length);
        if (action === 'cancel') return;

        if (action === 'overwrite') {
          state.items    = items;
          state.fileName = file.name;
        } else { // append
          state.items = [...state.items, ...items];
          // fileName 保留原样，不改
        }
      } else {
        // ── 首次导入 ──
        state.items    = items;
        state.fileName = file.name;
      }

      await saveState();
      location.hash = '#/';
      handleRoute();     // 显式刷新：hash 可能没变化，但视图需要更新
    } catch (err) {
      showToast('无法解析 JSON 文件：' + err.message);
    }
  };

  reader.onerror = () => showToast('文件读取失败，请重试');
  reader.readAsText(file);
}

function openFilePicker() {
  dom.fileInput.value = '';
  dom.fileInput.click();
}

// ============================================================
// 清空全部记录
// ============================================================
async function handleClearAll() {
  const confirmed = await showClearConfirm(state.items.length);
  if (!confirmed) return;

  await clearState();
  showToast('已清除全部记录');
  location.hash = '#/';
  handleRoute();     // 显式刷新视图
}

// ============================================================
// 路由
// ============================================================
function handleRoute() {
  const hash = location.hash || '#/';

  if (hash.startsWith('#/item/')) {
    const idx = parseInt(hash.split('/')[2], 10);
    if (isNaN(idx) || idx < 0 || idx >= state.items.length) {
      location.hash = '#/';
      return;
    }
    renderDetail(idx);
  } else {
    if (state.items.length > 0) renderList();
    else                         showPage('page-import');
  }
}

// ============================================================
// 页面切换
// ============================================================
function showPage(pageId) {
  $$('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');

  dom.backBtn.style.display = pageId === 'page-detail' ? 'flex' : 'none';

  const titles = {
    'page-import': 'JSON 阅读器',
    'page-list':   state.fileName || '列表',
    'page-detail': '对话详情',
  };
  dom.navTitle.textContent = titles[pageId] || 'JSON 阅读器';
}

// 按排序 + 筛选获取 [ { item, idx } ] 数组
function getSortedItems() {
  let indices = state.items.map((_, i) => i);
  if (state.filterMode === 'ph') {
    indices = indices.filter(i => state.items[i].hasPHMarker);
  }
  if (state.sortOrder === 'desc') indices.reverse();
  return indices.map(idx => ({ item: state.items[idx], idx }));
}

// ============================================================
// 渲染：列表页
// ============================================================
function renderList() {
  showPage('page-list');
  const sorted = getSortedItems();
  if (state.filterMode === 'ph') {
    dom.listCount.textContent = `⭐ ${sorted.length}/${state.items.length} 条`;
  } else {
    dom.listCount.textContent = `共 ${state.items.length} 条记录`;
  }

  dom.listWrap.innerHTML = sorted.map(({ item, idx }, displayIdx) => {
    const hasBookmark = !!item.bookmark;
    const phStar = item.hasPHMarker ? '<span class="card-ph-star">⭐</span>' : '';
    const cardClass = `list-card${hasBookmark ? ' has-bookmark' : ''}`;

    if (hasBookmark) {
      const preview = item.userContent
        ? truncate(item.userContent, 30)
        : '';
      return `
        <div class="${cardClass}" data-idx="${idx}">
          ${phStar}
          <span class="card-index">#${displayIdx + 1}</span>
          <span class="card-bookmark">${esc(item.bookmark)}</span>
          <span class="card-preview">${esc(preview)}</span>
          <div class="card-footer">
            <span class="card-role-badge">🔄 对话</span>
            <span class="card-arrow">›</span>
          </div>
        </div>
      `;
    }

    const preview = item.userContent
      ? truncate(item.userContent, 50)
      : '(空)';
    return `
      <div class="${cardClass}" data-idx="${idx}">
        ${phStar}
        <span class="card-index">#${displayIdx + 1}</span>
        <span class="card-body-preview">${esc(preview)}</span>
        <div class="card-footer">
          <span class="card-role-badge">🔄 对话</span>
          <span class="card-arrow">›</span>
        </div>
      </div>
    `;
  }).join('');

  dom.listWrap.addEventListener('click', (e) => {
    const card = e.target.closest('.list-card');
    if (card) {
      listScrollPos = window.scrollY;
      location.hash = `#/item/${card.dataset.idx}`;
    }
  });

  // ── 长按删除（手机触摸） ──
  let lpTimer = null;
  dom.listWrap.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.list-card');
    if (!card) return;
    lpTimer = setTimeout(async () => {
      const idx = parseInt(card.dataset.idx);
      const confirmed = await confirmDeleteItem(idx);
      if (confirmed) {
        state.items.splice(idx, 1);
        await saveState();
        renderList();
        showToast(`已删除第 ${idx + 1} 条`);
      }
    }, 600);
  }, { passive: true });
  dom.listWrap.addEventListener('touchend', () => clearTimeout(lpTimer));
  dom.listWrap.addEventListener('touchmove', () => clearTimeout(lpTimer));
  // PC 端右键删除
  dom.listWrap.addEventListener('contextmenu', async (e) => {
    const card = e.target.closest('.list-card');
    if (!card) return;
    e.preventDefault();
    const idx = parseInt(card.dataset.idx);
    const confirmed = await confirmDeleteItem(idx);
    if (confirmed) {
      state.items.splice(idx, 1);
      await saveState();
      renderList();
      showToast(`已删除第 ${idx + 1} 条`);
    }
  });

  if (listScrollPos !== null) {
    requestAnimationFrame(() => {
      window.scrollTo(0, listScrollPos);
      listScrollPos = null;
    });
  }
}

// ============================================================
// 渲染：详情页（支持单条 / 多条 AI 消息 + 可编辑书签）
// ============================================================
function renderDetail(index) {
  showPage('page-detail');
  detailCtx = { idx: index };
  const item = state.items[index];

  // ── User 部分 ──
  let html = `
    <div class="detail-section user-section">
      <div class="detail-label">🧑 用户 · 提示词</div>
      ${item.bookmark
        ? `<div class="detail-bookmark" contenteditable="true" id="editable-bookmark">${esc(item.bookmark)}</div>
           <button class="bookmark-save-btn" id="save-bookmark-btn">💾 保存书签</button>`
        : ''}
      <div class="detail-content">${renderWithHighlights(item.userContent || '(空)', index, 'user', null)}</div>
    </div>
  `;

  // ── AI 部分（多条时用分隔线）──
  if (item.hasMultipleAssistant && Array.isArray(item.assistantList)) {
    item.assistantList.forEach((content, i) => {
      html += `
        ${i > 0 ? '<div class="ai-message-divider"></div>' : ''}
        <div class="detail-section assistant-section">
          <div class="detail-label">🤖 AI 助手${item.assistantList.length > 1 ? ` · 消息 ${i + 1}/${item.assistantList.length}` : ''} · 回复</div>
          <div class="detail-content">${renderWithHighlights(content || '[无内容]', index, 'assistant', i)}</div>
        </div>
      `;
    });
  } else {
    const content = Array.isArray(item.assistantContent) ? item.assistantContent[0] : item.assistantContent;
    html += `
      <div class="detail-section assistant-section">
        <div class="detail-label">🤖 AI 助手 · 回复</div>
        <div class="detail-content">${esc(content || '[无内容]')}</div>
      </div>
    `;
  }

  dom.detailWrap.innerHTML = html;

  // ── 书签编辑 ──
  const bookmarkEl = document.getElementById('editable-bookmark');
  const saveBtn = document.getElementById('save-bookmark-btn');
  if (bookmarkEl && saveBtn) {
    const saveBookmark = () => {
      const newBookmark = bookmarkEl.textContent.trim();
      if (newBookmark !== item.bookmark) {
        state.items[index].bookmark = newBookmark;
        saveState();
        showToast('书签已更新');
      }
    };
    saveBtn.addEventListener('click', saveBookmark);
    bookmarkEl.addEventListener('blur', saveBookmark);
    bookmarkEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        bookmarkEl.blur();
      }
    });
  }
}

// ============================================================
// 模态弹窗
// ============================================================
function showModal(html) {
  return new Promise((resolve) => {
    dom.modalBody.innerHTML = html;
    dom.modalOverlay.classList.add('show');

    const handler = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      dom.modalOverlay.classList.remove('show');
      dom.modalBody.removeEventListener('click', handler);
      setTimeout(() => resolve(btn.dataset.action), 150);
    };
    dom.modalBody.addEventListener('click', handler);
  });
}

function showImportOptions(existingCount) {
  return showModal(`
    <div class="modal-icon">📥</div>
    <h3>已有 ${existingCount} 条记录</h3>
    <p>新文件要如何处理？</p>
    <div class="modal-actions">
      <button class="btn-danger"  data-action="overwrite">覆盖已有记录</button>
      <button class="btn-primary" data-action="append">追加到末尾</button>
      <button class="btn-ghost"   data-action="cancel">取消</button>
    </div>
  `);
}

function showClearConfirm(count) {
  return showModal(`
    <div class="modal-icon">🗑</div>
    <h3>确定要清除全部 ${count} 条记录吗？</h3>
    <p class="modal-warning">此操作不可撤销</p>
    <div class="modal-actions">
      <button class="btn-danger" data-action="confirm">确认清除</button>
      <button class="btn-ghost"  data-action="cancel">取消</button>
    </div>
  `).then(a => a === 'confirm');
}

function confirmDeleteItem(index) {
  return showModal(`
    <div class="modal-icon">🗑</div>
    <h3>确定要删除第 ${index + 1} 条记录吗？</h3>
    <p class="modal-warning">此操作不可撤销</p>
    <div class="modal-actions">
      <button class="btn-danger" data-action="confirm">确认删除</button>
      <button class="btn-ghost"  data-action="cancel">取消</button>
    </div>
  `).then(a => a === 'confirm');
}

// ============================================================
// 设置面板
// ============================================================
function renderSettings() {
  const orderLabel = state.sortOrder === 'asc' ? '↑ 正序' : '↓ 倒序';
  const orderIcon  = state.sortOrder === 'asc' ? '↑' : '↓';
  const size = state.fontSize || 'medium';
  const sizeHtml = ['small','medium','large','xlarge'].map(s =>
    `<button class="setting-btn small size-btn${s === size ? ' active' : ''}" data-size="${s}">${FONT_LABELS[s]}</button>`
  ).join('');

  dom.settingsBody.innerHTML = `
    <div class="settings-header">
      <h2>设置</h2>
      <button class="settings-close" id="settings-close-btn">✕</button>
    </div>
    <div class="settings-body">
      <!-- 搜索 -->
      <div class="search-wrap">
        <input class="search-input" id="search-input" type="search" placeholder="🔍 搜索关键词…">
      </div>
      <div id="search-results" class="search-result-wrap"></div>

      <!-- 排序 -->
      <div class="setting-item" id="sort-toggle">
        <span class="setting-label"><span class="icon">${orderIcon}</span> 排序方式</span>
        <button class="setting-btn small" id="sort-btn">${orderLabel}</button>
      </div>

      <!-- 筛选 -->
      <div class="setting-item" id="filter-toggle">
        <span class="setting-label"><span class="icon">🔍</span> 筛选</span>
        <button class="setting-btn small" id="filter-btn">${state.filterMode === 'ph' ? '⭐ 仅 ph' : '📋 全部'}</button>
      </div>

      <!-- 字号 -->
      <div class="setting-item">
        <span class="setting-label"><span class="icon">Aa</span> 字号</span>
        <div style="display:flex;gap:4px">${sizeHtml}</div>
      </div>

      <!-- 跳转编号 -->
      <div class="setting-item">
        <span class="setting-label"><span class="icon">🔢</span> 跳转到编号</span>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="setting-input" id="jump-input" type="number" min="1" max="${state.items.length}" placeholder="1-${state.items.length}">
          <button class="setting-btn small" id="jump-btn">GO</button>
        </div>
      </div>

      <!-- 回顶 -->
      <div class="setting-item" id="scroll-top-item">
        <span class="setting-label"><span class="icon">⬆</span> 回到顶部</span>
      </div>

      <!-- 导出备份 -->
      <div class="setting-item" id="export-btn">
        <span class="setting-label"><span class="icon">📤</span> 导出备份</span>
      </div>

      <!-- 导入备份 -->
      <div class="setting-item" id="import-backup-btn">
        <span class="setting-label"><span class="icon">📥</span> 导入备份</span>
      </div>

      <!-- 清空 -->
      <div class="setting-item" id="settings-clear-btn">
        <span class="setting-label"><span class="icon">🗑</span> 清空全部记录</span>
      </div>

      <!-- 关于 -->
      <div class="setting-item" style="border-top:1px solid var(--border);margin-top:8px">
        <span class="setting-label" style="color:var(--text-secondary);font-size:0.8125rem">
          JSON 阅读器 v1.2 · 数据存储在本地
        </span>
      </div>
    </div>
  `;

  // ── 事件绑定 ──
  closeSettingsOnOutsideTap();

  document.getElementById('settings-close-btn')?.addEventListener('click', closeSettings);
  document.getElementById('sort-btn')?.addEventListener('click', toggleSort);

  // 筛选
  document.getElementById('filter-btn')?.addEventListener('click', toggleFilter);

  // 字号
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', () => setFontSize(btn.dataset.size));
  });

  // 跳转
  document.getElementById('jump-btn')?.addEventListener('click', handleJump);
  document.getElementById('jump-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJump();
  });

  // 回顶
  document.getElementById('scroll-top-item')?.addEventListener('click', () => {
    closeSettings(); scrollToTop();
  });

  // 导出
  document.getElementById('export-btn')?.addEventListener('click', handleExport);

  // 导入备份
  document.getElementById('import-backup-btn')?.addEventListener('click', () => {
    dom.backupInput.value = '';
    dom.backupInput.click();
  });

  // 清空
  document.getElementById('settings-clear-btn')?.addEventListener('click', async () => {
    closeSettings(); await handleClearAll();
  });

  // 搜索
  const searchInput = document.getElementById('search-input');
  let searchTimer = null;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => handleSearch(searchInput.value.trim()), 300);
  });
}

function openSettings() {
  renderSettings();
  dom.settingsOverlay.classList.add('show');
}

function closeSettings() {
  dom.settingsOverlay.classList.remove('show');
}

function closeSettingsOnOutsideTap() {
  dom.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === dom.settingsOverlay) closeSettings();
  });
}

// ============================================================
// 排序切换
// ============================================================
function toggleSort() {
  state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
  renderSettings();   // 更新面板里的按钮文本
  listScrollPos = window.scrollY;
  if (document.getElementById('page-list')?.classList.contains('active')) {
    renderList();
  }
}

// ============================================================
// 筛选切换
// ============================================================
function toggleFilter() {
  state.filterMode = state.filterMode === 'all' ? 'ph' : 'all';
  renderSettings();
  listScrollPos = window.scrollY;
  if (document.getElementById('page-list')?.classList.contains('active')) {
    renderList();
  }
}

// ============================================================
// 荧光笔系统
// ============================================================

// 用高亮 span 包裹文本中的标记段落
function renderWithHighlights(text, itemIdx, source, msgIdx) {
  const hls = (state.highlights || [])
    .filter(h => h.itemIdx === itemIdx && h.source === source && h.msgIdx === msgIdx)
    .sort((a, b) => a.start - b.start);
  if (hls.length === 0) return esc(text);

  let result = '';
  let pos = 0;
  for (const h of hls) {
    const start = Math.max(h.start, pos);
    const end   = Math.min(h.end, text.length);
    if (start > pos) result += esc(text.substring(pos, start));
    if (start < end) {
      result += `<span class="hl-marker">${esc(text.substring(start, end))}</span>`;
    }
    pos = Math.max(pos, end);
  }
  if (pos < text.length) result += esc(text.substring(pos));
  return result;
}

// 添加高亮：将当前文本选区标记为高亮
function addHighlight(itemIdx, source, msgIdx) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) { showToast('请先选中一段文字'); return; }

  const selectedText = sel.toString().trim();
  if (!selectedText) { showToast('选中内容为空'); return; }

  let el = sel.getRangeAt(0).commonAncestorContainer;
  while (el && !el.classList?.contains?.('detail-content')) el = el.parentElement;
  if (!el) { showToast('无法定位文本位置'); return; }

  const fullText = el.textContent;
  const pos = fullText.indexOf(selectedText);
  if (pos === -1) { showToast('无法定位选中位置'); return; }

  // 检查是否与已有的高亮重叠 → 重叠则取消高亮
  const overlapping = (state.highlights || []).filter(h =>
    h.itemIdx === itemIdx && h.source === source && h.msgIdx === msgIdx &&
    h.start < pos + selectedText.length && h.end > pos
  );
  if (overlapping.length > 0) {
    state.highlights = state.highlights.filter(h => !overlapping.includes(h));
    saveState();
    renderDetail(itemIdx);
    showToast('已移除荧光笔');
    return;
  }

  state.highlights.push({
    itemIdx, source, msgIdx,
    start: pos,
    end: pos + selectedText.length,
  });
  saveState();
  renderDetail(itemIdx);
  showToast('🖍 已标记荧光笔');
}

// 显示/隐藏荧光笔浮动按钮
function onSelectionChange() {
  const btn = document.getElementById('hl-float-btn');
  if (!btn) return;
  const onDetail = document.getElementById('page-detail')?.classList.contains('active');
  const sel = window.getSelection();
  if (onDetail && sel.rangeCount && !sel.isCollapsed) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    btn.style.display = 'block';
    btn.style.top  = Math.max(8, rect.top - 48) + 'px';
    btn.style.left = Math.max(8, rect.left + rect.width / 2 - 50) + 'px';
  } else {
    btn.style.display = 'none';
  }
}

// ============================================================
// 跳转到编号
// ============================================================
function handleJump() {
  const input = document.getElementById('jump-input');
  const val = parseInt(input?.value, 10);
  if (isNaN(val) || val < 1 || val > state.items.length) {
    showToast(`请输入 1-${state.items.length} 之间的编号`);
    return;
  }
  closeSettings();

  // 根据排序计算实际索引
  const sorted = getSortedItems();
  const target = sorted[val - 1];  // displayIdx = val - 1
  if (!target) return;

  // 找到对应的卡片元素，滚动居中
  const card = dom.listWrap.querySelector(`.list-card[data-idx="${target.idx}"]`);
  if (card) {
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  input.value = '';
}

// ============================================================
// 一键回顶
// ============================================================
function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function handleScroll() {
  if (dom.scrollTopBtn) {
    if (window.scrollY > window.innerHeight * 0.8) {
      dom.scrollTopBtn.classList.add('show');
    } else {
      dom.scrollTopBtn.classList.remove('show');
    }
  }
}

// ============================================================
// 导出备份
// ============================================================
function handleExport() {
  const data = { items: state.items, fileName: state.fileName, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `json-reader-备份-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  closeSettings();
  showToast('✅ 备份已导出');
}

// ============================================================
// 字号调节
// ============================================================
const FONT_SIZES = { small: '14px', medium: '16px', large: '18px', xlarge: '20px' };
const FONT_LABELS = { small: '小', medium: '中', large: '大', xlarge: '特大' };

function applyFontSize(size) {
  const px = FONT_SIZES[size] || '16px';
  document.documentElement.style.setProperty('--content-font-size', px);
}

function setFontSize(size) {
  state.fontSize = size;
  applyFontSize(size);
  saveState();
  // 刷新设置面板里的激活态
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
}

// ============================================================
// 导入备份
// ============================================================
async function handleImportBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.items)) {
      showToast('无效的备份文件');
      return;
    }
    if (state.items.length > 0) {
      const action = await showImportOptions(state.items.length);
      if (action === 'cancel') return;
      if (action === 'overwrite') {
        state.items    = data.items;
        state.fileName = data.fileName || '备份恢复';
      } else {
        state.items = [...state.items, ...data.items];
      }
    } else {
      state.items    = data.items;
      state.fileName = data.fileName || '备份恢复';
    }
    if (data.sortOrder) state.sortOrder = data.sortOrder;
    if (data.fontSize)  state.fontSize  = data.fontSize;
    await saveState();
    applyFontSize(state.fontSize);
    location.hash = '#/';
    handleRoute();
    closeSettings();
    showToast('✅ 备份已恢复');
  } catch (err) {
    showToast('备份导入失败：' + err.message);
  }
}

// ============================================================
// 搜索
// ============================================================
function handleSearch(query) {
  const resultsEl = document.getElementById('search-results');
  if (!resultsEl) return;

  if (!query) {
    resultsEl.innerHTML = '';
    return;
  }

  const lowerQ = query.toLowerCase();
  const results = [];

  state.items.forEach((item, idx) => {
    // 搜书签
    if (item.bookmark && item.bookmark.toLowerCase().includes(lowerQ)) {
      results.push({ idx, src: '书签', text: item.bookmark });
    }
    // 搜 userContent
    if (item.userContent && item.userContent.toLowerCase().includes(lowerQ)) {
      results.push({ idx, src: '用户', text: item.userContent });
    }
    // 搜 assistant
    const asstTexts = Array.isArray(item.assistantContent) ? item.assistantContent : [item.assistantContent];
    asstTexts.forEach(t => {
      if (t && t.toLowerCase().includes(lowerQ)) {
        results.push({ idx, src: 'AI', text: t });
      }
    });
  });

  // 去重（同一个 item 可能匹配多个来源 → 合并）
  const seen = new Set();
  const unique = results.filter(r => {
    const key = `${r.idx}-${r.src}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) {
    resultsEl.innerHTML = '<div class="search-no-result">未找到相关结果</div>';
    return;
  }

  resultsEl.innerHTML = unique.slice(0, 50).map(r => {
    const snippet = getSnippet(r.text, query, 40);
    return `
      <div class="search-result-item" data-idx="${r.idx}">
        <span class="match-src">#${r.idx + 1} · ${r.src}</span><br>
        ${snippet}
      </div>
    `;
  }).join('');

  resultsEl.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => {
      closeSettings();
      location.hash = `#/item/${el.dataset.idx}`;
    });
  });
}

// 截取关键词前后文并高亮
function getSnippet(text, query, radius) {
  const lower = text.toLowerCase();
  const pos = lower.indexOf(query.toLowerCase());
  if (pos === -1) return esc(text.substring(0, radius * 2));

  const start = Math.max(0, pos - radius);
  const end   = Math.min(text.length, pos + query.length + radius);
  let snippet = '';
  if (start > 0) snippet += '…';
  snippet += text.substring(start, end);
  if (end < text.length) snippet += '…';

  // 高亮关键词
  const escaped = esc(snippet);
  const hl = escaped.replace(
    new RegExp(escapeRegex(query), 'gi'),
    m => `<span class="match-highlight">${m}</span>`
  );
  return hl;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// Toast 消息
// ============================================================
let toastTimer = null;

function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2500);
}

// ============================================================
// 工具函数
// ============================================================
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen) + '…' : str;
}

// ============================================================
// 主题切换
// ============================================================
function updateThemeIcon(theme) {
  const map = { auto: '🌙', dark: '☀️', light: '🌙' };
  dom.themeBtn.textContent = map[theme] || '🌙';
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  let next;
  if (!cur || cur === 'auto') next = isDark ? 'light' : 'dark';
  else if (cur === 'dark')    next = 'light';
  else                        next = 'dark';

  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeIcon(saved);
  } else {
    updateThemeIcon('auto');
  }
}

// ============================================================
// 启动
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {

  initTheme();

  // ── 从 localStorage 恢复数据 ──
  try {
    const saved = await Storage.load();
    if (saved) {
      state.items     = saved.items || [];
      state.fileName  = saved.fileName || '';
      state.sortOrder  = saved.sortOrder || 'asc';
      state.fontSize   = saved.fontSize || 'medium';
      state.filterMode = saved.filterMode || 'all';
      state.highlights = saved.highlights || [];
    }
  } catch (err) {
    console.warn('localStorage 加载失败，走空状态:', err);
  }

  // ── 应用字号 ──
  applyFontSize(state.fontSize);

  // ── 文件导入 ──
  dom.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
  });
  dom.importBtn.addEventListener('click', openFilePicker);
  dom.reimportBtn.addEventListener('click', openFilePicker);

  // ── 备份导入 ──
  dom.backupInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleImportBackup(e.target.files[0]);
  });

  // ── 清空 ──
  dom.clearBtn.addEventListener('click', handleClearAll);

  // ── 导航 ──
  dom.backBtn.addEventListener('click', () => { location.hash = '#/'; });
  dom.themeBtn.addEventListener('click', toggleTheme);
  dom.menuBtn.addEventListener('click', openSettings);

  // ── 一键回顶 ──
  dom.scrollTopBtn.addEventListener('click', scrollToTop);
  window.addEventListener('scroll', handleScroll, { passive: true });

  // ── 荧光笔 ──
  dom.hlBtn.addEventListener('click', () => {
    if (detailCtx.idx < 0) return;
    addHighlight(detailCtx.idx, 'user', null);
  });
  document.addEventListener('selectionchange', onSelectionChange);

  // ── 诊断：点标题 5 次测试 localStorage ──
  let tapCount = 0;
  dom.navTitle.addEventListener('click', () => {
    tapCount++;
    if (tapCount >= 5) {
      tapCount = 0;
      showToast('🧪 正在诊断存储…');
      testStorage().then(ok => {
        if (ok) showToast('✅ 存储正常');
        else    showToast('❌ 存储异常，连电脑看 Console');
      });
    }
  });

  // ── 路由 ──
  window.addEventListener('hashchange', handleRoute);
  handleRoute();

  // ── Service Worker（PWA 离线） ──
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    // SW 更新后自动刷新页面，确保运行最新代码
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  }
});
