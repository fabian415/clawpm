#!/usr/bin/env python3
"""
render_preview.py — 把 .pptx 轉成每頁 PNG 縮圖,供前端預覽。

管線:pptx --(unoserver / LibreOffice)--> pdf --(pymupdf)--> page-NN.png

unoserver 是一個常駐的 LibreOffice 轉檔 sidecar(clawpm-unoserver,監聽 host 2003 埠)。
動態建立的 per-user OpenClaw 容器不在同一個 compose network,透過 host.docker.internal
連過去。本容器已安裝 unoserver(提供 unoconvert CLI)與 pymupdf。

用法:
    python3 render_preview.py --pptx deck.pptx --out-dir preview/ \
        [--uno-host host.docker.internal] [--uno-port 2003] [--dpi 130]

輸出:preview/page-01.png, page-02.png, ...  並在 stdout 印出 JSON 結果。
失敗不應讓整個簡報流程失敗(pptx 本身已產出),故錯誤以 JSON ok:false 回報。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile


def pptx_to_pdf(pptx, pdf_path, host, port, timeout=180):
    """透過 unoserver 把 pptx 轉 pdf。

    注意:一定要用 `unoconvert` 這個 entry-point，不能用 `python -m unoserver.client`——
    後者在此版本會直接 exit 0 但不做任何事、不產出檔案，導致「明明成功卻沒有 pdf」的假象。
    跨容器時 host 不是 localhost，unoconvert 的 --host-location 需為 remote，讓檔案內容走
    XMLRPC 傳輸(auto 在某些情況判斷錯誤)。
    """
    candidates = [
        ["unoconvert", "--host", host, "--port", str(port),
         "--host-location", "remote", "--convert-to", "pdf", pptx, pdf_path],
        ["unoconvert", "--host", host, "--port", str(port),
         "--convert-to", "pdf", pptx, pdf_path],
    ]
    last_err = None
    for cmd in candidates:
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=timeout, text=True)
            if os.path.isfile(pdf_path) and os.path.getsize(pdf_path) > 0:
                return True, None
            last_err = (proc.stderr or proc.stdout or "").strip()[-300:] or f"exit {proc.returncode}，未產生 pdf"
        except Exception as e:
            last_err = repr(e)
    return False, last_err or "pdf 未產生"


def pdf_to_png(pdf_path, out_dir, dpi):
    import fitz  # pymupdf
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pages = []
    for i, page in enumerate(doc, start=1):
        pix = page.get_pixmap(matrix=mat)
        fp = os.path.join(out_dir, f"page-{i:02d}.png")
        pix.save(fp)
        pages.append(os.path.basename(fp))
    doc.close()
    return pages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pptx", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--uno-host", default=os.environ.get("UNOSERVER_HOST", "host.docker.internal"))
    ap.add_argument("--uno-port", default=os.environ.get("UNOSERVER_PORT", "2003"))
    ap.add_argument("--dpi", type=int, default=130)
    args = ap.parse_args()

    result = {"ok": False, "pages": [], "out_dir": args.out_dir}
    if not os.path.isfile(args.pptx):
        result["error"] = f"找不到 pptx:{args.pptx}"
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0)

    with tempfile.TemporaryDirectory() as tmp:
        pdf_path = os.path.join(tmp, "deck.pdf")
        ok, err = pptx_to_pdf(args.pptx, pdf_path, args.uno_host, args.uno_port)
        if not ok:
            result["error"] = f"pptx→pdf 轉檔失敗(unoserver {args.uno_host}:{args.uno_port}):{err}"
            print(json.dumps(result, ensure_ascii=False))
            sys.exit(0)
        try:
            pages = pdf_to_png(pdf_path, args.out_dir, args.dpi)
            result["ok"] = True
            result["pages"] = pages
        except Exception as e:
            result["error"] = f"pdf→png 失敗:{e}"

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
