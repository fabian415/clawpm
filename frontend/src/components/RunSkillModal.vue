<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div v-if="show" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-4xl h-[85vh] rounded-2xl shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-800 flex flex-col">
        <div class="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center shrink-0">
          <h3 class="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2"><Play class="w-5 h-5 text-blue-500" /> 執行技能</h3>
          <button @click="$emit('close')" class="text-slate-400 hover:text-slate-600"><X class="w-6 h-6" /></button>
        </div>

        <div class="flex-1 flex min-h-0">
          <!-- Left: form + history -->
          <div class="w-80 shrink-0 border-r border-slate-200 dark:border-slate-800 flex flex-col overflow-y-auto">
            <div class="p-5 space-y-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <label class="block text-sm font-medium mb-1">技能</label>
                <select
                  v-model="selectedSkillSlug"
                  :disabled="!!presetSkillSlug"
                  class="w-full bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm outline-none disabled:opacity-70"
                >
                  <option v-for="s in skills" :key="s.slug" :value="s.slug">{{ s.name }}（{{ s.slug }}）</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">專案</label>
                <select
                  v-model="selectedProjectSlug"
                  class="w-full bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm outline-none"
                >
                  <option value="" disabled>選擇專案...</option>
                  <option v-for="p in projects" :key="p.slug" :value="p.slug">{{ p.name || p.slug }}</option>
                </select>
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">補充指令（選填）</label>
                <textarea
                  v-model="instruction" rows="4"
                  placeholder="給這次執行的額外要求，留空則依技能預設行為執行"
                  class="w-full bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm outline-none resize-none"
                ></textarea>
              </div>
              <div v-if="error" class="bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 text-xs px-3 py-2 rounded-xl">{{ error }}</div>
              <button
                @click="run"
                :disabled="!selectedSkillSlug || !selectedProjectSlug || isRunning"
                :class="!selectedSkillSlug || !selectedProjectSlug || isRunning ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700'"
                class="w-full bg-blue-600 text-white px-4 py-2.5 rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
              >
                <Loader2 v-if="isRunning" class="w-4 h-4 animate-spin" />
                <Play v-else class="w-4 h-4" />
                執行
              </button>
            </div>

            <div class="p-5 flex-1">
              <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">歷次執行結果</div>
              <div v-if="isLoadingRuns" class="text-xs text-slate-400 italic">讀取中...</div>
              <div v-else-if="runs.length === 0" class="text-xs text-slate-400 italic">尚無執行紀錄</div>
              <button
                v-for="r in runs" :key="r.name"
                @click="openReport(r.name)"
                class="w-full text-left px-3 py-2 rounded-lg text-xs font-mono mb-1 transition-colors flex items-center justify-between gap-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400"
                title="在 Markdown Reviewer 中開啟"
              >
                <span>{{ r.displayDate }}</span>
                <ExternalLink class="w-3 h-3 opacity-50 shrink-0" />
              </button>
            </div>
          </div>

          <!-- Right: status / open-in-reviewer -->
          <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
            <div v-if="isRunning" class="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
              <Loader2 class="w-8 h-8 text-blue-500 animate-spin" />
              <p class="text-sm font-medium text-slate-700 dark:text-slate-300">AI 執行中，可打開聊天面板查看即時進度</p>
              <p class="text-xs text-slate-400">完成後可在此開啟報告</p>
            </div>
            <div v-else-if="completedFilename" class="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
              <div class="w-14 h-14 rounded-full bg-emerald-50 dark:bg-emerald-900/20 flex items-center justify-center">
                <Check class="w-7 h-7 text-emerald-500" />
              </div>
              <p class="text-sm font-medium text-slate-700 dark:text-slate-300">執行完成</p>
              <button
                @click="openReport(completedFilename)"
                class="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-bold flex items-center gap-2 transition-colors"
              >
                <ExternalLink class="w-4 h-4" /> 在 Markdown Reviewer 中開啟
              </button>
            </div>
            <div v-else class="flex-1 flex flex-col items-center justify-center text-slate-400 gap-2">
              <FileText class="w-10 h-10 opacity-20" />
              <p class="text-sm">選擇技能與專案後點擊「執行」，或從左側選擇一筆歷史紀錄開啟</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, watch } from 'vue'
import { X, Play, Loader2, FileText, ExternalLink, Check } from 'lucide-vue-next'

const props = defineProps({
  show: Boolean,
  skills: { type: Array, default: () => [] },
  presetSkillSlug: { type: String, default: '' },
})
const emit = defineEmits(['close', 'skill-ready', 'open-report'])

const selectedSkillSlug = ref('')
const selectedProjectSlug = ref('')
const instruction = ref('')
const projects = ref([])
const isRunning = ref(false)
const error = ref('')

const runs = ref([])
const isLoadingRuns = ref(false)
const completedFilename = ref('')
let pollTimer = null
let pendingFilename = ''

watch(() => props.show, async (show) => {
  stopPolling()
  if (!show) return
  error.value = ''
  isRunning.value = false
  completedFilename.value = ''
  instruction.value = ''
  selectedSkillSlug.value = props.presetSkillSlug || (props.skills[0]?.slug ?? '')
  selectedProjectSlug.value = ''
  await fetchProjects()
})

watch([selectedSkillSlug, selectedProjectSlug], () => {
  completedFilename.value = ''
  if (selectedSkillSlug.value && selectedProjectSlug.value) fetchRuns()
  else runs.value = []
})

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function fetchProjects() {
  try {
    const res = await fetch('/api/project-insights/list', { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    projects.value = data.projects || []
  } catch {}
}

async function fetchRuns() {
  isLoadingRuns.value = true
  try {
    const res = await fetch(
      `/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/runs?projectSlug=${encodeURIComponent(selectedProjectSlug.value)}`,
      { headers: authHeaders() }
    )
    if (!res.ok) return
    const data = await res.json()
    runs.value = data.reports || []
  } catch {} finally {
    isLoadingRuns.value = false
  }
}

function openReport(filename) {
  const project = projects.value.find(p => p.slug === selectedProjectSlug.value)
  emit('open-report', {
    skillSlug: selectedSkillSlug.value,
    projectSlug: selectedProjectSlug.value,
    projectName: project?.name || selectedProjectSlug.value,
    filename,
  })
  emit('close')
}

async function run() {
  if (!selectedSkillSlug.value || !selectedProjectSlug.value) return
  const project = projects.value.find(p => p.slug === selectedProjectSlug.value)

  isRunning.value = true
  error.value = ''
  completedFilename.value = ''
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/run`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectSlug: selectedProjectSlug.value,
        projectName: project?.name || selectedProjectSlug.value,
        instruction: instruction.value.trim(),
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '啟動執行失敗')

    emit('skill-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    pendingFilename = data.filename
    startPolling()
  } catch (err) {
    error.value = err.message
    isRunning.value = false
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(
        `/api/skills/${encodeURIComponent(selectedSkillSlug.value)}/runs/result?projectSlug=${encodeURIComponent(selectedProjectSlug.value)}&filename=${encodeURIComponent(pendingFilename)}`,
        { headers: authHeaders() }
      )
      if (!res.ok) return
      const data = await res.json()
      if (data.ready) {
        stopPolling()
        isRunning.value = false
        completedFilename.value = pendingFilename
        await fetchRuns()
      }
    } catch {}
  }, 3000)
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
</script>
