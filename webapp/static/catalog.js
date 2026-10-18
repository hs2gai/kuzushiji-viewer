// NDL の資料のカード（おすすめ・検索結果で共通）。縮小画像・元の資料へのリンク・開くを持つ（開けば資料に加わる）。
// dom.js の el を使う。

const IIIF_THUMB = (pid, page = 1) => `https://dl.ndl.go.jp/api/iiif/${pid}/R${String(page).padStart(7, '0')}/full/200,/0/default.jpg`;

// 元の資料を NDL デジタルコレクション・次世代デジタルライブラリーで見るリンク（ビューアのヘッダーと同じ行き先）
function sourceLinks(pid, page) {
  return el('div', { className: 'source-icons' }, [
    el('a', { className: 'src-icon', href: `https://dl.ndl.go.jp/pid/${pid}/1/${page}`, target: '_blank', rel: 'noopener', textContent: 'N', title: t('NDL デジタルコレクションで見る') }),
    el('a', { className: 'src-icon', href: `https://lab.ndl.go.jp/dl/book/${pid}?page=${page}`, target: '_blank', rel: 'noopener', textContent: '次', title: t('次世代デジタルライブラリーで見る') }),
  ]);
}

// カード。lines は書名の下に出す補足（著者・出版年など）、note はカードの幅いっぱいに出す紹介文
function catalogItem({ pid, page = 1, title, lines = [], note }) {
  return el('article', { className: 'item' }, [
    el('img', { src: IIIF_THUMB(pid, page), alt: '', loading: 'lazy' }),
    el('div', { className: 'info' }, [
      el('h3', { textContent: title }),
      ...lines.map((text) => text?.trim()).filter(Boolean).map((text) => el('div', { className: 'sub', textContent: t(text) })),
      el('div', { className: 'sub pid', textContent: `NDL ${pid}` }),
    ]),
    el('div', { className: 'actions' }, [
      sourceLinks(pid, page),
      el('a', { href: `/view?pid=${pid}&page=${page}`, textContent: t('開く') }),
    ]),
    note ? el('p', { className: 'note', textContent: t(note) }) : '',
  ]);
}
