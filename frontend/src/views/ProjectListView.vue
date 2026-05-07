<template>
  <div class="max-w-6xl mx-auto space-y-6">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">專案清單</h2>
      <button @click="$emit('new-project')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-all">
        <Plus class="w-4 h-4" /> 新建專案
      </button>
    </div>

    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <table class="w-full text-left">
        <thead class="bg-slate-50 dark:bg-slate-800/50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-6 py-4 font-semibold">專案名稱</th>
            <th class="px-6 py-4 font-semibold">建立時間</th>
            <th class="px-6 py-4 font-semibold text-center">會議數</th>
            <th class="px-6 py-4 font-semibold">最後更新</th>
            <th class="px-6 py-4 font-semibold"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-200 dark:divide-slate-800">
          <tr
            v-for="p in projects" :key="p.id"
            @click="$emit('select-project', p)"
            class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
          >
            <td class="px-6 py-4">
              <div class="font-medium text-slate-900 dark:text-slate-100">{{ p.name }}</div>
              <div class="text-xs text-slate-500 truncate w-48">{{ p.desc }}</div>
            </td>
            <td class="px-6 py-4 text-sm">{{ p.created }}</td>
            <td class="px-6 py-4 text-center">
              <span class="bg-blue-100 dark:bg-blue-950 text-blue-600 text-[10px] px-2 py-0.5 rounded-full font-bold">{{ p.meetings }}</span>
            </td>
            <td class="px-6 py-4 text-sm text-slate-500">{{ p.updated }}</td>
            <td class="px-6 py-4 text-right">
              <button class="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md" @click.stop>
                <MoreHorizontal class="w-4 h-4" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { Plus, MoreHorizontal } from 'lucide-vue-next'

defineProps({ projects: Array })
defineEmits(['select-project', 'new-project'])
</script>
