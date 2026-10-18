// 資料の画面（/）の「おすすめの古典籍」。カードは catalog.js。

// 何を読めばよいかわからない初めての人向けの案内なので、絵と文が同じコマにあって内容の想像がつくものを選ぶ。
// page は「開く」で最初に表示する見どころのコマ
const PRESETS = [
  { pid: '2541157', page: 4, title: '百人一首', note: '歌人の絵と和歌。知っている歌と見比べながら読めます' },
  { pid: '2557100', page: 6, title: '頭書増補訓蒙図彙 巻3', note: '絵入りの百科事典。小さな絵ごとに名前と説明が付きます' },
  { pid: '2533057', page: 7, title: '絵本藤の縁', note: '絵の余白に短い文が入った絵本' },
  { pid: '9893107', page: 8, title: '怪席料理献立', note: '会席料理をもじった書名の黄表紙。絵の余白に地の文とせりふが入ります' },
  { pid: '1287963', page: 3, title: '伊勢物語 上', note: '「むかし、男」で始まる初段。地の文と和歌を、かなの多いくずし字で' },
  { pid: '2558997', page: 15, title: '道中膝栗毛 8編続12編', note: '弥次郎兵衛と喜多八の滑稽な旅。かなの多い本文が続きます' },
];

const presetsBox = $('#presets-box');

// 開閉の状態はブラウザに保存する（読めないときは開いたまま）
const PRESETS_OPEN_KEY = 'presetsOpen';
try { if (localStorage.getItem(PRESETS_OPEN_KEY) === 'false') presetsBox.open = false; } catch (e) { /* 開いたまま */ }
presetsBox.addEventListener('toggle', () => {
  try { localStorage.setItem(PRESETS_OPEN_KEY, String(presetsBox.open)); } catch (e) { /* 保存できなくても開閉はできる */ }
});
$('#presets').append(...PRESETS.map((p) => catalogItem(p)));

// ---------- 見本 ----------
// このビューアでできること（OCR・Claude による翻刻の校正・全ページの現代語訳）を一冊まるごと見せる資料。
// 見本の PDF と JSON を、開くときに利用者のブラウザへ取り込む（backend.importSample があるブラウザ保存版だけ）。
// 見本の一覧は samples/index.json（[{url, thumb, title, lines, sourceUrl, note, en: {lines, note}}]）。見本は各自で用意するもので
// リポジトリには含めない。index.json が無ければ見本の欄は出さない
// 「見本を開く」は 1 ページ目から（前に開いたことがあれば続きから）
const SAMPLES_URL = '/static/samples/index.json';

function sampleItem({ url, thumb, title, lines, sourceUrl, note, en }) {
  // 英語の画面では en の補足・紹介文を出す（書名は原典のまま）
  if (lang === 'en' && en) ({ lines = lines, note = note } = en);
  // 「見本を開く」と同じく、縮小画像と書名を押しても開く（資料のカードと同じ）
  const open = el('button', { type: 'button', textContent: t('見本を開く') });
  const cover = el('a', { className: 'cover', href: '#', title: t('見本を開く'), tabIndex: -1 }, [el('img', { src: thumb, alt: '' })]);
  const name = el('a', { className: 'name', href: '#', textContent: title });
  const openSample = async (e) => {
    e.preventDefault();
    if (open.disabled) return;
    open.disabled = true;
    setStatus(t('見本を取り込み中…'));
    try { location.href = await backend.importSample(url); } catch (err) { setStatus(err.message, true); open.disabled = false; }
  };
  [open, cover, name].forEach((target) => target.addEventListener('click', openSample));
  return el('article', { className: 'item sample' }, [
    cover,
    el('div', { className: 'info' }, [
      el('h3', {}, [el('span', { className: 'badge', textContent: t('見本') }), name]),
      ...lines.map((text) => el('div', { className: 'sub', textContent: text })),
    ]),
    el('div', { className: 'actions' }, [
      el('a', { href: sourceUrl, target: '_blank', rel: 'noopener', textContent: t('出典') }),
      open,
    ]),
    el('p', { className: 'note', textContent: note }),
  ]);
}

async function showSamples() {
  const res = await fetch(SAMPLES_URL);
  if (res.status === 404) return;  // 見本を用意していない
  if (!res.ok) throw new Error(t('見本を取得できません（{status}）', { status: res.status }));
  const samples = await res.json();
  if (!samples.length) return;
  const box = $('#samples');
  box.append(...samples.map(sampleItem));
  box.hidden = false;
  // ビューアからブラウザの「戻る」で戻ると、ページが前の状態のまま復元される（bfcache）。
  // 「見本を取り込み中…」の表示と、押せなくしたボタンを元に戻す
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    setStatus('');
    box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  });
}
if (backend.importSample) showSamples().catch((e) => setStatus(e.message, true));
