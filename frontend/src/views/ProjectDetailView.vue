<template>
  <div class="max-w-6xl mx-auto space-y-8">
    <!-- Header -->
    <div class="flex items-start justify-between">
      <div class="space-y-2 flex-1">
        <div class="flex items-center gap-3">
          <input v-if="editing" v-model="project.name" class="text-3xl font-bold bg-transparent border-b-2 border-blue-500 focus:outline-none w-full max-w-lg" />
          <h2 v-else class="text-3xl font-bold">{{ project.name }}</h2>
          <button @click="editing = !editing" class="p-1 hover:text-blue-500 transition-colors">
            <Check v-if="editing" class="w-5 h-5" />
            <Pencil v-else class="w-5 h-5" />
          </button>
        </div>
        <div class="flex items-center gap-3">
          <input v-if="editing" v-model="project.desc" class="text-slate-500 bg-transparent border-b border-slate-300 dark:border-slate-700 focus:outline-none w-full max-w-lg" />
          <p v-else class="text-slate-500">{{ project.desc }}</p>
        </div>
      </div>
      <div class="flex gap-3">
        <button @click="$emit('navigate', 'workflow')" class="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center gap-2">
          <Plus class="w-4 h-4" /> 新增會議
        </button>
        <button @click="$emit('navigate', 'reviewer')" class="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-2 rounded-lg flex items-center gap-2">
          <BookOpen class="w-4 h-4" /> 開啟 Reviewer
        </button>
      </div>
    </div>

    <!-- Meeting List -->
    <div class="space-y-4">
      <h3 class="text-lg font-bold">會議列表</h3>
      <div class="space-y-3">
        <div v-for="m in meetings" :key="m.id" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div class="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors" @click="m.expanded = !m.expanded">
            <div class="flex items-center gap-4">
              <div class="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg"><Mic class="w-5 h-5" /></div>
              <div>
                <div class="font-bold">{{ m.title }}</div>
                <div class="text-xs text-slate-400">{{ m.date }} • {{ m.duration }}</div>
              </div>
            </div>
            <div class="flex items-center gap-8">
              <!-- Step progress -->
              <div class="flex items-center gap-2 text-slate-300">
                <UploadCloud class="w-4 h-4" :class="{ 'text-green-500': m.step >= 1 }" />
                <div class="w-4 h-[2px] bg-slate-200 dark:bg-slate-800"></div>
                <Hash class="w-4 h-4" :class="{ 'text-green-500': m.step >= 2 }" />
                <div class="w-4 h-[2px] bg-slate-200 dark:bg-slate-800"></div>
                <Type class="w-4 h-4" :class="{ 'text-green-500': m.step >= 3 }" />
                <div class="w-4 h-[2px] bg-slate-200 dark:bg-slate-800"></div>
                <Sparkles class="w-4 h-4" :class="{ 'text-green-500': m.step >= 4 }" />
              </div>
              <ChevronUp v-if="m.expanded" class="w-5 h-5" />
              <ChevronDown v-else class="w-5 h-5" />
            </div>
          </div>

          <div v-if="m.expanded" class="px-4 pb-4 pt-0 border-t border-slate-100 dark:border-slate-800/50">
            <div class="mt-4 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
              <div class="flex justify-between items-center mb-4">
                <h4 class="text-xs font-bold uppercase text-slate-400">洞見摘要預覽</h4>
                <button class="text-xs text-blue-500 hover:underline">複製內容</button>
              </div>
              <p class="text-sm leading-relaxed text-slate-600 dark:text-slate-400">{{ m.summaryPreview }}</p>
            </div>
            <div class="mt-4 flex justify-end gap-2">
              <button @click="$emit('navigate', 'workflow')" class="text-sm px-4 py-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">重新處理</button>
              <button @click="$emit('navigate', 'reviewer')" class="text-sm px-4 py-2 bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white rounded-lg">查看完整 Review</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import {
  Check, Pencil, Plus, BookOpen, Mic,
  UploadCloud, Hash, Type, Sparkles, ChevronUp, ChevronDown
} from 'lucide-vue-next'

const props = defineProps({ project: Object, meetings: Array })
defineEmits(['navigate'])

const editing = ref(false)
</script>
