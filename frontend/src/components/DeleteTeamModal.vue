<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div v-if="show" class="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">

        <!-- Header -->
        <div class="bg-red-600 px-8 py-5 flex items-center gap-3">
          <div class="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center shrink-0">
            <TriangleAlert class="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 class="text-lg font-bold text-white">危險操作：刪除團隊</h3>
            <p class="text-red-100 text-xs mt-0.5">此操作無法復原</p>
          </div>
        </div>

        <div v-if="!isDeleting" class="p-8 space-y-5">
          <!-- Warning list -->
          <div class="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-xl p-4 space-y-2">
            <p class="text-sm font-semibold text-red-700 dark:text-red-400 mb-3">以下資料將被永久刪除：</p>
            <div class="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <CircleX class="w-4 h-4 shrink-0" />
              <span>容器（Container）及其設定與連接埠</span>
            </div>
            <div class="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <CircleX class="w-4 h-4 shrink-0" />
              <span>團隊內所有帳號（包含管理員）</span>
            </div>
            <div class="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <CircleX class="w-4 h-4 shrink-0" />
              <span>團隊記錄與設定</span>
            </div>
          </div>

          <!-- Confirmation input -->
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-700 dark:text-slate-300">
              請輸入團隊名稱 <span class="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-red-600 dark:text-red-400 text-xs">{{ teamName }}</span> 以確認刪除：
            </label>
            <input
              v-model="confirmInput"
              type="text"
              placeholder="輸入團隊名稱..."
              class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 focus:ring-red-500 text-sm"
              @keyup.enter="confirmInput === teamName && $emit('confirm')"
            />
          </div>

          <!-- Buttons -->
          <div class="flex gap-3 pt-1">
            <button
              @click="$emit('close')"
              class="flex-1 py-3 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              取消
            </button>
            <button
              @click="$emit('confirm')"
              :disabled="confirmInput !== teamName"
              class="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 shadow-lg shadow-red-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
            >
              確認刪除團隊
            </button>
          </div>
        </div>

        <!-- Deleting state -->
        <div v-else class="p-10 text-center">
          <div class="w-16 h-16 mx-auto mb-6 relative">
            <svg class="animate-spin w-full h-full text-red-600" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <h3 class="text-xl font-bold mb-2">正在刪除團隊...</h3>
          <p class="text-sm text-slate-400">移除容器、帳號與團隊資料中，請稍候</p>
        </div>

      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, watch } from 'vue'
import { TriangleAlert, CircleX } from 'lucide-vue-next'

const props = defineProps({
  show: Boolean,
  isDeleting: Boolean,
  teamName: { type: String, default: '' },
})
defineEmits(['close', 'confirm'])

const confirmInput = ref('')

watch(() => props.show, (v) => {
  if (!v) confirmInput.value = ''
})
</script>
