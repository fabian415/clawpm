<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="translate-y-4 opacity-0"
    leave-active-class="transition duration-200 ease-in"
    leave-to-class="translate-y-4 opacity-0"
  >
    <div v-if="toast.show" class="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100]">
      <div
        class="px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3"
        :class="toast.type === 'error'
          ? 'bg-red-600 text-white'
          : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'"
      >
        <XCircle v-if="toast.type === 'error'" class="w-5 h-5 text-red-200 shrink-0" />
        <CheckCircle v-else class="w-5 h-5 text-green-400 shrink-0" />
        <span class="font-medium text-sm">{{ toast.message }}</span>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { CheckCircle, XCircle } from 'lucide-vue-next'
defineProps({ toast: Object })
</script>
