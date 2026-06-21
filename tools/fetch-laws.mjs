/*
 * fetch-laws.mjs — e-Gov 法令API v2 から六法＋会社法を取得し、条ごとにバラして3形式で出力。
 *
 *  出力（roppou-app 直下）:
 *   1) public/data/laws/{LawId}.json        … アプリ用（meta + articles[{id,articleNo,caption,text}]）
 *   2) export/markdown/{法令名}.md           … 授業用の読めるMarkdown（編/章/節の見出し＋条）
 *   3) export/articles/{法令名}/{id}.md       … 条ごとに1ファイル（完全バラし）
 *
 *  使い方:
 *    node tools/fetch-laws.mjs              # 七法すべて
 *    node tools/fetch-laws.mjs 民法 刑法    # 名前で絞り込み
 *
 *  データ層: e-Gov 法令API v2（JSON）。法令本文は著作権の対象外（著作権法13条）。出典=e-Gov法令検索。
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const API = 'https://laws.e-gov.go.jp/api/2';

const TARGETS = [
  // --- 六法＋会社法 ---
  { name: '日本国憲法', lawId: '321CONSTITUTION' },
  { name: '民法',       lawId: '129AC0000000089' },
  { name: '商法',       lawId: '132AC0000000048' },
  { name: '会社法',     lawId: '417AC0000000086' },
  { name: '刑法',       lawId: '140AC0000000045' },
  { name: '民事訴訟法', lawId: '408AC0000000109' },
  { name: '刑事訴訟法', lawId: '323AC0000000131' },
  // --- 行政法系 ---
  { name: '行政手続法',     lawId: '405AC0000000088' },
  { name: '行政不服審査法', lawId: '426AC0000000068' },
  { name: '行政事件訴訟法', lawId: '337AC0000000139' },
  { name: '国家賠償法',     lawId: '322AC0000000125' },
  { name: '地方自治法',     lawId: '322AC0000000067' },
  // --- 民事手続・倒産 ---
  { name: '民事執行法', lawId: '354AC0000000004' },
  { name: '民事保全法', lawId: '401AC0000000091' },
  { name: '破産法',     lawId: '416AC0000000075' },
  // --- 労働法 ---
  { name: '労働基準法', lawId: '322AC0000000049' },
  { name: '労働組合法', lawId: '324AC0000000174' },
  { name: '労働契約法', lawId: '419AC0000000128' },
  // --- 登記・主要特別法 ---
  { name: '不動産登記法',           lawId: '416AC0000000123' },
  { name: '商業登記法',             lawId: '338AC0000000125' },
  { name: '借地借家法',             lawId: '403AC0000000090' },
  { name: '消費者契約法',           lawId: '412AC0000000061' },
  { name: '製造物責任法',           lawId: '406AC0000000085' },
  { name: '法の適用に関する通則法', lawId: '418AC0000000078' },
  // --- 司法書士関連 ---
  { name: '供託法',     lawId: '132AC0000000015' },
  { name: '司法書士法', lawId: '325AC1000000197' },
];

const filter = process.argv.slice(2);
const targets = filter.length ? TARGETS.filter(t => filter.some(f => t.name.includes(f) || f === t.lawId)) : TARGETS;

/* ---------- ツリー走査ユーティリティ ---------- */
// 文字列リーフを連結。ルビの読み（Rt）は本文ではないので除外。
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.tag === 'Rt') return '';
  if (node.children) return node.children.map(textOf).join('');
  return '';
}

function pad(num) {
  // "94_2"(枝番) → "0094-2" / "1" → "0001"
  return String(num).split('_').map((p, i) => i === 0 ? p.padStart(4, '0') : p).join('-');
}
// 算用数字 → 全角（項番号の表示用）。1→""(無表記)、2→"２"、10→"１０"
function paraMarker(num) {
  if (!num || num < 2) return '';
  return String(num).replace(/[0-9]/g, d => '０１２３４５６７８９'[d]);
}

/* ---------- 条のパース ---------- */
function parseSub(node) {
  let title = '', sentence = '', subs = [];
  for (const c of node.children || []) {
    if (typeof c === 'string') continue;
    if (/Title$/.test(c.tag)) title = textOf(c);
    else if (/Sentence$/.test(c.tag)) sentence = textOf(c);
    else if (/^Subitem\d/.test(c.tag)) subs.push(parseSub(c));
  }
  return { title, sentence, subs };
}
function parseItem(node) {
  let title = '', sentence = '', subs = [];
  for (const c of node.children || []) {
    if (typeof c === 'string') continue;
    if (c.tag === 'ItemTitle') title = textOf(c);
    else if (c.tag === 'ItemSentence') sentence = textOf(c);
    else if (/^Subitem\d/.test(c.tag)) subs.push(parseSub(c));
  }
  return { title, sentence, subs };
}
function parseParagraph(node) {
  let sentence = '', items = [];
  for (const c of node.children || []) {
    if (typeof c === 'string') continue;
    if (c.tag === 'ParagraphSentence') sentence = textOf(c);
    else if (c.tag === 'Item') items.push(parseItem(c));
  }
  // 項番号は ParagraphNum のグリフに依存せず attr.Num から生成（法令間で表記が不統一なため）
  return { marker: paraMarker(Number(node.attr?.Num || 0)), sentence, items };
}
function parseArticle(node) {
  let caption = '', title = '', paragraphs = [];
  for (const c of node.children || []) {
    if (typeof c === 'string') continue;
    if (c.tag === 'ArticleCaption') caption = textOf(c);
    else if (c.tag === 'ArticleTitle') title = textOf(c);
    else if (c.tag === 'Paragraph') paragraphs.push(parseParagraph(c));
  }
  return { num: node.attr?.Num || '', title, caption, paragraphs };
}

/* ---------- 走査して見出し＋条の並びを得る ---------- */
const HEADING = { Part: 1, Chapter: 2, Section: 3, Subsection: 4, Division: 5 };
// 附則(SupplProvision)は条番号が第1条から振り直されるため、本則と衝突する。
// 附則ブロックには通し番号 supplId を振り、idを一意にする。
function walk(node, events, state, supplId) {
  if (!node || typeof node !== 'object') return;
  if (node.tag === 'Article') { events.push({ type: 'article', article: parseArticle(node), supplId }); return; }
  let childSuppl = supplId;
  if (node.tag === 'SupplProvision') {
    state.supplCount++;
    childSuppl = state.supplCount;
    const label = node.attr?.AmendLawNum ? `附則（${node.attr.AmendLawNum}）` : '附則';
    events.push({ type: 'heading', level: 1, text: label });
  } else if (HEADING[node.tag]) {
    const titleNode = (node.children || []).find(c => c && c.tag === `${node.tag}Title`);
    if (titleNode) events.push({ type: 'heading', level: HEADING[node.tag], text: textOf(titleNode) });
  }
  for (const c of node.children || []) if (c && typeof c === 'object') walk(c, events, state, childSuppl);
}
function artId(lawId, supplId, num) {
  return supplId ? `${lawId}_S${supplId}_${pad(num)}` : `${lawId}_${pad(num)}`;
}

/* ---------- 整形 ---------- */
function itemPlain(it) {
  let s = `${it.title}　${it.sentence}`.trim();
  for (const sub of it.subs) s += ` ${sub.title}　${sub.sentence}`.replace(/\s+$/, '');
  return s.trim();
}
// アプリ/TTS用の一本テキスト
function articlePlain(a) {
  const parts = [];
  a.paragraphs.forEach((p, i) => {
    let line = (i > 0 && p.marker) ? `${p.marker}　${p.sentence}` : p.sentence;
    if (line.trim()) parts.push(line.trim());
    for (const it of p.items) parts.push(itemPlain(it));
  });
  return parts.join('　');
}
// 条ブロックのMarkdown
function articleMd(a) {
  const head = `**${a.title}**${a.caption ? `　${a.caption}` : ''}`;
  const lines = [head, ''];
  a.paragraphs.forEach((p, i) => {
    lines.push((i > 0 && p.marker) ? `${p.marker}　${p.sentence}` : p.sentence);
    for (const it of p.items) {
      lines.push(`- ${it.title}　${it.sentence}`);
      for (const sub of it.subs) lines.push(`    - ${sub.title}　${sub.sentence}`);
    }
  });
  return lines.join('\n');
}

const today = new Date().toISOString().slice(0, 10);

async function processLaw(t) {
  const res = await fetch(`${API}/law_data/${t.lawId}`);
  if (!res.ok) throw new Error(`${t.name} ${t.lawId} -> ${res.status}`);
  const j = await res.json();
  const rev = j.revision_info || {};
  const info = j.law_info || {};
  const lawName = rev.law_title || t.name;
  const lawNo = info.law_num || '';

  const events = [];
  walk(j.law_full_text, events, { supplCount: 0 }, 0);
  const articleEvents = events.filter(e => e.type === 'article');

  // 1) アプリ用JSON
  const articles = articleEvents.map(e => {
    const a = e.article;
    return {
      id: artId(t.lawId, e.supplId, a.num),
      articleNo: a.title,
      caption: a.caption.replace(/^（|）$/g, ''),
      text: articlePlain(a),
      ...(e.supplId ? { suppl: true } : {}),
    };
  });
  const appJson = {
    meta: { lawId: t.lawId, lawName, lawNo, fetchedAt: today, revision: rev.updated || '', source: 'e-Gov法令検索' },
    articles,
  };
  const jsonDir = join(ROOT, 'public', 'data', 'laws');
  await mkdir(jsonDir, { recursive: true });
  await writeFile(join(jsonDir, `${t.lawId}.json`), JSON.stringify(appJson, null, 1));

  // 2) 読めるMarkdown（1法令1ファイル・見出しつき）
  const mdParts = [
    `# ${lawName}`, '',
    `${lawNo}`, '',
    `> 出典：e-Gov法令検索（https://laws.e-gov.go.jp）　取得日：${today}　LawId：${t.lawId}`,
    `> 法令本文は著作権の対象外（著作権法13条）。`, '',
    '---', '',
  ];
  for (const e of events) {
    if (e.type === 'heading') mdParts.push('', `${'#'.repeat(Math.min(e.level + 1, 6))} ${e.text}`, '');
    else mdParts.push(articleMd(e.article), '');
  }
  const mdDir = join(ROOT, 'export', 'markdown');
  await mkdir(mdDir, { recursive: true });
  await writeFile(join(mdDir, `${lawName}.md`), mdParts.join('\n'));

  // 3) 条ごとに1ファイル
  const artDir = join(ROOT, 'export', 'articles', lawName);
  await rm(artDir, { recursive: true, force: true });
  await mkdir(artDir, { recursive: true });
  for (const e of articleEvents) {
    const a = e.article;
    const id = artId(t.lawId, e.supplId, a.num);
    const body = [
      `# ${lawName}　${a.title}${e.supplId ? '（附則）' : ''}`,
      a.caption ? `（${a.caption.replace(/^（|）$/g, '')}）` : '',
      '',
      articleMd(a),
      '',
      `---`,
      `出典：e-Gov法令検索　${t.lawId}　取得日：${today}`,
    ].join('\n');
    await writeFile(join(artDir, `${id}.md`), body);
  }

  return { name: lawName, lawId: t.lawId, articles: articles.length };
}

(async () => {
  console.log(`対象: ${targets.map(t => t.name).join('・')}（取得日 ${today}）`);
  const results = [];
  for (const t of targets) {
    try {
      const r = await processLaw(t);
      results.push(r);
      console.log(`  ✓ ${r.name}（${r.articles}条）`);
    } catch (e) {
      console.error(`  ✗ ${t.name}: ${e.message}`);
    }
  }
  const total = results.reduce((s, r) => s + r.articles, 0);
  console.log(`完了: ${results.length}法令 / 計${total}条`);
  console.log('出力: public/data/laws/*.json ・ export/markdown/*.md ・ export/articles/*/*.md');
})();
