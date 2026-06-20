'use strict';

(() => {
  const DEVICE_ID = 'lumi_001';
  let configuredMode = 'ru-RU';
  let activeLanguage = 'ru-RU';
  let fallbackLanguage = 'ru-RU';

  function shortLabel(lang) {
    if (lang === 'ro-RO') return 'RO';
    if (lang === 'en-US') return 'ENG';
    return 'RU';
  }

  function ensureIndicator() {
    const row = document.querySelector('.lang-row');
    if (!row) return null;
    let indicator = document.getElementById('languageIndicator');
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.id = 'languageIndicator';
      indicator.className = 'lang-btn active';
      indicator.style.cursor = 'default';
      indicator.title = 'Язык задаётся в родительской панели';
      row.replaceChildren(indicator);
    }
    return indicator;
  }

  function renderIndicator() {
    const indicator = ensureIndicator();
    if (!indicator) return;
    indicator.textContent = configuredMode === 'auto'
      ? `AUTO → ${shortLabel(activeLanguage || fallbackLanguage)}`
      : shortLabel(configuredMode);
  }

  function applyModeToDemo() {
    const indicator = ensureIndicator();
    if (typeof window.setLang === 'function' && indicator) window.setLang(configuredMode, indicator);
    renderIndicator();
  }

  async function loadLanguageMode() {
    const serverInput = document.getElementById('serverUrl');
    const base = String(serverInput?.value || location.origin).trim().replace(/\/$/, '');
    try {
      const response = await fetch(`${base}/api/device/language?device_id=${encodeURIComponent(DEVICE_ID)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      configuredMode = data.language_mode || 'ru-RU';
      fallbackLanguage = data.auto_language_fallback || 'ru-RU';
      activeLanguage = data.active_language || fallbackLanguage;
      applyModeToDemo();
    } catch (err) {
      console.warn('[Demo Language] Cannot load parent language:', err.message);
      renderIndicator();
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (/\/chat(?:\?|$)/.test(url)) {
      response.clone().json().then(data => {
        if (data?.language_mode) configuredMode = data.language_mode;
        if (data?.active_language) activeLanguage = data.active_language;
        renderIndicator();
      }).catch(() => {});
    }
    return response;
  };

  loadLanguageMode();
  setInterval(loadLanguageMode, 15000);
})();
