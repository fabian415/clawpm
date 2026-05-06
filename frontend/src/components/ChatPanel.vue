<template>
  <!-- Backdrop (mobile) -->
  <Transition name="fade">
    <div v-if="show" class="fixed inset-0 z-40 sm:hidden bg-black/30" @click="$emit('close')" />
  </Transition>

  <!-- Panel -->
  <Transition name="slide-up">
    <div
      v-if="show"
      class="fixed z-50 bottom-24 left-4 sm:left-6 w-[calc(100vw-2rem)] sm:w-[420px] max-h-[70vh] flex flex-col bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full" :class="isConnected ? 'bg-green-400' : 'bg-slate-400 animate-pulse'" />
          <span class="font-semibold text-sm text-slate-800 dark:text-slate-200">OpenClaw 對話</span>
          <span v-if="!isConnected" class="text-xs text-slate-400">連線中…</span>
        </div>
        <div class="flex items-center gap-1">
          <button
            @click="$emit('new-session')"
            title="開新對話"
            class="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <SquarePen class="w-4 h-4" />
          </button>
          <button
            @click="$emit('close')"
            class="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div ref="scrollEl" class="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        <!-- Empty state -->
        <div v-if="messages.length === 0" class="flex flex-col items-center justify-center h-full py-12 text-center">
          <div class="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-3">
            <Bot class="w-6 h-6 text-blue-600 dark:text-blue-400" />
          </div>
          <p class="text-sm font-medium text-slate-700 dark:text-slate-300">與 OpenClaw 對話</p>
          <p class="text-xs text-slate-400 dark:text-slate-500 mt-1">輸入訊息開始對話</p>
        </div>

        <!-- Message list -->
        <template v-for="msg in messages" :key="msg.id">
          <!-- User message -->
          <div v-if="msg.role === 'user'" class="flex justify-end">
            <div class="max-w-[80%] px-3.5 py-2 bg-blue-600 text-white rounded-2xl rounded-br-sm text-sm leading-relaxed">
              {{ msg.content }}
            </div>
          </div>

          <!-- System / error -->
          <div v-else-if="msg.role === 'system'" class="flex justify-center">
            <div class="text-xs px-3 py-1.5 rounded-full" :class="msg.isError ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'">
              {{ msg.content }}
            </div>
          </div>

          <!-- Assistant message -->
          <div v-else class="flex gap-2 items-start">
            <div class="w-7 h-7 rounded-lg bg-slate-800 dark:bg-slate-700 flex items-center justify-center shrink-0 mt-0.5">
              <Bot class="w-4 h-4 text-white" />
            </div>
            <div class="flex-1 min-w-0 space-y-1.5">
              <!-- Tool-use events (collapsed) -->
              <ToolEventGroup
                v-if="msg.events && msg.events.length > 0"
                :events="msg.events"
                :is-streaming="msg.isStreaming"
              />

              <!-- Text content -->
              <div
                v-if="msg.content || msg.isStreaming"
                class="prose prose-sm max-w-none text-sm text-slate-700 dark:text-slate-300 leading-relaxed"
              >
                <span v-if="msg.content" class="whitespace-pre-wrap">{{ msg.content }}</span>
                <!-- Typing cursor while streaming -->
                <span v-if="msg.isStreaming" class="inline-block w-2 h-4 bg-slate-400 animate-pulse ml-0.5 align-middle" />
              </div>
            </div>
          </div>
        </template>

        <!-- Loading indicator (before message_start arrives) -->
        <div v-if="isLoading && !hasStreamingMsg" class="flex gap-2 items-center">
          <div class="w-7 h-7 rounded-lg bg-slate-800 dark:bg-slate-700 flex items-center justify-center shrink-0">
            <Bot class="w-4 h-4 text-white" />
          </div>
          <div class="flex gap-1 items-center py-2">
            <span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style="animation-delay: 0ms" />
            <span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style="animation-delay: 150ms" />
            <span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style="animation-delay: 300ms" />
          </div>
        </div>
      </div>

      <!-- Input -->
      <div class="px-3 py-2.5 border-t border-slate-100 dark:border-slate-800 shrink-0">
        <div class="flex items-end gap-2 bg-slate-50 dark:bg-slate-800 rounded-xl px-3 py-2">
          <textarea
            ref="inputEl"
            v-model="inputText"
            @keydown.enter.exact.prevent="submit"
            @keydown.enter.shift.exact="addNewline"
            placeholder="輸入訊息… (Enter 送出, Shift+Enter 換行)"
            rows="1"
            :disabled="!isConnected || isLoading"
            class="flex-1 resize-none bg-transparent text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 outline-none max-h-32 leading-relaxed disabled:opacity-50"
            @input="autoResize"
          />
          <button
            @click="submit"
            :disabled="!inputText.trim() || !isConnected || isLoading"
            class="p-1.5 rounded-lg bg-blue-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors shrink-0"
          >
            <SendHorizontal class="w-4 h-4" />
          </button>
        </div>
        <p class="text-[10px] text-slate-400 text-center mt-1.5">AI 可能犯錯，請自行核實重要資訊</p>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { X, SquarePen, Bot, SendHorizontal } from 'lucide-vue-next'
import ToolEventGroup from './ToolEventGroup.vue'

const props = defineProps({
  show: Boolean,
  messages: { type: Array, default: () => [] },
  isConnected: Boolean,
  isLoading: Boolean,
})

const emit = defineEmits(['close', 'send', 'new-session'])

const inputText = ref('')
const scrollEl = ref(null)
const inputEl = ref(null)

const hasStreamingMsg = computed(() => props.messages.some(m => m.isStreaming))

function submit() {
  const text = inputText.value.trim()
  if (!text || !props.isConnected || props.isLoading) return
  emit('send', text)
  inputText.value = ''
  nextTick(() => {
    if (inputEl.value) {
      inputEl.value.style.height = 'auto'
    }
  })
}

function addNewline() {
  inputText.value += '\n'
}

function autoResize(e) {
  const el = e.target
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 128) + 'px'
}

// Auto-scroll to bottom on new messages
watch(() => props.messages.length, () => scrollToBottom())
watch(() => {
  const streaming = props.messages.find(m => m.isStreaming)
  return streaming?.content
}, () => scrollToBottom())

function scrollToBottom() {
  nextTick(() => {
    if (scrollEl.value) {
      scrollEl.value.scrollTop = scrollEl.value.scrollHeight
    }
  })
}

// Focus input when panel opens
watch(() => props.show, (v) => {
  if (v) nextTick(() => inputEl.value?.focus())
})
</script>

<style scoped>
.slide-up-enter-active,
.slide-up-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
