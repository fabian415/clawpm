<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div v-if="show" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl shadow-2xl p-8 text-center">
        <div v-if="!isDestroying">
          <div class="w-16 h-16 bg-red-100 dark:bg-red-900/30 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <Trash2 class="w-8 h-8" />
          </div>
          <h3 class="text-2xl font-bold mb-3">確認刪除容器？</h3>
          <p class="text-slate-500 mb-2">此操作將永久停止並移除容器、釋放佔用的連接埠。</p>
          <p class="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-4 py-2 mb-8">
            ⚠ 工作區檔案不會被刪除，但需要重新 Provision 才能再次使用。
          </p>
          <div class="flex gap-3">
            <button @click="$emit('close')" class="flex-1 py-3 rounded-xl border border-slate-200 dark:border-slate-800 text-slate-500 font-bold hover:bg-slate-50 dark:hover:bg-slate-800">取消</button>
            <button @click="$emit('confirm')" class="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 shadow-lg shadow-red-500/20">確認刪除</button>
          </div>
        </div>
        <div v-else class="py-10">
          <div class="w-16 h-16 mx-auto mb-6 relative">
            <svg class="animate-spin w-full h-full text-red-600" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          <h3 class="text-xl font-bold mb-2">正在刪除容器...</h3>
          <p class="text-sm text-slate-400">停止容器並釋放資源中</p>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { Trash2 } from 'lucide-vue-next'

defineProps({
  show: Boolean,
  isDestroying: Boolean,
  containerConfig: { type: Object, default: null }
})
defineEmits(['close', 'confirm'])
</script>
