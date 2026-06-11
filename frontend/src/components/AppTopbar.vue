<template>
  <header class="h-16 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-8 bg-white/50 dark:bg-slate-950/50 backdrop-blur-sm sticky top-0 z-10">
    <div class="flex items-center gap-1.5 text-sm text-slate-500">
      <span class="hover:text-blue-600 cursor-pointer" @click="$emit('navigate', 'dashboard')">ClawPM</span>
      <template v-for="(item, i) in breadcrumbs" :key="i">
        <ChevronRight class="w-4 h-4 shrink-0" />
        <span
          v-if="item.page"
          class="hover:text-blue-600 cursor-pointer flex items-center gap-1"
          @click="$emit('navigate', item.page)"
        >
          <span v-if="item.icon === 'project'" class="w-2 h-2 rounded-sm bg-red-500 inline-block shrink-0"></span>
          {{ item.label }}
        </span>
        <span v-else class="text-slate-900 dark:text-slate-100 font-medium flex items-center gap-1">
          <span v-if="item.icon === 'project'" class="w-2 h-2 rounded-sm bg-red-500 inline-block shrink-0"></span>
          {{ item.label }}
        </span>
      </template>
    </div>

    <div class="flex items-center gap-4">
      <div class="relative group">
        <button class="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xs">
            {{ initials }}
          </div>
          <span class="text-sm font-medium hidden sm:inline-block">{{ displayName }}</span>
          <ChevronDown class="w-4 h-4" />
        </button>
        <div class="absolute right-0 mt-2 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl py-1 invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all z-50">
          <a href="#" class="block px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">個人資料</a>
          <div class="h-px bg-slate-200 dark:bg-slate-800 my-1"></div>
          <a @click.prevent="$emit('logout')" href="#" class="block px-4 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30">登出系統</a>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue'
import { ChevronRight, ChevronDown } from 'lucide-vue-next'

const props = defineProps({
  breadcrumbs: { type: Array, default: () => [] },
  currentUser: Object
})

defineEmits(['navigate', 'logout'])

const displayName = computed(() => props.currentUser?.name ?? props.currentUser?.email?.split('@')[0] ?? '使用者')

const initials = computed(() => {
  const name = displayName.value
  const parts = name.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
})
</script>
