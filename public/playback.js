/* playback.js — 再生バックエンドの抽象化
 *
 * 追加指示§2の肝：ランダムは「先にシャッフル済みキューへ実体化」し、
 * バックエンド（ネイティブ）が自動送りを所有する。JSの onComplete に依存しない。
 *
 * 2系統（音声二系統で確定）:
 *  - native : Capacitor自作プラグイン RoppouPlayback（Media3 ExoPlayer + MediaSessionService）。
 *             setQueue したプレイリストをネイティブが背景でも自動送り。MP3のみ。
 *  - web    : Web Speech API。前面専用。キューはJSが保持し onend で自動送り（背景では止まる＝割り切り）。
 *
 * app.js からはこの統一インターフェースだけを使う：
 *   Playback.init({ onTrackChanged, onQueueLow, onStateChanged })
 *   Playback.setQueue(items) / append(items) / playPause() / next() / prev() / stop() / setRate(r)
 *   item = { id, lawId, lawName, articleNo, caption, text, mp3Uri }
 */
'use strict';

const Playback = (() => {
  const cap = window.Capacitor;
  const NativePlugin = cap && cap.Plugins ? cap.Plugins.RoppouPlayback : null;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() && NativePlugin);

  let cbs = { onTrackChanged: () => {}, onQueueLow: () => {}, onStateChanged: () => {} };

  /* ============ ネイティブ・バックエンド ============ */
  const nativeBackend = {
    mode: 'native',
    async init(callbacks) {
      cbs = { ...cbs, ...callbacks };
      // ネイティブ→Web イベント
      NativePlugin.addListener('trackChanged', (ev) => cbs.onTrackChanged(ev)); // {index, id}
      NativePlugin.addListener('queueLow', (ev) => cbs.onQueueLow(ev));         // {remaining}
      NativePlugin.addListener('stateChanged', (ev) => cbs.onStateChanged(ev)); // {playing}
    },
    async setQueue(items) { await NativePlugin.setQueue({ items }); },
    async append(items)   { await NativePlugin.append({ items }); },
    async playPause()     { await NativePlugin.playPause(); },
    async next()          { await NativePlugin.next(); },
    async prev()          { await NativePlugin.previous(); },
    async stop()          { await NativePlugin.stop(); },
    async setRate(r)      { await NativePlugin.setRate({ rate: r }); },
    // ネイティブは自動送りを所有。ループ/自動送りは将来 plugin の repeatMode に橋渡しする。
    async setAutoAdvance(v) { if (NativePlugin.setAutoAdvance) await NativePlugin.setAutoAdvance({ enabled: !!v }); },
    async setLoop(v)        { if (NativePlugin.setLoop) await NativePlugin.setLoop({ enabled: !!v }); },
  };

  /* ============ Web・バックエンド（Web Speech / 前面専用） ============ */
  const webBackend = (() => {
    let queue = [];
    let index = -1;
    let rate = 1.2;
    let playing = false;
    let autoAdvance = true; // 初期ON（睡眠学習向け）
    let loop = false;       // 1条をくり返す

    function synthAvailable() { return 'speechSynthesis' in window; }

    function pickJaVoice() {
      if (!synthAvailable()) return null;
      const vs = window.speechSynthesis.getVoices();
      return vs.find(v => v.lang === 'ja-JP') || vs.find(v => v.lang && v.lang.startsWith('ja')) || null;
    }

    function readText(it) {
      const cap = it.caption ? `（${it.caption}）` : '';
      return `${it.lawName}。${it.articleNo}${cap}。${it.text}`;
    }

    function speakCurrent() {
      const it = queue[index];
      if (!it) return;
      cbs.onTrackChanged({ index, id: it.id }); // 表示はTTS有無に関わらず更新
      if (!synthAvailable()) { cbs.onStateChanged({ playing: false }); return; }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(readText(it));
      u.lang = 'ja-JP';
      u.rate = rate;
      const v = pickJaVoice();
      if (v) u.voice = v;
      u.onend = () => {
        if (!playing) return;
        if (loop) speakCurrent();            // 1条ループ：同じ条をくり返す
        else if (autoAdvance) advance();     // 自動で次へ
        else { playing = false; cbs.onStateChanged({ playing: false }); } // 1回読んで停止
      };
      u.onerror = () => { playing = false; cbs.onStateChanged({ playing: false }); };
      playing = true; cbs.onStateChanged({ playing: true });
      window.speechSynthesis.speak(u);
    }

    function advance() {
      if (index >= queue.length - 1) { // キュー末尾
        cbs.onQueueLow({ remaining: 0 });
        if (index >= queue.length - 1) { playing = false; cbs.onStateChanged({ playing: false }); return; }
      }
      index++;
      if (queue.length - 1 - index <= 5) cbs.onQueueLow({ remaining: queue.length - 1 - index });
      speakCurrent();
    }

    return {
      mode: 'web',
      async init(callbacks) {
        cbs = { ...cbs, ...callbacks };
        if (synthAvailable()) window.speechSynthesis.onvoiceschanged = () => {};
      },
      async setQueue(items) { queue = items.slice(); index = 0; speakCurrent(); },
      async append(items)   { queue = queue.concat(items); },
      async playPause() {
        if (!synthAvailable()) return;
        if (playing) { window.speechSynthesis.cancel(); playing = false; cbs.onStateChanged({ playing: false }); }
        else if (index >= 0) { speakCurrent(); }
      },
      async next() { if (index < queue.length - 1) { index++; speakCurrent(); } },
      async prev() { if (index > 0) { index--; speakCurrent(); } },
      async stop() { if (synthAvailable()) window.speechSynthesis.cancel(); playing = false; cbs.onStateChanged({ playing: false }); },
      async setRate(r) { rate = r; }, // 次の発話から反映
      async setAutoAdvance(v) { autoAdvance = !!v; },
      async setLoop(v) { loop = !!v; },
    };
  })();

  const backend = isNative ? nativeBackend : webBackend;

  return {
    mode: backend.mode,
    isNative,
    init: (callbacks) => backend.init(callbacks),
    setQueue: (items) => backend.setQueue(items),
    append: (items) => backend.append(items),
    playPause: () => backend.playPause(),
    next: () => backend.next(),
    prev: () => backend.prev(),
    stop: () => backend.stop(),
    setRate: (r) => backend.setRate(r),
    setAutoAdvance: (v) => backend.setAutoAdvance(v),
    setLoop: (v) => backend.setLoop(v),
  };
})();
