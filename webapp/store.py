# くずし字ビューアの永続化層（SQLite）
#
# pages           : OCR 結果（1画像 = 1行。lines は JSON 文字列）
# interpretations : LLM 解説（1画像につき最新1件を保持）
# english         : 現代語訳の英訳（1画像につき最新1件。段落の先頭に現代語訳と同じ行番号が付いた Markdown）
# corrections     : LLM による翻刻の校正（1画像につき最新1件。OCR の lines と同じ行数で、行ごとの本文だけを持つ）
# books           : 資料（本）ごとの表示名。ページが 1 件も無い資料にも名前を付けられるよう別テーブルにしてある
# added_books     : 以前の「資料に追加」ボタンで追加した資料（OCR 前でも一覧に出す。page は開くときのコマ）。ボタンは廃止し、残っている分を読むだけ
# opened_books    : 資料をビューアで最後に開いた日時とページ（一覧の「最近開いた順」と、続きから開くのに使う）
# book_metadata   : 資料のメタデータ（NDL の IIIF マニフェストの metadata をすべて [項目, 値] の JSON で）。一度取得したら NDL に問い合わせない
# page_counts     : 資料の総ページ数（NDL はマニフェストのコマ数、PDF はページ数）。一覧で「全ページ済み」かを見るのに使い、一度数えたら数え直さない
# 画像ファイル自体は webapp/cache/<id>.jpg に置き、DB には持たない。

import json
import sqlite3
import threading
from datetime import datetime

SCHEMA = '''
CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,          -- 'ndl' | 'pdf' | 'upload'
    pid         TEXT,                   -- 資料 ID（ndl: NDL の pid / pdf: PDF のハッシュ）
    page        INTEGER,                -- コマ・ページ番号（ndl, pdf のとき）
    name        TEXT,                   -- アップロード時のファイル名
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    lines       TEXT NOT NULL,          -- JSON: [{x1,y1,x2,y2,text}, ...]（読み順）
    text        TEXT NOT NULL,          -- 読み順に連結した全文
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interpretations (
    id          TEXT PRIMARY KEY REFERENCES pages(id),
    markdown    TEXT NOT NULL,
    model       TEXT,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS english (
    id          TEXT PRIMARY KEY REFERENCES pages(id),
    markdown    TEXT NOT NULL,
    model       TEXT,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS corrections (
    id          TEXT PRIMARY KEY REFERENCES pages(id),
    lines       TEXT NOT NULL,          -- JSON: ["校正後の1行目", ...]（pages.lines と同じ順・同じ行数）
    model       TEXT,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS books (
    id          TEXT PRIMARY KEY,       -- 'ndl:<pid>' | 'pdf:<hash>' | 'up:<item_id>'
    name        TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS added_books (
    id          TEXT PRIMARY KEY,       -- 'ndl:<pid>'
    page        INTEGER NOT NULL,
    added_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opened_books (
    id          TEXT PRIMARY KEY,       -- 'ndl:<pid>' | 'pdf:<hash>' | 'up:<item_id>'
    opened_at   TEXT NOT NULL,
    page        INTEGER                 -- 最後に開いたコマ・ページ番号（ndl, pdf のとき）
);
CREATE TABLE IF NOT EXISTS book_metadata (
    id          TEXT PRIMARY KEY,       -- 'ndl:<pid>'
    metadata    TEXT NOT NULL,          -- JSON: [[項目, 値], ...]
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS page_counts (
    id          TEXT PRIMARY KEY,       -- 'ndl:<pid>' | 'pdf:<hash>'
    count       INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);
'''


class Store:
    def __init__(self, db_path):
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._lock = threading.Lock()

    @staticmethod
    def _now():
        return datetime.now().isoformat(timespec='seconds')

    @staticmethod
    def _page_dict(row):
        d = dict(row)
        d['lines'] = json.loads(d['lines'])
        return d

    def get_page(self, item_id):
        row = self._conn.execute('SELECT * FROM pages WHERE id = ?', (item_id,)).fetchone()
        return self._page_dict(row) if row else None

    def get_doc_name(self, pid):
        """同じ資料（PDF）の保存済みページからファイル名を引く。"""
        row = self._conn.execute(
            'SELECT name FROM pages WHERE pid = ? AND name IS NOT NULL LIMIT 1', (pid,)).fetchone()
        return row['name'] if row else None

    def save_page(self, item_id, source, ocr):
        with self._lock:
            self._conn.execute(
                'INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?,?,?,?,?,?)',
                (item_id, source['type'], source.get('pid'), source.get('page'), source.get('name'),
                 ocr['width'], ocr['height'], json.dumps(ocr['lines'], ensure_ascii=False), ocr['text'], self._now()))
            self._conn.commit()

    def list_pages(self, limit=200):
        """limit=None で全件返す。"""
        rows = self._conn.execute(
            'SELECT p.id, p.source_type, p.pid, p.page, p.name, p.created_at, '
            '       substr(p.text, 1, 40) AS excerpt, (i.id IS NOT NULL) AS interpreted, (c.id IS NOT NULL) AS corrected '
            'FROM pages p LEFT JOIN interpretations i ON i.id = p.id LEFT JOIN corrections c ON c.id = p.id '
            'ORDER BY p.created_at DESC LIMIT ?', (-1 if limit is None else limit,)).fetchall()
        return [dict(r) for r in rows]

    def list_book_names(self):
        return {r['id']: r['name'] for r in self._conn.execute('SELECT id, name FROM books')}

    def set_book_name(self, book_id, name):
        with self._lock:
            if name:
                self._conn.execute('INSERT OR REPLACE INTO books VALUES (?,?,?)', (book_id, name, self._now()))
            else:
                self._conn.execute('DELETE FROM books WHERE id = ?', (book_id,))  # 空文字は既定の名前に戻す
            self._conn.commit()

    def delete_pages(self, item_ids):
        """ページとその解説・校正をまとめて削除する。"""
        with self._lock:
            marks = ','.join('?' * len(item_ids))
            self._conn.execute(f'DELETE FROM interpretations WHERE id IN ({marks})', item_ids)
            self._conn.execute(f'DELETE FROM corrections WHERE id IN ({marks})', item_ids)
            self._conn.execute(f'DELETE FROM english WHERE id IN ({marks})', item_ids)
            self._conn.execute(f'DELETE FROM pages WHERE id IN ({marks})', item_ids)
            self._conn.commit()

    def delete_book_name(self, book_id):
        self.set_book_name(book_id, None)

    def list_added_books(self):
        """{資料 ID: {'page', 'added_at'}}"""
        return {r['id']: {'page': r['page'], 'added_at': r['added_at']}
                for r in self._conn.execute('SELECT * FROM added_books')}

    def delete_added_book(self, book_id):
        with self._lock:
            self._conn.execute('DELETE FROM added_books WHERE id = ?', (book_id,))
            self._conn.commit()

    def list_opened_books(self):
        """{資料 ID: {'opened_at', 'page'}}"""
        return {r['id']: {'opened_at': r['opened_at'], 'page': r['page']}
                for r in self._conn.execute('SELECT * FROM opened_books')}

    def mark_book_opened(self, book_id, page):
        with self._lock:
            self._conn.execute('INSERT OR REPLACE INTO opened_books VALUES (?,?,?)', (book_id, self._now(), page))
            self._conn.commit()

    def delete_opened_book(self, book_id):
        with self._lock:
            self._conn.execute('DELETE FROM opened_books WHERE id = ?', (book_id,))
            self._conn.commit()

    def list_metadata(self):
        """{資料 ID: [[項目, 値], ...]}"""
        return {r['id']: json.loads(r['metadata']) for r in self._conn.execute('SELECT id, metadata FROM book_metadata')}

    def save_metadata(self, book_id, metadata):
        with self._lock:
            self._conn.execute('INSERT OR REPLACE INTO book_metadata VALUES (?,?,?)',
                               (book_id, json.dumps(metadata, ensure_ascii=False), self._now()))
            self._conn.commit()

    def delete_metadata(self, book_id):
        with self._lock:
            self._conn.execute('DELETE FROM book_metadata WHERE id = ?', (book_id,))
            self._conn.commit()

    def list_page_counts(self):
        """{資料 ID: 総ページ数}"""
        return {r['id']: r['count'] for r in self._conn.execute('SELECT id, count FROM page_counts')}

    def save_page_count(self, book_id, count):
        with self._lock:
            self._conn.execute('INSERT OR REPLACE INTO page_counts VALUES (?,?,?)', (book_id, count, self._now()))
            self._conn.commit()

    def delete_page_count(self, book_id):
        with self._lock:
            self._conn.execute('DELETE FROM page_counts WHERE id = ?', (book_id,))
            self._conn.commit()

    def get_interpretation(self, item_id):
        row = self._conn.execute('SELECT * FROM interpretations WHERE id = ?', (item_id,)).fetchone()
        return dict(row) if row else None

    def save_interpretation(self, item_id, markdown, model):
        with self._lock:
            self._conn.execute('INSERT OR REPLACE INTO interpretations VALUES (?,?,?,?)',
                               (item_id, markdown, model, self._now()))
            self._conn.commit()

    def get_english(self, item_id):
        row = self._conn.execute('SELECT markdown FROM english WHERE id = ?', (item_id,)).fetchone()
        return row['markdown'] if row else None

    def save_english(self, item_id, markdown, model):
        with self._lock:
            self._conn.execute('INSERT OR REPLACE INTO english VALUES (?,?,?,?)', (item_id, markdown, model, self._now()))
            self._conn.commit()

    def get_correction(self, item_id):
        """校正後の行本文のリスト。未校正なら None。"""
        row = self._conn.execute('SELECT lines FROM corrections WHERE id = ?', (item_id,)).fetchone()
        return json.loads(row['lines']) if row else None

    def save_correction(self, item_id, lines, model):
        with self._lock:
            self._conn.execute('INSERT OR REPLACE INTO corrections VALUES (?,?,?,?)',
                               (item_id, json.dumps(lines, ensure_ascii=False), model, self._now()))
            self._conn.commit()
