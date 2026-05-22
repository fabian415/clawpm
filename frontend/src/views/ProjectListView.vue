<template>
  <div class="max-w-6xl mx-auto space-y-6">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">專案清單</h2>
      <button @click="$emit('new-project')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-all">
        <Plus class="w-4 h-4" /> 新建專案
      </button>
    </div>

    <div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div v-if="isLoading" class="flex items-center justify-center py-16 text-slate-400">
        <Loader2 class="w-6 h-6 animate-spin" />
      </div>
      <div v-else-if="projects.length === 0" class="py-16 text-center text-slate-400 text-sm">
        尚無專案，點擊「新建專案」開始建立。
      </div>
      <table v-else class="w-full text-left">
        <thead class="bg-slate-50 dark:bg-slate-800/50 text-slate-500 text-xs uppercase tracking-wider">
          <tr>
            <th class="px-6 py-4 font-semibold">專案名稱</th>
            <th class="px-6 py-4 font-semibold">成熟度</th>
            <th class="px-6 py-4 font-semibold">最後更新</th>
            <th class="px-6 py-4 font-semibold"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-200 dark:divide-slate-800">
          <tr
            v-for="p in projects" :key="p.slug"
            @click="confirmDeleteSlug !== p.slug && $emit('select-project', p)"
            class="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
            :class="confirmDeleteSlug !== p.slug ? 'cursor-pointer' : 'cursor-default'"
          >
            <td class="px-6 py-4">
              <div class="font-medium text-slate-900 dark:text-slate-100">{{ p.name || p.title }}</div>
            </td>
            <td class="px-6 py-4 text-sm text-slate-500">{{ p.maturity || '—' }}</td>
            <td class="px-6 py-4 text-sm text-slate-500">{{ p.lastUpdated || '—' }}</td>
            <td class="px-6 py-4 text-right">
              <div v-if="confirmDeleteSlug === p.slug" class="flex items-center justify-end gap-2" @click.stop>
                <span class="text-xs text-red-600 font-medium whitespace-nowrap">確認刪除？</span>
                <button
                  @click.stop="deleteProject(p.slug)"
                  :disabled="isDeleting"
                  class="text-xs px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded-md disabled:opacity-50 transition-colors"
                >確認</button>
                <button
                  @click.stop="confirmDeleteSlug = null"
                  class="text-xs px-2 py-1 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded-md transition-colors"
                >取消</button>
              </div>
              <button
                v-else
                @click.stop="confirmDeleteSlug = p.slug"
                class="p-2 hover:bg-red-100 dark:hover:bg-red-950/50 hover:text-red-600 text-slate-400 rounded-md transition-colors"
                title="刪除專案"
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="deleteError" class="text-sm text-red-500">{{ deleteError }}</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { Plus, Trash2, Loader2 } from 'lucide-vue-next'

const emit = defineEmits(['select-project', 'new-project'])

const isLoading = ref(false)
const isDeleting = ref(false)
const projects = ref([])
const confirmDeleteSlug = ref(null)
const deleteError = ref('')

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function fetchProjects() {
  isLoading.value = true
  try {
    const res = await fetch('/api/project-insights/list', { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    projects.value = (data.projects || []).sort((a, b) => {
      if (!a.lastUpdated) return 1
      if (!b.lastUpdated) return -1
      return b.lastUpdated.localeCompare(a.lastUpdated)
    })
  } finally {
    isLoading.value = false
  }
}

async function deleteProject(slug) {
  isDeleting.value = true
  deleteError.value = ''
  try {
    const res = await fetch(`/api/project-insights/delete?slug=${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    const data = await res.json()
    if (!res.ok) {
      deleteError.value = data.error || '刪除失敗'
      return
    }
    confirmDeleteSlug.value = null
    await fetchProjects()
  } catch {
    deleteError.value = '刪除失敗，請稍後再試'
  } finally {
    isDeleting.value = false
  }
}

onMounted(fetchProjects)
</script>
