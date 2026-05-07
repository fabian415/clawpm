<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div v-if="show" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl shadow-2xl p-8 text-center">
        <div v-if="!isRestarting">
          <div class="w-16 h-16 bg-red-100 dark:bg-red-900/30 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <AlertTriangle class="w-8 h-8" />
          </div>
          <h3 class="text-2xl font-bold mb-3">確認重啟容器？</h3>
          <p class="text-slate-500 mb-8">重啟將中斷目前正在進行的所有轉錄工作。這大約需要 15-30 秒來重新加載 AI 模型。</p>
          <div class="flex gap-3">
            <button @click="$emit('close')" class="flex-1 py-3 rounded-xl border border-slate-200 dark:border-slate-800 text-slate-500 font-bold hover:bg-slate-50 dark:hover:bg-slate-800">取消</button>
            <button @click="$emit('confirm')" class="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 shadow-lg shadow-red-500/20">確認重啟</button>
          </div>
        </div>
        <div v-else class="py-10">
          <div class="w-16 h-16 mx-auto mb-6 relative">
            <svg class="animate-spin w-full h-full text-blue-600" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          <h3 class="text-xl font-bold mb-2">正在重啟 Container...</h3>
          <div class="h-1.5 w-48 bg-slate-100 dark:bg-slate-800 rounded-full mx-auto overflow-hidden mt-4">
            <div class="h-full bg-blue-600 transition-all duration-300" :style="{ width: restartProgress + '%' }"></div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { AlertTriangle } from 'lucide-vue-next'

defineProps({ show: Boolean, isRestarting: Boolean, restartProgress: Number })
defineEmits(['close', 'confirm'])
</script>
