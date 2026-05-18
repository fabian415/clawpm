<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-slate-900 dark:text-white">聲紋管理</h1>
        <p class="text-sm text-slate-500 mt-1">管理 Speaker 聲紋庫，用於轉錄任務中的語者辨識</p>
      </div>
      <button
        @click="showEnrollPanel = true"
        class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
      >
        <Plus class="w-4 h-4" />
        新增聲紋
      </button>
    </div>

    <!-- Enroll Panel -->
    <div v-if="showEnrollPanel" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 space-y-4">
      <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">註冊 Speaker 聲紋</h2>
      <p class="text-xs text-slate-500">請上傳 10–15 秒的單人清晰錄音（建議安靜環境）。相同名稱重複上傳將覆蓋既有資料。</p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Speaker 名稱 <span class="text-red-500">*</span></label>
          <input
            v-model="enrollName"
            type="text"
            placeholder="例：Alice"
            class="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">音訊檔案 <span class="text-red-500">*</span></label>
          <input
            ref="fileInputRef"
            type="file"
            accept=".mp3,.wav,.m4a,.mp4,.ogg,.flac,.webm,.aac"
            @change="onFileChange"
            class="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 file:mr-3 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-medium file:bg-blue-50 file:text-blue-700"
          />
          <p v-if="enrollFile" class="text-xs text-slate-500 mt-1">{{ enrollFile.name }} ({{ formatSize(enrollFile.size) }})</p>
        </div>
      </div>

      <div v-if="enrollError" class="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
        <AlertCircle class="w-4 h-4 shrink-0" />
        {{ enrollError }}
      </div>

      <div class="flex items-center gap-3 pt-1">
        <button
          @click="enrollSpeaker"
          :disabled="isEnrolling"
          class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
        >
          <Loader2 v-if="isEnrolling" class="w-4 h-4 animate-spin" />
          <Mic v-else class="w-4 h-4" />
          {{ isEnrolling ? '註冊中...' : '確認上傳' }}
        </button>
        <button
          @click="cancelEnroll"
          class="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
        >
          取消
        </button>
      </div>
    </div>

    <!-- Success Toast -->
    <div
      v-if="successMessage"
      class="flex items-center gap-2 text-sm text-green-700 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-4 py-3 rounded-lg"
    >
      <CheckCircle class="w-4 h-4 shrink-0" />
      {{ successMessage }}
    </div>

    <!-- Speaker List -->
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
      <div class="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-slate-300">
          已註冊 Speaker
          <span class="ml-2 text-xs font-normal text-slate-400">({{ speakers.length }} 人)</span>
        </h2>
        <button @click="fetchSpeakers" :disabled="isLoading" class="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 flex items-center gap-1 transition-colors">
          <RefreshCw class="w-3 h-3" :class="{ 'animate-spin': isLoading }" />
          重新整理
        </button>
      </div>

      <!-- Loading -->
      <div v-if="isLoading && speakers.length === 0" class="flex items-center justify-center py-16 text-slate-400">
        <Loader2 class="w-6 h-6 animate-spin mr-2" />
        <span class="text-sm">載入中...</span>
      </div>

      <!-- Error -->
      <div v-else-if="fetchError" class="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
        <AlertCircle class="w-8 h-8 text-red-400" />
        <p class="text-sm text-red-500">{{ fetchError }}</p>
        <button @click="fetchSpeakers" class="text-xs text-blue-500 hover:underline">重試</button>
      </div>

      <!-- Empty -->
      <div v-else-if="speakers.length === 0" class="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
        <Mic class="w-8 h-8" />
        <p class="text-sm">尚無已註冊的 Speaker</p>
        <button @click="showEnrollPanel = true" class="text-xs text-blue-500 hover:underline">點此新增</button>
      </div>

      <!-- Speaker Cards -->
      <ul v-else class="divide-y divide-slate-100 dark:divide-slate-800">
        <li v-for="speaker in speakers" :key="speaker.name" class="px-6 py-4 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
          <!-- Avatar -->
          <div class="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
            <span class="text-sm font-bold text-blue-600 dark:text-blue-400">{{ speaker.name.charAt(0).toUpperCase() }}</span>
          </div>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-slate-900 dark:text-slate-100">{{ speaker.name }}</p>
            <p class="text-xs text-slate-400 mt-0.5">
              {{ speaker.source_file }}
              <span class="mx-1">·</span>
              {{ speaker.dim }}D embedding
            </p>
          </div>

          <!-- Audio Preview -->
          <div class="flex items-center gap-2">
            <template v-if="speaker.has_audio">
              <button
                @click="togglePlay(speaker)"
                :disabled="loadingAudio === speaker.name"
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50"
                :class="playingSpeaker === speaker.name
                  ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-300 hover:text-blue-600'"
              >
                <Loader2 v-if="loadingAudio === speaker.name" class="w-3.5 h-3.5 animate-spin" />
                <Pause v-else-if="playingSpeaker === speaker.name" class="w-3.5 h-3.5" />
                <Play v-else class="w-3.5 h-3.5" />
                {{ loadingAudio === speaker.name ? '載入中' : playingSpeaker === speaker.name ? '停止' : '試聽' }}
              </button>
            </template>
            <span v-else class="text-xs text-slate-400 px-3">無音檔</span>

            <!-- Delete -->
            <button
              @click="confirmDelete(speaker)"
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:border-red-300 hover:text-red-600 dark:hover:border-red-700 dark:hover:text-red-400 transition-colors"
            >
              <Trash2 class="w-3.5 h-3.5" />
              刪除
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>

  <!-- Delete Confirm Modal -->
  <div v-if="deletingName" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
    <div class="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
          <Trash2 class="w-5 h-5 text-red-600" />
        </div>
        <div>
          <h3 class="font-semibold text-slate-900 dark:text-white">刪除聲紋</h3>
          <p class="text-sm text-slate-500">此操作無法復原</p>
        </div>
      </div>
      <p class="text-sm text-slate-700 dark:text-slate-300">
        確定要刪除 <strong>{{ deletingName }}</strong> 的聲紋資料嗎？後續轉錄任務將無法辨識此語者。
      </p>
      <div v-if="deleteError" class="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">{{ deleteError }}</div>
      <div class="flex gap-3 justify-end pt-2">
        <button @click="deletingName = null; deleteError = ''" class="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 transition-colors">取消</button>
        <button
          @click="deleteSpeaker"
          :disabled="isDeleting"
          class="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          <Loader2 v-if="isDeleting" class="w-4 h-4 animate-spin" />
          確認刪除
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { Plus, Mic, Trash2, Play, Pause, RefreshCw, Loader2, AlertCircle, CheckCircle } from 'lucide-vue-next'

const props = defineProps({ team: String })

const speakers = ref([])
const isLoading = ref(false)
const fetchError = ref('')

const showEnrollPanel = ref(false)
const enrollName = ref('')
const enrollFile = ref(null)
const fileInputRef = ref(null)
const isEnrolling = ref(false)
const enrollError = ref('')

const successMessage = ref('')
const playingSpeaker = ref(null)
const loadingAudio = ref(null)
let currentAudio = null
let currentBlobUrl = null

const deletingName = ref(null)
const isDeleting = ref(false)
const deleteError = ref('')

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function fetchSpeakers() {
  if (!props.team) {
    fetchError.value = '無法取得 Team 資訊，請重新登入'
    return
  }
  isLoading.value = true
  fetchError.value = ''
  try {
    const res = await fetch(`/api/speakers/${encodeURIComponent(props.team)}`, { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    speakers.value = data.speakers ?? []
  } catch (err) {
    fetchError.value = `無法載入聲紋清單：${err.message}`
  } finally {
    isLoading.value = false
  }
}

function onFileChange(e) {
  enrollFile.value = e.target.files?.[0] ?? null
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function cancelEnroll() {
  showEnrollPanel.value = false
  enrollName.value = ''
  enrollFile.value = null
  enrollError.value = ''
  if (fileInputRef.value) fileInputRef.value.value = ''
}

async function enrollSpeaker() {
  enrollError.value = ''
  if (!enrollName.value.trim()) { enrollError.value = '請填寫 Speaker 名稱'; return }
  if (!enrollFile.value) { enrollError.value = '請選擇音訊檔案'; return }

  isEnrolling.value = true
  try {
    const fd = new FormData()
    fd.append('audio', enrollFile.value)
    fd.append('name', enrollName.value.trim())

    const res = await fetch(`/api/speakers/${encodeURIComponent(props.team)}/enroll`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    })
    const data = await res.json()
    if (!res.ok) { enrollError.value = data.error ?? data.detail ?? '註冊失敗'; return }

    showSuccess(`Speaker ${data.name} 聲紋註冊成功！`)
    cancelEnroll()
    await fetchSpeakers()
  } catch (err) {
    enrollError.value = `上傳失敗：${err.message}`
  } finally {
    isEnrolling.value = false
  }
}

function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl)
    currentBlobUrl = null
  }
  playingSpeaker.value = null
}

async function togglePlay(speaker) {
  if (playingSpeaker.value === speaker.name) {
    stopCurrentAudio()
    return
  }
  stopCurrentAudio()

  loadingAudio.value = speaker.name
  try {
    const res = await fetch(`/api/speakers/${encodeURIComponent(props.team)}/${encodeURIComponent(speaker.name)}/audio`, {
      headers: authHeaders(),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    currentBlobUrl = URL.createObjectURL(blob)
    currentAudio = new Audio(currentBlobUrl)
    currentAudio.addEventListener('ended', stopCurrentAudio)
    currentAudio.addEventListener('error', stopCurrentAudio)
    await currentAudio.play()
    playingSpeaker.value = speaker.name
  } catch (err) {
    console.error('[speaker-audio]', err.message)
    stopCurrentAudio()
  } finally {
    loadingAudio.value = null
  }
}

function confirmDelete(speaker) {
  deletingName.value = speaker.name
  deleteError.value = ''
}

async function deleteSpeaker() {
  if (!deletingName.value) return
  isDeleting.value = true
  deleteError.value = ''
  try {
    const res = await fetch(`/api/speakers/${encodeURIComponent(props.team)}/${encodeURIComponent(deletingName.value)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    const data = await res.json()
    if (!res.ok) { deleteError.value = data.error ?? data.detail ?? '刪除失敗'; return }

    showSuccess(`Speaker ${deletingName.value} 已從聲紋庫刪除`)
    deletingName.value = null
    await fetchSpeakers()
  } catch (err) {
    deleteError.value = `刪除失敗：${err.message}`
  } finally {
    isDeleting.value = false
  }
}

function showSuccess(msg) {
  successMessage.value = msg
  setTimeout(() => { successMessage.value = '' }, 4000)
}

onMounted(fetchSpeakers)
</script>
