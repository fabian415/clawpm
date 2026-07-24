<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div v-if="show" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-800">
        <div class="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
          <h3 class="text-xl font-bold text-slate-900 dark:text-white">複製技能</h3>
          <button @click="$emit('close')" class="text-slate-400 hover:text-slate-600"><X class="w-6 h-6" /></button>
        </div>
        <div class="p-6 space-y-4">
          <p class="text-sm text-slate-500">
            以 <span class="font-mono font-medium text-slate-700 dark:text-slate-300">{{ sourceSlug }}</span> 為基礎建立一份可自由編輯的複本。
          </p>
          <div>
            <label class="block text-sm font-medium mb-1">新技能識別碼（slug） <span class="text-red-500">*</span></label>
            <input
              type="text" v-model="newSlug" placeholder="例如：tech-analyzer-internal"
              class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
            />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">顯示名稱</label>
            <input
              type="text" v-model="newName" placeholder="選填，會標註在技能說明前方"
              class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div v-if="error" class="bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 text-sm px-4 py-2 rounded-xl">{{ error }}</div>
        </div>
        <div class="p-6 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-3">
          <button @click="$emit('close')" class="px-6 py-2 rounded-xl text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700">取消</button>
          <button
            @click="clone"
            :disabled="isCloning"
            :class="isCloning ? 'opacity-60 cursor-not-allowed' : 'hover:bg-blue-700'"
            class="bg-blue-600 text-white px-8 py-2 rounded-xl font-bold transition-colors flex items-center gap-2"
          >
            <Loader2 v-if="isCloning" class="w-4 h-4 animate-spin" />
            複製
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, watch } from 'vue'
import { X, Loader2 } from 'lucide-vue-next'

const props = defineProps({ show: Boolean, sourceSlug: { type: String, default: '' } })
const emit = defineEmits(['close', 'cloned'])

const newSlug = ref('')
const newName = ref('')
const isCloning = ref(false)
const error = ref('')

watch(() => props.show, (show) => {
  if (!show) return
  newSlug.value = ''
  newName.value = ''
  error.value = ''
  isCloning.value = false
})

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function clone() {
  const slug = newSlug.value.trim()
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(slug)) {
    error.value = '技能識別碼僅限小寫英數字與連字號'
    return
  }

  isCloning.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(props.sourceSlug)}/clone`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ newSlug: slug, newName: newName.value.trim() }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '複製失敗')
    emit('cloned', { slug })
  } catch (err) {
    error.value = err.message
  } finally {
    isCloning.value = false
  }
}
</script>
