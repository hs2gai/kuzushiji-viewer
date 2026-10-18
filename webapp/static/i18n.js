// 画面の言語（日本語・英語）の切り替え。どの画面でも最初に読み込む（dom.js の data-icon より先に訳を入れるため）。
// - 言語は、利用者が選んだもの（ブラウザに保存）、無ければブラウザの言語（日本語なら日本語、それ以外は英語）
// - 訳の鍵は日本語の文そのもの。日本語ではそのまま使い、英語では EN の辞書から引く（辞書に無い文は日本語のまま出す）
// - HTML は、読み込んだ時点の文字と title・placeholder・aria-label を辞書と照らし合わせて訳す（applyI18n）
// - JavaScript の文は t('…{n}…', { n }) で訳す。{名前} の所に値が入る（サーバーのエラーも同じ形で返る）

const LANGS = { ja: '日本語', en: 'English' };
const LANG_KEY = 'lang';

const lang = (() => {
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch (e) { /* 保存できない環境ではブラウザの言語に従う */ }
  if (saved in LANGS) return saved;
  return /^ja\b/i.test(navigator.language || '') ? 'ja' : 'en';
})();
document.documentElement.lang = lang;

function t(text, values = {}) {
  const template = (lang === 'en' && EN[text]) || text;
  return template.replace(/\{(\w+)\}/g, (all, name) => (name in values ? values[name] : all));
}

// 読み込んだ時点の画面（HTML に書いた文字）を訳す。文字のかたまり（テキストノード）と title・placeholder・aria-label の値が
// 辞書にあれば置き換える。後から JavaScript が出す資料の中身（書名・翻刻・訳）は対象にならない（原典の日本語のまま）
function applyI18n(root = document.body) {
  if (lang === 'ja') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text && EN[text] && !node.parentElement.closest('script, style')) node.nodeValue = node.nodeValue.replace(text, EN[text]);
  }
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    root.querySelectorAll(`[${attr}]`).forEach((el) => { if (EN[el.getAttribute(attr)]) el.setAttribute(attr, EN[el.getAttribute(attr)]); });
  }
  document.title = t(document.title);
}

// サーバーのエラーの応答から、選んだ言語のメッセージを作る。
// detail は文字列か {message: 日本語のひな形, vars}（api_error）。ひな形を detail、値を vars で返す形も受け付ける
function errorMessage(body) {
  const detail = body?.detail;
  if (!detail) return '';
  if (Array.isArray(detail)) return detail.map((d) => d.msg).join('; ');  // FastAPI の入力チェックのエラー
  if (typeof detail === 'object') return t(detail.message, detail.vars);
  return t(detail, body.vars);
}

// ヘッダーの右端に言語の切り替えを置く。切り替えたら保存して読み込み直す
function addLangSwitch() {
  const header = document.querySelector('header');
  if (!header) return;
  const select = document.createElement('select');
  select.className = 'lang-switch';
  select.setAttribute('aria-label', 'Language');
  for (const [code, label] of Object.entries(LANGS)) select.append(new Option(label, code, false, code === lang));
  select.addEventListener('change', () => {
    try { localStorage.setItem(LANG_KEY, select.value); } catch (e) { /* 保存できなくても今回は切り替える */ }
    location.reload();
  });
  header.append(select);
}

// 英語の辞書（鍵は日本語の文）
const EN = {
  // 共通・ヘッダー
  'くずし字ビューア': 'Kuzushiji Viewer',
  '古典籍を探す（書名・著者など）': 'Search classical books (title, author…)',
  '古典籍を探す': 'Search classical books',
  '検索': 'Search',
  '資料の画面に戻る': 'Back to the library',
  '古典籍を探す — くずし字ビューア': 'Search classical books — Kuzushiji Viewer',
  'さらに表示': 'Show more',
  'NDL デジタルコレクションの古典籍を、': 'Classical books in the NDL Digital Collections are searched with the ',
  '次世代デジタルライブラリー': 'NDL Lab Next Digital Library',
  'の検索 API で探しています。': ' search API.',

  // 資料の画面
  'くずし字が混在する古典籍について、まずは何が書かれているのか知りたい人のためのツールです。':
    'A tool for people who want a first idea of what is written in classical Japanese books that contain kuzushiji (cursive script).',
  '実験的に機械的処理を優先しているため正確さが犠牲になっています。':
    'It is experimental and favors automated processing, so accuracy is sacrificed.',
  '誤訳や誤植を多く含むため正確なテキストが必要な場合は原典や専門の研究書を参照するようにしてください。':
    'The results contain many mistranslations and misreadings. If you need an accurate text, please consult the original or scholarly editions.',
  '翻刻をする場合は「自動翻刻」をオンにしてページをめくってください。': 'To transcribe, turn on “Auto transcribe” and turn the page.',
  '開いたPDFや画像はローカルで処理されるためサーバーには保存されません。':
    'PDFs and images you open are processed locally and are not stored on the server.',
  'ただし翻刻時の画像はOCR サーバーの仕様で、画像と結果を暗号化して最大 7 日間保持された後に削除されます。結果そのものはこのブラウザにだけ保存されます。':
    'However, images sent for transcription are, by the OCR server\'s design, kept encrypted with their results for up to 7 days and then deleted. The results themselves are stored only in this browser.',
  '翻刻時の画像はOCR サーバーの仕様で、画像と結果を暗号化して最大 7 日間保持された後に削除されます。結果そのものはこのブラウザにだけ保存されます。':
    'Images sent for transcription are, by the OCR server\'s design, kept encrypted with their results for up to 7 days and then deleted. The results themselves are stored only in this browser.',
  '資料': 'Library',
  '書名・著者・ID で絞り込み': 'Filter by title, author or ID',
  '資料の絞り込み': 'Filter the library',
  '並び順': 'Sort order',
  '最近開いた順': 'Recently opened',
  '更新した順': 'Recently updated',
  '追加した順': 'Recently added',
  '名前順': 'By name',
  '画像/PDF を開く': 'Open image/PDF',
  '注意書きを表示・隠す': 'Show or hide the notes',
  'OCR してからビューアで開きます（画面にドラッグ＆ドロップしても開けます）': 'Runs OCR, then opens it in the viewer (you can also drag and drop a file onto the page)',
  '条件に合う資料はありません。': 'No books match.',
  'おすすめの古典籍': 'Recommended classical books',
  '何から読めばよいか迷ったら、絵と文が並んだ次の本から試してみてください。「開く」で見どころのコマを表示します。':
    'Not sure where to start? Try these books with pictures and text side by side. "Open" shows a highlight frame.',
  'やめる': 'Cancel',
  'まだ資料がありません。上の検索やおすすめから追加するか、ビューアで NDL の資料・画像・PDF を開いてください。':
    'No books yet. Add one from the search or recommendations above, or open an NDL book, an image or a PDF in the viewer.',
  '{books} 資料 / {pages} ページ / {size}': '{books} books / {pages} pages / {size}',
  '{name} を OCR 中…': 'Running OCR on {name}…',
  '開けるのは画像か PDF です': 'Only images and PDFs can be opened',
  '書名': 'Title',
  '著者': 'Author',
  '出版者': 'Publisher',
  '出版年': 'Published',
  '画像': 'Image',
  'コマ': 'Frame',
  'ページ': 'Page',
  '書誌情報を取得できません（{error}）': 'Could not load bibliographic data ({error})',
  '開く': 'Open',
  '名前を変更': 'Rename',
  'OCR 済み {n} {unit}': 'OCR done: {n} {unit}',
  '解説 {n} 件': 'Commentary: {n}',
  '校正 {n} 件': 'Proofread: {n}',
  '翻刻をダウンロード': 'Download transcription',
  '全ページを翻刻': 'Transcribe all pages',
  '全ページを翻刻（翻刻は済み）': 'Transcribe all pages (transcription done)',
  '全ページを翻刻（校正まで済み）': 'Transcribe all pages (transcription and proofreading done)',
  '全ページを翻訳': 'Translate all pages',
  '全ページを翻訳（済み）': 'Translate all pages (done)',
  '削除': 'Delete',
  '保存': 'Save',
  '取消': 'Cancel',
  '中止': 'Stop',
  '経過': 'elapsed',
  '翻刻': 'Transcription',
  '翻刻と校正': 'Transcription and proofreading',
  '校正': 'Proofreading',
  '翻訳': 'Translation',
  '{name}中 {done} / {total} {unit}': '{name}: {done} / {total} {unit}',
  '（{pages} {unit}目を処理中）': ' (working on {unit} {pages})',
  '{name}が終わりました（{done} / {total} {unit}）': '{name} finished ({done} / {total} {unit})',
  '{name}を中止しました（{done} / {total} {unit}）': '{name} stopped ({done} / {total} {unit})',
  '失敗 {n} {unit}（もう一度同じボタンを押すと、失敗したページと残りのページだけ行います）':
    'Failed: {n} {unit} (press the same button again to process only the failed and remaining pages)',
  '「{name}」の全ページを翻刻します。※翻刻済み・校正済みのページはスキップします。\n校正では、Claude がページごとに画像と照らし合わせて翻刻の誤りを直します（1 ページに数十秒〜数分かかります）。校正だけなら、翻刻済みのページだけを校正します。\n翻刻済み {ocr} / {total} {unit}\n校正済み {corrected} {unit}':
    'Transcribe all pages of "{name}". *Pages already transcribed or proofread are skipped.\nProofreading has Claude check each page against the image and fix transcription mistakes (tens of seconds to a few minutes per page). "Proofread only" proofreads only the pages already transcribed.\nTranscribed: {ocr} / {total} {unit}\nProofread: {corrected} {unit}',
  '翻刻だけ': 'Transcribe only',
  '校正だけ': 'Proofread only',
  '校正済みのページも校正し直す': 'Proofread already proofread pages again',
  '「{name}」の全ページを Claude で翻訳（現代語訳と解説）します。※解説済みのページはスキップします。\n1 ページに数分かかるため、ページが多いと数時間かかることがあります。翻刻がまだのページは先に翻刻します。\n解説済み {n} / {total} {unit}':
    'Translate all pages of "{name}" with Claude (modern Japanese translation and commentary). *Pages that already have commentary are skipped.\nEach page takes a few minutes, so a long book can take hours. Pages not yet transcribed are transcribed first.\nWith commentary: {n} / {total} {unit}',
  '翻訳する': 'Translate',
  '解説済みのページも作り直す': 'Redo pages that already have commentary',
  '（校正済み）': ' (proofread)',
  '「{name}」を削除します。\n画像 {size}、OCR 結果 {pages} 件、解説 {interpreted} 件、校正 {corrected} 件がまとめて消え、元に戻せません。':
    'Delete "{name}"?\nImages ({size}), {pages} OCR results, {interpreted} commentaries and {corrected} proofreadings will be removed. This cannot be undone.',
  '削除する': 'Delete',
  '「{name}」を削除中…': 'Deleting "{name}"…',
  '「{name}」を削除しました（ページ {pages} 件 / ファイル {files} 個）': 'Deleted "{name}" ({pages} pages / {files} files)',

  // おすすめ・検索結果・見本
  'NDL デジタルコレクションで見る': 'View in NDL Digital Collections',
  '次世代デジタルライブラリーで見る': 'View in NDL Lab Next Digital Library',
  '見本を開く': 'Open sample',
  '見本を取り込み中…': 'Loading the sample…',
  '見本': 'Sample',
  '出典': 'Source',
  '歌人の絵と和歌。知っている歌と見比べながら読めます': 'Portraits of poets with their waka. You can compare them with poems you know',
  '絵入りの百科事典。小さな絵ごとに名前と説明が付きます': 'An illustrated encyclopedia. Each small picture has a name and a description',
  '絵の余白に短い文が入った絵本': 'A picture book with short texts in the margins of the pictures',
  '会席料理をもじった書名の黄表紙。絵の余白に地の文とせりふが入ります': 'A kibyōshi whose title puns on a banquet menu. Narration and dialogue fill the spaces around the pictures',
  '「むかし、男」で始まる初段。地の文と和歌を、かなの多いくずし字で': 'The opening episode, beginning "Long ago, a man…": prose and waka in kuzushiji written mostly in kana',
  '弥次郎兵衛と喜多八の滑稽な旅。かなの多い本文が続きます': 'The comic journey of Yajirobei and Kitahachi, told in text written mostly in kana',
  '検索できません (HTTP {status})': 'Search failed (HTTP {status})',
  '「{q}」を検索中…': 'Searching for "{q}"…',
  '「{q}」に当たる古典籍はありません。': 'No classical books found for "{q}".',
  '「{q}」の古典籍 {hit} 件（{shown} 件を表示）': '{hit} classical books for "{q}" ({shown} shown)',
  '「{q}」の検索結果 — くずし字ビューア': 'Results for "{q}" — Kuzushiji Viewer',
  '上の検索欄に書名・著者などを入れてください。': 'Enter a title, author, etc. in the search box above.',

  // ビューア
  '綴じ方向（矢印の進む向き）': 'Binding direction (which way the arrows turn pages)',
  '右開き（縦書き）': 'Right-to-left (vertical)',
  '左開き（横書き）': 'Left-to-right (horizontal)',
  '履歴': 'History',
  '履歴…': 'History…',
  'NDL デジタルコレクションでこのコマを開く': 'Open this frame in NDL Digital Collections',
  '次世代デジタルライブラリーでこのコマを開く': 'Open this frame in NDL Lab Next Digital Library',
  '自動翻刻': 'Auto transcribe',
  'ページをめくるたびに OCR で翻刻する（オフなら画像だけ表示し、レイヤーを「翻刻」に切り替えた時点で OCR する）':
    'Transcribe each page with OCR as you turn it (when off, only the image is shown and OCR runs when you switch to the transcription layer)',
  'レイヤー': 'Layer',
  'レイヤーなし': 'No layer',
  'English': 'English',
  '翻刻': 'Transcription',
  '現代語訳': 'Modern Japanese',
  '校正版': 'Proofread',
  'LLM で校正した翻刻を表示する（オフで OCR の原文）': 'Show the transcription proofread by an LLM (off: raw OCR text)',
  '不透明度': 'Opacity',
  '文字': 'Size',
  '文字の大きさ（現代語訳は全文が本文の領域に収まる大きさまで自動で小さくする）': 'Text size (the modern Japanese text shrinks automatically to fit the text area)',
  '字間': 'Spacing',
  '色': 'Color',
  '翻刻・現代語訳の文字色': 'Text color of the layers',
  '黒': 'Black',
  '青': 'Blue',
  '緑': 'Green',
  '朱': 'Vermilion',
  '白': 'White',
  '背景': 'Background',
  '翻刻・現代語訳の背景色': 'Background color of the layers',
  '生成り': 'Ecru',
  '薄黄': 'Light yellow',
  '薄灰': 'Light gray',
  '拡大': 'Zoom in',
  '縮小': 'Zoom out',
  'ページ全体を表示': 'Fit the whole page',
  '行一覧': 'Lines',
  '🤖 解説': '🤖 Commentary',
  'コピー': 'Copy',
  '行番号あり': 'With line numbers',
  'AIに解説依頼': 'Ask AI for commentary',
  '再実行': 'Run again',
  'キャッシュを無視して再実行': 'Ignore the saved result and run again',
  'お使いの LLM（Claude・ChatGPT など）に解説を依頼し、返答を貼り付けて保存できます。解説はこのブラウザにだけ保存されます。':
    'Ask your own LLM (Claude, ChatGPT, etc.) for a commentary, then paste and save the reply. Commentaries are stored only in this browser.',
  '① 「依頼文をコピー」して LLM に貼り付け（画像も添付すると精度が上がります）② 返答を下に貼り付けて「保存」':
    '① "Copy prompt" and paste it into the LLM (attaching the image improves accuracy) ② Paste the reply below and "Save"',
  '依頼文をコピー': 'Copy prompt',
  '画像を開く ↗': 'Open image ↗',
  'LLM に添付する画像を別タブで開く': 'Open the image to attach to the LLM in a new tab',
  '編集': 'Edit',
  'LLM の返答（Markdown）をここに貼り付け。空にして保存すると解説を削除します': 'Paste the LLM reply (Markdown) here. Save it empty to delete the commentary',
  '※ 現代語訳・要約・注記は LLM が生成したもので、完璧ではありません（もっともらしい誤りを含むことがあります）。最終的な確認は画像で行ってください。':
    '* The translation, summary and notes are generated by an LLM and are not perfect (they may contain plausible-looking errors). Always check against the image.',
  '推定で読んだ箇所': 'Uncertain reading',
  'NDL pid={pid} コマ{page} を取得中…': 'Loading NDL pid={pid} frame {page}…',
  'PDF {page} ページ目を読み込み中…': 'Loading PDF page {page}…',
  '読み込み中…': 'Loading…',
  '{n} 行': '{n} lines',
  '{m}分{s}秒': '{m}m {s}s',
  '{s}秒': '{s}s',
  '{n} 文字': '{n} chars',
  '依頼文をコピーしました。LLM に貼り付けてください': 'Prompt copied. Paste it into your LLM',
  'コマ{page}': 'frame {page}',
  '{page} コマ': 'Frame {page}',
  '翻刻中: {page} コマ目': 'Transcribing frame {page}',
  '翻刻中: {page} ページ目': 'Transcribing page {page}',
  '・待ち {n} 件': ' · {n} waiting',
  '行番号つきでコピーしました': 'Copied with line numbers',
  'コピーしました': 'Copied',
  '保存済みの解説': 'Saved commentary',
  '完了': 'Done',
  '次のコマ': 'Next frame',
  '前のコマ': 'Previous frame',
  '{page} ページ目の翻刻に失敗しました: {error}': 'Transcription of page {page} failed: {error}',
  '{page} コマ目の翻刻に失敗しました: {error}': 'Transcription of frame {page} failed: {error}',
  '翻刻中です。終わると解説を依頼できます': 'Transcribing. You can ask for a commentary when it finishes',
  'OCR 未実行です。レイヤーを「翻刻」にするか自動翻刻をオンにすると実行します':
    'Not transcribed yet. Switch to the transcription layer or turn on auto transcribe to run OCR',
  '順番待ち': 'Waiting',
  '起動中': 'Starting',
  '思考中': 'Thinking',
  '画像を確認中': 'Reading the image',
  '生成中': 'Writing',

  // サーバー・OCR のエラー
  'pid は数字か NDL の URL で指定してください': 'Specify the pid as a number or an NDL URL',
  'pid とコマ番号が正しくありません': 'The pid or frame number is invalid',
  'NDL から資料情報を取得できません (HTTP {status})': 'Could not load the book information from NDL (HTTP {status})',
  'NDL から画像を取得できません (HTTP {status})': 'Could not get the image from NDL (HTTP {status})',
  'NDL から画像を取得できません (HTTP {status}): {url}': 'Could not get the image from NDL (HTTP {status}): {url}',
  'NDL のサーバーが混み合っているため、画像を取得できませんでした。{wait} 秒ほど待ってから、もう一度開いてください':
    'The NDL server is busy, so the image could not be loaded. Please wait about {wait} seconds and open it again',
  'コマ {page} はありません（この資料は 1〜{count} コマ）': 'There is no frame {page} (this book has frames 1–{count})',
  'ページ {page} はありません（この PDF は 1〜{count} ページ）': 'There is no page {page} (this PDF has pages 1–{count})',
  'ページ {page} はありません': 'There is no page {page}',
  'PDF が見つかりません。もう一度開いてください': 'The PDF was not found. Please open it again',
  'PDF が見つかりません': 'The PDF was not found',
  'ページが見つかりません': 'The page was not found',
  '画像として読み込めません': 'Could not read it as an image',
  '画像を送ってください': 'Please send an image',
  '画像が大きすぎます': 'The image is too large',
  '画像を処理できません': 'Could not process the image',
  '画像の長辺は 8000px 以下にしてください': 'The long side of the image must be 8000px or less',
  '先に OCR を実行してください': 'Please run OCR first',
  'NDL から資料のコマ数を取得できません。しばらく待ってから、もう一度お試しください': 'Could not get the number of frames from NDL. Please wait a while and try again',
  '翻刻済みのページがありません。先に翻刻してください': 'There are no transcribed pages. Please transcribe first',
  'claude コマンドが見つかりません。Claude Code CLI をインストールしてください': 'The claude command was not found. Please install the Claude Code CLI',
  '見本を取得できません（{status}）': 'Could not load the sample ({status})',
  '依頼文のひな形を読み込めません': 'Could not load the prompt template',
  'OCR は準備中です。しばらくしてから再度お試しください': 'OCR is not ready yet. Please try again later',
  'OCR サーバーでエラーが発生しました (HTTP {status})。しばらくしてから再度お試しください': 'The OCR server returned an error (HTTP {status}). Please try again later',
  '本日の OCR 回数の上限に達しました。明日また使えます': 'You have reached today\'s OCR limit. You can use it again tomorrow',
  'デモ全体の本日の OCR 回数の上限に達しました。明日また使えます': 'The demo has reached today\'s overall OCR limit. It can be used again tomorrow',
  'OCR を使う前に確認が必要です': 'Verification is required before using OCR',
  'OCR を使う前に、ロボットでないことを確認させてください。': 'Before using OCR, please confirm that you are not a robot.',
  '確認用のトークンがありません': 'The verification token is missing',
  '確認画面を読み込めません': 'Could not load the verification screen',
  '確認に失敗しました。ページを再読み込みしてください': 'Verification failed. Please reload the page',
  '確認に失敗しました': 'Verification failed',
  '確認を中止しました': 'Verification was cancelled',
};

applyI18n();
addLangSwitch();
