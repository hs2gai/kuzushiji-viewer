// 資料の画面（/）の資料一覧。NDL・PDF・アップロード画像を資料ごとにまとめて表示し、改名と削除を行う。
// $・el・setStatus は dom.js。

// 以前は / がビューアだったので、ページを指す古い URL（?pid= / ?doc= / ?id=）はビューアに転送する（ブラウザ保存版用。このサーバーはサーバー側で転送する）
if (['pid', 'doc', 'id'].some((k) => new URLSearchParams(location.search).has(k))) location.replace(`/view${location.search}`);

const ui = {
  list: $('#book-list'), summary: $('#summary'), confirm: $('#confirm'), confirmText: $('#confirm-text'), confirmButtons: $('#confirm-buttons'),
  confirmCheckRow: $('#confirm-check-row'), confirmCheck: $('#confirm-check'), confirmCheckLabel: $('#confirm-check-label'),
  filter: $('#filter'), sort: $('#sort'), noMatch: $('#no-match'), file: $('#file'), notice: $('#notice'),
  categoryBar: $('#category-bar'), categoryOptions: $('#category-options'),
};
// フッターのリンク（backend.footerLink: {url, label}。言語によらず同じ表記）
if (backend.footerLink) {
  const footer = $('#site-footer');
  footer.append(el('a', { href: backend.footerLink.url, textContent: backend.footerLink.label }));
  footer.hidden = false;
}
// ブラウザ保存版: 資料はブラウザに保存されること、ただし翻刻時の画像の扱い（backend.notice）
if (backend.notice) {
  $('#notice-local').hidden = false;
  ui.notice.textContent = t(`ただし${backend.notice}`);
  ui.notice.hidden = false;
}

// 注意書きは「⚠」で開閉する。初めて来た人に見せたいので既定は開いた状態にし、開閉の状態はブラウザに保存する
const DISCLAIMER_OPEN_KEY = 'disclaimerOpen';
const disclaimer = $('#disclaimer');
const disclaimerToggle = $('#disclaimer-toggle');
function showDisclaimer(open) {
  disclaimer.hidden = !open;
  disclaimerToggle.setAttribute('aria-expanded', String(open));
}
showDisclaimer(loadSetting(DISCLAIMER_OPEN_KEY) !== 'false');
disclaimerToggle.addEventListener('click', () => {
  showDisclaimer(disclaimer.hidden);
  saveSetting(DISCLAIMER_OPEN_KEY, String(!disclaimer.hidden));
});

const KIND_LABEL = { ndl: 'NDL', pdf: 'PDF', up: '画像' };
// 数える単位（英語は複数形の小文字。見出しの「コマ」「ページ」とは別にする）
const UNIT_LABEL = { ndl: { ja: 'コマ', en: 'frames' }, pdf: { ja: 'ページ', en: 'pages' }, up: { ja: '枚', en: 'images' } };

function formatSize(bytes) {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}


// 書誌情報をカードに入れる。名前を変えていなければ書名を見出しにする。書名・著者は絞り込みの対象にも加える
function applyNdlBiblio(metadata, dl, card, book) {
  const rows = biblioRows(metadata);
  dl.classList.remove('loading');
  dl.replaceChildren(...rows.flatMap(([label, value]) => [el('dt', { textContent: t(label) }), el('dd', { textContent: value })]));
  const title = rows.find(([label]) => label === '書名')?.[1];
  if (title) {
    card.dataset.title = title;
    if (!book.renamed) card.querySelector('.name').textContent = title;
  }
  const searchable = rows.filter(([label]) => label === '書名' || label === '著者').map(([, value]) => value);
  card.dataset.search += ` ${searchable.join(' ')}`;
}

// メタデータが資料に保存済みなら（一覧のデータに入っている）その場で入れる。まだ無ければ書誌情報の分の高さを空けておき
// （届いたときにカードの高さが変わらない）、NDL から取って資料に保存してから入れる
function fillNdlBiblio(dl, card, book) {
  if (book.metadata) { applyNdlBiblio(book.metadata, dl, card, book); return; }
  dl.classList.add('loading');
  bookMetadata(book.key).then((metadata) => { applyNdlBiblio(metadata, dl, card, book); applyFilter(); }, (e) => {
    dl.classList.remove('loading');
    dl.append(el('dd', { className: 'error', textContent: t('書誌情報を取得できません（{error}）', { error: e.message }) }));
  });
}

function renderBook(book) {
  const unit = UNIT_LABEL[book.kind][lang];
  const card = el('article', { className: 'book' });
  const ident = book.key.split(':').slice(1).join(':');
  card.dataset.search = `${book.name} ${ident}`;  // 資料名と ID（NDL は pid）
  card.dataset.category = book.category || '';  // 分類を持つ前に保存した一覧には無い

  // サムネとタイトルからも資料を開ける（「開く」ボタンと同じリンク）
  card.append(el('a', { className: 'cover', href: book.url, title: t('開く'), tabIndex: -1 }, [book.thumb
    ? el('img', { src: book.thumb, alt: '', loading: 'lazy' })
    : el('div', { className: 'noimg' })]));

  const rename = iconButton('button', 'rename', t('名前を変更'), { className: 'icon-btn rename-btn' });
  const meta = el('div', {}, [
    el('div', { className: 'title-row' }, [el('h2', {}, [el('a', { className: 'name', href: book.url, textContent: book.name })]), rename]),
    el('div', { className: 'meta' }, [
      el('span', { className: `kind ${book.kind}`, textContent: book.kind === 'ndl' ? `NDL ${ident}` : t(KIND_LABEL[book.kind]) }),
      categoryButton(book.category, [book]),
      el('span', { textContent: t('OCR 済み {n} {unit}', { n: book.pages.length, unit }) }),
      el('span', { textContent: t('解説 {n} 件', { n: book.pages.filter((p) => p.interpreted).length }) }),
      canRunJob ? el('span', { textContent: t('校正 {n} 件', { n: book.pages.filter((p) => p.corrected).length }) }) : '',
      book.bytes ? el('span', { textContent: formatSize(book.bytes) }) : '',  // 追加しただけの資料はまだ何も保存していない
      el('span', { textContent: (book.updated_at || '').replace('T', ' ') }),
    ]),
  ]);
  const jobBox = el('div', { className: 'job', hidden: true });
  meta.append(jobBox);
  card.append(meta);
  if (book.kind === 'ndl') {  // 書名の欄（.name）をカードから探すので、meta をカードに入れてから
    const biblio = el('dl', { className: 'biblio' });
    meta.append(biblio);
    fillNdlBiblio(biblio, card, book);
  }

  const open = iconButton('a', 'open', t('開く'), { href: book.url });
  const download = iconButton('button', 'download', t('翻刻をダウンロード'), { disabled: !book.pages.length });
  // 全ページの翻刻（校正も選べる）と、全ページの翻訳（現代語訳と解説）。済んでいればボタンの色を変える（押せばやり直せる）:
  // 翻刻は、全ページの翻刻が済めば薄く、校正まで済めば濃く。翻訳は、全ページの解説が済めば濃く
  const progress = bookProgress(book);
  const transcribe = iconButton('button', 'correct', t(progress.corrected ? '全ページを翻刻（校正まで済み）' : progress.ocr ? '全ページを翻刻（翻刻は済み）' : '全ページを翻刻'), {
    hidden: !canRunJob, className: `icon-btn${progress.corrected ? ' done full' : progress.ocr ? ' done' : ''}`,
  });
  const translate = iconButton('button', 'layerTranslate', t(progress.translated ? '全ページを翻訳（済み）' : '全ページを翻訳'), {
    hidden: !canRunJob, className: `icon-btn${progress.translated ? ' done full' : ''}`,
  });
  const remove = iconButton('button', 'remove', t('削除'));
  remove.classList.add('danger');
  card.append(el('div', { className: 'actions' }, [open, download, transcribe, translate, remove]));

  download.addEventListener('click', () => downloadText(book));
  transcribe.addEventListener('click', () => startTranscribe(book, progress));
  translate.addEventListener('click', () => startTranslate(book, progress));
  rename.addEventListener('click', () => startRename(card, book));
  remove.addEventListener('click', () => deleteBook(book));
  if (canRunJob) showJob(jobBox, [transcribe, translate], book, book.job);
  return card;
}

// ---------- 全ページの一括処理（サーバーで OCR と claude -p を1ページずつ実行）----------
const canRunJob = Boolean(backend.startBookJob);  // サーバーで処理する backend だけが持つ
const POLL_MS = 3000;
const JOB_SHOW_SEC = 60;
const jobTimers = new Map();  // 資料 ID -> 進捗のポーリング用タイマー

const formatElapsed = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
// 処理の名前（行う処理 steps から決める）
const jobName = (steps) => t(steps.includes('interpret') ? '翻訳'
  : !steps.includes('correct') ? '翻刻' : steps.includes('ocr') ? '翻刻と校正' : '校正');

// 全ページで済んでいる処理。文字の無いページは校正・解説をしないので、文字のあるページ（excerpt が空でない）だけで見る。
// 総ページ数が分からない資料（NDL でまだ数えていないもの）は、どれも済んでいないことにする
function bookProgress(book) {
  const ocr = book.page_count != null && book.pages.length >= book.page_count;
  const textPages = book.pages.filter((p) => p.excerpt);
  return {
    ocr,
    corrected: ocr && textPages.every((p) => p.corrected),
    translated: ocr && textPages.every((p) => p.interpreted),
  };
}

// 一括処理の状態をカードに表示する。実行中ならポーリングを続け、終わったら一覧を読み直して件数を更新する
function showJob(box, buttons, book, state) {
  const unit = UNIT_LABEL[book.kind][lang];
  const running = state.status === 'running';
  buttons.forEach((b) => { b.disabled = running; });
  // 終わった処理は、失敗が無ければ終わってから JOB_SHOW_SEC 秒で表示を消す（サーバーは再起動まで最後の結果を返し続ける）。
  // 失敗したページがあれば、やり直せるよう表示を残す
  const settled = state.status !== 'running' && !state.failed?.length
    && Date.now() / 1000 - (state.finished_at || 0) > JOB_SHOW_SEC;
  box.hidden = state.status === 'none' || settled;
  if (box.hidden) return;

  const finished = state.done + state.failed.length;
  const name = jobName(state.steps);
  const label = {
    running: t('{name}中 {done} / {total} {unit}', { name, done: finished, total: state.total, unit })
      + (state.running.length ? t('（{pages} {unit}目を処理中）', { pages: state.running.join('・'), unit }) : ''),
    done: t('{name}が終わりました（{done} / {total} {unit}）', { name, done: state.done, total: state.total, unit }),
    canceled: t('{name}を中止しました（{done} / {total} {unit}）', { name, done: state.done, total: state.total, unit }),
  }[state.status];
  const children = [
    el('progress', { max: state.total, value: finished }),
    el('span', { textContent: `${label}・${t('経過')} ${formatElapsed(state.elapsed)}` }),
  ];
  if (running) {
    const cancel = el('button', { textContent: t('中止') });
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try { await backend.cancelBookJob(book.key); } catch (e) { setStatus(e.message, true); }
    });
    children.push(cancel);
  }
  if (state.failed.length) {
    children.push(el('details', { className: 'failed' }, [
      el('summary', { textContent: t('失敗 {n} {unit}（もう一度同じボタンを押すと、失敗したページと残りのページだけ行います）', { n: state.failed.length, unit }) }),
      el('ul', {}, state.failed.map((f) => el('li', { textContent: `${f.page ? `${f.page} ${unit}` : f.id}: ${f.error}` }))),
    ]));
  }
  box.replaceChildren(...children);

  if (!running) return;
  jobTimers.set(book.key, setTimeout(async () => {
    let next;
    try { next = await backend.getBookJob(book.key); } catch (e) { setStatus(e.message, true); return; }
    if (next.status === 'running') showJob(box, buttons, book, next);
    else load();  // 件数・ボタンの表示を更新する
  }, POLL_MS));
}

async function startBookJob(book, steps, redo) {
  try { await backend.startBookJob(book.key, steps, redo); } catch (e) { setStatus(e.message, true); return; }
  load();
}

// 総ページ数（分からなければ「?」）
const pageTotal = (book) => book.page_count ?? '?';

// 全ページの翻刻。翻刻だけ・校正だけ・翻刻と校正から選ぶ（既定は翻刻と校正）。
// 校正済みのページがあれば「校正し直す」を選べる（校正まで済んでいる資料では、はじめからチェックを入れておく）
async function startTranscribe(book, progress) {
  const unit = UNIT_LABEL[book.kind][lang];
  const corrected = book.pages.filter((p) => p.corrected).length;
  const choice = await confirmAction(
    t('「{name}」の全ページを翻刻します。※翻刻済み・校正済みのページはスキップします。\n校正では、Claude がページごとに画像と照らし合わせて翻刻の誤りを直します（1 ページに数十秒〜数分かかります）。校正だけなら、翻刻済みのページだけを校正します。\n翻刻済み {ocr} / {total} {unit}\n校正済み {corrected} {unit}',
      { name: book.name, ocr: book.pages.length, total: pageTotal(book), corrected, unit }),
    [
      { value: 'ocr', label: t('翻刻だけ') },
      { value: 'correct', label: t('校正だけ'), disabled: !book.pages.length },
      { value: 'both', label: t('翻刻と校正'), primary: true },
    ],
    corrected ? { label: t('校正済みのページも校正し直す'), checked: progress.corrected } : null);
  const steps = { ocr: ['ocr'], correct: ['correct'], both: ['ocr', 'correct'] }[choice];
  if (steps) startBookJob(book, steps, ui.confirmCheck.checked);
}

// 全ページの翻訳（現代語訳と解説）。ページごとに数分かかるので、確かめてから始める。
// 解説済みのページがあれば「作り直す」を選べる（全ページ済みの資料では、はじめからチェックを入れておく）
async function startTranslate(book, progress) {
  const unit = UNIT_LABEL[book.kind][lang];
  const interpreted = book.pages.filter((p) => p.interpreted).length;
  const choice = await confirmAction(
    t('「{name}」の全ページを Claude で翻訳（現代語訳と解説）します。※解説済みのページはスキップします。\n1 ページに数分かかるため、ページが多いと数時間かかることがあります。翻刻がまだのページは先に翻刻します。\n解説済み {n} / {total} {unit}',
      { name: book.name, n: interpreted, total: pageTotal(book), unit }),
    [{ value: 'translate', label: t('翻訳する'), primary: true }],
    interpreted ? { label: t('解説済みのページも作り直す'), checked: progress.translated } : null);
  if (choice === 'translate') startBookJob(book, ['ocr', 'interpret'], ui.confirmCheck.checked);
}

// タイトルの鉛筆アイコンで、その場でタイトルを入力欄に切り替える（Enter で保存、Esc・取消で元に戻す）
function startRename(card, book) {
  const titleRow = card.querySelector('.title-row');
  // 空欄で保存すると既定の名前（NDL は書名、PDF・画像はファイル名）に戻る
  const input = el('input', { type: 'text', value: card.querySelector('.name').textContent, placeholder: card.dataset.title || book.default_name });
  const save = iconButton('button', 'save', t('保存'));
  const cancel = iconButton('button', 'cancel', t('取消'), { type: 'button' });
  const form = el('form', { className: 'rename' }, [input, save, cancel]);
  titleRow.hidden = true;
  titleRow.after(form);
  input.focus();
  input.select();

  const close = () => { form.remove(); titleRow.hidden = false; };
  cancel.addEventListener('click', close);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try { await backend.renameBook(book.key, input.value); } catch (err) { setStatus(err.message, true); save.disabled = false; return; }
    load();
  });
}

// ---------- 分類（料理書・読み物など。利用者が付ける）----------
// 分類のボタン。押すとその場で入力欄に切り替える（Enter で保存、Esc・取消で元に戻す）。
// books を複数渡すと（シリーズ）、全冊に同じ分類を付ける
function categoryButton(category, books) {
  const button = el('button', { type: 'button', className: `category${category ? '' : ' empty'}`, textContent: category || t('＋分類'), title: t('分類を設定') });
  button.addEventListener('click', () => startCategory(button, category, books));
  return button;
}

function startCategory(button, category, books) {
  const input = el('input', { type: 'text', value: category, placeholder: t('分類（空欄で外す）'), maxLength: 40 });
  input.setAttribute('list', 'category-options');  // 付けたことのある分類を候補に出す
  const save = iconButton('button', 'save', t('保存'));
  const cancel = iconButton('button', 'cancel', t('取消'), { type: 'button' });
  const form = el('form', { className: 'category-form' }, [input, save, cancel]);
  button.hidden = true;
  button.after(form);
  input.focus();
  input.select();

  const close = () => { form.remove(); button.hidden = false; };
  cancel.addEventListener('click', close);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      for (const book of books) await backend.setBookCategory(book.key, input.value);
    } catch (err) { setStatus(err.message, true); save.disabled = false; return; }
    load();
  });
}

// 分類での絞り込み（選んだものはブラウザに保存する）。'' はすべて、UNCATEGORIZED は分類の無い資料だけ
const CATEGORY_KEY = 'books.category';
const UNCATEGORIZED = '\u0000';
let selectedCategory = loadSetting(CATEGORY_KEY) || '';

// 分類ごとの件数のボタンを並べる。分類を付けた資料が無ければ出さない
function renderCategoryBar(books) {
  const counts = new Map();
  for (const b of books) if (b.category) counts.set(b.category, (counts.get(b.category) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  ui.categoryOptions.replaceChildren(...names.map((name) => el('option', { value: name })));
  ui.categoryBar.hidden = !names.length;
  const uncategorized = books.length - [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (!names.length || (selectedCategory && selectedCategory !== UNCATEGORIZED && !counts.has(selectedCategory))
    || (selectedCategory === UNCATEGORIZED && !uncategorized)) selectedCategory = '';
  const chips = [['', t('すべて'), books.length], ...names.map((name) => [name, name, counts.get(name)])];
  if (uncategorized) chips.push([UNCATEGORIZED, t('未分類'), uncategorized]);
  ui.categoryBar.replaceChildren(...chips.map(([value, label, n]) => {
    const chip = el('button', { type: 'button', className: 'chip', textContent: `${label} ${n}` });
    chip.setAttribute('aria-pressed', String(value === selectedCategory));
    chip.addEventListener('click', () => {
      selectedCategory = value;
      saveSetting(CATEGORY_KEY, value);
      ui.categoryBar.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      applyFilter();
    });
    return chip;
  }));
}

// ---------- シリーズ（同じ名前で巻数だけ違う資料。「大晦日曙草紙 1」〜「6」など）----------
// 名前の末尾の巻数（1・二・巻5・[3] など）を除いた部分が同じ資料が 2 冊以上あれば、1 枚のカードにまとめる。
// 名前は、付けた名前、無ければ NDL の書名、それも無ければ既定の名前
const VOLUME = /^(.+?)[\s.:・_-]*[[(]?(?:巻|第)?([0-9]{1,3}|[一二三四五六七八九十]{1,3})(?:巻|冊|編|号)?[\])]?$/;
const KANJI_DIGITS = '〇一二三四五六七八九';
const SERIES_OPEN_KEY = 'books.seriesOpen';
const openSeries = new Set(JSON.parse(loadSetting(SERIES_OPEN_KEY) || '[]'));

function kanjiNumber(text) {
  let total = 0, digit = 0;
  for (const c of text) {
    if (c === '十') { total += (digit || 1) * 10; digit = 0; } else digit = KANJI_DIGITS.indexOf(c);
  }
  return total + digit;
}

function displayName(book) {
  const title = !book.renamed && book.metadata && biblioRows(book.metadata).find(([label]) => label === '書名')?.[1];
  return title || book.name;
}

// 名前から {base: シリーズ名, volume: 巻数} を取り出す。巻数が無ければ null
function volumeOf(name) {
  const m = name.normalize('NFKC').match(VOLUME);
  const base = m?.[1].replace(/[\s.:・_-]+$/, '');
  return base ? { base, volume: /^\d+$/.test(m[2]) ? Number(m[2]) : kanjiNumber(m[2]) } : null;
}

// 並べた資料を、資料かシリーズ（{base, books}）の並びにする。シリーズは最初の 1 冊の位置に置き、中は巻数の順
function groupSeries(books) {
  const byBase = new Map();
  for (const book of books) {
    const v = volumeOf(displayName(book));
    if (v) (byBase.get(v.base) || byBase.set(v.base, []).get(v.base)).push({ book, volume: v.volume });
  }
  const seriesOf = new Map();
  for (const [base, list] of byBase) {
    if (list.length < 2) continue;
    const series = { base, books: list.sort((a, b) => a.volume - b.volume).map((v) => v.book) };
    series.books.forEach((b) => seriesOf.set(b.key, series));
  }
  const items = [];
  for (const book of books) {
    const series = seriesOf.get(book.key);
    if (!series) items.push(book);
    else if (!items.includes(series)) items.push(series);
  }
  return items;
}

// シリーズのカード。見出しを押すと各冊のカードを開閉する（開閉の状態はブラウザに保存する）
function renderSeries(series) {
  const first = series.books[0];
  const categories = new Set(series.books.map((b) => b.category));
  const body = el('div', { className: 'series-books' }, series.books.map(renderBook));
  const toggle = el('button', { type: 'button', className: 'series-toggle', textContent: series.base, title: t('各冊を表示・隠す') });
  const box = el('section', { className: 'series' }, [
    el('div', { className: 'series-head' }, [
      el('div', { className: 'cover' }, [first.thumb ? el('img', { src: first.thumb, alt: '', loading: 'lazy' }) : el('div', { className: 'noimg' })]),
      el('div', {}, [
        el('h2', {}, [toggle]),
        el('div', { className: 'meta' }, [
          el('span', { className: 'kind series-count', textContent: t('{n} 冊', { n: series.books.length }) }),
          categoryButton(categories.size === 1 ? first.category : '', series.books),
          el('span', { textContent: series.books.reduce((max, b) => (b.updated_at > max ? b.updated_at : max), '').replace('T', ' ') }),
        ]),
      ]),
    ]),
    body,
  ]);
  const setOpen = (open) => {
    box.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  };
  setOpen(openSeries.has(series.base));
  toggle.addEventListener('click', () => {
    const open = box.dataset.open !== 'true';
    setOpen(open);
    if (open) openSeries.add(series.base); else openSeries.delete(series.base);
    saveSetting(SERIES_OPEN_KEY, JSON.stringify([...openSeries]));
  });
  return box;
}

// 翻刻を1冊1ファイルのテキストに書き出す。ページごとに見出しを付け、行は読み順に改行で区切る
async function downloadText(book) {
  const unit = UNIT_LABEL[book.kind][lang];
  let pages;
  try { pages = await backend.getBookPages(book.key); } catch (e) { setStatus(e.message, true); return; }
  // 校正済みのページは校正後の本文を書き出し、見出しに（校正済み）と付ける
  const sections = pages.map((p) =>
    `=== ${p.page ? `${p.page} ${unit}` : p.id}${p.corrected ? t('（校正済み）') : ''} ===\n${(p.corrected || p.lines.map((l) => l.text)).join('\n')}`);
  const text = `${book.name}\n\n${sections.join('\n\n')}\n`;
  const link = el('a', {
    href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
    download: `${book.name.replace(/[\\/:*?"<>|]/g, '_')}.txt`,  // ファイル名に使えない文字を置き換える
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));  // ダウンロードが始まってから解放する
}

// 確認ダイアログ。ブラウザの confirm は使わず、内容を示してから実行する。
// choices = [{value, label, primary, danger, disabled}]。押したボタンの value を返し、やめたら null。primary のボタンを既定（フォーカス）にする。
// check = {label, checked} を渡すとチェックボックスを出す（押したあとの状態は ui.confirmCheck.checked で見る。出さないときは false）
async function confirmAction(text, choices, check = null) {
  ui.confirmText.textContent = text;
  ui.confirmCheckRow.hidden = !check;
  ui.confirmCheck.checked = Boolean(check?.checked);
  ui.confirmCheckLabel.textContent = check?.label || '';
  const buttons = choices.map((c) => el('button', {
    value: c.value, textContent: c.label, className: c.danger ? 'danger' : c.primary ? 'primary' : '', disabled: Boolean(c.disabled),
  }));
  ui.confirmButtons.replaceChildren($('#confirm-cancel'), ...buttons);
  ui.confirm.returnValue = 'cancel';
  ui.confirm.showModal();
  buttons[choices.findIndex((c) => c.primary)]?.focus();
  await new Promise((resolve) => ui.confirm.addEventListener('close', resolve, { once: true }));
  return ui.confirm.returnValue === 'cancel' ? null : ui.confirm.returnValue;
}

async function deleteBook(book) {
  const interpreted = book.pages.filter((p) => p.interpreted).length;
  const corrected = book.pages.filter((p) => p.corrected).length;
  if (!await confirmAction(
    t('「{name}」を削除します。\n画像 {size}、OCR 結果 {pages} 件、解説 {interpreted} 件、校正 {corrected} 件がまとめて消え、元に戻せません。',
      { name: book.name, size: formatSize(book.bytes), pages: book.pages.length, interpreted, corrected }),
    [{ value: 'delete', label: t('削除する'), danger: true }])) return;
  setStatus(t('「{name}」を削除中…', { name: book.name }));
  try {
    const r = await backend.deleteBook(book.key);
    setStatus(t('「{name}」を削除しました（ページ {pages} 件 / ファイル {files} 個）', { name: book.name, pages: r.pages, files: r.files }));
  } catch (e) { setStatus(e.message, true); return; }
  load();
}

// ---------- 絞り込み（資料名・書名・著者・ID）----------
// 全角・半角や大文字・小文字の違いを無視し、空白区切りの語をすべて含む資料だけを残す
const normalize = (text) => text.normalize('NFKC').toLowerCase();

// 分類を選んでいれば、その分類の資料だけを残す。シリーズは残った冊があれば出し、語で絞り込んでいる間は閉じていても各冊を見せる
function applyFilter() {
  const terms = normalize(ui.filter.value).split(/\s+/).filter(Boolean);
  const inCategory = (card) => !selectedCategory
    || (selectedCategory === UNCATEGORIZED ? !card.dataset.category : card.dataset.category === selectedCategory);
  const cards = [...ui.list.querySelectorAll('.book')];
  let shown = 0;
  for (const card of cards) {
    const text = normalize(card.dataset.search);
    card.hidden = !inCategory(card) || !terms.every((t) => text.includes(t));
    if (!card.hidden) shown++;
  }
  for (const series of ui.list.querySelectorAll('.series')) {
    series.hidden = !series.querySelector('.book:not([hidden])');
    series.querySelector('.series-books').hidden = series.dataset.open !== 'true' && !terms.length;
  }
  ui.noMatch.hidden = !cards.length || shown > 0;
}

// ---------- 並び順（選んだものはブラウザに保存する）----------
// 日時は新しい順、名前は五十音順。開いたことの無い資料などは日時が空なので末尾に回る
const SORT_KEY = 'books.sort';
if ([...ui.sort.options].some((o) => o.value === loadSetting(SORT_KEY))) ui.sort.value = loadSetting(SORT_KEY);
ui.sort.addEventListener('change', () => { saveSetting(SORT_KEY, ui.sort.value); if (shownBooks) renderList(shownBooks); });

function sortBooks(books) {
  const key = ui.sort.value;
  if (key === 'name') return books.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return books.sort((a, b) => b[key].localeCompare(a[key]) || b.updated_at.localeCompare(a.updated_at));
}

// ---------- 一覧の描画 ----------
// 前回の一覧をブラウザに保存しておき、開いた瞬間にそれを描く。サーバーから最新の一覧を取ってきて、変わっていたときだけ描き直す。
// 保存が無い初回は、カードの枠（スケルトン）を並べておく。
// 一覧のデータの形を変えたら版を上げる（古い形の保存を描こうとして止まらないように。v2: 校正の状態 correct → 一括処理の状態 job）
const BOOKS_CACHE_KEY = 'books.cache.v2';
const SKELETON_COUNT = 4;
let shownBooks = null;   // 描画中の一覧（並び順を変えたときに描き直す）
let shownJson = null;    // 描画中の一覧の JSON（最新と同じなら描き直さない）

function renderList(books) {
  shownBooks = books;
  sortBooks(books);
  jobTimers.forEach(clearTimeout);  // 描画し直すカードのポーリングは新しいカードで張り直す
  jobTimers.clear();
  ui.list.replaceChildren();
  if (!books.length) {
    ui.list.append(el('p', { className: 'empty', textContent: t('まだ資料がありません。上の検索やおすすめから追加するか、ビューアで NDL の資料・画像・PDF を開いてください。') }));
    ui.summary.textContent = '';
    ui.categoryBar.hidden = true;
    return;
  }
  renderCategoryBar(books);
  groupSeries(books).forEach((item) => ui.list.append(item.books ? renderSeries(item) : renderBook(item)));
  applyFilter();
  const bytes = books.reduce((sum, b) => sum + b.bytes, 0);
  const pages = books.reduce((sum, b) => sum + b.pages.length, 0);
  ui.summary.textContent = t('{books} 資料 / {pages} ページ / {size}', { books: books.length, pages, size: formatSize(bytes) });
}

async function load() {
  if (!shownBooks) {
    const saved = loadSetting(BOOKS_CACHE_KEY);
    if (saved) renderList(JSON.parse(saved));
    else ui.list.replaceChildren(...Array.from({ length: SKELETON_COUNT }, () => el('article', { className: 'book skeleton' })));
  }
  try {
    const books = await backend.listBooks();
    const json = JSON.stringify(books);
    if (json === shownJson) return;
    shownJson = json;
    // ブラウザ保存版の PDF・画像の縮小画像はそのときだけ有効な blob: の URL なので、保存する一覧からは外す（次に開いたときは枠だけ出す）
    saveSetting(BOOKS_CACHE_KEY, JSON.stringify(books.map((b) => (b.thumb?.startsWith('blob:') ? { ...b, thumb: null } : b))));
    renderList(books);
  } catch (e) { setStatus(e.message, true); }
}

// 画像・PDF を開く: OCR して保存してから、そのページをビューアで開く（PDF は 1 ページ目）
async function openFile(file) {
  ui.file.disabled = true;
  setStatus(t('{name} を OCR 中…', { name: file.name }));
  try {
    const page = await backend.openFile(file);
    location.href = page.source_type === 'pdf' ? `/view?doc=${page.pid}&page=${page.page}` : `/view?id=${page.id}`;
  } catch (e) {
    setStatus(e.message, true);
    ui.file.disabled = false;
  }
}

ui.filter.addEventListener('input', applyFilter);
ui.file.addEventListener('change', () => { if (ui.file.files[0]) openFile(ui.file.files[0]); ui.file.value = ''; });

// 画像・PDF は画面のどこにドロップしても開ける。ドラッグ中は「画像/PDF を開く」を目立たせる
const isOpenable = (file) => file.type.startsWith('image/') || file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;  // 子要素への出入りでも dragenter / dragleave が来るので、入れ子の深さで判定する
const setDragging = (on) => document.body.classList.toggle('dragging', on);
document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; setDragging(true); } });
document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; setDragging(false); } });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });  // これが無いとブラウザがファイルを開いてしまう
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const file = [...e.dataTransfer.files].find(isOpenable);
  if (!file) { setStatus(t('開けるのは画像か PDF です'), true); return; }
  if (!ui.file.disabled) openFile(file);
});
load();
