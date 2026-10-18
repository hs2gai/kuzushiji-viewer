// データの取得・保存の窓口（個人版: FastAPI + SQLite）。
// app.js / books.js はここに定義した backend だけを使う。
// 同じ形の backend を定義すれば、保存先を差し替えられる（例: ブラウザに保存する版。その場合 startBookJob などサーバー専用の処理は持たない）。
// どちらも同じ形のデータ（ページ = {id, source_type, pid, page, name, width, height, lines, text, image_url, ...}）を返す。

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(errorMessage(body) || `${res.status} ${res.statusText}`), { status: res.status });
  return body;
}

const postJson = (path, data) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

const backend = {
  // 解説の方式。'server': サーバーで claude -p を実行 / 'manual': 利用者が自分の LLM で解説して貼り付ける
  interpretMode: 'server',
  // 自動翻刻（ページをめくるたびに OCR）の既定。利用者が切り替えたら、その選択を優先する
  autoOcrDefault: true,

  openNdl: (pid, page, ocr) => postJson('/api/ocr/ndl', { pid, page, ocr }),
  openPdf: (doc, page, ocr) => postJson('/api/ocr/pdf', { doc, page, ocr }),
  openFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    return api('/api/ocr/upload', { method: 'POST', body: fd });
  },
  getPage: (id) => api(`/api/pages/${id}`),
  // ビューアの縮小画像の帯に出す画像の URL。NDL は IIIF の縮小画像、PDF はサーバーで縮小して返す
  thumbnailUrl: (sourceType, pid, page) => (sourceType === 'ndl'
    ? `https://dl.ndl.go.jp/api/iiif/${pid}/R${String(page).padStart(7, '0')}/full/,160/0/default.jpg`
    : `/api/pdf/${pid}/thumb/${page}`),
  // 保存済みの縮小画像（取りには行かない）。無ければ null。PDF は手元のサーバーが作るので、待たずにそのまま取る
  cachedThumbnailUrl: async (sourceType, pid, page) => (sourceType === 'ndl'
    ? cachedImage(backend.thumbnailUrl(sourceType, pid, page)) : backend.thumbnailUrl(sourceType, pid, page)),
  listPages: () => api('/api/pages'),

  listBooks: () => api('/api/books'),
  renameBook: (key, name) => api(`/api/books/${encodeURIComponent(key)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  // 資料の分類（料理書・読み物など。空文字で外す）
  setBookCategory: (key, category) => api(`/api/books/${encodeURIComponent(key)}/category`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category }),
  }),
  deleteBook: (key) => api(`/api/books/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  // 資料のメタデータ（NDL の書誌情報。[[項目, 値], ...]）。保存が無ければ metadata は null
  getMetadata: async (key) => (await api(`/api/books/${encodeURIComponent(key)}/metadata`)).metadata,
  saveMetadata: (key, metadata) => api(`/api/books/${encodeURIComponent(key)}/metadata`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata }),
  }),
  // 資料の OCR 済みページ（[{id, page, lines, corrected}]、ページ順）。翻刻の書き出しに使う
  getBookPages: (key) => api(`/api/books/${encodeURIComponent(key)}/pages`),

  // 資料の全ページの一括処理（steps に入れた翻刻 'ocr'・校正 'correct'・解説 'interpret' を行う。校正・解説はサーバーで claude -p）。
  // redo なら校正済み・解説済みのページも作り直す。pages（ページ番号の配列）を渡せば、そのページだけ行う。
  // 状態 = {status: 'none'|'running'|'done'|'canceled', steps, redo, total, done, failed: [{page, error}], running: [page], elapsed}
  getBookJob: (key) => api(`/api/books/${encodeURIComponent(key)}/job`),
  startBookJob: (key, steps, redo, pages) => postJson(`/api/books/${encodeURIComponent(key)}/job`, { steps, redo, pages }),
  cancelBookJob: (key) => api(`/api/books/${encodeURIComponent(key)}/job`, { method: 'DELETE' }),

  // 解説（server 方式）。状態 = {status: 'none'|'queued'|'running'|'done'|'error', markdown, phase, elapsed, cached, error}
  getInterpret: (id) => api(`/api/interpret/${id}`),
  startInterpret: (id, force) => postJson('/api/interpret', { id, force }),
};
