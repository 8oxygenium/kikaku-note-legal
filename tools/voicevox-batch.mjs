/*
 * voicevox-batch.mjs — 条文JSON → VOICEVOX(春日部つむぎ) → MP3 を一括生成。
 *
 * 背景再生はMP3のみ（追加指示§3）。背景で聴ける範囲をプリレンダする。
 * 出力: public/audio/{LawId}/{articleId}.mp3   ← 命名規則は articleId 基準。
 *
 * 前提（ローカル環境で実行。デプロイ前のオフライン作業）:
 *   - VOICEVOX エンジンを起動しておく（既定 http://localhost:50021）
 *   - ffmpeg を PATH に通す（WAV→MP3 変換・チャンク連結に使用）
 *   - Node 18+（global fetch を使用）
 *
 * 使い方:
 *   node tools/voicevox-batch.mjs --law 327AC0000000176          # 宅建業法を生成
 *   node tools/voicevox-batch.mjs --law 327AC0000000176 --force  # 既存も作り直す
 *   環境変数: VOICEVOX_HOST(既定 http://localhost:50021) / SPEAKER(既定 8=春日部つむぎ ノーマル)
 *
 * 冪等: 既に out.mp3 があればスキップ（--force で再生成）。
 */
import { readFile, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOST = process.env.VOICEVOX_HOST || 'http://localhost:50021';
const SPEAKER = Number(process.env.SPEAKER || 8); // 8 = 春日部つむぎ（ノーマル）
const MAX_CHARS = 200; // 1チャンクの目安文字数

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const LAW_ID = arg('--law');
const FORCE = args.includes('--force');

if (!LAW_ID) { console.error('使い方: node tools/voicevox-batch.mjs --law <LawId> [--force]'); process.exit(1); }

/* 句読点で MAX_CHARS 目安に分割 */
function splitText(text) {
  const parts = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if ((ch === '。' || ch === '、') && buf.length >= MAX_CHARS) { parts.push(buf); buf = ''; }
  }
  if (buf.trim()) parts.push(buf);
  return parts.length ? parts : [text];
}

async function vvFetch(path, opts) {
  const res = await fetch(`${HOST}${path}`, opts);
  if (!res.ok) throw new Error(`VOICEVOX ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res;
}

async function synthChunk(text, wavPath) {
  const q = await vvFetch(`/audio_query?text=${encodeURIComponent(text)}&speaker=${SPEAKER}`, { method: 'POST' });
  const query = await q.json();
  const s = await vvFetch(`/synthesis?speaker=${SPEAKER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  const buf = Buffer.from(await s.arrayBuffer());
  await writeFile(wavPath, buf);
}

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`)));
  });
}

async function ffmpegConcatToMp3(wavPaths, outMp3) {
  if (wavPaths.length === 1) {
    await run('ffmpeg', ['-y', '-i', wavPaths[0], '-b:a', '128k', outMp3]);
    return;
  }
  const listFile = join(os.tmpdir(), `vvlist_${Date.now()}_${Math.floor(performance.now())}.txt`);
  await writeFile(listFile, wavPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-b:a', '128k', outMp3]);
  } finally {
    await rm(listFile, { force: true });
  }
}

async function checkEngine() {
  try { await vvFetch('/version', { method: 'GET' }); }
  catch (e) {
    console.error(`VOICEVOX エンジンに接続できません（${HOST}）。エンジンを起動してください。`);
    console.error(`  詳細: ${e.message}`);
    process.exit(1);
  }
}

async function main() {
  await checkEngine();

  const lawPath = join(ROOT, 'public', 'data', 'laws', `${LAW_ID}.json`);
  if (!existsSync(lawPath)) { console.error(`条文JSONが見つかりません: ${lawPath}`); process.exit(1); }
  const law = JSON.parse(await readFile(lawPath, 'utf8'));
  const outDir = join(ROOT, 'public', 'audio', LAW_ID);
  await mkdir(outDir, { recursive: true });

  console.log(`法令: ${law.meta.lawName}（${law.articles.length}条）／話者: ${SPEAKER}／出力: ${outDir}`);

  let done = 0, skipped = 0;
  for (const art of law.articles) {
    const outMp3 = join(outDir, `${art.id}.mp3`);
    if (!FORCE && existsSync(outMp3)) { skipped++; continue; }

    const chunks = splitText(art.text);
    const tmp = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const wav = join(os.tmpdir(), `${art.id}_${i}.wav`);
        await synthChunk(chunks[i], wav);
        tmp.push(wav);
      }
      await ffmpegConcatToMp3(tmp, outMp3);
      done++;
      process.stdout.write(`  ✓ ${art.articleNo} (${art.id})\n`);
    } catch (e) {
      console.error(`  ✗ ${art.articleNo} 失敗: ${e.message}`);
    } finally {
      for (const w of tmp) await rm(w, { force: true });
    }
  }
  console.log(`完了: 生成 ${done} / スキップ ${skipped}`);
  console.log('※ public/audio/ は cap copy で android assets に同梱され、ExoPlayer が asset:/// で再生します。');
}

main().catch(e => { console.error(e); process.exit(1); });
