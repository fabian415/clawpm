<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Hero Banner -->
    <section class="bg-blue-600 rounded-2xl p-8 text-white flex justify-between items-center relative overflow-hidden shadow-lg shadow-blue-500/20">
      <div class="relative z-10">
        <h2 class="text-3xl font-bold mb-2">{{ greeting }}，{{ displayName }} 👋</h2>
        <p class="text-blue-100 mb-6">歡迎回到 ClawPM，今日有 3 場會議待處理。</p>
        <button @click="$emit('navigate', 'workflow')" class="bg-white text-blue-600 px-6 py-2.5 rounded-xl font-bold hover:bg-blue-50 transition-colors flex items-center gap-2 shadow-sm">
          <PlusCircle class="w-5 h-5" /> 上傳新會議
        </button>
      </div>
      <div class="relative z-10 hidden md:block">
        <div class="bg-white/20 backdrop-blur-md rounded-2xl p-4 border border-white/20">
          <div class="flex items-center gap-3 mb-2 text-sm">
            <span class="w-3 h-3 rounded-full animate-pulse" :class="containerStatusColor"></span>
            <span class="font-semibold">容器：{{ containerStatus }}</span>
          </div>
          <p class="text-xs opacity-80">GPU 使用率：14% / RAM：2.4GB</p>
        </div>
      </div>
      <BrainCircuit class="absolute -right-12 -bottom-12 w-64 h-64 text-white/10 rotate-12" />
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <!-- Recent Projects -->
      <div class="lg:col-span-2 space-y-4">
        <h3 class="text-lg font-bold flex items-center gap-2">
          <Clock class="w-5 h-5" /> 最近專案
        </h3>
        <div v-if="isLoading" class="flex items-center justify-center py-12 text-slate-400">
          <Loader2 class="w-6 h-6 animate-spin" />
        </div>
        <div v-else-if="reviewerProjects.length === 0" class="py-12 text-center text-slate-400 text-sm">
          尚無專案資料，完成工作流程後將自動建立。
        </div>
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div
            v-for="p in reviewerProjects" :key="p.slug"
            @click="$emit('navigate', 'reviewer')"
            class="group p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-blue-500 hover:shadow-md transition-all cursor-pointer"
          >
            <div class="flex justify-between items-start mb-3">
              <h4 class="font-bold group-hover:text-blue-600 transition-colors">{{ p.name }}</h4>
              <span v-if="p.readiness" :class="maturityClass(p.readiness)" class="text-[10px] font-bold px-2 py-0.5 rounded-full">
                {{ p.readiness }}
              </span>
            </div>
            <p class="text-xs text-slate-500 mb-4">{{ p.stage || '—' }}</p>
            <div class="text-[10px] text-slate-400 flex items-center gap-1">
              <Calendar class="w-3 h-3" /> 更新於 {{ p.lastUpdated || '—' }}
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="space-y-4">
        <h3 class="text-lg font-bold">快速捷徑</h3>
        <div class="grid grid-cols-1 gap-3">
          <button @click="$emit('navigate', 'settings')" class="w-full flex items-center justify-between p-4 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-xl transition-colors">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-purple-100 text-purple-600 rounded-lg"><Settings2 class="w-5 h-5" /></div>
              <span class="font-medium">容器設定</span>
            </div>
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { PlusCircle, BrainCircuit, Clock, Calendar, ChevronRight, Settings2, Loader2 } from 'lucide-vue-next'

const props = defineProps({
  containerStatus: String,
  containerStatusColor: String,
  currentUser: Object,
})

defineEmits(['navigate'])

const isLoading = ref(false)
const reviewerProjects = ref([])

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function fetchReviewerProjects() {
  isLoading.value = true
  try {
    const res = await fetch('/api/project-insights/list', { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    const projects = data.projects || []
    reviewerProjects.value = projects.sort((a, b) => {
      if (!a.lastUpdated) return 1
      if (!b.lastUpdated) return -1
      return b.lastUpdated.localeCompare(a.lastUpdated)
    })
  } catch (err) {
    console.error('[dashboard] reviewer fetch error:', err.message)
  } finally {
    isLoading.value = false
  }
}

function maturityClass(m) {
  if (!m) return 'bg-slate-100 dark:bg-slate-800 text-slate-500'
  const v = String(m).toLowerCase()
  if (v.includes('not ready')) return 'bg-slate-200 dark:bg-slate-700 text-slate-500'
  if (v.includes('internal')) return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
  if (v.includes('soft')) return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
  if (v.includes('public')) return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
  return 'bg-slate-100 dark:bg-slate-800 text-slate-400'
}

const displayName = computed(() =>
  props.currentUser?.name ?? props.currentUser?.email?.split('@')[0] ?? '使用者'
)

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 12) return '早安'
  if (h < 18) return '午安'
  return '晚安'
})

onMounted(fetchReviewerProjects)
</script>
