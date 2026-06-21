# 六法読み上げアプリ

各種試験の条文をランダムに読み上げる聞き流し学習アプリ。**宅建（宅地建物取引士）MVP**。
Web版（PWA）と Android版（Capacitor + Media3 背景再生）の2系統。

- 監督：杉山隆郎（HANSODE）
- appId（Android）：`com.hansode.roppou`（既存3サイトとは別物）
- 公開先：新規 Cloudflare Pages（Web）／ Google Play（Android）。**NASには出さない。**

---

## 確定している設計判断

| 項目 | 決定 |
|------|------|
| プラットフォーム | Web=PWA、Android=Capacitor（TWAは背景再生が不安定なので不可） |
| 音声（2系統） | **Web版=Web Speech API**（前面のみ）／**Android版=事前生成MP3のネイティブ背景再生** |
| 背景再生コア | Media3(ExoPlayer)+MediaSessionService を**自作Capacitorプラグイン**で包む（第一候補 `@mediagrid/...` は背景自動送り非対応のため不採用） |
| 自動送り | ネイティブ所有。Webが作った**シャッフル済みキュー**をプレイリストで渡し、背景でもネイティブが進める（JSのonCompleteは背景で発火しないため不可） |
| MP3配置 | **アプリ同梱**（オフライン・背景で確実に鳴る） |
| プリレンダ範囲 | **宅建業法から**開始（全条）。他法令は順次 |
| 音声 | VOICEVOX「春日部つむぎ」(speaker=8)。クレジット「VOICEVOX：春日部つむぎ」必須 |
| データ | e-Gov法令API v2（JSON）。MVPは同梱JSON、「最新に更新」(再取得)は後回し |
| ランダム | 条単位・一様抽出。直近を避ける（キューのシャッフルで担保） |

---

## フォルダ構成

```
roppou-app/
├── public/                     ← Cloudflare Pages の出力ディレクトリ / Capacitor の webDir
│   ├── index.html
│   ├── styles.css
│   ├── playback.js             ← 再生バックエンド抽象（native / web を切替）
│   ├── app.js                  ← 画面・データ・キュー生成
│   ├── manifest.json  sw.js    ← PWA
│   ├── icons/icon.svg
│   ├── data/
│   │   ├── presets.json        ← 試験プリセット（宅建ほか）
│   │   └── laws/327AC0000000176.json   ← 宅建業法（サンプル条文／要 e-Gov 差し替え）
│   └── audio/{LawId}/{id}.mp3  ← VOICEVOXバッチで生成（MVPでは未生成。Android背景再生で使用）
├── android-native/             ← npx cap add android 後に android/ へドロップインする参照ファイル
│   ├── PlaybackService.kt
│   ├── RoppouPlaybackPlugin.kt
│   ├── MainActivity.java
│   ├── AndroidManifest.additions.xml
│   └── build.gradle.additions
├── tools/
│   ├── voicevox-batch.mjs      ← 条文JSON → VOICEVOX → MP3
│   └── dev-server.mjs          ← 開発用 静的サーバ
├── capacitor.config.json
└── package.json
```

---

## 0. 六法データの取得（e-Gov API v2 → 3形式で出力）

授業用・アプリ用に、**24法令・計約8,300条**を条ごとにバラして出力する。

```bash
node tools/fetch-laws.mjs              # 全24法令
node tools/fetch-laws.mjs 民法 刑法    # 名前で絞り込み
```

出力（3形式同時）:
- `public/data/laws/{LawId}.json` … アプリ用（meta + 条配列）。`六法＋会社法` プリセットがこれを読む。
- `export/markdown/{法令名}.md` … 授業用の読めるMarkdown（編/章/節の見出し＋条・項・号）。
- `export/articles/{法令名}/{id}.md` … 条ごとに1ファイル（完全バラし）。

収録法令（`tools/fetch-laws.mjs` の TARGETS）:
- **六法＋会社法**：日本国憲法・民法・商法・会社法・刑法・民事訴訟法・刑事訴訟法
- **行政法系**：行政手続法・行政不服審査法・行政事件訴訟法・国家賠償法・地方自治法
- **民事手続・倒産**：民事執行法・民事保全法・破産法
- **労働法**：労働基準法・労働組合法・労働契約法
- **登記・主要特別法**：不動産登記法・商業登記法・借地借家法・消費者契約法・製造物責任法・法の適用に関する通則法

法令を増やすときは、名前で LawId を引いて TARGETS に足す（`/api/2/laws?law_title=法令名` で確認可）。
法令本文は著作権の対象外（著作権法13条）。出典「e-Gov法令検索」を各ファイルに明記済み。

※ 項番号は e-Gov データ内 `ParagraphNum` のグリフが法令間で不統一（空のものがある）なため、
段落の `Num` 属性から `２`『３`…を生成して統一している。

---

## 1. Web版（PWA）をローカルで動かす

```bash
node tools/dev-server.mjs          # http://localhost:4178
```

ブラウザで開く → 「宅建」→「はじめる」。Web Speech APIで読み上げ。`次へ`で次の条。
※ 背景・画面オフでは Web Speech は止まる（Web版は前面専用）。背景再生はAndroid版で。

### Cloudflare Pages へ公開（Web版）→ `legal.kikaku-note.com`

新規 Pages プロジェクト（コンテンツは独立）に、kikaku-note.com ゾーンのサブドメインを当てる。

1. ログイン（ブラウザOAuth・本人操作）:
   ```bash
   npx wrangler login
   ```
2. デプロイ（`public/` を直アップロード。初回はプロジェクト名 `legal-kikaku-note` を作成）:
   ```bash
   npm run deploy
   # = npx wrangler pages deploy public --project-name=legal-kikaku-note
   ```
   → まず `https://legal-kikaku-note.pages.dev` で公開される。
3. カスタムドメインを当てる（どちらか）:
   - ダッシュボード：Workers & Pages → legal-kikaku-note → Custom domains → `legal.kikaku-note.com` を追加
     （kikaku-note.com が Cloudflare DNS 管理下なら CNAME は自動作成）
   - CLI：`npx wrangler pages domain add legal.kikaku-note.com --project-name=legal-kikaku-note`

- Build command：なし（静的）／ Output directory：`public`
- 更新デプロイは `npm run deploy` を再実行するだけ。
- 公開時、アプリ内クレジット画面に「VOICEVOX：春日部つむぎ」「出典：e-Gov法令検索」を常設済み。
- 注：六法データJSONは `/data/` で network-first キャッシュ。データを差し替えて再デプロイすれば反映される。

---

## 2. MP3をプリレンダ（Android背景再生の前提）

VOICEVOXエンジンを起動し、ffmpeg を PATH に通してから：

```bash
node tools/voicevox-batch.mjs --law 327AC0000000176          # 宅建業法を生成
# 既存も作り直す: --force ／ 話者変更: SPEAKER=8（既定=春日部つむぎ）
```

`public/audio/327AC0000000176/{articleId}.mp3` が生成される。これが `cap copy` で
android assets に同梱され、ExoPlayer が `asset:///public/audio/...` で再生する。

---

## 3. Android版をビルド（Capacitor + Media3）

> Android Studio / SDK が要る作業。詰まったら debugger（再現・ログ確認）。

```bash
npm install
npx cap add android        # android/ を生成
npx cap copy               # public/ を android assets へ
```

### 3-1. ネイティブ・ドロップイン

`android-native/` の各ファイルを android プロジェクトへ反映する：

| ファイル | 反映先 |
|---------|--------|
| `PlaybackService.kt` | `android/app/src/main/java/com/hansode/roppou/PlaybackService.kt` |
| `RoppouPlaybackPlugin.kt` | 同上ディレクトリへコピー |
| `MainActivity.java` | 生成済み `MainActivity` をこの内容で置換（`registerPlugin`） |
| `AndroidManifest.additions.xml` | `android/app/src/main/AndroidManifest.xml` に権限とService宣言をマージ |
| `build.gradle.additions` | `android/app/build.gradle` の dependencies に Media3 を追記。compileSdk/targetSdk=34+ |

> Kotlinファイルを足すので、`android/app/build.gradle` に Kotlin プラグインが必要なら
> Android Studio の案内に従って `org.jetbrains.kotlin.android` を有効化する。

### 3-2. 動作確認の勘所（実機 / debugger）

- 再生中にホームへ戻る・画面オフ → **鳴り続けて自動で次の条へ**進むか（§2の本丸）。
- 通知に再生/停止/次/前が出るか。ロック画面に「法令名 第◯条 / VOICEVOX：春日部つむぎ」が出るか（§6＝常時クレジット）。
- 初回再生時に通知許可（POST_NOTIFICATIONS）を求めるか（Android 13+）。
- 着信・他アプリ再生で一時停止/ダッキングするか（オーディオフォーカス）。

### 3-3. `.aab` 生成 → Play 提出

1. Android Studio で署名鍵（keystore）を作成。
2. Build → Generate Signed Bundle（`.aab`）。
3. Google Play Console に新規アプリ登録 → 内部テスト → 製品版。
   - プライバシーポリシーURL（Web版でホスト可）、データセーフティ申告が必要。
4. `assetlinks.json` は**不要**（TWAの仕組み。Capacitorでは使わない）。

---

## ライセンス / クレジット

- **法令本文**：著作権の対象外（著作権法13条）。読み上げ・同梱・公開すべて可。出典「e-Gov法令検索」を表示。
- **合成音声**：VOICEVOX規約準拠。クレジット「VOICEVOX：春日部つむぎ」を必須表記（アプリ内＋メディア通知メタデータ）。
  声を増やす場合は各キャラのクレジット併記＋規約確認。※最終的なライセンス解釈は公式規約で要確認。

## いまの状態 / TODO

- [x] Web版PWA（宅建MVP・コアループ／キュー／クレジット／PWA）— 動作確認済み
- [x] Android背景再生のスキャフォールド（自作Media3プラグイン・Manifest・バッチ・手順）
- [ ] **宅建業法の条文を e-Gov API v2 で正式取得して差し替え**（現状は代表条文サンプル）
- [ ] VOICEVOXで宅建業法を全条プリレンダ（要・ローカル環境）
- [ ] `npx cap add android` → ネイティブ反映 → 実機で背景再生を確認（debugger）
- [ ] 署名 `.aab` → Play 内部テスト
- [ ] 他法令（民法ほか）の条文＆MP3を順次追加
```
