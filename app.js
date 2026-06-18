/* ==========================================================
   JSON 阅读器 — 核心逻辑
   纯前端 SPA · Hash 路由 · localStorage 持久化 · 零依赖
   ========================================================== */

// ============================================================
// 状态
// ============================================================
const state = {
  items: [],     // 解析后的条目列表
  fileName: '',  // 当前文件名
};

// 记录列表滚动位置，返回时恢复
let listScrollPos = null;

// ============================================================
// DOM 快捷引用
// ============================================================
const $ = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

const dom = {
  fileInput:    $('#file-input'),
  importBtn:    $('#import-btn'),
  reimportBtn:  $('#reimport-btn'),
  clearBtn:     $('#clear-btn'),
  backBtn:      $('#back-btn'),
  themeBtn:     $('#theme-btn'),
  navTitle:     $('#nav-title'),
  toast:        $('#toast'),
  listWrap:     $('#list-wrap'),
  listCount:    $('#list-count'),
  detailWrap:   $('#detail-wrap'),
  modalOverlay: $('#modal-overlay'),
  modalBody:    $('#modal-body'),
};

// ============================================================
// 持久化存储（localStorage 方案）
// ============================================================
const Storage = {
  KEY: 'jsonReaderData',

  async load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) {
        console.log('[存储] 无数据');
        return null;
      }
      const data = JSON.parse(raw);
      const size = (raw.length / 1024).toFixed(1);
      console.log(`[存储] 加载成功: ${data.items?.length || 0} 条 (${size}KB)`);
      return data;
    } catch (e) {
      console.error('[存储] 加载失败:', e);
      return null;
    }
  },

  async save(data) {
    try {
      const raw = JSON.stringify(data);
      const size = (raw.length / 1024).toFixed(1);
      localStorage.setItem(this.KEY, raw);
      console.log(`[存储] 保存成功: ${data.items?.length || 0} 条 (${size}KB)`);
    } catch (e) {
      console.error('[存储] 保存失败:', e);
      throw e;
    }
  },

  async clear() {
    localStorage.removeItem(this.KEY);
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
  await Storage.save({ items: state.items, fileName: state.fileName });
}

async function clearState() {
  state.items    = [];
  state.fileName = '';
  await Storage.clear();
}

// ============================================================
// 解析器：chatData.history → items[]
// ============================================================
function parseChatJSON(json) {
  const items = [];
  const history = json?.chatData?.history;
  if (!Array.isArray(history)) return items;

  for (const entry of history) {
    const sharedHistory = entry?.payload?.sharedHistory;
    if (!Array.isArray(sharedHistory) || sharedHistory.length === 0) continue;

    const userMsg = sharedHistory.find(m => m.role === 'user');
    const asstMsg = sharedHistory.find(m => m.role === 'assistant');
    if (!userMsg && !asstMsg) continue;

    const raw = userMsg?.content || '';
    let bookmark = null;
    let body = raw;
    const nl = raw.indexOf('\n');
    if (nl !== -1) {
      const before = raw.substring(0, nl).trim();
      if (before) bookmark = before;
      body = raw.substring(nl + 1).trim();
    }

    items.push({
      bookmark,
      userContent:      nl === -1 ? raw : body,
      assistantContent: asstMsg?.content || '[无内容]',
      timestamp:        entry.timestamp || null,
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

// ============================================================
// 渲染：列表页
// ============================================================
function renderList() {
  showPage('page-list');
  dom.listCount.textContent = `共 ${state.items.length} 条记录`;

  dom.listWrap.innerHTML = state.items.map((item, i) => {
    const hasBookmark = !!item.bookmark;

    if (hasBookmark) {
      const preview = item.userContent
        ? truncate(item.userContent, 30)
        : '';

      return `
        <div class="list-card has-bookmark" data-idx="${i}">
          <span class="card-index">#${i + 1}</span>
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
      <div class="list-card" data-idx="${i}">
        <span class="card-index">#${i + 1}</span>
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
      listScrollPos = window.scrollY;   // ← 记住当前位置
      location.hash = `#/item/${card.dataset.idx}`;
    }
  });

  // 从详情返回时恢复滚动位置
  if (listScrollPos !== null) {
    requestAnimationFrame(() => {
      window.scrollTo(0, listScrollPos);
      listScrollPos = null;
    });
  }
}

// ============================================================
// 渲染：详情页
// ============================================================
function renderDetail(index) {
  showPage('page-detail');
  const item = state.items[index];

  dom.detailWrap.innerHTML = `
    <div class="detail-section user-section">
      <div class="detail-label">🧑 用户 · 提示词</div>
      ${item.bookmark ? `<div class="detail-bookmark">${esc(item.bookmark)}</div>` : ''}
      <div class="detail-content">${esc(item.userContent || '(空)')}</div>
    </div>
    <div class="detail-section assistant-section">
      <div class="detail-label">🤖 AI 助手 · 回复</div>
      <div class="detail-content">${esc(item.assistantContent)}</div>
    </div>
  `;
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
      state.items    = saved.items || [];
      state.fileName = saved.fileName || '';
    }
  } catch (err) {
    console.warn('localStorage 加载失败，走空状态:', err);
  }

  // ── 文件导入 ──
  dom.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
  });
  dom.importBtn.addEventListener('click', openFilePicker);
  dom.reimportBtn.addEventListener('click', openFilePicker);

  // ── 清空 ──
  dom.clearBtn.addEventListener('click', handleClearAll);

  // ── 导航 ──
  dom.backBtn.addEventListener('click', () => { location.hash = '#/'; });
  dom.themeBtn.addEventListener('click', toggleTheme);

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
