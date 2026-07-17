# Sidecar: 把技術分享文章改寫成部落格文章（中/英 + 封面圖）的無狀態 HTTP 服務。
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8010

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010"]
