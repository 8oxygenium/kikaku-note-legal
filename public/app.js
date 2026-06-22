/* 六法読み上げアプリ — 宅建MVP
 *
 * アーキテクチャ（発注書＋Android化追加指示）:
 *  - ランダムは「先にシャッフル済みキューへ実体化」して Playback に渡す（追加指示§2）。
 *    自動送りはバックエンドが所有：native=Media3が背景でも進める／web=Web Speech前面のみ。
 *  - 音声二系統：Web版=Web Speech、Android版=MP3ネイティブ背景再生。
 *  - MP3命名規則は articleId 基準（audio/{lawId}/{id}.mp3）。
 *  - e-Gov再取得は後回し。同梱JSONで動く。
 */
'use strict';

const APP_VERSION = '0.1.0';
const QUEUE_CHUNK = 40;   // 一度にキューへ積む条数
const DATA_BASE = './data';

const state = {
  presets: [],
  currentPreset: null,    // {id,name,laws:[...]}
  laws: {},               // lawId -> {meta, articles}
  pool: [],               // [{id,lawId,lawName,articleNo,caption,text,mp3Uri}]
  byId: new Map(),        // id -> item（表示同期用）
  rate: 1.2,
  playing: false,
  started: false,
  autoAdvance: true,      // 自動で次へ（初期ON・睡眠学習向け）
  loop: false,            // 1条をループ
  currentScreen: 'home',
};

/* ---------- 画面遷移 ---------- */
const screens = ['home', 'player', 'filter', 'info'];

// 画面の見た目だけを切り替える（副作用なし）
function show(name) {
  screens.forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.hidden = (s !== name);
  });
  state.currentScreen = name;
  document.getElementById('navBack').hidden = (name === 'home');
  window.scrollTo(0, 0);
}

/* ---------- 履歴ルーティング（＜ボタンもブラウザ戻るも効くように） ---------- */
function hashScreen() {
  const h = location.hash.replace('#', '');
  return ['player', 'filter', 'info'].includes(h) ? h : 'home';
}

// ハッシュ変化（＜ボタン/ブラウザ戻る/進む）に応じて画面と副作用を適用
function applyScreen(name) {
  // プリセット未起動でplayer/filterへ来たらホームに矯正
  if ((name === 'player' || name === 'filter') && !state.currentPreset) name = 'home';
  if (name === 'home') { Playback.stop(); state.currentPreset = null; }
  if (name === 'info') renderInfo();
  if (name === 'filter') renderFilter();
  show(name);
}

// 前進ナビ（ホーム→player、→info、→filter）。ハッシュを積んで履歴を作る。
function goTo(name) {
  const target = name === 'home' ? '' : name;
  if (location.hash.replace('#', '') === target) applyScreen(name);
  else location.hash = target; // hashchange→applyScreen
}

window.addEventListener('hashchange', () => applyScreen(hashScreen()));

/* ---------- データ読み込み ---------- */
async function loadPresets() {
  const res = await fetch(`${DATA_BASE}/presets.json`);
  if (!res.ok) throw new Error('presets.json 取得失敗');
  state.presets = (await res.json()).presets || [];
}

async function loadLaw(lawId) {
  if (state.laws[lawId]) return state.laws[lawId];
  try {
    const res = await fetch(`${DATA_BASE}/laws/${lawId}.json`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.laws[lawId] = data;
    return data;
  } catch (e) {
    console.warn(`[law] ${lawId} 未配置のためスキップ:`, e.message);
    return null;
  }
}

function mp3UriFor(lawId, id) {
  // 命名規則: articleId 基準。native はこの相対パスを asset:// に解決する。
  return `./audio/${lawId}/${id}.mp3`;
}

/* 有効な法令の全条を1プールにフラット化（D: 条単位） */
async function buildPool() {
  const enabled = state.currentPreset.laws.filter(l => l.enabled);
  const pool = [];
  state.byId.clear();
  for (const law of enabled) {
    const data = await loadLaw(law.lawId);
    if (!data || !data.articles) continue;
    for (const art of data.articles) {
      const item = {
        id: art.id,
        lawId: data.meta.lawId,
        lawName: data.meta.lawName,
        articleNo: art.articleNo,
        caption: art.caption || '',
        text: art.text,
        mp3Uri: mp3UriFor(data.meta.lawId, art.id),
      };
      pool.push(item);
      state.byId.set(item.id, item);
    }
  }
  state.pool = pool;
  return pool;
}

/* ---------- シャッフル済みキュー生成（直近重複を避ける） ---------- */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue(n, avoidFirstId) {
  const pool = state.pool;
  if (pool.length === 0) return [];
  const out = [];
  while (out.length < n) {
    let block = shuffle(pool);
    // 継ぎ目で同じ条が連続しないように
    if (out.length > 0 && block[0].id === out[out.length - 1].id && block.length > 1) {
      [block[0], block[1]] = [block[1], block[0]];
    }
    if (avoidFirstId && out.length === 0 && block[0].id === avoidFirstId && block.length > 1) {
      [block[0], block[1]] = [block[1], block[0]];
    }
    out.push(...block);
  }
  return out.slice(0, n);
}

/* ---------- 表示 ---------- */
function renderItem(item) {
  document.getElementById('lawName').textContent = item ? item.lawName : '—';
  document.getElementById('articleNo').textContent = item ? item.articleNo : '—';
  document.getElementById('articleCaption').textContent = item ? item.caption : '';
  document.getElementById('articleText').textContent =
    item ? item.text : '対象法令が選ばれていません。';
}

function updatePlayBtn() {
  document.getElementById('btnPlay').textContent = state.playing ? '■' : '▶';
}

function setVoiceStatus() {
  const el = document.getElementById('voiceStatus');
  el.textContent = Playback.isNative
    ? '音声：MP3（バックグラウンド再生対応）'
    : '音声：端末の音声合成（Web Speech・画面オン時のみ）';
}

/* ---------- Playback コールバック ---------- */
function onTrackChanged(ev) {
  const item = state.byId.get(ev.id);
  if (item) renderItem(item);
}
function onQueueLow() {
  if (!state.started || state.pool.length === 0) return;
  Playback.append(buildQueue(QUEUE_CHUNK));
}
function onStateChanged(ev) {
  state.playing = !!ev.playing;
  updatePlayBtn();
}

/* ---------- ホーム ---------- */
function renderHome() {
  const ul = document.getElementById('presetList');
  ul.innerHTML = '';
  state.presets.forEach(p => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'preset';
    btn.innerHTML = `<span>${p.name}</span>` +
      (p.ready ? `<span class="badge">はじめる</span>` : `<span class="badge soon">準備中</span>`);
    btn.disabled = !p.ready;
    btn.addEventListener('click', () => startPreset(p));
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function startPreset(preset) {
  state.currentPreset = {
    id: preset.id,
    name: preset.name,
    laws: preset.laws.map(l => ({ ...l })),
  };
  await buildPool();
  setVoiceStatus();
  await startQueue();
  goTo('player');
}

async function startQueue() {
  if (state.pool.length === 0) {
    state.started = false;
    renderItem(null);
    return;
  }
  state.started = true;
  const queue = buildQueue(QUEUE_CHUNK);
  renderItem(queue[0]);
  await Playback.setQueue(queue);
}

/* ---------- フィルタ ---------- */
function renderFilter() {
  const ul = document.getElementById('filterList');
  ul.innerHTML = '';
  if (!state.currentPreset) return;
  state.currentPreset.laws.forEach(law => {
    const li = document.createElement('li');
    li.className = 'filter-item' + (law.pending ? ' pending' : '');
    const label = document.createElement('div');
    label.innerHTML = `<span>${law.name}</span>` +
      (law.pending ? `<span class="law-sub">条文データ準備中</span>` : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!law.enabled;
    cb.disabled = !!law.pending;
    cb.addEventListener('change', () => { law.enabled = cb.checked; });
    li.appendChild(label);
    li.appendChild(cb);
    ul.appendChild(li);
  });
}

/* ---------- 情報 ---------- */
function renderInfo() {
  document.getElementById('appVersion').textContent = APP_VERSION;
  const law = state.laws['327AC0000000176'];
  const meta = law && law.meta;
  document.getElementById('dataMeta').textContent = meta
    ? `データ取得日：${meta.fetchedAt}／法令バージョン：${meta.revision}`
    : 'データ取得日：同梱サンプル';
}

/* ---------- イベント結線 ---------- */
function wire() {
  document.getElementById('navInfo').addEventListener('click', () => goTo('info'));
  // ＜ボタンはブラウザ履歴を1つ戻す（ブラウザの戻るボタンと同じ挙動に統一）
  document.getElementById('navBack').addEventListener('click', () => history.back());

  document.getElementById('btnNext').addEventListener('click', () => Playback.next());
  document.getElementById('btnPrev').addEventListener('click', () => Playback.prev());
  document.getElementById('btnPlay').addEventListener('click', () => Playback.playPause());

  document.getElementById('autoAdvance').addEventListener('change', e => {
    state.autoAdvance = e.target.checked;
    Playback.setAutoAdvance(state.autoAdvance);
  });

  document.getElementById('btnLoop').addEventListener('click', () => {
    state.loop = !state.loop;
    Playback.setLoop(state.loop);
    document.getElementById('btnLoop').classList.toggle('is-active', state.loop);
  });

  document.getElementById('speedGroup').addEventListener('click', e => {
    const b = e.target.closest('.speed');
    if (!b) return;
    state.rate = parseFloat(b.dataset.rate);
    Playback.setRate(state.rate);
    document.querySelectorAll('.speed').forEach(s => s.classList.toggle('is-active', s === b));
  });

  document.getElementById('openFilter').addEventListener('click', () => goTo('filter'));
  document.getElementById('filterDone').addEventListener('click', async () => {
    Playback.stop();
    await buildPool();
    setVoiceStatus();
    await startQueue();
    if (state.pool.length === 0) {
      document.getElementById('articleText').textContent =
        '対象法令が選ばれていません。フィルタで法令をONにしてください。';
    }
    history.back(); // フィルタは player から開くので、戻ると player に復帰
  });
}

/* ---------- 起動 ---------- */
async function init() {
  wire();
  await Playback.init({ onTrackChanged, onQueueLow, onStateChanged });
  // 既定値を再生層へ同期（自動で次へ=ON、ループ=OFF）。UIの初期状態と一致させる。
  document.getElementById('autoAdvance').checked = state.autoAdvance;
  Playback.setAutoAdvance(state.autoAdvance);
  Playback.setLoop(state.loop);
  document.getElementById('btnLoop').classList.toggle('is-active', state.loop);
  try {
    await loadPresets();
    renderHome();
  } catch (e) {
    console.error(e);
    document.getElementById('presetList').innerHTML =
      '<li style="color:#f6c074">データの読み込みに失敗しました。</li>';
  }
  // 直リンク（#info 等）にも対応しつつ、基本はホームから
  history.replaceState({}, '', location.pathname + location.search);
  show('home');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW登録失敗', err));
  }
}

document.addEventListener('DOMContentLoaded', init);
