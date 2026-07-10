'use strict';

(() => {
  const FIXED_LANGUAGES = ['ru-RU', 'ro-RO', 'en-US', 'es-ES', 'fr-FR', 'it-IT'];

  function autoOptionText(consoleLang) {
    if (consoleLang === 'ro-RO') return 'AUTO — răspunde în limba copilului';
    if (consoleLang === 'en-US') return "AUTO — reply in the child's language";
    if (consoleLang === 'es-ES') return 'AUTO — responder en el idioma del niño';
    if (consoleLang === 'fr-FR') return "AUTO — répondre dans la langue de l'enfant";
    if (consoleLang === 'it-IT') return 'AUTO — rispondi nella lingua del bambino';
    return 'AUTO — отвечать на языке ребёнка';
  }

  function fallbackText(consoleLang) {
    if (consoleLang === 'ro-RO') return {
      label: 'Dacă limba nu este determinată',
      help: 'Se folosește la începutul conversației și pentru cuvinte scurte neclare.',
    };
    if (consoleLang === 'en-US') return {
      label: 'If the language is unclear',
      help: 'Used at the start of a conversation and for short ambiguous words.',
    };
    if (consoleLang === 'es-ES') return {
      label: 'Si el idioma no está claro',
      help: 'Se usa al principio de la conversación y para palabras cortas ambiguas.',
    };
    if (consoleLang === 'fr-FR') return {
      label: "Si la langue n'est pas claire",
      help: "Utilisé au début de la conversation et pour les mots courts ambigus.",
    };
    if (consoleLang === 'it-IT') return {
      label: 'Se la lingua non è chiara',
      help: "Usato all'inizio della conversazione e per parole brevi ambigue.",
    };
    return {
      label: 'Если язык не определён',
      help: 'Используется в начале разговора и для коротких неоднозначных слов.',
    };
  }

  function currentConsoleLanguage() {
    try {
      return localStorage.getItem('lumi_parent_console_lang') || 'ru-RU';
    } catch (_) {
      return 'ru-RU';
    }
  }

  function childButtonText(consoleLang) {
    if (consoleLang === 'ro-RO') return {
      save: 'Salvează datele copilului',
      clear: 'Șterge datele copilului',
    };
    if (consoleLang === 'en-US') return {
      save: 'Save child data',
      clear: 'Clear child data',
    };
    if (consoleLang === 'es-ES') return {
      save: 'Guardar datos del niño',
      clear: 'Borrar datos del niño',
    };
    if (consoleLang === 'fr-FR') return {
      save: "Enregistrer les données de l'enfant",
      clear: "Effacer les données de l'enfant",
    };
    if (consoleLang === 'it-IT') return {
      save: 'Salva dati del bambino',
      clear: 'Cancella dati del bambino',
    };
    return {
      save: 'Сохранить данные ребёнка',
      clear: 'Очистить данные ребёнка',
    };
  }

  function relabelChildButtons() {
    const labels = childButtonText(currentConsoleLanguage());
    const saveButton = document.querySelector('#childPanel button[onclick="saveProfile()"]');
    const clearButton = document.querySelector('#childPanel button[onclick="clearChildProfile()"]');
    if (saveButton) saveButton.textContent = labels.save;
    if (clearButton) clearButton.textContent = labels.clear;
  }

  function localizeControls() {
    const languageSelect = document.getElementById('language');
    const autoOption = [...(languageSelect?.options || [])].find(option => option.value === 'auto');
    if (autoOption) autoOption.textContent = autoOptionText(currentConsoleLanguage());
    const text = fallbackText(currentConsoleLanguage());
    const label = document.getElementById('autoLanguageFallbackLabel');
    const help = document.getElementById('autoLanguageFallbackHelp');
    if (label) label.textContent = text.label;
    if (help) help.textContent = text.help;
    relabelChildButtons();
  }

  function toggleFallback() {
    const isAuto = document.getElementById('language')?.value === 'auto';
    document.getElementById('autoLanguageFallbackWrap')?.classList.toggle('hidden', !isAuto);
  }

  function ensureControls() {
    document.querySelector('#childPanel button[onclick="editChildProfile()"]')?.remove();
    relabelChildButtons();

    const languageSelect = document.getElementById('language');
    if (!languageSelect) return;

    let autoOption = [...languageSelect.options].find(option => option.value === 'auto');
    if (!autoOption) {
      autoOption = document.createElement('option');
      autoOption.value = 'auto';
      languageSelect.appendChild(autoOption);
    }

    if (!document.getElementById('autoLanguageFallbackWrap')) {
      const wrap = document.createElement('div');
      wrap.id = 'autoLanguageFallbackWrap';
      wrap.className = 'hidden';
      wrap.innerHTML = `
        <label id="autoLanguageFallbackLabel"></label>
        <select id="auto_language_fallback">
          <option value="ru-RU">Русский</option>
          <option value="ro-RO">Română</option>
          <option value="en-US">English</option>
          <option value="es-ES">Español</option>
          <option value="fr-FR">Français</option>
          <option value="it-IT">Italiano</option>
        </select>
        <p id="autoLanguageFallbackHelp" class="small"></p>
      `;
      languageSelect.closest('div')?.insertAdjacentElement('afterend', wrap);
    }

    // .onchange = ... тут ПОЛНОСТЬЮ заменяет inline onchange="setLanguageFromMain()" из
    // HTML — после первого loadState() смена языка внизу переставала обновлять голос
    // (#voice_id оставался со старого языка) и консольную локаль. Явно вызываем оба.
    languageSelect.onchange = () => {
      toggleFallback();
      const chosen = languageSelect.value === 'auto'
        ? document.getElementById('auto_language_fallback')?.value || 'ru-RU'
        : languageSelect.value;
      // UI_TEXT переведён на все 6 языков игрушки — applyConsoleLocale можно звать всегда.
      // 'chosen' уже резолвлен: сам язык, либо (если выбран 'auto') язык фолбэка —
      // 'auto' сам по себе не язык, UI_TEXT['auto'] не существует.
      if (typeof window.applyConsoleLocale === 'function') window.applyConsoleLocale(chosen);
      if (typeof window.refreshVoiceOptions === 'function') window.refreshVoiceOptions();
      if (typeof window.applyLanguageTopicDefaults === 'function') window.applyLanguageTopicDefaults(chosen);
      if (typeof window.updateUnsavedIndicator === 'function') window.updateUnsavedIndicator();
    };

    document.getElementById('auto_language_fallback')?.addEventListener('change', () => {
      if (languageSelect.value === 'auto' && typeof window.applyLanguageTopicDefaults === 'function') {
        window.applyLanguageTopicDefaults(document.getElementById('auto_language_fallback').value);
      }
      if (typeof window.updateUnsavedIndicator === 'function') window.updateUnsavedIndicator();
    });

    localizeControls();
    toggleFallback();
  }

  window.setLanguageFromTop = async function consoleLanguageOnly(language) {
    const toyTypeBefore = typeof window.getToyTypeValue === 'function' ? window.getToyTypeValue() : null;
    if (typeof window.applyConsoleLocale === 'function') window.applyConsoleLocale(language);
    if (toyTypeBefore && typeof window.setToyTypeValue === 'function') window.setToyTypeValue(toyTypeBefore);
    localizeControls();
    toggleFallback();
    if (typeof window.renderSavedProfiles === 'function') {
      window.renderSavedProfiles(window.lastSavedProfiles || [], window.lastParentState?.profile || null);
    }
    if (typeof window.renderStatusOverview === 'function') window.renderStatusOverview(window.lastParentState || {});
    if (typeof window.renderRuntime === 'function') window.renderRuntime(window.lastRuntime || {});
    if (window.lastAnalytics && typeof window.renderAnalytics === 'function') window.renderAnalytics(window.lastAnalytics);
  };

  const originalLoadState = window.loadState;
  if (typeof originalLoadState === 'function') {
    window.loadState = async function loadStateWithAutoLanguage() {
      await originalLoadState();
      ensureControls();
      try {
        if (typeof window.api === 'function') {
          const data = await window.api('/api/parent/state');
          const settings = data.settings || {};
          const languageSelect = document.getElementById('language');
          if (languageSelect && ['auto', ...FIXED_LANGUAGES].includes(settings.language)) languageSelect.value = settings.language;
          const fallback = document.getElementById('auto_language_fallback');
          if (fallback) fallback.value = FIXED_LANGUAGES.includes(settings.auto_language_fallback)
            ? settings.auto_language_fallback
            : 'ru-RU';
        }
      } catch (err) {
        console.warn('[Parent Language] Cannot load AUTO fallback:', err.message);
      }
      toggleFallback();
      relabelChildButtons();
    };
  }

  const originalSaveSettings = window.saveSettings;
  if (typeof originalSaveSettings === 'function') {
    window.saveSettings = async function saveSettingsWithAutoLanguage() {
      await originalSaveSettings();
      if (typeof window.api !== 'function') return;
      await window.api('/api/parent/settings', {
        method: 'POST',
        body: JSON.stringify({
          language: document.getElementById('language')?.value || 'ru-RU',
          auto_language_fallback: document.getElementById('auto_language_fallback')?.value || 'ru-RU',
        }),
      });
      toggleFallback();
    };
  }

  ensureControls();
})();
