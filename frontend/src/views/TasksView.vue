<template>
  <div class="max-w-4xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between mb-8">
      <div>
        <h2 class="text-2xl font-bold">任務管理</h2>
        <p class="text-sm text-slate-500 mt-1">所有進行中與已完成的音訊處理任務</p>
      </div>
      <button
        @click="$emit('navigate', 'workflow')"
        class="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-bold text-sm transition-colors shadow-lg shadow-blue-500/20"
      >
        <Plus class="w-4 h-4" /> 新增任務
      </button>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="flex items-center justify-center py-20">
      <Loader2 class="w-8 h-8 text-blue-500 animate-spin" />
    </div>

    <!-- Empty state -->
    <div v-else-if="tasks.length === 0" class="flex flex-col items-center justify-center py-24 text-center">
      <div class="w-16 h-16 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
        <ListTodo class="w-8 h-8 text-slate-400" />
      </div>
      <h3 class="text-lg font-bold mb-2">尚無任務</h3>
      <p class="text-slate-500 text-sm mb-6">上傳音訊檔後，系統將自動建立任務並追蹤每個步驟的進度</p>
      <button @click="$emit('navigate', 'workflow')" class="bg-blue-600 text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-blue-700 transition-colors">
        開始新任務
      </button>
    </div>

    <!-- Task list -->
    <div v-else class="space-y-4">
      <div
        v-for="task in tasks"
        :key="task.id"
        @click="emit('select-task', task.id)"
        class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 transition-shadow hover:shadow-md cursor-pointer hover:border-blue-300 dark:hover:border-blue-700"
      >
        <!-- Task header -->
        <div class="flex items-start justify-between gap-4 mb-5">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-bold truncate">{{ task.audioFileName || '未命名任務' }}</span>
              <span :class="statusBadgeClass(task.status)" class="shrink-0 text-xs font-bold px-2.5 py-0.5 rounded-full">
                {{ statusLabel(task.status) }}
              </span>
            </div>
            <p class="text-xs text-slate-400 mt-1">會議日期：{{ task.meetingDate }} ・ 建立於 {{ formatDate(task.createdAt) }}</p>
          </div>
          <button
            @click.stop="confirmDelete(task)"
            class="shrink-0 p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
          >
            <Trash2 class="w-4 h-4" />
          </button>
        </div>

        <!-- Step progress -->
        <div class="mb-5">
          <div class="flex items-center gap-1">
            <template v-for="(label, i) in stepLabels" :key="i">
              <div class="flex-1 flex flex-col items-center gap-1.5">
                <div
                  :class="stepCircleClass(task, i + 1)"
                  class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                >
                  <Check v-if="task.stepStatuses?.[i + 1] === 'done'" class="w-3.5 h-3.5" />
                  <Loader2 v-else-if="task.currentStep === i + 1 && task.status === 'running'" class="w-3.5 h-3.5 animate-spin" />
                  <AlertCircle v-else-if="task.errorStep === i + 1" class="w-3.5 h-3.5" />
                  <span v-else>{{ i + 1 }}</span>
                </div>
                <span class="text-[10px] text-center leading-tight" :class="stepLabelClass(task, i + 1)">{{ label }}</span>
              </div>
              <div v-if="i < stepLabels.length - 1" class="h-0.5 flex-1 -mt-5" :class="task.stepStatuses?.[i + 1] === 'done' ? 'bg-blue-500' : 'bg-slate-200 dark:bg-slate-700'" />
            </template>
          </div>
        </div>

        <!-- Error message -->
        <div v-if="task.status === 'error'" class="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/30 rounded-xl flex items-start gap-2">
          <AlertCircle class="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div class="flex-1 min-w-0">
            <p class="text-xs font-medium text-red-700 dark:text-red-400">步驟 {{ task.errorStep }} 發生錯誤</p>
            <p class="text-xs text-red-600 dark:text-red-500 mt-0.5 break-words">{{ task.errorMessage }}</p>
          </div>
        </div>

        <!-- Countdown + controls -->
        <div class="flex items-center gap-3 flex-wrap">
          <!-- Waiting countdown -->
          <template v-if="task.status === 'waiting' && task.autoAdvanceAt">
            <div class="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/30 rounded-lg">
              <Timer class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <span class="text-xs font-medium text-amber-700 dark:text-amber-300">
                {{ countdowns[task.id] ?? 10 }}s 後自動推進至步驟 {{ task.currentStep + 1 }}
              </span>
            </div>
            <button @click.stop="pause(task)" class="text-xs px-3 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors font-medium">
              暫停
            </button>
            <button @click.stop="advanceNow(task)" class="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium">
              立即推進
            </button>
          </template>

          <!-- Paused -->
          <template v-else-if="task.status === 'paused'">
            <div class="flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg">
              <PauseCircle class="w-3.5 h-3.5 text-slate-500" />
              <span class="text-xs font-medium text-slate-600 dark:text-slate-400">已暫停自動推進</span>
            </div>
            <button @click.stop="resume(task)" class="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium">
              繼續
            </button>
          </template>

          <!-- Error retry -->
          <template v-else-if="task.status === 'error'">
            <button @click.stop="retry(task)" class="text-xs px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-medium flex items-center gap-1.5">
              <RefreshCw class="w-3 h-3" /> 重試
            </button>
          </template>

          <!-- Running -->
          <template v-else-if="task.status === 'running'">
            <div class="flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900/30 rounded-lg">
              <Loader2 class="w-3.5 h-3.5 text-blue-500 animate-spin" />
              <span class="text-xs font-medium text-blue-700 dark:text-blue-300">{{ stepLabels[task.currentStep - 1] }} 進行中...</span>
            </div>
          </template>

          <!-- Completed -->
          <template v-else-if="task.status === 'completed'">
            <div class="flex items-center gap-2 px-3 py-1.5 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900/30 rounded-lg">
              <Check class="w-3.5 h-3.5 text-green-600" />
              <span class="text-xs font-medium text-green-700 dark:text-green-300">全部完成</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Delete confirm modal -->
    <div v-if="deleteTarget" class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" @click.self="deleteTarget = null">
      <div class="bg-white dark:bg-slate-900 rounded-2xl p-6 max-w-sm w-full shadow-xl">
        <h3 class="font-bold text-lg mb-2">刪除任務</h3>
        <p class="text-sm text-slate-500 mb-6">確定要刪除「{{ deleteTarget.audioFileName || '未命名任務' }}」嗎？此操作無法復原。</p>
        <div class="flex gap-3">
          <button @click="deleteTarget = null" class="flex-1 py-2.5 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">取消</button>
          <button @click="confirmDeleteExecute" class="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-bold hover:bg-red-700 transition-colors">刪除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, reactive } from 'vue'
import {
  Plus, ListTodo, Loader2, Check, AlertCircle, Trash2, Timer,
  PauseCircle, RefreshCw
} from 'lucide-vue-next'

const emit = defineEmits(['navigate', 'select-task'])

const stepLabels = ['上傳', '標語萃取', '語音轉錄', '會議記錄', '洞見生成']

const tasks = ref([])
const isLoading = ref(true)
const countdowns = reactive({})
const deleteTarget = ref(null)

let pollTimer = null
let countdownInterval = null

function token() { return localStorage.getItem('clawpm_token') }

async function fetchTasks() {
  try {
    const res = await fetch('/api/tasks', { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return
    tasks.value = await res.json()
  } catch {}
  isLoading.value = false
}

function updateCountdowns() {
  const now = Date.now()
  for (const task of tasks.value) {
    if (task.status === 'waiting' && task.autoAdvanceAt) {
      const remaining = Math.max(0, Math.ceil((new Date(task.autoAdvanceAt).getTime() - now) / 1000))
      countdowns[task.id] = remaining
    } else {
      delete countdowns[task.id]
    }
  }
}

async function pause(task) {
  await fetch(`/api/tasks/${task.id}/pause`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` } })
  await fetchTasks()
}

async function resume(task) {
  await fetch(`/api/tasks/${task.id}/resume`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` } })
  await fetchTasks()
}

async function retry(task) {
  await fetch(`/api/tasks/${task.id}/retry`, { method: 'POST', headers: { Authorization: `Bearer ${token()}` } })
  await fetchTasks()
}

async function advanceNow(task) {
  await fetch(`/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoAdvanceAt: new Date().toISOString() }),
  })
  await fetchTasks()
}

function confirmDelete(task) { deleteTarget.value = task }

async function confirmDeleteExecute() {
  if (!deleteTarget.value) return
  await fetch(`/api/tasks/${deleteTarget.value.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}` },
  })
  deleteTarget.value = null
  await fetchTasks()
}

function statusLabel(status) {
  return { waiting: '等待推進', running: '處理中', paused: '已暫停', error: '發生錯誤', completed: '已完成' }[status] || status
}

function statusBadgeClass(status) {
  return {
    waiting: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    running: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    paused: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400',
    error: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
    completed: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  }[status] || 'bg-slate-100 text-slate-500'
}

function stepCircleClass(task, step) {
  const done = task.stepStatuses?.[step] === 'done'
  const isError = task.errorStep === step
  const isActive = task.currentStep === step && task.status === 'running'

  if (done) return 'bg-blue-600 text-white'
  if (isError) return 'bg-red-500 text-white'
  if (isActive) return 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-2 border-blue-500'
  return 'bg-slate-100 dark:bg-slate-800 text-slate-400'
}

function stepLabelClass(task, step) {
  const done = task.stepStatuses?.[step] === 'done'
  const isError = task.errorStep === step
  const isActive = task.currentStep === step && task.status === 'running'
  if (isError) return 'text-red-500'
  if (done || isActive) return 'text-blue-600 dark:text-blue-400 font-medium'
  return 'text-slate-400'
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

onMounted(async () => {
  await fetchTasks()
  pollTimer = setInterval(fetchTasks, 5000)
  countdownInterval = setInterval(updateCountdowns, 500)
  updateCountdowns()
})

onUnmounted(() => {
  clearInterval(pollTimer)
  clearInterval(countdownInterval)
})
</script>
