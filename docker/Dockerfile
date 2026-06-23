FROM ghcr.io/openclaw/openclaw:2026.6.8

USER root

# The container runs as root with HOME=/home/node (set at `docker run` time), but
# openclaw resolves its home directory from the root passwd entry rather than $HOME,
# so without this, `openclaw plugins install` writes to /root/.openclaw instead of the
# bind-mounted, persistent /home/node/.openclaw — installing the plugin but never
# letting the gateway see it.
RUN sed -i 's#^root:x:0:0:root:/root:#root:x:0:0:root:/home/node:#' /etc/passwd

RUN apt-get update && apt-get install -y --no-install-recommends python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir \
        pdfplumber python-docx pandas openpyxl xlrd \
        google-genai markdown python-dotenv requests python-pptx


