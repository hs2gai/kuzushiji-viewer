# Kuzushiji Viewer

[日本語](README.ja.md)

A local web app for reading classical Japanese books written in kuzushiji (cursive script).
It runs OCR on each page with your own GPU and lays the transcription over the page image, line by line, as vertical text.
The OCR engine is the National Diet Library's [NDL Kotenseki OCR (ver.3)](https://github.com/ndl-lab/ndlkotenocr_cli).

- Open books from the NDL Digital Collections (search them from the library screen), or your own images and PDFs. OCR runs page by page as you read
- The transcription layer covers only the text lines (illustrations stay as they are). Opacity, font size, letter spacing, color and zoom are adjustable
- With the [Claude Code CLI](https://docs.anthropic.com/claude-code), Claude can proofread the OCR against the image and write a modern Japanese translation, notes and an English translation for each page — one page at a time, or a whole book at once
- A library screen: search the NDL's classical books, recommended books to start with, bibliographic data, filtering, renaming, deleting and downloading transcriptions

Public demo (runs in the browser; the hosting code is not part of this repository): https://kuzushiji-viewer.hs2g.com

## Getting started (Windows)

Requirements:
- Windows 10 / 11 (64-bit)
- An NVIDIA GPU with driver 520.06 or later (CUDA 12.1; the CUDA Toolkit is not needed). It also runs on the CPU, only much slower (see below)
- [uv](https://docs.astral.sh/uv/) (`winget install astral-sh.uv`). uv fetches Python 3.10 if you don't have it
  - Python is pinned to 3.10 because the prebuilt Windows wheels of mmcv 2.1.0 exist only for cp310 / cp311
- Optional: the [Claude Code CLI](https://docs.anthropic.com/claude-code), logged in with `claude` (works with a subscription; no API key needed), for proofreading, translation and notes

```powershell
git clone https://github.com/hs2gai/kuzushiji-viewer
cd kuzushiji-viewer
powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1   # virtual env, dependencies and models (about 1.5 GB)
.\.venv\Scripts\python.exe webapp\server.py                     # open http://127.0.0.1:8777/ once the models are loaded
```

`setup_windows.ps1` is safe to run again (it skips the `.venv` and models that already exist).
If you move or rename the folder, delete `.venv` and run it again (scripts in `.venv` keep the old path).

Without an NVIDIA GPU (when `nvidia-smi` is not found), `setup_windows.ps1` installs the CPU builds of PyTorch / mmcv (`-Cpu` forces them even with a GPU).
The viewer falls back to the CPU automatically, but each page takes much longer.
For the command-line `main.py`, change `device: 'cuda:0'` (two places) in `config.yml` to `'cpu'`.
When switching between the CUDA and CPU builds, delete `.venv` and run the script again.

## Using the viewer

- The library is at `/` and the viewer at `/view`. `/view?pid=2592440&page=8` opens that frame directly, and the URL follows as you turn pages, so the browser's back button and bookmarks work
- To open an NDL book you already know, use its pid: the number in its NDL Digital Collections URL (`https://dl.ndl.go.jp/pid/2592440` → `/view?pid=2592440&page=1`)
- Books from other libraries (such as IIIF collections) can be read by saving them as a PDF or images and opening that file
- Turn pages with ◀ ▶, the ← → keys, or by clicking the left/right edge of the image. The default is right-to-left (vertical writing), where ◀ is the next frame
- OCR results, translations and notes are saved in SQLite (`webapp/koten.db`), so pages you have read open instantly next time
- Claude jobs run in the background on the server: you can move to other pages or reload while they run

Environment variables:

| Name | Default | Meaning |
|---|---|---|
| `KOTEN_PORT` | `8777` | Port |
| `KOTEN_HOST` | `127.0.0.1` | Address to listen on. `0.0.0.0` opens it to your LAN (e.g. a phone) |
| `KOTEN_ALLOWED_HOSTS` | | Extra host names allowed in requests, comma-separated (e.g. `192.168.1.10` when using `KOTEN_HOST=0.0.0.0`) |
| `KOTEN_CLAUDE_MODEL` | Claude Code's default | Model for proofreading, translation and notes (e.g. `sonnet`) |
| `KOTEN_MAX_JOBS` | `2` | Claude jobs that run at the same time (the rest wait in line) |
| `KOTEN_CACHE_DAYS` | `30` | NDL images unused for this many days are deleted at startup (OCR results stay in the DB) |
| `KOTEN_MAX_UPLOAD_MB` | `500` | Largest image / PDF you can open |

**The server has no authentication.** It only accepts requests from its own pages, but if you open it to your LAN, anyone on that network can delete books or run Claude. Use it only on networks you trust.

## Using the OCR from the command line

You can also turn a folder of images into text without the viewer (the NDL Kotenseki OCR CLI).

```powershell
.\.venv\Scripts\activate
python main.py infer input_root output_dir
```

Put the images under `input_root/img/`. Add `-s b` to split them into one subfolder per book (`input_root/img/bookid1/page01.jpg` …).

```
output_dir/
  ├── input_root/
  │   ├── txt/page01.txt …   : text in reading order
  │   └── json/page01.json … : coordinates and text of each line
  └── opt.json               : options used
```

- `-a` adds image information (`imginfo`) to the JSON
- Model paths and other settings are in `config.yml`

For Docker, use the `docker/` setup of the upstream repository (it is not maintained here).

## Directory layout

```
kuzushiji-viewer/
├── webapp/                  : Kuzushiji Viewer (FastAPI + SQLite)
│   ├── server.py            : API and entry point
│   ├── ocr_engine.py        : keeps the OCR models loaded and runs them one image at a time
│   ├── store.py             : SQLite storage
│   ├── *_prompt.md          : prompts for Claude (proofreading, notes, English translation)
│   └── static/              : the screens (library, search, viewer)
├── main.py, cli/, src/      : NDL Kotenseki OCR (layout detection, text recognition, reading order)
├── config.yml               : OCR settings (model paths, device)
├── setup_windows.ps1        : sets up the native Windows environment
├── requirements-windows.txt : packages for inference on Windows
└── requirements.txt         : upstream package list (includes lmdb / jiwer for training)
```

## Retraining the models

- Layout model: [train-layout.ipynb](src/ndl_kotenseki_layout/train-layout.ipynb), [cococonverter-NDLDocL.ipynb](src/ndl_kotenseki_layout/cococonverter-NDLDocL.ipynb)
- Text recognition model: [train.py](src/text_kotenseki_recognition/train.py) (needs `lmdb` and `jiwer` from `requirements.txt`)

## Relation to NDL Kotenseki OCR

This repository is based on [ndl-lab/ndlkotenocr_cli](https://github.com/ndl-lab/ndlkotenocr_cli) (ver.3), with these changes:

- Added a native Windows environment (`setup_windows.ps1`, `requirements-windows.txt`); the Docker environment (`docker/`) is not maintained here
- Made file I/O in `cli/` explicitly UTF-8 (avoids garbled Japanese and errors on Windows)
- Added the Kuzushiji Viewer (`webapp/`)

NDL Kotenseki OCR was developed by the National Diet Library through its [FY2021 OCR projects](https://lab.ndl.go.jp/data_set/ocr/), research at [NDL Lab](https://lab.ndl.go.jp), and data resources from the digital humanities.
For the datasets and methods, see [the OCR experiment on classical materials](https://lab.ndl.go.jp/data_set/r4ocr/r4_koten/) and [the OCR training dataset (Minna de Honkoku)](https://github.com/ndl-lab/ndl-minhon-ocrdataset).

## License

This repository contains two licenses.

| Part | License |
|---|---|
| Added in this repository: `webapp/`, `setup_windows.ps1`, `requirements-windows.txt` | [MIT](./LICENSE-MIT) |
| From upstream (NDL Kotenseki OCR): everything else (`src/`, `cli/`, `main.py`, `config.yml`, …, including the changes to `cli/`) | [CC BY 4.0](./LICENSE) |

## Notes

- OCR makes mistakes, and Claude's proofreading, translations and notes can contain plausible-looking errors. Check against the image in the end
- Proofreading, translation and notes send the page image and OCR text to Anthropic through the Claude Code CLI. Keep this in mind for non-public materials (the NDL's public materials are out of copyright)
