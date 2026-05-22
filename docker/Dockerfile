FROM ghcr.io/openclaw/openclaw:2026.4.22

USER root

RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir \
        pdfplumber python-docx pandas openpyxl xlrd \
        google-genai markdown python-dotenv requests


