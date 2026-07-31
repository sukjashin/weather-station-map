#!/usr/bin/env python3
"""360° 파노라마 사진을 웹용으로 줄입니다.

원본은 건드리지 않고 결과만 따로 저장합니다.

    pip install pillow
    python3 tools/shrink-panoramas.py <원본폴더> [결과폴더]

기본값은 결과를 panoramas/ 에 넣습니다.

파일 이름이 '165.jpg'처럼 지점번호면 CSV의 panorama 칸에 그대로 적으면 됩니다.
이름이 다르면 --rename 으로 지점번호를 앞에 붙일 수 있습니다.

용량 기준 (가로 폭)
  4096px  원본 보관용. 장당 3~8MB — 저장소에 넣기엔 너무 큽니다.
  2048px  휴대폰에서 보기 충분. 장당 0.6~1.2MB  ← 기본값
  1600px  더 가볍게. 화질 차이가 눈에 띄기 시작합니다.
"""
import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow가 필요합니다:  pip install pillow")

EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def main():
    ap = argparse.ArgumentParser(description="파노라마 사진을 웹용 크기로 줄입니다.")
    ap.add_argument("src", type=Path, help="원본 사진이 든 폴더")
    ap.add_argument("dst", type=Path, nargs="?", default=Path("panoramas"), help="결과를 넣을 폴더")
    ap.add_argument("--width", type=int, default=2048, help="가로 폭 픽셀 (기본 2048)")
    ap.add_argument("--quality", type=int, default=82, help="JPEG 품질 1~95 (기본 82)")
    ap.add_argument("--rename", metavar="지점번호CSV",
                    help="'파일명,지점번호' 두 칸짜리 CSV를 주면 지점번호.jpg 로 저장합니다")
    args = ap.parse_args()

    if not args.src.is_dir():
        sys.exit(f"원본 폴더가 없습니다: {args.src}")

    rename = {}
    if args.rename:
        import csv
        with open(args.rename, encoding="utf-8-sig", newline="") as f:
            for row in csv.reader(f):
                if len(row) >= 2 and row[0].strip():
                    rename[row[0].strip()] = row[1].strip()

    args.dst.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in args.src.iterdir() if p.suffix.lower() in EXTS)
    if not files:
        sys.exit(f"{args.src} 안에 사진이 없습니다.")

    before = after = 0
    warned = []
    for i, p in enumerate(files, 1):
        with Image.open(p) as im:
            w, h = im.size
            # 360° 파노라마는 가로:세로가 2:1이어야 제대로 펼쳐집니다.
            if abs(w / h - 2) > 0.05:
                warned.append(f"{p.name} ({w}x{h}, 비율 {w/h:.2f})")
            if w > args.width:
                im = im.resize((args.width, round(args.width * h / w)), Image.LANCZOS)
            im = im.convert("RGB")
            name = rename.get(p.name, p.stem)
            out = args.dst / f"{name}.jpg"
            im.save(out, "JPEG", quality=args.quality, optimize=True, progressive=True)

        b, a = p.stat().st_size, out.stat().st_size
        before += b
        after += a
        print(f"[{i}/{len(files)}] {p.name} → {out.name}  {human(b)} → {human(a)}")

    print(f"\n{len(files)}장  {human(before)} → {human(after)}  "
          f"({after / before * 100:.0f}%, {human(before - after)} 절약)")
    if warned:
        print(f"\n⚠️ 2:1 비율이 아닌 사진 {len(warned)}장 — 파노라마로 펼치면 어긋나 보입니다:")
        for w in warned[:10]:
            print("   " + w)
        if len(warned) > 10:
            print(f"   … 외 {len(warned) - 10}장")


if __name__ == "__main__":
    main()
