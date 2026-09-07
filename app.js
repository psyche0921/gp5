'use strict';

/* ============================================================
   GP5 Pedalboard Controller
   Bluetooth (Web Bluetooth + SysEx) and USB (Web MIDI + CC) transport
   for the Valeton GP5 multi-effects pedal.
   ============================================================ */

// Bumped by hand on each deploy — yymmddHHMM of when this build was pushed.
const BUILD_VERSION = '2609071254';

const BLOCK_ORDER = ['nr', 'pre', 'dst', 'amp', 'cab', 'eq', 'mod', 'dly', 'rvb', 'ns'];
const BLOCK_HUE = { nr: 190, pre: 45, dst: 8, amp: 26, cab: 268, eq: 206, mod: 320, dly: 150, rvb: 118, ns: 255 };

// Minimal line-art icons (stroke = currentColor), one per effect category —
// same visual language as a hardware stage-floor controller: no emoji, no photoreal art.
const ICONS = {
  nr: `<svg viewBox="0 0 100 100"><path d="M8,58 H32 L32,28 H68 L68,58 H92" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pre: `<svg viewBox="0 0 100 100"><path d="M20,68 L50,24 L80,68" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><path d="M18,84 H82" stroke="currentColor" stroke-width="7" stroke-linecap="round"/></svg>`,
  dst: `<svg viewBox="0 0 100 100"><path d="M56,10 L22,58 H44 L38,90 L78,42 H54 Z" fill="currentColor"/></svg>`,
  amp: `<svg viewBox="0 0 100 100"><rect x="14" y="22" width="72" height="58" rx="6" fill="none" stroke="currentColor" stroke-width="7"/><circle cx="32" cy="38" r="6" fill="currentColor"/><circle cx="50" cy="38" r="6" fill="currentColor"/><circle cx="68" cy="38" r="6" fill="currentColor"/><path d="M20,60 H80 M20,70 H80" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>`,
  cab: `<svg viewBox="0 0 100 100"><rect x="14" y="14" width="72" height="72" rx="6" fill="none" stroke="currentColor" stroke-width="7"/><circle cx="36" cy="36" r="11" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="64" cy="36" r="11" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="36" cy="66" r="11" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="64" cy="66" r="11" fill="none" stroke="currentColor" stroke-width="6"/></svg>`,
  eq: `<svg viewBox="0 0 100 100"><path d="M22,15 V85 M50,15 V85 M78,15 V85" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M11,38 H33 M39,58 H61 M67,26 H89" stroke="currentColor" stroke-width="9" stroke-linecap="round"/></svg>`,
  mod: `<svg viewBox="0 0 100 100"><path d="M6,50 C18,22 32,22 44,50 C56,78 70,78 82,50 C88,38 92,32 96,28" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  dly: `<svg viewBox="0 0 100 100"><path d="M20,30 V70" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path d="M50,40 V70" stroke="currentColor" stroke-width="10" stroke-linecap="round" opacity="0.72"/><path d="M80,50 V70" stroke="currentColor" stroke-width="10" stroke-linecap="round" opacity="0.42"/></svg>`,
  rvb: `<svg viewBox="0 0 100 100"><path d="M84,50 A34,34 0 1,1 50,16" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M72,50 A22,22 0 1,1 50,28" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M60,50 A10,10 0 1,1 50,40" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/></svg>`,
  ns: `<svg viewBox="0 0 100 100"><rect x="30" y="30" width="40" height="40" rx="8" fill="none" stroke="currentColor" stroke-width="7"/><path d="M50,10 V26 M50,74 V90 M10,50 H26 M74,50 H90 M20,20 L30,30 M80,20 L70,30 M20,80 L30,70 M80,80 L70,70" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>`,
};

const state = {
  config: null,
  ccMap: null,
  transport: null,        // 'bluetooth' | 'usb' | null
  connected: false,
  bleDevice: null,
  bleChar: null,
  midiAccess: null,
  midiOut: null,
  midiIn: [],
  currentPatch: 0,
  patchNames: [],
  blocks: {},              // name -> { enabled, effectId(hex), effect(idx), effectName, parameters:[] }
  patchDataChunks: {},      // patch_data part index (0-3) -> decoded 100-byte data chunk, see decodePatchDataChunk
  activeBlock: null,
  syncing: false,
  patchPollTimer: null,
  patchDataLoaded: false,
  blinkEpoch: 0,            // performance.now() reference the idle pedal-blink animation is synced against
  consoleLogs: [],          // array of { time, level, message }
};

const $ = (sel) => document.querySelector(sel);
const els = {};
const escapeHtml = (str) => {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, c => map[c]);
};

window.addEventListener('DOMContentLoaded', init);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}

async function init() {
  cacheEls();
  bindStaticEvents();
  bindFullscreenToggle();
  els.buildVersion.textContent = `v${BUILD_VERSION}`;
  try {
    const [cfgRes, ccRes] = await Promise.all([
      fetch('data/ble_sysex.json'),
      fetch('data/cc_commands.json'),
    ]);
    state.config = await cfgRes.json();
    state.ccMap = await ccRes.json();
  } catch (err) {
    setStatus('설정 파일 로드 실패: ' + err.message, true);
    return;
  }
  state.blinkEpoch = performance.now();
  buildPedalboard();
  setStatus('연결을 기다리는 중...');

  // Hijack console methods to capture logs for UI display
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;

  const captureLog = (level, args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const time = new Date().toLocaleTimeString('ko-KR');
    state.consoleLogs.push({ time, level, message: msg });
    if (state.consoleLogs.length > 500) state.consoleLogs.shift(); // Keep last 500 logs
  };

  console.log = function(...args) { originalLog(...args); captureLog('log', args); };
  console.warn = function(...args) { originalWarn(...args); captureLog('warn', args); };
  console.error = function(...args) { originalError(...args); captureLog('error', args); };
  console.info = function(...args) { originalInfo(...args); captureLog('info', args); };
}

function cacheEls() {
  els.pedalboard = $('#pedalboard');
  els.transportSelect = createDropdown($('#transportSelect'));
  els.transportSelect.setOptions(
    [{ value: 'bluetooth', label: 'Bluetooth' }, { value: 'usb', label: 'USB MIDI' }],
    'bluetooth'
  );
  els.connectBtn = $('#connectBtn');
  els.connLed = $('#connLed');
  els.connLabel = $('#connLabel');
  els.rescanBtn = $('#rescanBtn');
  els.fullscreenBtn = $('#fullscreenBtn');
  els.toast = $('#toast');
  els.connectOverlay = $('#connectOverlay');
  els.connectOverlayText = $('#connectOverlayText');
  els.patchNum = $('#patchNum');
  els.patchName = $('#patchName');
  els.patchPrev = $('#patchPrev');
  els.patchNext = $('#patchNext');
  els.patchOpenList = $('#patchOpenList');
  els.patchListModal = $('#patchListModal');
  els.patchListBody = $('#patchListBody');
  els.patchListClose = $('#patchListClose');
  els.tunerBtn = $('#tunerBtn');
  els.savePatchBtn = $('#savePatchBtn');
  els.saveModal = $('#saveModal');
  els.saveModalClose = $('#saveModalClose');
  els.saveModalNum = $('#saveModalNum');
  els.saveModalName = $('#saveModalName');
  els.saveModalConfirm = $('#saveModalConfirm');
  els.masterVolWrap = $('#masterVolWrap');
  els.masterVol = $('#masterVol');
  els.masterVolValue = $('#masterVolValue');
  els.drawer = $('#drawer');
  els.drawerTitle = $('#drawerTitle');
  els.drawerClose = $('#drawerClose');
  els.drawerEffectSelect = createDropdown($('#drawerEffectSelect'));
  els.drawerToggle = $('#drawerToggle');
  els.drawerToggleLabel = $('#drawerToggleLabel');
  els.drawerKnobs = $('#drawerKnobs');
  els.drawerHint = $('#drawerHint');
  els.scrim = $('#scrim');
  els.statusText = $('#statusText');
  els.statusSpinner = $('#statusSpinner');
  els.buildVersion = $('#buildVersion');
  els.midiLogToggle = $('#midiLogToggle');
  els.midiLog = $('#midiLog');
  els.midiLogBody = $('#midiLogBody');
  els.midiLogClear = $('#midiLogClear');
  els.midiLogClose = $('#midiLogClose');
  els.consoleLogToggle = $('#consoleLogToggle');
  els.consoleLog = $('#consoleLog');
  els.consoleLogBody = $('#consoleLogBody');
  els.consoleLogDownload = $('#consoleLogDownload');
  els.consoleLogClear = $('#consoleLogClear');
  els.consoleLogClose = $('#consoleLogClose');
  els.toneMakerBtn = $('#toneMakerBtn');
  els.toneScreen = $('#toneScreen');
  els.toneBackBtn = $('#toneBackBtn');
  els.toneConnBanner = $('#toneConnBanner');
  els.toneInput = $('#toneInput');
  els.toneChips = $('#toneChips');
  els.toneGenerateBtn = $('#toneGenerateBtn');
  els.toneResult = $('#toneResult');
  els.toneResultTag = $('#toneResultTag');
  els.toneResultDesc = $('#toneResultDesc');
  els.toneResultBlocks = $('#toneResultBlocks');
  els.toneApplyHint = $('#toneApplyHint');
  els.toneApplyBtn = $('#toneApplyBtn');
}

function bindStaticEvents() {
  els.connectBtn.addEventListener('click', onConnectClick);
  els.rescanBtn.addEventListener('click', () => { if (!state.connected) attemptConnect(); });
  els.patchPrev.addEventListener('click', () => navigatePatch(-1));
  els.patchNext.addEventListener('click', () => navigatePatch(1));
  els.patchOpenList.addEventListener('click', openPatchList);
  els.patchListClose.addEventListener('click', closePatchList);
  els.tunerBtn.addEventListener('click', toggleTuner);
  els.savePatchBtn.addEventListener('click', openSaveModal);
  els.saveModalClose.addEventListener('click', closeSaveModal);
  els.saveModalConfirm.addEventListener('click', confirmSavePatch);
  [els.saveModalNum, els.saveModalName].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmSavePatch();
      else if (e.key === 'Escape') closeSaveModal();
    });
  });
  els.buildVersion.addEventListener('click', async () => {
    // Unregister service worker and clear all caches, then force reload
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }
    }
    // Clear all caches to force fresh fetch
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
    // Force hard reload with cache bust
    window.location.href = window.location.href.split('?')[0] + '?nocache=' + Date.now();
  });
  els.masterVol.addEventListener('input', onMasterVolInput);
  els.drawerClose.addEventListener('click', closeDrawer);
  els.scrim.addEventListener('click', () => { closeDrawer(); closePatchList(); closeSaveModal(); });
  els.midiLogToggle.addEventListener('click', () => {
    if (els.midiLog.classList.contains('show')) closeMidiLog();
    else openMidiLog();
  });
  els.midiLogClose.addEventListener('click', closeMidiLog);
  els.midiLogClear.addEventListener('click', () => { els.midiLogBody.innerHTML = ''; });
  els.consoleLogToggle.addEventListener('click', () => {
    if (els.consoleLog.classList.contains('show')) closeConsoleLog();
    else openConsoleLog();
  });
  els.consoleLogClose.addEventListener('click', closeConsoleLog);
  els.consoleLogDownload.addEventListener('click', downloadConsoleLogs);
  els.consoleLogClear.addEventListener('click', () => {
    state.consoleLogs = [];
    els.consoleLogBody.innerHTML = '';
  });
  els.toneMakerBtn.addEventListener('click', openToneScreen);
  els.toneBackBtn.addEventListener('click', closeToneScreen);
  els.toneGenerateBtn.addEventListener('click', onToneGenerateClick);
  els.toneApplyBtn.addEventListener('click', onToneApplyClick);
  buildToneChips();
}

const ICON_FS_ENTER = `<svg viewBox="0 0 100 100"><path d="M12,34 V12 H34 M66,12 H88 V34 M88,66 V88 H66 M34,88 H12 V66" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_FS_EXIT = `<svg viewBox="0 0 100 100"><path d="M12,34 H34 V12 M66,12 V34 H88 M88,66 H66 V88 M34,88 V66 H12" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Browsers only allow requestFullscreen()/exitFullscreen() from a user gesture, so this
// is wired to its own button instead of auto-firing on the first tap — an earlier
// auto-fullscreen-on-any-click version stole the transient user-activation that
// requestDevice()/requestMIDIAccess() need, making the Connect button randomly fail
// with "Must be handling a user gesture".
function bindFullscreenToggle() {
  const el = document.documentElement;
  const requestFn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  const exitFn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
  if (!requestFn || !exitFn) { els.fullscreenBtn.style.display = 'none'; return; }

  els.fullscreenBtn.addEventListener('click', () => {
    try {
      const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
      const result = fsElement ? exitFn.call(document) : requestFn.call(el);
      // requestFullscreen()/exitFullscreen() are spec'd to return a Promise, but some
      // browsers still throw synchronously instead of rejecting — cover both so a
      // real failure (permissions policy, no gesture, etc.) surfaces instead of
      // silently doing nothing.
      Promise.resolve(result).catch((err) => showToast('전체화면 전환 실패: ' + (err?.message || err), true));
    } catch (err) {
      showToast('전체화면 전환 실패: ' + err.message, true);
    }
  });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((evt) => document.addEventListener(evt, updateFullscreenBtn));
  updateFullscreenBtn();
}

function updateFullscreenBtn() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  els.fullscreenBtn.classList.toggle('active', on);
  els.fullscreenBtn.title = on ? '전체화면 해제' : '전체화면';
  els.fullscreenBtn.innerHTML = on ? ICON_FS_EXIT : ICON_FS_ENTER;
}

// Full-screen blur + indeterminate progress bar shown while a connect attempt is in
// flight, covering the whole viewport (pointer-events: auto) so nothing underneath is
// clickable until it resolves either way.
function setConnecting(active, label) {
  els.connectOverlay.classList.toggle('show', active);
  if (active && label) els.connectOverlayText.textContent = label;
}

let toastTimer = null;
function showToast(msg, isError) {
  clearTimeout(toastTimer);
  els.toast.textContent = msg;
  els.toast.classList.toggle('error', !!isError);
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

// Connection failures (device not found, chooser cancelled, GATT/MIDI errors) get both
// the persistent status-bar line and a toast, since the status bar alone is easy to miss.
function notifyConnectFailure(msg) {
  setStatus(msg, true);
  showToast(msg, true);
  showSpinner(false);
  setConnecting(false);
}

/* ==================== Pedalboard UI ==================== */

const SHORT_LABEL = { nr: 'NR', pre: 'PRE', dst: 'DIST', amp: 'AMP', cab: 'CAB', eq: 'EQ', mod: 'MOD', dly: 'DLY', rvb: 'REV', ns: 'NAM' };

function buildPedalboard() {
  els.pedalboard.innerHTML = '';
  BLOCK_ORDER.forEach((name) => {
    const block = state.config.blocks.find((b) => b.name === name);
    if (!block) return;
    const hue = BLOCK_HUE[name] ?? 200;
    const card = document.createElement('button');
    card.className = 'pedal';
    card.id = `pedal-${name}`;
    card.style.setProperty('--hue', hue);
    card.disabled = true;
    card.innerHTML = `
      <span class="pedal-icon">${ICONS[name] || ''}</span>
      <span class="pedal-label">${SHORT_LABEL[name] || name.toUpperCase()}</span>
      <span class="pedal-effect">${block.label}</span>
    `;
    card.addEventListener('click', () => openDrawer(block));
    els.pedalboard.appendChild(card);
  });
}

// The pedal-blink CSS animation (style.css) is 2.5s, unstaggered, so every bypassed
// pedal reads as "on the same beat" — but a CSS animation restarts its own timeline
// the moment an element starts matching :not(.on) again, so a pedal that just got
// toggled off (patch load, block disabled) would flash out of phase with pedals that
// have been idle since page load. Stamping a negative animation-delay here fast-forwards
// it to wherever it "should" be in the shared cycle, so it snaps back into sync instead.
const PEDAL_BLINK_CYCLE_MS = 2500;
function resyncBlink(card) {
  const elapsed = (performance.now() - state.blinkEpoch) % PEDAL_BLINK_CYCLE_MS;
  card.style.animationDelay = `-${elapsed}ms`;
}

function refreshPedal(name) {
  const card = document.getElementById(`pedal-${name}`);
  if (!card) return;
  const b = state.blocks[name] || {};
  const block = state.config.blocks.find((x) => x.name === name);
  const wasOn = card.classList.contains('on');
  const isOn = !!b.enabled;
  card.classList.toggle('on', isOn);
  if (wasOn && !isOn) resyncBlink(card);
  card.querySelector('.pedal-effect').textContent = b.effectName || block?.label || '';
}

function refreshAllPedals() {
  BLOCK_ORDER.forEach(refreshPedal);
}

function setControlsEnabled(enabled) {
  document.querySelectorAll('.pedal').forEach((el) => (el.disabled = !enabled));
  els.patchPrev.disabled = !enabled;
  els.patchNext.disabled = !enabled;
  els.patchOpenList.disabled = !enabled;
  els.tunerBtn.disabled = !enabled || state.transport !== 'usb';
  els.savePatchBtn.disabled = !enabled || state.transport !== 'bluetooth';
  els.masterVolWrap.classList.toggle('disabled', !(enabled && state.transport === 'usb'));
  els.masterVol.disabled = !(enabled && state.transport === 'usb');
}

/* ==================== Drawer (effect editor) ==================== */

// A hand-rolled dropdown, not a native <select>. Opening/closing a native <select> on
// Android Chrome/WebView triggers a full-screen WebView surface swap for the OS popup,
// which shows up as a whole-page flash -- CSS tweaks (removing backdrop-filter, etc.)
// don't touch that, only avoiding the native popup does.
function createDropdown(triggerEl) {
  const valueEl = triggerEl.querySelector('.custom-select-value');
  let options = [];
  let selectedValue = null;
  let onChangeCb = null;
  let closeMenu = null;

  function renderValue() {
    const opt = options.find((o) => o.value === selectedValue);
    valueEl.textContent = opt ? opt.label : '';
  }

  function open() {
    if (triggerEl.disabled || !options.length || closeMenu) return;
    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'custom-select-option' + (opt.value === selectedValue ? ' selected' : '');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        selectedValue = opt.value;
        renderValue();
        close();
        if (onChangeCb) onChangeCb(selectedValue);
      });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);

    const rect = triggerEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;
    menu.style.left = `${rect.left}px`;
    menu.style.minWidth = `${rect.width}px`;
    menu.style.maxHeight = `${Math.max(Math.min(256, openUp ? spaceAbove : spaceBelow), 80)}px`;
    if (openUp) {
      menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    } else {
      menu.style.top = `${rect.bottom + 6}px`;
    }
    triggerEl.classList.add('open');

    const onOutside = (e) => { if (!menu.contains(e.target) && e.target !== triggerEl) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close, true);

    closeMenu = () => {
      menu.remove();
      triggerEl.classList.remove('open');
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close, true);
      closeMenu = null;
    };
  }

  function close() { if (closeMenu) closeMenu(); }

  triggerEl.addEventListener('click', () => { if (closeMenu) close(); else open(); });

  return {
    setOptions(newOptions, newSelectedValue) {
      close();
      options = newOptions;
      selectedValue = newSelectedValue ?? (options[0]?.value ?? null);
      renderValue();
    },
    close,
    get value() { return selectedValue; },
    set disabled(v) { triggerEl.disabled = v; if (v) close(); },
    get disabled() { return triggerEl.disabled; },
    set onchange(fn) { onChangeCb = fn; },
  };
}

function openDrawer(block, keepEffect = true) {
  state.activeBlock = block;
  els.drawerTitle.innerHTML = `<span class="drawer-title-icon">${ICONS[block.name] || ''}</span>${block.label}`;
  els.drawer.style.setProperty('--hue', BLOCK_HUE[block.name] ?? 200);

  const bState = state.blocks[block.name] || {};
  const effects = Object.entries(block.effects || {});
  const isBluetooth = state.transport === 'bluetooth';

  // Effect select
  const effectOptions = effects.length
    ? effects.map(([effHex, eff]) => ({ value: effHex, label: eff.name }))
    : [{ value: '', label: block.note || '이 블록은 효과 목록이 고정되어 있지 않습니다' }];
  const selectedEntry = effects.find(
    ([effHex, eff]) => bState.effectId === effHex || (!bState.effectId && eff.id === (bState.effect || 0))
  );
  els.drawerEffectSelect.setOptions(effectOptions, selectedEntry?.[0] ?? effectOptions[0]?.value ?? null);
  els.drawerEffectSelect.disabled = !isBluetooth || effects.length === 0;
  els.drawerEffectSelect.onchange = (effHex) => {
    sendBlockEffectChange(block, effHex);
    // Only the parameter list changes when the effect type changes -- rebuilding just the
    // knobs/toggles (not the whole drawer) avoids tearing down the dropdown mid-interaction.
    setTimeout(() => renderDrawerParams(block, false), 150);
  };

  // On/off toggle
  els.drawerToggle.checked = !!bState.enabled;
  els.drawerToggleLabel.textContent = bState.enabled ? 'ON' : 'OFF';
  els.drawerToggle.onchange = () => {
    els.drawerToggleLabel.textContent = els.drawerToggle.checked ? 'ON' : 'OFF';
    sendBlockToggle(block, els.drawerToggle.checked);
  };

  renderDrawerParams(block, keepEffect);

  els.drawer.classList.add('open');
  els.scrim.classList.add('show');
}

function renderDrawerParams(block, keepEffect) {
  const bState = state.blocks[block.name] || {};
  const isBluetooth = state.transport === 'bluetooth';
  const effData = findEffectData(block, bState);
  const params = effData?.parameters || block.parameters || [];
  els.drawerKnobs.innerHTML = '';
  els.drawerHint.style.display = isBluetooth ? 'none' : 'block';
  els.drawerHint.textContent = 'USB 모드에서는 세부 파라미터를 편집할 수 없습니다. 정밀 편집은 Bluetooth 모드를 사용하세요.';

  // param.index is the device-side algId, e.g. Room reverb is Mix=0, Decay=2, Trail=3 --
  // it is NOT the same as this array's position once an effect's algIds skip a slot, so
  // both the read (bState.parameters) and the write (sendParamChange, via buildKnob) must
  // key off param.index rather than the forEach position or they silently hit the wrong
  // device-side parameter slot.
  params.forEach((param) => {
    const algId = param.index;
    const isToggle = param.min === 0 && param.max === 1;
    const value = keepEffect
      ? (bState.parameters?.[algId] ?? param.default)
      : (isToggle ? param.default : Math.round((param.min + param.max) / 2));
    const build = isToggle ? buildToggleParam : buildKnob;
    els.drawerKnobs.appendChild(build(block, param, algId, value, isBluetooth));
  });
}

function closeDrawer() {
  els.drawerEffectSelect.close();
  els.drawer.classList.remove('open');
  els.scrim.classList.remove('show');
}

function findEffectData(block, bState) {
  const effects = block.effects || {};
  if (bState.effectId && effects[bState.effectId]) return effects[bState.effectId];
  const entry = Object.values(effects).find((e) => e.id === (bState.effect || 0));
  return entry || null;
}

// The delay block's "Time (ms)" knob is a raw millisecond value (GP5 has no BPM/sync
// concept of its own — confirmed there's no such command in ble_sysex.json) so tap
// tempo is entirely client-side: tap interval directly becomes the delay time, and we
// just show the equivalent BPM (60000 / ms) as a convenience readout.
function msToBpmLabel(ms) {
  return ms > 0 ? `${Math.round(60000 / ms)} BPM` : '-- BPM';
}

// Binary params (min=0, max=1 -- e.g. Boost's +3dB/Bright, delay/reverb Trail, Toucher's
// Mode) are on/off switches on the real device, not continuous controls, so they get a
// toggle instead of a rotary knob.
function buildToggleParam(block, param, index, value, enabled) {
  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap toggle-param-wrap';
  const isOn = Math.round(value) >= 1;

  wrap.innerHTML = `
    <label class="switch toggle-param-switch">
      <input type="checkbox" ${isOn ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
      <span class="switch-track"></span>
    </label>
    <div class="knob-name">${param.name}</div>
    <div class="knob-value">${isOn ? 'ON' : 'OFF'}</div>
  `;

  if (!enabled) return wrap;

  const input = wrap.querySelector('input');
  const valueEl = wrap.querySelector('.knob-value');
  input.addEventListener('change', () => {
    const v = input.checked ? 1 : 0;
    valueEl.textContent = input.checked ? 'ON' : 'OFF';
    sendParamChange(block, index, v);
  });

  return wrap;
}

function buildKnob(block, param, index, value, enabled) {
  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';
  const range = param.max - param.min || 1;
  const frac = (v) => Math.min(1, Math.max(0, (v - param.min) / range));
  const deg = (v) => -135 + frac(v) * 270;
  const isDelayTime = block.name === 'dly' && /^Time/i.test(param.name);

  wrap.innerHTML = `
    <div class="knob ${enabled ? '' : 'disabled'}" tabindex="${enabled ? 0 : -1}">
      <div class="knob-arc"></div>
      <div class="knob-dial" style="transform:rotate(${deg(value)}deg)"><span></span></div>
    </div>
    <div class="knob-name">${param.name}</div>
    <div class="knob-value">${formatParamValue(value, param)}</div>
    ${isDelayTime ? `
      <div class="tap-tempo">
        <button type="button" class="tap-tempo-btn" ${enabled ? '' : 'disabled'}>TAP</button>
        <span class="tap-bpm">${msToBpmLabel(value)}</span>
      </div>` : ''}
  `;

  if (!enabled) return wrap;

  const knob = wrap.querySelector('.knob');
  const dial = wrap.querySelector('.knob-dial');
  const valueEl = wrap.querySelector('.knob-value');
  const bpmEl = wrap.querySelector('.tap-bpm');
  let current = value;
  let dragStartY = null;
  let dragStartVal = null;

  const apply = (v, commit) => {
    current = Math.min(param.max, Math.max(param.min, v));
    dial.style.transform = `rotate(${deg(current)}deg)`;
    valueEl.textContent = formatParamValue(current, param);
    if (bpmEl) bpmEl.textContent = msToBpmLabel(current);
    if (commit) {
      clearTimeout(knob._debounce);
      knob._debounce = setTimeout(() => sendParamChange(block, index, current), 90);
    }
  };

  if (isDelayTime) {
    const tapBtn = wrap.querySelector('.tap-tempo-btn');
    let tapTimes = [];
    tapBtn.addEventListener('click', () => {
      const now = performance.now();
      // Taps more than 2s apart are a fresh tempo, not a continuation.
      if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
      tapTimes.push(now);
      if (tapTimes.length > 6) tapTimes.shift();
      tapBtn.classList.add('pulse');
      setTimeout(() => tapBtn.classList.remove('pulse'), 120);
      if (tapTimes.length < 2) return;
      const intervals = tapTimes.slice(1).map((t, i) => t - tapTimes[i]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      apply(Math.round(avgMs), true);
    });
  }

  const onMove = (clientY) => {
    if (dragStartY === null) return;
    const dy = dragStartY - clientY;
    const sensitivity = range / 140; // 140px drag = full range
    apply(dragStartVal + dy * sensitivity, true);
  };

  const start = (clientY) => {
    dragStartY = clientY;
    dragStartVal = current;
    knob.classList.add('dragging');
  };
  const end = () => {
    dragStartY = null;
    knob.classList.remove('dragging');
  };

  knob.addEventListener('pointerdown', (e) => {
    knob.setPointerCapture(e.pointerId);
    start(e.clientY);
  });
  knob.addEventListener('pointermove', (e) => onMove(e.clientY));
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  knob.addEventListener('keydown', (e) => {
    const step = param.step || 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') apply(current + step, true);
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') apply(current - step, true);
  });
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = param.step || 1;
    apply(current + (e.deltaY < 0 ? step : -step), true);
  }, { passive: false });

  return wrap;
}

function formatParamValue(v, param) {
  const step = param.step || 1;
  return step < 1 ? v.toFixed(1) : Math.round(v).toString();
}

/* ==================== Patch list ==================== */

function openPatchList() {
  els.patchListBody.innerHTML = '';
  const count = state.patchNames.length || 100;
  for (let i = 0; i < count; i++) {
    const name = state.patchNames[i];
    if (state.transport === 'bluetooth' && !name) continue;
    const row = document.createElement('button');
    row.className = 'patch-row' + (i === state.currentPatch ? ' current' : '');
    row.innerHTML = `<span class="patch-row-num">${String(i).padStart(2, '0')}</span><span>${name || 'Patch ' + i}</span>`;
    row.addEventListener('click', () => { closePatchList(); selectPatch(i); });
    els.patchListBody.appendChild(row);
  }
  els.patchListModal.classList.add('show');
  els.scrim.classList.add('show');
}

function closePatchList() {
  els.patchListModal.classList.remove('show');
  els.scrim.classList.remove('show');
}

function updatePatchDisplay() {
  els.patchNum.textContent = String(state.currentPatch).padStart(2, '0');
  els.patchName.textContent = state.patchNames[state.currentPatch] || (state.transport === 'usb' ? `PATCH ${state.currentPatch}` : '—');
}

/* ==================== Connection ==================== */

async function onConnectClick() {
  if (state.connected) {
    disconnectAll();
    return;
  }
  await attemptConnect();
}

// Shared by the Connect button and the rescan button — re-running this while
// disconnected re-opens the browser's Bluetooth device chooser (or re-requests MIDI
// access) with a fresh scan, since neither API exposes a way to just "refresh" a list.
async function attemptConnect() {
  const mode = els.transportSelect.value;
  state.transport = mode;
  if (mode === 'bluetooth') await connectBluetooth();
  else await connectUsb();
}

function disconnectAll() {
  stopPatchPolling();
  if (state.bleDevice && state.bleDevice.gatt.connected) state.bleDevice.gatt.disconnect();
  if (Array.isArray(state.midiIn)) state.midiIn.forEach((p) => { p.onmidimessage = null; });
  state.midiOut = null;
  state.midiIn = [];
  state.connected = false;
  state.blocks = {};
  state.patchDataChunks = {};
  state.patchDataLoaded = false;
  updateConnLed(false);
  setControlsEnabled(false);
  setStatus('연결 해제됨');
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    notifyConnectFailure('이 브라우저는 Web Bluetooth를 지원하지 않습니다');
    return;
  }
  try {
    showSpinner(true);
    setStatus('GP5 검색 중...');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [state.config.device.bluetooth.service_uuid] }],
    });
    device.addEventListener('gattserverdisconnected', () => {
      state.connected = false;
      state.patchDataLoaded = false;
      stopPatchPolling();
      updateConnLed(false);
      setControlsEnabled(false);
      setStatus('장치 연결 끊김');
    });
    // The browser's own device chooser already blocks the page while it's open, so the
    // overlay only needs to cover the GATT handshake/sync that happens after a device
    // is picked — that's the part with no native UI of its own.
    setConnecting(true, `${device.name || 'GP5'}에 페어링하는 중...`);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(state.config.device.bluetooth.service_uuid);
    const char = await service.getCharacteristic(state.config.device.bluetooth.characteristic_uuid);
    await char.startNotifications();
    char.addEventListener('characteristicvaluechanged', handleBleNotification);

    state.bleDevice = device;
    state.bleChar = char;
    bleWriteChain = Promise.resolve(); // drop any write left pending from a prior connection
    setStatus('동기화 중...');
    setConnecting(true, '동기화하는 중...');
    await sendSysex(state.config.sync_commands.start_sync.sysex);
    await sleep(100);
    await sendSysex(state.config.sync_commands.request_patch_list.sysex);

    state.connected = true;
    updateConnLed(true, device.name || 'GP5');
    setControlsEnabled(true);
    startPatchPolling();
  } catch (err) {
    notifyConnectFailure('연결 실패: ' + err.message);
  }
}

// GP5 only pushes its "patch_changed" BLE notification for front-panel button
// presses — a patch change coming in over its USB host port (e.g. an M-Vave
// footswitch wired directly into GP5) never gets echoed to the BLE side at all.
// Since there's nothing to listen for in that case, we poll the current patch
// number instead so the UI still catches up regardless of what triggered the change.
function startPatchPolling() {
  stopPatchPolling();
  state.patchPollTimer = setInterval(() => {
    if (state.transport === 'bluetooth' && state.bleChar) {
      sendSysex(state.config.sync_commands.request_current_patch_number.sysex);
    }
  }, 700);
}

function stopPatchPolling() {
  if (state.patchPollTimer) {
    clearInterval(state.patchPollTimer);
    state.patchPollTimer = null;
  }
}

async function connectUsb() {
  if (!navigator.requestMIDIAccess) {
    notifyConnectFailure('이 브라우저는 Web MIDI를 지원하지 않습니다 (Android Chrome은 대부분 미지원 — Bluetooth 권장)');
    return;
  }
  try {
    setStatus('MIDI 접근 요청 중...');
    setConnecting(true, 'MIDI 장치에 연결하는 중...');
    state.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    state.midiAccess.onstatechange = pickMidiPorts;
    pickMidiPorts();
  } catch (err) {
    notifyConnectFailure('MIDI 연결 실패: ' + err.message);
  }
}

function pickMidiPorts() {
  const outs = Array.from(state.midiAccess.outputs.values());
  const ins = Array.from(state.midiAccess.inputs.values());
  const out = outs.find((o) => /gp-?5/i.test(o.name)) || outs[0];

  if (out) {
    state.midiOut = out;
    state.connected = true;
    updateConnLed(true, out.name || 'USB MIDI');
    setStatus(`USB MIDI 연결됨: ${out.name} (입력 장치 ${ins.length}개 감시 중)`);
    state.patchNames = [];
    setControlsEnabled(true);
    updatePatchDisplay();
  } else {
    state.midiOut = null;
    state.connected = false;
    updateConnLed(false);
    notifyConnectFailure('MIDI 출력 장치를 찾을 수 없습니다');
    setControlsEnabled(false);
  }

  // Listen on every connected MIDI input, not just GP5's own port — a separate
  // foot controller (e.g. M-Vave Chocolate Plus) shows up as its own input and
  // was previously ignored entirely if it wasn't the one port we picked.
  state.midiIn = ins;
  ins.forEach((port) => {
    port.onmidimessage = (event) => handleMidiMessage(event, port);
  });
}

function updateConnLed(connected, label) {
  els.connLed.classList.toggle('on', connected);
  els.connLabel.textContent = connected ? (label || '연결됨') : 'Connect';
  els.connectBtn.classList.toggle('connected', connected);
  els.rescanBtn.disabled = connected;
  showSpinner(false);
  setConnecting(false);
  if (els.toneScreen.classList.contains('show')) refreshToneConnBanner();
}

/* ==================== USB MIDI handlers ==================== */

function handleMidiMessage(event, port) {
  const [status, d1, d2] = event.data;
  const kind = status & 0xf0;
  const portName = port?.name || 'unknown';

  // Every message that reaches the tablet is logged here regardless of whether we
  // recognize it — this is the only way to tell "GP5 didn't send anything for this
  // event" apart from "it sent something our CC map doesn't cover".
  appendMidiLogRow(portName, event.data, decodeMidiMessage(status, d1, d2));

  if (kind === 0xc0 || kind !== 0xb0 || !state.ccMap?.commands) return;

  const cc = d1, value = d2;
  const cmds = state.ccMap.commands;

  const mod = cmds.modules.find((m) => m.cc === cc);
  if (mod) {
    state.blocks[mod.key] = state.blocks[mod.key] || {};
    state.blocks[mod.key].enabled = value >= 64;
    refreshPedal(mod.key);
    return;
  }
  if (cc === cmds.presetSelect.cc) {
    state.currentPatch = value;
    updatePatchDisplay();
    return;
  }
  if (cc === cmds.tuner.cc) {
    els.tunerBtn.classList.toggle('on', value >= 64);
  }
}

function decodeMidiMessage(status, d1, d2) {
  const kind = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  if (kind === 0xc0) return `Program Change #${d1} (ch${ch})`;
  if (kind === 0x90) return `Note On ${d1} vel${d2} (ch${ch})`;
  if (kind === 0x80) return `Note Off ${d1} (ch${ch})`;
  if (kind === 0xb0) {
    const cmds = state.ccMap?.commands;
    if (cmds) {
      const mod = cmds.modules.find((m) => m.cc === d1);
      if (mod) return `CC#${d1} ${mod.label} = ${d2}`;
      if (d1 === cmds.presetSelect?.cc) return `CC#${d1} Preset = ${d2}`;
      if (d1 === cmds.tuner?.cc) return `CC#${d1} Tuner = ${d2}`;
    }
    return `CC#${d1} = ${d2} (ch${ch})`;
  }
  return `status 0x${status.toString(16).padStart(2, '0')} [${d1}, ${d2}]`;
}

function openMidiLog() {
  els.midiLog.classList.add('show');
  els.midiLogToggle.classList.add('active');
}

function closeMidiLog() {
  els.midiLog.classList.remove('show');
  els.midiLogToggle.classList.remove('active');
  els.midiLogBody.innerHTML = '<p class="midi-log-empty">연결(Bluetooth 또는 USB) 후 GP5/페달 버튼을 누르면 여기에 원본 신호가 그대로 찍힙니다. 아무것도 안 찍히면 GP5가 그 이벤트를 이 연결로 전혀 보내지 않는다는 뜻입니다.</p>';
}

function openConsoleLog() {
  els.consoleLog.classList.add('show');
  els.consoleLogToggle.classList.add('active');
  refreshConsoleLogDisplay();
}

function closeConsoleLog() {
  els.consoleLog.classList.remove('show');
  els.consoleLogToggle.classList.remove('active');
}

function appendConsoleLogRow(time, level, message) {
  const row = document.createElement('div');
  row.className = `log-row log-${level}`;
  row.innerHTML = `<span class="log-time">${time}</span><span class="log-level">[${level.toUpperCase()}]</span><span class="log-msg">${escapeHtml(message)}</span>`;
  els.consoleLogBody.appendChild(row);
  els.consoleLogBody.scrollTop = els.consoleLogBody.scrollHeight;
}

function refreshConsoleLogDisplay() {
  els.consoleLogBody.innerHTML = '';
  if (state.consoleLogs.length === 0) {
    els.consoleLogBody.innerHTML = '<p class="midi-log-empty">아직 로그 메시지가 없습니다.</p>';
  } else {
    state.consoleLogs.forEach(log => {
      appendConsoleLogRow(log.time, log.level, log.message);
    });
  }
}

function downloadConsoleLogs() {
  if (state.consoleLogs.length === 0) {
    alert('로그가 없습니다.');
    return;
  }
  const content = state.consoleLogs
    .map(log => `[${log.time}] [${log.level.toUpperCase()}] ${log.message}`)
    .join('\n');

  // Try standard download first
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `console-log-${Date.now()}.txt`;

  try {
    // Mobile fallback: use navigator.share if available
    if (navigator.share) {
      navigator.share({
        title: 'Console Logs',
        text: content
      }).catch(() => {
        // If share fails, try traditional download
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    } else {
      // Desktop: traditional download
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } catch (err) {
    console.error('Download failed:', err);
    // Last resort: show in alert (for very limited environments)
    alert('로그를 복사해주세요:\n\n' + content.slice(0, 500) + '...');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}

// Only record while the panel is actually open — GP5 sends a steady stream of
// notifications (patch polling alone is every 700ms) and there's no point burning
// memory/DOM nodes logging traffic nobody is looking at.
function appendMidiLogRow(portName, bytes, decoded) {
  if (!els.midiLog.classList.contains('show')) return;

  const empty = els.midiLogBody.querySelector('.midi-log-empty');
  if (empty) empty.remove();

  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const now = new Date();
  const time = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');

  const row = document.createElement('div');
  row.className = 'midi-log-row';
  row.innerHTML = `
    <span class="midi-log-time">${time}</span>
    <span class="midi-log-port">${portName}</span>
    <span class="midi-log-bytes">[${hex}]</span>
    <span class="midi-log-decoded">${decoded}</span>
  `;
  els.midiLogBody.prepend(row);
  while (els.midiLogBody.children.length > 150) els.midiLogBody.lastChild.remove();
}

/* ==================== Commands: Bluetooth (SysEx) ==================== */

// Web Bluetooth rejects a write issued while another GATT operation on the same
// device is still in flight ("GATT operation already in progress") and most callers
// below fire sendSysex without awaiting it -- e.g. an effect-type change immediately
// followed by a debounced knob-drag write. Without serialization the second write
// throws and is silently dropped, so the value never reaches the device even though
// the UI already shows it optimistically. Chaining every write onto one promise
// makes them run strictly one-at-a-time regardless of how callers invoke this.
let bleWriteChain = Promise.resolve();

async function sendSysex(hexString) {
  if (!state.bleChar) return;
  const hex = hexString.trim().replace(/[^0-9a-fA-F]/g, '');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  const char = state.bleChar;
  const run = () => char.writeValueWithoutResponse(new Uint8Array(bytes));
  const attempt = bleWriteChain.then(run, run);
  bleWriteChain = attempt.then(() => {}, () => {});
  try {
    await attempt;
  } catch (err) {
    setStatus('전송 오류: ' + err.message, true);
  }
}

function buildSysexCommand(commandHex) {
  const crc = crc8(hexStringToBytes(commandHex));
  const withCrc = crc.toString(16).padStart(2, '0').toUpperCase() + commandHex;
  return '8080F0' + addzero(withCrc) + 'F7';
}

function sendBlockToggle(block, on) {
  if (state.transport === 'usb') {
    const cmds = state.ccMap?.commands;
    const mod = cmds?.modules.find((m) => m.key === block.name);
    if (mod && state.midiOut) {
      const val = on ? 127 : 0;
      state.midiOut.send([0xb0, mod.cc, val]);
      state.blocks[block.name] = state.blocks[block.name] || {};
      state.blocks[block.name].enabled = on;
      refreshPedal(block.name);
    }
    return;
  }
  const command = state.config.block_commands.toggle_block.command_template
    .replace('{EFFECT}', block.id.toString())
    .replace('{STATUS}', on ? '1' : '0');
  sendSysex(buildSysexCommand(command));
  state.blocks[block.name] = state.blocks[block.name] || {};
  state.blocks[block.name].enabled = on;
  refreshPedal(block.name);
}

function sendBlockEffectChange(block, effectHex) {
  if (state.transport === 'usb') {
    setStatus('USB 모드에서는 효과 종류를 바꿀 수 없습니다 (Bluetooth 필요)', true);
    return;
  }
  const command = state.config.block_commands.change_effect.command_template
    .replace(/\{BLOCK\}/g, block.id.toString())
    .replace('{EFFECT_ID}', effectHex);
  sendSysex(buildSysexCommand(command));

  const effData = block.effects[effectHex];
  state.blocks[block.name] = state.blocks[block.name] || {};
  state.blocks[block.name].effectId = effectHex;
  state.blocks[block.name].effect = effData?.id ?? 0;
  state.blocks[block.name].effectName = effData?.name || '';
  state.blocks[block.name].parameters = [];
  // The device needs real time to load the new effect's DSP algorithm before it can
  // accept a parameter write -- or a save -- against it: a command sent too soon after
  // a type change targets a state the device hasn't finished switching into yet, and
  // silently doesn't stick. Repro'd live: a knob drag ~2s after the type change
  // persisted fine, ~1s after did not. sendParamChange and savePatch both wait out
  // this cooldown before transmitting.
  state.lastEffectChangeAt = performance.now();
  refreshPedal(block.name);
}

const EFFECT_CHANGE_SETTLE_MS = 500;

async function waitForEffectChangeSettle() {
  const elapsed = performance.now() - (state.lastEffectChangeAt || 0);
  if (elapsed < EFFECT_CHANGE_SETTLE_MS) await sleep(EFFECT_CHANGE_SETTLE_MS - elapsed);
}

async function sendParamChange(block, paramIndex, value) {
  if (state.transport === 'usb') return; // not supported over CC map
  await waitForEffectChangeSettle();

  console.log(`[sendParamChange] ${block.name} param[${paramIndex}] = ${value}`);
  const floatHex = floatToHexLE(value).join('');
  const command = state.config.block_commands.change_parameter.command_template
    .replace('{BLOCK}', block.id.toString(16).padStart(2, '0'))
    .replace('{PARAM_NUM}', paramIndex.toString(16).padStart(2, '0'))
    .replace('{VALUE_FLOAT_HEX}', floatHex);
  console.log(`[sendParamChange] sending: block=${block.id.toString(16).padStart(2, '0')} param=${paramIndex.toString(16).padStart(2, '0')} hex=${floatHex}`);
  sendSysex(buildSysexCommand(command));

  state.blocks[block.name] = state.blocks[block.name] || {};
  state.blocks[block.name].parameters = state.blocks[block.name].parameters || [];
  state.blocks[block.name].parameters[paramIndex] = value;
  console.log(`[sendParamChange] cache updated: param[${paramIndex}] = ${value}`);
}

async function selectPatch(num) {
  if (state.transport === 'usb') {
    const cmds = state.ccMap?.commands;
    if (cmds?.presetSelect && state.midiOut) {
      state.midiOut.send([0xb0, cmds.presetSelect.cc, clampMidi(num)]);
      state.currentPatch = num;
      state.blocks = {};
      state.patchDataChunks = {};
      updatePatchDisplay();
      refreshAllPedals();
    }
    return;
  }
  const command = state.config.patch_commands.change_patch.command_template
    .replace('{PATCH}', num.toString(16).padStart(2, '0'));
  await sendSysex(buildSysexCommand(command));
  state.blocks = {};
  state.patchDataChunks = {};
  state.currentPatch = num;
  updatePatchDisplay();
  refreshAllPedals();
  await sleep(200);
  setStatus(`패치 ${num} 불러오는 중...`);
  await sendSysex(state.config.sync_commands.request_patch_data.sysex);
}

function patchTotal() {
  return state.transport === 'bluetooth' ? Math.max(state.patchNames.length, 1) : 100;
}

let stopTrackingSaveModalViewport = () => {};

// Keeps a fixed-position, vertically-centered modal above the on-screen keyboard.
// `interactive-widget=resizes-content` (viewport meta) already handles this on newer
// Chrome/WebView by shrinking the layout viewport itself, but on older Android WebView
// that's ignored and a fixed `top: 50%` modal ends up centered on the FULL screen height
// -- i.e. partly hidden behind the keyboard. visualViewport always reports the actually
// visible area regardless of that support, so re-centering against it works everywhere.
function trackVisualViewport(modalEl) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const update = () => {
    modalEl.style.top = `${vv.offsetTop + vv.height / 2}px`;
    modalEl.style.maxHeight = `${vv.height * 0.9}px`;
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    modalEl.style.top = '';
    modalEl.style.maxHeight = '';
  };
}

// Valeton Suite lets you save the current live edits to any patch slot under any name
// (not just overwrite the active one), and jumps you to that slot afterward. Pre-fill
// the modal with the active patch's number/name so a plain confirm behaves like the
// old one-click save.
function openSaveModal() {
  if (state.transport !== 'bluetooth' || !state.bleChar) return;
  els.saveModalNum.value = state.currentPatch;
  els.saveModalNum.max = patchTotal() - 1;
  els.saveModalName.value = state.patchNames[state.currentPatch] || '';
  els.saveModal.classList.add('show');
  els.scrim.classList.add('show');
  stopTrackingSaveModalViewport = trackVisualViewport(els.saveModal);
  els.saveModalName.focus();
  els.saveModalName.select();
}

function closeSaveModal() {
  els.saveModal.classList.remove('show');
  els.scrim.classList.remove('show');
  stopTrackingSaveModalViewport();
  stopTrackingSaveModalViewport = () => {};
}

// Commits the current live edits to a patch slot on GP5. There's no documented SysEx
// command for this — it was reverse-engineered from a BLE HCI snoop capture of Valeton
// Suite's own Save action (patch number + a 10-byte, zero-padded ASCII name field),
// since GP5 otherwise discards parameter/effect edits on patch change or power-off.
async function writePatchToDevice(num, name) {
  const nameHex = Array.from({ length: 10 }, (_, i) => (name.charCodeAt(i) || 0).toString(16).padStart(2, '0')).join('');
  const command = state.config.patch_commands.save_patch.command_template
    .replace('{PATCH}', num.toString(16).padStart(2, '0'))
    .replace('{NAME}', nameHex);
  await sendSysex(buildSysexCommand(command));
  await sleep(150);
}

async function confirmSavePatch() {
  if (state.transport !== 'bluetooth' || !state.bleChar) return;

  const total = patchTotal();
  const parsedNum = parseInt(els.saveModalNum.value, 10);
  const targetNum = Number.isFinite(parsedNum) ? Math.min(Math.max(parsedNum, 0), total - 1) : state.currentPatch;
  const targetName = els.saveModalName.value.slice(0, 10);
  const originalPatch = state.currentPatch;

  await waitForEffectChangeSettle();

  console.log(`[savePatch] Saving current live edits to patch ${targetNum} as "${targetName}"`);
  console.log(`[savePatch] Current blocks state:`, JSON.stringify(Object.entries(state.blocks).map(([name, block]) => ({ name, params: block.parameters?.slice(0, 8) }))));

  els.saveModalConfirm.disabled = true;
  els.savePatchBtn.disabled = true;
  setConnecting(true, '패치 저장하는 중...');

  await writePatchToDevice(targetNum, targetName);
  state.patchNames[targetNum] = targetName;

  if (targetNum !== originalPatch) {
    // Reload from the slot we just wrote so the main screen reflects it as the active patch.
    await selectPatch(targetNum);
  } else {
    updatePatchDisplay();
  }

  setConnecting(false);
  els.saveModalConfirm.disabled = false;
  els.savePatchBtn.disabled = false;
  closeSaveModal();

  console.log(`[savePatch] Save command sent`);
  els.savePatchBtn.classList.add('saved');
  setTimeout(() => els.savePatchBtn.classList.remove('saved'), 1200);
  showToast(`패치 ${targetNum} "${targetName || '(이름 없음)'}" 저장 완료`);
  setStatus(`패치 ${targetNum} 저장 완료`);
}

function navigatePatch(dir) {
  const total = patchTotal();
  const next = ((state.currentPatch + dir) % total + total) % total;
  selectPatch(next);
}

function toggleTuner() {
  if (state.transport !== 'usb' || !state.midiOut) return;
  const cmds = state.ccMap?.commands;
  if (!cmds?.tuner) return;
  const isOn = els.tunerBtn.classList.contains('on');
  state.midiOut.send([0xb0, cmds.tuner.cc, isOn ? 0 : 127]);
  els.tunerBtn.classList.toggle('on', !isOn);
}

function onMasterVolInput(e) {
  const value = Number(e.target.value);
  els.masterVolValue.textContent = value;
  if (state.transport !== 'usb' || !state.midiOut) return;
  const cmds = state.ccMap?.commands;
  clearTimeout(els.masterVol._debounce);
  els.masterVol._debounce = setTimeout(() => {
    state.midiOut.send([0xb0, cmds.patchVolume.cc, clampMidi(value)]);
  }, 80);
}

/* ==================== BLE notification parsing ==================== */

function handleBleNotification(event) {
  const view = event.target.value;
  const bytes = [];
  for (let i = 0; i < view.byteLength; i++) bytes.push(view.getUint8(i));

  appendMidiLogRow('Bluetooth GATT', bytes, describeBleNotification(bytes));

  if (bytes[5] === 1 && bytes[6] === 5 && bytes.length === 212) {
    parsePatchNames(bytes);
  } else if (bytes[5] === 1 && bytes[6] === 5 && bytes[7] === 1 && bytes[8] === 4 && bytes.length === 16) {
    populatePatchListFromNames();
    sendSysex(state.config.sync_commands.request_snaptones.sysex);
  } else if (bytes[5] === 0 && bytes[6] === 14 && bytes.length === 136) {
    sendSysex(state.config.sync_commands.request_ir_list.sysex);
  } else if (bytes[5] === 0 && bytes[6] === 4 && bytes.length === 96) {
    sendSysex(state.config.sync_commands.request_current_patch_number.sysex);
  } else if (bytes[5] === 0 && bytes[6] === 1 && bytes[10] === 4 && bytes[11] === 1 && bytes[12] === 2 && bytes.length === 20) {
    // Also arrives from our own 1.5s poll (see startPatchPolling) — only reload
    // when the patch actually changed, otherwise this fires every poll for nothing.
    const patch = bytes[15] * 16 + bytes[16];
    if (patch !== state.currentPatch || !state.patchDataLoaded) {
      state.blocks = {};
      state.patchDataChunks = {};
      state.currentPatch = patch;
      updatePatchDisplay();
      setStatus(`패치 ${patch} 데이터 로드 중...`);
      setTimeout(() => sendSysex(state.config.sync_commands.request_patch_data.sysex), 100);
    }
  } else if (bytes[5] === 0 && bytes[6] === 5 && bytes.length === 212) {
    // patch_data parts: 0=pre/nr, 1=dst through dly, 2-3=more of dst through rvb,
    // 4=ns and rvb tail. parsePatchData1 and parsePatchData2 handle effect IDs and
    // block-enabled status from parts 0 and 1; extractKnownParams extracts parameter
    // values from parts 1-4. Only call extractKnownParams on parts 1-3 (not part 0,
    // since no parameter data there yet), to avoid redundant extractions.
    if (bytes[7] === 0 && bytes[8] === 0) {
      parsePatchData1(bytes);
    } else if (bytes[7] === 0 && bytes[8] === 1) {
      parsePatchData2(bytes);
      state.patchDataChunks[1] = decodePatchDataChunk(bytes);
      extractKnownParams();
    } else if (bytes[7] === 0 && bytes[8] >= 2 && bytes[8] <= 3) {
      state.patchDataChunks[bytes[8]] = decodePatchDataChunk(bytes);
      extractKnownParams();
    }
  } else if (bytes[5] === 0 && bytes[6] === 5 && bytes.length === 148 && bytes[7] === 0 && bytes[8] === 4) {
    state.patchDataChunks[4] = decodePatchDataChunk(bytes);
    extractKnownParams();
    setStatus('GP5 동기화 완료');
    showSpinner(false);
    state.patchDataLoaded = true;
    refreshAllPedals();
  } else if (bytes[5] === 0 && bytes[6] === 1 && bytes[12] === 2 && bytes[13] === 4 && bytes[14] === 3 && bytes.length === 24) {
    const patch = bytes[15] * 16 + bytes[16];
    state.blocks = {};
    state.patchDataChunks = {};
    state.currentPatch = patch;
    updatePatchDisplay();
    setStatus(`장치에서 패치 ${patch}(으)로 변경됨, 로드 중...`);
    setTimeout(() => sendSysex(state.config.sync_commands.request_patch_data.sysex), 100);
  }
}

function describeBleNotification(bytes) {
  const b5 = bytes[5], b6 = bytes[6], b7 = bytes[7], b8 = bytes[8], len = bytes.length;
  if (b5 === 1 && b6 === 5 && len === 212) return 'patch_list (이름 조각)';
  if (b5 === 1 && b6 === 5 && b7 === 1 && b8 === 4 && len === 16) return 'patch_list_end';
  if (b5 === 0 && b6 === 14 && len === 136) return 'snaptones_end';
  if (b5 === 0 && b6 === 4 && len === 96) return 'ir_list_end';
  if (b5 === 0 && b6 === 1 && bytes[10] === 4 && bytes[11] === 1 && bytes[12] === 2 && len === 20) return 'current_patch_number';
  if (b5 === 0 && b6 === 5 && len === 212) return `patch_data part ${b7}/${b8}`;
  if (b5 === 0 && b6 === 5 && len === 148 && b7 === 0 && b8 === 4) return 'patch_data_final (sync done)';
  if (b5 === 0 && b6 === 1 && bytes[12] === 2 && bytes[13] === 4 && bytes[14] === 3 && len === 24) return 'patch_changed';
  return `미인식 (len ${len}, [5]=${b5} [6]=${b6} [7]=${b7} [8]=${b8})`;
}

// Shared by parsePatchData1 (pre) and parsePatchData2 (dst..ns): reads the effect-ID
// bytes at `offset` in the raw notification and, if it matches a known effect in
// ble_sysex.json, records the block's current effect/effectName.
function applyEffectIdAt(bytes, name, offset) {
  const effHex = readEffectIdHex(bytes, offset);
  state.blocks[name] = state.blocks[name] || {};
  state.blocks[name].effectId = effHex;
  const block = state.config.blocks.find((b) => b.name === name);
  const effData = block?.effects?.[effHex];
  if (effData) {
    state.blocks[name].effect = effData.id;
    state.blocks[name].effectName = effData.name;
  }
}

function parsePatchData1(bytes) {
  const status = {
    nr: !!(bytes[152] & (1 << 0)), pre: !!(bytes[152] & (1 << 1)),
    dst: !!(bytes[152] & (1 << 2)), amp: !!(bytes[152] & (1 << 3)),
    cab: !!(bytes[151] & (1 << 0)), eq: !!(bytes[151] & (1 << 1)),
    mod: !!(bytes[151] & (1 << 2)), dly: !!(bytes[151] & (1 << 3)),
    rvb: !!(bytes[154] & (1 << 0)), ns: !!(bytes[154] & (1 << 1)),
  };
  Object.entries(status).forEach(([name, enabled]) => {
    state.blocks[name] = state.blocks[name] || {};
    state.blocks[name].enabled = enabled;
  });

  // pre's effect ID lives at raw offset 203 in this notification -- found via a live
  // BLE HCI capture (adb bugreport -> btsnoop_hci.log): after switching pre to Toucher
  // ("0f000001"), that exact byte pattern appeared uniquely at offset 203, nowhere else
  // in part1 or part2. nr has only one effect (Gate), so it has no selector slot at all
  // and doesn't need this. Previously pre's effectId was never read, so its effect type
  // always looked unset/reverted after a save+reload even though it was saved correctly.
  applyEffectIdAt(bytes, 'pre', 203);
  console.log(`[parsePatchData1] pre effectId=${state.blocks.pre.effectId} effect=${state.blocks.pre.effect} effectName=${state.blocks.pre.effectName}`);
  // If the drawer is open on PRE, re-render just the drawer instead of refreshing the
  // pedalboard UI, to avoid the flash/flicker when the user is interacting with the
  // drawer (e.g., changing effect type via dropdown).
  const drawerOpen = els.drawer.classList.contains('open');
  const drawerBlockName = state.activeBlock?.name;
  if (drawerOpen && drawerBlockName === 'pre') {
    renderDrawerParams(state.activeBlock, true);
  } else {
    refreshPedal('pre');
  }
}

function parsePatchData2(bytes) {
  const offsets = { dst: 11, ns: 67, amp: 19, cab: 27, eq: 35, mod: 43, dly: 51, rvb: 59 };
  Object.entries(offsets).forEach(([name, offset]) => {
    applyEffectIdAt(bytes, name, offset);
  });
  // If the drawer is open and showing one of these blocks, re-render just the drawer
  // to avoid flashing the entire pedalboard UI (refreshAllPedals) while the user has
  // a dropdown open or is actively using the drawer.
  const drawerOpen = els.drawer.classList.contains('open');
  const drawerBlockName = state.activeBlock?.name;
  const isDrawerBlockAffected = ['dst', 'amp', 'cab', 'eq', 'mod', 'dly', 'rvb'].includes(drawerBlockName);
  if (drawerOpen && isDrawerBlockAffected) {
    renderDrawerParams(state.activeBlock, true);
  } else {
    refreshAllPedals();
  }
}

// GP5's outgoing SysEx commands nibble-encode every payload byte as its own wire byte
// (see buildSysexCommand/addzero) — patch_data notifications turn out to use the same
// encoding for their parameter-value region, even though the block-enabled bitflags and
// effect IDs elsewhere in the same messages are plain bytes. Confirmed against a live
// BLE HCI capture: this reconstructs the true parameter bytes from the wire bytes.
function decodePatchDataChunk(bytes) {
  const logical = [];
  for (let i = 3; i + 1 < bytes.length - 1; i += 2) {
    logical.push(((bytes[i] & 0x0f) << 4) | (bytes[i + 1] & 0x0f));
  }
  return logical.slice(4); // drop the CRC + 3-byte part-marker header
}

function readFloat32LE(buf, offset) {
  return new DataView(new Uint8Array(buf.slice(offset, offset + 4)).buffer).getFloat32(0, true);
}

// Reverse-engineered from live BLE HCI captures (set a distinct value per block, saved,
// forced a reload, diffed the raw bytes against what was sent). Every block gets 8
// reserved parameter slots (float32 LE, 4 bytes each), but the slots for different
// blocks live in different patch_data parts:
//   - part1 (100 decoded bytes): nr at offset 36, pre at offset 68 (i.e. 36 + blockIndex*32,
//     for blockIndex 0-1)
//   - part2+part3+part4[0:24] concatenated (224 bytes): dst..rvb (blockIndex 2-8), offset =
//     (blockIndex - 2) * 32 + paramIndex * 4. dst..dly (blockIndex 2-7) fit entirely inside
//     part2+part3 (200 bytes), but rvb (blockIndex 8, base 192) needs offsets up to 223 for
//     its 8 slots, so its params from index 2 onward spill into the first 24 bytes of part4 --
//     confirmed via a captured Suite save+reload: rvb's Decay (param index 2), just written
//     via change_parameter, read back byte-identical at part4 offset 0, not anywhere in
//     part2+part3. Reading only part2+part3 (the original assumption) silently left rvb's
//     Decay/Trail undefined, which is why a saved Decay value appeared to not persist.
//   - part4 (68 decoded bytes) offset 24 onward: ns (NAM), offset = 24 + paramIndex * 4
function extractBlockParams(name, buf, base) {
  const bState = state.blocks[name] = state.blocks[name] || {};
  const block = state.config.blocks.find((b) => b.name === name);
  const effectHex = bState.effectId;
  const effect = block?.effects?.[effectHex];
  const params = [];

  if (effect?.parameters) {
    // JSON's parameter indices may skip slots (e.g. Room reverb: Mix=0, Decay=2, Trail=3).
    // Use param.index to place each value into the correct slot so that later when
    // sendParamChange uses param.index to address the device, it finds the right cached value.
    effect.parameters.forEach((param) => {
      const algId = param.index;
      const off = base + algId * 4;
      if (off >= 0 && off + 4 <= buf.length) {
        params[algId] = readFloat32LE(buf, off);
      }
    });
  } else {
    // Fallback: if we don't know the effect, read all 8 slots sequentially.
    // This is expected for: nr/pre (no effectId in patch data), cab (special block),
    // or when effect JSON is unavailable. Only log if this seems unexpected.
    if (effectHex !== undefined && block && !effect) {
      console.warn(`[extractBlockParams] Effect not in JSON: ${name} effectHex=${effectHex}`);
    }
    for (let p = 0; p < 8; p++) {
      const off = base + p * 4;
      if (off < 0 || off + 4 > buf.length) continue;
      params[p] = readFloat32LE(buf, off);
    }
  }
  bState.parameters = params;
}

function extractKnownParams() {
  const part1 = state.patchDataChunks[1];
  const part2 = state.patchDataChunks[2];
  const part3 = state.patchDataChunks[3];
  const part4 = state.patchDataChunks[4];

  if (part1) {
    extractBlockParams('nr', part1, 36 + 0 * 32);
    extractBlockParams('pre', part1, 36 + 1 * 32);
  }
  if (part2 && part3) {
    // rvb's tail (params index 2+) lives in part4[0:24] -- see extractBlockParams'
    // comment above. Append it when part4 has already arrived; otherwise rvb's later
    // slots are simply left unset until part4 shows up and this re-runs.
    const buf = part2.concat(part3).concat(part4 ? part4.slice(0, 24) : []);
    ['dst', 'amp', 'cab', 'eq', 'mod', 'dly', 'rvb'].forEach((name) => {
      const blockIdx = BLOCK_ORDER.indexOf(name);
      extractBlockParams(name, buf, (blockIdx - 2) * 32);
    });
  }
  if (part4) {
    extractBlockParams('ns', part4, 24);
  }
}

// The per-block 8-byte stride in patch_data holds the distinguishing effect byte
// nibble-pair-encoded across TWO bytes -- (start) is its high nibble, (start+1) its low
// nibble -- not as a single byte at (start+1) like earlier reverse-engineering assumed.
// That assumption happened to work for every effect whose distinguishing byte is <16
// (Green OD=0x00, Room=0x00, Pure=0x00, ...) because the missing high nibble was always
// zero there, but it silently produced garbage for any effect >=0x10 -- e.g. amp's J-120
// CL (0x14), Foxy 30N (0x11), UK 45 (0x2a); pre's Boost (0x1a) and Micro Boost (0x14);
// dst's SM Dist (0x2a), Plustortion (0x29), La Charger (0x30), etc. This is why PRE's
// effect type (Boost, Micro Boost) never read back correctly after a save+reload even
// once pre was given an offset at all: offset 203 was right, but the single-byte read
// turned Boost's 0x1a into 0x0a and Micro Boost's 0x14 into 0x04, neither of which
// matches any real effect key.
//
// Verified via a live BLE HCI capture (adb bugreport -> btsnoop_hci.log) of the official
// Valeton Suite app: reconstructing amp's distinguishing byte as (bytes[19]<<4)|bytes[20]
// across many patch_data captures produced "01000007" (Tweedy), "14000007" (J-120 CL),
// and "24000007" -- all three exact, real keys in ble_sysex.json. Same reconstruction at
// pre's offset 203 turned Suite-confirmed Boost/Micro Boost selections into "1a000000"
// and "14000000" byte-for-byte. The marker byte (start+7) needs no such fix -- its own
// high nibble (start+6) was confirmed to always be zero across every block in the
// capture, so a single byte read there remains correct.
function readEffectIdHex(bytes, start) {
  const distHi = bytes[start];
  const distLo = bytes[start + 1];
  const marker = bytes[start + 7];
  if (distHi === undefined || distLo === undefined || marker === undefined) return '';
  const distinguishing = (distHi << 4) | distLo;
  return distinguishing.toString(16).padStart(2, '0') + '0000' + marker.toString(16).padStart(2, '0');
}

function parsePatchNames(bytes) {
  const getName = (start) => {
    let name = '';
    for (let i = 0; i < 20; i += 2) {
      const code = bytes[i + start] * 16 + bytes[i + start + 1];
      name += String.fromCharCode(code);
    }
    return name.trim();
  };
  const index = (bytes[7] * 16 + bytes[8]) * 5;
  for (let k = 0; k < 5; k++) state.patchNames[index + k] = getName(23 + k * 40);
}

function populatePatchListFromNames() {
  updatePatchDisplay();
  setStatus(`${state.patchNames.filter(Boolean).length}개 패치 로드됨`);
}

/* ==================== Protocol utils ==================== */

function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

function hexStringToBytes(hexString) {
  const clean = hexString.replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.substr(i, 2), 16));
  return bytes;
}

function addzero(str) {
  let out = '';
  for (const ch of str) out += '0' + ch;
  return out;
}

function floatToHexLE(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0'));
}

function clampMidi(v) { return Math.min(127, Math.max(0, Math.round(v))); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ==================== AI tone maker (natural-language preset generator) ====================
   Fully local/offline: no external LLM call. Free-form Korean/English text is scored against
   a curated set of genre/mood archetypes (keyword hits), then a handful of regex-based
   modifiers ("리버브 많이", "게인 낮게", ...) nudge specific block params on top of the base
   recipe. The result is a plain { blockName -> { enabled, effect, params } } spec that is
   applied through the same sendBlockToggle/sendBlockEffectChange/sendParamChange pipeline
   the drawer already uses, so it only works over Bluetooth (parameter/effect edits are not
   supported over the USB CC map) and can be saved afterward via the existing SAVE modal. */

const TONE_ARCHETYPES = [
  {
    id: 'clean_bright', label: '청량한 클린',
    keywords: ['클린', '청량', '맑은', '밝은', '크리스탈', 'clean', 'bright', 'sparkle', 'jangle', '쟁글'],
    desc: '군더더기 없이 맑고 화사한 클린 톤. 아르페지오나 컴핑에 어울립니다.',
    blocks: {
      nr: { enabled: true, params: { THRE: 25 } },
      pre: { enabled: false },
      dst: { enabled: false },
      amp: { enabled: true, effect: 'J-120 CL', params: { VOL: 55, Bass: 45, Middle: 50, Treble: 62, Bright: 1 } },
      cab: { enabled: true, effect: 'J-120 2x12' },
      eq: { enabled: false },
      mod: { enabled: true, effect: 'A-Chorus', params: { Depth: 25, Rate: 2.0, Tone: 60 } },
      dly: { enabled: true, effect: 'Pure', params: { Mix: 15, Time: 320, 'F.Back': 15, Trail: 0 } },
      rvb: { enabled: true, effect: 'Hall', params: { Mix: 20, Decay: 35, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'warm_clean', label: '따뜻한 클린',
    keywords: ['따뜻', '포근', '벨벳', '부드러운', 'mellow', 'warm', 'jazz', '재즈', 'soft clean'],
    desc: '부드럽고 따뜻한 클린 톤. 재즈나 발라드 백킹에 어울립니다.',
    blocks: {
      nr: { enabled: true, params: { THRE: 20 } },
      pre: { enabled: true, effect: 'COMP', params: { Sustain: 15, VOL: 55 } },
      dst: { enabled: false },
      amp: { enabled: true, effect: 'Match CL', params: { Gain: 20, PRES: 55, VOL: 55, Bass: 55, Middle: 55, Treble: 40 } },
      cab: { enabled: true, effect: 'Bellman 2x12' },
      eq: { enabled: false },
      mod: { enabled: true, effect: 'B-Chorus', params: { Depth: 15, Rate: 1.5, VOL: 50 } },
      dly: { enabled: false },
      rvb: { enabled: true, effect: 'Room', params: { Mix: 25, Decay: 40, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'blues_crunch', label: '빈티지 블루스',
    keywords: ['블루스', 'blues', '브레이크업', 'breakup', '빈티지 크런치', 'soulful', '텍사스'],
    desc: '살짝 뭉개지는 빈티지 블루스 크런치. 픽 다이내믹에 반응하는 브레이크업 사운드.',
    blocks: {
      nr: { enabled: true, params: { THRE: 20 } },
      pre: { enabled: false },
      dst: { enabled: true, effect: 'Green OD', params: { Gain: 35, Tone: 65, VOL: 55 } },
      amp: { enabled: true, effect: 'Tweedy', params: { Gain: 45, Tone: 55, VOL: 55 } },
      cab: { enabled: true, effect: 'TWD CP 1x8' },
      eq: { enabled: false },
      mod: { enabled: false },
      dly: { enabled: true, effect: 'Analog', params: { Mix: 18, Time: 380, Feedback: 18, Trail: 0 } },
      rvb: { enabled: true, effect: 'Spring', params: { Mix: 28, Decay: 35, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'classic_rock', label: '클래식 록',
    keywords: ['클래식록', 'classic rock', '70s', '록', 'rock', '레드제플린', '지미핸드릭스'],
    desc: '70년대 클래식 록 사운드. 적당히 밀어붙이는 오버드라이브와 미드레인지 강조 톤.',
    blocks: {
      nr: { enabled: true, params: { THRE: 25 } },
      pre: { enabled: false },
      dst: { enabled: true, effect: 'Super OD', params: { Gain: 55, Tone: 55, VOL: 55 } },
      amp: { enabled: true, effect: 'L-Star CL', params: { Gain: 55, PRES: 60, VOL: 55, Bass: 50, Middle: 55, Treble: 55 } },
      cab: { enabled: true, effect: 'UK GRN 2x12' },
      eq: { enabled: false },
      mod: { enabled: false },
      dly: { enabled: true, effect: 'Analog', params: { Mix: 15, Time: 400, Feedback: 20, Trail: 0 } },
      rvb: { enabled: true, effect: 'Plate', params: { Mix: 22, Decay: 30, Damp: 40, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'hard_rock', label: '하드 록',
    keywords: ['하드록', 'hard rock', '80s', '아레나', '헤비록', '파워풀'],
    desc: '80년대 하드록 스타일의 두꺼운 리프 톤. 하이게인 오버드라이브와 강조된 미드로 파워풀하게.',
    blocks: {
      nr: { enabled: true, params: { THRE: 35 } },
      pre: { enabled: false },
      dst: { enabled: true, effect: 'SM Dist', params: { Gain: 65, Tone: 55, VOL: 55 } },
      amp: { enabled: true, effect: 'UK 45', params: { Gain: 60, PRES: 55, VOL: 55, Bass: 55, Middle: 60, Treble: 55 } },
      cab: { enabled: true, effect: 'UK GRN 4x12' },
      eq: { enabled: false },
      mod: { enabled: false },
      dly: { enabled: false },
      rvb: { enabled: true, effect: 'Room', params: { Mix: 15, Decay: 25, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'modern_metal', label: '모던 메탈',
    keywords: ['메탈', 'metal', '헤비', '다운튠', 'djent', '브루탈', 'brutal', '코어', '극한게인', '스래시'],
    desc: '타이트한 게이트와 극강의 게인으로 다진 모던 메탈 톤.',
    blocks: {
      nr: { enabled: true, params: { THRE: 55 } },
      pre: { enabled: false },
      dst: { enabled: true, effect: 'Darktale', params: { Gain: 75, Filter: 55, VOL: 55 } },
      amp: { enabled: true, effect: 'Mess DualV', params: { Gain: 70, PRES: 50, VOL: 55, Bass: 60, Middle: 35, Treble: 55 } },
      cab: { enabled: true, effect: 'Mess 4x12' },
      eq: { enabled: true, effect: 'Guitar EQ 2', params: { '100Hz': 10, '500Hz': -5, '1kHz': -10, '3kHz': 4, '6kHz': 6, VOL: 55 } },
      mod: { enabled: false },
      dly: { enabled: false },
      rvb: { enabled: false },
      ns: { enabled: false },
    },
  },
  {
    id: 'ambient_shoegaze', label: '몽환적인 슈게이징',
    keywords: ['앰비언트', 'ambient', '슈게이징', 'shoegaze', '드림팝', 'dream pop', '몽환', '아득', '우주'],
    desc: '두터운 리버브와 딜레이로 감싸는 몽환적인 슈게이징/앰비언트 톤.',
    blocks: {
      nr: { enabled: true, params: { THRE: 15 } },
      pre: { enabled: false },
      dst: { enabled: true, effect: 'Sora Fuzz', params: { Fuzz: 35, VOL: 45 } },
      amp: { enabled: true, effect: 'Dark Twin', params: { Gain: 40, VOL: 50, Bass: 55, Middle: 40, Treble: 55, Bright: 1 } },
      cab: { enabled: true, effect: 'Dark Twin 2x12' },
      eq: { enabled: false },
      mod: { enabled: true, effect: 'N-Jet', params: { Depth: 45, Rate: 0.6, 'P.Delay': 55, 'F.Back': 45 } },
      dly: { enabled: true, effect: 'Tape', params: { Mix: 45, Time: 550, 'F.Back': 45, Trail: 1 } },
      rvb: { enabled: true, effect: 'Church', params: { Mix: 55, Decay: 75, Trail: 1 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'funk_clean', label: '훵키 클린',
    keywords: ['훵키', 'funk', 'groove', '그루브', '치킨피킹', '컷팅'],
    desc: '탄탄한 컴프와 챙챙거리는 커팅감의 훵키 클린 톤.',
    blocks: {
      nr: { enabled: true, params: { THRE: 20 } },
      pre: { enabled: true, effect: 'COMP', params: { Sustain: 30, VOL: 55 } },
      dst: { enabled: false },
      amp: { enabled: true, effect: 'J-120 CL', params: { VOL: 55, Bass: 45, Middle: 55, Treble: 60, Bright: 1 } },
      cab: { enabled: true, effect: 'J-120 2x12' },
      eq: { enabled: false },
      mod: { enabled: true, effect: 'B-Chorus', params: { Depth: 15, Rate: 3.0, VOL: 50 } },
      dly: { enabled: true, effect: 'Slapback', params: { Mix: 12, Time: 90, 'F.Back': 10, Trail: 0 } },
      rvb: { enabled: true, effect: 'Room', params: { Mix: 15, Decay: 20, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'acoustic_sim', label: '어쿠스틱 시뮬레이션',
    keywords: ['어쿠스틱', 'acoustic', '통기타', '언플러그드', 'unplugged'],
    desc: '어쿠스틱 기타 느낌을 살린 톤. 앰프 시뮬레이터로 통기타 특유의 울림을 표현합니다.',
    blocks: {
      nr: { enabled: true, params: { THRE: 15 } },
      pre: { enabled: true, effect: 'COMP', params: { Sustain: 25, VOL: 55 } },
      dst: { enabled: false },
      amp: { enabled: true, effect: 'AC Pre1', params: { Volume: 55, Tone: 55, Balance: 50, 'EQ Freq': 50, 'EQ Q': 50, 'EQ Gain': 55 } },
      cab: { enabled: false },
      eq: { enabled: false },
      mod: { enabled: false },
      dly: { enabled: true, effect: 'Pure', params: { Mix: 12, Time: 300, 'F.Back': 10, Trail: 0 } },
      rvb: { enabled: true, effect: 'Room', params: { Mix: 30, Decay: 45, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'lofi_vintage', label: '로파이 빈티지',
    keywords: ['로파이', 'lo-fi', 'lofi', '빈티지 테이프', '테이프 딜레이', '올드스쿨', '노스탤지어', 'nostalgia'],
    desc: '테이프 딜레이와 어두운 톤으로 빚어낸 로파이/빈티지 감성.',
    blocks: {
      nr: { enabled: true, params: { THRE: 20 } },
      pre: { enabled: false },
      dst: { enabled: true, effect: 'Green OD', params: { Gain: 20, Tone: 40, VOL: 50 } },
      amp: { enabled: true, effect: 'Bellman 59B', params: { Gain: 30, PRES: 40, VOL: 50, Bass: 55, Middle: 50, Treble: 35 } },
      cab: { enabled: true, effect: 'Bellman 2x12' },
      eq: { enabled: false },
      mod: { enabled: false },
      dly: { enabled: true, effect: 'Tape', params: { Mix: 35, Time: 420, 'F.Back': 40, Trail: 1 } },
      rvb: { enabled: true, effect: 'Spring', params: { Mix: 25, Decay: 35, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'punk_raw', label: '펑크 록',
    keywords: ['펑크록', 'punk rock', 'punk', '하드코어', '개러지', 'garage', '펑크'],
    desc: '거칠고 다이렉트한 펑크록 디스토션. 군더더기 없이 직진하는 사운드.',
    blocks: {
      nr: { enabled: true, params: { THRE: 30 } },
      pre: { enabled: false },
      dst: { enabled: true, effect: 'Plustortion', params: { Gain: 70, VOL: 55 } },
      amp: { enabled: true, effect: 'UK 45', params: { Gain: 60, PRES: 50, VOL: 55, Bass: 50, Middle: 50, Treble: 60 } },
      cab: { enabled: true, effect: 'UK GRN 4x12' },
      eq: { enabled: false },
      mod: { enabled: false },
      dly: { enabled: false },
      rvb: { enabled: false },
      ns: { enabled: false },
    },
  },
  {
    id: 'country_twang', label: '컨트리 트웽',
    keywords: ['컨트리', 'country', '트웽', 'twang', '내슈빌', '텔레캐스터'],
    desc: '쨍하고 탄력있는 컨트리 트웽 톤.',
    blocks: {
      nr: { enabled: true, params: { THRE: 20 } },
      pre: { enabled: true, effect: 'COMP4', params: { Sustain: 25, Attack: 65, VOL: 55, Clip: 5 } },
      dst: { enabled: false },
      amp: { enabled: true, effect: 'Foxy 30N', params: { Gain: 30, 'Tone Cut': 45, VOL: 55, Bright: 1 } },
      cab: { enabled: true, effect: 'Foxy 1x12' },
      eq: { enabled: false },
      mod: { enabled: false },
      dly: { enabled: true, effect: 'Slapback', params: { Mix: 15, Time: 120, 'F.Back': 15, Trail: 0 } },
      rvb: { enabled: true, effect: 'Spring', params: { Mix: 22, Decay: 30, Trail: 0 } },
      ns: { enabled: false },
    },
  },
  {
    id: 'ballad_reverb', label: '감성 발라드',
    keywords: ['발라드', 'ballad', '서정적', '잔잔한', '감성', 'emotional', '이별', '눈물'],
    desc: '길게 울리는 리버브로 감정을 담아내는 발라드 클린 톤.',
    blocks: {
      nr: { enabled: true, params: { THRE: 15 } },
      pre: { enabled: false },
      dst: { enabled: false },
      amp: { enabled: true, effect: 'Match CL', params: { Gain: 22, PRES: 60, VOL: 55, Bass: 50, Middle: 50, Treble: 55 } },
      cab: { enabled: true, effect: 'Bellman 2x12' },
      eq: { enabled: false },
      mod: { enabled: true, effect: 'A-Chorus', params: { Depth: 20, Rate: 1.2, Tone: 55 } },
      dly: { enabled: true, effect: 'Sweet Echo', params: { Mix: 25, Time: 450, 'F.Back': 25, Trail: 1 } },
      rvb: { enabled: true, effect: 'Hall', params: { Mix: 40, Decay: 60, Trail: 1 } },
      ns: { enabled: false },
    },
  },
];

const TONE_CHIP_EXAMPLES = [
  '따뜻한 빈티지 블루스, 리버브는 살짝만',
  '80년대 하드록 리프 톤, 게인 강하게',
  '몽환적인 슈게이징, 리버브 풍성하게',
  '어쿠스틱 통기타 느낌',
  '타이트한 모던 메탈',
  '재즈 느낌의 부드러운 클린',
];

// Looks up a param's { min, max } for clamping, following the same block/effect/parameter
// shape the drawer itself reads (block.effects[x].parameters, or block.parameters for
// effect-less blocks like ns).
function findToneParamDef(blockName, effectName, paramName) {
  const block = state.config.blocks.find((b) => b.name === blockName);
  if (!block) return null;
  const effects = block.effects || {};
  const effData = effectName
    ? Object.values(effects).find((e) => e.name === effectName)
    : Object.values(effects)[0]; // single-effect blocks like nr's Gate
  const params = effData?.parameters || block.parameters || [];
  return params.find((p) => p.name === paramName) || null;
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// Nudges one param on one block (if that block is enabled in the recipe) by a delta,
// clamped to the real device range for whichever effect the recipe picked.
function adjustToneParam(blocks, blockName, paramName, delta) {
  const rb = blocks[blockName];
  if (!rb || rb.enabled === false) return;
  const def = findToneParamDef(blockName, rb.effect, paramName);
  if (!def) return;
  const current = rb.params?.[paramName] ?? def.default;
  rb.params = rb.params || {};
  rb.params[paramName] = clamp(current + delta, def.min, def.max);
}

function scaleToneParam(blocks, blockName, paramName, factor) {
  const rb = blocks[blockName];
  if (!rb || rb.enabled === false) return;
  const def = findToneParamDef(blockName, rb.effect, paramName);
  if (!def) return;
  const current = rb.params?.[paramName] ?? def.default;
  rb.params = rb.params || {};
  rb.params[paramName] = clamp(Math.round(current * factor), def.min, def.max);
}

// Small, deliberately conservative set of fine-tuning phrases layered on top of whichever
// archetype matched — enough to cover "리버브 많이", "게인 낮게" style requests without
// trying to be a full parser.
const TONE_MODIFIERS = [
  { label: '리버브 강조', test: /리버브.*?(많이|진하게|크게|풍성)|more reverb|drench/, apply: (b) => { adjustToneParam(b, 'rvb', 'Mix', 20); adjustToneParam(b, 'rvb', 'Decay', 15); } },
  { label: '리버브 줄임', test: /리버브.*?(적게|약하게|살짝만|줄여|은은)/, apply: (b) => { adjustToneParam(b, 'rvb', 'Mix', -15); adjustToneParam(b, 'rvb', 'Decay', -10); } },
  { label: '딜레이 길게', test: /딜레이.*?(길게|넉넉)|long delay/, apply: (b) => scaleToneParam(b, 'dly', 'Time', 1.4) },
  { label: '딜레이 짧게', test: /딜레이.*?(짧게|타이트)|short delay|tight delay/, apply: (b) => scaleToneParam(b, 'dly', 'Time', 0.6) },
  { label: '게인 강조', test: /게인.*?(높게|세게|강하게)|드라이브.*?(강하게|세게)|more gain|more drive/, apply: (b) => { adjustToneParam(b, 'dst', 'Gain', 15); adjustToneParam(b, 'amp', 'Gain', 15); } },
  { label: '게인 낮춤', test: /게인.*?(낮게|약하게)|드라이브.*?(약하게)|less gain/, apply: (b) => { adjustToneParam(b, 'dst', 'Gain', -15); adjustToneParam(b, 'amp', 'Gain', -15); } },
  { label: '디스토션 제거', test: /디스토션.*?(빼|없이|off)|no distortion|clean only|클린하게/, apply: (b) => { if (b.dst) b.dst.enabled = false; } },
  { label: '베이스 강조', test: /베이스.*?(부스트|강조|두껍게)|more bass/, apply: (b) => adjustToneParam(b, 'amp', 'Bass', 15) },
  { label: '트레블 강조', test: /트레블.*?(부스트|강조|밝게)|more treble|brighter/, apply: (b) => adjustToneParam(b, 'amp', 'Treble', 15) },
  { label: '미드 스쿱', test: /미드.*?(스쿱|빼|줄여)|mid scoop|scooped mid/, apply: (b) => adjustToneParam(b, 'amp', 'Middle', -20) },
];

// Purely local keyword scoring, no network call: every archetype's keyword list is tested
// as a substring of the (lowercased) input, longer/more specific keywords counting for more
// so e.g. "블루스" outweighs a stray one-off match. Falls back to Classic Rock (with a
// `fallback: true` flag the UI surfaces) when nothing scores above zero.
function generateTonePreset(rawText) {
  const text = (rawText || '').trim();
  if (!text) return null;
  const lc = text.toLowerCase();

  let best = null, bestScore = 0, bestKeywords = [];
  TONE_ARCHETYPES.forEach((arch) => {
    let score = 0;
    const hits = [];
    arch.keywords.forEach((kw) => {
      if (lc.includes(kw.toLowerCase())) {
        score += kw.length >= 3 ? 2 : 1;
        hits.push(kw);
      }
    });
    if (score > bestScore) {
      bestScore = score;
      best = arch;
      bestKeywords = hits;
    }
  });

  const fallback = bestScore === 0;
  const archetype = best || TONE_ARCHETYPES.find((a) => a.id === 'classic_rock');
  const blocks = JSON.parse(JSON.stringify(archetype.blocks));
  const appliedModifiers = [];
  TONE_MODIFIERS.forEach((mod) => {
    if (mod.test.test(lc)) {
      mod.apply(blocks);
      appliedModifiers.push(mod.label);
    }
  });

  return { archetype, blocks, matchedKeywords: bestKeywords, fallback, appliedModifiers };
}

function formatToneParamValue(v) {
  return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v);
}

function renderToneResult(result) {
  const { archetype, blocks, matchedKeywords, fallback, appliedModifiers } = result;
  els.toneResultTag.textContent = archetype.label;
  els.toneResultDesc.textContent = archetype.desc + (fallback
    ? ' (특정 장르 키워드를 찾지 못해 기본 톤을 적용했어요. 장르나 아티스트, 분위기를 조금 더 구체적으로 적어보면 더 정확해져요.)'
    : '');

  els.toneResultBlocks.innerHTML = '';
  BLOCK_ORDER.forEach((name) => {
    const block = state.config.blocks.find((b) => b.name === name);
    const rb = blocks[name];
    const isOn = !!rb?.enabled;
    const paramsText = rb?.params
      ? Object.entries(rb.params).map(([k, v]) => `${k} ${formatToneParamValue(v)}`).join(', ')
      : '';
    const row = document.createElement('div');
    row.className = 'tone-block-row' + (isOn ? ' on' : '');
    row.innerHTML = `
      <span class="tone-block-name">${SHORT_LABEL[name] || name.toUpperCase()}</span>
      <span class="tone-block-detail">${isOn ? escapeHtml(rb.effect || block?.label || 'ON') : 'OFF'}</span>
      ${paramsText ? `<span class="tone-block-params">${escapeHtml(paramsText)}</span>` : ''}
    `;
    els.toneResultBlocks.appendChild(row);
  });

  const hintParts = [];
  if (matchedKeywords.length) hintParts.push(`인식된 키워드: ${matchedKeywords.join(', ')}`);
  if (appliedModifiers.length) hintParts.push(`세부 조정: ${appliedModifiers.join(', ')}`);
  els.toneApplyHint.textContent = hintParts.join(' · ');

  els.toneResult.hidden = false;
  els.toneApplyBtn.disabled = state.transport !== 'bluetooth' || !state.connected;
  state.pendingTonePreset = blocks;
}

function onToneGenerateClick() {
  const result = generateTonePreset(els.toneInput.value);
  if (!result) {
    showToast('원하는 톤을 먼저 입력해주세요', true);
    return;
  }
  renderToneResult(result);
}

async function onToneApplyClick() {
  if (!state.pendingTonePreset) return;
  await applyTonePresetToDevice(state.pendingTonePreset);
}

// Applies a generated recipe through the exact same commands the drawer uses (toggle,
// effect-change, param-change), so it inherits the existing settle-time handling — only
// difference is we're doing it for every block in one sweep instead of one knob at a time.
async function applyTonePresetToDevice(blocksSpec) {
  if (state.transport !== 'bluetooth' || !state.bleChar) {
    showToast('AI 톤메이커는 Bluetooth 연결 상태에서만 적용할 수 있습니다', true);
    return false;
  }
  els.toneApplyBtn.disabled = true;
  setConnecting(true, 'GP5에 프리셋 적용하는 중...');
  try {
    for (const name of BLOCK_ORDER) {
      const rb = blocksSpec[name];
      const block = state.config.blocks.find((b) => b.name === name);
      if (!rb || !block) continue;

      sendBlockToggle(block, !!rb.enabled);
      if (!rb.enabled) { await sleep(60); continue; }

      let effData = null;
      if (rb.effect && block.effects) {
        const entry = Object.entries(block.effects).find(([, eff]) => eff.name === rb.effect);
        if (entry) {
          const [effHex, eff] = entry;
          const bState = state.blocks[name] || {};
          if (bState.effectId !== effHex) sendBlockEffectChange(block, effHex);
          effData = eff;
        }
      }

      const paramDefs = effData?.parameters || block.parameters || [];
      if (rb.params) {
        for (const [paramName, value] of Object.entries(rb.params)) {
          const paramDef = paramDefs.find((p) => p.name === paramName);
          if (!paramDef) continue;
          await sendParamChange(block, paramDef.index, value);
        }
      }
      await sleep(60);
    }
    showToast('프리셋을 GP5에 적용했습니다. 마음에 들면 SAVE로 저장하세요.');
    setStatus('AI 톤메이커 프리셋 적용 완료');
    return true;
  } catch (err) {
    showToast('프리셋 적용 중 오류: ' + err.message, true);
    return false;
  } finally {
    setConnecting(false);
    els.toneApplyBtn.disabled = state.transport !== 'bluetooth' || !state.connected;
  }
}

function buildToneChips() {
  els.toneChips.innerHTML = '';
  TONE_CHIP_EXAMPLES.forEach((phrase) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tone-chip';
    chip.textContent = phrase;
    chip.addEventListener('click', () => {
      els.toneInput.value = phrase;
      renderToneResult(generateTonePreset(phrase));
    });
    els.toneChips.appendChild(chip);
  });
}

function refreshToneConnBanner() {
  const ok = state.transport === 'bluetooth' && state.connected;
  els.toneConnBanner.hidden = ok;
  if (!ok) {
    els.toneConnBanner.textContent = state.connected
      ? '⚠ USB 연결에서는 효과/파라미터를 바꿀 수 없습니다. 프리셋 미리보기만 가능해요 — 적용하려면 Bluetooth로 연결하세요.'
      : '⚠ 아직 GP5에 연결되지 않았습니다. 프리셋 미리보기는 가능하지만, 적용하려면 먼저 Bluetooth로 연결하세요.';
  }
  if (els.toneApplyBtn) els.toneApplyBtn.disabled = !ok || !state.pendingTonePreset;
}

function openToneScreen() {
  refreshToneConnBanner();
  els.toneScreen.classList.add('show');
}

function closeToneScreen() {
  els.toneScreen.classList.remove('show');
}

/* ==================== Status bar ==================== */

function setStatus(msg, isError) {
  els.statusText.textContent = msg;
  els.statusText.classList.toggle('error', !!isError);
}
function showSpinner(show) {
  els.statusSpinner.classList.toggle('active', show);
}
