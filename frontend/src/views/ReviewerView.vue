<template>
  <div class="h-full flex flex-col -m-8">
    <!-- Toolbar -->
    <div class="h-14 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-6 bg-slate-50 dark:bg-slate-900">
      <div class="flex items-center gap-2">
        <button @click="mode = 'split'" :class="mode === 'split' ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all">
          <Columns2 class="w-4 h-4" />
        </button>
        <button @click="mode = 'edit'" :class="mode === 'edit' ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all">
          <PenTool class="w-4 h-4" />
        </button>
        <button @click="mode = 'preview'" :class="mode === 'preview' ? 'bg-white dark:bg-slate-700 shadow-sm' : ''" class="p-1.5 rounded-md hover:bg-white dark:hover:bg-slate-700 transition-all">
          <Eye class="w-4 h-4" />
        </button>
        <div class="w-px h-6 bg-slate-300 dark:bg-slate-700 mx-2"></div>
        <button class="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-800"><Bold class="w-4 h-4" /></button>
        <button class="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-800"><Italic class="w-4 h-4" /></button>
        <button class="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-800"><List class="w-4 h-4" /></button>
        <button class="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-800"><Code class="w-4 h-4" /></button>
      </div>
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2 text-xs">
          <span class="w-2 h-2 rounded-full bg-green-500"></span>
          <span class="text-slate-500">已儲存</span>
        </div>
        <div class="flex gap-1">
          <button class="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-2"><Save class="w-3.5 h-3.5" /> 儲存變更</button>
          <button class="bg-slate-200 dark:bg-slate-800 px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-2"><Download class="w-3.5 h-3.5" /> 匯出 .md</button>
          <button class="bg-slate-200 dark:bg-slate-800 px-3 py-1.5 rounded-md text-sm font-bold flex items-center gap-2"><Copy class="w-3.5 h-3.5" /> 複製</button>
        </div>
      </div>
    </div>

    <!-- Editor Area -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Code Editor -->
      <div v-if="mode !== 'preview'" class="flex-1 bg-[#1e1e1e] text-slate-300 p-6 font-mono text-sm overflow-y-auto outline-none" contenteditable="true">
        <pre>{{ markdownContent }}</pre>
      </div>
      <!-- Preview -->
      <div v-if="mode !== 'edit'" class="flex-1 bg-white dark:bg-slate-950 p-12 overflow-y-auto">
        <article class="prose dark:prose-invert max-w-none">
          <h1 class="text-3xl font-bold border-b pb-4 mb-6">會議專案洞見：ClawPM 前端架構討論</h1>
          <h2 class="text-xl font-bold mt-8 mb-4">核心決定</h2>
          <ul class="list-disc pl-5 space-y-2">
            <li>使用 <strong>Vue 3</strong> 作為主要框架</li>
            <li>採用 <strong>Tailwind CSS</strong> 進行快速 UI 佈局</li>
            <li>容器重啟邏輯需具備即時回饋</li>
          </ul>
          <h2 class="text-xl font-bold mt-8 mb-4">待辦清單</h2>
          <div class="space-y-2">
            <div class="flex items-center gap-3"><input type="checkbox" class="w-4 h-4 rounded text-blue-600" /><span>完成 Markdown Reviewer 雙欄顯示</span></div>
            <div class="flex items-center gap-3"><input type="checkbox" class="w-4 h-4 rounded text-blue-600" /><span>整合 Whisper API 轉錄流</span></div>
          </div>
          <h2 class="text-xl font-bold mt-8 mb-4">代碼範例</h2>
          <div class="bg-slate-100 dark:bg-slate-900 rounded-lg p-4 font-mono text-sm">
            <span class="text-purple-500">const</span> <span class="text-blue-500">handleRestart</span> = <span class="text-purple-500">async</span> () => {<br />
            &nbsp;&nbsp;isRestarting.value = <span class="text-orange-500">true</span>;<br />
            &nbsp;&nbsp;<span class="text-purple-500">await</span> restartContainer();<br />
            &nbsp;&nbsp;showToast(<span class="text-green-500">"容器已重啟"</span>);<br />
            }
          </div>
        </article>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { Columns2, PenTool, Eye, Bold, Italic, List, Code, Save, Download, Copy } from 'lucide-vue-next'

const mode = ref('split')

const markdownContent = `# 會議專案洞見：ClawPM 前端架構討論

## 核心決定
1. 使用 **Vue 3** 作為主要框架
2. 採用 **Tailwind CSS** 進行快速 UI 佈局
3. 容器重啟邏輯需具備即時回饋

## 待辦清單
- [ ] 完成 Markdown Reviewer 雙欄顯示
- [ ] 整合 Whisper API 轉錄流
- [ ] 實作容器重啟的 Toast 提示

## 代碼範例
\`\`\`javascript
const handleRestart = async () => {
    isRestarting.value = true;
    await restartContainer();
    showToast("容器已重啟");
}
\`\`\``
</script>
