<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div v-if="show" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-800 flex flex-col" :class="step === 'review' ? 'h-[85vh]' : ''">
        <div class="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center shrink-0">
          <h3 class="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2"><Sparkles class="w-5 h-5 text-blue-500" /> 用 AI 產生新技能</h3>
          <button @click="handleClose" class="text-slate-400 hover:text-slate-600"><X class="w-6 h-6" /></button>
        </div>

        <!-- Step 1: describe -->
        <div v-if="step === 'describe'" class="p-6 space-y-4">
          <label class="block text-sm font-medium mb-1">用一段話描述你想要的技能</label>
          <textarea
            v-model="description" rows="6"
            placeholder="例如：我要一個技能，能讀取專案的客戶訪談逐字稿，整理成一份「客戶痛點清單」，每個痛點附引用原文與日期來源。"
            class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none resize-none"
          ></textarea>

          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold text-slate-400 uppercase tracking-wide">沒有靈感？試試這些</span>
              <button @click="rollSuggestions" type="button" class="text-xs font-bold text-blue-500 hover:text-blue-600 flex items-center gap-1">
                <Shuffle class="w-3 h-3" /> 換一批
              </button>
            </div>
            <div class="grid gap-2">
              <button
                v-for="(s, i) in suggestions" :key="i"
                @click="description = s"
                type="button"
                class="text-left text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-700 dark:hover:text-blue-300 border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-800 rounded-xl px-3 py-2.5 transition-colors"
              >
                {{ s }}
              </button>
            </div>
          </div>

          <p class="text-xs text-slate-400">點擊上方任一建議可直接帶入並自行修改；AI 會在下方聊天面板即時執行，草擬完成後會回到這裡讓你預覽與微調，確認後才會正式建立為技能。</p>
          <div v-if="error" class="bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 text-sm px-4 py-2 rounded-xl">{{ error }}</div>
        </div>

        <!-- Step 2: generating -->
        <div v-else-if="step === 'generating'" class="p-10 flex flex-col items-center justify-center gap-4 text-center">
          <Loader2 class="w-10 h-10 text-blue-500 animate-spin" />
          <p class="font-semibold text-slate-700 dark:text-slate-300">AI 正在草擬技能，請稍候...</p>
          <p class="text-sm text-slate-400 max-w-sm">可以打開聊天面板查看即時進度，完成後會自動載入這裡讓你預覽。</p>
        </div>

        <!-- Step 3: review -->
        <div v-else-if="step === 'review'" class="flex-1 flex flex-col min-h-0">
          <div class="px-6 pt-4 grid grid-cols-2 gap-4 shrink-0">
            <div>
              <label class="block text-sm font-medium mb-1">技能識別碼（slug） <span class="text-red-500">*</span></label>
              <input
                type="text" v-model="reviewSlug"
                class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
              />
            </div>
            <div class="flex items-end">
              <p class="text-xs text-slate-400">草稿內容可直接於下方編輯，滿意後按「另存為技能」正式建立</p>
            </div>
          </div>
          <div v-if="error" class="mx-6 mt-3 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 text-sm px-4 py-2 rounded-xl shrink-0">{{ error }}</div>
          <div class="flex-1 p-6 min-h-0">
            <textarea
              v-model="draftContent"
              spellcheck="false"
              class="w-full h-full bg-[#1e1e1e] text-slate-200 p-4 font-mono text-sm rounded-xl resize-none outline-none leading-relaxed overflow-y-auto"
            ></textarea>
          </div>
        </div>

        <div class="p-6 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-3 shrink-0">
          <button @click="handleClose" class="px-6 py-2 rounded-xl text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700">
            {{ step === 'review' ? '捨棄' : '取消' }}
          </button>
          <button
            v-if="step === 'describe'"
            @click="startGenerate"
            :disabled="!description.trim() || isSubmitting"
            :class="!description.trim() || isSubmitting ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700'"
            class="bg-blue-600 text-white px-8 py-2 rounded-xl font-bold transition-colors flex items-center gap-2"
          >
            <Loader2 v-if="isSubmitting" class="w-4 h-4 animate-spin" />
            產生
          </button>
          <button
            v-else-if="step === 'review'"
            @click="saveDraft"
            :disabled="isSaving"
            :class="isSaving ? 'opacity-60 cursor-not-allowed' : 'hover:bg-blue-700'"
            class="bg-blue-600 text-white px-8 py-2 rounded-xl font-bold transition-colors flex items-center gap-2"
          >
            <Loader2 v-if="isSaving" class="w-4 h-4 animate-spin" />
            另存為技能
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, watch, onUnmounted } from 'vue'
import { X, Sparkles, Loader2, Shuffle } from 'lucide-vue-next'

const SUGGESTION_POOL = [
  '我要一個技能，能讀取專案的客戶訪談逐字稿，整理成一份「客戶痛點清單」，每個痛點附引用原文與日期來源。',
  '我要一個技能，能從歷次會議記錄中彙整所有「待辦事項與負責人」，標註指派日期與目前狀態，產出一份追蹤表。',
  '我要一個技能，能掃描會議記錄中提到的競品名稱與定價，整理成一份競品定價比較表，附來源會議日期。',
  '我要一個技能，能把專案的重大決策與其背後的理由，依時間順序整理成一份「決策紀錄」，方便新加入的人快速理解來龍去脈。',
  '我要一個技能，能從會議逐字稿抓出所有被提出過的風險與疑慮，整理成風險登記表，標記目前是否已解決。',
  '我要一個技能，能把專案 Markdown 與會議記錄整理成給新進團隊成員看的「專案 onboarding 懶人包」，涵蓋背景、現況與待辦。',
  '我要一個技能，能從會議記錄彙整客戶或使用者提出的功能需求，依出現頻率排序，整理成功能請求清單。',
  '我要一個技能，能定期彙整專案的預算與花費相關討論，整理成一份簡易的成本追蹤摘要。',
  '我要一個技能，能從多次會議記錄中抓出對專案的正負面情緒與滿意度變化，畫出簡單的時間軸描述。',
  '我要一個技能，能把一次回顧會議（retro）的逐字稿整理成「做得好 / 待改進 / 下次行動」三欄格式的回顧摘要。',
  '我要一個技能，能掃描會議記錄找出所有被提到的外部廠商或合作夥伴，整理成聯絡對象與合作事項清單。',
  '我要一個技能，能把專案的功能發布歷程從會議記錄與專案 Markdown 中萃取出來，整理成對外可發布的 changelog。',
  '我要一個技能，能從會議記錄中找出被提及但一直沒處理的技術債項目，整理成清單並標記嚴重度與提出日期。',
  '我要一個技能，能整理跨會議反覆出現的專有名詞與縮寫，附第一次出現的會議日期與簡短解釋，做成給新人看的詞彙對照表。',
  '我要一個技能，能從會議記錄中抓出被提及的關鍵指標數字（例如轉換率、留存率），依日期排列成一份指標走勢紀錄。',
  '我要一個技能，能整理會議中提到的客戶名稱、聯繫窗口與最近一次互動內容，做成一份客戶關係總覽表。',
  '我要一個技能，能比對前後兩次會議記錄，找出上次會議承諾的行動項目這次是否真的被執行，整理成一份「說到做到」追蹤表。',
  '我要一個技能，能從歷次會議中提及的功能規劃與優先順序，整理成一份簡易的產品路線圖（Roadmap）。',
  '我要一個技能，能從會議記錄中找出反覆被問到的問題與當時的回答，整理成一份內部 FAQ 文件。',
  '我要一個技能，能抓出會議記錄中提到的專案重要里程碑與達成或延遲情況，整理成一份里程碑時間軸。',
  '我要一個技能，能整理會議中提到需要其他部門配合的事項，標註負責部門與目前進度，做成跨部門協作追蹤表。',
  '我要一個技能，能從客戶訪談逐字稿中挑出適合用在行銷或簡報的客戶原話金句，附來源與日期，整理成一份金句庫。',
  '我要一個技能，能整理每次會議的出席者、角色與發言重點，做成一份人員參與總覽表。',
  '我要一個技能，能從會議記錄中整理出團隊目前還在驗證中的產品或市場假設，標註驗證方法與目前結果，做成一份待驗證假設清單。',
]

function pickRandom(pool, count) {
  const arr = [...pool]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, count)
}

const props = defineProps({ show: Boolean })
const emit = defineEmits(['close', 'skill-ready', 'saved'])

const step = ref('describe')
const description = ref('')
const suggestions = ref([])
const draftId = ref('')
const draftContent = ref('')
const reviewSlug = ref('')
const isSubmitting = ref(false)
const isSaving = ref(false)
const error = ref('')
let pollTimer = null

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

function rollSuggestions() {
  suggestions.value = pickRandom(SUGGESTION_POOL, 3)
}

watch(() => props.show, (show) => {
  if (!show) {
    stopPolling()
    return
  }
  step.value = 'describe'
  description.value = ''
  rollSuggestions()
  draftId.value = ''
  draftContent.value = ''
  reviewSlug.value = ''
  error.value = ''
  isSubmitting.value = false
  isSaving.value = false
})

onUnmounted(stopPolling)

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

function guessSlug(content) {
  const m = content.match(/^name:\s?(.+)$/m)
  const raw = (m ? m[1] : '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return raw || `custom-skill-${Date.now().toString(36)}`
}

async function startGenerate() {
  if (!description.value.trim()) return
  isSubmitting.value = true
  error.value = ''
  try {
    const res = await fetch('/api/skills/generate', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: description.value.trim() }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '啟動產生失敗')

    draftId.value = data.draftId
    emit('skill-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    step.value = 'generating'
    startPolling()
  } catch (err) {
    error.value = err.message
  } finally {
    isSubmitting.value = false
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/skills/drafts/${encodeURIComponent(draftId.value)}`, { headers: authHeaders() })
      if (!res.ok) return
      const data = await res.json()
      if (data.ready) {
        stopPolling()
        draftContent.value = data.content
        reviewSlug.value = guessSlug(data.content)
        step.value = 'review'
      }
    } catch {}
  }, 3000)
}

async function saveDraft() {
  const slug = reviewSlug.value.trim()
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(slug)) {
    error.value = '技能識別碼僅限小寫英數字與連字號'
    return
  }
  if (!draftContent.value.trim()) {
    error.value = 'SKILL.md 內容不可為空'
    return
  }

  isSaving.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/skills/drafts/${encodeURIComponent(draftId.value)}/save`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, content: draftContent.value }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '儲存失敗')
    emit('saved', { slug })
  } catch (err) {
    error.value = err.message
  } finally {
    isSaving.value = false
  }
}

async function discardDraft() {
  if (!draftId.value) return
  try {
    await fetch(`/api/skills/drafts/${encodeURIComponent(draftId.value)}`, { method: 'DELETE', headers: authHeaders() })
  } catch {}
}

function handleClose() {
  if (step.value !== 'describe') discardDraft()
  stopPolling()
  emit('close')
}
</script>
