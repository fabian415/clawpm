# Sidecar: 常駐的 LibreOffice 轉檔服務（unoserver），給 PPTX 整頁截圖用。
# 只有這個 image 需要扛 LibreOffice 的體積，主要的 OpenClaw image 維持瘦身。
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-impress fonts-noto-cjk python3-pip python3-uno \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --break-system-packages --no-cache-dir unoserver

EXPOSE 2003

CMD ["unoserver", "--interface", "0.0.0.0", "--port", "2003"]
