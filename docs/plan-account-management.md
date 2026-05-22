# 功能規劃：帳號管理（Account Management）

## 概述

ClawPM 目前是單人帳號系統。本次新增「Team」概念與兩層角色架構（`admin` / `user`），支援多個 Team 並存、多位管理員，讓 admin 可以邀請成員共用同一個容器與工作區，並可將成員升級為 admin。

---

## 角色定義

| 功能 | Admin（原 Team Leader） | User（原 Team Member） |
|------|:-----------:|:-----------:|
| 登入 / 登出 | ✅ | ✅ |
| 上傳錄音檔 | ✅ | ✅ |
| 上傳文件 | ✅ | ✅ |
| 使用 OpenClaw 聊天 | ✅ | ✅ |
| 執行工作流程（Step 1–5）| ✅ | ✅ |
| 建立容器（Provision） | ✅ | ❌ |
| 重啟容器 | ✅ | ❌ |
| 刪除容器 | ✅ | ❌ |
| 新增 / 刪除 Team 成員 | ✅ | ❌ |
| 查看成員列表 | ✅ | ❌ |
| 升級成員為 Admin | ✅ | ❌ |
| 降級 Admin 為 User | ✅ | ❌ |

---

## 核心設計決策

### 1. Team 實體

引入獨立的 `teams.json`，一個 Team 對應一個容器 / workspace。

```jsonc
// data/teams.json
{
  "teams": [
    {
      "id": "team_1234_abc",
      "name": "研發一組",
      "workspaceFolder": "rd-team-1",   // 對應容器 userId
      "createdAt": "2026-05-13T..."
    }
  ]
}
```

### 2. 共用工作區（Shared Workspace）

- 所有屬於同一 Team 的成員（不論 admin / user）共用同一個 `workspaceFolder`。
- `getProvisionUserId(authUserId)` 改為：user → `teamId` → team.`workspaceFolder`。
- Container、FTP、工作流程路徑全部以 team 的 workspaceFolder 作為根目錄。

### 3. 多 Admin 支援

- 一個 Team 可有多位 admin，不限數量。
- Admin 可將 user 升級為 admin，或將其他 admin 降為 user。
- 建立 Team 時的第一位用戶自動成為該 Team 的 admin。

### 4. 用戶資料結構

```jsonc
// data/users.json
{
  "users": [
    // Admin 範例
    {
      "id": "user_1234_abc",
      "email": "admin@company.com",
      "name": "Admin A",
      "password": "<bcrypt>",
      "role": "admin",             // 新增：admin | user
      "teamId": "team_1234_abc",   // 新增：所屬 Team
      "createdAt": "..."
    },
    // User 範例
    {
      "id": "user_5678_def",
      "email": "user@company.com",
      "name": "User B",
      "password": "<bcrypt>",
      "role": "user",
      "teamId": "team_1234_abc",
      "createdAt": "..."
    }
  ]
}
```

> `setupConfig` 與 `setupCompleted` 移至 Team 層級，不再掛在個別用戶上。

---

## 登入 / 註冊畫面設計

登入頁分為兩個入口：

```
┌─────────────────────────────────┐
│         ClawPM                  │
│                                 │
│  ┌─────────────────────────┐    │
│  │  建立新的 Team           │    │  → 走「註冊 Team」流程
│  └─────────────────────────┘    │
│                                 │
│  或選擇現有 Team 登入：          │
│  ┌─────────────────────────┐    │
│  │  研發一組               │    │  ← 動態列出 GET /api/teams
│  ├─────────────────────────┤    │
│  │  業務二組               │    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

### 註冊新 Team 流程
1. 填寫 Team 名稱、admin email、密碼
2. 後端建立 Team + 第一位 admin 用戶
3. 登入成功，進入 Setup Wizard（Provision 容器）

### 選擇既有 Team 登入流程
1. 點選 Team 名稱
2. 出現 email / 密碼欄位（預填 teamId）
3. 後端驗證用戶屬於該 Team
4. 登入成功

---

## 後端變更

### A. 新增 `TeamManager.js`

```js
createTeam(name)            // 建立 Team，返回 { teamId, name, workspaceFolder }
getTeam(teamId)             // 取得 Team 資訊
listTeams()                 // 列出所有 Teams（供登入頁顯示）
completeTeamSetup(teamId, config)   // 完成 provision，更新 workspaceFolder
resetTeamSetup(teamId)      // 重置 setup
getWorkspaceFolder(teamId)  // 返回 team.workspaceFolder
```

### B. `UserManager.js` 修改

**修改 `register()`** → 改為 `registerTeam(teamName, email, password)`
- 建立新 Team（`TeamManager.createTeam`）
- 建立第一位 admin 用戶，`teamId` 指向新 Team
- 返回 user + teamId

**新增 `createMember(adminId, email, password, name)`**
- 驗證呼叫者為 admin
- 建立 `role: user`、`teamId` 與呼叫者相同的帳號
- 返回帳號資訊（不含密碼）

**新增 `setMemberRole(adminId, targetUserId, role)`**
- 驗證呼叫者為 admin 且與目標屬於同一 Team
- 更新 `targetUser.role`（`admin` / `user`）

**新增 `listMembers(adminId)`**
- 返回同一 teamId 的所有成員（不含密碼）

**新增 `deleteMember(adminId, memberId)`**
- 驗證同 Team，且不可刪除自己

**修改 `login()`**
- 接受額外的 `teamId` 參數，驗證 `user.teamId === teamId`
- JWT payload 加入 `role` 與 `teamId`

**修改 `signToken()` / JWT payload**
```js
{ userId, email, name, role, teamId }
```

**修改 `getUserById()` / `getProvisionUserId()`**
- `getProvisionUserId(authUserId)` 改為：查 user.teamId → 查 team.workspaceFolder

### C. `server.js` 變更

**新增 `requireAdmin` middleware**
```js
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '此操作需要 Admin 權限' })
  }
  next()
}
```

**套用到受限路由：**
- `POST /api/provision` → `requireAuth, requireAdmin`
- `POST /api/container/restart` → `requireAuth, requireAdmin`
- `DELETE /api/container` → `requireAuth, requireAdmin`
- 所有 `/api/team/*` 管理路由

**新增公開路由（不需驗證）：**
```
GET /api/teams    → 列出所有 Team（id, name）供登入頁顯示
```

**新增 Team 與成員管理路由（requireAuth + requireAdmin）：**
```
GET    /api/team/members                      → 列出 Team 成員
POST   /api/team/members                      → 新增 user 成員
DELETE /api/team/members/:memberId            → 刪除成員
PATCH  /api/team/members/:memberId/role       → 升級 / 降級角色
```

**修改 Setup 相關路由：**
- `PATCH /api/user/setup` → 改為 `PATCH /api/team/setup`，寫入 team 層級

**新增 Team 註冊路由（公開）：**
```
POST /api/auth/register-team    → { teamName, email, password }
                                   建立 Team + 第一位 admin
```

**修改登入路由：**
```
POST /api/auth/login    → body 加入 { teamId, email, password }
```

---

## 前端變更

### A. `LoginView.vue` 重設計

- 預設顯示 Team 列表（`GET /api/teams`）與「建立新 Team」按鈕
- 選擇 Team 後展開 email / 密碼欄位
- 「建立新 Team」展開表單：Team 名稱 + email + 密碼

### B. `useApp.js`

- `currentUser` 加入 `role`、`teamId`
- 提供 `isAdmin` computed（`currentUser.role === 'admin'`）

### C. 條件渲染：隱藏限制功能

`user` 角色時隱藏：
- `RestartModal.vue` 觸發按鈕 → `v-if="isAdmin"`
- `DestroyModal.vue` 觸發按鈕 → `v-if="isAdmin"`
- `SetupWizard.vue` provision 入口 → `v-if="isAdmin"`
- `SettingsView.vue` 「刪除容器」區塊 → `v-if="isAdmin"`

### D. 帳號管理 Tab（`SettingsView.vue`）

僅 admin 可見，包含：
1. 目前 Team 名稱與 admin 清單
2. 成員列表（名稱、email、角色、建立時間）
   - 每列有「升為 Admin / 降為 User」切換按鈕
   - 每列有「刪除」按鈕（不可刪自己）
3. 「新增成員」按鈕 → Modal（email、姓名、初始密碼）

---

## 資料流示意

```
─── 建立新 Team ───
POST /api/auth/register-team { teamName, email, password }
  └─ createTeam("研發一組") → team_id
  └─ createUser(email, password, role:"admin", teamId: team_id)
  └─ 登入成功 → Setup Wizard → Provision Container
       └─ completeTeamSetup(teamId, { workspaceFolder, ... })

─── Admin 登入 ───
POST /api/auth/login { teamId, email, password }
  └─ JWT: { userId, role:"admin", teamId }
  └─ getProvisionUserId() → team.workspaceFolder

─── User 登入 ───
POST /api/auth/login { teamId, email, password }
  └─ JWT: { userId, role:"user", teamId }
  └─ getProvisionUserId() → team.workspaceFolder（共用容器）
  └─ 重啟/刪除按鈕不顯示，後端 requireAdmin 雙重保護

─── Admin 升級成員 ───
PATCH /api/team/members/:memberId/role { role: "admin" }
  └─ user.role 更新為 "admin"
  └─ 下次登入時 JWT 帶入新 role
```

---

## 實作順序

1. **`TeamManager.js`（新建）** — Team CRUD、`getWorkspaceFolder`
2. **`UserManager.js`** — 修改 register、login，新增 createMember、setMemberRole、listMembers、deleteMember；修改 getProvisionUserId
3. **`server.js`** — 新增 `requireAdmin`、`GET /api/teams`、`POST /api/auth/register-team`、修改 login、新增 `/api/team/*` 路由、套用 requireAdmin 到受限路由
4. **前端 `LoginView.vue`** — 重設計登入 / 建立 Team 畫面
5. **前端 `useApp.js`** — 加入 `role`、`teamId`、`isAdmin`
6. **前端條件渲染** — RestartModal、DestroyModal、SetupWizard、SettingsView
7. **前端帳號管理 Tab** — SettingsView 新增成員管理 + 角色切換

---

## 邊界情況

| 情況 | 處理方式 |
|------|---------|
| User 嘗試呼叫受限 API | `requireAdmin` 回傳 403 |
| Admin 嘗試刪除自己 | 後端拒絕，返回 400 |
| Team 內只剩一位 Admin，嘗試降級自己 | 後端拒絕，至少保留一位 admin |
| 舊有用戶（無 role / teamId 欄位）| 遷移腳本：建立預設 Team，現有用戶設為 admin |
| Leader 還沒完成 provision，User 登入 | `team.setupCompleted: false`，顯示「等待 Admin 完成設定」提示 |
| 選擇 Team 後登入失敗（帳號不屬於該 Team）| 返回 401「帳號或密碼錯誤」（不洩漏成員資訊） |
