/* ============================================================
 *  AI Code Studio — главная логика
 *  + Проверка подключения к ИИ
 *  + Запуск кода в изолированном iframe (HTML/JS/CSS/SVG/JSON)
 *  + Автоповтор при сетевых ошибках
 * ============================================================ */

(function () {
'use strict';

// ==================== Утилиты ====================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const formatBytes = (n) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};

const TEXT_EXT = new Set([
  'js','jsx','ts','tsx','mjs','cjs','json','html','htm','css','scss','sass','less',
  'md','markdown','txt','xml','yaml','yml','toml','ini','cfg','conf','env','sh','bash',
  'zsh','fish','ps1','bat','py','pyw','rb','go','rs','java','kt','kts','c','cpp','cc',
  'cxx','h','hpp','hh','cs','php','swift','m','mm','sql','graphql','gql','vue','svelte',
  'astro','dockerfile','makefile','gitignore','gitattributes','editorconfig','log','csv',
  'tsv','rtf','srt','vtt','lua','pl','r','dart','ex','exs','erl','hs','clj','fs','fsx',
  'nim','zig','v','sv','vhd','asm','s','tex','bib','diff','patch'
]);

const MIME_MAP = {
  js:'application/javascript', mjs:'application/javascript', cjs:'application/javascript',
  json:'application/json', html:'text/html', htm:'text/html', css:'text/css',
  md:'text/markdown', txt:'text/plain', xml:'application/xml', svg:'image/svg+xml',
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
  webp:'image/webp', bmp:'image/bmp', ico:'image/x-icon', avif:'image/avif',
  mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', m4a:'audio/mp4', flac:'audio/flac',
  aac:'audio/aac', opus:'audio/opus',
  mp4:'video/mp4', webm:'video/webm', mkv:'video/x-matroska', mov:'video/quicktime',
  avi:'video/x-msvideo', ogv:'video/ogg',
  pdf:'application/pdf', zip:'application/zip', gz:'application/gzip',
  tar:'application/x-tar', '7z':'application/x-7z-compressed', rar:'application/vnd.rar',
  wasm:'application/wasm', woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf',
  otf:'font/otf'
};

const guessMime = (name) => {
  const ext = String(name).split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
};

const isTextFile = (name, mime) => {
  if (mime) {
    if (mime.startsWith('text/')) return true;
    if (mime === 'application/json') return true;
    if (mime === 'application/javascript') return true;
    if (mime === 'application/xml') return true;
    if (mime === 'image/svg+xml') return true;
  }
  const ext = String(name).split('.').pop().toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (!String(name).includes('.')) return true;
  return false;
};

const isImage = (mime) => mime && mime.startsWith('image/');
const isVideo = (mime) => mime && mime.startsWith('video/');
const isAudio = (mime) => mime && mime.startsWith('audio/');

const isAndroid = () => /Android/i.test(navigator.userAgent);
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

// ==================== Скачивание / Share ====================
async function saveFile(blob, filename, opts = {}) {
  const { preferShare = false } = opts;

  if (preferShare && navigator.canShare && typeof File !== 'undefined') {
    try {
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return true;
      }
    } catch (e) {
      if (e.name === 'AbortError') return true;
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
    return true;
  } catch (e) {
    console.warn('Скачивание не сработало:', e);
    return false;
  }
}

// ==================== Markdown ====================
const renderMarkdown = (text) => {
  let html = escapeHtml(text);
  const codeBlocks = [];
  html = html.replace(/```([\w:-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const idx = codeBlocks.length;
    const cleanLang = lang && lang.startsWith('tool:') ? '' : lang;
    codeBlocks.push(
      `<pre class="code-block" data-lang="${escapeHtml(cleanLang)}"><code>${code}</code></pre>`
    );
    return `\u0001CB${idx}\u0001`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/^### (.+)$/gm, '<strong style="font-size:1.05em">$1</strong>');
  html = html.replace(/^## (.+)$/gm,  '<strong style="font-size:1.1em">$1</strong>');
  html = html.replace(/^# (.+)$/gm,   '<strong style="font-size:1.15em">$1</strong>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/\u0001CB(\d+)\u0001/g, (m, i) => codeBlocks[+i] || '');
  return html;
};

// ==================== Состояние ====================
const state = {
  chats: [],
  currentChatId: null,
  files: new Map(),
  ai: new AIClient(),
  isGenerating: false,
  abortController: null,
  selectedFilePath: null,
  previewUrl: null,
  uiOpen: false,
  deferredInstall: null,
  lastRunUrl: null
};

// ==================== DOM ====================
const DOM = {};

function cacheDom() {
  DOM.chatList = $('#chat-list');
  DOM.messages = $('#messages');
  DOM.chatTitle = $('#chat-title');
  DOM.input = $('#input');
  DOM.sendBtn = $('#send-btn');
  DOM.stopBtn = $('#stop-btn');
  DOM.newChatBtn = $('#new-chat-btn');
  DOM.settingsBtn = $('#settings-btn');
  DOM.settingsModal = $('#settings-modal');
  DOM.closeSettings = $('#close-settings');
  DOM.saveSettings = $('#save-settings');
  DOM.resetSettings = $('#reset-settings');
  DOM.filesPanel = $('#files-panel');
  DOM.sidebar = $('#sidebar');
  DOM.backdrop = $('#backdrop');
  DOM.menuBtn = $('#menu-btn');
  DOM.closeFilesBtn = $('#close-files-btn');
  DOM.toggleFilesBtn = $('#toggle-files-btn');
  DOM.fileInput = $('#file-input');
  DOM.importBtn = $('#import-files-btn');
  DOM.exportAllBtn = $('#export-all-btn');
  DOM.fileList = $('#file-list');
  DOM.filePreview = $('#file-preview');
  DOM.app = $('#app');
  DOM.installBtn = $('#install-btn');
  DOM.aiStatus = $('#ai-status');
  DOM.testBtn = $('#test-connection');
  DOM.testResult = $('#test-result');
  DOM.runModal = $('#run-modal');
  DOM.runIframe = $('#run-iframe');
  DOM.runTitle = $('#run-title');
  DOM.runClose = $('#run-close');
  DOM.runReload = $('#run-reload');
  DOM.runOpen = $('#run-open');
}

// ==================== Индикатор статуса ИИ ====================
function setAiStatus(kind, title) {
  if (!DOM.aiStatus) return;
  DOM.aiStatus.classList.remove('idle', 'checking', 'ok', 'err');
  DOM.aiStatus.classList.add(kind);
  DOM.aiStatus.title = title || 'Статус подключения';
}

// ==================== Чаты ====================
const CHATS_KEY = 'aics_chats';

function loadChats() {
  try {
    const data = localStorage.getItem(CHATS_KEY);
    if (data) {
      const parsed = JSON.parse(data);
      state.chats = Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.warn('Не удалось загрузить чаты:', e);
    state.chats = [];
  }
}

function saveChats() {
  try {
    const trimmed = state.chats.map((c) => ({
      ...c,
      messages: c.messages.slice(-200)
    }));
    localStorage.setItem(CHATS_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('Не удалось сохранить чаты:', e);
  }
}

function getCurrentChat() {
  return state.chats.find((c) => c.id === state.currentChatId) || null;
}

function createChat() {
  const chat = {
    id: uid(),
    title: 'Новый чат',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  saveChats();
  renderChatList();
  renderMessages();
  renderChatTitle();
  if (!isMobile()) DOM.input.focus();
  return chat;
}

function switchChat(id) {
  if (state.isGenerating) {
    if (!confirm('Идёт генерация. Прервать и переключиться?')) return;
    stopGeneration();
  }
  state.currentChatId = id;
  renderChatList();
  renderMessages();
  renderChatTitle();
  if (isMobile()) closeAllUI();
}

function deleteChat(id) {
  const idx = state.chats.findIndex((c) => c.id === id);
  if (idx < 0) return;
  if (!confirm('Удалить этот чат?')) return;
  state.chats.splice(idx, 1);
  if (state.currentChatId === id) {
    state.currentChatId = state.chats[0] ? state.chats[0].id : null;
  }
  if (!state.currentChatId && state.chats.length === 0) createChat();
  saveChats();
  renderChatList();
  renderMessages();
  renderChatTitle();
}

function autoTitleFromMessage(text) {
  const chat = getCurrentChat();
  if (!chat) return;
  if (chat.title === 'Новый чат' && chat.messages.length <= 2) {
    chat.title = text.trim().slice(0, 40) + (text.length > 40 ? '…' : '');
    renderChatList();
    renderChatTitle();
  }
}

function renderChatList() {
  DOM.chatList.innerHTML = '';
  if (state.chats.length === 0) {
    DOM.chatList.innerHTML = '<div class="empty-files" style="padding:12px 8px;">Нет чатов</div>';
    return;
  }
  state.chats.forEach((chat) => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.currentChatId ? ' active' : '');
    item.innerHTML = `
      <span class="title">${escapeHtml(chat.title)}</span>
      <button class="del" title="Удалить" aria-label="Удалить чат">✕</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) return;
      switchChat(chat.id);
    });
    item.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });
    DOM.chatList.appendChild(item);
  });
}

function renderChatTitle() {
  const chat = getCurrentChat();
  DOM.chatTitle.textContent = chat ? chat.title : 'Чат не выбран';
}

// ==================== Сообщения ====================
function renderMessages() {
  const chat = getCurrentChat();
  DOM.messages.innerHTML = '';
  if (!chat || chat.messages.length === 0) {
    DOM.messages.innerHTML = `
      <div class="empty-state">
        <h2>Начните диалог</h2>
        <p>Опишите, что нужно сделать — ИИ может создавать, редактировать и удалять файлы проекта.</p>
      </div>`;
    return;
  }
  chat.messages.forEach((msg) => appendMessageToDOM(msg));
  scrollToBottom(false);
}

function appendMessageToDOM(msg) {
  const el = document.createElement('div');
  el.className = 'message ' + msg.role;

  const roleLabel = msg.role === 'user' ? 'Вы' : msg.role === 'assistant' ? 'ИИ' : msg.role;
  let inner = '';

  if (msg.role === 'assistant' && msg.reasoning) {
    inner += `<details class="reasoning"><summary>Размышления</summary>${escapeHtml(msg.reasoning)}</details>`;
  }

  inner += `<div class="body">${renderMarkdown(msg.content || '')}</div>`;

  if (msg.toolResults && msg.toolResults.length) {
    msg.toolResults.forEach((r) => {
      inner += renderToolResult(r);
    });
  }

  el.innerHTML = `<span class="role">${roleLabel}</span>${inner}`;
  DOM.messages.appendChild(el);
  return el;
}

const RUNNABLE_EXT = new Set(['html', 'htm', 'js', 'mjs', 'cjs', 'css', 'svg', 'json']);

function renderToolResult(r) {
  const badgeClass = r.ok ? (
    r.tool === 'write_file' ? 'write' :
    r.tool === 'delete_file' ? 'delete' :
    r.tool === 'read_file' ? 'read' :
    'list'
  ) : 'error';

  const status = r.ok ? 'OK' : 'Ошибка';
  const bodyText = r.ok ? (r.message || '') : (r.error || 'Неизвестная ошибка');

  let footer = '';
  if (r.ok && r.tool === 'write_file' && r.path) {
    const ext = r.path.split('.').pop().toLowerCase();
    if (RUNNABLE_EXT.has(ext)) {
      footer = `<div class="tool-footer">
        <button class="run-from-tool" data-path="${escapeHtml(r.path)}">▶ Запустить</button>
      </div>`;
    }
  }

  return `
    <div class="tool-call">
      <div class="tool-header">
        <span>🖥 ${escapeHtml(r.tool)} ${r.path ? '· ' + escapeHtml(r.path) : ''}</span>
        <span class="badge ${badgeClass}">${status}</span>
      </div>
      <div class="tool-body">${escapeHtml(bodyText)}</div>
      ${footer}
    </div>
  `;
}

function scrollToBottom(smooth = true) {
  try {
    DOM.messages.scrollTo({
      top: DOM.messages.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
  } catch (_) {
    DOM.messages.scrollTop = DOM.messages.scrollHeight;
  }
}

// ==================== Инструменты ИИ ====================
const TOOL_REGEX = /```tool:(\w+)\s*\n([\s\S]*?)```/g;

function extractToolCalls(text) {
  const calls = [];
  let m;
  TOOL_REGEX.lastIndex = 0;
  while ((m = TOOL_REGEX.exec(text)) !== null) {
    const tool = m[1];
    const raw = m[2].trim();
    let args = {};
    try { args = JSON.parse(raw); }
    catch (e) {
      calls.push({ tool, args: null, parseError: e.message, raw });
      continue;
    }
    calls.push({ tool, args });
  }
  return calls;
}

function stripToolCalls(text) {
  return text.replace(TOOL_REGEX, '').trim();
}

function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function executeTool(call) {
  const result = { tool: call.tool, ok: false };

  if (!call.args) {
    result.error = 'Не удалось разобрать JSON: ' + (call.parseError || '');
    return result;
  }

  const args = call.args;

  try {
    switch (call.tool) {
      case 'write_file': {
        const path = normalizePath(args.path);
        if (!path) { result.error = 'Не указан path'; break; }
        const content = args.content == null ? '' : String(args.content);
        const mime = guessMime(path);
        const isText = isTextFile(path, mime);
        const blob = isText ? content : new Blob([content], { type: mime });
        const size = isText ? new Blob([content]).size : blob.size;

        state.files.set(path, {
          path,
          name: path.split('/').pop(),
          mime,
          size,
          content: blob,
          isText
        });
        result.ok = true;
        result.path = path;
        result.message = `Файл записан (${formatBytes(size)})`;
        renderFiles();
        break;
      }
      case 'read_file': {
        const path = normalizePath(args.path);
        if (!path) { result.error = 'Не указан path'; break; }
        const file = state.files.get(path);
        if (!file) { result.error = 'Файл не найден: ' + path; break; }
        if (!file.isText) { result.error = 'Файл бинарный, чтение как текст невозможно'; break; }
        result.ok = true;
        result.path = path;
        result.message = String(file.content).slice(0, 8000) +
          (file.content.length > 8000 ? '\n… (усечено)' : '');
        break;
      }
      case 'delete_file': {
        const path = normalizePath(args.path);
        if (!path) { result.error = 'Не указан path'; break; }
        if (!state.files.has(path)) { result.error = 'Файл не найден: ' + path; break; }
        const confirmed = confirm(`ИИ хочет удалить файл:\n${path}\n\nПодтвердить удаление?`);
        if (!confirmed) {
          result.error = 'Удаление отклонено пользователем';
          break;
        }
        state.files.delete(path);
        result.ok = true;
        result.path = path;
        result.message = 'Файл удалён';
        if (state.selectedFilePath === path) {
          state.selectedFilePath = null;
          DOM.filePreview.classList.remove('open');
          DOM.filePreview.innerHTML = '';
        }
        renderFiles();
        break;
      }
      case 'list_files': {
        const list = Array.from(state.files.values())
          .map((f) => `${f.path}  (${formatBytes(f.size)})`)
          .join('\n');
        result.ok = true;
        result.message = list || '(файлов нет)';
        break;
      }
      default:
        result.error = 'Неизвестный инструмент: ' + call.tool;
    }
  } catch (e) {
    result.error = e.message || String(e);
  }

  return result;
}

// ==================== Контекст проекта ====================
function buildProjectContext() {
  if (state.files.size === 0) return '';
  const list = Array.from(state.files.values())
    .map((f) => `  • ${f.path}  (${formatBytes(f.size)})`)
    .join('\n');
  return `\n\n=== ФАЙЛЫ ПРОЕКТА (${state.files.size}) ===\n${list}\n=== КОНЕЦ СПИСКА ===`;
}

function buildMessagesForAI() {
  const chat = getCurrentChat();
  const sys = state.ai.settings.systemPrompt + buildProjectContext();
  const messages = [{ role: 'system', content: sys }];
  if (!chat) return messages;

  chat.messages.forEach((m) => {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  });
  return messages;
}

// ==================== Отправка сообщений ====================
async function sendMessage() {
  const text = DOM.input.value.trim();
  if (!text) return;
  if (state.isGenerating) return;

  if (!state.ai.settings.apiKey) {
    alert('Сначала укажите API Key в настройках (⚙️).');
    openSettings();
    return;
  }

  if (!state.currentChatId) createChat();

  const chat = getCurrentChat();
  const userMsg = { role: 'user', content: text, ts: Date.now() };
  chat.messages.push(userMsg);
  chat.updatedAt = Date.now();
  autoTitleFromMessage(text);
  DOM.input.value = '';
  DOM.input.style.height = 'auto';

  renderMessages();
  saveChats();

  const assistantMsg = { role: 'assistant', content: '', reasoning: '', toolResults: [] };
  chat.messages.push(assistantMsg);
  const assistantEl = appendMessageToDOM(assistantMsg);
  const bodyEl = assistantEl.querySelector('.body');
  bodyEl.classList.add('typing');
  scrollToBottom(false);

  state.isGenerating = true;
  DOM.sendBtn.disabled = true;
  DOM.stopBtn.style.display = 'inline-flex';
  state.abortController = new AbortController();

  let reasoningBuffer = '';
  let reasoningEl = null;

  const updateReasoning = (chunk) => {
    reasoningBuffer += chunk;
    if (!reasoningEl) {
      reasoningEl = document.createElement('details');
      reasoningEl.className = 'reasoning';
      reasoningEl.open = true;
      reasoningEl.innerHTML = `<summary>Размышления</summary><span class="r-body"></span>`;
      assistantEl.insertBefore(reasoningEl, bodyEl);
    }
    reasoningEl.querySelector('.r-body').textContent = reasoningBuffer;
    scrollToBottom();
  };

  try {
    const messages = buildMessagesForAI();
    const cleanMessages = messages.filter((m, i) => {
      if (i === messages.length - 1 && m.role === 'assistant' && !m.content) return false;
      return true;
    });

    await state.ai.streamChat(cleanMessages, {
      onToken: (chunk) => {
        assistantMsg.content += chunk;
        bodyEl.innerHTML = renderMarkdown(assistantMsg.content);
        scrollToBottom();
      },
      onReasoning: updateReasoning,
      signal: state.abortController.signal
    });

    // Успех — статус зелёный
    setAiStatus('ok', 'Подключение активно');
  } catch (err) {
    if (err.name === 'AbortError') {
      assistantMsg.content += '\n\n_[генерация прервана]_';
    } else {
      // Диагностика
      const errText = err.message || String(err);
      let extra = '';

      if (/сетевая ошибка|failed to fetch|network/i.test(errText)) {
        const hint = typeof diagnoseFetchError === 'function'
          ? diagnoseFetchError(state.ai.settings.apiUrl)
          : '';
        extra = hint ? `\n\n${hint}` : '';
        setAiStatus('err', 'Ошибка подключения — нажмите для проверки');
      } else if (err.status) {
        setAiStatus('err', `Ошибка ${err.status}`);
      }

      assistantMsg.content += `\n\n**⚠ Ошибка:** ${errText}${extra}\n\n_Откройте ⚙️ Настройки → «🔌 Проверить подключение».`;
    }
    bodyEl.innerHTML = renderMarkdown(assistantMsg.content);
  } finally {
    bodyEl.classList.remove('typing');
    state.isGenerating = false;
    DOM.sendBtn.disabled = false;
    DOM.stopBtn.style.display = 'none';
    state.abortController = null;

    if (reasoningBuffer) assistantMsg.reasoning = reasoningBuffer;

    const toolCalls = extractToolCalls(assistantMsg.content);
    if (toolCalls.length > 0) {
      const cleanContent = stripToolCalls(assistantMsg.content);
      assistantMsg.content = cleanContent;
      const results = [];
      for (const call of toolCalls) {
        const r = executeTool(call);
        results.push(r);
      }
      assistantMsg.toolResults = results;
      const newEl = document.createElement('div');
      newEl.className = 'message assistant';
      let inner = '';
      if (assistantMsg.reasoning) {
        inner += `<details class="reasoning"><summary>Размышления</summary>${escapeHtml(assistantMsg.reasoning)}</details>`;
      }
      inner += `<div class="body">${renderMarkdown(assistantMsg.content || '_(выполнены действия)_')}</div>`;
      results.forEach((r) => { inner += renderToolResult(r); });
      newEl.innerHTML = `<span class="role">ИИ</span>${inner}`;
      assistantEl.replaceWith(newEl);

      // Автозапуск: если ИИ создал index.html — не запускаем автоматически,
      // но подсвечиваем кнопку "▶ Запустить" в карточке файла.
    }

    saveChats();
    scrollToBottom();
  }
}

function stopGeneration() {
  if (state.abortController) {
    try { state.abortController.abort(); } catch (_) {}
  }
}

// ==================== Файлы ====================
function renderFiles() {
  DOM.fileList.innerHTML = '';
  if (state.files.size === 0) {
    DOM.fileList.innerHTML = '<div class="empty-files">Пока нет файлов.<br><small>Импортируйте или попросите ИИ создать.</small></div>';
    return;
  }
  const sorted = Array.from(state.files.values())
    .sort((a, b) => a.path.localeCompare(b.path));

  sorted.forEach((file) => {
    const item = document.createElement('div');
    item.className = 'file-item' + (file.path === state.selectedFilePath ? ' selected' : '');
    item.innerHTML = `
      <span>${fileIcon(file)}</span>
      <span class="fname" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span>
      <span class="fsize">${formatBytes(file.size)}</span>
      <button class="fdel" title="Удалить" aria-label="Удалить файл">✕</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('fdel')) return;
      previewFile(file.path);
    });
    item.querySelector('.fdel').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Удалить файл "${file.path}"?`)) {
        deleteFile(file.path);
      }
    });
    DOM.fileList.appendChild(item);
  });
}

function fileIcon(file) {
  if (isImage(file.mime)) return '🖼';
  if (isVideo(file.mime)) return '🎬';
  if (isAudio(file.mime)) return '🎵';
  const ext = file.path.split('.').pop().toLowerCase();
  if (['js','jsx','mjs','cjs'].includes(ext)) return '🟨';
  if (['ts','tsx'].includes(ext)) return '🔷';
  if (ext === 'json') return '🔧';
  if (['html','htm'].includes(ext)) return '🌐';
  if (['css','scss','sass','less'].includes(ext)) return '🎨';
  if (['md','markdown'].includes(ext)) return '📝';
  if (['py'].includes(ext)) return '🐍';
  if (['go'].includes(ext)) return '🐹';
  if (['rs'].includes(ext)) return '🦀';
  if (['zip','gz','tar','rar','7z'].includes(ext)) return '🗜';
  if (file.isText) return '📄';
  return '📦';
}

function addFile(path, content, mime) {
  path = normalizePath(path);
  if (!path) return null;
  const guessedMime = mime || guessMime(path);
  const isText = isTextFile(path, guessedMime);

  let stored;
  let size;
  if (typeof content === 'string') {
    stored = isText ? content : new Blob([content], { type: guessedMime });
    size = new Blob([content]).size;
  } else if (content instanceof Blob) {
    stored = content;
    size = content.size;
  } else if (content instanceof ArrayBuffer) {
    stored = isText
      ? new TextDecoder().decode(content)
      : new Blob([content], { type: guessedMime });
    size = content.byteLength;
  } else {
    stored = String(content);
    size = new Blob([stored]).size;
  }

  state.files.set(path, {
    path,
    name: path.split('/').pop(),
    mime: guessedMime,
    size,
    content: stored,
    isText: isText && typeof stored === 'string'
  });
  return path;
}

function deleteFile(path) {
  state.files.delete(path);
  if (state.selectedFilePath === path) {
    state.selectedFilePath = null;
    DOM.filePreview.classList.remove('open');
    DOM.filePreview.innerHTML = '';
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }
  }
  renderFiles();
}

async function previewFile(path) {
  const file = state.files.get(path);
  if (!file) return;
  state.selectedFilePath = path;

  renderFiles();

  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }

  DOM.filePreview.classList.add('open');
  DOM.filePreview.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'preview-header';

  const ext = file.path.split('.').pop().toLowerCase();
  const canRun = file.isText && RUNNABLE_EXT.has(ext);

  header.innerHTML = `
    <span title="${escapeHtml(file.path)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">${escapeHtml(file.path)}</span>
    <div class="preview-actions">
      ${canRun ? '<button class="pv-run" title="Запустить">▶ Запустить</button>' : ''}
      <button class="pv-dl" title="Скачать">⬇ Скачать</button>
    </div>
  `;
  DOM.filePreview.appendChild(header);

  const runBtn = header.querySelector('.pv-run');
  if (runBtn) runBtn.addEventListener('click', () => runFile(path));

  header.querySelector('.pv-dl').addEventListener('click', () => downloadFile(path));

  if (isImage(file.mime)) {
    const blob = file.content instanceof Blob ? file.content : new Blob([file.content], { type: file.mime });
    const url = URL.createObjectURL(blob);
    state.previewUrl = url;
    const img = document.createElement('img');
    img.src = url;
    img.loading = 'lazy';
    DOM.filePreview.appendChild(img);
  } else if (isVideo(file.mime)) {
    const blob = file.content instanceof Blob ? file.content : new Blob([file.content], { type: file.mime });
    const url = URL.createObjectURL(blob);
    state.previewUrl = url;
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    DOM.filePreview.appendChild(v);
  } else if (isAudio(file.mime)) {
    const blob = file.content instanceof Blob ? file.content : new Blob([file.content], { type: file.mime });
    const url = URL.createObjectURL(blob);
    state.previewUrl = url;
    const a = document.createElement('audio');
    a.src = url;
    a.controls = true;
    DOM.filePreview.appendChild(a);
  } else if (file.isText) {
    const pre = document.createElement('pre');
    pre.textContent = String(file.content);
    DOM.filePreview.appendChild(pre);
  } else {
    const info = document.createElement('div');
    info.style.color = 'var(--text-dim)';
    info.style.fontSize = '12px';
    info.textContent = `Бинарный файл (${file.mime}, ${formatBytes(file.size)}). Скачайте для просмотра.`;
    DOM.filePreview.appendChild(info);
  }
}

async function downloadFile(path) {
  const file = state.files.get(path);
  if (!file) return;
  const blob = file.content instanceof Blob
    ? file.content
    : new Blob([file.content], { type: file.mime });
  await saveFile(blob, file.name, { preferShare: isAndroid() });
}

// ==================== ЗАПУСК КОДА ====================
async function replaceAsync(str, regex, asyncFn) {
  const promises = [];
  str.replace(regex, (match, ...args) => {
    promises.push(Promise.resolve(asyncFn(match, ...args)));
    return match;
  });
  const results = await Promise.all(promises);
  let i = 0;
  return str.replace(regex, () => results[i++]);
}

function resolveRelPath(baseDir, rel) {
  if (/^(https?:|data:|blob:|mailto:|tel:|javascript:)/i.test(rel)) return null;
  if (rel.startsWith('//')) return null;
  if (rel.startsWith('/')) {
    return normalizePath(rel);
  }
  const combined = (baseDir + rel).split('/');
  const out = [];
  for (const p of combined) {
    if (p === '' || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function buildRunnableHTML(path) {
  const file = state.files.get(path);
  if (!file || !file.isText) return null;

  const ext = path.split('.').pop().toLowerCase();
  const baseDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const raw = String(file.content);

  // .html — собираем с зависимостями
  if (ext === 'html' || ext === 'htm') {
    let html = raw;

    // Внешние CSS
    html = await replaceAsync(
      html,
      /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
      async (match, href) => {
        const resolved = resolveRelPath(baseDir, href);
        if (!resolved) return match;
        const css = state.files.get(resolved);
        if (!css || !css.isText) return match;
        return `<style data-from="${escapeHtml(resolved)}">\n${css.content}\n</style>`;
      }
    );

    // Внешние JS
    html = await replaceAsync(
      html,
      /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
      async (match, a1, src, a2) => {
        const resolved = resolveRelPath(baseDir, src);
        if (!resolved) return match;
        const js = state.files.get(resolved);
        if (!js || !js.isText) return match;
        const attrs = (a1 + ' ' + a2)
          .replace(/\bsrc\s*=\s*["'][^"']*["']/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        return `<script ${attrs} data-from="${escapeHtml(resolved)}">\n${js.content}\n</script>`;
      }
    );

    // Картинки
    html = await replaceAsync(
      html,
      /<img\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>/gi,
      async (match, a1, src, a2) => {
        if (/^(data:|https?:|blob:)/i.test(src)) return match;
        const resolved = resolveRelPath(baseDir, src);
        if (!resolved) return match;
        const img = state.files.get(resolved);
        if (!img || !(img.content instanceof Blob)) return match;
        const dataUrl = await blobToDataURL(img.content);
        return `<img${a1}src="${dataUrl}"${a2}>`;
      }
    );

    return html;
  }

  // .js / .mjs / .cjs — оборачиваем в HTML с console-перехватом
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    const moduleAttr = ext === 'mjs' ? ' type="module"' : '';
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(file.name)}</title>
<style>
  body { margin: 0; background: #0e1116; color: #e6edf3; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; }
  #__console { padding: 14px; white-space: pre-wrap; word-break: break-word; }
  #__console .log { color: #e6edf3; }
  #__console .info { color: #79aaff; }
  #__console .warn { color: #ffcb56; }
  #__console .error { color: #ff8484; }
  #__console .ret { color: #67d179; }
  #__console .muted { color: #8b949e; }
</style>
</head>
<body>
<div id="__console"></div>
<script${moduleAttr}>
(function(){
  const out = document.getElementById('__console');
  const print = (cls, args) => {
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a, null, 2); } catch(e) { return String(a); }
    }).join(' ');
    out.appendChild(line);
  };
  const _log = console.log, _info = console.info, _warn = console.warn, _err = console.error;
  console.log   = (...a) => { print('log', a);   _log.apply(console, a); };
  console.info  = (...a) => { print('info', a);  _info.apply(console, a); };
  console.warn  = (...a) => { print('warn', a);  _warn.apply(console, a); };
  console.error = (...a) => { print('error', a); _err.apply(console, a); };
  window.addEventListener('error', (e) => {
    print('error', ['Uncaught:', e.message, 'at', (e.filename||'') + ':' + (e.lineno||0)]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    print('error', ['Unhandled promise rejection:', e.reason && (e.reason.message || e.reason)]);
  });
  print('muted', ['▶ ${file.name} запущен']);
})();
<\/script>
<script${moduleAttr}>
${String(file.content)}
<\/script>
</body>
</html>`;
  }

  // .css — оборачиваем с тестовым HTML
  if (ext === 'css') {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(file.name)}</title>
<style>
  .__demo { padding: 20px; font-family: system-ui, sans-serif; }
  .__demo h1 { margin: 0 0 12px; }
  .__demo p { margin: 0 0 12px; }
  .__demo button { padding: 8px 14px; border-radius: 6px; border: 1px solid #888; cursor: pointer; margin-right: 8px; }
  .__demo .card { padding: 16px; border-radius: 8px; border: 1px solid #ccc; margin-top: 12px; }
</style>
<style data-from="${escapeHtml(path)}">
${String(file.content)}
</style>
</head>
<body>
<div class="__demo">
  <h1>Демо-страница</h1>
  <p>Это тестовый HTML, чтобы вы могли увидеть, как работает ваш CSS-файл <b>${escapeHtml(file.name)}</b>.</p>
  <p>
    <button>Кнопка</button>
    <button>Вторая</button>
  </p>
  <div class="card">
    <h2>Заголовок карточки</h2>
    <p>Текст внутри карточки для проверки стилей.</p>
  </div>
</div>
</body>
</html>`;
  }

  // .svg — оборачиваем в HTML
  if (ext === 'svg') {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(file.name)}</title>
<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#1a1a1a;}svg{max-width:90vw;max-height:90vh;}</style>
</head><body>${String(file.content)}</body></html>`;
  }

  // .json — просто превью с форматированием
  if (ext === 'json') {
    let pretty = String(file.content);
    try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch (_) {}
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(file.name)}</title>
<style>body{margin:0;background:#0e1116;color:#e6edf3;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;}
pre{padding:14px;margin:0;white-space:pre-wrap;word-break:break-word;}</style>
</head><body><pre>${escapeHtml(pretty)}</pre></body></html>`;
  }

  return null;
}

async function runFile(path) {
  const file = state.files.get(path);
  if (!file) return;

  if (!file.isText) {
    alert('Этот файл нельзя запустить — он бинарный.');
    return;
  }

  const ext = path.split('.').pop().toLowerCase();
  if (!RUNNABLE_EXT.has(ext)) {
    alert(
      `Запуск .${ext} в браузере не поддерживается.\n\n` +
      `Можно запустить: .html, .htm, .js, .mjs, .cjs, .css, .svg, .json`
    );
    return;
  }

  let html;
  try {
    html = await buildRunnableHTML(path);
  } catch (e) {
    alert('Ошибка сборки: ' + e.message);
    return;
  }

  if (!html) {
    alert('Не удалось подготовить файл к запуску.');
    return;
  }

  // Открываем модалку
  DOM.runTitle.textContent = '▶ ' + path;
  DOM.runModal.classList.add('open');
  pushUIState();

  // Небольшая задержка, чтобы iframe перерисовался
  DOM.runIframe.srcdoc = html;
  state.lastRunPath = path;
}

function closeRunModal() {
  DOM.runModal.classList.remove('open');
  DOM.runIframe.srcdoc = '<!-- closed -->';
}

async function reopenRunModal() {
  if (!state.lastRunPath) return;
  const path = state.lastRunPath;
  const html = await buildRunnableHTML(path);
  if (html) DOM.runIframe.srcdoc = html;
}

function openRunInNewTab() {
  if (!DOM.runIframe.srcdoc) return;
  const blob = new Blob([DOM.runIframe.srcdoc], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ==================== Импорт / Экспорт ====================
async function handleImportedFiles(fileList) {
  const files = Array.from(fileList);
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      await importZip(f);
    } else {
      await importSingleFile(f, '');
    }
  }
  renderFiles();
}

async function importSingleFile(file, prefix) {
  const guessed = file.type || guessMime(file.name);
  const text = isTextFile(file.name, guessed);

  if (text) {
    const content = await file.text();
    addFile(prefix + file.name, content, guessed);
  } else {
    addFile(prefix + file.name, file, guessed);
  }
}

async function importZip(zipFile) {
  if (typeof JSZip === 'undefined') {
    alert('JSZip не загружен. Проверьте подключение к интернету.');
    return;
  }
  try {
    const zip = await JSZip.loadAsync(zipFile);
    const entries = [];
    zip.forEach((relativePath, entry) => {
      if (!entry.dir) entries.push({ relativePath, entry });
    });

    for (const { relativePath, entry } of entries) {
      const path = normalizePath(relativePath);
      if (!path) continue;
      const mime = guessMime(path);
      const text = isTextFile(path, mime);

      if (text) {
        const content = await entry.async('string');
        addFile(path, content, mime);
      } else {
        const buf = await entry.async('arraybuffer');
        addFile(path, buf, mime);
      }
    }
    console.log(`Импортировано из ZIP: ${entries.length} файлов`);
  } catch (e) {
    console.error(e);
    alert('Ошибка при чтении ZIP: ' + e.message);
  }
}

async function exportAll() {
  if (state.files.size === 0) {
    alert('Нет файлов для экспорта.');
    return;
  }
  if (typeof JSZip === 'undefined') {
    alert('JSZip не загружен.');
    return;
  }
  const zip = new JSZip();

  for (const [path, file] of state.files) {
    if (file.content instanceof Blob) {
      const buf = await file.content.arrayBuffer();
      zip.file(path, buf);
    } else {
      zip.file(path, String(file.content));
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  await saveFile(blob, `project-${stamp}.zip`, { preferShare: isAndroid() });
}

// ==================== Настройки ====================
function openSettings() {
  const s = state.ai.settings;
  $('#set-apiUrl').value = s.apiUrl;
  $('#set-apiKey').value = s.apiKey;
  $('#set-model').value = s.model;
  $('#set-maxTokens').value = s.maxTokens;
  $('#set-temperature').value = s.temperature;
  $('#set-topP').value = s.topP;
  $('#set-presencePenalty').value = s.presencePenalty;
  $('#set-frequencyPenalty').value = s.frequencyPenalty;
  $('#set-reasoningEffort').value = s.reasoningEffort;
  $('#set-webSearch').checked = !!s.webSearch;
  const autoRetryCb = $('#set-autoRetry');
  if (autoRetryCb) autoRetryCb.checked = s.autoRetry !== false;
  $('#set-systemPrompt').value = s.systemPrompt;

  updateValLabels();
  DOM.testResult.textContent = '';
  DOM.testResult.className = 'test-result';
  DOM.settingsModal.classList.add('open');
  pushUIState();
}

function closeSettings() {
  if (!DOM.settingsModal.classList.contains('open')) return;
  DOM.settingsModal.classList.remove('open');
}

function updateValLabels() {
  $('#temp-val').textContent = $('#set-temperature').value;
  $('#topp-val').textContent = $('#set-topP').value;
  $('#pp-val').textContent = $('#set-presencePenalty').value;
  $('#fp-val').textContent = $('#set-frequencyPenalty').value;
}

function readSettingsFromForm() {
  return {
    apiUrl: $('#set-apiUrl').value.trim(),
    apiKey: $('#set-apiKey').value.trim(),
    model: $('#set-model').value.trim(),
    maxTokens: Number($('#set-maxTokens').value) || 4096,
    temperature: parseFloat($('#set-temperature').value),
    topP: parseFloat($('#set-topP').value),
    presencePenalty: parseFloat($('#set-presencePenalty').value),
    frequencyPenalty: parseFloat($('#set-frequencyPenalty').value),
    reasoningEffort: $('#set-reasoningEffort').value,
    webSearch: $('#set-webSearch').checked,
    autoRetry: $('#set-autoRetry') ? $('#set-autoRetry').checked : true,
    systemPrompt: $('#set-systemPrompt').value
  };
}

function saveSettingsFromForm() {
  Object.assign(state.ai.settings, readSettingsFromForm());
  state.ai.saveSettings();
  closeUIAndHistory();
}

function resetSettingsForm() {
  if (!confirm('Сбросить настройки к значениям по умолчанию?')) return;
  state.ai.resetSettings();
  openSettings();
}

// ==================== Проверка подключения ====================
async function testConnectionFromForm() {
  const override = readSettingsFromForm();

  if (!override.apiUrl || !override.apiKey) {
    DOM.testResult.className = 'test-result err';
    DOM.testResult.textContent = '❌ Заполните API URL и API Key';
    return;
  }

  DOM.testBtn.disabled = true;
  DOM.testResult.className = 'test-result checking';
  DOM.testResult.textContent = '⏳ Проверка подключения...';
  setAiStatus('checking', 'Проверка...');

  try {
    const res = await state.ai.testConnection(override);

    if (res.ok) {
      DOM.testResult.className = 'test-result ok';
      DOM.testResult.textContent = `✅ ${res.message}${res.usage ? ` · токенов: ${res.usage.total_tokens || '?'}` : ''}`;
      setAiStatus('ok', 'Подключение активно');

      // Обновляем статус в state.ai
      state.ai.settings.apiUrl = override.apiUrl;
      state.ai.settings.apiKey = override.apiKey;
      state.ai.settings.model = override.model;
    } else {
      DOM.testResult.className = 'test-result err';
      let msg = '❌ ' + res.error;
      if (res.hint) msg += '\n💡 ' + res.hint;
      DOM.testResult.innerHTML = escapeHtml(msg).replace(/\n/g, '<br>');
      setAiStatus('err', 'Ошибка подключения');
    }
  } catch (e) {
    DOM.testResult.className = 'test-result err';
    DOM.testResult.textContent = '❌ ' + (e.message || e);
    setAiStatus('err', 'Ошибка');
  } finally {
    DOM.testBtn.disabled = false;
  }
}

// ==================== UI Drawer / Back-button ====================
function pushUIState() {
  if (!state.uiOpen) {
    try { history.pushState({ aicsUI: true }, ''); } catch (_) {}
    state.uiOpen = true;
  }
}

function openDrawer(which) {
  closeAllUIDOM();
  if (which === 'sidebar') DOM.sidebar.classList.add('drawer-open');
  else if (which === 'files') DOM.filesPanel.classList.add('drawer-open');
  DOM.backdrop.classList.add('show');
  pushUIState();
}

function closeAllUIDOM() {
  DOM.sidebar.classList.remove('drawer-open');
  DOM.filesPanel.classList.remove('drawer-open');
  DOM.backdrop.classList.remove('show');
  DOM.settingsModal.classList.remove('open');
  if (DOM.runModal) DOM.runModal.classList.remove('open');
}

function closeUIAndHistory() {
  if (state.uiOpen) {
    try { history.back(); } catch (_) { closeAllUI(); }
  } else {
    closeAllUI();
  }
}

function closeAllUI() {
  state.uiOpen = false;
  closeAllUIDOM();
  if (DOM.runIframe) DOM.runIframe.srcdoc = '<!-- closed -->';
}

// ==================== Мобильные фичи ====================
function setupMobileFeatures() {
  if (DOM.menuBtn) {
    DOM.menuBtn.addEventListener('click', () => openDrawer('sidebar'));
  }
  if (DOM.closeFilesBtn) {
    DOM.closeFilesBtn.addEventListener('click', () => closeUIAndHistory());
  }
  if (DOM.backdrop) {
    DOM.backdrop.addEventListener('click', () => closeUIAndHistory());
  }

  window.addEventListener('popstate', () => {
    closeAllUI();
  });

  window.addEventListener('pagehide', () => {
    state.uiOpen = false;
  });

  // ============ Свайпы ============
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartT = 0;
  let tracking = false;
  const EDGE = 32;
  const MIN_DIST = 60;
  const MAX_TIME = 600;

  document.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchStartT = Date.now();
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!isMobile() || !tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    const dt = Date.now() - touchStartT;

    if (dt > MAX_TIME) return;
    if (Math.abs(dx) < MIN_DIST) return;
    if (Math.abs(dy) > Math.abs(dx)) return;

    const sidebarOpen = DOM.sidebar.classList.contains('drawer-open');
    const filesOpen = DOM.filesPanel.classList.contains('drawer-open');

    if (!sidebarOpen && !filesOpen &&
        touchStartX < EDGE && dx > MIN_DIST) {
      openDrawer('sidebar');
      return;
    }
    if (!sidebarOpen && !filesOpen &&
        touchStartX > window.innerWidth - EDGE && dx < -MIN_DIST) {
      openDrawer('files');
      return;
    }
    if (sidebarOpen && dx < -MIN_DIST) { closeUIAndHistory(); return; }
    if (filesOpen && dx > MIN_DIST) { closeUIAndHistory(); return; }
  }, { passive: true });

  // ============ Visual Viewport ============
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const updateViewport = () => {
      document.documentElement.style.setProperty('--vvh', vv.height + 'px');
      setTimeout(() => scrollToBottom(false), 120);
    };
    vv.addEventListener('resize', updateViewport);
    vv.addEventListener('scroll', updateViewport);
  }

  // ============ PWA install ============
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    if (DOM.installBtn) DOM.installBtn.style.display = 'inline-flex';
  });

  if (DOM.installBtn) {
    DOM.installBtn.addEventListener('click', async () => {
      const prompt = state.deferredInstall;
      if (!prompt) return;
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch (e) { console.warn(e); }
      finally {
        state.deferredInstall = null;
        DOM.installBtn.style.display = 'none';
      }
    });
  }

  window.addEventListener('appinstalled', () => {
    if (DOM.installBtn) DOM.installBtn.style.display = 'none';
    state.deferredInstall = null;
  });

  // ============ Service Worker ============
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then(
        (reg) => console.log('[SW] Зарегистрирован:', reg.scope),
        (err) => console.warn('[SW] Ошибка регистрации:', err)
      );
    });
  }

  if (DOM.input) {
    DOM.input.addEventListener('focus', () => {
      setTimeout(() => scrollToBottom(false), 200);
    });
  }
}

// ==================== Привязка событий ====================
function bindEvents() {
  DOM.newChatBtn.addEventListener('click', () => {
    createChat();
    if (isMobile()) closeUIAndHistory();
  });

  DOM.settingsBtn.addEventListener('click', openSettings);
  DOM.closeSettings.addEventListener('click', () => closeUIAndHistory());
  DOM.saveSettings.addEventListener('click', saveSettingsFromForm);
  DOM.resetSettings.addEventListener('click', resetSettingsForm);
  DOM.testBtn.addEventListener('click', testConnectionFromForm);

  // Клик по статусу ИИ — открыть настройки + проверка
  DOM.aiStatus.addEventListener('click', () => {
    openSettings();
    setTimeout(() => testConnectionFromForm(), 100);
  });

  // Запуск из карточки tool-call (делегирование)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.run-from-tool');
    if (btn && btn.dataset.path) {
      e.preventDefault();
      runFile(btn.dataset.path);
    }
  });

  // Модалка запуска
  DOM.runClose.addEventListener('click', () => closeUIAndHistory());
  DOM.runReload.addEventListener('click', reopenRunModal);
  DOM.runOpen.addEventListener('click', openRunInNewTab);
  DOM.runModal.addEventListener('click', (e) => {
    if (e.target === DOM.runModal) closeUIAndHistory();
  });

  // Табы
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      const content = document.querySelector(`.tab-content[data-tab="${name}"]`);
      if (content) content.classList.add('active');
    });
  });

  // Слайдеры
  ['#set-temperature', '#set-topP', '#set-presencePenalty', '#set-frequencyPenalty'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('input', updateValLabels);
  });

  // Отправка
  DOM.sendBtn.addEventListener('click', sendMessage);
  DOM.stopBtn.addEventListener('click', stopGeneration);

  DOM.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  });

  DOM.input.addEventListener('input', () => {
    DOM.input.style.height = 'auto';
    DOM.input.style.height = Math.min(DOM.input.scrollHeight, 160) + 'px';
  });

  // Файлы
  DOM.importBtn.addEventListener('click', () => DOM.fileInput.click());
  DOM.fileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length) {
      await handleImportedFiles(e.target.files);
      e.target.value = '';
    }
  });
  DOM.exportAllBtn.addEventListener('click', exportAll);

  DOM.toggleFilesBtn.addEventListener('click', () => {
    if (isMobile()) openDrawer('files');
    else DOM.app.classList.toggle('files-hidden');
  });

  // Drag & drop
  DOM.filesPanel.addEventListener('dragover', (e) => {
    e.preventDefault();
    DOM.filesPanel.style.background = 'var(--bg-3)';
  });
  DOM.filesPanel.addEventListener('dragleave', () => {
    DOM.filesPanel.style.background = '';
  });
  DOM.filesPanel.addEventListener('drop', async (e) => {
    e.preventDefault();
    DOM.filesPanel.style.background = '';
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      await handleImportedFiles(e.dataTransfer.files);
    }
  });

  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    if (e.target.closest('.files-panel')) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault();
      await handleImportedFiles(e.dataTransfer.files);
      if (isMobile()) openDrawer('files');
    }
  });

  // Закрытие модалки настроек по клику вне
  DOM.settingsModal.addEventListener('click', (e) => {
    if (e.target === DOM.settingsModal) closeUIAndHistory();
  });

  // Esc — закрыть верхний UI
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const anyOpen =
        DOM.settingsModal.classList.contains('open') ||
        DOM.runModal.classList.contains('open') ||
        DOM.sidebar.classList.contains('drawer-open') ||
        DOM.filesPanel.classList.contains('drawer-open');
      if (anyOpen) closeUIAndHistory();
    }
  });

  // Ориентация
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (!isMobile()) closeAllUI();
    }, 150);
  });

  const mq = window.matchMedia('(min-width: 901px)');
  const handleMq = (e) => {
    if (e.matches) {
      closeAllUI();
      DOM.backdrop.classList.remove('show');
    }
  };
  if (mq.addEventListener) mq.addEventListener('change', handleMq);
  else if (mq.addListener) mq.addListener(handleMq);
}

// ==================== Автоподключение при старте ====================
async function autoCheckOnStart() {
  const s = state.ai.settings;
  if (!s.apiUrl || !s.apiKey) {
    setAiStatus('idle', 'API не настроен — откройте настройки');
    return;
  }
  setAiStatus('checking', 'Проверка подключения...');
  try {
    const res = await state.ai.testConnection();
    if (res.ok) setAiStatus('ok', `Подключение активно · ${res.model}`);
    else setAiStatus('err', 'Ошибка: ' + (res.error || ''));
  } catch (e) {
    setAiStatus('err', 'Ошибка: ' + e.message);
  }
}

// ==================== Инициализация ====================
function init() {
  cacheDom();
  loadChats();
  if (state.chats.length === 0) {
    createChat();
  } else {
    state.currentChatId = state.chats[0].id;
  }
  renderChatList();
  renderChatTitle();
  renderMessages();
  renderFiles();
  bindEvents();
  setupMobileFeatures();

  // Стартовая проверка подключения в фоне
  setTimeout(autoCheckOnStart, 500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();