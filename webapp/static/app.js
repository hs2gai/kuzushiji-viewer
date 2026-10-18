const SVG_NS = 'http://www.w3.org/2000/svg';

const ui = {
  form: $('#ndl-form'), pid: $('#pid'), page: $('#page'),
  navLeft: $('#nav-left'), navRight: $('#nav-right'), binding: $('#binding'),
  stage: $('#stage'), edgeLeft: $('#edge-left'), edgeRight: $('#edge-right'), thumbs: $('#thumbs'), thumbPreview: $('#thumb-preview'),
  pageSelect: $('#page-select'), historyBtn: $('#history-btn'), historyList: $('#history-list'), sourceLinks: $('#source-links'), sourceLink: $('#source-link'), labLink: $('#lab-link'),
  autoOcr: $('#auto-ocr'), layerForm: $('#layer-form'), layer: $('#layer-form').elements.layer, useCorrected: $('#use-corrected'), correctedWrap: $('#corrected-wrap'), opacity: $('#opacity'), fontScale: $('#font-scale'), letterSpacing: $('#letter-spacing'), textColor: $('#text-color'), bgColor: $('#bg-color'),
  zoomIn: $('#zoom-in'), zoomOut: $('#zoom-out'), zoomFit: $('#zoom-fit'), zoomLevel: $('#zoom-level'),
  commentaryLang: $('#commentary-lang'), englishBody: $('#english-body'),
  pageInfo: $('#page-info'), ocrProgress: $('#ocr-progress'), bookTitle: $('#book-title'), canvasWrap: $('#canvas-wrap'), canvas: $('#canvas'), image: $('#page-image'), overlay: $('#overlay'),
  lineList: $('#line-list'), copyText: $('#copy-text'), copyNumbered: $('#copy-numbered'),
  interpretBtn: $('#interpret-btn'), reinterpretBtn: $('#reinterpret-btn'),
  interpretStatus: $('#interpret-status'), interpretBody: $('#interpret-body'),
  interpretServer: $('#interpret-server'), interpretManual: $('#interpret-manual'), notice: $('#notice'),
  copyPrompt: $('#copy-prompt'), openImage: $('#open-image'), editInterpret: $('#edit-interpret'),
  interpretEditor: $('#interpret-editor'), interpretInput: $('#interpret-input'),
  saveInterpret: $('#save-interpret'), cancelInterpret: $('#cancel-interpret'),
};

// 解説の方式（backend.js が決める）。manual はブラウザ保存版: 利用者が自分の LLM で解説して貼り付ける
const manualInterpret = backend.interpretMode === 'manual';
ui.interpretServer.hidden = manualInterpret;
ui.interpretManual.hidden = !manualInterpret;

let current = null; // 表示中のページ（API のレスポンス）

// 解説の Markdown を HTML にする。LLM の返答（manual 方式では利用者が貼り付けたもの）にスクリプトが紛れても実行しないよう、必ずサニタイズする
// 推定で読んだ箇所の印「（？）」は、疑問文の「？」と紛れないよう、小さく薄い色の「？」にする（現代語訳のレイヤーと解説タブ）
const UNCERTAIN = /[（(]\s*[？?]\s*[）)]/g;
const UNCERTAIN_MARK = '';  // 現代語訳のレイヤーで直前の文字に付ける目印（マスは取らず、描くときにその文字の右脇に小さな「？」を添える）
const UNCERTAIN_HTML = `<span class="uncertain" title="${t('推定で読んだ箇所')}">？</span>`;
// 「（次ページへ続く）」「（前の項の続き）」などの断り書きは、現代語訳のレイヤーでは「……」にして訳文の場所を空ける
// （段落の頭なら前からの続き、末なら次へ続く。前後にある「……」もまとめる）。訳文でページの切れ目を示す「……」と同じ形にそろえる。
// 解説タブは元の書き方のまま
// 「（前のページから続く飛竜頭の作り方）」のように、前・次・以下で始まり「続」を含む断り書きも同じに扱う
const CONTINUED = /…*\s*[（(](?:[^（）()]{0,16}?(?:続き|続く)|(?:前|次|以下)[^（）()]{0,24}?続[^（）()]{0,20}?)\s*[）)]\s*…*/g;
// 「卵（から生まれるものの中にも？……次のページへ続く）」のように、推定した続きの文と断り書きが括弧に入っているものは、
// 括弧と断り書きを外して「卵から生まれるものの中にも……」にする（文末の「？」は推定の印にする）
const CONTINUED_TAIL = /[（(]([^（）()]+?)([？?])?\s*…+\s*(?:次|以下)[^（）()]{0,16}?続[くき][^（）()]{0,4}[）)]/g;
const expandContinued = (text) => text
  .replace(CONTINUED_TAIL, (_, body, mark) => `${body}${mark ? UNCERTAIN_MARK : ''}……`)
  .replace(CONTINUED, '……');
// （？）の目印は Markdown の段階で差し込み、最後にまとめてサニタイズする（サニタイズ後の HTML は書き換えない）
const renderMarkdown = (markdown) => DOMPurify.sanitize(marked.parse((markdown || '').replace(UNCERTAIN, UNCERTAIN_HTML)));

// ---------- ステータス表示 ----------
// ---------- ページ読み込み ----------
// まず画像だけ表示する。翻刻（OCR）は待ち行列で裏で実行し、終わったときに表示中のページなら重ねる（showPage が依頼する）
async function loadNdl(pid, page, fromHistory = false) {
  setStatus(t('NDL pid={pid} コマ{page} を取得中…', { pid, page }));
  try {
    showPage(await backend.openNdl(pid, page, false), fromHistory);
  } catch (e) { setStatus(e.message, true); }
}

async function loadPdf(doc, page, fromHistory = false) {
  setStatus(t('PDF {page} ページ目を読み込み中…', { page }));
  try {
    showPage(await backend.openPdf(doc, page, false), fromHistory);
  } catch (e) { setStatus(e.message, true); }
}

async function loadHistory(id, fromHistory = false) {
  setStatus(t('読み込み中…'));
  try { showPage(await backend.getPage(id), fromHistory); }
  catch (e) { setStatus(e.message, true); }
}

// ---------- URL 同期（?pid=&page= / ?doc=&page= / ?id=）----------
const PAGE_URL = { ndl: (d) => `?pid=${d.pid}&page=${d.page}`, pdf: (d) => `?doc=${d.pid}&page=${d.page}` };

function syncUrl(data, fromHistory) {
  const url = (PAGE_URL[data.source_type] || ((d) => `?id=${d.id}`))(data);
  if (fromHistory || location.search === url) return;
  history.pushState({ id: data.id, pid: data.pid, page: data.page }, '', url);
}

function loadFromUrl(fromHistory) {
  const params = new URLSearchParams(location.search);
  if (params.get('pid')) {
    ui.pid.value = params.get('pid');
    ui.page.value = params.get('page') || 1;
    loadNdl(ui.pid.value, Number(ui.page.value), fromHistory);
  } else if (params.get('doc')) {
    ui.page.value = params.get('page') || 1;
    loadPdf(params.get('doc'), Number(ui.page.value), fromHistory);
  } else if (params.get('id')) {
    loadHistory(params.get('id'), fromHistory);
  }
}
window.addEventListener('popstate', () => loadFromUrl(true));

// コマ数がわかるときだけ、数字の入力欄の横に 1〜コマ数の一覧を出す（直接入力もそのまま使える）
function setPageOptions(count, page) {
  ui.pageSelect.hidden = !count;
  if (!count) return;
  if (ui.pageSelect.options.length !== count) {
    ui.pageSelect.replaceChildren(...Array.from({ length: count }, (_, i) => new Option(i + 1, i + 1)));
  }
  ui.pageSelect.value = page;
}

// NDL・PDF は複数ページあるのでコマ送りできる（アップロードした 1 枚の画像はできない）
const isPageable = (data) => data?.source_type === 'ndl' || data?.source_type === 'pdf';

function showPage(data, fromHistory = false) {
  current = data;
  setStatus('');
  syncUrl(data, fromHistory);
  if (data.source_type === 'ndl' || data.source_type === 'pdf') {
    if (data.source_type === 'ndl') ui.pid.value = data.pid;
    ui.page.value = data.page;
    ui.page.max = data.page_count || '';
    setPageOptions(data.page_count, data.page);
    const head = data.source_type === 'ndl' ? `${data.name || `pid ${data.pid}`} / ${t('コマ')}` : `${data.name || 'PDF'} / ${t('ページ')}`;
    ui.pageInfo.textContent = `${head} ${data.page}${data.page_count ? ` / ${data.page_count}` : ''} / ${t('{n} 行', { n: data.lines.length })}`;
  } else {
    ui.pageInfo.textContent = `${data.name || data.id} / ${t('{n} 行', { n: data.lines.length })}`;
  }
  ui.stage.classList.toggle('pageable', isPageable(data));
  renderBookTitle(data);
  renderThumbs(data);
  ui.sourceLinks.hidden = data.source_type !== 'ndl';
  if (data.source_type === 'ndl') {
    ui.sourceLink.href = `https://dl.ndl.go.jp/pid/${data.pid}/1/${data.page}`;
    ui.labLink.href = `https://lab.ndl.go.jp/dl/book/${data.pid}?page=${data.page}`;
  }
  ui.canvas.setAttribute('viewBox', `0 0 ${data.width} ${data.height}`);
  ui.image.setAttribute('href', data.image_url);
  ui.image.setAttribute('width', data.width);
  ui.image.setAttribute('height', data.height);
  ui.correctedWrap.hidden = !data.corrected;
  renderText();
  renderEnglishList();
  ui.interpretBody.innerHTML = '';
  ui.interpretStatus.textContent = '';
  ui.openImage.href = data.image_url;
  if (data.ocr_done === false) {
    // OCR 未実行: 解説は出せないのでボタンを無効化し、案内だけ出す
    stopPolling();
    ui.interpretBtn.disabled = ui.reinterpretBtn.disabled = ui.copyPrompt.disabled = true;
    if (manualInterpret) renderManual('');
    if (ui.autoOcr.checked) enqueueOcr(data);
    renderOcrProgress();  // 翻刻待ちか未実行かの案内を出す
  } else {
    syncInterpret();  // 保存済み・実行中の解説はサーバーの状態に従って表示
  }
  refreshHistory();
}

// ロゴの下とタブに書名を出す。改名した名前・ファイル名があればそれ、無ければ NDL の書誌情報の書名（取れなければ pid）
async function renderBookTitle(data) {
  const key = `${data.source_type}:${data.pid || data.id}`;
  ui.bookTitle.dataset.key = key;
  let title = data.name;
  if (!title && data.source_type === 'ndl') {
    const metadata = await bookMetadata(key).catch(() => []);  // 書誌情報が取れなくてもページの表示は続ける
    title = biblioRows(metadata).find(([label]) => label === '書名')?.[1] || `NDL ${data.pid}`;
  }
  if (ui.bookTitle.dataset.key !== key) return;  // 取得している間に別の資料へ移った
  ui.bookTitle.textContent = title || '';
  ui.bookTitle.hidden = !title;
  document.title = title ? `${title} - ${t('くずし字ビューア')}` : t('くずし字ビューア');
}

// ---------- 翻刻レイヤー ----------
// 表示する行の本文。校正済みのページは「校正版」がオンなら校正後の本文、オフなら OCR の原文
const showCorrected = () => Boolean(current?.corrected) && ui.useCorrected.checked;
const lineTexts = () => (showCorrected() ? current.corrected : current.lines.map((l) => l.text));

function renderText() {
  renderOverlay();
  renderLineList();
}

// 行一覧を1行ずつ改行で区切ってコピーする。「行番号あり」なら各行の先頭に番号を付ける
async function copyLines() {
  if (!current) return;
  const numbered = ui.copyNumbered.checked;
  const texts = lineTexts().map((t, i) => (numbered ? `${i + 1}. ${t}` : t));
  await navigator.clipboard.writeText(texts.join('\n'));
  setStatus(t(numbered ? '行番号つきでコピーしました' : 'コピーしました'));
}

// 手書きの行幅は同じ文脈でも揺れるので、ページの標準の行幅に近い行は同じ文字サイズにそろえる。
// 範囲を外れる細い行（ルビ・挿絵の注記）や太い行（題など）は、その行の幅のまま
const SIZE_RANGE = [0.6, 1.4];

// 標準の行幅 = 行の長さで重みを付けた行幅の中央値。短いふりがなの行が多いページでも、本文の行幅になる
function baseLineWidth(lines) {
  const sorted = [...lines].sort((a, b) => (a.x2 - a.x1) - (b.x2 - b.x1));
  const half = sorted.reduce((sum, l) => sum + l.y2 - l.y1, 0) / 2;
  let acc = 0;
  const line = sorted.find((l) => (acc += l.y2 - l.y1) >= half);
  return line ? line.x2 - line.x1 : 0;
}

function renderOverlay() {
  ui.overlay.innerHTML = '';
  if (!current) return;
  const opacity = ui.opacity.value;
  const fontScale = parseFloat(ui.fontScale.value);
  const spacing = parseFloat(ui.letterSpacing.value);  // em 単位
  const texts = lineTexts();
  const base = baseLineWidth(current.lines);
  // 行矩形は翻刻以外のレイヤーでも置いておく（透明にして、行一覧とのホバー・選択に使う）
  ui.overlay.classList.toggle('hidden', ui.layer.value !== 'transcription');
  current.lines.forEach((line, i) => {
    const w = line.x2 - line.x1, h = line.y2 - line.y1;
    const fontSize = (w >= base * SIZE_RANGE[0] && w <= base * SIZE_RANGE[1] ? base : w) * fontScale;
    const boxW = Math.max(w, fontSize);  // そろえた文字が行より太いときは背景も文字幅まで広げる
    const cx = line.x1 + w / 2;
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('line-box');
    g.dataset.index = i;

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', cx - boxW / 2); rect.setAttribute('y', line.y1);
    rect.setAttribute('width', boxW); rect.setAttribute('height', h);
    rect.setAttribute('rx', 4);
    rect.setAttribute('fill-opacity', opacity);

    // ツールチップ。校正で変わった行は OCR の原文も併せて示す
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${i + 1}: ${texts[i]}${texts[i] !== line.text ? `\nOCR: ${line.text}` : ''}`;

    g.append(rect, verticalText(cx, line.y1, h, fontSize, spacing, texts[i]), title);
    g.addEventListener('mouseenter', () => setHover(i, true));
    g.addEventListener('mouseleave', () => setHover(i, false));
    g.addEventListener('click', () => select(i));
    ui.overlay.appendChild(g);
  });
  if (ui.layer.value === 'translation') renderTranslation(base, fontScale, spacing, opacity);
}

// 縦書きテキスト。上端 y から始める。高さ h を超えるときは textLength で詰める
// 縦書き用の記号（Unicode の縦書き用の形）。文字を立てて並べる指定（text-orientation: upright）では、
// ブラウザによって括弧や句読点が横書きの形のまま出るので、描くときだけ縦書き用の文字に置き換える（行一覧・コピーは元のまま）
// 縦書きで向きが合わない記号（波線・矢印・等号・ダッシュ）も、縦向きの形に置き換える
const VERTICAL_FORMS = Object.fromEntries([...'（︵）︶「﹁」﹂『﹃』﹄【︻】︼〔︹〕︺［﹇］﹈〈︿〉﹀《︽》︾｛︷｝︸、︑。︒，︐：︓；︔…︙‥︰ー︱—︱―︱〜≀～≀→↓←↑＝‖－︲']
  .reduce((pairs, ch, i, all) => (i % 2 ? pairs : [...pairs, [ch, all[i + 1]]]), []));
// 半角の英数字・記号は縦に並べると細く寝てしまうので、全角にして立てる（全角にしてから縦書きの形に置き換える）
const toFullWidth = (ch) => (ch >= '!' && ch <= '~' ? String.fromCharCode(ch.charCodeAt(0) + 0xFEE0) : ch);
const toVertical = (str) => str.replace(/./gu, (ch) => VERTICAL_FORMS[toFullWidth(ch)] || toFullWidth(ch));

function verticalText(x, y, h, fontSize, spacing, str) {
  // 推定の印は本文から外し、どの文字の後ろに付いていたか（何文字目か）を覚えておく
  const marks = [];
  const body = [...str].filter((ch, i, all) => {
    if (ch !== UNCERTAIN_MARK) return true;
    marks.push(all.slice(0, i).filter((c) => c !== UNCERTAIN_MARK).length - 1);
    return false;
  }).join('');
  const length = [...body].length;
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', x);
  text.setAttribute('y', y);
  text.setAttribute('font-size', fontSize);
  text.setAttribute('letter-spacing', fontSize * spacing);
  const squeezed = fontSize * (1 + spacing) * length > h;
  if (squeezed) { text.setAttribute('textLength', h); text.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
  text.textContent = toVertical(body);
  if (!marks.length) return text;
  // 印は、その文字の右脇（ルビの位置）に小さな「？」を別に置く。本文のマスは取らないので、語が途中で離れない
  const g = document.createElementNS(SVG_NS, 'g');
  const step = squeezed ? h / length : fontSize * (1 + spacing);
  g.append(text, ...marks.filter((i) => i >= 0).map((i) => {
    const mark = document.createElementNS(SVG_NS, 'text');
    mark.setAttribute('class', 'uncertain');
    mark.setAttribute('x', x + fontSize * 0.62);
    mark.setAttribute('y', y + i * step + fontSize * 0.05);
    mark.setAttribute('font-size', fontSize * 0.45);
    mark.textContent = '？';
    return mark;
  }));
  return g;
}

// ---------- 現代語訳レイヤー ----------
// 訳は原文と字数も行数も違うので、行には合わせず、本文のまとまり（領域）ごとに白い板を敷いて縦書きで流し込む。
// 板は翻刻の行矩形から作るので、板の外（挿絵）は画像のまま見える。現代語訳がまだ無いページ（解説を依頼していない）では何も載せない。
// 解説の段落に行番号（[15-22] など）が付いていれば、その段落はその行の板にだけ入れる（枠内の本文は枠内に、せりふはその場所に）。
// 文字サイズは段落ごとに、その板に収まる最大の大きさ（板いっぱいに入り、すき間が残りにくい）。
// 付いていない古い解説は、本文の領域を読み順（右から左、縦に重なる領域は上から下）に並べて順に流し込む
const COLUMN_PITCH = 1.15;  // 列の間隔（文字サイズに対する倍率）
const REGION_GAP = 1.0;     // この間隔（隣り合う2行のうち太い方の行幅に対する倍率）より近い行は同じ領域にまとめる。
                            // ページ全体の標準の行幅だと、細いふりがなが多いページで太い本文の行どうしがつながらない
const REGION_MIN = 4;       // 行番号が無いとき、行の長さの合計がこれ（標準の行幅の何文字分）に満たない領域は挿絵の中の題などとみなして使わない
const MIN_ROWS = 4;         // これより少ない文字数しか入らない短い列（行の切れ端）には訳を入れない
const RUBY_WIDTH = 0.75;    // すぐ横の本文の行の、この割合より細く、かつ
const RUBY_HEIGHT = 0.5;    // この割合より短い行はふりがなとみなして板に使わない
const LINE_REF = /^[[［]\s*([\d\s,，、\-–〜~]+?)\s*[\]］]\s*/;  // 段落の先頭の行番号（例: [1-9]、[3, 7-8]）

// 解説の「現代語訳」の節（見出しから次の見出しまで）を取り出し、Markdown の装飾を外して段落 {text, lines} の配列にする。
// lines は段落の先頭の行番号が指す行（無ければ null）
function translationParagraphs() {
  const lines = (current.interpretation || '').split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s.*現代語訳/.test(l));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').replace(/[*_`>]/g, '').replace(/\s*\n\s*/g, '').trim())
    .filter((p) => p && !/^-+$/.test(p))
    .map((p) => {
      const ref = p.match(LINE_REF);
      return { text: expandContinued(p.replace(LINE_REF, '').replace(UNCERTAIN, UNCERTAIN_MARK)), lines: ref ? lineRefs(ref[1]) : null };
    })
    .filter((p) => p.text);
}

// 「1-9」「3, 7-8」を行（current.lines の要素）の配列にする。範囲外の番号は無視する
function lineRefs(ref) {
  const lines = ref.split(/[,，、]/).flatMap((part) => {
    const [from, to = from] = part.split(/[-–〜~]/).map((n) => parseInt(n, 10));
    return Number.isNaN(from) || Number.isNaN(to) ? [] : Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k);
  }).map((n) => current.lines[n - 1]).filter(Boolean);
  return lines.length ? [...new Set(lines)] : null;
}

// 領域。上下が半分以上重なり、間が狭い行どうしをまとめ、読み順（右から左、縦に重なる領域は上から下）に並べる。
// 板の形は翻刻の行矩形から作る: 行の上下端はそのまま、隣の行との隙間だけ中間で分けて埋めた帯（strip）を並べる。
// 外枠の矩形にしないので、行が短い所の下（挿絵）は覆わない
function textRegions(lines, base) {
  const root = lines.map((_, i) => i);
  const find = (i) => (root[i] === i ? i : (root[i] = find(root[i])));
  lines.forEach((a, i) => lines.slice(i + 1).forEach((b, k) => {
    const gap = Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2);
    if (sideBySide(a, b) && gap < Math.max(a.x2 - a.x1, b.x2 - b.x1) * REGION_GAP) root[find(i + 1 + k)] = find(i);
  }));
  const groups = new Map();
  lines.forEach((l, i) => groups.set(find(i), [...(groups.get(find(i)) || []), l]));
  const pad = base * 0.15;
  const regions = [...groups.values()].map((group) => {
    const sorted = [...group].sort((a, b) => b.x2 - a.x2);  // 右の行から
    // 左右の境目は、横に並ぶ（上下が半分以上重なる）いちばん近い行との中間。上下に積み重なった行は境目に使わない
    const beside = (l, side) => group.filter((o) => o !== l && sideBySide(l, o) && (side > 0 ? o.x1 >= l.x1 : o.x2 <= l.x2))
      .sort((a, b) => (side > 0 ? a.x1 - b.x1 : b.x2 - a.x2))[0];
    const strips = sorted.map((l) => {
      const right = beside(l, 1), left = beside(l, -1);
      return {
        line: l,
        x2: right ? (right.x1 + l.x2) / 2 : l.x2 + pad,
        x1: left ? (l.x1 + left.x2) / 2 : l.x1 - pad,
        y1: l.y1 - pad, y2: l.y2 + pad,
      };
    });
    fillNotches(strips);
    separateStacked(strips);
    return regionOf(strips);
  });
  return regions.sort(readingOrder);
}

// 段落の領域のうち、同じ列に上下に続く領域（左右が半分以上重なり、間が行幅 3 つ分まで）を 1 つにまとめる。
// 料理書の項目番号「九十五」のように、本文と離れた小さな行が別の領域になると、番号と料理名・本文が同じ列につながらない
function joinStacked(regions, base) {
  const joined = [];
  for (const r of regions) {
    const near = joined.find((j) => {
      const overlapX = Math.min(j.x2, r.x2) - Math.max(j.x1, r.x1);
      const gapY = Math.max(j.y1, r.y1) - Math.min(j.y2, r.y2);
      return overlapX > Math.min(j.x2 - j.x1, r.x2 - r.x1) / 2 && gapY < base * 3;
    });
    if (near) joined[joined.indexOf(near)] = regionOf([...near.strips, ...r.strips]);
    else joined.push(r);
  }
  return joined.sort(readingOrder);
}

// 領域の読み順: 右から左。左右が半分以上重なる（上下に積み重なった）領域どうしは上から下
function readingOrder(a, b) {
  const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  return overlapX > Math.min(a.x2 - a.x1, b.x2 - b.x1) / 2 ? a.y1 - b.y1 : b.x2 - a.x2;
}

// 横に並んでいる（上下が、短い方の行の半分以上重なる）か
function sideBySide(a, b) {
  return Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > Math.min(a.y2 - a.y1, b.y2 - b.y1) / 2;
}

// 上下に積み重なった行（左右が重なり、横に並んではいない）の帯は、間の中ほどで区切って重ならないようにする
function separateStacked(strips) {
  for (const s of strips) {
    for (const t of strips) {
      const below = t.line.y1 + t.line.y2 > s.line.y1 + s.line.y2;
      if (t === s || !below || sideBySide(s.line, t.line) || Math.min(s.x2, t.x2) <= Math.max(s.x1, t.x1)) continue;
      const mid = (s.line.y2 + t.line.y1) / 2;
      s.y2 = Math.min(s.y2, mid);
      t.y1 = Math.max(t.y1, mid);
    }
  }
}

// 帯の集まりを領域にする（外接矩形と、行の長さの合計を持たせる）
function regionOf(strips) {
  return {
    strips, length: strips.reduce((sum, s) => sum + s.line.y2 - s.line.y1, 0),
    x1: Math.min(...strips.map((s) => s.x1)), x2: Math.max(...strips.map((s) => s.x2)),
    y1: Math.min(...strips.map((s) => s.y1)), y2: Math.max(...strips.map((s) => s.y2)),
  };
}

// 短い行の上下にできる凹みを埋めて訳文の場所にする。両側にそれより長い帯があるときだけ、低い方の端まで伸ばす
// （雨水が溜まる所だけ埋めるのと同じ）。領域の外側の縁はそのままなので、その先の挿絵は覆わない
function fillNotches(strips) {
  const scan = (key, pick) => {
    const fromRight = strips.map((s) => s[key]).map((v, i, a) => pick(...a.slice(0, i + 1)));
    const fromLeft = strips.map((s) => s[key]).map((v, i, a) => pick(...a.slice(i)));
    return strips.map((_, i) => [fromRight[i], fromLeft[i]]);
  };
  const bottoms = scan('y2', Math.max), tops = scan('y1', Math.min);
  strips.forEach((s, i) => {
    s.y2 = Math.max(s.y2, Math.min(...bottoms[i]));
    s.y1 = Math.min(s.y1, Math.max(...tops[i]));
  });
}

// 文字サイズ f で置ける列（右から左、領域は並び順）。MIN_ROWS 文字も入らない短い列（行の切れ端）は使わない。
// 列の上下: 列の中心線に掛かる帯の上下をつないだ範囲（上下に積み重なった帯は 1 本につなぐ。目録の番号の枠と項目名など）の
// うち、最も長いところを使う。列は帯の境目とずれて並ぶので、端で判定すると細い見出しの行と枠をまたぐ列が使えなくなる
function regionColumns(regions, f, spacing) {
  const pitch = f * COLUMN_PITCH, step = f * (1 + spacing), pad = f * 0.2;
  return regions.flatMap(({ strips, x1: left, x2: right }) => (
    Array.from({ length: Math.max(0, Math.floor((right - left - pad * 2) / pitch)) }, (_, k) => {
      const x2 = right - pad - k * pitch, x1 = x2 - pitch;
      // 番号・見出しと本文の間の空白（文字 3 つ分まで）はつなぐ（目録や料理書の「九十四 → 油煠ながし → 本文」など）
      const spans = spansAt(strips, x2 - pitch / 2, pitch * 3);
      const span = spans.reduce((best, s) => (!best || s[1] - s[0] > best[1] - best[0] ? s : best), null);
      if (!span) return { rows: 0 };  // 段落の帯が飛び飛びのとき、間の列は使わない
      const y1 = span[0] + pad, y2 = span[1] - pad;
      return { x: x2 - pitch / 2, y: y1, rows: Math.floor((y2 - y1) / step) };
    })
  )).filter((c) => c.rows >= MIN_ROWS);
}

// 横位置 x に掛かる帯の上下の範囲 [[y1, y2], ...]（上から順）。間が gap 以下の帯はつなぐ
function spansAt(strips, x, gap) {
  const spans = [];
  for (const [y1, y2] of strips.filter((s) => s.x1 <= x && x <= s.x2).map((s) => [s.y1, s.y2]).sort((a, b) => a[0] - b[0])) {
    const last = spans[spans.length - 1];
    if (last && y1 <= last[1] + gap) last[1] = Math.max(last[1], y2);
    else spans.push([y1, y2]);
  }
  return spans;
}

// 禁則: 列の頭に置かない文字（句読点・閉じ括弧など）と、列の末に置かない文字（開き括弧）
const NO_COLUMN_START = new Set([...'、。，．,.：:；;）)」』】〕］]〉》｝}？！?!…‥']);
const NO_COLUMN_END = new Set([...'（(「『【〔［[〈《｛{']);

// 列に入れる文字数（マスの数）。次の列の頭に句読点などが来る、または列の末が開き括弧になるときは、手前の文字ごと次の列へ送る（追い出し）
// cells はマスの並び（推定の印は直前の文字のマスに含める）
function columnLength(cells, pos, rows) {
  let n = Math.min(rows, cells.length - pos);
  if (pos + n >= cells.length) return n;
  while (n > 1 && (NO_COLUMN_START.has(cells[pos + n][0]) || NO_COLUMN_END.has(cells[pos + n - 1][0]))) n--;
  return n;
}

// 文字列をマスに分ける。推定の印はマスを取らず、直前の文字のマスに付ける
function toCells(text) {
  const cells = [];
  for (const ch of text) {
    if (ch === UNCERTAIN_MARK && cells.length) cells[cells.length - 1] += ch;
    else cells.push(ch);
  }
  return cells;
}

// 文字サイズ f で、板（block）にその訳を流し込む（段落は新しい列から）。収まらなければ null
function flowBlock(block, f, spacing) {
  const columns = regionColumns(block.regions, f, spacing);
  const out = [];
  let c = 0;
  for (const text of block.texts) {
    const cells = toCells(text);
    for (let pos = 0; pos < cells.length; c++) {
      if (c >= columns.length) return null;
      const n = columnLength(cells, pos, columns[c].rows);
      out.push({ ...columns[c], text: cells.slice(pos, pos + n).join('') });
      pos += n;
    }
  }
  return out;
}

// 段落ごとの板の文字サイズをそろえる。段落ごとに板に収まる最大の大きさを決めると、同じ本文のまとまりの中で大きさがばらつく。
// - 同じまとまり（ページ全体で見た領域）の段落は、代表の大きさ（文字数で重み付けした中央値）にそろえる（大きい段落は下げる）
// - 細い枠に長い訳が当たって代表よりずっと小さくなる段落は、前後の段落のうち左へ続く本文（本文の続き）とまとめて場所を分け合う。
//   年記・署名・目録のように位置が前後する段落はまとめない（訳が別の場所に流れ込むため）。
//   目録・献立の項目のような短い段落も、まとめると項目が混ざるのでまとめない（その段落の大きさのまま）
const CRAMPED = 0.75;       // 代表のこの割合より小さくなる段落を、窮屈とみなす
const MERGE_MIN_CHARS = 20; // 窮屈な段落がこれより短ければまとめない
function harmonizeBlocks(blocks, pageRegions, regionsOf, base, maxFontSize, spacing) {
  const regionOfLine = new Map(pageRegions.flatMap((r, i) => r.strips.map((s) => [s.line, i])));
  const keyOf = (b) => regionOfLine.get(b.lines.find((l) => regionOfLine.has(l))) ?? `own${blocks.indexOf(b)}`;
  const fit = (b) => { b.regions = regionsOf(b.lines); b.fit = fitBlock(b, maxFontSize, spacing).fontSize; return b; };
  const textLength = (b) => b.texts.join('').length;
  const typical = (group) => {
    const sorted = [...group].sort((a, b) => a.fit - b.fit);
    const half = sorted.reduce((sum, b) => sum + textLength(b), 0) / 2;
    let acc = 0;
    return sorted.find((b) => (acc += textLength(b)) >= half).fit;
  };
  const groups = new Map();
  blocks.forEach((b) => { fit(b); groups.set(keyOf(b), [...(groups.get(keyOf(b)) || []), b]); });
  const result = [];
  for (const group of groups.values()) {
    const size = typical(group);
    const merged = [];
    for (const b of group) {
      const prev = merged[merged.length - 1];
      // 本文の続き: 前の段落のすぐ左の列にあり（間は 1.5 行幅まで）、上下が重なっている
      const right = prev && Math.max(...b.lines.map((l) => l.x2)), left = prev && Math.min(...prev.lines.map((l) => l.x1));
      const follows = prev && right <= left + base * 0.5 && left - right < base * 1.5
        && Math.min(...prev.lines.map((l) => l.y2), ...b.lines.map((l) => l.y2)) > Math.max(...prev.lines.map((l) => l.y1), ...b.lines.map((l) => l.y1));
      const cramped = [prev, b].filter((x) => x && x.fit < size * CRAMPED);
      if (follows && cramped.length && cramped.every((x) => textLength(x) >= MERGE_MIN_CHARS)) {
        prev.lines.push(...b.lines);
        prev.texts.push(...b.texts);
        fit(prev);
      } else {
        merged.push(b);
      }
    }
    merged.forEach((b) => { b.fontSize = Math.min(b.fit, size); });
    result.push(...merged);
  }
  return result;
}

// 板に収まる最大の文字サイズ（上限は maxFontSize）を二分探索で求める。板いっぱいに入るので、すき間が残りにくい
function fitBlock(block, maxFontSize, spacing) {
  const best = flowBlock(block, maxFontSize, spacing);
  if (best) return { fontSize: maxFontSize, columns: best };
  let lo = 1, hi = maxFontSize;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (flowBlock(block, mid, spacing)) lo = mid; else hi = mid;
  }
  return { fontSize: lo, columns: flowBlock(block, lo, spacing) || [] };
}

// ふりがなの行 = 本文の行のすぐ横にあり、それより細くて短い行。挿絵の中のせりふのように細い行どうしが並ぶだけなら本文扱い
function isRuby(l, lines) {
  const w = l.x2 - l.x1, h = l.y2 - l.y1;
  return lines.some((b) => {
    const bw = b.x2 - b.x1;
    return w < bw * RUBY_WIDTH && h < (b.y2 - b.y1) * RUBY_HEIGHT
      && Math.min(l.y2, b.y2) - Math.max(l.y1, b.y1) > h / 2 && Math.max(l.x1, b.x1) - Math.min(l.x2, b.x2) < bw / 2;
  });
}

// 行番号付きなら段落ごとにその行の板へ、無ければ本文の領域すべてへ順に流し込んで描く。文字サイズは板ごとに収まる最大の大きさ
// ---------- 英訳（解説タブの English）----------
// 現代語訳の英訳（current.english。段落の先頭に現代語訳と同じ行番号）を段落ごとに並べ、行と連動させる:
// 画像の上の行・行一覧にマウスを乗せると、その行を訳した段落をハイライトして見える位置まで送る（setHover）。
// 段落にマウスを乗せると、その段落の行を画像の上でハイライトする
// 「(continued on next page)」などの断り書きは「……」にする（現代語訳のレイヤーと同じ）
const ENGLISH_CONTINUED = /…*\s*\((?:continued|cont\.)[^()]*\)\s*…*/gi;
const COMMENTARY_LANG_KEY = 'commentaryLang';
let commentaryLang = loadSetting(COMMENTARY_LANG_KEY) || (lang === 'en' ? 'en' : 'ja');

function englishParagraphs() {
  return (current.english || '').split(/\n\s*\n/)
    .map((p) => p.replace(/[*_`>]/g, '').replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((p) => {
      const ref = p.match(LINE_REF);
      return { text: p.replace(LINE_REF, '').replace(ENGLISH_CONTINUED, '……'), lines: (ref && lineRefs(ref[1])) || [] };
    });
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function renderEnglishList() {
  const hasEnglish = Boolean(current.english);
  ui.commentaryLang.hidden = !hasEnglish;
  ui.englishBody.replaceChildren(...englishParagraphs().map((p) => {
    const indexes = p.lines.map((l) => current.lines.indexOf(l)).filter((i) => i >= 0);
    const para = document.createElement('p');
    para.innerHTML = escapeHtml(p.text).replace(/\(\?\)/g, `<span class="uncertain" title="${t('推定で読んだ箇所')}">?</span>`);
    linkParagraph(para, indexes);
    return para;
  }));
  showCommentaryLang(hasEnglish ? commentaryLang : 'ja');
}

function showCommentaryLang(code) {
  ui.interpretBody.hidden = code === 'en';
  ui.englishBody.hidden = code !== 'en';
  ui.commentaryLang.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.clang === code));
}

// 要素を、それをスクロールさせている欄の縦の中央付近に送る。すでに中央の 1/3 に入っていれば動かさない（行を移るたびに揺れないように）
function scrollToCenter(el) {
  const pane = el.closest('.tab');
  // スマホ幅では欄ではなくページ全体がスクロールする
  if (!pane || pane.scrollHeight <= pane.clientHeight) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
  const box = pane.getBoundingClientRect(), r = el.getBoundingClientRect();
  const center = r.top + r.height / 2;
  if (center > box.top + box.height / 3 && center < box.bottom - box.height / 3) return;
  pane.scrollBy({ top: center - (box.top + box.height / 2), behavior: 'smooth' });
}

// 訳の段落と画像の上の行を連動させる: 段落にマウスを乗せると訳している行をハイライトし、押すとその行を選ぶ
function linkParagraph(para, indexes) {
  para.dataset.lines = indexes.join(',');
  para.classList.add('linked');
  para.addEventListener('mouseenter', () => indexes.forEach((i) => setLineHover(i, true)));
  para.addEventListener('mouseleave', () => indexes.forEach((i) => setLineHover(i, false)));
  para.addEventListener('click', () => { if (indexes.length) select(indexes[0]); });
}

// 日本語の解説の「現代語訳」の節の段落（先頭に行番号の付いたもの）を、行と連動させる
function linkTranslationParagraphs() {
  let inTranslation = false;
  for (const node of ui.interpretBody.children) {
    if (/^H[1-6]$/.test(node.tagName)) { inTranslation = node.textContent.includes('現代語訳'); continue; }
    if (!inTranslation) continue;
    for (const para of node.matches('p') ? [node] : node.querySelectorAll('li, p')) {
      const ref = para.textContent.trim().match(LINE_REF);
      if (ref) linkParagraph(para, (lineRefs(ref[1]) || []).map((l) => current.lines.indexOf(l)).filter((i) => i >= 0));
    }
  }
}

// 表示中の訳（日本語の解説か英訳）の段落のうち、行 i を訳しているもの
const linkedParasOf = (i) => [...document.querySelectorAll('#interpret-body .linked, #english-body .linked')]
  .filter((p) => !p.closest('[hidden]') && p.dataset.lines.split(',').includes(String(i)));

function renderTranslation(base, fontScale, spacing, opacity) {
  const paragraphs = translationParagraphs();
  if (!paragraphs.length || !current.lines.length) return;
  // 板の形はページ全体で先に決める（ふりがなを除いた行を並べ、隣の行との間は中間で分けて埋める）。
  // 段落はそのうち自分の行の帯を受け持つので、隣の段落の板とすき間なく接する
  const pageRegions = textRegions(current.lines.filter((l) => !isRuby(l, current.lines)), base);
  let blocks;
  if (paragraphs.every((p) => p.lines)) {
    const regionsOf = (lines) => {
      const own = new Set(lines);
      // 段落の行だけの帯で領域を作り直し、読み順も段落の中だけで並べ直す。ページ全体の並びは領域が多く、
      // この比べ方では順序が崩れることがある（右上の行より左下の行の領域が先になり、訳の途中から流し込まれる）
      const regions = joinStacked(pageRegions.map((r) => r.strips.filter((s) => own.has(s.line))).filter((strips) => strips.length)
        .map(regionOf).sort(readingOrder), base);
      return regions.length ? regions : textRegions(lines, base);  // ふりがなの行だけの段落は、その行で板を作る
    };
    // 文が行の途中で切り替わると、隣り合う段落が同じ行を指す（[1-2] と [2-12] など）。
    // 重ならないよう、その行は先の段落だけが使う。使える行が無くなった段落（1行に2人のせりふなど）は、
    // その行を使っている段落の後ろに、改行せず同じ列で続けて流し込む（原文で 1 行に縦に並んでいるので、
    // 新しい列にすると横に並んでしまう。目録の「三十 絹ごし豆腐　三十一 油揚げ田楽」など）。間は全角の空白 1 つ
    const owner = new Map();  // 行 → その行を使う段落の block
    blocks = [];
    for (const p of paragraphs) {
      const own = p.lines.filter((l) => !owner.has(l));
      if (!own.length) {
        const texts = owner.get(p.lines[0]).texts;
        texts[texts.length - 1] += `　${p.text}`;
        continue;
      }
      const block = { lines: own, texts: [p.text] };
      own.forEach((l) => owner.set(l, block));
      blocks.push(block);
    }
    blocks = harmonizeBlocks(blocks, pageRegions, regionsOf, base, base * fontScale, spacing);
  } else {
    const main = pageRegions.filter((r) => r.length >= base * REGION_MIN);
    blocks = [{ regions: main.length ? main : pageRegions, texts: paragraphs.map((p) => p.text) }];
  }
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('translation');
  // 段落の行にはすべて板を敷く（訳が入りきって余った行の原文も隠す）
  for (const s of blocks.flatMap((b) => b.regions).flatMap((r) => r.strips)) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', s.x1); rect.setAttribute('y', s.y1);
    rect.setAttribute('width', s.x2 - s.x1); rect.setAttribute('height', s.y2 - s.y1);
    rect.setAttribute('fill-opacity', opacity);
    g.append(rect);
  }
  for (const block of blocks) {
    // 文字サイズは harmonizeBlocks がそろえたもの（行番号の無い古い解説は、板に収まる最大の大きさ）
    // そろえた大きさで流し込めないときは（禁則の追い出しなどで、小さくしても収まり方が変わることがある）、板に収まる大きさにする
    const aligned = block.fontSize && flowBlock(block, block.fontSize, spacing);
    const { fontSize, columns } = aligned ? { fontSize: block.fontSize, columns: aligned } : fitBlock(block, base * fontScale, spacing);
    for (const c of columns) g.append(verticalText(c.x, c.y, c.rows * fontSize * (1 + spacing), fontSize, spacing, c.text));
  }
  ui.overlay.append(g);
}

function renderLineList() {
  ui.lineList.innerHTML = '';
  lineTexts().forEach((text, i) => {
    const li = document.createElement('li');
    li.textContent = text;
    li.dataset.index = i;
    li.addEventListener('mouseenter', () => setHover(i, true));
    li.addEventListener('mouseleave', () => setHover(i, false));
    li.addEventListener('click', () => select(i));
    ui.lineList.appendChild(li);
  });
}

function setLineHover(i, on) {
  document.querySelectorAll(`[data-index="${i}"]`).forEach((el) => el.classList.toggle('hover', on));
}

// 行のハイライト。解説タブに訳（日本語の現代語訳・英訳）を表示中なら、その行を訳した段落もハイライトして見える位置まで送る。
// 段落のハイライトは、行からマウスが外れても PARA_LINGER_MS だけ残す（細い行の間を動くたびに点滅しないように）。
// その間に同じ段落の行へ移れば続け、別の段落の行へ移ればすぐ切り替える。スクロールは段落が変わったときだけ
const PARA_LINGER_MS = 300;
let litParas = [];
let paraTimer = null;
function setHover(i, on) {
  setLineHover(i, on);
  clearTimeout(paraTimer);
  if (!on) {
    paraTimer = setTimeout(() => { litParas.forEach((p) => p.classList.remove('hover')); litParas = []; }, PARA_LINGER_MS);
    return;
  }
  const paras = linkedParasOf(i);
  const changed = paras.some((p) => !litParas.includes(p));
  litParas.filter((p) => !paras.includes(p)).forEach((p) => p.classList.remove('hover'));
  paras.forEach((p) => p.classList.add('hover'));
  litParas = paras;
  // 段落が欄の中央に来るよう送る（端に寄ると読みにくい）。もう中央付近に見えていれば動かさない。解説タブを開いているときだけ
  if (changed && paras.length && ui.interpretBody.closest('.tab').classList.contains('active')) scrollToCenter(paras[0]);
}

function select(i) {
  document.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelectorAll(`[data-index="${i}"]`).forEach((el) => el.classList.add('selected'));
  linkedParasOf(i).forEach((p) => p.classList.add('selected'));
  ui.lineList.children[i]?.scrollIntoView({ block: 'nearest' });
}

// ---------- LLM 解説 ----------
// 解説の実行状態はサーバーが一元管理する（同じページの二重起動防止、ページ遷移・リロード・別端末でも継続）。
// ここでは表示中ページの状態を取得して描画し、実行中ならポーリングで途中経過を反映するだけ。
let pollTimer = null;
const POLL_MS = 1500;

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function renderInterpret(state) {
  const busy = state.status === 'queued' || state.status === 'running';
  ui.interpretBtn.disabled = ui.reinterpretBtn.disabled = busy;
  if (state.status === 'none' || state.status === 'error') {
    ui.interpretBody.innerHTML = '';
    ui.interpretStatus.textContent = '';
    if (state.status === 'error') setStatus(state.error, true);
    return;
  }
  ui.interpretBody.innerHTML = renderMarkdown(state.markdown);
  linkTranslationParagraphs();
  if (state.status === 'done') {
    ui.interpretStatus.textContent = t(state.cached ? '保存済みの解説' : '完了');
    if (!current.interpreted) { current.interpreted = true; refreshHistory(); }
  } else {
    const e = state.elapsed || 0;
    const elapsed = e >= 60 ? t('{m}分{s}秒', { m: Math.floor(e / 60), s: String(e % 60).padStart(2, '0') }) : t('{s}秒', { s: e });
    const progress = state.markdown ? ` / ${t('{n} 文字', { n: state.markdown.length })}` : '';
    ui.interpretStatus.textContent = `${t(state.phase)}… ${t('経過')} ${elapsed}${progress}`;
  }
}

// state を省略するとサーバーに問い合わせる。取得中に別ページへ移動していたら結果は捨てる
async function syncInterpret(state) {
  if (!current) return;
  const id = current.id;
  stopPolling();
  try { state = state || await backend.getInterpret(id); }
  catch (e) { setStatus(e.message, true); return; }
  if (current?.id !== id) return;
  if (current.interpretation !== (state.markdown || '')) {
    current.interpretation = state.markdown || '';
    if (ui.layer.value === 'translation') renderOverlay();
  }
  if (manualInterpret) {
    ui.copyPrompt.disabled = false;
    renderManual(current.interpretation);
    return;
  }
  renderInterpret(state);
  if (state.status === 'queued' || state.status === 'running') pollTimer = setTimeout(() => syncInterpret(), POLL_MS);
}

async function interpret(force) {
  if (!current) return;
  const id = current.id;
  ui.interpretBtn.disabled = ui.reinterpretBtn.disabled = true;
  try {
    const state = await backend.startInterpret(id, force);
    if (current?.id !== id) return;
    if (force) { current.interpreted = false; refreshHistory(); }
    syncInterpret(state);
  } catch (e) {
    setStatus(e.message, true);
    if (current?.id === id) syncInterpret();
  }
}

// manual 方式: 保存済みなら本文を表示し、無ければ貼り付け欄を出す
function renderManual(markdown) {
  ui.interpretBody.innerHTML = renderMarkdown(markdown);
  linkTranslationParagraphs();
  ui.interpretEditor.hidden = Boolean(markdown);
  ui.editInterpret.hidden = !markdown;
  ui.cancelInterpret.hidden = true;
  ui.interpretInput.value = '';
}

async function copyPrompt() {
  if (!current) return;
  try {
    await navigator.clipboard.writeText(await backend.buildPrompt(current));
    setStatus(t('依頼文をコピーしました。LLM に貼り付けてください'));
  } catch (e) { setStatus(e.message, true); }
}

function editInterpret() {
  ui.interpretInput.value = current.interpretation || '';
  ui.interpretEditor.hidden = false;
  ui.cancelInterpret.hidden = false;
  ui.interpretInput.focus();
}

// 空で保存すると削除になる
async function saveInterpret() {
  if (!current) return;
  const id = current.id;
  let saved;
  try { saved = await backend.saveInterpret(id, ui.interpretInput.value.trim()); } catch (e) { setStatus(e.message, true); return; }
  if (current?.id !== id) return;
  current.interpreted = Boolean(saved.markdown);
  current.interpretation = saved.markdown;
  current.english = saved.english;
  renderManual(saved.markdown);
  renderEnglishList();
  renderOverlay();
  refreshHistory();
}

// ---------- 履歴 ----------
async function refreshHistory() {
  const pages = await backend.listPages();
  ui.historyList.replaceChildren(...pages.map((p) => {
    const label = p.source_type === 'ndl' ? `${p.name || `NDL ${p.pid}`} ${t('コマ{page}', { page: p.page })}`
      : p.source_type === 'pdf' ? `${p.name || 'PDF'} p.${p.page}` : p.name;
    const item = el('button', { type: 'button', role: 'menuitem', className: p.id === current?.id ? 'current' : '' }, [
      el('span', { className: 'label', textContent: `${p.interpreting ? '⏳ ' : p.interpreted ? '🤖 ' : ''}${label}` }),
      el('span', { className: 'excerpt', textContent: p.excerpt }),
    ]);
    item.addEventListener('click', () => { toggleHistory(false); loadHistory(p.id); });
    return item;
  }));
}

// 履歴のメニューの開け閉め。メニューの外を押すか Esc で閉じる
function toggleHistory(open = ui.historyList.hidden) {
  ui.historyList.hidden = !open;
  ui.historyBtn.setAttribute('aria-expanded', String(open));
}
ui.historyBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHistory(); });
document.addEventListener('click', (e) => { if (!ui.historyList.hidden && !e.target.closest('.history-menu')) toggleHistory(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ui.historyList.hidden) toggleHistory(false); });

// ---------- イベント ----------
// 保存値が選択肢にあるときだけ復元する（選択肢を変えた後に古い値が残っていても既定値に戻る）
// select・ラジオボタン（RadioNodeList）のどちらにも使える
function restoreSelect(control, key) {
  const saved = loadSetting(key);
  const before = control.value;
  if (saved === null) return;
  control.value = saved;
  if (control.value !== saved) control.value = before;
}
// コマ番号を入力して Enter で、表示中の資料のそのコマへ移る
ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (current?.source_type === 'pdf') loadPdf(current.pid, Number(ui.page.value));
  else loadNdl(ui.pid.value, Number(ui.page.value));
});
ui.pageSelect.addEventListener('change', () => goToPage(Number(ui.pageSelect.value)));
// ---------- コマ送り（綴じ方向で矢印の向きが変わる） ----------
// 右開き（縦書き）: ◀ = 次のコマ, ▶ = 前のコマ / 左開き（横書き）: その逆
function movePage(delta) {
  if (isPageable(current)) goToPage(Number(ui.page.value) + delta);
}

// 速くめくったときは、めくり終わったページだけを読み込む（通り過ぎたページの画像まで NDL などから取りに行かない）。
// コマ番号の表示はすぐ変える
const PAGE_SETTLE_MS = 300;
let pageTimer = null;
function goToPage(page) {
  if (page < 1 || (current.page_count && page > current.page_count)) return;  // 最終コマを超えて進まない
  ui.page.value = page;
  clearTimeout(pageTimer);
  pageTimer = setTimeout(() => ui.form.requestSubmit(), PAGE_SETTLE_MS);
}
function applyBinding() {
  const rtl = ui.binding.value === 'rtl';
  ui.thumbs.classList.toggle('rtl', rtl);  // 右開きはコマ 1 を右端に置く
  for (const [button, label] of [[ui.navLeft, t(rtl ? '次のコマ' : '前のコマ')], [ui.navRight, t(rtl ? '前のコマ' : '次のコマ')]]) {
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  saveSetting('binding', ui.binding.value);
}
restoreSelect(ui.binding, 'binding');
applyBinding();
ui.binding.addEventListener('change', applyBinding);
ui.navLeft.addEventListener('click', () => movePage(ui.binding.value === 'rtl' ? 1 : -1));
ui.navRight.addEventListener('click', () => movePage(ui.binding.value === 'rtl' ? -1 : 1));
ui.edgeLeft.addEventListener('click', () => ui.navLeft.click());
ui.edgeRight.addEventListener('click', () => ui.navRight.click());
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || !isPageable(current)) return;
  if (e.key === 'ArrowLeft') ui.navLeft.click();
  if (e.key === 'ArrowRight') ui.navRight.click();
});
// 自動翻刻オフで開いた OCR 未実行のページは、レイヤーを「翻刻」にするか自動翻刻をオンにした時点で翻刻を依頼する
function ocrIfNeeded() {
  if (current?.ocr_done === false) enqueueOcr(current);
}
restoreSelect(ui.layer, 'layer');
// 既定は backend.autoOcrDefault（個人版はオン、ブラウザ保存版はオフ）。切り替えた人はその選択（change で保存）
ui.autoOcr.checked = (loadSetting('autoOcr') ?? (backend.autoOcrDefault ? '1' : '0')) === '1';
ui.layerForm.addEventListener('change', () => {
  saveSetting('layer', ui.layer.value);
  renderOverlay();
  if (ui.layer.value === 'transcription') ocrIfNeeded();
});
// 数字キー 1・2・3 でレイヤー（なし・翻刻・現代語訳）を切り替える。キーはツールチップにも出す
[...ui.layer].forEach((radio, i) => { radio.nextElementSibling.title += ` (${i + 1})`; });
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input:not([type=radio]), select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const radio = ui.layer[Number(e.key) - 1];
  if (!radio || radio.checked) return;
  radio.checked = true;
  ui.layerForm.dispatchEvent(new Event('change'));
});
// ブラウザ保存版のお知らせ: 自動翻刻がオフなら翻刻のしかた、オンなら翻刻時の画像の扱い（backend.notice）
const AUTO_OCR_HINT = '翻刻をする場合は「自動翻刻」をオンにしてページをめくってください。';
function renderNotice() {
  ui.notice.textContent = t(ui.autoOcr.checked ? backend.notice : AUTO_OCR_HINT);
}
ui.notice.hidden = !backend.notice;
if (backend.notice) renderNotice();
ui.autoOcr.addEventListener('change', () => {
  saveSetting('autoOcr', ui.autoOcr.checked ? '1' : '0');
  if (backend.notice) renderNotice();
  if (ui.autoOcr.checked) ocrIfNeeded();
});
ui.useCorrected.addEventListener('change', renderText);
ui.opacity.addEventListener('input', renderOverlay);
ui.fontScale.addEventListener('input', renderOverlay);
ui.letterSpacing.addEventListener('input', renderOverlay);
// レイヤーの文字色・背景色は CSS 変数で切替（再描画不要）。設定はブラウザに保存
for (const [control, cssVar, key] of [[ui.textColor, '--tr-color', 'textColor'], [ui.bgColor, '--tr-bg', 'bgColor']]) {
  const apply = () => document.documentElement.style.setProperty(cssVar, control.value);
  restoreSelect(control, key);
  apply();
  // 選び直したときだけ保存する（開いただけで既定値を保存すると、あとで既定値を変えても反映されない）
  control.addEventListener('change', () => { apply(); saveSetting(key, control.value); });
}
// ---------- 縮小画像の帯 ----------
// 全コマの枠を並べ、画面に見えている枠の縮小画像だけを読み込む。スクロールして新しく見えた枠はその都度読み込む。
// 縮小画像を作る側（NDL の IIIF・個人版サーバーの PDF 変換・ブラウザ保存版の pdf.js）に負荷をかけないよう、行儀よく取得する:
// スクロール中は取りに行かず、止まって THUMB_SETTLE_MS たってから、見えている枠だけを同時に THUMB_CONCURRENCY 件まで、
// 1 件ごとに THUMB_INTERVAL_MS 空けて取る。待っている間に見えなくなった枠は取らない
const THUMB_CONCURRENCY = 2;
const THUMB_SETTLE_MS = 400;
const THUMB_INTERVAL_MS = 300;
const THUMB_PREVIEW_HEIGHT = 160;  // マウスを乗せたときの拡大表示の高さ（取得している縮小画像の原寸）
let thumbs = null;  // 表示中の資料の帯 {key, observer, queue, active}

let thumbsScrolledAt = 0;
ui.thumbs.addEventListener('scroll', () => {
  hideThumbPreview();  // スクロールで枠が動いたら位置がずれるので消す
  thumbsScrolledAt = Date.now();
  if (thumbs) pumpThumbs(thumbs);
});

function renderThumbs(data) {
  const key = isPageable(data) && data.page_count ? `${data.source_type}:${data.pid}:${data.page_count}` : null;
  ui.thumbs.hidden = !key;
  if (key !== thumbs?.key) {
    thumbs?.observer.disconnect();
    ui.thumbs.replaceChildren();
    thumbs = key ? buildThumbs(key, data) : null;
  }
  if (!thumbs) return;
  ui.thumbs.querySelector('.current')?.classList.remove('current');
  const item = ui.thumbs.children[data.page - 1];
  item.classList.add('current');
  item.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function buildThumbs(key, data) {
  const state = { key, queue: [], active: 0 };
  // 見えている間だけ読み込み待ちに入れる。見えなくなった枠は、順番が来ても読み込まない
  state.observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      target.dataset.visible = isIntersecting ? '1' : '';
      if (isIntersecting && !target.dataset.state) {
        target.dataset.state = 'queued';
        showCachedThumb(state, target);
      }
    }
  }, { root: ui.thumbs, rootMargin: '0px 200px' });

  for (let page = 1; page <= data.page_count; page++) {
    const item = el('button', { type: 'button', className: 'thumb', title: t('{page} コマ', { page }) }, [
      el('img', { alt: '' }), el('span', { textContent: page }),
    ]);
    item.dataset.page = page;
    item.addEventListener('click', () => goToPage(page));
    item.addEventListener('mouseenter', () => showThumbPreview(item));
    item.addEventListener('mouseleave', hideThumbPreview);
    ui.thumbs.append(item);
    state.observer.observe(item);
  }
  // 翻刻済みのコマと、待ち行列にあるコマに印を付ける
  for (const job of [ocrJobs.running, ...ocrJobs.queue].filter(Boolean)) {
    if (`${job.source_type}:${job.pid}:${data.page_count}` === key) ui.thumbs.children[job.page - 1].dataset.ocr = job === ocrJobs.running ? 'running' : 'queued';
  }
  backend.getBookPages(`${data.source_type}:${data.pid}`).then((pages) => {
    for (const p of pages) markThumb({ source_type: data.source_type, pid: data.pid, page: p.page }, 'done');
  });
  return state;
}

// 帯の枠は小さく表示しているので、マウスを乗せた枠だけ取得した原寸（高さ 160px）で枠の上に浮かせて出す。
// 帯は横スクロールのため中で拡大すると上下が切れる。そこで帯の外の要素に出す
function showThumbPreview(item) {
  if (item.dataset.state !== 'done') return;  // 読み込み前・失敗した枠は出さない
  const preview = ui.thumbPreview;
  const source = item.querySelector('img');
  const img = preview.querySelector('img');
  img.src = source.src;
  img.style.width = `${Math.round(THUMB_PREVIEW_HEIGHT * source.naturalWidth / source.naturalHeight)}px`;  // 読み込み前でも位置を決められるよう幅を先に決める
  preview.querySelector('span').textContent = t('{page} コマ', { page: item.dataset.page });
  preview.hidden = false;
  const rect = item.getBoundingClientRect();
  const left = rect.left + rect.width / 2 - preview.offsetWidth / 2;
  preview.style.left = `${Math.max(4, Math.min(left, window.innerWidth - preview.offsetWidth - 4))}px`;
  preview.style.top = `${Math.max(4, rect.top - preview.offsetHeight - 6)}px`;
}

function hideThumbPreview() {
  ui.thumbPreview.hidden = true;
}

// ブラウザに保存済みの縮小画像は、取得の待ち行列に入れずにすぐ出す（取りに行かないので相手に負担がかからない）。
// 保存されていなければ待ち行列に入れて、行儀よく取得する（pumpThumbs）
async function showCachedThumb(state, item) {
  const [sourceType, pid] = state.key.split(':');
  const cached = await backend.cachedThumbnailUrl(sourceType, pid, Number(item.dataset.page));
  if (cached) {
    const img = item.querySelector('img');
    img.onload = () => { item.dataset.state = 'done'; };
    img.onerror = () => { item.dataset.state = 'error'; };
    img.src = cached;
    return;
  }
  state.queue.push(item);
  pumpThumbs(state);
}

function pumpThumbs(state) {
  if (state !== thumbs || state.active >= THUMB_CONCURRENCY) return;  // 帯が別の資料に替わった・同時に取得できる数に達した
  // スクロールが止まるのと、前の取得から間隔が空くのを待つ（待ちは 1 本にまとめる）
  const wait = Math.max(thumbsScrolledAt + THUMB_SETTLE_MS, (state.lastStart || 0) + THUMB_INTERVAL_MS) - Date.now();
  if (wait > 0) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => pumpThumbs(state), wait);
    return;
  }
  let item;
  while ((item = state.queue.shift()) && !item.dataset.visible) item.dataset.state = '';  // 待っている間にスクロールで見えなくなった
  if (!item) return;
  item.dataset.state = 'loading';
  state.active++;
  state.lastStart = Date.now();
  const done = (ok) => {
    item.dataset.state = ok ? 'done' : 'error';
    state.active--;
    pumpThumbs(state);
  };
  const [sourceType, pid] = state.key.split(':');
  Promise.resolve(backend.thumbnailUrl(sourceType, pid, Number(item.dataset.page))).then(cachedImageUrl).then((url) => {
    const img = item.querySelector('img');
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  }, () => done(false));
  pumpThumbs(state);  // 次の 1 件は間隔を空けて始める
}

// ---------- 翻刻の待ち行列 ----------
// 翻刻（OCR）は裏で 1 件ずつ実行する（OCR する側も 1 件ずつしか処理しないため）。開いたページを先頭に入れて優先し、
// 通り過ぎたページも続けて処理する（戻ったときにはできている）。終わったページが表示中なら、その場で翻刻を重ねる
const ocrJobs = { queue: [], running: null };  // 要素は {key, source_type, pid, page}
const ocrKey = (d) => `${d.source_type}:${d.pid}:${d.page}`;
const isOcrPending = (d) => ocrJobs.running?.key === ocrKey(d) || ocrJobs.queue.some((job) => job.key === ocrKey(d));

function enqueueOcr(data) {
  const key = ocrKey(data);
  if (ocrJobs.running?.key === key) return;
  ocrJobs.queue = ocrJobs.queue.filter((job) => job.key !== key);
  ocrJobs.queue.unshift({ key, source_type: data.source_type, pid: data.pid, page: data.page });
  markThumb(data, 'queued');
  renderOcrProgress();
  pumpOcr();
}

const OCR_STOP_STATUS = [429, 503];  // このエラーが返ったら待ち行列を止める

async function pumpOcr() {
  if (ocrJobs.running || !ocrJobs.queue.length) return;
  const job = ocrJobs.running = ocrJobs.queue.shift();
  markThumb(job, 'running');
  renderOcrProgress();
  try {
    const data = await (job.source_type === 'pdf' ? backend.openPdf(job.pid, job.page, true) : backend.openNdl(job.pid, job.page, true));
    markThumb(job, 'done');
    if (current && ocrKey(current) === job.key) showPage(data, true);
  } catch (e) {
    if (OCR_STOP_STATUS.includes(e.status)) {
      // 回数の上限・NDL の混雑: 続けても同じエラーになるので、待っているページは取りやめて 1 回だけ知らせる。
      // 取りやめたページは、もう一度開いたとき（または自動翻刻・翻刻レイヤーに切り替えたとき）に改めて依頼する
      [job, ...ocrJobs.queue].forEach((j) => markThumb(j, ''));
      ocrJobs.queue = [];
      ocrJobs.running = null;
      renderOcrProgress();
      setStatus(e.message, true);
      return;
    }
    markThumb(job, 'error');
    setStatus(t(job.source_type === 'pdf' ? '{page} ページ目の翻刻に失敗しました: {error}' : '{page} コマ目の翻刻に失敗しました: {error}', { page: job.page, error: e.message }), true);
  }
  ocrJobs.running = null;
  renderOcrProgress();
  pumpOcr();
}

// 進捗はページ情報の横（翻刻中のコマと待ちの件数）と、縮小画像の帯の印（markThumb）で見せる
function renderOcrProgress() {
  const { running, queue } = ocrJobs;
  ui.ocrProgress.hidden = !running;
  if (running) {
    const unit = running.source_type === 'pdf' ? '翻刻中: {page} ページ目' : '翻刻中: {page} コマ目';
    ui.ocrProgress.textContent = t(unit, { page: running.page }) + (queue.length ? t('・待ち {n} 件', { n: queue.length }) : '');
  }
  if (current?.ocr_done === false) {
    ui.interpretStatus.textContent = t(isOcrPending(current) ? '翻刻中です。終わると解説を依頼できます'
      : 'OCR 未実行です。レイヤーを「翻刻」にするか自動翻刻をオンにすると実行します');
  }
}

// 縮小画像の帯の枠に翻刻の状態（queued・running・done・error）を付ける。帯に出ている資料のページだけ
function markThumb(page, state) {
  if (!thumbs?.key.startsWith(`${page.source_type}:${page.pid}:`)) return;
  const item = ui.thumbs.children[page.page - 1];
  if (item) item.dataset.ocr = state;
}

// ---------- 拡大 ----------
// 倍率は表示欄の幅に対する画像の幅（100% = 幅いっぱい）。ボタンとホイールは ZOOM_STEP 刻み
const ZOOM_MIN = 30, ZOOM_MAX = 300, ZOOM_STEP = 10;
let zoom = 100;

// 倍率を変える。anchor（画面上の点）を渡すと、その点の下にある画像の位置が動かないようスクロールを補正する
function setZoom(value, anchor) {
  const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)));
  if (next === zoom) return;
  const before = ui.canvas.getBoundingClientRect();
  const point = anchor || { x: before.left + before.width / 2, y: before.top + before.height / 2 };
  const px = (point.x - before.left) / before.width, py = (point.y - before.top) / before.height;
  zoom = next;
  ui.canvas.style.width = `${zoom}%`;
  ui.zoomLevel.textContent = `${zoom}%`;
  const after = ui.canvas.getBoundingClientRect();
  ui.canvasWrap.scrollLeft += after.left + px * after.width - point.x;
  ui.canvasWrap.scrollTop += after.top + py * after.height - point.y;
}

// ページ全体（縦横とも）が表示欄に収まる倍率。幅いっぱいでも収まるなら 100%
function fitZoom() {
  if (!current) return;
  const style = getComputedStyle(ui.canvasWrap);
  const width = ui.canvasWrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = ui.canvasWrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const fitWidth = Math.min(width, height * current.width / current.height);
  setZoom(Math.min(100, Math.floor(fitWidth / width * 100)));
  ui.canvasWrap.scrollTo(0, 0);
}

ui.zoomIn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
ui.zoomOut.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
ui.zoomFit.addEventListener('click', fitZoom);
// ホイールで拡大縮小（上下スクロールは手のひらツールで行う）。カーソル直下の点が動かないようにする
ui.canvasWrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(zoom + ZOOM_STEP * (e.deltaY < 0 ? 1 : -1), { x: e.clientX, y: e.clientY });
}, { passive: false });

// ---------- 手のひらツール ----------
// 拡大して画像がはみ出したとき、ドラッグでスクロールできるようにする。
// 少しでも動かしたらドラッグ扱いにし、直後の click（行選択）は抑止する。
const pan = { active: false, dragged: false, x: 0, y: 0, left: 0, top: 0 };
ui.canvasWrap.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.pointerType === 'touch') return;  // タッチは標準スクロールに任せる
  Object.assign(pan, { active: true, dragged: false, x: e.clientX, y: e.clientY, left: ui.canvasWrap.scrollLeft, top: ui.canvasWrap.scrollTop });
  ui.canvasWrap.setPointerCapture(e.pointerId);
});
ui.canvasWrap.addEventListener('pointermove', (e) => {
  if (!pan.active) return;
  const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
  if (!pan.dragged && Math.hypot(dx, dy) < 4) return;
  pan.dragged = true;
  ui.canvasWrap.classList.add('panning');
  ui.canvasWrap.scrollLeft = pan.left - dx;
  ui.canvasWrap.scrollTop = pan.top - dy;
});
const endPan = () => { pan.active = false; ui.canvasWrap.classList.remove('panning'); };
ui.canvasWrap.addEventListener('pointerup', endPan);
ui.canvasWrap.addEventListener('pointercancel', endPan);
ui.canvasWrap.addEventListener('click', (e) => { if (pan.dragged) { e.stopPropagation(); pan.dragged = false; } }, true);
ui.copyText.addEventListener('click', copyLines);
ui.copyPrompt.addEventListener('click', copyPrompt);
ui.editInterpret.addEventListener('click', editInterpret);
ui.saveInterpret.addEventListener('click', saveInterpret);
ui.cancelInterpret.addEventListener('click', () => renderManual(current?.interpretation));
ui.interpretBtn.addEventListener('click', () => interpret(false));
ui.reinterpretBtn.addEventListener('click', () => interpret(true));
ui.commentaryLang.addEventListener('click', (e) => {
  const code = e.target.closest('button')?.dataset.clang;
  if (!code) return;
  commentaryLang = code;
  saveSetting(COMMENTARY_LANG_KEY, code);
  showCommentaryLang(code);
});
document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tabs button, .tab').forEach((el) => el.classList.remove('active'));
  btn.classList.add('active');
  $(`#tab-${btn.dataset.tab}`).classList.add('active');
}));

// URL パラメータ（?pid=...&page=... または ?id=...）で直接開ける
loadFromUrl(true);
refreshHistory();
