// 全域攔截 fetch 回應：後端 requireAuth 對過期/無效 token 一律回 401，
// 但既有程式碼在各個 view 各自呼叫 fetch，沒有統一的 API 層可以掛攔截邏輯，
// 因此改為 patch window.fetch 一次，讓所有現有呼叫自動受益，不用逐一修改。
const originalFetch = window.fetch.bind(window)
const SESSION_EXPIRED_EVENT = 'clawpm:session-expired'

function resolveUrl(input) {
  if (typeof input === 'string') return input
  if (input instanceof Request) return input.url
  return String(input ?? '')
}

window.fetch = async (...args) => {
  const response = await originalFetch(...args)
  const url = resolveUrl(args[0])

  // /api/auth/login、/api/auth/register-team 本身在帳密錯誤時也會回 401，
  // 不屬於 token 過期，排除掉避免誤觸發登出。
  if (response.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    localStorage.removeItem('clawpm_token')
    localStorage.removeItem('clawpm_user')
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
  }

  return response
}

export { SESSION_EXPIRED_EVENT }
