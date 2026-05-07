<template>
  <button
    @click="$emit('click')"
    class="fixed bottom-6 right-6 z-50 w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-xl flex items-center justify-center transition-all duration-200 hover:scale-110 active:scale-95"
    :title="isConnected ? 'OpenClaw 對話' : '正在連線...'"
  >
    <MessageCircle class="w-6 h-6" />

    <!-- Unread badge -->
    <span
      v-if="unreadCount > 0"
      class="absolute -top-1 -right-1 min-w-[20px] h-5 bg-red-500 text-white text-[11px] font-bold rounded-full flex items-center justify-center px-1 leading-none"
    >
      {{ unreadCount > 99 ? '99+' : unreadCount }}
    </span>

    <!-- Connection indicator dot -->
    <span
      class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white"
      :class="isConnected ? 'bg-green-400' : 'bg-slate-400'"
    />
  </button>
</template>

<script setup>
import { MessageCircle } from 'lucide-vue-next'

defineProps({
  unreadCount: { type: Number, default: 0 },
  isConnected: { type: Boolean, default: false },
})
defineEmits(['click'])
</script>
