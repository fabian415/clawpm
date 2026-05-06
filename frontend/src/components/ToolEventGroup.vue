<template>
  <div class="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-xs">
    <!-- Toggle header -->
    <button
      @click="expanded = !expanded"
      class="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left"
    >
      <Wrench class="w-3.5 h-3.5 shrink-0" />
      <span class="flex-1 truncate">
        {{ isStreaming ? '正在執行…' : `${events.length} 項系統操作` }}
      </span>
      <ChevronDown
        class="w-3.5 h-3.5 shrink-0 transition-transform duration-150"
        :class="{ 'rotate-180': expanded }"
      />
    </button>

    <!-- Expanded content -->
    <div v-if="expanded" class="divide-y divide-slate-100 dark:divide-slate-700/60">
      <div
        v-for="(ev, i) in events"
        :key="i"
        class="px-3 py-2 bg-white dark:bg-slate-900/40 space-y-1"
      >
        <!-- Role badge -->
        <div class="flex items-center gap-1.5 font-mono font-semibold text-slate-600 dark:text-slate-300">
          <span class="w-1.5 h-1.5 rounded-full shrink-0"
            :class="ev.role === 'toolresult' || ev.role === 'functionresult' ? 'bg-green-400' : 'bg-amber-400'" />
          <span class="capitalize">{{ ev.name ?? ev.role ?? 'tool' }}</span>
        </div>

        <!-- Content -->
        <pre
          v-if="ev.content"
          class="whitespace-pre-wrap break-all text-slate-500 dark:text-slate-400 leading-relaxed"
        >{{ formatContent(ev.content) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { Wrench, ChevronDown } from 'lucide-vue-next'

defineProps({
  events: { type: Array, default: () => [] },
  isStreaming: { type: Boolean, default: false },
})

const expanded = ref(false)

function formatContent(val) {
  if (typeof val === 'string') {
    try { return JSON.stringify(JSON.parse(val), null, 2) } catch { return val }
  }
  try { return JSON.stringify(val, null, 2) } catch { return String(val) }
}
</script>
