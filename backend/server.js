import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { register, login, verifyToken, getUserById, completeSetup } from './src/managers/UserManager.js'

dotenv.config()

const app = express()
const PORT = process.env.API_PORT || 3000

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true
}))
app.use(express.json())

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) {
    return res.status(400).json({ error: '請填寫電子郵件與密碼' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼至少需要 6 個字元' })
  }
  try {
    const result = await register(email, password)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {}
  if (!email || !password) {
    return res.status(400).json({ error: '請填寫電子郵件與密碼' })
  }
  try {
    const result = await login(email, password)
    res.json(result)
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

// Logout is handled client-side (remove token); this endpoint exists for completeness
app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true })
})

function requireAuth(req, res, next) {
  const auth = req.headers.authorization ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: '未授權' })
  try {
    req.user = verifyToken(token)
    next()
  } catch {
    res.status(401).json({ error: 'Token 無效或已過期' })
  }
}

app.get('/api/user/me', requireAuth, (req, res) => {
  const user = getUserById(req.user.userId)
  if (!user) return res.status(404).json({ error: '用戶不存在' })
  res.json(user)
})

app.patch('/api/user/setup', requireAuth, (req, res) => {
  const { provider, apiKey, baseUrl, model, workspaceFolder } = req.body ?? {}
  if (!provider || !apiKey || !model || !workspaceFolder) {
    return res.status(400).json({ error: '缺少必要的設定欄位' })
  }
  try {
    const user = completeSetup(req.user.userId, { provider, apiKey, baseUrl, model, workspaceFolder })
    res.json(user)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`ClawPM API server running on http://localhost:${PORT}`)
})
