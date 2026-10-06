'use strict';
/*
 * バケカ — 音（BGM と効果音）
 * 音のファイルは使わず、Web Audio でその場で8ビット風の音を作る。
 */

const SND = {
  ctx: null, master: null, bgmGain: null, sfxGain: null, noiseBuf: null,
  vol: loadVol(),
  playing: false, step: 0, nextTime: 0, timer: null,
};

function loadVol() {
  try {
    const v = JSON.parse(localStorage.getItem('bakeka-sound') || 'null');
    if (v && typeof v.bgm === 'number') return { bgm: v.bgm, sfx: v.sfx, mute: !!v.mute };
  } catch { /* 保存できない環境でも鳴らす */ }
  return { bgm: 0.5, sfx: 0.7, mute: false };
}

function saveVol() {
  try { localStorage.setItem('bakeka-sound', JSON.stringify(SND.vol)); } catch { /* 保存できなくても動く */ }
}

// 最初に画面にふれたときに音を使えるようにする（ブラウザの決まり）
function audio() {
  if (!SND.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    SND.ctx = ctx;
    SND.master = ctx.createGain();
    SND.master.connect(ctx.destination);
    SND.bgmGain = ctx.createGain();
    SND.sfxGain = ctx.createGain();
    SND.bgmGain.connect(SND.master);
    SND.sfxGain.connect(SND.master);
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    SND.noiseBuf = buf;
    applyVol();
  }
  if (SND.ctx.state === 'suspended') SND.ctx.resume().catch(() => {});
  return SND.ctx;
}

function applyVol() {
  if (!SND.ctx) return;
  SND.master.gain.value = SND.vol.mute ? 0 : 1;
  SND.bgmGain.gain.value = SND.vol.bgm * 0.5;
  SND.sfxGain.gain.value = SND.vol.sfx;
}

const hz = n => 440 * Math.pow(2, (n - 69) / 12);

function tone(dest, type, freq, t, dur, vol, slideTo) {
  const ctx = SND.ctx;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dest, t, dur, vol, ftype = 'highpass', f0 = 4000, f1 = null) {
  const ctx = SND.ctx;
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = SND.noiseBuf;
  f.type = ftype;
  f.frequency.setValueAtTime(f0, t);
  if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t); s.stop(t + dur + 0.02);
}

/* ───────── 効果音 ───────── */

const SFX = {
  tap: t => tone(SND.sfxGain, 'square', 880, t, 0.04, 0.04),
  draw: t => { noise(SND.sfxGain, t, 0.16, 0.12, 'bandpass', 1500, 5000); tone(SND.sfxGain, 'triangle', 660, t + 0.08, 0.06, 0.08); },
  summon: t => [523, 659, 784, 1047].forEach((f, i) => tone(SND.sfxGain, 'square', f, t + i * 0.06, 0.09, 0.07)),
  set: t => { tone(SND.sfxGain, 'triangle', 220, t, 0.14, 0.2, 110); noise(SND.sfxGain, t, 0.05, 0.06, 'lowpass', 900); },
  magic: t => [1047, 1319, 1568, 2093, 2637].forEach((f, i) => tone(SND.sfxGain, 'sine', f, t + i * 0.05, 0.18, 0.07)),
  energy: t => { tone(SND.sfxGain, 'sine', 1319, t, 0.22, 0.1); tone(SND.sfxGain, 'sine', 1976, t + 0.05, 0.2, 0.06); },
  attack: t => noise(SND.sfxGain, t, 0.28, 0.16, 'bandpass', 600, 4000),
  hit: t => { tone(SND.sfxGain, 'square', 140, t, 0.16, 0.14, 50); noise(SND.sfxGain, t, 0.12, 0.2, 'lowpass', 2500); },
  clash: t => { tone(SND.sfxGain, 'sawtooth', 220, t, 0.22, 0.08); tone(SND.sfxGain, 'sawtooth', 233, t, 0.22, 0.08); noise(SND.sfxGain, t, 0.2, 0.18, 'highpass', 2000); },
  destroy: t => { noise(SND.sfxGain, t, 0.45, 0.2, 'lowpass', 3000, 200); tone(SND.sfxGain, 'square', 330, t, 0.4, 0.08, 70); },
  life: t => { noise(SND.sfxGain, t, 0.12, 0.18, 'highpass', 5000); tone(SND.sfxGain, 'triangle', 1568, t, 0.12, 0.1); tone(SND.sfxGain, 'triangle', 1175, t + 0.06, 0.16, 0.09); },
  trap: t => { tone(SND.sfxGain, 'sawtooth', 180, t, 0.3, 0.09, 900); tone(SND.sfxGain, 'square', 90, t + 0.05, 0.25, 0.08); },
  direct: t => { noise(SND.sfxGain, t, 0.9, 0.3, 'lowpass', 1800, 80); tone(SND.sfxGain, 'sine', 90, t, 0.8, 0.35, 35); },
  turn: t => { tone(SND.sfxGain, 'triangle', 784, t, 0.12, 0.12); tone(SND.sfxGain, 'triangle', 1047, t + 0.12, 0.18, 0.12); },
  win: t => {
    [523, 659, 784, 1047].forEach((f, i) => tone(SND.sfxGain, 'square', f, t + i * 0.13, 0.14, 0.08));
    [523, 659, 784, 1047].forEach(f => tone(SND.sfxGain, 'triangle', f, t + 0.55, 0.9, 0.07));
  },
  lose: t => [392, 349, 330, 262].forEach((f, i) => tone(SND.sfxGain, 'triangle', f, t + i * 0.28, 0.32, 0.12)),
};

// 効果音を鳴らす。net=true のときは、オンライン対戦の相手にも鳴らしてもらう
function sfx(name, net = false) {
  if (net) NET?.fx('sfx', [name]);
  if (SND.vol.mute || SND.vol.sfx <= 0) return;
  const ctx = audio();
  if (!ctx || ctx.state !== 'running' || !SFX[name]) return;
  try { SFX[name](ctx.currentTime + 0.01); } catch { /* 音が鳴らなくてもゲームは続ける */ }
}

/* ───────── BGM（明るい8ビットのループ） ───────── */

const BPM = 132;
const STEP = 60 / BPM / 2; // 8分音符
const ROOTS = [48, 45, 41, 43, 48, 45, 41, 43]; // C Am F G をくり返す
const LEAD = [
  72, 76, 79, 76, 74, 76, 72, null,
  72, 69, 72, 76, 74, 72, 69, null,
  69, 72, 77, 76, 74, 72, 74, 76,
  79, 77, 76, 74, 71, 74, 79, null,
  79, null, 79, 76, 77, 76, 74, 72,
  76, null, 76, 72, 74, 72, 69, 72,
  77, 76, 74, 72, 74, 76, 77, 79,
  79, 77, 74, 71, 72, null, null, null,
];

function bgmStep(i, t) {
  const g = SND.bgmGain;
  const bar = Math.floor(i / 8), beat = i % 8;
  const root = ROOTS[bar];
  if (LEAD[i] != null) tone(g, 'square', hz(LEAD[i]), t, STEP * 0.9, 0.05);
  tone(g, 'triangle', hz(beat % 2 ? root + 12 : root), t, STEP * 0.95, 0.16);
  if (beat === 0 || beat === 4) tone(g, 'sine', 120, t, 0.12, 0.25, 45);
  if (beat === 2 || beat === 6) noise(g, t, 0.1, 0.07, 'bandpass', 1800);
  noise(g, t, 0.03, 0.025, 'highpass', 8000);
}

function bgmTick() {
  const ctx = SND.ctx;
  while (SND.nextTime < ctx.currentTime + 0.25) {
    if (SND.nextTime < ctx.currentTime - 0.1) SND.nextTime = ctx.currentTime + 0.05; // 裏に回って遅れたら追いつく
    bgmStep(SND.step, SND.nextTime);
    SND.nextTime += STEP;
    SND.step = (SND.step + 1) % LEAD.length;
  }
}

function bgm(on) {
  if (!on) {
    clearInterval(SND.timer);
    SND.timer = null;
    SND.playing = false;
    return;
  }
  if (SND.playing) return;
  const ctx = audio();
  if (!ctx) return;
  SND.playing = true;
  SND.step = 0;
  SND.nextTime = ctx.currentTime + 0.1;
  SND.timer = setInterval(() => { if (SND.ctx.state === 'running') bgmTick(); }, 60);
}

/* ───────── 音の設定の画面 ───────── */

function openSound() {
  $('#vbgm').value = Math.round(SND.vol.bgm * 100);
  $('#vsfx').value = Math.round(SND.vol.sfx * 100);
  $('#vmute').checked = SND.vol.mute;
  showVolLabels();
  $('#sound').hidden = false;
}

function showVolLabels() {
  $('#vbgmv').textContent = $('#vbgm').value;
  $('#vsfxv').textContent = $('#vsfx').value;
}

$('#vbgm').addEventListener('input', () => { SND.vol.bgm = $('#vbgm').value / 100; audio(); applyVol(); showVolLabels(); saveVol(); });
$('#vsfx').addEventListener('input', () => { SND.vol.sfx = $('#vsfx').value / 100; audio(); applyVol(); showVolLabels(); saveVol(); });
$('#vsfx').addEventListener('change', () => sfx('summon'));
$('#vmute').addEventListener('change', () => { SND.vol.mute = $('#vmute').checked; audio(); applyVol(); saveVol(); });
$('#vtest').onclick = () => { audio(); if (SND.playing) bgm(false); else bgm(true); $('#vtest').textContent = SND.playing ? 'BGMを止める' : 'BGMをためしに鳴らす'; };
$('#soundclose').onclick = () => {
  $('#sound').hidden = true;
  if (!G) { bgm(false); $('#vtest').textContent = 'BGMをためしに鳴らす'; }
};
document.querySelectorAll('[data-sound]').forEach(b => { b.onclick = openSound; });

// 画面にふれたら音を使えるようにして、ボタンは小さく鳴らす
document.addEventListener('pointerdown', e => {
  audio();
  if (e.target.closest('button, .choice')) sfx('tap');
}, { capture: true });
document.addEventListener('visibilitychange', () => {
  if (!SND.ctx) return;
  if (document.hidden) SND.ctx.suspend().catch(() => {});
  else SND.ctx.resume().catch(() => {});
});
