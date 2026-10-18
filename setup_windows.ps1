# NDL古典籍OCR Windows ネイティブ環境セットアップスクリプト（Docker / WSL 不要）
#
# 前提:
#   - NVIDIA GPU + ドライバ 520.06 以上（CUDA 12.1 対応。CUDA Toolkit のインストールは不要）
#     NVIDIA GPU が無い（nvidia-smi が見つからない）環境、または -Cpu 指定時は CPU 版の PyTorch / mmcv を入れる
#   - uv (https://docs.astral.sh/uv/) がインストール済み
#       winget install astral-sh.uv   または   pip install uv
#     Python 3.10 が無い場合は uv が自動でダウンロードする
#
# 使い方（リポジトリ直下で実行）:
#   powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1 -Cpu   # GPU があっても CPU 版にする
#
# 実行後:
#   .\.venv\Scripts\activate
#   python main.py infer input_root output_dir

param([switch]$Cpu)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# CUDA 版か CPU 版か（PyTorch と mmcv の取得先を切り替える）
$Variant = if ($Cpu -or -not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { 'cpu' } else { 'cu121' }
$TorchIndex = "https://download.pytorch.org/whl/$Variant"
$MmcvIndex  = "https://download.openmmlab.com/mmcv/dist/$Variant/torch2.1/index.html"
$LayoutModelUrl = 'https://lab.ndl.go.jp/dataset/ndlkotensekiocr/layoutmodel/ndl_kotenseki_layout_ver3.pth'
$TrocrModelUrl  = 'https://lab.ndl.go.jp/dataset/ndlkotensekiocr/trocr/model-ver2.zip'
$LayoutModelPath = 'src\ndl_kotenseki_layout\models\ndl_kotenseki_layout_ver3.pth'
$TrocrZipPath    = 'src\text_kotenseki_recognition\model-ver2.zip'
$TrocrModelDir   = 'src\text_kotenseki_recognition\model-ver2'
$Py = '.\.venv\Scripts\python.exe'

# ネイティブコマンドの失敗を検知して停止する
function Invoke-Step {
    param([string]$Title, [scriptblock]$Command)
    Write-Host "`n==> $Title" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "失敗: $Title (exit code $LASTEXITCODE)" }
}

function Get-FileIfMissing {
    param([string]$Url, [string]$Dest)
    if (Test-Path $Dest) {
        Write-Host "  スキップ（既存）: $Dest"
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
    Invoke-Step "ダウンロード: $Url" { curl.exe -L --fail --progress-bar -o $Dest $Url }
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Error 'uv が見つかりません。winget install astral-sh.uv などでインストールしてから再実行してください。'
}

# 1. 仮想環境（Python 3.10 固定: mmcv 2.1.0 の Windows wheel が cp310/cp311 のみ提供のため）
if (-not (Test-Path $Py)) {
    Invoke-Step 'Python 3.10 仮想環境 (.venv) を作成' { uv venv --python 3.10 .venv }
} else {
    Write-Host '  スキップ（既存）: .venv'
}

# 2. PyTorch
Invoke-Step "PyTorch 2.1.1 ($Variant) をインストール" {
    uv pip install --python $Py torch==2.1.1 torchvision==0.16.1 torchaudio==2.1.1 torchtext==0.16.1 --index-url $TorchIndex
}

# 3. mmcv（OpenMMLab 提供の Windows 向けビルド済み wheel）
Invoke-Step "mmcv 2.1.0 ($Variant) をインストール" {
    uv pip install --python $Py mmcv==2.1.0 -f $MmcvIndex
}

# 4. その他の依存パッケージ
Invoke-Step 'requirements-windows.txt をインストール' {
    uv pip install --python $Py -r requirements-windows.txt
}

# 4b. くずし字ビューア（webapp）用パッケージ
Invoke-Step 'webapp/requirements.txt をインストール' {
    uv pip install --python $Py -r webapp\requirements.txt
}

# 5. モデルファイル
Get-FileIfMissing -Url $LayoutModelUrl -Dest $LayoutModelPath
Get-FileIfMissing -Url $TrocrModelUrl  -Dest $TrocrZipPath
if (-not (Test-Path $TrocrModelDir)) {
    Write-Host "`n==> 文字認識モデルを展開: $TrocrZipPath" -ForegroundColor Cyan
    Expand-Archive -Path $TrocrZipPath -DestinationPath (Split-Path $TrocrZipPath) -Force
} else {
    Write-Host "  スキップ（既存）: $TrocrModelDir"
}

# 6. 動作確認
Invoke-Step 'インストール確認' {
    & $Py -c "import torch, mmcv, mmdet, transformers; print('torch', torch.__version__, '/ CUDA:', torch.cuda.is_available(), '/ mmcv', mmcv.__version__, '/ mmdet', mmdet.__version__)"
}

Write-Host "`nセットアップ完了 🎉" -ForegroundColor Green
Write-Host '  .\.venv\Scripts\activate'
Write-Host '  python main.py infer input_root output_dir'
