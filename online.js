'use strict';
/*
 * バケカ — オンライン対戦（PeerJS で2人のブラウザを直接つなぐ）
 *
 * 部屋を作った人（ホスト）のブラウザがゲームを進める。
 * ホスト → 相手：盤面の状態（state）、演出（fx）、効果の選択の質問（ask）
 * 相手 → ホスト：参加（join）、行動（act）、質問への答え（answer）、もう一度（rematch）
 */

const PEER_PREFIX = 'bakeka-battle-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

NET = {
  isHost: false,
  peer: null,
  conn: null,
  myName: '', myDeck: 0,
  seq: 0, lastSeq: 0, waitFrom: -1, waiting: false, hostBusy: false,
  sendTimer: null,
  askSeq: 0, asks: new Map(), approving: false,
  queue: Promise.resolve(),

  // ── 共通 ──
  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  },
  blocked() {
    return G && G.mode === 'online' && !this.isHost && (this.waiting || this.hostBusy);
  },
  leave() {
    try { this.conn?.close(); } catch { /* もう切れている */ }
    try { this.peer?.destroy(); } catch { /* もう切れている */ }
    this.conn = null; this.peer = null; this.isHost = false;
    this.asks.clear();
  },

  // ── ホスト側 ──
  // 盤面を送る（描くたびに呼ばれるので、まとめて1回にする）
  afterRender() {
    if (!this.isHost || !this.conn || !G || G.mode !== 'online') return;
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => this.flush(), 0);
  },
  flush() {
    if (this.sendTimer) { clearTimeout(this.sendTimer); this.sendTimer = null; }
    if (!this.isHost || !this.conn || !G || G.mode !== 'online') return;
    const g = { ...G, log: G.log.slice(-80) };
    this.send({ t: 'state', seq: ++this.seq, busy: UI.busy, g });
  },
  // 演出を相手にも見せる（盤面を先に送ってから）
  fx(name, args) {
    if (!this.isHost || !this.conn || !G || G.mode !== 'online') return;
    if (name === 'toast' && !UI.busy) return; // ホストが自分で見ただけのお知らせは送らない
    this.flush();
    this.send({ t: 'fx', name, args });
  },
  // 相手に効果の選択を聞く
  remoteAsk(pi, q) {
    this.flush();
    const id = ++this.askSeq;
    const plain = {
      title: q.title, text: q.text || '', card: q.card || null, cancel: !!q.cancel,
      options: q.options.map(o => ({ label: o.label, value: o.value, card: o.card || null, primary: !!o.primary })),
    };
    toast(`${G.players[pi].name}が選んでいます…`);
    return new Promise(res => {
      this.asks.set(id, res);
      this.send({ t: 'ask', id, q: plain });
    });
  },
  rematch() {
    if (this.isHost) { if (UI.opts) newGame(UI.opts); }
    else { this.send({ t: 'rematch' }); $('#result').hidden = true; toast('もう一度をお願いしました'); }
  },
  onHostMessage(m) {
    if (m.t === 'join') {
      if (G && G.mode === 'online' && G.winner == null) return;
      if (this.approving) return;
      const name = String(m.name || '相手').slice(0, 10);
      this.approving = true;
      // 参加はホストの承認がいる
      modal({
        title: '参加のおねがい',
        text: `「${name}」さんが対戦に参加したいと言っています。許可しますか？`,
        options: [{ label: '許可する', value: true, primary: true }, { label: 'ことわる', value: false }],
      }).then(ok => {
        this.approving = false;
        if (!this.conn || !this.conn.open) return;
        if (!ok) {
          this.send({ t: 'denied' });
          const c = this.conn;
          this.conn = null;
          setTimeout(() => { try { c.close(); } catch { /* もう切れている */ } }, 500);
          onlineStatus('参加をことわりました。部屋はそのまま開いています。');
          return;
        }
        closeOnline();
        newGame({ mode: 'online', names: [this.myName, name], decks: [this.myDeck, DECKS[m.deck] ? m.deck : 0], hide: false });
      });
    } else if (m.t === 'act') {
      if (!G || G.current !== 1 || UI.busy || G.winner != null || !ACTIONS[m.name]) { this.flush(); return; }
      run(() => ACTIONS[m.name](...(m.args || [])));
    } else if (m.t === 'answer') {
      const res = this.asks.get(m.id);
      if (res) { this.asks.delete(m.id); res(m.value); }
    } else if (m.t === 'rematch') {
      if (G && G.winner != null && UI.opts) newGame(UI.opts);
    }
  },

  // ── 相手側 ──
  sendAct(name, args) {
    this.waiting = true;
    this.waitFrom = this.lastSeq;
    this.send({ t: 'act', name, args });
    render();
  },
  onGuestMessage(m) {
    this.queue = this.queue.then(() => this.applyGuest(m)).catch(e => console.error(e));
  },
  async applyGuest(m) {
    if (m.t === 'denied') {
      this.conn = null;
      onlineStatus('ホストに参加をことわられました。', true);
      return;
    }
    if (m.t === 'state') {
      this.lastSeq = m.seq;
      this.hostBusy = m.busy;
      if (!m.busy && m.seq > this.waitFrom) this.waiting = false;
      const first = !G || G.mode !== 'online';
      G = m.g;
      UI.viewer = 1;
      if (first) {
        bgm(true);
        closeOnline();
        $('#title').hidden = true;
        $('#game').hidden = false;
        for (const id of ['#opp', '#me', '#hand']) $(id).innerHTML = '';
        UI.from.clear();
        for (const c of G.players[1].hand) UI.from.set(String(c.uid), { pi: 1, pile: 'deck' });
        UI.lastViewer = 1;
      }
      if (G.winner == null) $('#result').hidden = true;
      render();
      if (G.winner != null && $('#result').hidden) showResult();
    } else if (m.t === 'fx') {
      if (m.name === 'toast') toast(...m.args);
      else if (m.name === 'sfx') sfx(m.args[0]);
      else if (m.name === 'mark') markLocal(...m.args);
      else if (m.name === 'fxPip') fxPip(...m.args);
      else {
        const f = { fxAttack, fxClash, fxLife, fxTrap, fxDirect }[m.name];
        if (f) await f(...m.args);
      }
    } else if (m.t === 'ask') {
      const value = await modal({ ...m.q });
      this.send({ t: 'answer', id: m.id, value });
    }
  },
};

/* ───────── 部屋を作る・入る ───────── */

function onlineStatus(msg, isError = false) {
  const el = $('#onstatus');
  el.textContent = msg;
  el.classList.toggle('err', isError);
}

function openOnline() {
  if (typeof Peer === 'undefined') {
    $('#online').hidden = false;
    onlineStatus('オンライン対戦は、公開したWebサイトで開いたときだけ使えます（このページでは通信が使えません）。', true);
    $('#onhost').disabled = true; $('#onjoin').disabled = true;
    return;
  }
  NET.leave();
  $('#onhost').disabled = false; $('#onjoin').disabled = false;
  $('#oncode').hidden = true;
  onlineStatus('部屋を作るか、相手から聞いた部屋番号を入れてください。');
  $('#online').hidden = false;
}

function closeOnline() {
  $('#online').hidden = true;
}

function myOnlineSettings() {
  NET.myName = $('#name1').value.trim() || 'プレイヤー';
  NET.myDeck = +$('#deck1').value;
}

function hostRoom(tries = 0) {
  myOnlineSettings();
  NET.leave();
  NET.isHost = true;
  const code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  onlineStatus('部屋を作っています…');
  const peer = new Peer(PEER_PREFIX + code, { debug: 0 });
  NET.peer = peer;
  peer.on('open', () => {
    $('#oncode').hidden = false;
    $('#oncodetext').textContent = code;
    onlineStatus('相手にこの部屋番号を伝えて、待っていてください。');
  });
  peer.on('connection', conn => {
    if (NET.conn && NET.conn.open) { conn.on('open', () => { conn.send({ t: 'denied' }); setTimeout(() => conn.close(), 300); }); return; }
    NET.conn = conn;
    conn.on('open', () => onlineStatus('参加したい人がいます。'));
    conn.on('data', m => NET.onHostMessage(m));
    conn.on('close', () => lostConnection());
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id' && tries < 3) { hostRoom(tries + 1); return; }
    onlineStatus(peerErrorText(e), true);
  });
  peer.on('disconnected', () => { if (!NET.conn) onlineStatus('通信サーバーとの接続が切れました。もう一度「部屋を作る」を押してください。', true); });
}

function joinRoom() {
  const code = $('#onjoincode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 4) { onlineStatus('部屋番号は4文字です。', true); return; }
  myOnlineSettings();
  NET.leave();
  NET.isHost = false;
  NET.waiting = false; NET.hostBusy = false; NET.lastSeq = 0; NET.waitFrom = -1;
  NET.queue = Promise.resolve();
  onlineStatus('部屋につないでいます…');
  const peer = new Peer({ debug: 0 });
  NET.peer = peer;
  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + code, { serialization: 'json', reliable: true });
    NET.conn = conn;
    const timer = setTimeout(() => { if (!conn.open) onlineStatus('つながりませんでした。部屋番号を確かめて、もう一度ためしてください。', true); }, 15000);
    conn.on('open', () => {
      clearTimeout(timer);
      onlineStatus('つながりました。ホストの承認を待っています…');
      conn.send({ t: 'join', name: NET.myName, deck: NET.myDeck });
    });
    conn.on('data', m => NET.onGuestMessage(m));
    conn.on('close', () => lostConnection());
  });
  peer.on('error', e => onlineStatus(peerErrorText(e), true));
}

function peerErrorText(e) {
  if (e.type === 'peer-unavailable') return 'その部屋番号の部屋が見つかりません。番号を確かめてください。';
  if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') return '通信サーバーにつながりません。インターネットの接続を確かめてください。';
  if (e.type === 'browser-incompatible') return 'このブラウザはオンライン対戦に対応していません。';
  return 'つながりませんでした（' + e.type + '）。もう一度ためしてください。';
}

function lostConnection() {
  if (!NET.conn) return;
  NET.conn = null;
  if (G && G.mode === 'online' && !$('#game').hidden) {
    modal({ title: '相手との接続が切れました', text: '対戦を続けられません。タイトルにもどります。', options: [{ label: 'タイトルへ', value: true, primary: true }] })
      .then(() => { NET.leave(); showTitle(); });
  } else {
    onlineStatus('相手との接続が切れました。', true);
  }
}

$('#onopen').onclick = openOnline;
$('#onclose').onclick = () => { NET.leave(); closeOnline(); };
$('#onhost').onclick = () => hostRoom();
$('#onjoin').onclick = joinRoom;
$('#onjoincode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('#oncopy').onclick = async () => {
  const code = $('#oncodetext').textContent;
  try { await navigator.clipboard.writeText(code); toast('部屋番号をコピーしました'); }
  catch { toast('コピーできませんでした。番号を直接伝えてください'); }
};
