// 検索結果の画面（/search?q=...）。次世代デジタルライブラリーで NDL デジタルコレクションの古典籍を探し、開ける。
// カードは catalog.js。

// 次世代デジタルライブラリーの検索 API（CORS が許可されているのでブラウザから直接呼べる）。仕様: https://lab.ndl.go.jp/service/tsugidigi/apiinfo/
// 営利目的かつ継続的な利用でなければ申請不要（https://lab.ndl.go.jp/service/tsugidigi/ の「ご利用に当たって」）。
// fc-isClassic=true で古典籍に絞り、使わない本文の抜粋（ハイライト）は withouthighlight=true で省いてサーバーの負荷を下げる
const SEARCH_URL = 'https://lab.ndl.go.jp/dl/api/book/search';
const SEARCH_SIZE = 24;
// 検索は NDL のサーバーへの問い合わせなので、連打や同じ検索の繰り返しで負荷をかけないようにする:
// 同時に 1 件まで・前の問い合わせから一定時間あける・同じ条件の結果は使い回す。
// 検索のたびにページを読み込み直すので、間隔と結果はタブの間だけ残る sessionStorage に置く（戻る・進むでも問い合わせない）
const SEARCH_INTERVAL_MS = 2000;
const LAST_SEARCH_KEY = 'searchLastAt';
const CACHE_PREFIX = 'search:';

const searchUi = { q: $('#search-q'), summary: $('#search-summary'), results: $('#search-results'), more: $('#search-more') };
const search = { q: new URLSearchParams(location.search).get('q')?.trim() || '', from: 0, busy: false };

function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function sessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch (e) { /* 保存できなくても検索はできる（間隔の制限はこのページの中だけになる） */ }
}

let lastSearchAt = Number(sessionGet(LAST_SEARCH_KEY)) || 0;

async function fetchSearch(params) {
  const url = `${SEARCH_URL}?${params}`;
  const cached = sessionGet(CACHE_PREFIX + url);
  if (cached) return JSON.parse(cached);
  const wait = lastSearchAt + SEARCH_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastSearchAt = Date.now();
  sessionSet(LAST_SEARCH_KEY, String(lastSearchAt));
  const res = await fetch(url);
  if (!res.ok) throw new Error(t('検索できません (HTTP {status})', { status: res.status }));
  const data = await res.json();
  sessionSet(CACHE_PREFIX + url, JSON.stringify(data));
  return data;
}

// 著者などは '||' 区切りで複数入っているので ' / ' でつなぐ
const joinValues = (value) => (value || '').split('||').filter(Boolean).join(' / ');

async function runSearch() {
  if (search.busy) return;  // 問い合わせ中の「さらに表示」は受け付けない
  search.busy = searchUi.more.disabled = true;
  const params = new URLSearchParams({ keyword: search.q, 'fc-isClassic': 'true', withouthighlight: 'true', size: SEARCH_SIZE, from: search.from });
  setStatus(t('「{q}」を検索中…', { q: search.q }));
  let data;
  try {
    data = await fetchSearch(params);
  } catch (e) { setStatus(e.message, true); return; }
  finally { search.busy = searchUi.more.disabled = false; }
  setStatus('');

  if (!data.hit) {
    searchUi.summary.textContent = t('「{q}」に当たる古典籍はありません。', { q: search.q });
    return;
  }
  searchUi.results.append(...data.list.map((b) => catalogItem({
    pid: b.id,
    title: [b.title, b.volume].filter(Boolean).join(' '),
    lines: [joinValues(b.responsibility), b.published],
  })));
  search.from += data.list.length;
  searchUi.summary.textContent = t('「{q}」の古典籍 {hit} 件（{shown} 件を表示）', { q: search.q, hit: data.hit, shown: search.from });
  searchUi.more.hidden = search.from >= data.hit;
}

searchUi.more.addEventListener('click', runSearch);
searchUi.q.value = search.q;
if (search.q) document.title = t('「{q}」の検索結果 — くずし字ビューア', { q: search.q });
if (search.q) runSearch();
else searchUi.summary.textContent = t('上の検索欄に書名・著者などを入れてください。');
