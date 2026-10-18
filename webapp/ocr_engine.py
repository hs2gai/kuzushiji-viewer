# くずし字ビューア用の OCR エンジンラッパー
#
# cli/core/inference.py の OcrInferencer は「入力ディレクトリ → 出力ディレクトリ」の
# バッチ実行専用なので、モデルを常駐させたまま画像1枚を推論できる薄いラッパーを提供する。

import os
import sys
import threading

import cv2
import torch
import yaml

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from cli.core.inference import OcrInferencer  # noqa: E402


class OcrEngine:
    """モデルを1回だけロードし、画像1枚ずつ推論する。GPU 推論はスレッドセーフでないためロックで直列化する。"""

    def __init__(self, config_path=os.path.join(REPO_ROOT, 'config.yml')):
        with open(config_path, 'r', encoding='utf-8') as f:
            cfg = yaml.safe_load(f)
        # config.yml のモデルパスはリポジトリ直下からの相対パスなので絶対パスに直す
        for section in cfg.values():
            for key, value in section.items():
                if key.endswith('_path') or key.startswith('saved_'):
                    section[key] = os.path.join(REPO_ROOT, value)
        # CUDA が使えない環境（NVIDIA GPU なし・CPU 版 PyTorch）では config.yml を書き換えずに CPU で動かす
        if not torch.cuda.is_available():
            for section in cfg.values():
                if str(section.get('device', '')).startswith('cuda'):
                    print(f"CUDA が使えないため CPU で推論します（config.yml の device: {section['device']} を無視）")
                    section['device'] = 'cpu'
        cfg['proc_range'] = {'start': 0, 'end': 2}
        cfg['input_structure'] = 's'
        cfg['add_info'] = False
        self._inferencer = OcrInferencer(cfg)
        self._lock = threading.Lock()

    def run(self, img_path):
        img = cv2.imread(img_path)
        if img is None:
            raise ValueError(f'画像を読み込めません: {img_path}')
        return self.run_image(img, os.path.basename(img_path))

    def run_image(self, img, name='page.jpg'):
        """
        画像（BGR の ndarray）を推論する。ファイルを介さないので中身をディスクに残さない。

        Returns
        -------
        dict: {'width', 'height', 'lines': [{'x1','y1','x2','y2','text'}, ...], 'text'}
              lines は読み順に整序済み。
        """
        h, w = img.shape[:2]
        data = [{
            'img_path': name,
            'img_file_name': name,
            'output_dir': '',
            'img': img,
            'img_width': w,
            'img_height': h,
        }]
        with self._lock:
            for proc in self._inferencer.proc_list:
                outputs = []
                for idx, d in enumerate(data):
                    outputs.extend(proc.do(idx, d))
                data = outputs
        result = data[0]
        lines = [
            {'x1': int(l[0]), 'y1': int(l[1]), 'x2': int(l[2]), 'y2': int(l[3]), 'text': l[4]}
            for l in result['json']
        ]
        return {'width': w, 'height': h, 'lines': lines, 'text': result['text']}
