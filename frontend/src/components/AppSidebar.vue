<template>
  <aside
    :class="collapsed ? 'w-20' : 'w-64'"
    class="bg-slate-900 text-slate-300 flex flex-col transition-all duration-300 relative border-r border-slate-800"
  >
    <!-- Logo -->
    <div class="p-6 flex items-center gap-3 overflow-hidden">
      <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
        <Terminal class="text-white w-5 h-5" />
      </div>
      <div v-if="!collapsed" class="flex flex-col leading-none">
        <span class="text-xl font-bold text-white tracking-tight">MemoSynth</span>
        <span v-if="appVersion" class="text-[10px] text-slate-500 mt-0.5">{{ appVersion }}</span>
      </div>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 px-4 py-4 space-y-2 overflow-y-auto">
      <div
        @click="$emit('navigate', 'dashboard')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'dashboard' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <LayoutDashboard class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">儀表板</span>
      </div>
      <div
        @click="$emit('navigate', 'reviewer')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'reviewer' || currentPage === 'swotReport' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <FileSearch class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">專案列表</span>
      </div>
      <div
        @click="$emit('navigate', 'speakers')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'speakers' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <Mic class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">聲紋管理</span>
      </div>
      <div
        @click="$emit('navigate', 'terminology')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'terminology' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <BookMarked class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">專有名詞</span>
      </div>
      <div
        @click="$emit('navigate', 'tasks')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'tasks' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <div class="relative shrink-0">
          <ListTodo class="w-5 h-5" />
          <span
            v-if="activeTaskCount > 0"
            class="absolute -top-1.5 -right-1.5 w-4 h-4 bg-orange-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center"
          >{{ activeTaskCount > 9 ? '9+' : activeTaskCount }}</span>
        </div>
        <span v-if="!collapsed">任務管理</span>
      </div>
      <div
        v-if="isAdmin"
        @click="$emit('navigate', 'account')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'account' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <Users class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">帳號管理</span>
      </div>
      <div
        v-if="isAdmin"
        @click="$emit('navigate', 'container')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'container' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <Container class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">容器設定</span>
      </div>
      <div
        @click="$emit('navigate', 'sessions')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'sessions' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <History class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">會話紀錄</span>
      </div>
      <div
        @click="$emit('navigate', 'releaseNote')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'releaseNote' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <ScrollText class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">更新紀錄</span>
      </div>

      <template v-if="!collapsed">
        <div class="pt-4 pb-2 text-[10px] uppercase font-semibold text-slate-500 tracking-wider">最近專案</div>
        <div v-if="isLoading" class="flex items-center justify-center py-4 text-slate-500">
          <Loader2 class="w-4 h-4 animate-spin" />
        </div>
        <div
          v-for="p in recentReviewerProjects" :key="p.slug"
          @click="$emit('open-reviewer-project', p.slug)"
          class="flex items-center gap-3 px-3 py-1.5 text-sm rounded-md hover:bg-slate-800 cursor-pointer text-slate-400"
        >
          <ChevronRight class="w-3 h-3 shrink-0" />
          <span class="truncate">{{ p.name }}</span>
        </div>
        <div v-if="!isLoading && recentReviewerProjects.length === 0" class="px-3 py-2 text-xs text-slate-600">
          尚無專案
        </div>
      </template>
    </nav>

    <!-- Footer -->
    <div class="p-4 border-t border-slate-800 space-y-4">
      <div v-if="!collapsed" class="bg-slate-800/50 rounded-lg p-3">
        <div class="flex items-center justify-between text-xs mb-2">
          <span>容器狀態</span>
          <div class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full" :class="containerStatusColor"></span>
            <span :class="containerStatusTextColor">{{ containerStatus }}</span>
          </div>
        </div>
      </div>
      <div :class="collapsed ? 'flex-col' : 'flex-row justify-between gap-2'" class="flex items-center">
        <button @click="$emit('navigate', 'settings')" class="flex items-center justify-center p-2 rounded-md hover:bg-slate-800" :class="collapsed ? 'w-full' : 'flex-1'">
          <Settings class="w-5 h-5" />
        </button>
        <button @click="$emit('toggle-theme')" class="flex items-center justify-center p-2 rounded-md hover:bg-slate-800" :class="collapsed ? 'w-full' : 'flex-1'">
          <Sun v-if="isDark" class="w-5 h-5" />
          <Moon v-else class="w-5 h-5" />
        </button>
        <button @click="$emit('update:collapsed', !collapsed)" class="flex items-center justify-center p-2 rounded-md hover:bg-slate-800" :class="collapsed ? 'w-full' : ''">
          <ChevronRight v-if="collapsed" class="w-5 h-5" />
          <ChevronLeft v-else class="w-5 h-5" />
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import {
  Terminal, LayoutDashboard, FileSearch, ChevronRight, ChevronLeft,
  Settings, Sun, Moon, Loader2, Mic, ListTodo, Users, Container, History, ScrollText, BookMarked
} from 'lucide-vue-next'

defineProps({
  collapsed: Boolean,
  currentPage: String,
  containerStatus: String,
  containerStatusColor: String,
  containerStatusTextColor: String,
  isDark: Boolean,
  isAdmin: { type: Boolean, default: false }
})

defineEmits(['navigate', 'open-reviewer-project', 'toggle-theme', 'update:collapsed'])

const isLoading = ref(false)
const recentReviewerProjects = ref([])
const activeTaskCount = ref(0)
const appVersion = ref('')
let taskPollTimer = null

async function fetchRecentProjects() {
  isLoading.value = true
  try {
    const res = await fetch('/api/project-insights/list', {
      headers: { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
    })
    if (!res.ok) return
    const data = await res.json()
    const projects = data.projects || []
    recentReviewerProjects.value = projects
      .sort((a, b) => {
        if (!a.lastUpdated) return 1
        if (!b.lastUpdated) return -1
        return b.lastUpdated.localeCompare(a.lastUpdated)
      })
  } catch (err) {
    console.error('[sidebar] reviewer fetch error:', err.message)
  } finally {
    isLoading.value = false
  }
}

async function fetchActiveTaskCount() {
  try {
    const res = await fetch('/api/tasks', {
      headers: { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
    })
    if (!res.ok) return
    const tasks = await res.json()
    activeTaskCount.value = tasks.filter(t => t.status !== 'completed').length
  } catch {}
}

async function fetchAppVersion() {
  try {
    const res = await fetch('/api/version')
    if (!res.ok) return
    const data = await res.json()
    appVersion.value = data.version || ''
  } catch {}
}

onMounted(() => {
  fetchRecentProjects()
  fetchActiveTaskCount()
  fetchAppVersion()
  taskPollTimer = setInterval(fetchActiveTaskCount, 10000)
})

onUnmounted(() => {
  clearInterval(taskPollTimer)
})
</script>
