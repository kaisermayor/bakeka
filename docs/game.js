'use strict';
/* バケカ — ルール処理・画面・CPU */

const $ = (s, el = document) => el.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const def = c => CARD_DB[c.id];
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const fmt = v => (v === Infinity ? '∞' : String(v));
const nm = c => def(c).short || def(c).name;

const RULES = { energy: 10, normal: 15, maxCopies: 2, life: 3, hand: 3, slots: 3 };
const TYPE_LABEL = { monster: 'モンスター', magic: 'まほう', trap: 'わな', equip: 'そうび', field: 'フィールド', energy: 'エネルギー' };
const PHASES = [
  { id: 'main', label: 'メイン', hint: 'カードを使う → エネルギー → 攻撃' },
  { id: 'energy', label: 'エネルギー', hint: 'エネルギーをモンスターへ（1体1枚まで）' },
  { id: 'attack', label: '攻撃', hint: 'モンスターを相手へドラッグして攻撃' },
];

class GameOver extends Error {}
class SkipTurn extends Error {}

let G = null;
let NET = null; // オンライン対戦の通信（online.js が入れる）
const isGuest = () => !!(NET && G && G.mode === 'online' && !NET.isHost);
const UI = { busy: false, viewer: 0, opts: null, art: loadArt(), lastViewer: null, from: new Map(), noClick: false };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadArt() {
  try { return localStorage.getItem('bakeka-art') === 'original' ? 'original' : 'design'; } catch { return 'design'; }
}
function setArt(v) {
  UI.art = v;
  try { localStorage.setItem('bakeka-art', v); } catch { /* 保存できなくても動く */ }
  renderArtControls();
  UI.lastViewer = null; // 切りかえでカードが動いて見えないように
  render();
}
let uidSeq = 1;

/* ───────── 準備 ───────── */

function deckProblems(deck) {
  const count = {};
  for (const [id, n] of deck.cards) count[id] = (count[id] || 0) + n;
  const energy = count.energy || 0;
  const normal = Object.entries(count).filter(([id]) => id !== 'energy').reduce((s, [, n]) => s + n, 0);
  const out = [];
  if (energy !== RULES.energy) out.push(`エネルギーが${energy}枚（${RULES.energy}枚必要）`);
  if (normal !== RULES.normal) out.push(`通常カードが${normal}枚（${RULES.normal}枚必要）`);
  for (const [id, n] of Object.entries(count)) {
    if (id !== 'energy' && n > RULES.maxCopies) out.push(`「${CARD_DB[id].name}」が${n}枚（${RULES.maxCopies}枚まで）`);
  }
  return out;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck(deck) {
  const cards = [];
  for (const [id, n] of deck.cards) for (let k = 0; k < n; k++) cards.push({ uid: uidSeq++, id });
  return shuffle(cards);
}

function makePlayer(i, o) {
  return {
    i, name: o.names[i], cpu: o.mode === 'cpu' && i === 1, deckName: DECKS[o.decks[i]].name,
    deck: [], hand: [], life: [], mons: [null, null, null], trap: null, field: null, grave: [], egrave: [], noDirect: -1,
  };
}

function newGame(o) {
  UI.opts = o;
  bgm(true);
  UI.lastViewer = null;
  G = { mode: o.mode, hide: o.hide, players: [0, 1].map(i => makePlayer(i, o)), turn: 0, current: 0, phase: 'start', winner: null, reason: '', log: [] };
  G.players.forEach((p, i) => {
    p.deck = buildDeck(DECKS[o.decks[i]]);
    p.life = p.deck.splice(0, RULES.life);
    p.hand = p.deck.splice(0, RULES.hand);
  });
  G.current = Math.random() < 0.5 ? 0 : 1;
  UI.viewer = G.mode === 'cpu' || G.mode === 'online' ? 0 : G.current;
  $('#title').hidden = true;
  $('#result').hidden = true;
  $('#game').hidden = false;
  // 2人対戦で手札をかくすときは、最初の人に渡すまで盤面を見せない
  if (G.mode === 'hot' && G.hide) {
    $('#passname').textContent = '';
    $('#passmsg').textContent = '先行・後攻を決めています…';
    $('#pass').hidden = false;
  }
  log(`先行は${G.players[G.current].name}`);
  for (const id of ['#opp', '#me', '#hand']) $(id).innerHTML = '';
  UI.from.clear();
  UI.lastViewer = UI.viewer;
  if (!(G.mode === 'cpu' && G.players[UI.viewer].cpu)) {
    for (const c of G.players[UI.viewer].hand) UI.from.set(String(c.uid), { pi: UI.viewer, pile: 'deck' });
  }
  render();
  run(async () => {
    toast(`先行は ${G.players[G.current].name}`, 'big');
    await sleep(900);
    await startTurn(true);
  });
}

/* ───────── 小道具 ───────── */

const cur = () => G.players[G.current];
const energyIn = p => p.hand.filter(c => c.id === 'energy');
const canPay = (p, n) => energyIn(p).length >= n;
const slotsOf = p => p.mons.map((m, i) => (m ? i : -1)).filter(i => i >= 0);

function pay(p, n) {
  for (let k = 0; k < n; k++) {
    const i = p.hand.findIndex(c => c.id === 'energy');
    p.egrave.push(p.hand.splice(i, 1)[0]);
  }
}

function take(zone, uid) {
  const i = zone.findIndex(c => c.uid === uid);
  return i >= 0 ? zone.splice(i, 1)[0] : null;
}

// モリのくまが相手の場にいると、モンスターの効果は消える（くま自身はいつも有効）
function effectsOn(pi, s) {
  const m = G.players[pi].mons[s];
  if (!m) return false;
  if (def(m.c).silence) return true;
  return !G.players[1 - pi].mons.some(x => x && def(x.c).silence);
}
const has = (pi, s, flag) => !!(G.players[pi].mons[s] && def(G.players[pi].mons[s].c)[flag] && effectsOn(pi, s));
const breakable = (pi, s) => !has(pi, s, 'unbreakable');

function cost(pi, c) {
  const d = def(c);
  return d.costFn ? d.costFn(API, pi) : d.cost;
}

function power(pi, slot) {
  const m = G.players[pi].mons[slot];
  if (!m) return 0;
  const d = def(m.c);
  let v = d.powerFn && effectsOn(pi, slot) ? d.powerFn(API, pi, m) : (d.power || 0);
  if (m.equip) {
    const e = def(m.equip);
    v += e.powerBonus || 0;
    if (e.powerMod) v += e.powerMod(API, { owner: pi, monOwner: pi, mon: m });
  }
  for (const fp of G.players) {
    if (fp.field && def(fp.field).powerMod) v += def(fp.field).powerMod(API, { owner: fp.i, monOwner: pi, mon: m });
  }
  return Math.max(0, v);
}

function cardValue(c) {
  const d = def(c);
  if (d.type === 'monster') return 10 + Math.min(d.power || 0, 4000) / 500;
  return { trap: 7, magic: 6, equip: 5, field: 5, energy: 4 }[d.type];
}

function log(msg) {
  G.log.push({ turn: G.turn, msg });
  const line = $('#logline');
  if (line) line.textContent = msg;
  if (!$('#logpanel').hidden) renderLog();
}

function lose(pi, reason) {
  G.winner = 1 - pi;
  G.reason = reason;
  log(`${G.players[pi].name}は${reason}。${G.players[1 - pi].name}の勝ち！`);
  throw new GameOver();
}

function clearSlot(pi, s) {
  const p = G.players[pi], m = p.mons[s];
  p.grave.push(...m.under);
  if (m.equip) p.grave.push(m.equip);
  p.egrave.push(...m.energy);
  p.mons[s] = null;
}

// 破壊する。ゾンビなど破壊されないときは false
function destroy(pi, s, why = 'effect') {
  const p = G.players[pi], m = p.mons[s];
  if (!m) return false;
  if (!breakable(pi, s)) { // ゾンビなどは、バトルでも効果でも破壊されない
    log(`「${nm(m.c)}」は破壊されない！`);
    return false;
  }
  clearSlot(pi, s);
  p.grave.push(m.c);
  log(`${p.name}の「${nm(m.c)}」が破壊された`);
  return true;
}

// 「墓地」の枚数（エネルギー墓地もふくむ）
const graveCount = pi => G.players[pi].grave.length + G.players[pi].egrave.length;

function toGrave(pi, cards) {
  const p = G.players[pi];
  for (const c of cards) (c.id === 'energy' ? p.egrave : p.grave).push(c);
}

function bounce(pi, s) {
  const p = G.players[pi], m = p.mons[s];
  clearSlot(pi, s);
  p.hand.push(m.c);
}

function attachFromEgrave(pi, s, n) {
  const p = G.players[pi];
  const k = Math.min(n, p.egrave.length);
  p.mons[s].energy.push(...p.egrave.splice(p.egrave.length - k, k));
  return k;
}

function draw(pi, n) {
  const p = G.players[pi];
  const k = Math.min(n, p.deck.length);
  const got = p.deck.splice(0, k);
  p.hand.push(...got);
  mark(pi, got, 'deck');
  return k;
}

// 山札・墓地から手札に来たカードを覚えておき、そこから飛んでくるように動かす
function mark(pi, cards, pile) {
  if (!cards.length) return;
  NET?.fx('mark', [pi, cards.map(c => c.uid), pile]);
  markLocal(pi, cards.map(c => c.uid), pile);
}

function markLocal(pi, uids, pile) {
  const cards = uids.map(uid => ({ uid }));
  if (pi === UI.viewer && !(G.mode === 'cpu' && G.players[pi].cpu)) {
    for (const c of cards) UI.from.set(String(c.uid), { pi, pile });
  } else {
    flyToHand(pi, pile, cards.length);
  }
}

const isCpuTurn = () => G.players[G.current].cpu;
const beat = (ms = 1000) => sleep(isCpuTurn() ? ms : 350);

// カードの効果から使う道具
const API = {
  player: pi => G.players[pi],
  opp: pi => G.players[1 - pi],
  name: nm, fmt, def, log, toast, destroy, bounce, power, cost, sleep, cardValue, shuffle, draw, attachFromEgrave, breakable, mark, toGrave, graveCount,
  turn: () => G.turn,
  ask: (...a) => ask(...a),
  summon: (...a) => summon(...a),
  render: () => render(),
  skipTurn() { throw new SkipTurn(); },
  trapToGrave(pi) {
    const p = G.players[pi];
    if (p.trap) { p.grave.push(p.trap.c); p.trap = null; }
  },
};

/* ───────── ターンの流れ ───────── */

async function run(fn) {
  if (UI.busy) return;
  UI.busy = true;
  render();
  try {
    let task = fn;
    while (task) {
      try {
        await task();
        task = null;
      } catch (e) {
        if (!(e instanceof SkipTurn)) throw e;
        render();
        task = endTurn; // わなでターンがとばされた
      }
    }
  } catch (e) {
    if (!(e instanceof GameOver)) { console.error(e); toast('エラーが起きました：' + e.message); }
  } finally {
    UI.busy = false;
    render();
    if (G && G.winner != null) showResult();
  }
}

async function startTurn(first = false) {
  G.turn++;
  const p = cur();
  G.phase = 'start';
  if (G.mode === 'hot') await handTo(G.current, `${p.name}のターン`, true);
  else if (!first) toast(`${p.name}のターン`, 'big');
  log(`── ${G.turn}ターン目：${p.name} ──`);
  sfx('turn', true);
  render();
  await sleep(900);

  if (p.egrave.length) {
    const e = p.egrave.pop();
    p.hand.push(e);
    mark(G.current, [e], 'egrave');
    log(`${p.name}はエネルギー墓地からエネルギーを1枚回収した`);
    render();
    await sleep(700);
  }
  if (G.turn === 1) {
    log('先行の最初のターンはドローできない');
  } else {
    if (!p.deck.length) lose(G.current, '山札がなくなってカードを引けなかった');
    const c = p.deck.shift();
    p.hand.push(c);
    mark(G.current, [c], 'deck');
    log(`${p.name}はカードを1枚引いた`);
    render();
    await sleep(800);
  }
  for (let s = 0; s < 3; s++) {
    const m = p.mons[s];
    if (m && def(m.c).turnStart && effectsOn(G.current, s)) {
      render();
      await def(m.c).turnStart(API, G.current, s);
      await handTo(G.current);
    }
  }
  G.phase = 'main';
  settle();
  render();
  if (p.cpu) await cpuTurn();
}

async function endTurn() {
  log(`${cur().name}のターン終了`);
  G.phase = 'end';
  G.current = 1 - G.current;
  await startTurn();
}

// 場の様子が変わったら、自動で働く効果を調べる（ヒカキン仮など）
function settle() {
  for (let guard = 0; guard < 10; guard++) {
    let changed = false;
    for (const pi of [0, 1]) {
      for (let s = 0; s < 3; s++) {
        const m = G.players[pi].mons[s];
        if (m && def(m.c).check && effectsOn(pi, s)) {
          def(m.c).check(API, pi, s);
          if (G.players[pi].mons[s] !== m) changed = true;
        }
      }
    }
    if (!changed) return;
  }
}

/* ───────── カードを使う ───────── */

function usableInMain(pi, c, from = 'hand') {
  const p = G.players[pi], d = def(c);
  if (G.phase !== 'main') return { ok: false, why: 'メインフェーズで使えます' };
  if (from === 'grave' && !d.fromGrave) return { ok: false, why: '墓地からは使えません' };
  if (d.type === 'trap') return p.trap ? { ok: false, why: 'わなはもう置いてあります（1枚まで）' } : { ok: true };
  const k = cost(pi, c);
  if (k === Infinity) return { ok: false, why: c.id === 'wither' ? `墓地（エネルギー墓地もふくむ）にカードが6枚以上ないと出せません（いま${graveCount(pi)}枚）` : 'いまは出せません' };
  if (!canPay(p, k)) return { ok: false, why: `エネルギーが足りません（手札に${energyIn(p).length}枚／必要${k}枚）` };
  if (d.type === 'monster' && !p.mons.includes(null)) return { ok: false, why: 'モンスターゾーンがいっぱいです（3体まで）' };
  if (d.type === 'equip') {
    if (!p.mons.some(Boolean)) return { ok: false, why: 'そうびするモンスターがいません' };
    if (p.mons.some(m => m && m.equip)) return { ok: false, why: 'そうびはもう場にあります（1枚まで）' };
  }
  if (d.type === 'field' && p.field) return { ok: false, why: 'フィールドはもう置いてあります（1枚まで）' };
  if (d.canCast) {
    const r = d.canCast(API, pi);
    if (r !== true) return { ok: false, why: r };
  }
  return { ok: true };
}

// L.D でコストなしに使えるか
function usableFree(pi, c) {
  const p = G.players[pi], d = def(c);
  if (d.type === 'monster') return p.mons.includes(null);
  if (d.type === 'trap') return !p.trap;
  if (d.type === 'magic') return !d.canCast || d.canCast(API, pi) === true;
  if (d.type === 'field') return !p.field;
  if (d.type === 'equip') return p.mons.some(Boolean) && !p.mons.some(m => m && m.equip);
  return false;
}

async function summon(pi, c, { stackOn = null, slot = null } = {}) {
  const p = G.players[pi], oi = 1 - pi, o = G.players[oi];
  let s;
  if (stackOn != null) {
    s = stackOn;
    const old = p.mons[s];
    p.mons[s] = { c, energy: old.energy, equip: old.equip, eTurn: old.eTurn, under: [...old.under, old.c] };
    log(`${p.name}は「${nm(old.c)}」の上に「${nm(c)}」を重ねて出した`);
  } else {
    s = slot != null && !p.mons[slot] ? slot : p.mons.indexOf(null);
    p.mons[s] = { c, energy: [], equip: null, eTurn: 0, under: [] };
    log(`${p.name}は「${nm(c)}」を出した`);
  }
  toast(`「${nm(c)}」登場！`);
  render();
  await sleep(800);

  // 相手のわな（モンスターを出したとき）
  if (o.trap && def(o.trap.c).trigger === 'opponentSummon') {
    const td = def(o.trap.c);
    const yes = await ask(oi, {
      title: 'わなを使う？',
      text: `${p.name}が「${nm(c)}」（パワー${fmt(power(pi, s))}）を出した。わな「${nm(o.trap.c)}」を発動しますか？`,
      card: o.trap.c,
      options: [{ label: '発動する', value: true, primary: true }, { label: '発動しない', value: false }],
      ai: () => (!td.aiTrap || td.aiTrap(API, oi, { summoner: pi, slot: s })) && (cost(pi, c) >= 2 || power(pi, s) >= 1600),
    });
    if (yes) {
      await fxTrap(oi);
      await td.onTrap(API, oi, { summoner: pi, slot: s });
      render();
    }
  }
  if (p.mons[s] && p.mons[s].c === c && def(c).onSummon && effectsOn(pi, s)) {
    await def(c).onSummon(API, pi, s);
  }
  settle();
  render();
  return s;
}

async function useCard(pi, uid, { free = false, from = 'hand', slot = null } = {}) {
  const p = G.players[pi];
  const zone = from === 'grave' ? p.grave : p.hand;
  const c = zone.find(x => x.uid === uid);
  const d = def(c);
  const payCost = () => { if (!free) pay(p, cost(pi, c)); };
  switch (d.type) {
    case 'monster':
      payCost();
      take(zone, uid);
      if (free) log(`L.D！「${nm(c)}」をコストなしで出す`);
      await summon(pi, c, { slot });
      break;
    case 'magic': {
      payCost();
      take(zone, uid);
      log(`${p.name}はまほう「${nm(c)}」を使った`);
      toast(`まほう「${nm(c)}」`);
      sfx('magic', true);
      render();
      await sleep(900);
      const r = d.onCast ? await d.onCast(API, pi) : null;
      if (r === 'hand') { p.hand.push(c); log(`「${nm(c)}」は手札にもどった`); } else p.grave.push(c);
      break;
    }
    case 'trap':
      take(zone, uid);
      p.trap = { c, faceUp: false };
      log(`${p.name}はわなを1枚ふせた`);
      toast('わなを1枚ふせた');
      break;
    case 'equip': {
      const cands = slotsOf(p);
      const s = slot != null ? slot : await ask(pi, {
        title: 'どのモンスターにそうびする？',
        options: cands.map(i => ({ card: p.mons[i].c, label: `${nm(p.mons[i].c)}（パワー${fmt(power(pi, i))}）`, value: i })),
        cancel: !free,
        ai: () => [...cands].sort((a, b) => power(pi, b) - power(pi, a))[0],
      });
      if (s == null) return;
      payCost();
      take(zone, uid);
      p.mons[s].equip = c;
      log(`${p.name}は「${nm(p.mons[s].c)}」に「${nm(c)}」をそうびした`);
      if (d.onEquip) await d.onEquip(API, pi, s);
      break;
    }
    case 'field':
      payCost();
      take(zone, uid);
      p.field = c;
      log(`${p.name}はフィールド「${nm(c)}」を置いた`);
      if (d.onField) await d.onField(API, pi);
      break;
  }
  settle();
  render();
  await handTo(G.current);
}

// エネルギーをつけたあと：相手の「エネルギーをつけたとき」のわな
async function afterAttach(pi) {
  const oi = 1 - pi, o = G.players[oi];
  if (o.trap && def(o.trap.c).trigger === 'opponentAttach') {
    const yes = await ask(oi, {
      title: 'わなを使う？',
      text: `${G.players[pi].name}がエネルギーをつけた。わな「${nm(o.trap.c)}」を発動しますか？`,
      card: o.trap.c,
      options: [{ label: '発動する', value: true, primary: true }, { label: '発動しない', value: false }],
      ai: () => true,
    });
    if (yes) {
      await fxTrap(oi);
      await def(o.trap.c).onTrap(API, oi, { attacher: pi });
    }
    await handTo(G.current);
  }
}

async function attachEnergy(pi, s) {
  const p = G.players[pi], m = p.mons[s];
  const i = p.hand.findIndex(c => c.id === 'energy');
  m.energy.push(p.hand.splice(i, 1)[0]);
  m.eTurn = G.turn;
  log(`${p.name}は「${nm(m.c)}」にエネルギーをつけた`);
  render();
  fxPip(pi, s);
  await sleep(350);
  await afterAttach(pi);
}

async function playerAttach(pi, s) {
  if (G.phase === 'main') { G.phase = 'energy'; render(); }
  await attachEnergy(pi, s);
  if (G.current === pi && G.phase === 'energy' && !slotsOf(G.players[pi]).some(x => canAttach(pi, x))) {
    await sleep(400);
    G.phase = 'attack';
    toast('攻撃フェーズへ');
    render();
  }
}

async function playerAttack(pi, s, t) {
  if (G.phase !== 'attack') { G.phase = 'attack'; render(); }
  await attack(pi, s, t);
}

const canAttach = (pi, s) => {
  const p = G.players[pi], m = p.mons[s];
  return !!m && m.eTurn !== G.turn && !has(pi, s, 'noEnergy') && energyIn(p).length > 0;
};

// 会長リューの能力：手札を1枚捨てて、エネルギー墓地から1枚つける
async function discardAttach(pi, s) {
  const p = G.players[pi], m = p.mons[s];
  const uid = await ask(pi, {
    title: '捨てる手札をえらぶ',
    text: `捨てたあと、エネルギー墓地からエネルギーを1枚「${nm(m.c)}」につけます。エネルギーを捨てれば、それをそのままつけられます。`,
    options: p.hand.map(c => ({ card: c, label: nm(c), value: c.uid })),
    cancel: true,
    ai: () => (energyIn(p)[0] || [...p.hand].sort((a, b) => cardValue(a) - cardValue(b))[0]).uid,
  });
  if (uid == null) return;
  const c = take(p.hand, uid);
  (c.id === 'energy' ? p.egrave : p.grave).push(c);
  const n = attachFromEgrave(pi, s, 1);
  log(`${p.name}は「${nm(c)}」を捨てて、「${nm(m.c)}」にエネルギーを${n}枚つけた`);
  render();
  if (n) await afterAttach(pi);
}

const canDiscardAttach = (pi, s) => {
  const p = G.players[pi];
  return G.phase === 'main' && has(pi, s, 'ability') && p.hand.length > 0 && (p.egrave.length > 0 || energyIn(p).length > 0);
};

// 画面からの行動。オンラインで相手側のときは、ホストに送ってホストが実行する
function act(name, ...args) {
  if (isGuest()) return NET.sendAct(name, args);
  return ACTIONS[name](...args);
}

/* ───────── 攻撃とバトル ───────── */

const canAttack = (pi, s) => G.turn > 1 && !!G.players[pi].mons[s] && G.players[pi].mons[s].energy.length > 0 && !has(pi, s, 'noAttack');
const directBlocked = oi => !G.players[oi].life.length && G.players[oi].noDirect === G.turn;

async function attack(pi, slot, target) {
  const p = G.players[pi], oi = 1 - pi, o = G.players[oi];
  const m = p.mons[slot];
  const aName = nm(m.c);
  const ap = power(pi, slot);
  p.egrave.push(m.energy.pop());
  const tName = target === 'player' ? o.name : `「${nm(o.mons[target].c)}」`;
  log(`${p.name}の「${aName}」（パワー${fmt(ap)}）が${tName}に攻撃！`);
  toast(`「${aName}」の攻撃！ → ${tName}`, 'attack');
  render();
  await fxAttack(pi, slot, target);
  await sleep(500);

  // わな（相手のモンスターが攻撃するとき）
  if (o.trap && def(o.trap.c).trigger === 'opponentAttack') {
    const td = def(o.trap.c);
    const yes = await ask(oi, {
      title: 'わなを使う？',
      text: `${p.name}の「${aName}」（パワー${fmt(ap)}）が${target === 'player' ? 'あなた' : tName}に攻撃してきた。わな「${nm(o.trap.c)}」を発動しますか？`,
      card: o.trap.c,
      options: [{ label: '発動する', value: true, primary: true }, { label: '発動しない', value: false }],
      ai: () => !td.aiTrap || td.aiTrap(API, oi, { attacker: pi, slot, target }),
    });
    if (yes) {
      await fxTrap(oi);
      const r = await td.onTrap(API, oi, { attacker: pi, slot, target });
      settle();
      render();
      if ((r && r.stop) || !p.mons[slot] || p.mons[slot].c !== m.c) { await handTo(G.current); return; }
    }
  }

  // ブロック：エネルギーのついたモンスターが1枚使って、攻撃を自分とのバトルに変える
  // （プレイヤーへの攻撃でも、モンスターへの攻撃でもできる。狙われたモンスター自身は除く）
  const blockers = slotsOf(o).filter(i => o.mons[i].energy.length && i !== target);
  if (blockers.length && p.mons[slot]) {
    const what = target === 'player'
      ? (o.life.length ? `ブロックしないとライフガードが${Math.min(Math.floor(ap / 1000), o.life.length)}枚壊れます。`
        : directBlocked(oi) ? '' : 'ライフガードがないので、ブロックしないと負けです！')
      : `狙われているのは「${nm(o.mons[target].c)}」（パワー${fmt(power(oi, target))}）です。`;
    const b = await ask(oi, {
      title: 'ブロックする？',
      text: `${p.name}の「${aName}」（パワー${fmt(ap)}）が攻撃してきた。${what}ブロックすると、そのモンスターのエネルギーを1枚使って、攻撃してきたモンスターとバトルします。`,
      options: [
        ...blockers.map(i => ({ card: o.mons[i].c, label: `${nm(o.mons[i].c)}（パワー${fmt(power(oi, i))}）でブロック`, value: i })),
        { label: 'ブロックしない', value: -1 },
      ],
      ai: () => (target === 'player' ? aiBlock(oi, ap, blockers) : aiBlockMon(oi, ap, target, blockers)),
    });
    if (b >= 0) {
      o.egrave.push(o.mons[b].energy.pop());
      log(`${o.name}は「${nm(o.mons[b].c)}」でブロックした`);
      toast(`「${nm(o.mons[b].c)}」がブロック！`);
      await battle(pi, slot, oi, b);
      settle();
      render();
      await handTo(G.current);
      return;
    }
  }

  if (target === 'player') {
    if (!o.life.length) {
      if (directBlocked(oi)) {
        log(`このターン、${o.name}はダイレクトアタックを受けない`);
      } else {
        log('ダイレクトアタック！');
        toast('ダイレクトアタック！', 'big');
        await fxDirect();
        await sleep(1200);
        lose(oi, 'ダイレクトアタックを受けた');
      }
    } else {
      const n = Math.min(Math.floor(ap / 1000), o.life.length);
      if (n === 0) {
        log('パワーが1000に届かず、ライフガードは壊れなかった');
      } else {
        toast(`ライフガードを${n}枚破壊！`, 'attack');
        await fxLife(oi, n);
        const broken = o.life.splice(o.life.length - n, n);
        o.hand.push(...broken);
        log(`${o.name}のライフガードを${n}枚破壊！（${o.name}の手札へ）`);
        render();
        await sleep(700);
        await lifeBroken(oi, broken);
      }
    }
  } else if (o.mons[target]) {
    await battle(pi, slot, oi, target);
  }
  settle();
  render();
  await handTo(G.current);
}

// ライフガードが壊れて手札に入ったとき：L.D と I♡LD
async function lifeBroken(pi, broken) {
  const p = G.players[pi];
  const ld = broken.filter(c => def(c).ld);
  if (p.trap && def(p.trap.c).trigger === 'ownLifeBroken') {
    const cands = broken.filter(c => !def(c).ld && c.id !== 'energy' && usableFree(pi, c));
    if (cands.length) {
      const yes = await ask(pi, {
        title: 'わなを使う？',
        text: `ライフガードが壊れた。わな「${nm(p.trap.c)}」を発動して、壊れたカードをL.D（コストなしですぐ使える）にしますか？`,
        card: p.trap.c,
        options: [{ label: '発動する', value: true, primary: true }, { label: '発動しない', value: false }],
        ai: () => true,
      });
      if (yes) {
        await fxTrap(pi);
        log(`わな「${nm(p.trap.c)}」発動！`);
        toast(`わな「${nm(p.trap.c)}」発動！`, 'trap');
        API.trapToGrave(pi);
        const uid = cands.length === 1 ? cands[0].uid : await ask(pi, {
          title: 'L.Dにするカード',
          text: '壊れたライフガードから、L.Dにするカードをえらんでください。',
          options: cands.map(c => ({ card: c, label: nm(c), value: c.uid })),
          ai: () => [...cands].sort((a, b) => cardValue(b) - cardValue(a))[0].uid,
        });
        ld.push(cands.find(c => c.uid === uid));
      }
    }
  }
  for (const c of ld) {
    if (!p.hand.includes(c) || !usableFree(pi, c)) continue;
    const yes = await ask(pi, {
      title: 'L.D',
      text: `ライフガードから「${nm(c)}」が手札に入った。コストを払わずに、いますぐ使いますか？`,
      card: c,
      options: [{ label: '使う', value: true, primary: true }, { label: '使わない', value: false }],
      ai: () => true,
    });
    if (yes) await useCard(pi, c.uid, { free: true });
  }
}

async function battle(ai, as, di, ds) {
  const A = G.players[ai], D = G.players[di];
  const ap = power(ai, as), dp = power(di, ds);
  log(`バトル！「${nm(A.mons[as].c)}」${fmt(ap)} 対「${nm(D.mons[ds].c)}」${fmt(dp)}`);
  toast(`バトル！ ${fmt(ap)} 対 ${fmt(dp)}`, 'attack');
  render();
  await fxClash(ai, as, di, ds);
  await sleep(600);
  if (ap > dp) destroy(di, ds, 'battle');
  else if (ap < dp) destroy(ai, as, 'battle');
  else { destroy(ai, as, 'battle'); destroy(di, ds, 'battle'); }
  render();
  await sleep(900);
}

const ACTIONS = { useCard: (...a) => useCard(...a), playerAttach: (...a) => playerAttach(...a), playerAttack: (...a) => playerAttack(...a), discardAttach: (...a) => discardAttach(...a), endTurn: () => endTurn() };

/* ───────── CPU ───────── */

// モンスターが狙われたとき：狙われたモンスターが負けそうで、勝てるモンスターがいればブロック
function aiBlockMon(oi, ap, target, blockers) {
  if (power(oi, target) > ap || !breakable(oi, target)) return -1;
  const safe = blockers.find(i => !breakable(oi, i));
  if (safe != null) return safe;
  const byPow = [...blockers].sort((a, b) => power(oi, a) - power(oi, b));
  const win = byPow.find(i => power(oi, i) > ap);
  return win ?? -1;
}

function aiBlock(oi, ap, blockers) {
  const o = G.players[oi];
  const safe = blockers.find(i => !breakable(oi, i));
  if (safe != null && !(o.life.length && Math.floor(ap / 1000) === 0)) return safe;
  const byPow = [...blockers].sort((a, b) => power(oi, a) - power(oi, b));
  if (!o.life.length) {
    if (directBlocked(oi)) return -1;
    return byPow.find(i => power(oi, i) >= ap) ?? byPow[byPow.length - 1];
  }
  const win = byPow.find(i => power(oi, i) > ap);
  if (win != null) return win;
  const tie = byPow.find(i => power(oi, i) === ap);
  if (tie != null && ap >= 2000) return tie;
  // この攻撃でライフガードが全部こわれるなら、いちばん弱いモンスターを差し出して守る
  if (Math.floor(ap / 1000) >= o.life.length) return byPow[0];
  return -1;
}

// ブロックしてくる相手モンスター（エネルギーつき、狙ったモンスター以外）に負けるか
function aiBlockedLoss(pi, s, target) {
  if (!breakable(pi, s)) return false;
  const oi = 1 - pi, ap = power(pi, s);
  return slotsOf(G.players[oi]).some(i => i !== target && G.players[oi].mons[i].energy.length
    && (power(oi, i) > ap || (power(oi, i) === ap && !breakable(oi, i))));
}

// 相手がいちばん上手にブロック（とわな）で守っても、ダイレクトアタックまで届くか。
// 届くなら、最初に攻撃するモンスターの置き場を返す（届かなければ -1）。
// ブロックで負けたモンスターは、残りのエネルギーの分の攻撃もなくなる。ブロックで負けた相手も同じ。
function aiLethal(pi) {
  const oi = 1 - pi, o = G.players[oi], p = G.players[pi];
  if (directBlocked(oi)) return -1;
  const trap = o.trap && def(o.trap.c).trigger === 'opponentAttack' ? o.trap.c.id : null;
  if (trap === 'saiaku') return -1;
  // ブロックで失うものが少ない、エネルギー1枚のモンスターから試す
  const A = [0, 1, 2].filter(s => canAttack(pi, s))
    .sort((a, b) => p.mons[a].energy.length - p.mons[b].energy.length || power(pi, b) - power(pi, a))
    .map(s => ({ s, pw: power(pi, s), brk: breakable(pi, s), n: p.mons[s].energy.length }));
  const B = slotsOf(o).map(i => ({ pw: power(oi, i), brk: breakable(oi, i), n: o.mons[i].energy.length }));
  // 1体で攻撃できる回数は「相手の守りの回数＋ライフガード＋1」より多くても意味がないので、そこで切る（計算を軽くする）
  const guards = B.reduce((n, x) => n + x.n, 0) + (trap ? 1 + B.length : 0) + o.life.length + 1;
  for (const x of A) x.n = Math.min(x.n, guards);
  const memo = new Map();
  // a・b：のこりのエネルギー（-1 は破壊された）。t：わなが場にあるか
  const wins = (a, b, life, t) => {
    const key = `${a}|${b}|${life}|${t}`;
    if (!memo.has(key)) {
      if (memo.size > 20000) throw new Error('aiLethal'); // 計算が多すぎるときは、届かないことにする
      memo.set(key, A.some((x, i) => a[i] > 0 && hits(a, b, life, t, i)));
    }
    return memo.get(key);
  };
  // i番目のモンスターで攻撃したとき、相手のどの守り方でも届くか
  const hits = (a0, b, life, t, i) => {
    const a = [...a0], ap = A[i].pw;
    a[i]--;
    if (t && A[i].brk) { // わなで攻撃したモンスターを破壊される
      const a2 = [...a];
      a2[i] = -1;
      if (!wins(a2, b, life, 0)) return false;
      if (trap === 'manhole') { // 自分のモンスターを1体破壊して、わなを残す
        for (let j = 0; j < B.length; j++) {
          if (b[j] < 0 || !B[j].brk) continue;
          const b2 = [...b];
          b2[j] = -1;
          if (!wins(a2, b2, life, 1)) return false;
        }
      }
    }
    for (let j = 0; j < B.length; j++) { // ブロックされてバトル
      if (!(b[j] > 0)) continue;
      const a2 = [...a], b2 = [...b];
      b2[j]--;
      if (ap >= B[j].pw && B[j].brk) b2[j] = -1;
      if (ap <= B[j].pw && A[i].brk) a2[i] = -1;
      if (!wins(a2, b2, life, t)) return false;
    }
    if (!life) return true; // ブロックされなければダイレクトアタック
    return wins(a, b, life - Math.min(life, Math.floor(ap / 1000)), t);
  };
  const a = A.map(x => x.n), b = B.map(x => x.n), t = trap ? 1 : 0;
  try {
    const i = A.findIndex((x, k) => hits(a, b, o.life.length, t, k));
    return i >= 0 ? A[i].s : -1;
  } catch (e) {
    if (e.message === 'aiLethal') return -1;
    throw e;
  }
}

async function cpuTurn() {
  const pi = G.current, p = cur(), oi = 1 - pi, o = G.players[oi];
  await sleep(500);

  // メイン：モンスター → まほう → わな → そうび → フィールド の順に、使えるものを使う
  const order = { monster: 0, magic: 1, trap: 2, equip: 3, field: 4 };
  for (let guard = 0; guard < 25; guard++) {
    const cands = [
      ...p.hand.filter(c => c.id !== 'energy').map(c => ({ c, from: 'hand' })),
      ...p.grave.filter(c => def(c).fromGrave).map(c => ({ c, from: 'grave' })),
    ]
      .filter(({ c, from }) => usableInMain(pi, c, from).ok && (!def(c).aiUse || def(c).aiUse(API, pi)))
      .sort((a, b) => order[def(a.c).type] - order[def(b.c).type] || Math.min(def(b.c).power || 0, 5000) - Math.min(def(a.c).power || 0, 5000));
    if (!cands.length) break;
    await useCard(pi, cands[0].c.uid, { from: cands[0].from });
    await beat();
  }
  // 会長リューの能力：手札のエネルギーを2枚まで回す
  for (let s = 0; s < 3; s++) {
    for (let k = 0; k < 2 && canDiscardAttach(pi, s) && energyIn(p).length; k++) {
      await discardAttach(pi, s);
      await beat(450);
    }
  }

  G.phase = 'energy';
  render();
  await beat(500);
  const bySlot = slotsOf(p).sort((a, b) => power(pi, b) - power(pi, a));
  for (const s of bySlot) {
    if (!canAttach(pi, s) || has(pi, s, 'noAttack') && energyIn(p).length < 2) continue;
    await attachEnergy(pi, s);
    await beat(450);
  }

  G.phase = 'attack';
  render();
  await beat(500);
  for (let guard = 0; guard < 40; guard++) {
    // 勝てる計算なら、プレイヤーを攻撃し続ける
    const ls = aiLethal(pi);
    if (ls >= 0) {
      await attack(pi, ls, 'player');
      await beat(500);
      continue;
    }
    let best = null;
    for (let s = 0; s < 3; s++) {
      if (!canAttack(pi, s)) continue;
      const m = p.mons[s];
      const ap = power(pi, s);
      const bias = o.trap ? -Math.min(ap, 5000) / 100 : 0; // わながあるときは弱いモンスターから行く
      o.mons.forEach((x, t) => {
        if (!x) return;
        const dp = power(oi, t);
        let score = -1;
        if (!breakable(oi, t)) return; // 倒せない相手は狙わない
        if (aiBlockedLoss(pi, s, t)) return; // ほかの強いモンスターにブロックされて負けるので狙わない
        if (ap > dp) score = 50 + Math.min(dp, 5000) / 100 + x.energy.length * 8; // エネルギーのついた相手を先に倒す
        else if (ap === dp && cardValue(x.c) > cardValue(m.c)) score = 10;
        if (score > 0 && (!best || score + bias > best.score)) best = { s, t, score: score + bias };
      });
      const strongBlock = aiBlockedLoss(pi, s, 'player');
      let ps = -1;
      if (!o.life.length) ps = strongBlock || directBlocked(oi) ? -1 : 1000;
      else if (!strongBlock && ap >= 1000) ps = 30 + Math.min(Math.floor(ap / 1000), o.life.length) * 10;
      if (ps > 0 && (!best || ps + bias > best.score)) best = { s, t: 'player', score: ps + bias };
    }
    if (!best) break;
    await attack(pi, best.s, best.t);
    await beat(500);
  }
  await endTurn();
}

/* ───────── 質問・画面の切り替え ───────── */

// 人には画面で聞き、CPU には q.ai() で決めさせる
async function ask(pi, q) {
  const p = G.players[pi];
  if (p.cpu) {
    await sleep(700);
    return q.ai ? q.ai() : q.options[0].value;
  }
  if (G.mode === 'online' && NET && pi !== UI.viewer) return NET.remoteAsk(pi, q);
  if (G.mode === 'hot' && G.hide && UI.viewer !== pi) await handTo(pi);
  render();
  const who = G.mode === 'hot' ? p.name : '';
  return modal({ ...q, who, whoClass: pi ? 'p2' : 'p1' });
}

// 2人対戦で、端末を次の人に渡す
async function handTo(pi, title = '', turnStart = false) {
  if (G.mode !== 'hot') return;
  if (UI.viewer === pi && !turnStart) return;
  if (G.hide) {
    const pass = $('#pass');
    $('#passname').textContent = G.players[pi].name;
    $('#passname').className = pi ? 'p2' : 'p1';
    $('#passmsg').textContent = title ? 'のターンです' : 'の番です（相手のターン中）';
    pass.hidden = false;
    UI.viewer = pi;
    render();
    await new Promise(res => { $('#passgo').onclick = () => { pass.hidden = true; res(); }; });
  } else {
    UI.viewer = pi;
    render();
    if (title) toast(title, 'big');
  }
}

function modal(q) {
  return new Promise(res => {
    const box = $('#modal');
    const cards = q.options.filter(o => o.card);
    const btns = q.options.filter(o => !o.card);
    if (q.cancel) btns.push({ label: 'やめる', value: null });
    const closable = btns.some(o => o.value == null);
    box.innerHTML = `
      <div class="sheet split" role="dialog" aria-modal="true">
        ${closable ? '<button class="x" data-k="x" aria-label="とじる">×</button>' : ''}
        <div class="sheet-body">
          ${q.who ? `<div class="who ${q.whoClass}">${esc(q.who)}さん</div>` : ''}
          <h2>${esc(q.title)}</h2>
          ${q.text ? `<p class="qtext">${esc(q.text)}</p>` : ''}
          ${q.card ? `<div class="qcard">${cardHTML(q.card, { big: true })}</div>` : ''}
          ${cards.length ? `<div class="choices">${cards.map((o, i) => `
            <button class="choice" data-k="c${i}">${cardHTML(o.card)}<span>${esc(o.label)}</span></button>`).join('')}</div>` : ''}
        </div>
        <div class="btns">${btns.map((o, i) => `<button class="btn ${o.primary ? 'primary' : ''} ${o.value == null ? 'ghost' : ''}" data-k="b${i}">${esc(o.label)}</button>`).join('')}</div>
      </div>`;
    box.hidden = false;
    box.onclick = e => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (!k) return;
      const o = k === 'x' ? { value: null } : k[0] === 'c' ? cards[+k.slice(1)] : btns[+k.slice(1)];
      box.hidden = true;
      box.innerHTML = '';
      res(o.value);
    };
  });
}

let toastTimer = null;
function toast(msg, kind = '') {
  NET?.fx('toast', [msg, kind]);
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast ' + kind; }, kind === 'big' ? 2000 : 1800);
}

/* ───────── アニメーション ───────── */

// アニメーションの終わりを待つ（画面が裏にあっても止まらないよう、時間が来たら先へ進む）
function anim(el, frames, opts) {
  if (!el || REDUCED) return Promise.resolve();
  const a = el.animate(frames, opts);
  return Promise.race([a.finished.catch(() => {}), sleep((opts.duration || 0) + (opts.delay || 0) + 100)]);
}
const SHAKE = [
  { transform: 'translateX(0)' }, { transform: 'translateX(-7px) rotate(-2deg)' }, { transform: 'translateX(7px) rotate(2deg)' },
  { transform: 'translateX(-4px)' }, { transform: 'translateX(3px)' }, { transform: 'none' },
];
const BIG_SHAKE = [
  { transform: 'translate(0, 0)' }, { transform: 'translate(-14px, 6px)' }, { transform: 'translate(12px, -8px)' },
  { transform: 'translate(-8px, 4px)' }, { transform: 'translate(5px, -2px)' }, { transform: 'none' },
];
const monEl = (pi, s) => $(`#game .slot.mon[data-p="${pi}"][data-s="${s}"]`);
const center = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

// 描きなおす前の位置を覚えておく
function snapshot() {
  const m = new Map();
  if ($('#game').hidden) return m;
  document.querySelectorAll('#game [data-cid]').forEach(el => {
    m.set(el.dataset.cid, { r: el.getBoundingClientRect(), html: el.outerHTML, z: el.dataset.z });
  });
  return m;
}

// 前と比べて、出てきたカード・動いたカード・消えたカードを動かす
function animateDiff(before) {
  if (REDUCED) return;
  const seen = new Set();
  let k = 0;
  document.querySelectorAll('#game [data-cid]').forEach(el => {
    const id = el.dataset.cid;
    seen.add(id);
    const b = before.get(id);
    const r = el.getBoundingClientRect();
    if (!b) {
      if (el.dataset.z === 'hand') {
        const src = UI.from.get(id);
        UI.from.delete(id);
        const pile = src && $(`#game [data-zone="${src.pile}"][data-p="${src.pi}"]`);
        if (pile) drawFrom(el, pile, src.pile === 'deck', (k++) * 160);
        else el.animate([{ transform: 'translateY(50px) scale(.85)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 500, easing: 'cubic-bezier(.2,.8,.2,1)' });
      } else {
        sfx(el.dataset.z === 'mon' ? 'summon' : 'set');
        el.animate([
          { transform: 'translateY(-40px) scale(1.4) rotate(-8deg)', opacity: 0, filter: 'brightness(1.8)' },
          { transform: 'scale(.94)', opacity: 1, offset: 0.65 },
          { transform: 'none', opacity: 1, filter: 'none' },
        ], { duration: 700, easing: 'ease-out' });
      }
      return;
    }
    const dx = b.r.left - r.left, dy = b.r.top - r.top;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      const sc = r.width ? b.r.width / r.width : 1;
      el.style.zIndex = 20;
      el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sc})` }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.3,.7,.2,1)' });
      setTimeout(() => { el.style.zIndex = ''; }, 600);
    }
  });
  for (const [id, b] of before) {
    if (!seen.has(id) && (b.z === 'mon' || b.z === 'aux')) ghost(b);
  }
}

// 山札から引いたカード：裏向きで飛んできて、手札でめくれる
function drawFrom(el, pile, faceDown, delay) {
  setTimeout(() => sfx('draw'), delay);
  const to = el.getBoundingClientRect(), f = pile.getBoundingClientRect();
  if (faceDown) {
    const g = document.createElement('div');
    g.className = 'fx-ghost';
    g.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px;transform-origin:top left`;
    g.innerHTML = backHTML();
    $('#fx').appendChild(g);
    g.animate([
      { transform: `translate(${f.left - to.left}px, ${f.top - to.top}px) scale(${f.width / to.width})` },
      { transform: 'translate(0, -16px) scale(1.06)', offset: 0.8 },
      { transform: 'none' },
    ], { duration: 480, delay, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'both' });
    setTimeout(() => g.remove(), 500 + delay);
    el.animate([
      { opacity: 0, transform: 'rotateY(90deg)' },
      { opacity: 0, transform: 'rotateY(90deg)', offset: 0.64 },
      { opacity: 1, transform: 'rotateY(90deg)', offset: 0.65 },
      { opacity: 1, transform: 'none' },
    ], { duration: 760, delay, fill: 'backwards' });
  } else {
    el.animate([
      { transform: `translate(${f.left - to.left}px, ${f.top - to.top}px) scale(${f.width / to.width})`, opacity: 0.4 },
      { transform: 'none', opacity: 1 },
    ], { duration: 560, delay, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' });
  }
}

// 相手が引いたとき：裏向きのカードが山札から相手の手札（名前のところ）へ飛ぶ
function flyToHand(pi, pileName, n) {
  sfx('draw');
  if (REDUCED) return;
  const pile = $(`#game [data-zone="${pileName}"][data-p="${pi}"]`), info = $(`#game .pinfo[data-p="${pi}"]`);
  if (!pile || !info) return;
  const f = pile.getBoundingClientRect(), T = center(info);
  for (let i = 0; i < Math.min(n, 6); i++) {
    const g = document.createElement('div');
    g.className = 'fx-ghost';
    g.style.cssText = `left:${f.left}px;top:${f.top}px;width:${f.width}px;height:${f.height}px`;
    g.innerHTML = pileName === 'deck' ? backHTML() : pile.querySelector('.card')?.outerHTML || backHTML();
    $('#fx').appendChild(g);
    g.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${T.x - f.left - f.width / 2}px, ${T.y - f.top - f.height / 2}px) scale(.4)`, opacity: 0 },
    ], { duration: 600, delay: i * 140, easing: 'ease-in', fill: 'both' });
    setTimeout(() => g.remove(), 620 + i * 140);
  }
}

// 場から消えたカードを、光ってくずれるように消す
function ghost(b) {
  if (b.z === 'mon') sfx('destroy');
  const g = document.createElement('div');
  g.className = 'fx-ghost';
  g.style.cssText = `left:${b.r.left}px;top:${b.r.top}px;width:${b.r.width}px;height:${b.r.height}px`;
  g.innerHTML = b.html;
  $('#fx').appendChild(g);
  g.animate([
    { opacity: 1, transform: 'none', filter: 'none' },
    { opacity: 1, transform: 'scale(1.1)', filter: 'brightness(2.2) saturate(0)', offset: 0.25 },
    { opacity: 0, transform: 'scale(.5) rotate(14deg) translateY(30px)', filter: 'grayscale(1) blur(3px)' },
  ], { duration: 850, easing: 'ease-in' });
  setTimeout(() => g.remove(), 900);
}

async function fxAttack(pi, s, target) {
  NET?.fx('fxAttack', [pi, s, target]);
  const a = monEl(pi, s);
  const t = target === 'player' ? $(`#game .lgrow[data-p="${1 - pi}"]`) : monEl(1 - pi, target);
  sfx('attack');
  setTimeout(() => sfx('hit'), 560);
  if (!a || !t || REDUCED) return;
  const A = center(a), T = center(t);
  const dx = T.x - A.x, dy = T.y - A.y;
  a.style.zIndex = 20;
  setTimeout(() => anim(t, SHAKE, { duration: 450 }), 560);
  await anim(a, [
    { transform: 'none' },
    { transform: `translate(${-dx * 0.06}px, ${-dy * 0.06}px) scale(1.12) rotate(-5deg)`, offset: 0.3 },
    { transform: `translate(${dx * 0.8}px, ${dy * 0.8}px) scale(1.15)`, offset: 0.6 },
    { transform: `translate(${dx * 0.7}px, ${dy * 0.7}px) scale(1.1)`, offset: 0.68 },
    { transform: 'none' },
  ], { duration: 1000, easing: 'ease-in-out' });
  a.style.zIndex = '';
}

async function fxClash(ai, as, di, ds) {
  NET?.fx('fxClash', [ai, as, di, ds]);
  const a = monEl(ai, as), d = monEl(di, ds);
  sfx('clash');
  if (!a || !d || REDUCED) return;
  const A = center(a), D = center(d);
  const dx = (D.x - A.x) * 0.35, dy = (D.y - A.y) * 0.35;
  a.style.zIndex = 20; d.style.zIndex = 20;
  const hit = (x, y) => [
    { transform: 'none', filter: 'none' },
    { transform: `translate(${x}px, ${y}px) scale(1.08)`, filter: 'brightness(1.8)', offset: 0.5 },
    { transform: 'none', filter: 'none' },
  ];
  await Promise.all([
    anim(a, hit(dx, dy), { duration: 700, easing: 'ease-in-out' }),
    anim(d, hit(-dx, -dy), { duration: 700, easing: 'ease-in-out' }),
  ]);
  a.style.zIndex = ''; d.style.zIndex = '';
}

async function fxLife(oi, n) {
  NET?.fx('fxLife', [oi, n]);
  const cells = [...document.querySelectorAll(`#game .lgrow[data-p="${oi}"] .cell`)].filter(c => c.querySelector('.back')).slice(-n);
  const target = oi === UI.viewer ? $('#hand') : $(`#game .pinfo[data-p="${oi}"]`);
  for (let i = 0; i < Math.max(1, cells.length); i++) setTimeout(() => sfx('life'), i * 160);
  if (!cells.length || !target || REDUCED) return;
  const T = center(target);
  await Promise.all(cells.map((c, k) => {
    const C = center(c);
    c.style.zIndex = 20;
    return anim(c, [
      { transform: 'none', opacity: 1 },
      { transform: 'translateY(-14px) scale(1.25) rotateY(90deg)', opacity: 1, offset: 0.35 },
      { transform: `translate(${T.x - C.x}px, ${T.y - C.y}px) scale(.7) rotateY(180deg)`, opacity: 0 },
    ], { duration: 900, delay: k * 160, easing: 'ease-in', fill: 'forwards' });
  }));
}

async function fxTrap(pi) {
  NET?.fx('fxTrap', [pi]);
  const el = $(`#game .aux[data-zone="trap"][data-p="${pi}"]`);
  sfx('trap');
  if (!el) return;
  el.style.zIndex = 20;
  await anim(el, [
    { transform: 'none', filter: 'none' },
    { transform: 'scale(1.5) rotateY(90deg)', offset: 0.35 },
    { transform: 'scale(1.5)', filter: 'drop-shadow(0 0 14px #b57cff) brightness(1.3)', offset: 0.65 },
    { transform: 'none', filter: 'none' },
  ], { duration: 950, easing: 'ease-in-out' });
  el.style.zIndex = '';
}

async function fxDirect() {
  NET?.fx('fxDirect', []);
  sfx('direct');
  const flash = document.createElement('div');
  flash.className = 'flash';
  $('#fx').appendChild(flash);
  anim(flash, [{ opacity: 0.85 }, { opacity: 0 }], { duration: 900 }).then(() => flash.remove());
  await anim($('#game'), BIG_SHAKE, { duration: 700 });
}

function fxPip(pi, s) {
  NET?.fx('fxPip', [pi, s]);
  sfx('energy');
  const pips = monEl(pi, s)?.querySelectorAll('.pip');
  if (pips && pips.length) anim(pips[pips.length - 1], [{ transform: 'scale(0)' }, { transform: 'scale(1.8)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: 500 });
}

/* ───────── 描画 ───────── */

const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 4 13.5h6.2L9 22l10-12.2h-6.4z"/></svg>';

function cardHTML(c, o = {}) {
  const d = def(c);
  const cls = `card t-${d.type} ${o.big ? 'big' : ''} ${o.extra || ''}`;
  if (d.type === 'energy') {
    return `<div class="${cls}"><div class="face energy">${BOLT}<b>エネルギー</b></div></div>`;
  }
  if (UI.art === 'design') return designHTML(c, o, cls);
  const k = o.cost ?? d.cost;
  const badges = o.big ? '' : `<span class="cost ${k !== d.cost ? 'changed' : ''}">${fmt(k)}</span>${d.type === 'monster' ? `<span class="pow">${fmt(o.power ?? d.power)}</span>` : ''}`;
  if (d.img) {
    return `<div class="${cls}"><img class="face" src="${d.img}" alt="${esc(d.name)}" draggable="false">${badges}</div>`;
  }
  // 画像がまだないカードは、手描きカードと同じ枠で描く
  return `<div class="${cls}"><div class="face tmpl">
      <div class="f-top"><span class="f-cost">${fmt(d.cost)}</span><span class="f-name">${esc(d.name)}${d.tribe ? `<small>${esc(d.tribe)}</small>` : ''}</span></div>
      <div class="f-art"></div>
      <div class="f-type">${TYPE_LABEL[d.type]}${d.type === 'monster' ? `<br>パワー${fmt(d.power)}` : ''}</div>
      <div class="f-text">${esc(d.text)}</div>
    </div>${o.big ? '' : badges}</div>`;
}

// 新しい絵のカード：原画・名前・効果をもとに描きなおした絵を、原画と同じ区切りの枠に入れる
function designHTML(c, o, cls) {
  const d = def(c);
  const k = o.cost ?? d.cost, pw = o.power ?? d.power;
  const nl = [...d.name].length, tl = [...d.text].length;
  const ns = nl <= 5 ? 'n1' : nl <= 8 ? 'n2' : nl <= 13 ? 'n3' : 'n4';
  const ts = tl <= 30 ? 't1' : tl <= 60 ? 't2' : tl <= 100 ? 't3' : 't4';
  const art = d.img ? `style="background-image:url('cards/draw/${c.id}.svg')"` : '';
  return `<div class="${cls} dz"><div class="dz-in">
      <div class="dz-head"><span class="dz-cost ${k !== d.cost ? 'changed' : ''}">${fmt(k)}</span><div class="dz-name ${ns}"><b>${esc(d.name)}</b>${d.tribe ? `<small>${esc(d.tribe)}</small>` : ''}</div></div>
      <div class="dz-art" ${art}></div>
      <div class="dz-type"><b>${TYPE_LABEL[d.type]}</b>${d.type === 'monster' ? `<span class="${pw !== d.power ? 'changed' : ''}">パワー${fmt(pw)}</span>` : ''}${d.ld ? '<em>L.D</em>' : ''}</div>
      <div class="dz-text ${ts}">${esc(d.text)}</div>
    </div></div>`;
}

function renderArtControls() {
  document.querySelectorAll('[data-art]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.art === UI.art)));
  const btn = $('#artbtn');
  if (btn) btn.textContent = UI.art === 'design' ? '原画にする' : '新しい絵にする';
  const fan = $('#cardfan');
  if (fan) fan.innerHTML = ['manhole', 'arubaito', 'deadattacker'].map((id, i) => cardHTML({ uid: -1 - i, id }, { big: true })).join('');
}

const backHTML = (extra = '') => `<div class="card back ${extra}"><span>バケカ</span></div>`;
const emptyHTML = label => `<div class="empty"><span>${label}</span></div>`;

function myTurn() {
  return G && G.winner == null && !UI.busy && !(NET && NET.blocked()) && G.current === UI.viewer && !cur().cpu && PHASES.some(ph => ph.id === G.phase);
}

function canActMon(pi, s) {
  if (!myTurn() || pi !== UI.viewer) return false;
  if (canAttack(pi, s)) return true;
  if (G.phase !== 'attack' && canAttach(pi, s)) return true;
  return G.phase === 'main' && canDiscardAttach(pi, s);
}

function canUseHand(c) {
  if (!myTurn()) return false;
  const p = G.players[UI.viewer];
  if (c.id === 'energy') return G.phase !== 'attack' && slotsOf(p).some(s => canAttach(UI.viewer, s));
  return usableInMain(UI.viewer, c).ok;
}

function monSlotHTML(p, s) {
  const m = p.mons[s];
  if (!m) return `<div class="slot mon" data-p="${p.i}" data-s="${s}">${emptyHTML('モンスター')}</div>`;
  const pips = m.energy.length > 4
    ? `<span class="pip"></span><b>×${m.energy.length}</b>`
    : m.energy.map(() => '<span class="pip"></span>').join('');
  const off = !effectsOn(p.i, s) && (def(m.c).onSummon || def(m.c).powerFn || def(m.c).noAttack || def(m.c).unbreakable || def(m.c).ability || def(m.c).turnStart || def(m.c).noEnergy);
  return `<div class="slot mon filled ${canActMon(p.i, s) ? 'can' : ''} ${myTurn() && p.i === UI.viewer && canAttack(p.i, s) ? 'dragok' : ''}" data-zone="mon" data-p="${p.i}" data-s="${s}" data-cid="${m.c.uid}" data-z="mon">
      ${cardHTML(m.c, { power: power(p.i, s) })}
      ${m.equip ? '<span class="tag eq">そうび</span>' : ''}
      ${m.under.length ? `<span class="tag under">重ね${m.under.length}</span>` : ''}
      ${off ? '<span class="tag off">効果なし</span>' : ''}
      <div class="pips" aria-label="エネルギー${m.energy.length}枚">${pips}</div>
    </div>`;
}

function trapHTML(p) {
  if (!p.trap) return emptyHTML('わな');
  if (p.trap.faceUp) return cardHTML(p.trap.c);
  const mine = p.i === UI.viewer && !p.cpu;
  return mine ? cardHTML(p.trap.c, { extra: 'facedown-own' }) : backHTML('trapback');
}

function sideHTML(p, top) {
  const mons = [0, 1, 2].map(s => monSlotHTML(p, s));
  if (top) mons.reverse();
  const topGrave = p.grave[p.grave.length - 1];
  const lifeRow = `<div class="lgrow" data-zone="life" data-p="${p.i}">${[0, 1, 2].map(i => `<div class="cell">${i < p.life.length ? backHTML() : emptyHTML('')}</div>`).join('')}</div>`;
  const piles = [
    `<div class="cell pile" data-zone="grave" data-p="${p.i}">${topGrave ? cardHTML(topGrave) : emptyHTML('墓地')}<i>墓地 ${p.grave.length}</i></div>`,
    `<div class="cell pile" data-zone="deck" data-p="${p.i}">${p.deck.length ? backHTML() : emptyHTML('山札')}<i>山札 ${p.deck.length}</i></div>`,
    `<div class="cell pile" data-zone="egrave" data-p="${p.i}">${p.egrave.length ? cardHTML(p.egrave[0]) : emptyHTML('エネ墓地')}<i>エネ墓地 ${p.egrave.length}</i></div>`,
  ];
  if (top) piles.reverse();
  const pileRow = `<div class="pilerow">${piles.join('')}</div>`;
  const grid = `<div class="grid3">${top ? pileRow + lifeRow : lifeRow + pileRow}</div>`;
  // わなとフィールドはモンスター置き場の左右（自分は左がフィールド・右がわな、相手は逆）
  const fieldAux = `<div class="aux" data-zone="field" data-p="${p.i}" ${p.field ? `data-cid="${p.field.uid}" data-z="aux"` : ''}>${p.field ? cardHTML(p.field) : emptyHTML('フィールド')}</div>`;
  const trapAux = `<div class="aux" data-zone="trap" data-p="${p.i}" ${p.trap ? `data-cid="${p.trap.c.uid}" data-z="aux"` : ''}>${trapHTML(p)}</div>`;
  const rowAItems = top ? [trapAux, ...mons, fieldAux] : [fieldAux, ...mons, trapAux];
  const info = `<div class="pinfo ${p.i ? 'p2' : 'p1'} ${G.current === p.i ? 'active' : ''}" data-p="${p.i}">
      <b>${esc(p.name)}</b><span>手札 ${p.hand.length}</span>${top ? `<span class="minihand">${p.hand.map(() => '<i></i>').join('')}</span>` : ''}
      ${p.noDirect === G.turn ? '<span class="guard">ダイレクトアタック無効</span>' : ''}
    </div>`;
  const a = `<div class="row rowA">${rowAItems.join('')}</div>`;
  const b = `<div class="row rowB">${grid}</div>`;
  return top ? info + b + a : a + b + info;
}

function barHTML() {
  const p = cur();
  const mine = myTurn();
  const ph = PHASES.find(x => x.id === G.phase);
  let hint = '';
  if (G.winner != null) hint = '';
  else if (p.cpu) hint = 'CPUが考えています…';
  else if (G.mode === 'online' && G.current !== UI.viewer) hint = `${p.name}が考えています…`;
  else if (G.mode === 'cpu' || G.current === UI.viewer) hint = ph ? ph.hint : '';
  if (mine && G.phase === 'attack' && G.turn === 1) hint = '先行の最初のターンは攻撃できません';
  return `
    <div class="turn"><span class="whose ${G.current ? 'p2' : 'p1'}">${esc(p.name)}のターン</span><span class="tno">${G.turn}ターン目</span></div>
    <ol class="phases">${PHASES.map(x => `<li class="${x.id === G.phase ? 'on' : ''}">${x.label}</li>`).join('')}</ol>
    <div class="hint">${esc(hint)}</div>
    <button class="btn primary next" id="nextbtn" ${mine ? '' : 'disabled'}>ターンエンド</button>`;
}

function render() {
  if (!G) return;
  const before = UI.lastViewer === UI.viewer ? snapshot() : null;
  const me = G.players[UI.viewer], op = G.players[1 - UI.viewer];
  $('#opp').innerHTML = sideHTML(op, true);
  $('#me').innerHTML = sideHTML(me, false);
  $('#bar').innerHTML = barHTML();
  const showHand = !(G.mode === 'cpu' && me.cpu);
  $('#hand').innerHTML = showHand
    ? me.hand.map(c => `<button class="hcard ${canUseHand(c) ? 'can' : ''}" data-zone="hand" data-uid="${c.uid}" data-cid="${c.uid}" data-z="hand">${cardHTML(c, { cost: def(c).type === 'energy' ? 0 : cost(me.i, c) })}</button>`).join('') || '<p class="nohand">手札はありません</p>'
    : '';
  const last = G.log[G.log.length - 1];
  $('#logline').textContent = last ? last.msg : '';
  if (!$('#logpanel').hidden) renderLog();
  if (before) animateDiff(before);
  UI.lastViewer = UI.viewer;
  NET?.afterRender();
}

function renderLog() {
  $('#loglist').innerHTML = G.log.map(l => `<li class="${l.msg.startsWith('──') ? 'sep' : ''}">${esc(l.msg)}</li>`).join('');
  $('#loglist').scrollTop = 1e9;
}

/* ───────── カードをタップしたとき ───────── */

function infoSheet(c, extra, actions = []) {
  const d = def(c);
  const box = $('#modal');
  const meta = [TYPE_LABEL[d.type], d.tribe && `種族：${d.tribe}`, d.type !== 'energy' && `コスト：${fmt(d.cost)}`, d.type === 'monster' && `パワー：${fmt(d.power)}`, d.ld && 'L.D'].filter(Boolean);
  box.innerHTML = `
    <div class="sheet split" role="dialog" aria-modal="true">
      <button class="x" data-a="close" aria-label="とじる">×</button>
      <div class="sheet-body detail">
        <div class="dcard">${cardHTML(c, { big: true })}</div>
        <div class="dinfo">
          <h2>${esc(d.name)}</h2>
          <p class="meta">${meta.map(esc).join('　')}</p>
          <p class="dtext">${esc(d.text)}</p>
          ${extra ? `<p class="dextra">${extra}</p>` : ''}
          ${actions.filter(a => !a.ok && a.why).map(a => `<small class="why">${esc(a.why)}</small>`).join('')}
        </div>
      </div>
      <div class="btns">
        ${actions.map((a, i) => `<button class="btn ${a.ok ? 'primary' : ''}" data-a="${i}" ${a.ok ? '' : 'disabled'}>${esc(a.label)}</button>`).join('')}
        <button class="btn ghost" data-a="close">とじる</button>
      </div>
    </div>`;
  box.hidden = false;
  box.onclick = e => {
    if (e.target === box) { box.hidden = true; return; }
    const k = e.target.closest('[data-a]')?.dataset.a;
    if (k == null) return;
    box.hidden = true;
    box.innerHTML = '';
    if (k !== 'close') run(actions[+k].run);
  };
}

function handActions(c) {
  if (!myTurn()) return [];
  const pi = UI.viewer, p = G.players[pi], d = def(c);
  if (d.type === 'energy') {
    const targets = slotsOf(p).filter(s => canAttach(pi, s));
    return [{
      label: 'モンスターにつける', ok: (G.phase === 'main' || G.phase === 'energy') && targets.length > 0,
      why: G.phase === 'attack' ? '攻撃フェーズではつけられません' : 'つけられるモンスターがいません（1体1枚まで）',
      run: async () => {
        const s = targets.length === 1 ? targets[0] : await ask(pi, {
          title: 'どのモンスターにつける？',
          options: targets.map(i => ({ card: p.mons[i].c, label: `${nm(p.mons[i].c)}（エネ${p.mons[i].energy.length}）`, value: i })),
          cancel: true,
        });
        if (s != null) await act('playerAttach', pi, s);
      },
    }];
  }
  const u = usableInMain(pi, c);
  const k = cost(pi, c);
  const label = { monster: '出す', magic: '使う', trap: 'わなをふせる', equip: 'そうびする', field: 'フィールドに置く' }[d.type];
  return [{ label: label + (d.type !== 'trap' && k && k !== Infinity ? `（エネルギー×${k}）` : ''), ok: u.ok, why: u.why, run: () => act('useCard', pi, c.uid) }];
}

function monActions(pi, s) {
  if (!myTurn() || pi !== UI.viewer) return [];
  const p = G.players[pi], m = p.mons[s];
  const acts = [];
  if (G.phase === 'main' && has(pi, s, 'ability')) {
    acts.push({ label: '手札を1枚捨ててエネルギーをつける', ok: canDiscardAttach(pi, s), why: '捨てる手札か、つけるエネルギーがありません', run: () => act('discardAttach', pi, s) });
  }
  if (G.phase !== 'attack') {
    acts.push({
      label: 'エネルギーをつける', ok: canAttach(pi, s),
      why: has(pi, s, 'noEnergy') ? 'このモンスターにはエネルギーをつけられません'
        : m.eTurn === G.turn ? 'このターンはもうつけました（1体1枚まで）' : '手札にエネルギーがありません',
      run: () => act('playerAttach', pi, s),
    });
  }
  acts.push({
    label: '攻撃する（エネルギー×1）', ok: canAttack(pi, s),
    why: G.turn === 1 ? '先行の最初のターンは攻撃できません' : has(pi, s, 'noAttack') ? 'このモンスターは攻撃できません' : 'エネルギーがついていません',
    run: async () => {
      const oi = 1 - pi, o = G.players[oi];
      const opts = o.mons.map((x, i) => (x ? { card: x.c, label: `${nm(x.c)}（パワー${fmt(power(oi, i))}）`, value: i } : null)).filter(Boolean);
      if (!directBlocked(oi)) {
        opts.push({ label: o.life.length ? `${o.name}に攻撃（ライフガード残り${o.life.length}）` : `${o.name}にダイレクトアタック！`, value: 'player', primary: true });
      }
      if (!opts.length) { toast(`このターン、${o.name}はダイレクトアタックを受けません`); return; }
      const t = await ask(pi, {
        title: 'どこに攻撃する？',
        text: `「${nm(m.c)}」パワー${fmt(power(pi, s))}` + (directBlocked(oi) ? `（このターン、${o.name}はダイレクトアタックを受けません）` : ''),
        options: opts, cancel: true,
      });
      if (t != null) await act('playerAttack', pi, s, t);
    },
  });
  return acts;
}

function onZone(ds) {
  if (!G || !$('#modal').hidden) return;
  const pi = +ds.p, p = G.players[pi];
  switch (ds.zone) {
    case 'hand': {
      const c = G.players[UI.viewer].hand.find(x => x.uid === +ds.uid);
      if (c) infoSheet(c, def(c).type !== 'energy' && cost(UI.viewer, c) !== def(c).cost ? `いまのコスト <b>${fmt(cost(UI.viewer, c))}</b>` : '', handActions(c));
      break;
    }
    case 'mon': {
      const s = +ds.s, m = p.mons[s];
      if (!m) return;
      const extra = `いまのパワー <b>${fmt(power(pi, s))}</b>　ついているエネルギー <b>${m.energy.length}</b>枚` +
        (m.under.length ? `　下に重なっているカード：${m.under.map(c => esc(nm(c))).join('、')}` : '') +
        (m.equip ? `　そうび「${esc(nm(m.equip))}」` : '') +
        (!effectsOn(pi, s) ? '<br>相手の「モリのくま」がいるので、効果は消えています' : '');
      infoSheet(m.c, extra, monActions(pi, s));
      break;
    }
    case 'trap':
      if (!p.trap) toast('わなは置かれていません');
      else if (p.trap.faceUp || (pi === UI.viewer && !p.cpu)) infoSheet(p.trap.c, p.trap.faceUp ? '表向きで場に残っています' : 'ふせてあります（相手には見えません）');
      else toast('ふせられたわなカード');
      break;
    case 'field':
      if (p.field) infoSheet(p.field, '');
      else toast('フィールドカードは置かれていません');
      break;
    case 'grave':
      if (!p.grave.length) { toast('墓地にカードはありません'); break; }
      modal({ title: `${p.name}の墓地（${p.grave.length}枚）`, options: [...p.grave.map(c => ({ card: c, label: nm(c), value: c.uid })).reverse(), { label: 'とじる', value: null }] })
        .then(uid => {
          const c = p.grave.find(x => x.uid === uid);
          if (!c) return;
          const acts = [];
          if (def(c).fromGrave && pi === UI.viewer && myTurn()) {
            const u = usableInMain(pi, c, 'grave');
            acts.push({ label: `墓地から出す（エネルギー×${fmt(cost(pi, c))}）`, ok: u.ok, why: u.why, run: () => act('useCard', pi, uid, { from: 'grave' }) });
          }
          infoSheet(c, '', acts);
        });
      break;
    case 'egrave': toast(`エネルギー墓地：${p.egrave.length}枚`); break;
    case 'deck':
      if (pi === UI.viewer && !p.cpu) openDeckView(`${p.name}の山札（残り${p.deck.length}枚）`, '順番はわかりません', [{ label: '', ids: p.deck.map(c => c.id) }]);
      else toast(`山札：残り${p.deck.length}枚`);
      break;
    case 'life': toast(`ライフガード：残り${p.life.length}枚`); break;
  }
}

/* ───────── デッキの中身 ───────── */

const TYPE_ORDER = { monster: 0, magic: 1, trap: 2, equip: 3, field: 4, energy: 5 };

function deckGroups(ids) {
  const m = new Map();
  for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
  return [...m].sort((a, b) => {
    const A = CARD_DB[a[0]], B = CARD_DB[b[0]];
    return TYPE_ORDER[A.type] - TYPE_ORDER[B.type] || (A.cost === Infinity ? 99 : A.cost) - (B.cost === Infinity ? 99 : B.cost);
  });
}

// tabs: [{label, ids}]。対戦中の山札は1つだけ
function openDeckView(title, note, tabs, start = 0) {
  const box = $('#deckview');
  const draw = i => {
    const groups = deckGroups(tabs[i].ids);
    const counts = Object.entries(TYPE_LABEL).map(([t, label]) => {
      const n = groups.filter(([id]) => CARD_DB[id].type === t).reduce((s, [, k]) => s + k, 0);
      return n ? `${label} ${n}` : '';
    }).filter(Boolean).join('　');
    box.innerHTML = `
      <div class="sheet split" role="dialog" aria-modal="true">
        <button class="x" data-dv="close" aria-label="とじる">×</button>
        <div class="sheet-body">
          <h2>${esc(title)}</h2>
          ${tabs.length > 1 ? `<div class="seg dvtabs">${tabs.map((t, k) => `<button data-dv="tab${k}" aria-pressed="${k === i}">${esc(t.label)}</button>`).join('')}</div>` : ''}
          <p class="meta">${tabs[i].ids.length}枚　${esc(counts)}${note ? '　' + esc(note) : ''}</p>
          <div class="dv-grid">${groups.map(([id, n]) => `
            <button class="dv-item" data-dv="card:${id}">${cardHTML({ uid: -1, id })}<b class="dv-count">×${n}</b><span class="dv-name">${esc(CARD_DB[id].short || CARD_DB[id].name)}</span></button>`).join('')}</div>
        </div>
        <div class="btns"><button class="btn ghost" data-dv="close">とじる</button></div>
      </div>`;
  };
  draw(start);
  box.hidden = false;
  box.onclick = e => {
    const k = e.target.closest('[data-dv]')?.dataset.dv;
    if (!k) { if (e.target === box) box.hidden = true; return; }
    if (k === 'close') box.hidden = true;
    else if (k.startsWith('tab')) draw(+k.slice(3));
    else if (k.startsWith('card:')) infoSheet({ uid: -1, id: k.slice(5) }, '', []);
  };
}

function deckIds(deck) {
  return deck.cards.flatMap(([id, n]) => Array(n).fill(id));
}

function openTitleDecks() {
  openDeckView('デッキの中身', '', DECKS.map(d => ({ label: `${d.name}（${d.key}）`, ids: deckIds(d) })), +$('#deck1').value || 0);
}

/* ───────── 結果・タイトル ───────── */

function showResult() {
  const w = G.players[G.winner];
  bgm(false);
  const lost = G.mode === 'cpu' ? w.cpu : G.mode === 'online' ? G.winner !== UI.viewer : false;
  sfx(lost ? 'lose' : 'win');
  const title = G.mode === 'cpu' ? (w.cpu ? 'まけ…' : 'かち！') : G.mode === 'online' ? (G.winner === UI.viewer ? 'かち！' : 'まけ…') : `${w.name}の勝ち！`;
  $('#restitle').textContent = title;
  $('#restitle').className = G.winner ? 'p2' : 'p1';
  $('#resreason').textContent = `${G.players[1 - G.winner].name}は${G.reason}。`;
  $('#result').hidden = false;
}

function showTitle() {
  G = null;
  bgm(false);
  $('#game').hidden = true;
  $('#result').hidden = true;
  $('#modal').hidden = true;
  $('#pass').hidden = true;
  $('#title').hidden = false;
}

function setup() {
  for (const id of ['deck1', 'deck2']) {
    $('#' + id).innerHTML = DECKS.map((d, i) => `<option value="${i}">${esc(d.name)}（${esc(d.key)}）</option>`).join('');
  }
  $('#deck2').value = String(Math.min(1, DECKS.length - 1));
  const probs = DECKS.flatMap(d => deckProblems(d).map(x => `${d.name}：${x}`));
  $('#decknote').textContent = `カードは全部で${Object.keys(CARD_DB).length - 1}種類。どのデッキもエネルギー10枚＋通常カード15枚です。` + (probs.length ? ' ／ ' + probs.join('、') : '');

  document.querySelectorAll('[data-mode]').forEach(b => {
    b.onclick = () => {
      const mode = b.dataset.mode;
      const n1 = $('#name1').value.trim() || (mode === 'cpu' ? 'あなた' : 'プレイヤー1');
      const n2 = mode === 'cpu' ? 'CPU' : ($('#name2').value.trim() || 'プレイヤー2');
      newGame({ mode, names: [n1, n2], hide: $('#hide').checked, decks: [+$('#deck1').value, +$('#deck2').value] });
    };
  });
  document.querySelectorAll('[data-art]').forEach(b => { b.onclick = () => setArt(b.dataset.art); });
  $('#artbtn').onclick = () => setArt(UI.art === 'design' ? 'original' : 'design');
  renderArtControls();
  $('#again').onclick = () => {
    if (G && G.mode === 'online' && NET) { NET.rematch(); return; }
    newGame(UI.opts);
  };
  $('#totitle').onclick = () => { NET?.leave(); showTitle(); };
  document.querySelectorAll('[data-rules]').forEach(b => { b.onclick = () => { $('#rules').hidden = false; }; });
  $('#deckbtn').onclick = openTitleDecks;
  $('#rulesclose').onclick = () => { $('#rules').hidden = true; };
  $('#logbtn').onclick = () => { const lp = $('#logpanel'); lp.hidden = !lp.hidden; if (!lp.hidden) renderLog(); };
  $('#logline').onclick = $('#logbtn').onclick;
  $('#quit').onclick = async () => {
    if (!$('#modal').hidden) return;
    const yes = await modal({ title: 'タイトルにもどる？', text: 'いまの対戦は終わりになります。', options: [{ label: 'もどる', value: true, primary: true }, { label: 'つづける', value: false }] });
    if (yes) { NET?.leave(); showTitle(); }
  };

  setupDrag();
  document.addEventListener('click', e => {
    if (UI.noClick) { UI.noClick = false; return; }
    if (e.target.closest('#nextbtn')) { if (myTurn()) run(() => act('endTurn')); return; }
    const z = e.target.closest('[data-zone]');
    if (z && z.closest('#game')) onZone(z.dataset);
  });
}

// ドラッグで行動する：手札のカードを場へ、攻撃フェーズは自分のモンスターを相手へ
function dropTargets(src) {
  const pi = UI.viewer, oi = 1 - pi, p = G.players[pi], o = G.players[oi];
  const out = [];
  const add = (el, run) => { if (el) out.push({ el, run }); };
  if (src.kind === 'hand') {
    const c = p.hand.find(x => x.uid === src.uid);
    if (!c) return out;
    const d = def(c);
    if (d.type === 'energy') {
      if (G.phase === 'main' || G.phase === 'energy') for (const s of slotsOf(p).filter(s => canAttach(pi, s))) add(monEl(pi, s), () => act('playerAttach', pi, s));
      return out;
    }
    if (!usableInMain(pi, c).ok) return out;
    if (d.type === 'monster') {
      for (let s = 0; s < 3; s++) if (!p.mons[s]) add(monEl(pi, s), () => act('useCard', pi, c.uid, { slot: s }));
    } else if (d.type === 'trap') {
      add($(`#game .aux[data-zone="trap"][data-p="${pi}"]`), () => act('useCard', pi, c.uid));
    } else if (d.type === 'field') {
      add($(`#game .aux[data-zone="field"][data-p="${pi}"]`), () => act('useCard', pi, c.uid));
    } else if (d.type === 'equip') {
      for (const s of slotsOf(p)) add(monEl(pi, s), () => act('useCard', pi, c.uid, { slot: s }));
    } else if (d.type === 'magic') {
      add($('#me'), () => act('useCard', pi, c.uid));
    }
  } else if (src.kind === 'mon' && canAttack(pi, src.s)) {
    for (const t of slotsOf(o)) add(monEl(oi, t), () => act('playerAttack', pi, src.s, t));
    if (!directBlocked(oi)) {
      add($(`#game .lgrow[data-p="${oi}"]`), () => act('playerAttack', pi, src.s, 'player'));
      add($(`#game .pinfo[data-p="${oi}"]`), () => act('playerAttack', pi, src.s, 'player'));
    }
  }
  return out;
}

function setupDrag() {
  let d = null;
  const hit = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? d.targets.find(t => t.el.contains(el)) : null;
  };
  const begin = (e, src, el) => {
    if (!myTurn()) return;
    d = { src, el, x0: e.clientX, y0: e.clientY, id: e.pointerId, on: false };
  };
  $('#hand').addEventListener('pointerdown', e => {
    const btn = e.target.closest('.hcard');
    if (btn) begin(e, { kind: 'hand', uid: +btn.dataset.uid }, btn);
  });
  $('#game').addEventListener('pointerdown', e => {
    const slot = e.target.closest('.slot.mon.filled');
    if (slot && +slot.dataset.p === UI.viewer) begin(e, { kind: 'mon', s: +slot.dataset.s }, slot);
  });
  window.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.on) {
      if (Math.hypot(dx, dy) < 8) return;
      if (d.src.kind === 'hand' && e.pointerType === 'touch' && Math.abs(dx) > Math.abs(dy)) { d = null; return; } // 横は手札のスクロール
      d.targets = dropTargets(d.src);
      if (!d.targets.length) { d = null; return; }
      d.on = true;
      const card = d.el.querySelector('.card');
      const r = card.getBoundingClientRect();
      d.w = r.width; d.h = r.height;
      d.ghost = document.createElement('div');
      d.ghost.className = 'drag-ghost';
      d.ghost.style.cssText = `width:${r.width}px;height:${r.height}px`;
      d.ghost.innerHTML = card.outerHTML;
      document.body.appendChild(d.ghost);
      d.el.classList.add('dragging');
      for (const t of d.targets) t.el.classList.add('droptarget');
    }
    e.preventDefault();
    d.ghost.style.transform = `translate(${e.clientX - d.w / 2}px, ${e.clientY - d.h * 0.7}px) rotate(-6deg) scale(1.1)`;
    const t = hit(e.clientX, e.clientY);
    for (const x of d.targets) x.el.classList.toggle('dropover', x === t);
  }, { passive: false });
  const finish = (e, cancel) => {
    if (!d || (e && e.pointerId !== d.id)) return;
    const cur = d;
    if (!cur.on) { d = null; return; }
    const t = cancel ? null : hit(e.clientX, e.clientY);
    d = null;
    UI.noClick = true;
    setTimeout(() => { UI.noClick = false; }, 50);
    for (const x of cur.targets) x.el.classList.remove('droptarget', 'dropover');
    cur.el.classList.remove('dragging');
    if (t) {
      cur.ghost.remove();
      run(t.run);
    } else {
      const r = cur.el.getBoundingClientRect();
      cur.ghost.animate([{ transform: cur.ghost.style.transform, opacity: 1 }, { transform: `translate(${r.left}px, ${r.top}px)`, opacity: 0.3 }], { duration: 250, fill: 'forwards' });
      setTimeout(() => cur.ghost.remove(), 260);
    }
  };
  window.addEventListener('pointerup', e => finish(e, false));
  window.addEventListener('pointercancel', e => finish(e, true));
}

setup();
