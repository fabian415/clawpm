# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend runtime
FROM node:22-alpine
WORKDIR /app
# git: 供部落格發布功能 clone/push 外部 Azure DevOps repo 用
RUN apk add --no-cache git
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ .
COPY version.txt ./
COPY release_note.txt ./
# server.js resolves ../frontend/dist → /frontend/dist (relative to /app)
COPY --from=frontend-builder /build/dist /frontend/dist
EXPOSE 3000
CMD ["node", "server.js"]
