# くずし字ビューア

[English](README.md)

くずし字の古典籍を読むためのローカルWebアプリです。
手元のGPUでページごとにOCRを実行し、読み取った翻刻を画像の行に合わせて縦書きで重ねて表示します。
OCRエンジンには国立国会図書館の[NDL古典籍OCR（ver.3）](https://github.com/ndl-lab/ndlkotenocr_cli)を使っています。

- NDLデジタルコレクションの資料（資料の画面の検索欄で探せる）、手元の画像・PDFを開ける。読み進めるとページごとにOCRを実行
- 翻刻レイヤーはテキストの行だけを覆う（挿絵は画像のまま）。不透明度・文字サイズ・字間・文字色・拡大を調整できる
- [Claude Code CLI](https://docs.anthropic.com/claude-code)があれば、Claudeが画像と照らし合わせて翻刻を校正し、現代語訳・注記・英訳を作る。1ページずつでも、資料の全ページまとめてでもよい
- 資料の画面：NDLの古典籍の検索、最初に読むのにおすすめの本、書誌情報の表示、絞り込み・改名・削除・翻刻のダウンロード

公開デモ（ブラウザで動く版。公開用の構成はこのリポジトリに含めていません）：https://kuzushiji-viewer.hs2g.com

## はじめかた（Windows）

前提：
- Windows 10 / 11 (64bit)
- NVIDIA GPUとNVIDIA Driver 520.06以上（CUDA 12.1対応。CUDA Toolkitのインストールは不要）。GPUが無くてもCPUで動きます（遅くなります。後述）
- [uv](https://docs.astral.sh/uv/)（`winget install astral-sh.uv`）。Python 3.10が無ければuvが自動で取得します
  - Python 3.10固定なのは、mmcv 2.1.0のWindows向けビルド済みwheelがcp310 / cp311のみのため
- 任意：校正・翻訳・注記を使うなら[Claude Code CLI](https://docs.anthropic.com/claude-code)をインストールし、`claude`でログインしておく（サブスクリプションで動作。APIキー不要）

```powershell
git clone https://github.com/hs2gai/kuzushiji-viewer
cd kuzushiji-viewer
powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1   # 仮想環境・依存パッケージ・モデル（約1.5GB）をまとめて用意
.\.venv\Scripts\python.exe webapp\server.py                     # モデルのロード後 http://127.0.0.1:8777/ を開く
```

`setup_windows.ps1`は再実行しても安全です（作成済みの`.venv`やダウンロード済みのモデルはスキップします）。
フォルダを移動・改名したときは`.venv`を削除してから再実行してください（`.venv`内のスクリプトに元のパスが残るため）。

NVIDIA GPUが無い環境（`nvidia-smi`が見つからない場合）では、`setup_windows.ps1`がCPU版のPyTorch / mmcvを入れます（GPUがあっても`-Cpu`を付けるとCPU版になります）。
ビューアはCUDAが使えなければ自動でCPUで推論しますが、1ページの処理はかなり遅くなります。
コマンドラインの`main.py`で使う場合は、`config.yml`の`device: 'cuda:0'`（2か所）を`'cpu'`に変えてください。
CUDA版とCPU版を切り替えるときは`.venv`を削除してから再実行してください。

## ビューアの使い方

- 資料の画面は`/`、ビューアは`/view`。`/view?pid=2592440&page=8`で直接そのコマを開けます。ページ送りに応じてURLも変わるので、ブラウザの戻る・ブックマークが使えます
- 決まったNDLの資料を開くときは、NDLデジタルコレクションのURLにある数字（pid）を使います（`https://dl.ndl.go.jp/pid/2592440`なら`/view?pid=2592440&page=1`）
- NDL以外の資料（IIIFで公開されている資料など）は、PDFや画像にして開けば読めます
- ◀ ▶、キーボードの ← →、画像の左右端のクリックでコマを移動できます。既定は右開き（縦書き）で、◀ が次のコマです
- OCR結果・翻訳・注記はSQLite（`webapp/koten.db`）に保存され、一度読んだページは次から即表示されます
- Claudeの処理はサーバーのバックグラウンドで動くので、待っている間に別のページへ移ったり再読み込みしたりしても続きます

環境変数：

| 名前 | 既定 | 内容 |
|---|---|---|
| `KOTEN_PORT` | `8777` | ポート |
| `KOTEN_HOST` | `127.0.0.1` | 待ち受けるアドレス。`0.0.0.0`でLAN内の他端末（スマホなど）からも開ける |
| `KOTEN_ALLOWED_HOSTS` | | 受け付けるホスト名の追加（カンマ区切り。`KOTEN_HOST=0.0.0.0`のときの`192.168.1.10`など） |
| `KOTEN_CLAUDE_MODEL` | Claude Codeの既定 | 校正・翻訳・注記に使うモデル（例：`sonnet`） |
| `KOTEN_MAX_JOBS` | `2` | Claudeの処理を同時に動かす数（超えた分は順番待ち） |
| `KOTEN_CACHE_DAYS` | `30` | この日数使われなかったNDLの画像を起動時に削除（OCR結果はDBに残る） |
| `KOTEN_MAX_UPLOAD_MB` | `500` | 開ける画像・PDFの大きさの上限 |

**サーバーに認証はありません**。自分の画面以外からのリクエストは受け付けませんが、LANに公開すると同じネットワークの誰でも資料の削除やClaudeの実行ができます。信頼できるネットワークでだけ使ってください。

## OCRをコマンドラインで使う

ビューアを使わずに、画像フォルダをまとめてテキスト化することもできます（NDL古典籍OCRのCLI）。

```powershell
.\.venv\Scripts\activate
python main.py infer input_root output_dir
```

入力は`input_root/img/`の下に画像を置きます。資料ごとのサブフォルダ（`input_root/img/bookid1/page01.jpg` …）で分ける場合は`-s b`を付けます。

```
output_dir/
  ├── input_root/
  │   ├── txt/page01.txt …   : 読み順に並べた本文
  │   └── json/page01.json … : 行ごとの座標と認識文字列
  └── opt.json               : 実行時のオプション
```

- `-a`：出力JSONに画像サイズ等の情報（`imginfo`）を追加します
- 重みファイルのパスなどは`config.yml`で変更できます

Dockerで動かしたい場合は、本家リポジトリの`docker/`と手順を使ってください（このリポジトリでは管理していません）。

## ディレクトリ構成

```
kuzushiji-viewer/
├── webapp/                  : くずし字ビューア（FastAPI + SQLite）
│   ├── server.py            : API とエントリポイント
│   ├── ocr_engine.py        : OCR のモデルを常駐させ、1枚ずつ推論する
│   ├── store.py             : SQLite への保存
│   ├── *_prompt.md          : Claude への依頼文（校正・注記・英訳）
│   └── static/              : 画面（資料・検索・ビューア）
├── main.py, cli/, src/      : NDL古典籍OCR 本体（レイアウト抽出・文字認識・読み順整序）
├── config.yml               : OCR の設定（モデルのパス、device など）
├── setup_windows.ps1        : Windows ネイティブ環境のセットアップ
├── requirements-windows.txt : 推論用の依存パッケージ（Windows）
└── requirements.txt         : 本家の依存パッケージ一覧（再学習用の lmdb / jiwer を含む）
```

## モデルの再学習

- レイアウト認識モデル：[train-layout.ipynb](src/ndl_kotenseki_layout/train-layout.ipynb)、[cococonverter-NDLDocL.ipynb](src/ndl_kotenseki_layout/cococonverter-NDLDocL.ipynb)
- 文字列認識モデル：[train.py](src/text_kotenseki_recognition/train.py)（`requirements.txt`の`lmdb`と`jiwer`が別途必要です）

## 本家（NDL古典籍OCR）との関係

このリポジトリは[ndl-lab/ndlkotenocr_cli](https://github.com/ndl-lab/ndlkotenocr_cli)（ver.3）をもとにしています。本家への変更点は次のとおりです。

- Windowsネイティブ環境（`setup_windows.ps1`、`requirements-windows.txt`）を追加し、Docker環境（`docker/`）は管理外にした
- `cli/`のファイル入出力をUTF-8に明示（Windowsで日本語が文字化け・エラーになるのを防ぐ）
- くずし字ビューア（`webapp/`）を追加

NDL古典籍OCRは、国立国会図書館が[令和3年度OCR関連事業](https://lab.ndl.go.jp/data_set/ocr/)や[NDLラボ](https://lab.ndl.go.jp)の調査研究、人文情報学分野のデータ資源を活用して開発したものです。
データセットや手法の詳細は[古典籍資料のOCRテキスト化実験](https://lab.ndl.go.jp/data_set/r4ocr/r4_koten/)と[OCR学習用データセット（みんなで翻刻）](https://github.com/ndl-lab/ndl-minhon-ocrdataset)を参照してください。

## ライセンス

このリポジトリには2つのライセンスが混在しています。

| 対象 | ライセンス |
|---|---|
| このリポジトリで追加した部分：`webapp/`・`setup_windows.ps1`・`requirements-windows.txt` | [MIT](./LICENSE-MIT) |
| 本家由来の部分（NDL古典籍OCR）：上記以外（`src/`・`cli/`・`main.py`・`config.yml`など。`cli/`への修正を含む） | [CC BY 4.0](./LICENSE) |

## 注意

- OCRには誤りが含まれます。Claudeの校正・翻訳・注記も、もっともらしい誤りを含むことがあります。最終的な確認は画像で行ってください
- 校正・翻訳・注記は、Claude Code CLIを通じてページの画像とOCRテキストをAnthropicに送信します。非公開の資料を扱うときは留意してください（NDLの公開資料は保護期間満了のため問題ありません）
