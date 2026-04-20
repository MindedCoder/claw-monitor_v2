(function () {
  var state = {
    bpm: 100,
    beatsPerBar: 4,
    isPlaying: false,
    currentBeat: 1,
    accent: true,
    voiceMode: 'off',
    volume: 0.75
  };

  var bpmValue = document.getElementById('bpmValue');
  var bpmSlider = document.getElementById('bpmSlider');
  var decreaseBpm = document.getElementById('decreaseBpm');
  var increaseBpm = document.getElementById('increaseBpm');
  var beatsSelect = document.getElementById('beatsSelect');
  var voiceMode = document.getElementById('voiceMode');
  var accentToggle = document.getElementById('accentToggle');
  var volumeSlider = document.getElementById('volumeSlider');
  var startStop = document.getElementById('startStop');
  var pulseCore = document.getElementById('pulseCore');
  var currentBeat = document.getElementById('currentBeat');
  var beatDots = document.getElementById('beatDots');
  var statusText = document.getElementById('statusText');
  var presetButtons = document.getElementById('presetButtons');

  var audioCtx = null;
  var nextTickTimeout = null;

  function setStatus(text) {
    statusText.textContent = text;
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended' && audioCtx.resume) {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function syncPresetButtons() {
    var buttons = presetButtons.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', Number(buttons[i].getAttribute('data-bpm')) === state.bpm);
    }
  }

  function renderBeats() {
    beatDots.innerHTML = '';
    for (var i = 1; i <= 6; i++) {
      var dot = document.createElement('div');
      dot.className = 'beat-dot';
      if (i <= state.beatsPerBar) {
        if (i === state.currentBeat) dot.className += ' current';
        if (i === 1 && state.accent) dot.className += ' accent';
      }
      beatDots.appendChild(dot);
    }
  }

  function setBpm(value) {
    var bpm = Number(value) || 100;
    if (bpm < 30) bpm = 30;
    if (bpm > 240) bpm = 240;
    state.bpm = bpm;
    bpmValue.textContent = String(bpm);
    bpmSlider.value = String(bpm);
    syncPresetButtons();
    if (state.isPlaying) restartTicking();
  }

  function getBeatLabel(beat) {
    var labels = {
      cn: ['一', '二', '三', '四', '五', '六'],
      en: ['one', 'two', 'three', 'four', 'five', 'six'],
      count: ['1', '2', '3', '4', '5', '6']
    };
    if (!labels[state.voiceMode]) return '';
    return labels[state.voiceMode][beat - 1] || String(beat);
  }

  function speakBeat(beat) {
    if (state.voiceMode === 'off' || !window.speechSynthesis || document.hidden) return;
    try {
      window.speechSynthesis.cancel();
      var utterance = new SpeechSynthesisUtterance(getBeatLabel(beat));
      utterance.lang = state.voiceMode === 'cn' ? 'zh-CN' : 'en-US';
      utterance.volume = state.volume;
      utterance.rate = 1;
      utterance.pitch = beat === 1 ? 1.15 : 1;
      window.speechSynthesis.speak(utterance);
    } catch (e) {}
  }

  function playClick(isAccent) {
    var ctx = ensureAudioContext();
    if (!ctx) return;
    var now = ctx.currentTime;
    var oscillator = ctx.createOscillator();
    var gainNode = ctx.createGain();
    oscillator.type = isAccent ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(isAccent ? 1320 : 880, now);
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(state.volume * (isAccent ? 0.34 : 0.22), now + 0.005);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.1);
  }

  function animateBeat(isAccent) {
    currentBeat.textContent = String(state.currentBeat);
    pulseCore.classList.remove('active');
    pulseCore.classList.remove('accent');
    void pulseCore.offsetWidth;
    pulseCore.classList.add('active');
    if (isAccent) pulseCore.classList.add('accent');
    setTimeout(function () {
      pulseCore.classList.remove('active');
      pulseCore.classList.remove('accent');
    }, 120);
  }

  function clearTimer() {
    if (nextTickTimeout) {
      clearTimeout(nextTickTimeout);
      nextTickTimeout = null;
    }
  }

  function tick() {
    if (!state.isPlaying) return;
    var beat = state.currentBeat;
    var isAccent = state.accent && beat === 1;
    playClick(isAccent);
    animateBeat(isAccent);
    renderBeats();
    speakBeat(beat);
    setStatus('第 ' + beat + ' 拍 / 共 ' + state.beatsPerBar + ' 拍');
    state.currentBeat = beat >= state.beatsPerBar ? 1 : beat + 1;
    nextTickTimeout = setTimeout(tick, (60 / state.bpm) * 1000);
  }

  function startMetronome() {
    ensureAudioContext();
    state.isPlaying = true;
    state.currentBeat = 1;
    startStop.textContent = '停止';
    tick();
  }

  function stopMetronome(reason) {
    state.isPlaying = false;
    clearTimer();
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    startStop.textContent = '开始';
    state.currentBeat = 1;
    currentBeat.textContent = '1';
    pulseCore.classList.remove('active');
    pulseCore.classList.remove('accent');
    renderBeats();
    setStatus(reason || '待机中');
  }

  function restartTicking() {
    if (!state.isPlaying) return;
    clearTimer();
    state.currentBeat = 1;
    tick();
  }

  function safeBindTap(el, handler) {
    el.addEventListener('click', handler, false);
    el.addEventListener('touchend', function (e) {
      e.preventDefault();
      handler(e);
    }, false);
  }

  bpmSlider.addEventListener('input', function (event) { setBpm(event.target.value); }, false);
  safeBindTap(decreaseBpm, function () { setBpm(state.bpm - 1); });
  safeBindTap(increaseBpm, function () { setBpm(state.bpm + 1); });
  safeBindTap(startStop, function () {
    if (state.isPlaying) stopMetronome();
    else startMetronome();
  });

  beatsSelect.addEventListener('change', function (event) {
    state.beatsPerBar = Number(event.target.value) || 4;
    state.currentBeat = 1;
    renderBeats();
    setStatus('拍号已切到 ' + state.beatsPerBar + ' 拍');
  }, false);

  voiceMode.addEventListener('change', function (event) {
    state.voiceMode = event.target.value || 'off';
    setStatus(state.voiceMode === 'off' ? '人声喊拍已关闭' : '人声喊拍已开启');
  }, false);

  accentToggle.addEventListener('change', function (event) {
    state.accent = !!event.target.checked;
    renderBeats();
  }, false);

  volumeSlider.addEventListener('input', function (event) {
    state.volume = Number(event.target.value) / 100;
  }, false);

  presetButtons.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button[data-bpm]') : event.target;
    if (!button || !button.getAttribute('data-bpm')) return;
    setBpm(button.getAttribute('data-bpm'));
  }, false);
  presetButtons.addEventListener('touchend', function (event) {
    var target = event.target;
    while (target && target !== presetButtons && (!target.getAttribute || !target.getAttribute('data-bpm'))) {
      target = target.parentNode;
    }
    if (!target || target === presetButtons) return;
    event.preventDefault();
    setBpm(target.getAttribute('data-bpm'));
  }, false);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.isPlaying) stopMetronome('切到后台，已自动暂停');
  }, false);
  window.addEventListener('pagehide', function () { stopMetronome('页面已关闭'); }, false);
  window.addEventListener('beforeunload', function () { stopMetronome('页面已关闭'); }, false);

  renderBeats();
  syncPresetButtons();
  setStatus('待机中');
})();
