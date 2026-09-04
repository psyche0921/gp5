'use strict';

/* ============================================================
   GP5 Pedalboard Controller
   Bluetooth (Web Bluetooth + SysEx) and USB (Web MIDI + CC) transport
   for the Valeton GP5 multi-effects pedal.
   ============================================================ */

// Bumped by hand on each deploy — yymmddHHMM of when this build was pushed.
const BUILD_VERSION = '2609041438';

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
};

const $ = (sel) => document.querySelector(sel);
const els = {};

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
}

function cacheEls() {
  els.pedalboard = $('#pedalboard');
  els.transportSelect = $('#transportSelect');
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
  els.masterVolWrap = $('#masterVolWrap');
  els.masterVol = $('#masterVol');
  els.masterVolValue = $('#masterVolValue');
  els.drawer = $('#drawer');
  els.drawerTitle = $('#drawerTitle');
  els.drawerClose = $('#drawerClose');
  els.drawerEffectSelect = $('#drawerEffectSelect');
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
}

function bindStaticEvents() {
  els.connectBtn.addEventListener('click', onConnectClick);
  els.rescanBtn.addEventListener('click', () => { if (!state.connected) attemptConnect(); });
  els.patchPrev.addEventListener('click', () => navigatePatch(-1));
  els.patchNext.addEventListener('click', () => navigatePatch(1));
  els.patchOpenList.addEventListener('click', openPatchList);
  els.patchListClose.addEventListener('click', closePatchList);
  els.tunerBtn.addEventListener('click', toggleTuner);
  els.savePatchBtn.addEventListener('click', savePatch);
  els.masterVol.addEventListener('input', onMasterVolInput);
  els.drawerClose.addEventListener('click', closeDrawer);
  els.scrim.addEventListener('click', () => { closeDrawer(); closePatchList(); });
  els.midiLogToggle.addEventListener('click', () => {
    if (els.midiLog.classList.contains('show')) closeMidiLog();
    else openMidiLog();
  });
  els.midiLogClose.addEventListener('click', closeMidiLog);
  els.midiLogClear.addEventListener('click', () => { els.midiLogBody.innerHTML = ''; });
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

function openDrawer(block, keepEffect = true) {
  state.activeBlock = block;
  els.drawerTitle.innerHTML = `<span class="drawer-title-icon">${ICONS[block.name] || ''}</span>${block.label}`;
  els.drawer.style.setProperty('--hue', BLOCK_HUE[block.name] ?? 200);

  const bState = state.blocks[block.name] || {};
  const effects = Object.entries(block.effects || {});
  const isBluetooth = state.transport === 'bluetooth';

  // Effect select
  els.drawerEffectSelect.innerHTML = '';
  if (effects.length) {
    effects.forEach(([effHex, eff]) => {
      const opt = document.createElement('option');
      opt.value = effHex;
      opt.textContent = eff.name;
      if (bState.effectId === effHex || (!bState.effectId && eff.id === (bState.effect || 0))) opt.selected = true;
      els.drawerEffectSelect.appendChild(opt);
    });
  } else {
    const opt = document.createElement('option');
    opt.textContent = block.note || '이 블록은 효과 목록이 고정되어 있지 않습니다';
    els.drawerEffectSelect.appendChild(opt);
  }
  els.drawerEffectSelect.disabled = !isBluetooth || effects.length === 0;
  els.drawerEffectSelect.onchange = () => {
    const effHex = els.drawerEffectSelect.value;
    sendBlockEffectChange(block, effHex);
    setTimeout(() => openDrawer(block, false), 150);
  };

  // On/off toggle
  els.drawerToggle.checked = !!bState.enabled;
  els.drawerToggleLabel.textContent = bState.enabled ? 'ON' : 'OFF';
  els.drawerToggle.onchange = () => {
    els.drawerToggleLabel.textContent = els.drawerToggle.checked ? 'ON' : 'OFF';
    sendBlockToggle(block, els.drawerToggle.checked);
  };

  // Parameters -> knobs
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
    const value = keepEffect ? (bState.parameters?.[algId] ?? param.default) : Math.round((param.min + param.max) / 2);
    els.drawerKnobs.appendChild(buildKnob(block, param, algId, value, isBluetooth));
  });

  els.drawer.classList.add('open');
  els.scrim.classList.add('show');
}

function closeDrawer() {
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

  const floatHex = floatToHexLE(value).join('');
  const command = state.config.block_commands.change_parameter.command_template
    .replace('{BLOCK}', block.id.toString(16).padStart(2, '0'))
    .replace('{PARAM_NUM}', paramIndex.toString(16).padStart(2, '0'))
    .replace('{VALUE_FLOAT_HEX}', floatHex);
  sendSysex(buildSysexCommand(command));

  state.blocks[block.name] = state.blocks[block.name] || {};
  state.blocks[block.name].parameters = state.blocks[block.name].parameters || [];
  state.blocks[block.name].parameters[paramIndex] = value;
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

// Commits the current live edits to the active patch slot on GP5. There's no
// documented SysEx command for this — it was reverse-engineered from a BLE HCI snoop
// capture of Valeton Suite's own Save action (patch number + a 10-byte, zero-padded
// ASCII name field), since GP5 otherwise discards parameter/effect edits on patch
// change or power-off.
async function savePatch() {
  if (state.transport !== 'bluetooth' || !state.bleChar) return;
  await waitForEffectChangeSettle();
  const name = (state.patchNames[state.currentPatch] || '').slice(0, 10);
  const nameHex = Array.from({ length: 10 }, (_, i) => (name.charCodeAt(i) || 0).toString(16).padStart(2, '0')).join('');
  const command = state.config.patch_commands.save_patch.command_template
    .replace('{PATCH}', state.currentPatch.toString(16).padStart(2, '0'))
    .replace('{NAME}', nameHex);

  els.savePatchBtn.disabled = true;
  setConnecting(true, '패치 저장하는 중...');
  await sendSysex(buildSysexCommand(command));
  await sleep(150);
  setConnecting(false);
  els.savePatchBtn.disabled = false;

  els.savePatchBtn.classList.add('saved');
  setTimeout(() => els.savePatchBtn.classList.remove('saved'), 1200);
  showToast(`패치 ${state.currentPatch} "${name || '(이름 없음)'}" 저장 완료`);
  setStatus(`패치 ${state.currentPatch} 저장 완료`);
}

function navigatePatch(dir) {
  const total = state.transport === 'bluetooth' ? Math.max(state.patchNames.length, 1) : 100;
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
    if (bytes[7] === 0 && bytes[8] === 0) parsePatchData1(bytes);
    else if (bytes[7] === 0 && bytes[8] === 1) parsePatchData2(bytes);
    if (bytes[7] === 0 && bytes[8] >= 0 && bytes[8] <= 3) {
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
}

function parsePatchData2(bytes) {
  const offsets = { dst: 11, ns: 67, amp: 19, cab: 27, eq: 35, mod: 43, dly: 51, rvb: 59 };
  Object.entries(offsets).forEach(([name, offset]) => {
    const effHex = readEffectIdHex(bytes, offset);
    state.blocks[name] = state.blocks[name] || {};
    state.blocks[name].effectId = effHex;
    const block = state.config.blocks.find((b) => b.name === name);
    const effData = block?.effects?.[effHex];
    if (effData) {
      state.blocks[name].effect = effData.id;
      state.blocks[name].effectName = effData.name;
    }
  });
  refreshAllPedals();
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
//   - part2+part3 concatenated (200 bytes): dst..rvb (blockIndex 2-8), offset =
//     (blockIndex - 2) * 32 + paramIndex * 4
//   - part4 (68 decoded bytes): ns (NAM), offset = 24 + paramIndex * 4
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
    // Fallback: if we don't know the effect (old version, loading before effect decoded),
    // read all 8 slots sequentially as a safe default.
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
    const buf = part2.concat(part3);
    ['dst', 'amp', 'cab', 'eq', 'mod', 'dly', 'rvb'].forEach((name) => {
      const blockIdx = BLOCK_ORDER.indexOf(name);
      extractBlockParams(name, buf, (blockIdx - 2) * 32);
    });
  }
  if (part4) {
    extractBlockParams('ns', part4, 24);
  }
}

// The effect-ID byte for each block lives at (declared offset + 7) -- the LAST byte of
// its 8-byte stride, not the first -- and it's a single byte, not 4: verified via a live
// raw-byte dump against Valeton Suite's own display (dly byte 0x0b -> Suite showed "Pure";
// rvb byte 0x0c -> Suite showed "Room"). ble_sysex.json keys are 8-hex-char strings whose
// only non-zero byte is this one, so pad it out to match. Reading straight from `start`
// (the old behavior) always landed on 0x00, silently falling back to whichever effect has
// id 0 for that block -- which is why an effect-type change never appeared to "stick" on
// reload even though it was actually saved correctly on the device the whole time.
// The per-block 8-byte stride in patch_data part 2 holds the distinguishing effect byte
// at (start+1), not at `start` itself -- verified by dumping the full raw packet and
// searching for the byte value Valeton Suite confirmed as ground truth (Church reverb's
// key "0200000c" -> distinguishing byte 0x02): it appears exactly once inside rvb's own
// 8-byte region, at start+1. byte(start+7) is a constant "family" marker shared by every
// effect in that block (0x0c for every reverb, 0x0b for every delay, etc.) -- reading
// that instead (the previous, wrong assumption) always decoded to whichever effect in
// the family has distinguishing byte 0, regardless of what's actually live on the device.
function readEffectIdHex(bytes, start) {
  const distinguishing = bytes[start + 1];
  const marker = bytes[start + 7];
  if (distinguishing === undefined || marker === undefined) return '';
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

/* ==================== Status bar ==================== */

function setStatus(msg, isError) {
  els.statusText.textContent = msg;
  els.statusText.classList.toggle('error', !!isError);
}
function showSpinner(show) {
  els.statusSpinner.classList.toggle('active', show);
}
