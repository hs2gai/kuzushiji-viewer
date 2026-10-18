// 画面（ビューア・資料の画面）で共通の DOM の補助関数。各画面のスクリプトより先に読み込む
const $ = (sel) => document.querySelector(sel);

// 要素を作る。props はプロパティ（textContent・className など）、children は子要素や文字列
function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ボタンのアイコン（線画の SVG。viewBox 24×24 の path を並べる）
const ICONS = {
  open: ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  correct: ['M6 16l6-12 6 12', 'M8 12h8', 'M16 20l2 2 4-4'],
  rename: ['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z', 'M15 5l4 4'],
  remove: ['M3 6h18', 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6', 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  save: ['M20 6L9 17l-5-5'],
  cancel: ['M18 6L6 18', 'M6 6l12 12'],
  left: ['M15 18l-6-6 6-6'],
  right: ['M9 18l6-6-6-6'],
  history: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  // レイヤーの切り替え（なし・翻刻・現代語訳）
  layerNone: ['M9.9 9.9a3 3 0 1 0 4.2 4.2', 'M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7', 'M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6', 'M2 2l20 20'],
  layerText: ['M18 3v18', 'M12 3v13', 'M6 3v18'],
  layerTranslate: ['M5 8l6 6', 'M4 14l6-6 2-3', 'M2 5h12', 'M7 2h1', 'M22 22l-5-10-5 10', 'M14 18h6'],
};
function icon(name) {
  const paths = ICONS[name].map((d) => `<path d="${d}"/>`).join('');
  return el('span', {
    className: 'btn-icon',
    innerHTML: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  });
}

// アイコンだけのボタンを作る。意味はツールチップ（title）と読み上げ用のラベルで伝える
function iconButton(tag, name, label, props = {}) {
  const node = el(tag, { className: 'icon-btn', title: label, ...props }, [icon(name)]);
  node.setAttribute('aria-label', label);
  return node;
}
// HTML に書いたボタンは data-icon でアイコンを付ける（中の文字はツールチップとラベルに回す）
for (const node of document.querySelectorAll('[data-icon]')) {
  const label = node.textContent.trim();
  node.classList.add('icon-btn');
  node.title = label;
  node.setAttribute('aria-label', label);
  node.replaceChildren(icon(node.dataset.icon));
}

// 画面上部のお知らせ（#status）。エラーは目立たせる。空文字で消す
function setStatus(msg, isError = false) {
  const status = $('#status');
  status.hidden = !msg;
  status.textContent = msg || '';
  status.classList.toggle('error', isError);
}
$('#status')?.addEventListener('click', () => setStatus(''));  // エラー表示はクリックで閉じる

// 表示の設定はブラウザに保存する（localStorage が使えない環境でも既定値で動かす）
function loadSetting(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function saveSetting(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* 保存できなくても動作させる */ }
}

// NDL 資料の書誌情報。IIIF マニフェストの metadata から取り出す（CORS が許可されているのでブラウザから直接取得できる）
const NDL_MANIFEST_URL = (pid) => `https://dl.ndl.go.jp/api/iiif/${pid}/manifest.json`;
const NDL_BIBLIO_FIELDS = [['Title', '書名'], ['Creator', '著者'], ['Publisher', '出版者'], ['Publication Date', '出版年']];

// マニフェストの metadata をすべて [項目, 値] で返す。複数の値は配列か '||' 区切りで入っているので ' / ' でつなぐ
async function requestNdlMetadata(pid) {
  const res = await fetch(NDL_MANIFEST_URL(pid));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()).metadata || []).map((m) => [String(m.label), [m.value].flat().join('||').split('||').join(' / ')]);
}

// 画面に出す書誌情報（書名・著者・出版者・出版年）を [表示名, 値] で返す
function biblioRows(metadata) {
  const values = Object.fromEntries(metadata);
  return NDL_BIBLIO_FIELDS.filter(([key]) => values[key]).map(([key, label]) => [label, values[key]]);
}

// 資料のメタデータ（資料の画面の一覧とビューアの書名表示で使う）。資料のデータとして保存し（backend.saveMetadata）、
// 保存済みなら NDL に問い合わせない。同じ資料を同時に求められたときは、問い合わせを 1 回にまとめる
const metadataRequests = new Map();
function bookMetadata(key) {
  if (!metadataRequests.has(key)) {
    metadataRequests.set(key, (async () => {
      const saved = await backend.getMetadata(key);
      if (saved) return saved;
      const metadata = await requestNdlMetadata(key.slice(4));
      await backend.saveMetadata(key, metadata);
      return metadata;
    })().finally(() => metadataRequests.delete(key)));
  }
  return metadataRequests.get(key);
}

// 外部（NDL の IIIF など）の縮小画像は、一度取得したらブラウザの Cache Storage に保存し、次からはそこから出す
// （同じ画像を何度も取りに行かない）。保存できない環境（Cache Storage が無い・容量不足など）では、そのつど取得する
const IMAGE_CACHE = 'thumbs-v1';
// 保存済みなら画像の URL（blob:）、無ければ null。取りには行かない
async function cachedImage(url) {
  if (!url.startsWith('http') || !globalThis.caches) return null;
  const cache = await caches.open(IMAGE_CACHE).catch(() => null);
  const res = cache && await cache.match(url);
  return res ? URL.createObjectURL(await res.blob()) : null;
}

async function cachedImageUrl(url) {
  if (!url.startsWith('http') || !globalThis.caches) return url;
  // 保存領域が開けない環境（プライベートブラウズの一部など）では、そのつど取得する（画像の URL をそのまま使う）
  const cache = await caches.open(IMAGE_CACHE).catch(() => null);
  if (!cache) return url;
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);  // 取得に失敗した画像は、枠を失敗の表示にする
    await cache.put(url, res.clone()).catch(() => {});  // 容量不足で保存できなくても、今回の表示には使える
  }
  return URL.createObjectURL(await res.blob());
}
