'use strict';

(() => {
  const DEVICE_ID = 'lumi_001';
  let configuredMode = 'ru-RU';
  let activeLanguage = 'ru-RU';
  let fallbackLanguage = 'ru-RU';
  let pendingDetectedLanguage = null;

  let autoRecorder = null;
  let autoStream = null;
  let autoChunks = [];
  let autoRecording = false;
  let autoStarting = false;
  let autoReleaseRequested = false;
  let autoStartedAt = 0;
  let autoStopTimer = null;
  let suppressAutoMouseUntil = 0;

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
      activeLanguage = data.active_language || activeLanguage || fallbackLanguage;
      applyModeToDemo();
    } catch (err) {
      console.warn('[Demo Language] Cannot load parent language:', err.message);
      renderIndicator();
    }
  }

  function chooseRecorderMimeType() {
    if (!window.MediaRecorder) return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  function clearAutoStopTimer() {
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = null;
    }
  }

  function stopAutoTracks() {
    if (autoStream) {
      autoStream.getTracks().forEach(track => track.stop());
      autoStream = null;
    }
  }

  function resetAutoMicUi() {
    clearAutoStopTimer();
    autoRecording = false;
    autoStarting = false;
    autoReleaseRequested = false;
    try {
      micBtn.classList.remove('recording');
      micBtn.innerHTML = '<svg id="micIcon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="28" height="28" style="pointer-events:none;user-select:none"><rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor"/><path d="M5 10a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="17" x2="12" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="22" x2="16" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      msgInput.placeholder = 'Напиши Lumi...';
    } catch (_) {}
  }

  async function sendAutoAudio(blob) {
    const serverInput = document.getElementById('serverUrl');
    const base = String(serverInput?.value || location.origin).trim().replace(/\/$/, '');

    bubbleText.textContent = '🎧 Определяю язык и распознаю речь...';
    setBear('thinking');

    const response = await fetch(`${base}/api/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'audio/webm',
        'x-device-id': DEVICE_ID,
      },
      body: blob,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `STT HTTP ${response.status}`);
    if (!data.text) throw new Error('Речь не распознана');

    pendingDetectedLanguage = data.detected_language || null;
    if (pendingDetectedLanguage) activeLanguage = pendingDetectedLanguage;
    renderIndicator();

    msgInput.value = data.text;
    bubbleText.textContent = data.text;
    await sendMessage();
  }

  async function finishAutoRecording() {
    const mimeType = autoRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(autoChunks, { type: mimeType });
    autoChunks = [];
    stopAutoTracks();
    resetAutoMicUi();

    if (blob.size < 1000) {
      bubbleText.textContent = 'Я не расслышала. Попробуй ещё раз.';
      setBear('');
      return;
    }

    try {
      await sendAutoAudio(blob);
    } catch (err) {
      console.error('[AUTO Voice]', err);
      bubbleText.textContent = `😿 ${err.message}`;
      setBear('');
    }
  }

  async function startAutoRecording() {
    if (configuredMode !== 'auto' || autoRecording || autoStarting || isProcessing) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      bubbleText.textContent = 'Этот браузер не поддерживает серверное AUTO-распознавание.';
      return;
    }

    autoStarting = true;
    autoReleaseRequested = false;
    autoChunks = [];

    try {
      try {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
      } catch (_) {}
      audioWrap.className = 'audio-wrap';
      setBear('');

      autoStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const mimeType = chooseRecorderMimeType();
      autoRecorder = mimeType
        ? new MediaRecorder(autoStream, { mimeType })
        : new MediaRecorder(autoStream);

      autoRecorder.ondataavailable = event => {
        if (event.data?.size) autoChunks.push(event.data);
      };
      autoRecorder.onerror = event => {
        console.error('[AUTO Voice recorder]', event.error || event);
      };
      autoRecorder.onstop = () => {
        finishAutoRecording().catch(err => {
          bubbleText.textContent = `😿 ${err.message}`;
          setBear('');
        });
      };

      autoRecorder.start();
      autoStartedAt = Date.now();
      autoRecording = true;
      autoStarting = false;

      micBtn.classList.add('recording');
      micBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26" style="pointer-events:none;user-select:none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
      bubbleText.textContent = '🎤 AUTO: слушаю...';
      msgInput.value = '';
      setBear('listening');

      autoStopTimer = setTimeout(() => stopAutoRecording(), 23000);
      if (autoReleaseRequested) stopAutoRecording();
    } catch (err) {
      stopAutoTracks();
      resetAutoMicUi();
      bubbleText.textContent = err.name === 'NotAllowedError'
        ? '🎤 Разреши доступ к микрофону в браузере'
        : `🎤 Ошибка: ${err.message}`;
    }
  }

  function stopAutoRecording() {
    if (configuredMode !== 'auto') return;
    if (autoStarting && !autoRecording) {
      autoReleaseRequested = true;
      return;
    }
    if (!autoRecorder || autoRecorder.state !== 'recording') return;

    clearAutoStopTimer();
    const elapsed = Date.now() - autoStartedAt;
    const stopNow = () => {
      if (autoRecorder?.state === 'recording') autoRecorder.stop();
    };
    if (elapsed < 500) setTimeout(stopNow, 500 - elapsed);
    else stopNow();
  }

  function interceptAutoMic(event, action) {
    if (configuredMode !== 'auto') return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.type === 'touchstart' || event.type === 'touchend' || event.type === 'touchcancel') {
      suppressAutoMouseUntil = Date.now() + 900;
    }
    if (event.type.startsWith('mouse') && Date.now() < suppressAutoMouseUntil) return;

    if (action === 'start') startAutoRecording();
    else stopAutoRecording();
  }

  const mic = document.getElementById('micBtn');
  if (mic) {
    mic.disabled = false;
    mic.style.opacity = '';
    mic.addEventListener('mousedown', event => interceptAutoMic(event, 'start'), true);
    mic.addEventListener('mouseup', event => interceptAutoMic(event, 'stop'), true);
    mic.addEventListener('mouseleave', event => interceptAutoMic(event, 'stop'), true);
    mic.addEventListener('touchstart', event => interceptAutoMic(event, 'start'), { capture: true, passive: false });
    mic.addEventListener('touchend', event => interceptAutoMic(event, 'stop'), { capture: true, passive: false });
    mic.addEventListener('touchcancel', event => interceptAutoMic(event, 'stop'), { capture: true, passive: false });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    if (/\/chat(?:\?|$)/.test(url) && pendingDetectedLanguage && args[1]?.body) {
      try {
        const payload = JSON.parse(args[1].body);
        payload.detected_language = pendingDetectedLanguage;
        args[1] = { ...args[1], body: JSON.stringify(payload) };
      } catch (_) {}
      pendingDetectedLanguage = null;
    }

    const response = await originalFetch(...args);
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
