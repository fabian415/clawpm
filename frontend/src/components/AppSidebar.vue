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
      <span v-if="!collapsed" class="text-xl font-bold text-white tracking-tight">ClawPM</span>
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
        @click="$emit('navigate', 'projects')"
        :class="{ 'bg-blue-600 text-white': currentPage === 'projects' || currentPage === 'projectDetail' }"
        class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <FolderKanban class="w-5 h-5 shrink-0" />
        <span v-if="!collapsed">專案列表</span>
      </div>

      <template v-if="!collapsed">
        <div class="pt-4 pb-2 text-[10px] uppercase font-semibold text-slate-500 tracking-wider">最近專案</div>
        <div
          v-for="p in recentProjects" :key="p.id"
          @click="$emit('select-project', p)"
          class="flex items-center gap-3 px-3 py-1.5 text-sm rounded-md hover:bg-slate-800 cursor-pointer text-slate-400"
        >
          <ChevronRight class="w-3 h-3" />
          <span class="truncate">{{ p.name }}</span>
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
import {
  Terminal, LayoutDashboard, FolderKanban, ChevronRight, ChevronLeft,
  Settings, Sun, Moon
} from 'lucide-vue-next'

defineProps({
  collapsed: Boolean,
  currentPage: String,
  recentProjects: Array,
  containerStatus: String,
  containerStatusColor: String,
  containerStatusTextColor: String,
  isDark: Boolean
})

defineEmits(['navigate', 'select-project', 'toggle-theme', 'update:collapsed'])
</script>
