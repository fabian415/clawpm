<template>
  <div class="max-w-3xl mx-auto w-full space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold">專有名詞辭庫</h1>
        <p class="text-sm text-slate-500 mt-1">管理團隊的專有名詞，轉錄時自動帶入以提升辨識準確率</p>
      </div>
      <button
        @click="openAdd"
        class="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium text-sm transition-colors"
      >
        <Plus class="w-4 h-4" />
        新增術語
      </button>
    </div>

    <!-- Search & Stats -->
    <div class="flex items-center gap-3">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          v-model="search"
          type="text"
          placeholder="搜尋術語..."
          class="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-900 outline-none focus:ring-2 focus:ring-blue-500 dark:text-slate-100"
        />
      </div>
      <span class="text-sm text-slate-400 shrink-0">共 {{ terms.length }} 筆</span>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="flex items-center justify-center py-16 text-slate-400">
      <Loader2 class="w-6 h-6 animate-spin mr-2" />
      <span class="text-sm">載入中...</span>
    </div>

    <!-- Empty state -->
    <div v-else-if="terms.length === 0" class="flex flex-col items-center justify-center py-16 text-center gap-3">
      <div class="w-14 h-14 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
        <BookMarked class="w-7 h-7 text-slate-400" />
      </div>
      <p class="font-medium text-slate-600 dark:text-slate-300">辭庫尚無術語</p>
      <p class="text-sm text-slate-400">點擊「新增術語」開始建立你的專有名詞辭庫</p>
    </div>

    <!-- Term list -->
    <div v-else class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
      <div
        v-for="(term, idx) in filteredTerms"
        :key="term.id"
        class="flex items-center gap-4 px-5 py-3.5 group"
        :class="idx < filteredTerms.length - 1 ? 'border-b border-slate-100 dark:border-slate-800' : ''"
      >
        <span class="flex-1 text-sm font-medium text-slate-700 dark:text-slate-200">{{ term.term }}</span>
        <span class="text-xs text-slate-400 shrink-0">{{ formatDate(term.created_at) }}</span>
        <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            @click="openEdit(term)"
            class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-blue-500 transition-colors"
            title="編輯"
          >
            <Pencil class="w-3.5 h-3.5" />
          </button>
          <button
            @click="confirmDelete(term)"
            class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-red-500 transition-colors"
            title="刪除"
          >
            <Trash2 class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div v-if="filteredTerms.length === 0" class="py-8 text-center text-sm text-slate-400">
        找不到符合「{{ search }}」的術語
      </div>
    </div>
  </div>

  <!-- Add / Edit Modal -->
  <div v-if="modal.show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="modal.show = false">
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
      <h3 class="font-bold text-base">{{ modal.isEdit ? '編輯術語' : '新增術語' }}</h3>
      <input
        ref="modalInputRef"
        v-model="modal.term"
        @keyup.enter="saveModal"
        type="text"
        placeholder="輸入術語..."
        class="w-full px-4 py-2.5 text-sm border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800 outline-none focus:ring-2 focus:ring-blue-500 dark:text-slate-100"
        :class="modal.error ? 'border-red-400' : ''"
      />
      <p v-if="modal.error" class="text-xs text-red-500">{{ modal.error }}</p>
      <div class="flex gap-2 justify-end">
        <button @click="modal.show = false" class="px-4 py-2 text-sm rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">取消</button>
        <button
          @click="saveModal"
          :disabled="modal.saving"
          class="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-colors disabled:opacity-50"
        >
          {{ modal.saving ? '儲存中...' : '儲存' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Delete confirm -->
  <div v-if="deleteTarget" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="deleteTarget = null">
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
      <h3 class="font-bold text-base">確認刪除</h3>
      <p class="text-sm text-slate-600 dark:text-slate-300">確定要刪除術語「<strong>{{ deleteTarget.term }}</strong>」嗎？此操作無法復原。</p>
      <div class="flex gap-2 justify-end">
        <button @click="deleteTarget = null" class="px-4 py-2 text-sm rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">取消</button>
        <button
          @click="deleteTerm"
          :disabled="isDeleting"
          class="px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-xl transition-colors disabled:opacity-50"
        >
          {{ isDeleting ? '刪除中...' : '確認刪除' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted } from 'vue'
import { Plus, Search, BookMarked, Pencil, Trash2, Loader2 } from 'lucide-vue-next'

const emit = defineEmits(['toast'])

const isLoading = ref(false)
const terms = ref([])
const search = ref('')
const deleteTarget = ref(null)
const isDeleting = ref(false)
const modalInputRef = ref(null)

const modal = ref({ show: false, isEdit: false, id: null, term: '', error: '', saving: false })

const filteredTerms = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return terms.value
  return terms.value.filter(t => t.term.toLowerCase().includes(q))
})

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('zh-TW')
}

async function fetchTerms() {
  isLoading.value = true
  try {
    const res = await fetch('/api/terminology', {
      headers: { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
    })
    if (!res.ok) throw new Error()
    terms.value = await res.json()
  } catch {
    emit('toast', '載入辭庫失敗', 'error')
  } finally {
    isLoading.value = false
  }
}

function openAdd() {
  modal.value = { show: true, isEdit: false, id: null, term: '', error: '', saving: false }
  nextTick(() => modalInputRef.value?.focus())
}

function openEdit(term) {
  modal.value = { show: true, isEdit: true, id: term.id, term: term.term, error: '', saving: false }
  nextTick(() => modalInputRef.value?.focus())
}

async function saveModal() {
  const term = modal.value.term.trim()
  if (!term) { modal.value.error = '術語不可為空'; return }
  modal.value.error = ''
  modal.value.saving = true
  try {
    const url = modal.value.isEdit ? `/api/terminology/${modal.value.id}` : '/api/terminology'
    const method = modal.value.isEdit ? 'PUT' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ term })
    })
    const data = await res.json()
    if (!res.ok) { modal.value.error = data.error || '操作失敗'; return }
    if (modal.value.isEdit) {
      const idx = terms.value.findIndex(t => t.id === modal.value.id)
      if (idx >= 0) terms.value[idx] = data
    } else {
      terms.value.push(data)
      terms.value.sort((a, b) => a.term.localeCompare(b.term, 'zh-TW'))
    }
    modal.value.show = false
    emit('toast', modal.value.isEdit ? '術語已更新' : '術語已新增')
  } catch {
    modal.value.error = '操作失敗，請稍後再試'
  } finally {
    modal.value.saving = false
  }
}

function confirmDelete(term) {
  deleteTarget.value = term
}

async function deleteTerm() {
  if (!deleteTarget.value) return
  isDeleting.value = true
  try {
    const res = await fetch(`/api/terminology/${deleteTarget.value.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
    })
    if (!res.ok) throw new Error()
    terms.value = terms.value.filter(t => t.id !== deleteTarget.value.id)
    emit('toast', '術語已刪除')
    deleteTarget.value = null
  } catch {
    emit('toast', '刪除失敗', 'error')
  } finally {
    isDeleting.value = false
  }
}

onMounted(fetchTerms)
</script>
