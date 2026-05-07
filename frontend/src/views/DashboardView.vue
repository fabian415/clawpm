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
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div
            v-for="p in recentProjects" :key="p.id"
            @click="$emit('select-project', p)"
            class="group p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-blue-500 hover:shadow-md transition-all cursor-pointer"
          >
            <div class="flex justify-between items-start mb-3">
              <h4 class="font-bold group-hover:text-blue-600 transition-colors">{{ p.name }}</h4>
              <span class="text-[10px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded uppercase">{{ p.meetings }} Meetings</span>
            </div>
            <p class="text-xs text-slate-500 line-clamp-2 mb-4">{{ p.desc }}</p>
            <div class="text-[10px] text-slate-400 flex items-center gap-1">
              <Calendar class="w-3 h-3" /> 更新於 {{ p.updated }}
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="space-y-4">
        <h3 class="text-lg font-bold">快速捷徑</h3>
        <div class="grid grid-cols-1 gap-3">
          <button @click="$emit('new-project')" class="w-full flex items-center justify-between p-4 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-xl transition-colors">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-blue-100 text-blue-600 rounded-lg"><Plus class="w-5 h-5" /></div>
              <span class="font-medium">新建專案</span>
            </div>
            <ChevronRight class="w-4 h-4" />
          </button>
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
import { computed } from 'vue'
import { PlusCircle, BrainCircuit, Clock, Calendar, Plus, ChevronRight, Settings2 } from 'lucide-vue-next'

const props = defineProps({
  recentProjects: Array,
  containerStatus: String,
  containerStatusColor: String,
  currentUser: Object,
})

defineEmits(['navigate', 'select-project', 'new-project'])

const displayName = computed(() =>
  props.currentUser?.name ?? props.currentUser?.email?.split('@')[0] ?? '使用者'
)

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 12) return '早安'
  if (h < 18) return '午安'
  return '晚安'
})
</script>
