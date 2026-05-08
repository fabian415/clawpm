# OpenClaw 整合技術指南

> 內部技術分享文件  
> 適用版本：`ghcr.io/openclaw/openclaw:2026.4.22`

---

## 概覽

本文說明如何：

1. **建立並啟動** 一個獨立的 OpenClaw Gateway Container
2. **完成 Device Pairing**，取得可操作的 Operator Token
3. **透過 JSON-RPC over WebSocket** 與 OpenClaw 進行對話

整體流程如下：

```
Host 後端
 │
 ├─① 配置 workspace 目錄結構 (openclaw.json、.env …)
 ├─② 啟動 Docker Container (掛載 config/ 與 workspace/)
 ├─③ 等待 Container Healthcheck 通過
 ├─④ 執行 docker exec → devices list / devices rotate
 │      → 取得 operatorToken 與 deviceId
 │
 └─⑤ WebSocket 連線 (JSON-RPC)
        ← connect.challenge
        → connect (帶簽名)
        → chat.send  /  chat.history
```

---

## 一、目錄結構

每個使用者（`userId`）都有一套獨立的目錄，預設放在 `~/.openclaw/users/<userId>/`。

```
~/.openclaw/users/<userId>/
├── config/                     # 掛載到容器的 /home/node/.openclaw
│   ├── openclaw.json           # Gateway 主設定
│   ├── .env                    # API Key（如 GEMINI_API_KEY）
│   └── identity/
│       └── device.json         # Gateway 啟動後自動產生的裝置金鑰
└── workspace/                  # 掛載到容器的 /home/node/.openclaw/workspace
    ├── skills/                 # 技能包（可選）
    └── ftp_data/               # FTP 上傳資料
```

**關鍵原則：** `config/` 目錄會整個掛載進容器，因此 `openclaw.json` 裡的設定在容器啟動後即生效；容器產生的 `identity/device.json` 也會回寫到 Host，讓後端可以直接讀取。

---

## 二、openclaw.json 最小設定

Gateway 啟動時讀取 `/home/node/.openclaw/openclaw.json`（即 Host 上的 `config/openclaw.json`）。

### 使用 Gemini 的範例

```json
{
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
      "sandbox": { "mode": "off" },
      "models": { "google/gemini-2.5-flash": {} },
      "model": { "primary": "google/gemini-2.5-flash" }
    }
  },
  "gateway": {
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "<隨機產生的 hex token>"
    },
    "port": 18789,
    "bind": "lan",
    "tailscale": { "mode": "off", "resetOnExit": false },
    "controlUi": {
      "allowInsecureAuth": true,
      "allowedOrigins": [
        "http://localhost:18789",
        "http://127.0.0.1:18789",
        "http://localhost:<hostPort>"
      ]
    }
  },
  "session": { "dmScope": "per-channel-peer" },
  "tools": { "profile": "coding" },
  "plugins": {
    "entries": { "google": { "enabled": true } }
  }
}
```

`token` 就是 **Gateway Token**，是後端連線的第一道認證。建議使用 `crypto.randomBytes(32).toString('hex')` 產生。

### 使用自訂 OpenAI-compatible API 的範例

```json
{
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
      "model": { "primary": "custom/<modelId>" },
      "models": { "custom/<modelId>": {} }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "custom": {
        "baseUrl": "https://your-llm-endpoint/v1",
        "apiKey": "<your-api-key>",
        "api": "openai-completions",
        "models": [{
          "id": "<modelId>",
          "name": "<modelId>",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 131072,
          "maxTokens": 8192
        }]
      }
    }
  },
  "gateway": { "..." : "（同上）" }
}
```

---

## 三、啟動 Container

透過 Docker API（此專案使用 `dockerode`）建立並啟動容器。

### 關鍵參數

| 參數 | 說明 |
|---|---|
| `Image` | `ghcr.io/openclaw/openclaw:2026.4.22` |
| `Cmd` | `node dist/index.js gateway --bind lan --port 18789` |
| `18789/tcp` | Gateway WebSocket 埠（對外） |
| `18790/tcp` | Bridge 埠（保留，目前不一定用到） |
| `config/` → `/home/node/.openclaw` | 設定與金鑰掛載 |
| `workspace/` → `/home/node/.openclaw/workspace` | 工作區掛載 |
| `OPENCLAW_GATEWAY_TOKEN` | 可選環境變數，與 `openclaw.json` 裡的 `token` 一致即可 |

### Healthcheck

容器內建的 healthcheck 每 15 秒輪詢一次 `http://127.0.0.1:18789/healthz`。
Gateway 第一次啟動需要 ~100 秒完成初始化，因此 `StartPeriod` 設為 150 秒。

```
healthy → 可以開始 Device Pairing
```

---

## 四、Device Pairing

Device Pairing 的目的是取得 **Operator Token**，這個 token 的權限比 Gateway Token 更高，可以進行對話操作。

### 流程

```
1. 等待容器 health = healthy
2. docker exec → openclaw devices list --json
   └─ 找到 Container 自動建立的 device (從 config/identity/device.json 比對 deviceId)
3. docker exec → openclaw devices rotate --device <deviceId> --role operator --json
   └─ 取得 operatorToken
4. 將 { deviceId, operatorToken } 存到後端 DB
```

### docker exec 指令對應

```bash
# 列出已配對裝置
node dist/index.js devices list --token <gatewayToken> --json

# 輪換（或首次核發）Operator Token
node dist/index.js devices rotate \
  --device <deviceId> \
  --role operator \
  --scope operator.read \
  --scope operator.write \
  --scope operator.approvals \
  --token <gatewayToken> \
  --json
```

`devices list` 回傳格式：
```json
{
  "pending": [],
  "paired": [
    { "deviceId": "abc123...", "role": "operator", "scopes": [...] }
  ]
}
```

`devices rotate` 回傳格式（可能因版本不同而略有差異）：
```json
{ "token": "xxxxxxxx..." }
```

---

## 五、透過 JSON-RPC over WebSocket 進行對話

### 5.1 協定基礎

OpenClaw Gateway 使用 WebSocket + 自定義 JSON-RPC 協定（**Protocol Version 3**）：

```
Client → Gateway:  { "type": "req",   "id": "<uuid>", "method": "...", "params": {...} }
Gateway → Client:  { "type": "res",   "id": "<uuid>", "ok": true/false, "payload": {...} }
Gateway → Client:  { "type": "event", "event": "...", "payload": {...} }
```

### 5.2 連線握手（Auth Flow）

連線後 Gateway **主動** 發出 challenge，Client 必須回應已簽名的 `connect` request。

```
Client                         Gateway
  │                                │
  │── WebSocket open ─────────────>│
  │                                │
  │<── event: connect.challenge ───│  payload: { nonce: "..." }
  │                                │
  │── req: connect ───────────────>│  params 見下方
  │                                │
  │<── res: connect (ok: true) ────│  payload: { auth: { scopes: [...] } }
```

### 5.3 connect 的 params 結構

```json
{
  "minProtocol": 3,
  "maxProtocol": 3,
  "client": {
    "id": "cli",
    "version": "1.0.0",
    "platform": "linux",
    "mode": "cli"
  },
  "role": "operator",
  "scopes": ["operator.read", "operator.write", "operator.approvals"],
  "locale": "zh-TW",
  "userAgent": "your-backend/1.0.0",
  "auth": {
    "deviceToken": "<operatorToken>"
  },
  "device": {
    "id": "<deviceId>",
    "publicKey": "<ed25519 public key, base64url>",
    "signature": "<ed25519 signature, base64url>",
    "signedAt": 1234567890123,
    "nonce": "<nonce from challenge>"
  }
}
```

#### 簽名計算

簽名的 payload 是下列欄位用 `|` 串接的字串（Protocol v3）：

```
v3|<deviceId>|<clientId>|<clientMode>|<role>|<scopes(逗號分隔)>|<signedAtMs>|<token>|<nonce>|<platform>|
```

使用容器產生的 Ed25519 私鑰（`config/identity/device.json` 裡的 `privateKeyPem`）做 Ed25519 簽名，結果轉 base64url。

> **注意：** `platform` 填 `linux`，因為 device identity 是在 Linux Container 內產生的，即使後端執行在 macOS 也要填 `linux`。

### 5.4 發送訊息

連線建立後，發送使用者訊息：

```json
{
  "type": "req",
  "id": "<uuid>",
  "method": "chat.send",
  "params": {
    "sessionKey": "agent:main:main",
    "message": "請幫我整理今天的會議記錄",
    "idempotencyKey": "<uuid>"
  }
}
```

`chat.send` 回傳 `ok: true` 後，Assistant **不會** 即時推播回應，需要輪詢 `chat.history`。

### 5.5 輪詢歷史（Polling）

```json
{
  "type": "req",
  "id": "<uuid>",
  "method": "chat.history",
  "params": {
    "sessionKey": "agent:main:main",
    "limit": 200
  }
}
```

回傳的 `payload` 是訊息陣列，每個訊息包含 `id`、`role`、`content`、`createdAt` 等欄位。

**判斷完成的方式：** 輪詢間隔 800ms，連續 **2 次** 訊息列表的內容完全相同（以 `role:content` 串接比較），即視為 Assistant 回覆完畢。

```
chat.send ──→ 開始輪詢 chat.history
              ↓ 800ms
              history 有變化？→ 繼續輪詢（stableCount = 0）
              ↓ 800ms
              history 無變化？→ stableCount++
              stableCount >= 2 → 完成
```

### 5.6 SessionKey 格式

SessionKey 決定訊息的對話範圍：

| 用途 | SessionKey |
|---|---|
| 預設主對話 | `agent:main:main` |
| 新建獨立對話 | `agent:main:chat:<timestamp>-<uuid前8碼>` |

每次呼叫 `chat.send` 與 `chat.history` 要使用同一個 sessionKey，才能存取到同一個對話串。

---

## 六、完整流程小結

```
POST /api/provision
 │
 ├─ 1. 分配 Port（gatewayPort, bridgePort）
 ├─ 2. 建立 workspace 目錄 + openclaw.json（含 gatewayToken）
 ├─ 3. 寫入 openclaw.json（LLM 設定）
 ├─ 4. 確認 Image 存在，不存在就 pull
 ├─ 5. createAndStartContainer（掛載 config/ 與 workspace/）
 ├─ 6. pairDevice（等 healthy → exec devices list → exec devices rotate）
 │      → 存入 { deviceId, operatorToken }
 └─ 7. completeSetup（將 auth user 連結到 workspace userId）

WebSocket /ws/chat
 │
 ├─ auth（驗證 JWT）
 ├─ message → handleChatMessage
 │    ├─ getClientForUser(provisionUserId)  → OpenClawGatewayClient
 │    ├─ ensureConnected()                  → WebSocket 握手（connect.challenge + connect）
 │    └─ sendAndStream()                    → chat.send + 輪詢 chat.history
 └─ new_session → 建立新的 sessionKey
```

---

## 七、常見問題

**Q：為什麼 device pairing 要等到 healthcheck 通過才能做？**  
A：Gateway 需要約 100 秒完成初始化，並在過程中自動產生 `config/identity/device.json`。在這之前執行 `devices list` 會找不到任何 device。

**Q：operatorToken 和 gatewayToken 有什麼差別？**  
A：`gatewayToken` 是 openclaw.json 裡的共用 token，任何人都可以用它連線（但權限受限）。`operatorToken` 是針對特定 device 核發的 token，具備 `operator.write` 等完整操作權限，才能執行 `chat.send`。

**Q：為什麼需要 Ed25519 簽名？只用 token 不夠嗎？**  
A：Gateway 採用 Device Authentication，簽名確保連線的 Client 持有對應裝置的私鑰，防止 token 被竊用後冒充已知裝置。

**Q：Assistant 的回覆為什麼要用 polling 而不是 event-driven？**  
A：Gateway 目前不會主動 push assistant 回覆的增量，只能透過 `chat.history` 輪詢。`POLL_INTERVAL_MS = 800ms`，`POLL_STABLE_COUNT = 2` 是在延遲與效能間取得的平衡。
