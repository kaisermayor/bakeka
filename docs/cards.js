'use strict';
/*
 * バケカ カードデータ
 *
 * 新しいカードを足すときは CARD_DB に1枚分を追加する。
 *   id / name / type(monster|magic|trap|equip|field|energy) / cost / tribe / power / text / img
 *   short   : ログなどで使う短い名前（長い名前のカードだけ）
 *
 * 効果（api は game.js の API を参照）
 *   onSummon(api, me, slot)      モンスターが場に出たとき
 *   onCast(api, me)              まほうを使ったとき。'hand' を返すと墓地ではなく手札にもどる
 *   canCast(api, me)             まほうを今使えるか（使えないときは理由の文字列を返す）
 *   trigger + onTrap(api, me, ctx) わな。trigger は opponentAttack / opponentSummon / opponentAttach / ownLifeBroken
 *   powerFn(api, me, mon)        パワーを計算で決める
 *   costFn(api, me)              コストを計算で決める
 *   turnStart(api, me, slot)     自分のターンのはじめ
 *   check(api, me, slot)         場の様子が変わるたびに調べる（自動でもどる など）
 *   ability                      メインフェーズにタップして使える能力
 *   noAttack / noEnergy / unbreakable / silence / ld / fromGrave   決まった性質
 *
 * ルール：カードに「墓地」と書いてあれば、エネルギー墓地もふくむ（枚数は api.graveCount で数える）
 *   aiUse(api, me)               CPU がこのカードを使うかどうか
 *   aiTrap(api, me, ctx)         CPU がこのわなを発動するかどうか（ないときはいつも発動する）
 */

const CARD_DB = {
  energy: {
    id: 'energy', name: 'エネルギー', type: 'energy', cost: 0, img: null,
    text: 'コストの支払いに使う。モンスターにつけると、1枚使うごとに攻撃・防御が1回できる。',
  },

  /* ───────── デッキ1のカード ───────── */

  wither: {
    id: 'wither', name: 'ウィザー（ネザーモード）', short: 'ウィザー', tribe: 'マイクラウィザー', type: 'monster',
    cost: Infinity, power: Infinity, img: 'cards/wither.jpg', fromGrave: true,
    text: 'このモンスターは墓地からも出せる。このモンスターのコストは、墓地（エネルギー墓地もふくむ）にカードが6枚以上あれば1になる（6枚より少ないと出せない）。出たとき、このモンスター以外のモンスターをすべて破壊する。',
    costFn: (api, me) => (api.graveCount(me) >= 6 ? 1 : Infinity),
    async onSummon(api, me, slot) {
      api.toast('ウィザーがすべてをこわす！', 'attack');
      await api.sleep(600);
      for (const pi of [me, 1 - me]) {
        for (let s = 0; s < 3; s++) if (!(pi === me && s === slot)) api.destroy(pi, s);
      }
    },
    aiUse(api, me) {
      const sum = pi => api.player(pi).mons.reduce((t, m, s) => t + (m ? Math.min(api.power(pi, s), 4000) + 500 : 0), 0);
      return sum(1 - me) > sum(me);
    },
  },

  witherskel: {
    id: 'witherskel', name: 'ウィザースケルトン', tribe: 'マイクラ・ネザー', type: 'monster', cost: 1, power: 1600,
    img: 'cards/witherskel.jpg',
    text: '出たとき、自分の山札の上から3枚を墓地に置く（エネルギーはエネルギー墓地へ）。',
    async onSummon(api, me) {
      const p = api.player(me);
      const n = Math.min(3, p.deck.length);
      api.toGrave(me, p.deck.splice(0, n));
      api.log(`${p.name}は山札の上から${n}枚を墓地に置いた`);
    },
  },

  inuno: {
    id: 'inuno', name: 'イぬノオまクソサン', tribe: 'どうぶつ', type: 'monster', cost: 3, power: 1800,
    img: 'cards/inuno.jpg',
    text: '出たとき、相手のモンスター1体についているエネルギーを1枚えらんで破壊する。',
    async onSummon(api, me) {
      const oi = 1 - me, o = api.player(oi);
      const t = o.mons.map((m, i) => (m && m.energy.length ? i : -1)).filter(i => i >= 0);
      if (!t.length) { api.log('エネルギーのついた相手モンスターがいないので、効果は空振り'); return; }
      const s = await api.ask(me, {
        title: 'イぬノオまクソサンの効果',
        text: 'エネルギーを1枚破壊する相手のモンスターをえらんでください。',
        options: t.map(i => ({ card: o.mons[i].c, label: `${api.name(o.mons[i].c)}（エネ${o.mons[i].energy.length}）`, value: i })),
        ai: () => [...t].sort((a, b) => api.power(oi, b) - api.power(oi, a))[0],
      });
      o.egrave.push(o.mons[s].energy.pop());
      api.log(`${o.name}の「${api.name(o.mons[s].c)}」のエネルギーを1枚破壊した`);
    },
  },

  obakuso: {
    id: 'obakuso', name: '犬のオバクソさん', tribe: 'ゴースト', type: 'monster', cost: 3, power: 1700,
    img: 'cards/obakuso.jpg',
    text: '出たとき、自分のエネルギー墓地にあるエネルギーをすべてこのモンスターにつける。',
    async onSummon(api, me, slot) {
      const n = api.attachFromEgrave(me, slot, Infinity);
      api.log(`エネルギー墓地から${n}枚を「犬のオバクソさん」につけた`);
    },
  },

  hikakin: {
    id: 'hikakin', name: 'ヒカキン', tribe: 'マイクラ', type: 'monster', cost: 1, power: 1600,
    img: 'cards/hikakin.jpg',
    text: '効果はありません。（レア）',
  },

  hikakin2: {
    id: 'hikakin2', name: 'ヒカキン（仮カード）', short: 'ヒカキン（仮）', tribe: 'マイクラ', type: 'monster', cost: 1, power: 1599,
    img: 'cards/hikakin2.jpg',
    text: 'どちらかのモンスターゾーンにほかの「ヒカキン」が出ていたら、このモンスターを手札にもどす。',
    check(api, me, slot) {
      const self = api.player(me).mons[slot];
      const other = [0, 1].some(pi => api.player(pi).mons.some(m => m && m !== self && m.c.id.startsWith('hikakin')));
      if (other) {
        api.bounce(me, slot);
        api.log('ほかの「ヒカキン」がいるので、「ヒカキン（仮）」は手札にもどった');
      }
    },
    aiUse: api => ![0, 1].some(pi => api.player(pi).mons.some(m => m && m.c.id.startsWith('hikakin'))),
  },

  kaicho: {
    id: 'kaicho', name: '会長リュー1', tribe: 'にんげん', type: 'monster', cost: 4, power: 1900,
    img: 'cards/kaicho.jpg',
    text: 'メインフェーズに、自分の手札を1枚捨てるごとに、エネルギー墓地からエネルギーを1枚このモンスターにつけられる（捨てたエネルギーをそのままつけてもよい）。',
    ability: 'discardAttach',
  },

  robo: {
    id: 'robo', name: '会長ロボリュー1', tribe: 'ロボット', type: 'monster', cost: 5, power: 2400,
    img: 'cards/robo.jpg',
    text: '出たとき、自分の手札とエネルギー墓地にあるエネルギーをすべてこのモンスターにつける。',
    async onSummon(api, me, slot) {
      const p = api.player(me), m = p.mons[slot];
      const fromHand = p.hand.filter(c => c.id === 'energy');
      p.hand = p.hand.filter(c => c.id !== 'energy');
      m.energy.push(...fromHand);
      const n = api.attachFromEgrave(me, slot, Infinity);
      api.log(`「会長ロボリュー1」にエネルギーを${fromHand.length + n}枚つけた`);
    },
  },

  spkaicho: {
    id: 'spkaicho', name: 'SP会長リュー1', tribe: 'にんげん', type: 'monster', cost: 11, power: 3011,
    img: 'cards/spkaicho.jpg',
    text: 'このモンスターのコストは、自分の墓地とエネルギー墓地のカードの枚数だけ少なくなる。出たとき、エネルギー墓地のエネルギーをすべてこのモンスターにつける。パワーは、ついているエネルギー1枚につき＋500。メインフェーズに、手札を1枚捨てるごとにエネルギー墓地からエネルギーを1枚つけられる。',
    costFn: (api, me) => Math.max(0, 11 - api.graveCount(me)),
    powerFn: (api, me, m) => 3011 + 500 * m.energy.length,
    async onSummon(api, me, slot) {
      const n = api.attachFromEgrave(me, slot, Infinity);
      api.log(`エネルギー墓地から${n}枚を「SP会長リュー1」につけた`);
    },
    ability: 'discardAttach',
  },

  gucha: {
    id: 'gucha', name: 'ぐちゃぐちゃ', tribe: 'キチガイ', type: 'monster', cost: 4, power: 2000,
    img: 'cards/gucha.jpg',
    text: '出たとき、自分のエネルギー墓地にあるエネルギーをすべて手札に加える。',
    async onSummon(api, me) {
      const p = api.player(me);
      const n = p.egrave.length;
      const got = p.egrave.splice(0);
      p.hand.push(...got);
      api.mark(me, got, 'egrave');
      api.log(`${p.name}はエネルギー墓地からエネルギーを${n}枚手札に加えた`);
    },
  },

  arubaito: {
    id: 'arubaito', name: 'アルバイト', tribe: 'にんげん', type: 'monster', cost: 1, power: 1000,
    img: 'cards/arubaito.jpg',
    text: '出たとき、墓地かエネルギー墓地からカードを1枚手札に加える。',
    async onSummon(api, me) {
      const p = api.player(me);
      const pool = [...p.grave, ...p.egrave.slice(-1)];
      if (!pool.length) { api.log('墓地にカードがないので、効果は空振り'); return; }
      const uid = await api.ask(me, {
        title: 'アルバイトの効果',
        text: '墓地かエネルギー墓地から、手札に加えるカードを1枚えらんでください。',
        options: pool.map(c => ({ card: c, label: api.name(c), value: c.uid })),
        ai: () => [...pool].sort((a, b) => api.cardValue(b) - api.cardValue(a))[0].uid,
      });
      for (const z of [p.grave, p.egrave]) {
        const i = z.findIndex(x => x.uid === uid);
        if (i >= 0) { const c = z.splice(i, 1)[0]; p.hand.push(c); api.mark(me, [c], z === p.grave ? 'grave' : 'egrave'); api.log(`${p.name}は墓地から「${api.name(c)}」を手札に加えた`); }
      }
    },
  },

  deadattacker: {
    id: 'deadattacker', name: 'デッドアタッカー', type: 'magic', cost: 2,
    img: 'cards/deadattacker.jpg',
    text: '自分のエネルギー墓地からエネルギーをすべて手札に加える。',
    async onCast(api, me) {
      const p = api.player(me);
      const n = p.egrave.length;
      const got = p.egrave.splice(0);
      p.hand.push(...got);
      api.mark(me, got, 'egrave');
      api.log(`${p.name}はエネルギー墓地からエネルギーを${n}枚手札に加えた`);
    },
    aiUse: (api, me) => api.player(me).egrave.length >= 1,
  },

  saiaku: {
    id: 'saiaku', name: 'さいあく', type: 'trap', cost: 0,
    img: 'cards/saiaku.jpg', trigger: 'opponentAttack',
    text: '相手のモンスターが攻撃するとき発動できる。相手のモンスターについているエネルギーをすべてエネルギー墓地に送り、その攻撃を止める。',
    async onTrap(api, me, ctx) {
      const o = api.player(ctx.attacker);
      let n = 0;
      for (const m of o.mons) if (m) { n += m.energy.length; o.egrave.push(...m.energy.splice(0)); }
      api.log(`わな「さいあく」発動！ ${o.name}のモンスターのエネルギー${n}枚がエネルギー墓地へ`);
      api.toast('わな「さいあく」発動！', 'trap');
      api.trapToGrave(me);
      return { stop: true };
    },
  },

  akizawa: {
    id: 'akizawa', name: 'アキザワのおじいちゃんのおねーちゃんのまごのおにーさんのむすこのおけつ', short: 'アキザワの…おけつ',
    type: 'trap', cost: 0, img: 'cards/akizawa.jpg', trigger: 'opponentAttach',
    text: '相手がモンスターにエネルギーをつけたとき発動できる。相手のターンの残りをとばす。',
    async onTrap(api, me) {
      api.log('わな「アキザワの…おけつ」発動！ 相手のターンはここで終わり');
      api.toast('わな「アキザワの…おけつ」発動！', 'trap');
      api.trapToGrave(me);
      await api.sleep(900);
      api.skipTurn();
    },
  },

  /* ───────── デッキ2のカード ───────── */

  apanman: {
    id: 'apanman', name: 'あパンマン', type: 'monster', cost: 1, power: 2000,
    img: 'cards/apanman.jpg', noAttack: true,
    text: 'このモンスターは攻撃できない（防御はできる）。',
  },

  bochi: {
    id: 'bochi', name: 'ぼちとはかなしい言葉じゃない', short: 'ぼちとは…', tribe: 'ゴースト', type: 'monster', cost: 3, power: 1700,
    img: 'cards/bochi.jpg',
    text: '出たとき、自分の墓地とエネルギー墓地のカードをすべて手札に加える。',
    async onSummon(api, me) {
      const p = api.player(me);
      const n = p.grave.length + p.egrave.length;
      const g1 = p.grave.splice(0), g2 = p.egrave.splice(0);
      p.hand.push(...g1, ...g2);
      api.mark(me, g1, 'grave');
      api.mark(me, g2, 'egrave');
      api.log(`${p.name}は墓地のカード${n}枚をすべて手札に加えた`);
    },
  },

  zombie: {
    id: 'zombie', name: 'ゾンビ', tribe: 'マイクラ', type: 'monster', cost: 1, power: 1000,
    img: 'cards/zombie.jpg', unbreakable: true,
    text: 'このモンスターは破壊されない（バトルで負けても、わなや効果でも破壊されない）。',
  },

  sarabada: {
    id: 'sarabada', name: 'サラバダやまちゃん', tribe: 'にんげん', type: 'monster', cost: 2, power: 1650,
    img: 'cards/sarabada.jpg', noEnergy: true,
    text: 'このモンスターにはエネルギーをつけられない。自分のターンのはじめに、相手は相手の山札の上から5枚を見て1枚を手札に加え、残りを墓地に置く。',
    async turnStart(api, me) {
      const oi = 1 - me, o = api.player(oi);
      if (!o.deck.length) return;
      const top = o.deck.splice(0, Math.min(5, o.deck.length));
      api.log(`「サラバダやまちゃん」の効果：${o.name}は山札の上から${top.length}枚を見る`);
      const uid = await api.ask(oi, {
        title: 'サラバダやまちゃんの効果',
        text: '山札の上から見たカードです。1枚を手札に加え、残りは墓地に置きます。',
        options: top.map(c => ({ card: c, label: api.name(c), value: c.uid })),
        ai: () => [...top].sort((a, b) => api.cardValue(b) - api.cardValue(a))[0].uid,
      });
      for (const c of top) { if (c.uid === uid) o.hand.push(c); else api.toGrave(oi, [c]); }
      api.mark(oi, top.filter(c => c.uid === uid), 'deck');
      api.log(`${o.name}は1枚を手札に加え、${top.length - 1}枚を墓地に置いた`);
    },
  },

  ilovld: {
    id: 'ilovld', name: 'I♡LD', type: 'trap', cost: 0,
    img: 'cards/ilovld.jpg', trigger: 'ownLifeBroken',
    text: '自分のライフガードが破壊されたとき発動できる。破壊されたライフガードのカード1枚を、L.D（コストなしですぐ使える）にする。',
  },

  potion: {
    id: 'potion', name: '再生のポーション', type: 'magic', cost: 2,
    img: 'cards/potion.jpg',
    text: '自分の墓地からモンスターを1体えらんで、コストを払わずに出す。このカードは使ったあと墓地に行かず、手札にもどる。',
    canCast(api, me) {
      const p = api.player(me);
      if (!p.grave.some(c => api.def(c).type === 'monster')) return '墓地にモンスターがいません';
      if (!p.mons.includes(null)) return 'モンスターゾーンがいっぱいです';
      return true;
    },
    async onCast(api, me) {
      const p = api.player(me);
      const mons = p.grave.filter(c => api.def(c).type === 'monster');
      const uid = await api.ask(me, {
        title: '再生のポーション',
        text: '墓地から出すモンスターをえらんでください。',
        options: mons.map(c => ({ card: c, label: `${api.name(c)}（パワー${api.fmt(api.def(c).power)}）`, value: c.uid })),
        ai: () => [...mons].sort((a, b) => api.cardValue(b) - api.cardValue(a))[0].uid,
      });
      const c = p.grave.splice(p.grave.findIndex(x => x.uid === uid), 1)[0];
      await api.summon(me, c);
      return 'hand';
    },
    aiUse: (api, me) => api.player(me).grave.some(c => api.def(c).type === 'monster' && api.def(c).power >= 1500),
  },

  wanada: {
    id: 'wanada', name: 'ワナダアイスキジュニア', tribe: 'ゴースト', type: 'monster', cost: 1, power: 1000,
    img: 'cards/wanada.jpg',
    text: '出たとき、自分の山札からわなを1枚えらんで、わな置き場にふせる（わながもう置いてあるときは何もしない）。',
    async onSummon(api, me) {
      const p = api.player(me);
      if (p.trap) { api.log('わなはもう置いてあるので、効果は空振り'); return; }
      const traps = p.deck.filter(c => api.def(c).type === 'trap');
      if (!traps.length) { api.log('山札にわながないので、効果は空振り'); return; }
      const kinds = [...new Map(traps.map(c => [c.id, c])).values()];
      const uid = await api.ask(me, {
        title: 'ワナダアイスキジュニアの効果',
        text: '山札からふせるわなをえらんでください。',
        options: kinds.map(c => ({ card: c, label: api.name(c), value: c.uid })),
        ai: () => kinds[0].uid,
      });
      const c = p.deck.splice(p.deck.findIndex(x => x.uid === uid), 1)[0];
      p.trap = { c, faceUp: false };
      api.shuffle(p.deck);
      api.log(`${p.name}は山札からわなを1枚ふせた（山札はシャッフル）`);
    },
  },

  mattekure: {
    id: 'mattekure', name: 'マッテクレー', tribe: 'ゴースト', type: 'monster', cost: 2, power: 1200,
    img: 'cards/mattekure.jpg', ld: true,
    text: 'L.D（ライフガードが破壊されて手札に入るとき、コストを払わずに使える）。このモンスターが出たターン、自分はダイレクトアタックを受けない。',
    async onSummon(api, me) {
      api.player(me).noDirect = api.turn();
      api.log(`このターン、${api.player(me).name}はダイレクトアタックを受けない`);
    },
  },

  cake: {
    id: 'cake', name: 'たんじょう日ケーキ', type: 'magic', cost: 2,
    img: 'cards/cake.jpg',
    text: '自分の手札のコスト4以下のモンスター1体を、自分のバトルゾーンにいるモンスターの上に重ねて出す。下のモンスターの能力は使えなくなり、上のモンスターが破壊されたとき、いっしょに墓地に置かれる。',
    canCast(api, me) {
      const p = api.player(me);
      if (!p.mons.some(Boolean)) return '重ねる自分のモンスターがいません';
      if (!p.hand.some(c => api.def(c).type === 'monster' && api.cost(me, c) <= 4)) return '手札にコスト4以下のモンスターがいません';
      return true;
    },
    async onCast(api, me) {
      const p = api.player(me);
      const hand = p.hand.filter(c => api.def(c).type === 'monster' && api.cost(me, c) <= 4);
      const uid = await api.ask(me, {
        title: 'たんじょう日ケーキ',
        text: '重ねて出す手札のモンスターをえらんでください。',
        options: hand.map(c => ({ card: c, label: `${api.name(c)}（コスト${api.cost(me, c)}）`, value: c.uid })),
        ai: () => [...hand].sort((a, b) => (api.def(b).power || 0) - (api.def(a).power || 0))[0].uid,
      });
      const slots = p.mons.map((m, i) => (m ? i : -1)).filter(i => i >= 0);
      const s = await api.ask(me, {
        title: 'どのモンスターの上に重ねる？',
        options: slots.map(i => ({ card: p.mons[i].c, label: `${api.name(p.mons[i].c)}（パワー${api.fmt(api.power(me, i))}）`, value: i })),
        ai: () => [...slots].sort((a, b) => api.power(me, a) - api.power(me, b))[0],
      });
      const c = p.hand.splice(p.hand.findIndex(x => x.uid === uid), 1)[0];
      await api.summon(me, c, { stackOn: s });
    },
    aiUse(api, me) {
      const p = api.player(me);
      const best = Math.max(0, ...p.hand.filter(c => api.def(c).type === 'monster' && api.cost(me, c) <= 4).map(c => api.def(c).power || 0));
      const weakest = Math.min(...p.mons.map((m, i) => (m ? api.power(me, i) : Infinity)));
      return best > weakest + 300;
    },
  },

  naga: {
    id: 'naga', name: 'SP会員ナーガ', tribe: 'にんげん', type: 'monster', cost: 1, power: 1000,
    img: 'cards/naga.jpg',
    text: 'パワーは1000＋（自分の手札と墓地（エネルギー墓地もふくむ）の枚数）×100。出たとき、カードを3枚引く。',
    powerFn: (api, me) => 1000 + 100 * (api.player(me).hand.length + api.graveCount(me)),
    async onSummon(api, me) {
      const n = api.draw(me, 3);
      api.log(`${api.player(me).name}はカードを${n}枚引いた`);
    },
  },

  morinokuma: {
    id: 'morinokuma', name: 'モリのくま', tribe: 'キチガイ', type: 'monster', cost: 1, power: 1000,
    img: 'cards/morinokuma.jpg', silence: true,
    text: 'このモンスターがバトルゾーンにいるあいだ、相手のモンスターのカードに書いてある効果はすべて消える。',
  },

  buta: {
    id: 'buta', name: 'ブタ', tribe: 'マイクラ', type: 'monster', cost: 1, power: 1200,
    img: 'cards/buta.jpg',
    text: '出たとき、このモンスターを破壊してもよい。そうしたら、自分の墓地からコスト2以下のモンスターを1体、コストを払わずに出す。',
    async onSummon(api, me, slot) {
      const p = api.player(me), self = p.mons[slot].c;
      const pick = () => p.grave.filter(c => api.def(c).type === 'monster' && api.def(c).cost <= 2 && c !== self);
      if (!pick().length) return;
      const yes = await api.ask(me, {
        title: 'ブタの効果',
        text: 'ブタを破壊して、墓地からコスト2以下のモンスターを出しますか？',
        options: [{ label: '破壊して出す', value: true, primary: true }, { label: 'そのまま', value: false }],
        ai: () => pick().some(c => api.cardValue(c) > api.cardValue(self)),
      });
      if (!yes || !api.destroy(me, slot)) return;
      const mons = pick();
      const uid = await api.ask(me, {
        title: 'ブタの効果',
        text: '墓地から出すモンスターをえらんでください。',
        options: mons.map(c => ({ card: c, label: api.name(c), value: c.uid })),
        ai: () => [...mons].sort((a, b) => api.cardValue(b) - api.cardValue(a))[0].uid,
      });
      const c = p.grave.splice(p.grave.findIndex(x => x.uid === uid), 1)[0];
      await api.summon(me, c);
    },
  },

  akira: {
    id: 'akira', name: '会員アキラ', tribe: 'にんげん', type: 'monster', cost: 4, power: 1000,
    img: 'cards/akira.jpg',
    text: 'パワーは、自分の手札1枚につき＋300。',
    powerFn: (api, me) => 1000 + 300 * api.player(me).hand.length,
  },

  shoki: {
    id: 'shoki', name: 'しょきフリョー', type: 'trap', cost: 0,
    img: 'cards/shoki.jpg', trigger: 'opponentSummon',
    text: '相手がモンスターを出したとき発動できる。そのモンスターを破壊する（そのモンスターの「出たとき」の効果は使えない）。',
    async onTrap(api, me, ctx) {
      api.log('わな「しょきフリョー」発動！');
      api.toast('わな「しょきフリョー」発動！', 'trap');
      api.trapToGrave(me);
      await api.sleep(600);
      api.destroy(ctx.summoner, ctx.slot);
    },
    aiTrap: (api, me, ctx) => api.breakable(ctx.summoner, ctx.slot), // ゾンビなど、破壊できない相手には使わない
  },

  manhole: {
    id: 'manhole', name: 'まンほオる', type: 'trap', cost: 0,
    img: 'cards/manhole.jpg', trigger: 'opponentAttack',
    text: '相手のモンスターが攻撃するとき発動できる。そのモンスターを破壊する。（使ったあと、自分のモンスターを1体破壊すれば、このわなを墓地に送らず場に残してもよい）',
    async onTrap(api, me, ctx) {
      const p = api.player(me);
      p.trap.faceUp = true;
      api.log('わな「まンほオる」発動！');
      api.toast('わな「まンほオる」発動！', 'trap');
      await api.sleep(500);
      api.destroy(ctx.attacker, ctx.slot);
      api.render();
      const own = p.mons.map((m, i) => (m && api.breakable(me, i) ? i : -1)).filter(i => i >= 0);
      let keep = -1;
      if (own.length) {
        keep = await api.ask(me, {
          title: 'わなを残す？',
          text: '自分のモンスターを1体破壊すると、「まンほオる」を場に残せます。',
          options: [
            ...own.map(i => ({ card: p.mons[i].c, label: `「${api.name(p.mons[i].c)}」を破壊して残す`, value: i })),
            { label: '残さない（墓地へ）', value: -1 },
          ],
          ai: () => {
            const spare = own.filter(i => !p.mons[i].energy.length).sort((a, b) => api.power(me, a) - api.power(me, b));
            return spare.length && own.length >= 2 ? spare[0] : -1;
          },
        });
      }
      if (keep >= 0) {
        api.destroy(me, keep);
        api.log('「まンほオる」は場に残った');
      } else {
        api.trapToGrave(me);
      }
      return { stop: !api.player(ctx.attacker).mons[ctx.slot] };
    },
    aiTrap: (api, me, ctx) => api.breakable(ctx.attacker, ctx.slot), // ゾンビなど、破壊できない相手には使わない
  },
};

/* デッキ（エネルギー10枚＋通常カード15枚）
 * デッキ1・2は写真のカードそのまま（ウィザースケルトンは絵ちがいの2枚） */
const DECKS = [
  {
    name: 'デッキ1', key: '写真1のカード',
    cards: [['energy', 10], ['wither', 1], ['witherskel', 2], ['inuno', 1], ['obakuso', 1], ['hikakin', 1], ['hikakin2', 1],
      ['kaicho', 1], ['robo', 1], ['spkaicho', 1], ['gucha', 1], ['arubaito', 1], ['deadattacker', 1], ['saiaku', 1], ['akizawa', 1]],
  },
  {
    name: 'デッキ2', key: '写真2のカード',
    cards: [['energy', 10], ['apanman', 1], ['bochi', 1], ['zombie', 1], ['sarabada', 1], ['ilovld', 1], ['potion', 1], ['wanada', 1],
      ['mattekure', 1], ['cake', 1], ['naga', 1], ['morinokuma', 1], ['buta', 1], ['akira', 1], ['shoki', 1], ['manhole', 1]],
  },
  /* ───── デモ用デッキ（いまのカードを組み合わせたもの。同じカードは2枚まで） ───── */
  {
    name: 'マイクラ軍団', key: 'ウィザースケルトンで墓地をためてウィザー',
    cards: [['energy', 10], ['witherskel', 2], ['zombie', 2], ['buta', 2], ['hikakin', 2], ['wither', 1],
      ['potion', 2], ['manhole', 2], ['shoki', 1], ['deadattacker', 1]],
  },
  {
    name: 'ゴーストのいたずら', key: 'ゴーストとわなで相手をじゃまする',
    cards: [['energy', 10], ['obakuso', 2], ['bochi', 2], ['wanada', 2], ['mattekure', 2], ['deadattacker', 2],
      ['saiaku', 2], ['manhole', 2], ['ilovld', 1]],
  },
  {
    name: 'にんげん会議', key: '手札とエネルギーをふやして重ねる',
    cards: [['energy', 10], ['arubaito', 2], ['kaicho', 2], ['spkaicho', 1], ['naga', 2], ['akira', 2],
      ['sarabada', 2], ['robo', 1], ['cake', 2], ['akizawa', 1]],
  },
  {
    name: 'エネルギー全開', key: '会長ロボとSP会長に一気につける',
    cards: [['energy', 10], ['robo', 2], ['spkaicho', 2], ['obakuso', 2], ['gucha', 2], ['deadattacker', 2],
      ['kaicho', 1], ['arubaito', 2], ['akizawa', 2]],
  },
  {
    name: '鉄壁と山札切れ', key: '守りながら相手の山札をけずる',
    cards: [['energy', 10], ['apanman', 2], ['zombie', 2], ['morinokuma', 2], ['mattekure', 2], ['sarabada', 2],
      ['manhole', 2], ['saiaku', 1], ['shoki', 2]],
  },
];
