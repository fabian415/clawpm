<template>
  <div class="max-w-3xl mx-auto space-y-6 pb-16">
    <div class="flex items-center gap-3 mb-8">
      <div class="w-10 h-10 bg-blue-100 dark:bg-blue-900/40 rounded-xl flex items-center justify-center">
        <ScrollText class="w-5 h-5 text-blue-600 dark:text-blue-400" />
      </div>
      <div>
        <h1 class="text-2xl font-bold text-slate-900 dark:text-white">更新紀錄</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400">MemoSynth Release Notes</p>
      </div>
    </div>

    <div v-if="isLoading" class="flex justify-center py-16 text-slate-400">
      <Loader2 class="w-6 h-6 animate-spin" />
    </div>

    <div v-else-if="releases.length === 0" class="text-center py-16 text-slate-500">
      暫無更新紀錄
    </div>

    <div v-else class="space-y-5">
      <div
        v-for="(release, i) in releases"
        :key="release.version"
        class="rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900 shadow-sm"
      >
        <!-- Version header -->
        <div class="px-6 py-4 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <span
            class="text-sm font-bold px-3 py-1 rounded-full"
            :class="i === 0
              ? 'bg-blue-600 text-white'
              : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'"
          >
            {{ release.version }}
          </span>
          <span v-if="i === 0" class="text-[10px] font-semibold uppercase tracking-wider text-blue-500 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded-full">
            最新版本
          </span>
          <span class="ml-auto text-xs text-slate-400">{{ release.date }}</span>
        </div>

        <!-- Categories -->
        <div class="px-6 py-5 space-y-5">
          <div v-for="cat in release.categories" :key="cat.name">
            <div class="flex items-center gap-2 mb-2">
              <span
                class="text-xs font-semibold px-2.5 py-0.5 rounded-md"
                :class="categoryStyle(cat.name)"
              >
                {{ cat.name }}
              </span>
            </div>
            <ul class="space-y-2 pl-1">
              <li
                v-for="(item, idx) in cat.items"
                :key="idx"
                class="text-sm text-slate-700 dark:text-slate-300 leading-relaxed flex gap-2"
              >
                <span class="text-slate-400 dark:text-slate-600 select-none shrink-0 mt-0.5">•</span>
                <span class="whitespace-pre-wrap">{{ item }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ScrollText, Loader2 } from 'lucide-vue-next'

const isLoading = ref(true)
const releases = ref([])

const CATEGORY_STYLES = {
  '錯誤修正': 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  '新功能':   'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  '初始版本': 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
}

function categoryStyle(name) {
  return CATEGORY_STYLES[name] ?? 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
}

function parseReleaseNotes(text) {
  const SEPARATOR = '================================================================'
  const blocks = text.split(SEPARATOR).map(b => b.trim()).filter(Boolean)

  const result = []
  for (const block of blocks) {
    if (block.startsWith('MemoSynth Release Notes') || block === '') continue

    const lines = block.split('\n').map(l => l.trimEnd())
    const versionLine = lines.find(l => l.startsWith('VERSION:'))
    const dateLine = lines.find(l => l.startsWith('DATE:'))
    if (!versionLine) continue

    const version = versionLine.replace('VERSION:', '').trim()
    const date = dateLine ? dateLine.replace('DATE:', '').trim() : ''

    // Parse categories: sections starting with [Name]
    const categories = []
    let currentCat = null
    const DIVIDER = '----------------------------------------------------------------'

    for (const line of lines) {
      if (line === DIVIDER || line.startsWith('VERSION:') || line.startsWith('DATE:')) continue
      const catMatch = line.match(/^\[(.+)\]$/)
      if (catMatch) {
        currentCat = { name: catMatch[1], items: [] }
        categories.push(currentCat)
        continue
      }
      if (!currentCat) continue

      if (line.startsWith('- ')) {
        currentCat.items.push(line.slice(2))
      } else if (line.trim() !== '' && currentCat.items.length > 0) {
        // Continuation lines (indented) append to last item
        currentCat.items[currentCat.items.length - 1] += '\n' + line.trimStart()
      }
    }

    result.push({ version, date, categories })
  }
  return result
}

async function fetchReleaseNotes() {
  isLoading.value = true
  try {
    const res = await fetch('/api/release-notes')
    const data = await res.json().catch(() => ({}))
    releases.value = parseReleaseNotes(data.content || '')
  } catch {
    releases.value = []
  } finally {
    isLoading.value = false
  }
}

onMounted(fetchReleaseNotes)
</script>
