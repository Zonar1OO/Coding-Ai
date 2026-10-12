/* ============================================================
 *  AIClient — работа с OpenAI-совместимыми API
 *  + Диагностика сетевых ошибок
 *  + testConnection() — проверка подключения
 * ============================================================ */

(function (global) {
  'use strict';

  const DEFAULT_SYSTEM_PROMPT = `Ты — AI-ассистент программиста, встроенный в среду разработки "AI Code Studio".

У тебя есть ВИРТУАЛЬНЫЙ ТЕРМИНАЛ с доступом к файловой системе проекта.
Ты можешь создавать, перезаписывать, читать и удалять файлы.

Чтобы выполнить действие над файлами, добавь в свой ответ специальный блок:

\`\`\`tool:write_file
{"path": "src/index.js", "content": "console.log('hello');"}
\`\`\`

\`\`\`tool:read_file
{"path": "src/index.js"}
\`\`\`

\`\`\`tool:delete_file
{"path": "src/old.js"}
\`\`\`

\`\`\`tool:list_files
{}
\`\`\`

ПРАВИЛА:
1. Удаляй файлы ТОЛЬКО если пользователь прямо просит удалить.
2. Всегда указывай полный путь к файлу, используя прямой слэш "/".
3. Внутри "content" используй \\n для переносов строк (это JSON-строка).
4. После блока с инструментом кратко объясни, что ты сделал.
5. Ты можешь использовать несколько блоков-инструментов в одном ответе.
6. Если нужно — сначала читай существующий файл (read_file), затем перезаписывай его (write_file).
7. Пиши качественный, рабочий код с комментариями там, где это уместно.

Отвечай на языке пользователя. Будь кратким, но информативным.`;

  /* ============================================================
   *  Диагностика сетевых ошибок fetch
   * ============================================================ */
  function diagnoseFetchError(url) {
    const tips = [];

    if (location.protocol === 'file:') {
      tips.push(
        '⚠ Страница открыта через file:// — браузер блокирует fetch. ' +
        'Запустите через локальный сервер (например, "npx serve" или Python http.server) или загрузите на хостинг.'
      );
    }

    if (location.protocol === 'https:' && /^http:\/\//i.test(url)) {
      tips.push(
        '⚠ Смешанный контент: HTTPS-страница не может обращаться к HTTP-API. Используйте https:// в URL.'
      );
    }

    if (!navigator.onLine) {
      tips.push('⚠ Нет подключения к интернету.');
    }

    let host = '';
    try { host = new URL(url).host; } catch (_) {}

    if (host && (host === 'localhost' || host.startsWith('127.') || host.startsWith('192.168.'))) {
      tips.push(
        `⚠ API на ${host} — убедитесь, что сервер запущен и разрешает CORS-запросы с этого источника.`
      );
    }

    if (!tips.length) {
      tips.push(
        'Возможные причины: 1) неверный URL (обычно нужен путь /v1/chat/completions); ' +
        '2) сервер API не разрешает CORS-запросы из браузера; 3) неверный ключ или модель; ' +
        '4) блокировка браузерным расширением; 5) сервер API недоступен.'
      );
    }

    return tips.join(' ');
  }

  /* ============================================================
   *  Понятные сообщения по HTTP-коду
   * ============================================================ */
  function humanizeHttpError(status, raw) {
    let short = '';
    try {
      const parsed = JSON.parse(raw);
      short = parsed?.error?.message || parsed?.message || parsed?.error || '';
      if (typeof short !== 'string') short = JSON.stringify(short);
    } catch (_) {
      short = (raw || '').slice(0, 300);
    }

    switch (status) {
      case 400:
        return `400 Bad Request — неверный запрос. ${short || 'Проверьте модель и параметры.'}`;
      case 401:
        return `401 Unauthorized — неверный API Key. ${short || 'Проверьте ключ в настройках.'}`;
      case 402:
        return `402 Payment Required — закончились средства / нужен платный тариф. ${short}`;
      case 403:
        return `403 Forbidden — доступ запрещён. ${short || 'Возможно, ключ не имеет прав на эту модель.'}`;
      case 404:
        return `404 Not Found — URL или модель не найдены. ${short || 'Проверьте URL (обычно заканчивается на /v1/chat/completions).'}`;
      case 413:
        return `413 Payload Too Large — слишком большой запрос. ${short || 'Уменьшите историю чата или размер контекста.'}`;
      case 422:
        return `422 Unprocessable Entity — некорректные параметры. ${short}`;
      case 429:
        return `429 Too Many Requests — превышен лимит запросов. ${short || 'Подождите и повторите.'}`;
      case 500:
      case 502:
      case 503:
      case 504:
        return `${status} — сервер API временно недоступен. ${short || 'Попробуйте позже.'}`;
      default:
        return `${status} — ${short || 'неизвестная ошибка API.'}`;
    }
  }

  class AIClient {
    constructor() {
      this.defaults = {
        apiUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: '',
        model: 'gpt-4o-mini',
        maxTokens: 4096,
        temperature: 0.7,
        topP: 1,
        presencePenalty: 0,
        frequencyPenalty: 0,
        reasoningEffort: '',
        webSearch: false,
        autoRetry: true,
        systemPrompt: DEFAULT_SYSTEM_PROMPT
      };
      this.settings = Object.assign({}, this.defaults);
      this.loadSettings();
    }

    loadSettings() {
      try {
        const saved = localStorage.getItem('aics_settings');
        if (saved) {
          const parsed = JSON.parse(saved);
          Object.assign(this.settings, parsed);
        }
      } catch (e) {
        console.warn('Не удалось загрузить настройки:', e);
      }
    }

    saveSettings() {
      try {
        localStorage.setItem('aics_settings', JSON.stringify(this.settings));
      } catch (e) {
        console.warn('Не удалось сохранить настройки:', e);
      }
    }

    resetSettings() {
      this.settings = Object.assign({}, this.defaults);
      this.saveSettings();
    }

    /* ============================================================
     *  Проверка подключения — не сохраняет настройки,
     *  возвращает { ok, latency, status, model, error, hint }
     * ============================================================ */
    async testConnection(override = {}) {
      const s = Object.assign({}, this.settings, override);

      // --- Валидация ---
      if (!s.apiUrl) return { ok: false, error: 'Не задан API URL' };
      if (!s.apiKey) return { ok: false, error: 'Не задан API Key' };

      if (!/^https?:\/\//i.test(s.apiUrl)) {
        return {
          ok: false,
          error: 'URL должен начинаться с http:// или https://',
          hint: 'Пример: https://api.openai.com/v1/chat/completions'
        };
      }

      if (location.protocol === 'https:' && /^http:\/\//i.test(s.apiUrl)) {
        return {
          ok: false,
          error: 'HTTPS-страница не может обращаться к HTTP-API (mixed content)',
          hint: 'Используйте https:// в URL или откройте приложение по http://'
        };
      }

      // --- Подготовка запроса ---
      const payload = {
        model: s.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        stream: false
      };

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.apiKey
      };

      if (/openrouter\.ai/.test(s.apiUrl)) {
        headers['HTTP-Referer'] = location.origin || 'http://localhost';
        headers['X-Title'] = 'AI Code Studio';
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const t0 = performance.now();
      let response;

      try {
        response = await fetch(s.apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          return { ok: false, error: 'Таймаут 30 секунд — сервер не отвечает' };
        }
        return {
          ok: false,
          error: 'Сетевая ошибка: ' + err.message,
          hint: diagnoseFetchError(s.apiUrl)
        };
      }
      clearTimeout(timeout);

      const latency = Math.round(performance.now() - t0);

      if (!response.ok) {
        let raw = '';
        try { raw = await response.text(); } catch (_) {}
        return {
          ok: false,
          status: response.status,
          latency,
          error: humanizeHttpError(response.status, raw),
          hint: response.status === 401 || response.status === 403
            ? 'Проверьте API Key в настройках. Убедитесь, что ключ активен и не имеет лишних символов/пробелов.'
            : (response.status === 404
              ? 'URL, вероятно, неполный. Обычно endpoint: /v1/chat/completions. Пример: https://api.openai.com/v1/chat/completions'
              : null)
        };
      }

      let data = null;
      try { data = await response.json(); } catch (_) {}

      const actualModel = data?.model || s.model;
      const usage = data?.usage || null;

      return {
        ok: true,
        latency,
        status: response.status,
        model: actualModel,
        usage,
        message: `Подключение успешно · ${latency} мс · модель: ${actualModel}`
      };
    }

    /* ============================================================
     *  Потоковая генерация
     *  Автоповтор 1 раз при сетевой ошибке (если autoRetry !== false)
     * ============================================================ */
    async streamChat(messages, handlers = {}) {
      const { onToken, onReasoning, signal } = handlers;
      const s = this.settings;

      // --- Валидация ---
      if (!s.apiUrl) throw new Error('Не задан API URL. Откройте ⚙️ Настройки.');
      if (!s.apiKey) throw new Error('Не задан API Key. Откройте ⚙️ Настройки.');
      if (!s.model) throw new Error('Не задана модель. Откройте ⚙️ Настройки.');

      if (!/^https?:\/\//i.test(s.apiUrl)) {
        throw new Error('URL API должен начинаться с http:// или https://');
      }

      // --- Тело ---
      const body = {
        model: s.model,
        messages: messages,
        stream: true
      };

      const num = (v) => (v === '' || v === null || v === undefined) ? null : Number(v);

      if (num(s.maxTokens)) body.max_tokens = num(s.maxTokens);
      if (num(s.temperature) !== null) body.temperature = num(s.temperature);
      if (num(s.topP) !== null) body.top_p = num(s.topP);
      if (num(s.presencePenalty)) body.presence_penalty = num(s.presencePenalty);
      if (num(s.frequencyPenalty)) body.frequency_penalty = num(s.frequencyPenalty);
      if (s.reasoningEffort) body.reasoning_effort = s.reasoningEffort;

      if (s.webSearch) {
        body.tools = [{ type: 'web_search' }];
        body.tool_choice = 'auto';
      }

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.apiKey
      };

      if (/openrouter\.ai/.test(s.apiUrl)) {
        headers['HTTP-Referer'] = location.origin || 'http://localhost';
        headers['X-Title'] = 'AI Code Studio';
      }

      // --- Попытка с опциональным ретраем ---
      const attempts = s.autoRetry === false ? 1 : 2;
      let lastNetworkError = null;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        let response;
        try {
          response = await fetch(s.apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal
          });
        } catch (err) {
          if (err.name === 'AbortError') throw err;

          lastNetworkError = err;

          if (attempt < attempts) {
            console.warn(`Сетевая ошибка (попытка ${attempt}/${attempts}), повтор через 1 сек...`);
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          const hint = diagnoseFetchError(s.apiUrl);
          const e = new Error('Сетевая ошибка: ' + err.message + '\n\n' + hint);
          e.cause = err;
          throw e;
        }

        if (!response.ok) {
          let raw = '';
          try { raw = await response.text(); } catch (_) {}
          const msg = humanizeHttpError(response.status, raw);
          const e = new Error(msg);
          e.status = response.status;
          throw e;
        }

        // Стриминг или fallback JSON
        if (!response.body || !response.body.getReader) {
          const data = await response.json();
          const text = data?.choices?.[0]?.message?.content || '';
          if (onToken) onToken(text);
          return text;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullText = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line) continue;

              let data = line;
              if (line.startsWith('data:')) data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;

              let json;
              try { json = JSON.parse(data); } catch (_) { continue; }

              const choice = json.choices && json.choices[0];
              if (!choice) continue;
              const delta = choice.delta || choice.message || {};

              const reasoning =
                delta.reasoning_content ||
                delta.reasoning ||
                choice.reasoning_content ||
                null;
              if (reasoning && onReasoning) onReasoning(reasoning);

              if (delta.content) {
                fullText += delta.content;
                if (onToken) onToken(delta.content);
              }
            }
          }
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          throw err;
        }

        return fullText;
      }

      // Сюда не должны попасть, но на всякий случай
      throw lastNetworkError || new Error('Не удалось выполнить запрос');
    }
  }

  global.AIClient = AIClient;
  global.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
  global.diagnoseFetchError = diagnoseFetchError;
})(window);