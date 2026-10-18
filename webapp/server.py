# くずし字ビューア: NDL古典籍OCR の認識結果を画像に重ねて表示し、必要に応じて LLM に解説させる Web アプリ
#
# 起動:
#   .venv\Scripts\python.exe webapp\server.py
#   → http://127.0.0.1:8777/
#
# - OCR はページ読み込みごとにローカル GPU で実行し、結果は SQLite (webapp/koten.db) に保存
# - 画像ファイルは webapp/cache/<id>.jpg に保存
# - LLM 解説は「解説」ボタンを押したときだけ `claude -p`（Claude Code CLI、サブスク認証）で実行

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

import cv2
import numpy as np
import pymupdf  # PDF のページをラスタライズする
import requests
import truststore
import uvicorn
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

# HTTPS の検証に OS の証明書ストアを使う（社内の SSL 検査など、certifi に無いルート証明書の環境でも NDL から取得できるように）
truststore.inject_into_ssl()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ocr_engine import OcrEngine  # noqa: E402
from store import Store  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, 'cache')
STATIC_DIR = os.path.join(HERE, 'static')
DB_PATH = os.path.join(HERE, 'koten.db')
PROMPT_PATH = os.path.join(HERE, 'interpret_prompt.md')
CORRECT_PROMPT_PATH = os.path.join(HERE, 'correct_prompt.md')
ENGLISH_PROMPT_PATH = os.path.join(HERE, 'english_prompt.md')
CLAUDE_MODEL = os.environ.get('KOTEN_CLAUDE_MODEL')  # 解説・校正に使うモデル（未指定なら claude の既定）
IIIF_URL = 'https://dl.ndl.go.jp/api/iiif/{pid}/R{page:07d}/full/full/0/default.jpg'
MANIFEST_URL = 'https://dl.ndl.go.jp/api/iiif/{pid}/manifest.json'
CLAUDE_TIMEOUT_SEC = 600
MAX_INTERPRET_JOBS = int(os.environ.get('KOTEN_MAX_JOBS', 2))  # 同時に走らせる claude の上限。超えた分は順番待ち
PDF_DPI = 300  # PDF のページを画像化するときの解像度
THUMB_HEIGHT = 160  # ビューアの縮小画像の帯に出す PDF のページの高さ（px。表示の 2 倍程度）
CACHE_MAX_AGE_DAYS = int(os.environ.get('KOTEN_CACHE_DAYS', 30))  # 最終利用からこの日数を過ぎた NDL 画像は起動時に削除（OCR 結果は DB に残る）
LLM_IMAGE_MAX_SIDE = 2000  # LLM に渡す画像の長辺の上限（px）。原寸はトークンと時間を浪費するため縮小する
MAX_UPLOAD_BYTES = int(os.environ.get('KOTEN_MAX_UPLOAD_MB', 500)) * 1024 * 1024  # 開く画像・PDF の大きさの上限
MAX_IMAGE_BYTES = 20 * 1024 * 1024  # /api/ocr/image の上限
# ページ・PDF の ID の形（ファイルのパスに使うので、これ以外は受け付けない）
ITEM_ID = re.compile(r'ndl_\d+_\d{7}|pdf_[0-9a-f]{16}_\d{7}|up_[0-9a-f]{16}')
DOC_ID = re.compile(r'[0-9a-f]{16}')

os.makedirs(CACHE_DIR, exist_ok=True)

app = FastAPI(title='くずし字ビューア')
store = Store(DB_PATH)
engine = None  # 起動時にロード（__main__ 参照）


class NdlRequest(BaseModel):
    pid: str
    page: int
    ocr: bool = True  # False なら画像の取得だけ行い、OCR は実行しない（翻刻レイヤーがオフのときのページ送り）


class PdfRequest(BaseModel):
    doc: str = Field(pattern=f'^{DOC_ID.pattern}$')  # アップロードした PDF の識別子
    page: int
    ocr: bool = True


class InterpretRequest(BaseModel):
    id: str
    force: bool = False


def image_path(item_id):
    if not ITEM_ID.fullmatch(item_id):
        raise HTTPException(404, 'ページが見つかりません')
    return os.path.join(CACHE_DIR, f'{item_id}.jpg')


def llm_image_path(item_id):
    """LLM 用に長辺 LLM_IMAGE_MAX_SIDE px へ縮小した画像を作り（作成済みなら再利用）、そのパスを返す。"""
    path = os.path.join(CACHE_DIR, f'{item_id}.llm.jpg')
    if not os.path.exists(path):
        img = cv2.imread(image_path(item_id))
        scale = LLM_IMAGE_MAX_SIDE / max(img.shape[:2])
        if scale < 1:
            img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return path


def parse_pid(text):
    """pid の数字、または dl.ndl.go.jp/pid/NNN や lab.ndl.go.jp/dl/book/NNN?page=N の URL を受け付ける。"""
    m = re.search(r'/(?:pid|book)/(\d+)', text)
    if m:
        return m.group(1)
    m = re.fullmatch(r'\s*(\d+)\s*', text)
    if m:
        return m.group(1)
    raise HTTPException(400, 'pid は数字か NDL の URL で指定してください')




def api_error(status, message, **values):
    """値の入るエラー。detail は {message: 日本語のひな形（{名前} の所に値が入る）, vars: 値}。
    画面側（i18n.js の t）が、選んだ言語の文に組み立てる（ひな形がそのまま英語の辞書の鍵になる）。"""
    return HTTPException(status, {'message': message, 'vars': values})

# ---------- NDL へのリクエスト ----------
# NDL のサーバーに負担をかけないよう、リクエストは 1 本ずつ、前のリクエストから NDL_MIN_INTERVAL 秒空けて送る。
# 制限（403・429・503）を受けたら、Retry-After（無ければ NDL_COOLDOWN 秒）が過ぎるまで NDL には送らずにエラーを返す
NDL_MIN_INTERVAL = 1.0
NDL_COOLDOWN = 60
NDL_LIMITED = (403, 429, 503)
_ndl_lock = threading.Lock()
_ndl = {'last': 0.0, 'cooldown_until': 0.0}


def ndl_cooldown_error():
    wait = int(_ndl['cooldown_until'] - time.time()) + 1
    return api_error(503, 'NDL のサーバーが混み合っているため、画像を取得できませんでした。{wait} 秒ほど待ってから、もう一度開いてください', wait=wait)


def ndl_get(url, timeout):
    """NDL への GET（呼び出し側が _ndl_lock を持っていること）。間隔を空け、制限を受けたら休止に入る。"""
    if time.time() < _ndl['cooldown_until']:
        raise ndl_cooldown_error()
    wait = _ndl['last'] + NDL_MIN_INTERVAL - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    try:
        r = requests.get(url, timeout=timeout)
    finally:
        _ndl['last'] = time.monotonic()
    if r.status_code in NDL_LIMITED:
        retry = r.headers.get('Retry-After', '')
        _ndl['cooldown_until'] = time.time() + (int(retry) if retry.isdigit() else NDL_COOLDOWN)
        print(f'NDL から HTTP {r.status_code}。{int(_ndl["cooldown_until"] - time.time())} 秒休止します: {url}', flush=True)
        raise ndl_cooldown_error()
    return r


def ndl_page_count(pid):
    """資料の総コマ数（IIIF マニフェストから数えて DB に保存する）。マニフェストが取れないときは None（ページ送りの上限なし）。"""
    key = f'ndl:{pid}'
    with _ndl_lock:
        if key not in store.list_page_counts():
            try:
                r = ndl_get(MANIFEST_URL.format(pid=pid), timeout=30)
                r.raise_for_status()
                store.save_page_count(key, len(r.json()['sequences'][0]['canvases']))
            except (requests.RequestException, HTTPException, KeyError, IndexError, ValueError):
                return None
    return store.list_page_counts()[key]


def pdf_path(doc_id):
    if not DOC_ID.fullmatch(doc_id):
        raise HTTPException(404, 'PDF が見つかりません')
    return os.path.join(CACHE_DIR, f'pdf_{doc_id}.pdf')


def pdf_page_count(doc_id):
    """PDF のページ数（数えて DB に保存する）。"""
    key = f'pdf:{doc_id}'
    if key not in store.list_page_counts():
        with pymupdf.open(pdf_path(doc_id)) as doc:
            store.save_page_count(key, doc.page_count)
    return store.list_page_counts()[key]


def render_pdf_page(doc_id, page, item_id):
    """PDF の指定ページを PDF_DPI で画像化して cache に保存する（既にあれば何もしない）。"""
    jpg = image_path(item_id)
    if os.path.exists(jpg):
        os.utime(jpg)  # mtime を「最終利用」として掃除の基準にする
        return
    if not os.path.exists(pdf_path(doc_id)):
        raise HTTPException(404, 'PDF が見つかりません。もう一度開いてください')
    with pymupdf.open(pdf_path(doc_id)) as doc:
        if not 1 <= page <= doc.page_count:
            raise api_error(400, 'ページ {page} はありません（この PDF は 1〜{count} ページ）', page=page, count=doc.page_count)
        doc[page - 1].get_pixmap(dpi=PDF_DPI).save(jpg)


def pdf_thumb_path(doc_id, page):
    """PDF のページの縮小画像（ビューアの縮小画像の帯用）。作り直せるので古くなれば掃除の対象になる。"""
    pdf_path(doc_id)  # doc_id の形を確かめる
    path = os.path.join(CACHE_DIR, f'pdf_{doc_id}_{page:07d}.thumb.jpg')
    if os.path.exists(path):
        return path
    if not os.path.exists(pdf_path(doc_id)):
        raise HTTPException(404, 'PDF が見つかりません')
    with pymupdf.open(pdf_path(doc_id)) as doc:
        if not 1 <= page <= doc.page_count:
            raise api_error(404, 'ページ {page} はありません', page=page)
        pdf_page = doc[page - 1]
        zoom = THUMB_HEIGHT / pdf_page.rect.height
        pdf_page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom)).save(path)
    return path


def fetch_ndl_image(pid, page, item_id):
    """NDL の IIIF から画像を取得して cache に保存する（既にあれば何もしない）。"""
    jpg = image_path(item_id)
    if os.path.exists(jpg):
        os.utime(jpg)  # mtime を「最終利用」として掃除の基準にする
        return
    count = ndl_page_count(pid)
    if count is not None and not 1 <= page <= count:
        raise api_error(400, 'コマ {page} はありません（この資料は 1〜{count} コマ）', page=page, count=count)
    url = IIIF_URL.format(pid=pid, page=page)
    with _ndl_lock:
        # 同じページの表示と裏の翻刻がほぼ同時に来ることがある。先の依頼が取ってきていれば、取りに行かない
        if os.path.exists(jpg):
            return
        r = ndl_get(url, timeout=120)
        if r.status_code != 200 or not r.headers.get('content-type', '').startswith(('image/', 'binary/')):
            raise api_error(404, 'NDL から画像を取得できません (HTTP {status}): {url}', status=r.status_code, url=url)
        tmp = jpg + '.part'
        with open(tmp, 'wb') as f:
            f.write(r.content)
        os.replace(tmp, jpg)  # 書き込み途中のファイルを、ほかの依頼が完成した画像と見なさないように


def ensure_image(page):
    """DB にある NDL ページの画像がキャッシュ掃除で消えていたら取り直す。"""
    if page['source_type'] == 'ndl':
        fetch_ndl_image(page['pid'], page['page'], page['id'])
    elif page['source_type'] == 'pdf':
        render_pdf_page(page['pid'], page['page'], page['id'])


def cleanup_cache():
    """最終利用から CACHE_MAX_AGE_DAYS を過ぎた画像を削除する。
    再生成できるもの（NDL 画像・PDF のページ画像・LLM 用の縮小画像）だけが対象で、
    アップロードした画像と PDF 本体は残す。"""
    limit = time.time() - CACHE_MAX_AGE_DAYS * 86400
    removed = 0
    for name in os.listdir(CACHE_DIR):
        if not (name.endswith('.jpg') and (name.startswith(('ndl_', 'pdf_')) or name.endswith('.llm.jpg'))):
            continue
        path = os.path.join(CACHE_DIR, name)
        if os.path.getmtime(path) < limit:
            os.remove(path)
            removed += 1
    if removed:
        print(f'キャッシュ画像を {removed} 件削除しました（{CACHE_MAX_AGE_DAYS} 日以上未使用）')


def page_response(item_id, source):
    """DB にあればそれを返し、無ければ OCR を実行して保存する。"""
    page = store.get_page(item_id)
    if page is None:
        ocr = engine.run(image_path(item_id))
        store.save_page(item_id, source, ocr)
        page = store.get_page(item_id)
    ensure_image(page)
    return _decorate(item_id, page)


def image_only_response(item_id, source):
    """OCR 未実行の画像だけの応答（DB には保存しない）。lines が空で ocr_done=False になる。"""
    h, w = cv2.imread(image_path(item_id)).shape[:2]
    page = {'id': item_id, 'source_type': source['type'], 'pid': source.get('pid'), 'page': source.get('page'),
            'name': source.get('name'), 'width': w, 'height': h, 'lines': [], 'text': ''}
    return _decorate(item_id, page, ocr_done=False)


def page_correction(page):
    """校正後の行本文のリスト。未校正、または OCR の行数と合わない（OCR をやり直した）ときは None。"""
    lines = store.get_correction(page['id'])
    return lines if lines is not None and len(lines) == len(page['lines']) else None


def opened(page):
    """ビューアで表示したページとして「最後に開いた日時とページ」を更新し、そのまま返す。
    ビューアが裏で翻刻するだけのページ（ocr=True の依頼）は記録しない。"""
    store.mark_book_opened(book_key(page), page.get('page'))
    return page


def _decorate(item_id, page, ocr_done=True):
    page['name'] = store.list_book_names().get(book_key(page)) or page.get('name')  # 管理画面で付けた名前を優先
    page['image_url'] = f'/cache/{item_id}.jpg'
    page['ocr_done'] = ocr_done
    page['interpreted'] = store.get_interpretation(item_id) is not None
    page['corrected'] = page_correction(page)
    page['english'] = store.get_english(item_id)  # 現代語訳の英訳（English のレイヤーに重ねる）
    if page['source_type'] == 'ndl':
        page['page_count'] = ndl_page_count(page['pid'])
    elif page['source_type'] == 'pdf':
        page['page_count'] = pdf_page_count(page['pid'])
    return page


# / は資料の画面（検索・おすすめ・資料一覧）、/view はビューア
@app.get('/')
def index(request: Request):
    # 以前は / がビューアだったので、ページを指す古い URL（?pid= / ?doc= / ?id=）はビューアに転送する
    if any(k in request.query_params for k in ('pid', 'doc', 'id')):
        return RedirectResponse(f'/view?{request.url.query}')
    return FileResponse(os.path.join(STATIC_DIR, 'index.html'))


@app.get('/view')
def view():
    return FileResponse(os.path.join(STATIC_DIR, 'view.html'))


@app.get('/search')
def search_page():
    """古典籍の検索結果（検索はブラウザから次世代デジタルライブラリーに問い合わせる）。"""
    return FileResponse(os.path.join(STATIC_DIR, 'search.html'))


@app.get('/books')
def books_page():
    """以前の資料の管理画面の URL。"""
    return RedirectResponse('/')


@app.get('/api/pages')
def list_pages():
    pages = store.list_pages()
    names = store.list_book_names()
    for p in pages:
        p['name'] = names.get(book_key(p)) or p.get('name')
        p['interpreting'] = job_state(p['id'])['status'] in ('queued', 'running')
    return pages


@app.get('/api/pages/{item_id}')
def get_page(item_id: str):
    if store.get_page(item_id) is None:
        raise HTTPException(404, 'ページが見つかりません')
    return opened(page_response(item_id, None))


@app.post('/api/ocr/ndl')
def ocr_ndl(req: NdlRequest):
    pid = parse_pid(req.pid)
    item_id = f'ndl_{pid}_{req.page:07d}'
    fetch_ndl_image(pid, req.page, item_id)
    source = {'type': 'ndl', 'pid': pid, 'page': req.page}
    if not req.ocr:
        return opened(page_response(item_id, source) if store.get_page(item_id) else image_only_response(item_id, source))
    return page_response(item_id, source)


@app.post('/api/ocr/upload')
async def ocr_upload(file: UploadFile = File(...)):
    if file.size and file.size > MAX_UPLOAD_BYTES:
        raise api_error(413, 'ファイルが大きすぎます（上限 {mb} MB）', mb=MAX_UPLOAD_BYTES // 1024 // 1024)
    content = await file.read()
    digest = hashlib.sha1(content).hexdigest()[:16]
    if content[:5] == b'%PDF-':
        # PDF は本体を保存し、ページ画像は表示するときに 1 ページずつ作る
        if not os.path.exists(pdf_path(digest)):
            with open(pdf_path(digest), 'wb') as f:
                f.write(content)
        return opened(pdf_response(digest, 1, ocr=True, name=file.filename))
    item_id = 'up_' + digest
    jpg = image_path(item_id)
    if not os.path.exists(jpg):
        with open(jpg, 'wb') as f:
            f.write(content)
    return opened(page_response(item_id, {'type': 'upload', 'name': file.filename}))


def pdf_response(doc_id, page, ocr, name=None):
    item_id = f'pdf_{doc_id}_{page:07d}'
    render_pdf_page(doc_id, page, item_id)
    known = store.get_page(item_id)
    # ファイル名は最初に開いたときのものを使い回す（ページ送りでは渡ってこない）
    source = {'type': 'pdf', 'pid': doc_id, 'page': page,
              'name': name or (known or {}).get('name') or store.get_doc_name(doc_id)}
    if not ocr and known is None:
        return image_only_response(item_id, source)
    return page_response(item_id, source)


@app.get('/api/pdf/{doc_id}/thumb/{page}')
def pdf_thumb(doc_id: str, page: int):
    """PDF のページの縮小画像。画面に見えている分だけ呼ばれる（作ったものは cache に置いて使い回す）。"""
    return FileResponse(pdf_thumb_path(doc_id, page))


@app.post('/api/ocr/pdf')
def ocr_pdf(req: PdfRequest):
    page = pdf_response(req.doc, req.page, req.ocr)
    return page if req.ocr else opened(page)


@app.post('/api/ocr/image')
async def ocr_image(request: Request):
    """画像のバイト列を OCR して結果だけ返し、何も保存しない（ほかのプログラムから OCR だけを使う窓口）。"""
    body = await request.body()
    if len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(413, '画像が大きすぎます')
    img = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, '画像として読み込めません')
    return await run_in_threadpool(engine.run_image, img)


# ---------- 資料（本）の管理 ----------
# ページ単位の OCR 結果を資料ごとにまとめ、一覧・改名・削除を行う。
# 資料 ID は 'ndl:<pid>' / 'pdf:<hash>' / 'up:<item_id>'。

def book_key(page):
    if page['source_type'] in ('ndl', 'pdf'):
        return f"{page['source_type']}:{page['pid']}"
    return f"up:{page['id']}"


def cache_book_key(filename):
    """キャッシュのファイル名から所属する資料 ID を求める（対象外なら None）。"""
    stem = filename
    for ext in ('.llm.jpg', '.jpg', '.pdf'):
        if stem.endswith(ext):
            stem = stem[:-len(ext)]
            break
    else:
        return None
    parts = stem.split('_')
    if parts[0] in ('ndl', 'pdf') and len(parts) >= 2:
        return f'{parts[0]}:{parts[1]}'
    if parts[0] == 'up':
        return f'up:{stem}'
    return None


def default_book_name(key, pages):
    kind, ident = key.split(':', 1)
    if kind == 'ndl':
        return f'NDL {ident}'
    named = next((p['name'] for p in pages if p.get('name')), None)
    return named or ('PDF' if kind == 'pdf' else ident)


def viewer_url(key, pages, start_page=None, last_page=None):
    """前に開いたことがあれば最後に開いたページから続きを開く。
    無ければ OCR 済みの最初のページ、それも無ければ追加したときのコマ（おすすめの資料は見どころのコマ）。"""
    kind, ident = key.split(':', 1)
    page = last_page or min((p['page'] for p in pages if p.get('page')), default=start_page or 1)
    return {'ndl': f'/view?pid={ident}&page={page}', 'pdf': f'/view?doc={ident}&page={page}'}.get(kind, f'/view?id={ident}')


def ndl_thumb_url(pid, page):
    return f'https://dl.ndl.go.jp/api/iiif/{pid}/R{page:07d}/full/200,/0/default.jpg'


def book_page_count(key, page_counts):
    """一覧に出す総ページ数。画像は 1 枚、PDF は手元で数える。
    NDL はビューアで開くか一括処理をするまで数えない（一覧のために NDL へ問い合わせない）ので None のことがある。"""
    kind, ident = key.split(':', 1)
    if kind == 'up':
        return 1
    if kind == 'pdf' and key not in page_counts and os.path.exists(pdf_path(ident)):
        return pdf_page_count(ident)
    return page_counts.get(key)


@app.get('/api/books')
def list_books():
    grouped: dict[str, list] = {}
    for page in store.list_pages(limit=None):
        grouped.setdefault(book_key(page), []).append(page)

    sizes: dict[str, int] = {}
    for name in os.listdir(CACHE_DIR):
        key = cache_book_key(name)
        if key:
            sizes[key] = sizes.get(key, 0) + os.path.getsize(os.path.join(CACHE_DIR, name))
            grouped.setdefault(key, [])  # OCR 前の PDF も一覧に出す

    added = store.list_added_books()
    for key in added:
        grouped.setdefault(key, [])  # 追加しただけで OCR 前の資料も一覧に出す

    names = store.list_book_names()
    opened = store.list_opened_books()
    page_counts = store.list_page_counts()
    metadata = store.list_metadata()
    books = []
    for key, pages in grouped.items():
        pages.sort(key=lambda p: p.get('page') or 0)
        default = default_book_name(key, pages)
        start = added.get(key, {})
        thumb = f"/cache/{pages[0]['id']}.jpg" if pages and os.path.exists(image_path(pages[0]['id'])) else None
        if not thumb and key.startswith('ndl:'):
            thumb = ndl_thumb_url(key[4:], pages[0]['page'] if pages else start.get('page') or 1)
        books.append({
            'key': key,
            'kind': key.split(':', 1)[0],
            'name': names.get(key) or default,
            'renamed': key in names,
            'default_name': default,
            'bytes': sizes.get(key, 0),
            'updated_at': max((p['created_at'] for p in pages), default=start.get('added_at', '')),
            'added_at': min([p['created_at'] for p in pages] + ([start['added_at']] if start else []), default=''),
            'opened_at': opened.get(key, {}).get('opened_at', ''),
            'metadata': metadata.get(key),
            'url': viewer_url(key, pages, start.get('page'), opened.get(key, {}).get('page')),
            'thumb': thumb,
            'page_count': book_page_count(key, page_counts),
            'pages': [{'id': p['id'], 'page': p['page'], 'excerpt': p['excerpt'],
                       'interpreted': bool(p['interpreted']), 'corrected': bool(p['corrected'])} for p in pages],
            'job': book_job_state(key),
        })
    books.sort(key=lambda b: b['updated_at'], reverse=True)
    return books


class RenameRequest(BaseModel):
    name: str


@app.patch('/api/books/{key}')
def rename_book(key: str, req: RenameRequest):
    store.set_book_name(key, req.name.strip())
    return {'key': key, 'name': req.name.strip()}


class MetadataRequest(BaseModel):
    metadata: list[list[str]]


# 資料のメタデータ（NDL の資料の書誌情報）。ブラウザが NDL の IIIF マニフェストから取って保存し、以後は問い合わせない
@app.get('/api/books/{key}/metadata')
def get_metadata(key: str):
    return {'key': key, 'metadata': store.list_metadata().get(key)}


@app.put('/api/books/{key}/metadata')
def save_metadata(key: str, req: MetadataRequest):
    store.save_metadata(key, req.metadata)
    return {'key': key, 'metadata': req.metadata}


def translation_section(markdown):
    """解説の「現代語訳」の節（見出しの次から次の見出しまで）。無ければ None。"""
    m = re.search(r'^#{1,6}[ \t][^\n]*現代語訳[^\n]*\n(.*?)(?=^#{1,6}\s|\Z)', markdown, re.M | re.S)
    return m.group(1).strip() if m else None


class EnglishRequest(BaseModel):
    id: str
    force: bool = False


# 現代語訳を英訳する（段落と行番号はそのまま）。画像は読まず、解説の現代語訳だけを訳す。返るまで待つ（1 ページ数十秒）
@app.post('/api/english')
def make_english(req: EnglishRequest):
    if not req.force and (saved := store.get_english(req.id)):
        return {'id': req.id, 'markdown': saved, 'cached': True}
    interpretation = store.get_interpretation(req.id)
    source = interpretation and translation_section(interpretation['markdown'])
    if not source:
        raise HTTPException(404, '先に解説（現代語訳）を作ってください')
    require_claude()
    with open(ENGLISH_PROMPT_PATH, encoding='utf-8') as f:
        prompt = f.read().replace('{translation}', source)
    markdown = run_claude(prompt).strip()
    store.save_english(req.id, markdown, CLAUDE_MODEL)
    return {'id': req.id, 'markdown': markdown, 'cached': False}


@app.get('/api/books/{key}/pages')
def book_pages(key: str):
    """資料の OCR 済みページを順に返す（翻刻の書き出し用）。画像は取りに行かない。
    corrected は校正後の行本文のリスト（未校正なら None）。"""
    pages = [store.get_page(p['id']) for p in store.list_pages(limit=None) if book_key(p) == key]
    pages.sort(key=lambda p: p.get('page') or 0)
    return [{'id': p['id'], 'page': p['page'], 'lines': p['lines'], 'corrected': page_correction(p)} for p in pages]


@app.delete('/api/books/{key}')
def delete_book(key: str):
    """資料に属する画像・OCR 結果・解説をまとめて削除する。"""
    item_ids = [p['id'] for p in store.list_pages(limit=None) if book_key(p) == key]
    if item_ids:
        store.delete_pages(item_ids)
    store.delete_book_name(key)
    store.delete_added_book(key)
    store.delete_opened_book(key)
    store.delete_metadata(key)
    store.delete_page_count(key)
    removed = 0
    for name in os.listdir(CACHE_DIR):
        if cache_book_key(name) == key:
            os.remove(os.path.join(CACHE_DIR, name))
            removed += 1
    with jobs_lock:
        for item_id in item_ids:
            jobs.pop(item_id, None)
        job = book_jobs.pop(key, None)
        if job:
            job['cancel'] = True  # 実行中の一括処理は残りのページを行わずに終える
    return {'key': key, 'pages': len(item_ids), 'files': removed}


# ---------- LLM 解説ジョブ ----------
# 解説はサーバー側のバックグラウンドジョブとして走らせ、クライアントはポーリングで途中経過を受け取る。
# - 同じページの依頼が重なっても（リロード・別端末）claude を二重起動しない
# - 待っている間に別のページへ移動しても処理は続き、戻ってくれば途中経過/結果が見える
# - 複数ページを連続で依頼できる（MAX_INTERPRET_JOBS を超えた分は順番待ち）
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
job_slots = threading.Semaphore(MAX_INTERPRET_JOBS)


def job_state(item_id):
    """クライアントに返す解説の状態。実行中ならその途中経過、無ければ保存済みの結果、それも無ければ none。"""
    with jobs_lock:
        job = jobs.get(item_id)
        if job:
            state = {'id': item_id, **job}
            # 経過秒はサーバー側で計算して返す（クライアントの時計に依存させない）
            since = job.get('started_at') or job.get('queued_at')
            if since and job['status'] in ('queued', 'running'):
                state['elapsed'] = int(time.time() - since)
            return state
    cached = store.get_interpretation(item_id)
    if cached:
        return {'id': item_id, 'status': 'done', 'markdown': cached['markdown'], 'cached': True}
    return {'id': item_id, 'status': 'none'}


def run_claude(prompt, on_stream=None):
    """claude -p に prompt を渡し、最終的な返答本文を返す。失敗したら RuntimeError を送出する。
    on_stream を渡すと、途中経過のイベント（stream-json の stream_event）を1件ずつ受け取れる。"""
    # 画像を読む Read 以外は不要なので、ツールを Read だけに絞り、MCP サーバー・設定ファイル・スキルも読み込まない。
    # 起動が速くなり、無関係なツール定義がプロンプトに乗らなくなる。
    # Read は許可ルールを付けず、作業フォルダ（cwd）にしたキャッシュの中だけ読めるようにする（画像に仕込まれた指示で
    # ほかのファイルを読まされないため。-p では許可を確認できないので、キャッシュの外は読めずに終わる）
    cmd = [shutil.which('claude'), '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
           '--tools', 'Read',
           '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence']
    if CLAUDE_MODEL:
        cmd += ['--model', CLAUDE_MODEL]
    # CLAUDECODE を外すのは、Claude Code のセッション内から起動した場合にネスト起動が拒否されるのを避けるため
    env = {k: v for k, v in os.environ.items() if k != 'CLAUDECODE'}
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding='utf-8', env=env, cwd=CACHE_DIR)
    final = None
    error = None
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get('type') == 'stream_event' and on_stream:
                on_stream(ev['event'])
            elif ev.get('type') == 'result':
                if ev.get('is_error'):
                    error = ev.get('result') or 'claude がエラーを返しました'
                else:
                    final = ev.get('result')
        rc = proc.wait(timeout=CLAUDE_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise RuntimeError('claude の応答がタイムアウトしました')
    if rc != 0 and error is None:
        error = f'claude の実行に失敗しました (exit {rc}):\n{proc.stderr.read().strip()}'
    if error is not None:
        raise RuntimeError(error)
    return final


def require_claude():
    if shutil.which('claude') is None:
        raise HTTPException(500, 'claude コマンドが見つかりません。Claude Code CLI をインストールしてください')


def llm_prompt(template_path, item_id, line_texts):
    """依頼文のテンプレートに、LLM 用の画像パスと行番号付きの翻刻を埋め込む。"""
    with open(template_path, encoding='utf-8') as f:
        template = f.read()
    numbered = '\n'.join(f'{i + 1}. {t}' for i, t in enumerate(line_texts))
    return template.format(image_path=llm_image_path(item_id).replace('\\', '/'),
                           ocr_lines=numbered, line_count=len(line_texts))


def error_message(e):
    if isinstance(e, HTTPException):
        detail = e.detail
        return detail['message'].format(**detail['vars']) if isinstance(detail, dict) else str(detail)
    return str(e) if isinstance(e, RuntimeError) else f'{type(e).__name__}: {e}'


def run_interpret_job(item_id, prompt):
    job = jobs[item_id]

    def on_stream(e):
        if e.get('type') == 'message_start':
            job['markdown'] = ''  # 画像確認前の前置きなどは捨て、最後のメッセージだけ本文にする
        elif e.get('type') == 'content_block_start':
            kind = e.get('content_block', {}).get('type')
            job['phase'] = {'tool_use': '画像を確認中', 'text': '生成中'}.get(kind, '思考中')
        elif e.get('type') == 'content_block_delta' and e['delta'].get('type') == 'text_delta':
            job['markdown'] += e['delta']['text']

    final = None
    error = None
    with job_slots:
        job['status'] = 'running'
        job['phase'] = '起動中'
        job['started_at'] = time.time()
        try:
            final = run_claude(prompt, on_stream) or job['markdown']
        except Exception as e:  # noqa: BLE001 - ジョブスレッドで例外を落とすと状態が running のまま残るため
            error = error_message(e)

    with jobs_lock:
        if error is not None or not final:
            jobs[item_id] = {'status': 'error', 'error': error or 'claude から本文が返りませんでした'}
        else:
            store.save_interpretation(item_id, final.strip(), CLAUDE_MODEL)
            del jobs[item_id]  # 以降は DB から返す


def interpret_prompt(page):
    ensure_image(page)  # 画像がキャッシュ掃除で消えていても解説できるよう取り直す
    # 校正済みのページは校正後の本文を渡す（行数は OCR と同じなので、訳に付ける行番号はそのまま使える）
    return llm_prompt(PROMPT_PATH, page['id'], page_correction(page) or [l['text'] for l in page['lines']])


def queue_interpret(item_id):
    """解説ジョブを順番待ちに登録する。すでに実行中・順番待ちなら False。"""
    with jobs_lock:
        if jobs.get(item_id, {}).get('status') in ('queued', 'running'):
            return False
        jobs[item_id] = {'status': 'queued', 'phase': '順番待ち', 'markdown': '', 'queued_at': time.time()}
        return True


@app.post('/api/interpret')
def interpret(req: InterpretRequest):
    """OCR 結果と画像を claude -p に渡す解説ジョブを開始する。実行中・保存済みならその状態を返す。"""
    state = job_state(req.id)
    if state['status'] in ('queued', 'running') or (state['status'] == 'done' and not req.force):
        return state

    page = store.get_page(req.id)
    if page is None:
        raise HTTPException(404, '先に OCR を実行してください')
    require_claude()
    prompt = interpret_prompt(page)
    if queue_interpret(req.id):
        threading.Thread(target=run_interpret_job, args=(req.id, prompt), daemon=True).start()
    return job_state(req.id)


@app.get('/api/interpret/{item_id}')
def get_interpret(item_id: str):
    return job_state(item_id)


# ---------- 資料の一括処理ジョブ ----------
# 資料（本）単位のジョブ。選んだ処理（翻刻（OCR）・校正・解説）を全ページに行う。校正・解説はページごとに claude -p で行う。
# 翻刻しないとき（校正だけ）は、翻刻済みのページだけが対象になる。
# - OCR は 1 ページずつ順に行う（NDL の画像は間隔を空けて 1 枚ずつ取り、OCR エンジンも同時に 1 枚しか処理しないため）。
#   翻刻が済んだページから順に claude の処理へ回す
# - claude の同時実行数は解説と同じ job_slots を共有する（claude の同時起動数の上限は全体で MAX_INTERPRET_JOBS）
# - 済んでいる処理は飛ばす（翻刻済み・校正済み・解説済みのページはやり直さない）。redo なら校正・解説は作り直す
#   （OCR は同じ画像なら結果も同じなのでやり直さない）。
#   1 ページ終わるたびに DB へ保存するので、途中で失敗・中止しても済んだページは残り、もう一度始めれば残りだけ行う
# - 校正結果は OCR の行と1対1に対応させる（行矩形の上に重ねるため）。行数が合わない返答は失敗として扱う
# - 校正と解説を両方行うページは、校正してから解説する（解説に校正後の本文を渡す）
# - NDL から制限を受けたら、残りのページは行わずに止める（続けても同じエラーになり、NDL に負担をかけるため）
book_jobs: dict[str, dict] = {}  # 資料 ID -> 状態。終了後も次の開始まで結果（失敗したページなど）を残す


def book_job_state(key):
    with jobs_lock:
        job = book_jobs.get(key)
        if not job:
            return {'status': 'none'}
        state = {k: v for k, v in job.items() if k not in ('cancel', 'pages')}
        state['running'] = sorted(job['running'])
        state['failed'] = list(job['failed'])
        state['elapsed'] = int((job.get('finished_at') or time.time()) - job['started_at'])
        return state


def parse_correction(text, line_count):
    """「行番号. 本文」の返答を行のリストにする。全行がそろわなければ RuntimeError。"""
    lines = {}
    for raw in (text or '').splitlines():
        m = re.match(r'\s*(\d+)\s*[.．]\s?(.*)$', raw)
        if m and 1 <= int(m.group(1)) <= line_count:
            lines[int(m.group(1))] = m.group(2).strip()
    missing = [n for n in range(1, line_count + 1) if n not in lines]
    if missing:
        raise RuntimeError(f'返答に {len(missing)} 行分の欠けがあります（{line_count} 行中。例: {missing[0]} 行目）')
    return [lines[n] for n in range(1, line_count + 1)]


def book_page_numbers(key):
    """資料の全ページの番号。画像（up）は 1 枚なので [None]。"""
    kind, ident = key.split(':', 1)
    if kind == 'up':
        return [None]
    count = ndl_page_count(ident) if kind == 'ndl' else pdf_page_count(ident)
    if count is None:
        raise api_error(503, 'NDL から資料のコマ数を取得できません。しばらく待ってから、もう一度お試しください')
    return list(range(1, count + 1))


def ocr_book_page(key, number):
    """資料のページを OCR して DB のページを返す（翻刻済みなら DB のものをそのまま返す）。"""
    kind, ident = key.split(':', 1)
    if kind == 'ndl':
        item_id = f'ndl_{ident}_{number:07d}'
        if store.get_page(item_id) is None:
            fetch_ndl_image(ident, number, item_id)
            page_response(item_id, {'type': 'ndl', 'pid': ident, 'page': number})
    elif kind == 'pdf':
        item_id = f'pdf_{ident}_{number:07d}'
        if store.get_page(item_id) is None:
            pdf_response(ident, number, ocr=True)
    else:
        item_id = ident  # アップロードした画像は開いたときに翻刻済み
    return store.get_page(item_id)


def correct_book_page(job, page):
    with job_slots:
        if job['cancel']:
            return
        ensure_image(page)  # 画像がキャッシュ掃除で消えていても校正できるよう取り直す
        texts = [l['text'] for l in page['lines']]
        reply = run_claude(llm_prompt(CORRECT_PROMPT_PATH, page['id'], texts))
        store.save_correction(page['id'], parse_correction(reply, len(texts)), CLAUDE_MODEL)


def interpret_book_page(job, page):
    """ビューアで頼んだ解説と同じジョブとして行う（ビューアで開けば途中経過が見える）。実行中のものは任せて待たない。"""
    if job['cancel'] or not queue_interpret(page['id']):
        return
    run_interpret_job(page['id'], interpret_prompt(page))
    with jobs_lock:
        error = jobs.get(page['id'], {}).get('error')
    if error:
        raise RuntimeError(error)


def finish_book_page(job, page, error=None):
    with jobs_lock:
        job['running'].discard(page['page'] or 0)
        if error is None:
            job['done'] += 1
        else:
            job['failed'].append({'page': page['page'], 'id': page['id'], 'error': error})


def llm_book_page(job, page):
    """翻刻済みのページに、選んだ処理のうち済んでいないものを行う。文字の無いページは何もしない。"""
    if job['cancel']:  # 中止したら、順番待ちのページは済んだ数にも失敗にも数えない
        with jobs_lock:
            job['running'].discard(page['page'] or 0)
        return
    try:
        if page['lines'] and 'correct' in job['steps'] and (job['redo'] or not page_correction(page)):
            correct_book_page(job, page)
        if page['lines'] and 'interpret' in job['steps'] and (job['redo'] or store.get_interpretation(page['id']) is None):
            interpret_book_page(job, page)
    except Exception as e:  # noqa: BLE001 - 1ページの失敗で残りのページを止めないため
        finish_book_page(job, page, error_message(e))
        return
    finish_book_page(job, page)


def run_book_job(job, key):
    with ThreadPoolExecutor(MAX_INTERPRET_JOBS) as pool:
        for number in job['pages']:
            if job['cancel']:
                break
            with jobs_lock:
                job['running'].add(number or 0)
            try:
                page = ocr_book_page(key, number)
            except Exception as e:  # noqa: BLE001 - 1ページの失敗で残りのページを止めないため
                finish_book_page(job, {'page': number, 'id': None}, error_message(e))
                if time.time() < _ndl['cooldown_until']:
                    job['cancel'] = True
                continue
            pool.submit(llm_book_page, job, page)
    with jobs_lock:
        job['status'] = 'canceled' if job['cancel'] else 'done'
        job['finished_at'] = time.time()


class BookJobRequest(BaseModel):
    steps: list[Literal['ocr', 'correct', 'interpret']]  # 行う処理（翻刻・校正・解説）
    redo: bool = False  # True なら校正済み・解説済みのページも作り直す


@app.post('/api/books/{key}/job')
def start_book_job(key: str, req: BookJobRequest):
    """資料の全ページを処理するジョブを開始する。実行中ならその状態を返す。"""
    if book_job_state(key)['status'] == 'running':
        return book_job_state(key)
    if set(req.steps) - {'ocr'}:
        require_claude()
    if 'ocr' in req.steps:
        pages = book_page_numbers(key)
    else:
        pages = sorted(p['page'] for p in store.list_pages(limit=None) if book_key(p) == key)
        if not pages:
            raise HTTPException(400, '翻刻済みのページがありません。先に翻刻してください')
    with jobs_lock:
        job = book_jobs[key] = {'status': 'running', 'steps': req.steps, 'redo': req.redo, 'pages': pages, 'total': len(pages),
                                'done': 0, 'failed': [], 'running': set(), 'cancel': False, 'started_at': time.time()}
    threading.Thread(target=run_book_job, args=(job, key), daemon=True).start()
    return book_job_state(key)


@app.get('/api/books/{key}/job')
def get_book_job(key: str):
    return book_job_state(key)


@app.delete('/api/books/{key}/job')
def cancel_book_job(key: str):
    """ジョブを中止する。実行中のページは終わるまで待ち、まだ始まっていないページは行わない。"""
    with jobs_lock:
        if key in book_jobs:
            book_jobs[key]['cancel'] = True
    return book_job_state(key)


app.mount('/cache', StaticFiles(directory=CACHE_DIR), name='cache')
app.mount('/static', StaticFiles(directory=STATIC_DIR), name='static')


# 認証の無いローカル用サーバーなので、ブラウザで開いているほかのサイトから操作されないようにする
# - Host: DNS rebinding（攻撃者のドメインを 127.0.0.1 に向けて同じオリジンに見せかける）を防ぐ。
#   KOTEN_HOST で LAN に公開するときは、開くときのホスト名（IP アドレスなど）を KOTEN_ALLOWED_HOSTS にカンマ区切りで足す
# - Sec-Fetch-Site・Origin: 他サイトのページからの POST・DELETE（CSRF）や、<img> で「その資料を開いたか」を探られるのを防ぐ。
#   ブラウザ以外（curl など）はどちらも付けないので通る
ALLOWED_HOSTS = {'127.0.0.1', 'localhost', '[::1]', os.environ.get('KOTEN_HOST', '127.0.0.1'),
                 *filter(None, os.environ.get('KOTEN_ALLOWED_HOSTS', '').split(','))}
# 画面が読み込む先（自分・NDL・jsDelivr）だけを許す
CSP = ("default-src 'self'; script-src 'self' https://cdn.jsdelivr.net/npm/marked@12.0.2/ https://cdn.jsdelivr.net/npm/dompurify@3.4.15/; "
       "img-src 'self' blob: data: https://dl.ndl.go.jp https://dss-r4-prod-contents-download.s3.amazonaws.com; "
       "connect-src 'self' https://dl.ndl.go.jp https://lab.ndl.go.jp https://cdn.jsdelivr.net/npm/dompurify@3.4.15/; "
       "worker-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


@app.middleware('http')
async def same_origin_only(request, call_next):
    host = request.headers.get('host', '')
    if re.sub(r':\d+$', '', host) not in ALLOWED_HOSTS:
        return JSONResponse({'detail': f'このホスト名では開けません: {host}'}, 403)
    origin = request.headers.get('origin')
    if request.headers.get('sec-fetch-site') in ('cross-site', 'same-site') or (
            request.method not in ('GET', 'HEAD') and origin and origin.split('://', 1)[-1] != host):
        return JSONResponse({'detail': 'ほかのサイトからは操作できません'}, 403)
    response = await call_next(request)
    response.headers['Content-Security-Policy'] = CSP
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    return response


@app.middleware('http')
async def revalidate_static(request, call_next):
    """画面のファイルは毎回更新を確認させる（Cache-Control が無いとブラウザが古い CSS/JS を使い続けるため）。
    変更が無ければ ETag により 304 が返るので、転送量はほとんど増えない。"""
    response = await call_next(request)
    if request.url.path in ('/', '/view', '/search') or request.url.path.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-cache'
    return response


if __name__ == '__main__':
    cleanup_cache()
    print('OCR モデルをロード中...')
    engine = OcrEngine()
    port = int(os.environ.get('KOTEN_PORT', 8777))
    print(f'ロード完了。 http://127.0.0.1:{port}/')
    # KOTEN_HOST=0.0.0.0 で LAN 内の他端末からもアクセス可能にする
    uvicorn.run(app, host=os.environ.get('KOTEN_HOST', '127.0.0.1'), port=port, log_level='info')
