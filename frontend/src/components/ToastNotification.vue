<template>
  <Transition
    enter-active-class="transition duration-300 ease-out"
    enter-from-class="translate-y-4 opacity-0"
    leave-active-class="transition duration-200 ease-in"
    leave-to-class="translate-y-4 opacity-0"
  >
    <div v-if="toast.show" class="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100]">
      <div class="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3">
        <CheckCircle class="w-5 h-5 text-green-400" />
        <span class="font-medium text-sm">{{ toast.message }}</span>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { CheckCircle } from 'lucide-vue-next'
defineProps({ toast: Object })
</script>
