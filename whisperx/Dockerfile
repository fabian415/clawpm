# WhisperX 語音轉錄 API
# 基底映像：PyTorch + CUDA 12.1（對應 NVIDIA 驅動 ≥ 525）
FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime

# ---- 系統相依套件 ----
# build-essential：編譯 ctc-segmentation 的 C 擴充套件（ctc_segmentation_dyn.c）需要 gcc
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        git \
        curl \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Python 套件 ----
# 安裝 whisperx
# 安裝後立即移除 torchvision：音訊轉錄不需要它，
# 且 whisperx 的某個依賴會從 PyPI 拉入 CPU 版 torchvision，
# 與 CUDA torch 版本不符會造成 'circular import' 錯誤。
RUN pip install --no-cache-dir whisperx && \
    pip uninstall -y torchvision || true

# ctc-segmentation（強制對齊用）內附的 Cython 產生的 .c 檔是舊版 numpy C-API
# 寫法（直接存取 PyArray_Descr 的 struct 欄位），numpy 2.0 改了這個 struct 版面，
# 無法相容且套件多年未更新修正，只能把 numpy 固定在 1.x 才能編譯 + 執行。
# --no-build-isolation：讓它編譯時直接用這裡固定好的 numpy<2，
# 避免 pip 的 build isolation 另外抓一份不同版本的 numpy 造成 ABI 不一致。
RUN pip install --no-cache-dir "numpy<2" && \
    pip install --no-cache-dir --no-build-isolation ctc-segmentation

# 之後所有 pip install 都要帶 "numpy<2"，避免任何套件的相依解析
# 把 numpy 悄悄升回 2.x，導致 ctc-segmentation 又壞掉。
RUN pip install --no-cache-dir \
        "numpy<2" \
        fastapi \
        "uvicorn[standard]" \
        python-multipart \
        funasr \
        deepmultilingualpunctuation \
        soundfile \
        requests \
        opencc-python-reimplemented

# ---- 複製服務腳本 ----
COPY scripts/transcribe_diarize.py /app/
COPY scripts/transcribe_api.py /app/
COPY scripts/transcribe_azure.py /app/
COPY scripts/transcribe_azure_diarize.py /app/
COPY scripts/speaker_db.py /app/

# ---- 資料目錄 ----
RUN mkdir -p /app/uploads /app/outputs /app/speaker_profiles

# ---- 環境變數預設值（可由 docker-compose .env 覆蓋）----
ENV UPLOAD_DIR=/app/uploads \
    OUTPUT_DIR=/app/outputs \
    SPEAKER_DIR=/app/speaker_profiles \
    SPEAKER_SIMILARITY_THRESHOLD=0.75 \
    MAX_FILE_MB=500 \
    JOB_TTL_HOURS=48 \
    JOB_TIMEOUT_SECONDS=10800 \
    MAX_TERMS=30 \
    TRANSCRIBE_ENGINE=whisperx \
    PORT=8000

EXPOSE 8000

# workers=1：GPU 記憶體只夠跑一個 Whisper 模型實例
CMD ["uvicorn", "transcribe_api:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--log-level", "info"]
