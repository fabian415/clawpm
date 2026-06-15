<template>
  <!-- Preview Modal -->
  <div v-if="previewModal.show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="previewModal.show = false">
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
      <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold text-base">{{ previewModal.title }}</h3>
        <div class="flex items-center gap-2">
          <button @click="downloadText(previewModal.content, previewModal.filename)" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
            <Download class="w-3.5 h-3.5" /> 下載
          </button>
          <button @click="previewModal.show = false" class="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500">
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-6 py-5">
        <div class="md-preview text-sm text-slate-700 dark:text-slate-300 leading-relaxed" v-html="renderMarkdown(previewModal.content)"></div>
      </div>
    </div>
  </div>

  <div :class="hasAnyFiles ? 'flex gap-5 items-start' : ''">
    <!-- Left Files Panel -->
    <div v-if="hasAnyFiles" class="w-64 shrink-0">
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <FolderOpen class="w-4 h-4 text-slate-400 shrink-0" />
          <span class="text-sm font-bold">會議文件</span>
        </div>

        <div class="divide-y divide-slate-100 dark:divide-slate-800">
          <!-- Supplementary Docs -->
          <div v-if="successDocs.length > 0" class="px-4 py-3">
            <p class="text-[10px] uppercase font-semibold text-slate-400 tracking-wider mb-2">補充文件</p>
            <div v-for="doc in successDocs" :key="doc.remotePath" class="flex items-center gap-2 py-1.5 group">
              <File class="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span class="text-xs text-slate-600 dark:text-slate-400 truncate flex-1 min-w-0" :title="doc.name">{{ doc.name }}</span>
              <button @click="downloadDoc(doc.remotePath, doc.name)" class="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-blue-500 transition-all" title="下載">
                <Download class="w-3 h-3" />
              </button>
            </div>
          </div>

          <!-- Transcript -->
          <div v-if="transcriptRawContent" class="px-4 py-3">
            <p class="text-[10px] uppercase font-semibold text-slate-400 tracking-wider mb-2">逐字稿</p>
            <div class="flex items-center gap-2 py-1.5 group">
              <FileText class="w-3.5 h-3.5 text-green-400 shrink-0" />
              <span class="text-xs text-slate-600 dark:text-slate-400 truncate flex-1 min-w-0">逐字稿.md</span>
              <div class="shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button @click="openPreview('逐字稿', transcriptRawContent, 'transcript.md')" class="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-blue-500" title="預覽">
                  <Eye class="w-3 h-3" />
                </button>
                <button @click="downloadText(transcriptRawContent, 'transcript.md')" class="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-blue-500" title="下載">
                  <Download class="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>

          <!-- Meeting Notes -->
          <div v-if="meetingNotesContent" class="px-4 py-3">
            <p class="text-[10px] uppercase font-semibold text-slate-400 tracking-wider mb-2">會議記錄</p>
            <div class="flex items-center gap-2 py-1.5 group">
              <FileText class="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span class="text-xs text-slate-600 dark:text-slate-400 truncate flex-1 min-w-0">會議記錄.md</span>
              <div class="shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button @click="openPreview('會議記錄', meetingNotesContent, 'meeting-notes.md')" class="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-purple-500" title="預覽">
                  <Eye class="w-3 h-3" />
                </button>
                <button @click="downloadText(meetingNotesContent, 'meeting-notes.md')" class="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-purple-500" title="下載">
                  <Download class="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Workflow Content -->
    <div :class="hasAnyFiles ? 'flex-1 min-w-0 max-w-3xl' : 'max-w-4xl mx-auto w-full'">
    <!-- Stepper -->
    <div class="mb-12 relative flex justify-between">
      <div class="absolute top-5 left-0 w-full h-1 bg-slate-200 dark:bg-slate-800 -z-10"></div>
      <div class="absolute top-5 left-0 h-1 bg-blue-600 -z-10 transition-all duration-500" :style="{ width: ((step - 1) / 5 * 100) + '%' }"></div>

      <div v-for="s in 6" :key="s" class="flex flex-col items-center">
        <div
          :class="[step >= s ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-400']"
          class="w-10 h-10 rounded-full border-2 flex items-center justify-center font-bold mb-2 transition-all duration-300 shadow-sm"
        >
          <Check v-if="step > s" class="w-5 h-5 text-white" />
          <span v-else>{{ s }}</span>
        </div>
        <span :class="step === s ? 'text-blue-600 font-bold' : 'text-slate-400'" class="text-xs">{{ stepLabels[s - 1] }}</span>
      </div>
    </div>

    <!-- Step 1: Upload -->
    <div v-if="step === 1" class="space-y-6">
      <!-- Hidden file input for audio -->
      <input
        ref="fileInputRef"
        type="file"
        accept=".mp3,.wav,.m4a,.webm"
        class="hidden"
        @change="handleFileChange"
      />

      <!-- Hidden file input for docs -->
      <input
        ref="docFileInputRef"
        type="file"
        accept=".pdf,.docx,.txt,.csv,.xls,.xlsx,.pptx"
        multiple
        class="hidden"
        @change="handleDocFileChange"
      />

      <!-- Meeting date picker -->
      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex items-center gap-4">
        <Calendar class="w-5 h-5 text-slate-400 shrink-0" />
        <label class="font-bold text-sm shrink-0">會議日期</label>
        <input
          v-model="meetingDate"
          type="date"
          class="px-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:text-slate-100"
        />
        <span class="text-xs text-slate-400">此日期將用於建立資料夾及帶入 AI 對話</span>
      </div>

      <!-- Upload area -->
      <div
        @click="openFileDialog"
        class="bg-white dark:bg-slate-900 border-2 border-dashed rounded-2xl p-12 text-center transition-colors group cursor-pointer"
        :class="uploadError
          ? 'border-red-400 dark:border-red-600'
          : uploadDone
            ? 'border-green-400 dark:border-green-600'
            : 'border-slate-300 dark:border-slate-700 hover:border-blue-500'"
      >
        <!-- Idle state -->
        <template v-if="!selectedFile && !uploadError">
          <div class="w-16 h-16 bg-blue-50 dark:bg-blue-900/30 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
            <UploadCloud class="w-8 h-8" />
          </div>
          <h3 class="text-lg font-bold mb-2">上傳會議音訊檔</h3>
          <p class="text-sm text-slate-500 mb-6">支援 MP3, WAV, M4A, WebM (上限 500MB)</p>
          <button class="bg-blue-600 text-white px-8 py-2.5 rounded-xl font-bold hover:bg-blue-700 transition-colors">選擇檔案</button>
        </template>

        <!-- Uploading state -->
        <template v-else-if="selectedFile && !uploadDone && !uploadError">
          <div class="w-16 h-16 bg-blue-50 dark:bg-blue-900/30 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <UploadCloud class="w-8 h-8 animate-bounce" />
          </div>
          <h3 class="text-lg font-bold mb-1">{{ selectedFile.name }}</h3>
          <p class="text-xs text-slate-400 mb-6">{{ formatFileSize(selectedFile.size) }}</p>
          <div class="max-w-xs mx-auto">
            <div class="h-2 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-2">
              <div class="h-full bg-blue-600 transition-all duration-300" :style="{ width: uploadProgress + '%' }"></div>
            </div>
            <p class="text-xs text-blue-500 font-medium">{{ uploadProgress }}% 上傳中...</p>
          </div>
        </template>

        <!-- Success state -->
        <template v-else-if="uploadDone">
          <div class="w-16 h-16 bg-green-50 dark:bg-green-900/30 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <Check class="w-8 h-8" />
          </div>
          <h3 class="text-lg font-bold mb-1 text-green-700 dark:text-green-400">上傳完成</h3>
          <p class="text-sm text-slate-500 mb-4">{{ selectedFile.name }}</p>
          <p class="text-xs text-slate-400">點擊重新選擇檔案</p>
        </template>

        <!-- Error state -->
        <template v-else>
          <div class="w-16 h-16 bg-red-50 dark:bg-red-900/30 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
            <X class="w-8 h-8" />
          </div>
          <h3 class="text-lg font-bold mb-1 text-red-600">上傳失敗</h3>
          <p class="text-sm text-red-500 mb-4">{{ uploadError }}</p>
          <button class="bg-blue-600 text-white px-8 py-2.5 rounded-xl font-bold hover:bg-blue-700 transition-colors">重新選擇</button>
        </template>
      </div>

      <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8">
        <h3 class="font-bold mb-4 flex items-center gap-2"><FileText class="w-5 h-5 text-slate-400" /> 會議補充文件 (選填)</h3>
        <div class="space-y-4">
          <div v-for="(file, idx) in uploadedDocs" :key="idx" class="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
            <div class="flex items-center gap-3">
              <Loader2 v-if="file.uploading" class="w-4 h-4 text-blue-500 animate-spin" />
              <AlertCircle v-else-if="file.error" class="w-4 h-4 text-red-500" />
              <File v-else class="w-4 h-4 text-blue-500" />
              <span class="text-sm font-medium">{{ file.name }}</span>
              <span v-if="file.uploading" class="text-[10px] text-blue-400">上傳中...</span>
              <span v-else-if="file.error" class="text-[10px] text-red-400">{{ file.error }}</span>
              <span v-else class="text-[10px] text-slate-400">{{ file.size }}</span>
            </div>
            <button @click.stop="removeDoc(idx)" class="text-red-500 hover:text-red-700"><X class="w-4 h-4" /></button>
          </div>
          <button
            @click="openDocDialog"
            @dragover.prevent="isDragOver = true"
            @dragleave="isDragOver = false"
            @drop.prevent="handleDocDrop"
            :class="isDragOver
              ? 'border-blue-500 text-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : 'border-slate-200 dark:border-slate-800 text-slate-400 hover:text-blue-500 hover:border-blue-500'"
            class="w-full py-3 border-2 border-dotted rounded-xl transition-all text-sm font-medium"
          >+ 點擊或拖放文件 (PDF, Docx, TXT, CSV, XLS, XLSX, PPTX)</button>
        </div>
      </div>
    </div>

    <!-- Step 2: Extraction -->
    <div v-if="step === 2" class="space-y-5">
      <!-- Processing spinner -->
      <div v-if="isProcessing" class="text-center py-10">
        <div class="relative w-32 h-32 mx-auto mb-8">
          <div class="absolute inset-0 rounded-full border-4 border-blue-100 dark:border-slate-800"></div>
          <div class="absolute inset-0 rounded-full border-4 border-blue-600 border-t-transparent animate-spin"></div>
          <div class="absolute inset-0 flex items-center justify-center">
            <Brain class="w-12 h-12 text-blue-600 animate-pulse" />
          </div>
        </div>
        <h3 class="text-2xl font-bold mb-2">正在辨識關鍵字...</h3>
        <p class="text-slate-500">AI 正在分析文件並提取專有名詞與核心概念</p>
      </div>

      <!-- Ready state -->
      <div v-else class="space-y-4 text-left">
        <!-- Error -->
        <div v-if="extractionError" class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/30 rounded-xl flex items-start gap-3">
          <AlertCircle class="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p class="font-medium text-red-700 dark:text-red-400 text-sm">萃取失敗</p>
            <p class="text-xs text-red-600 dark:text-red-500 mt-0.5">{{ extractionError }}</p>
          </div>
        </div>

        <!-- Library Terms -->
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-base flex items-center gap-2">
              <BookMarked class="w-4 h-4 text-blue-500 shrink-0" />
              辭庫術語
              <span class="text-xs font-normal text-slate-400">{{ checkedLibraryCount }}/{{ libraryTerms.length }}</span>
            </h3>
            <div class="flex gap-3 text-xs">
              <button @click="libraryTerms.forEach(t => t.checked = true)" class="text-blue-500 hover:underline">全選</button>
              <button @click="libraryTerms.forEach(t => t.checked = false)" class="text-slate-400 hover:underline">取消全選</button>
            </div>
          </div>
          <div v-if="libraryTerms.length > 0" class="flex flex-wrap gap-2">
            <label
              v-for="t in libraryTerms" :key="t.id"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium cursor-pointer select-none border transition-colors"
              :class="t.checked
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 border-blue-100 dark:border-blue-900/50'
                : 'bg-white dark:bg-slate-900 text-slate-400 border-slate-200 dark:border-slate-700'"
            >
              <input type="checkbox" v-model="t.checked" class="sr-only" />
              <Check v-if="t.checked" class="w-3 h-3 shrink-0" />
              {{ t.term }}
            </label>
          </div>
          <div v-else class="py-4 text-center text-xs text-slate-400">
            辭庫目前為空。
            <button @click="$emit('navigate', 'terminology')" class="text-blue-500 hover:underline">前往辭庫管理</button>
            新增術語。
          </div>
        </div>

        <!-- Extracted Terms -->
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-base flex items-center gap-2">
              <Sparkles class="w-4 h-4 text-amber-500 shrink-0" />
              本次萃取
              <span class="text-xs font-normal text-slate-400">{{ checkedExtractedCount }}/{{ extractedTerms.length }}</span>
            </h3>
            <div class="flex items-center gap-3">
              <div class="flex gap-3 text-xs">
                <button @click="extractedTerms.forEach(t => t.checked = true)" class="text-blue-500 hover:underline">全選</button>
                <button @click="extractedTerms.forEach(t => t.checked = false)" class="text-slate-400 hover:underline">取消全選</button>
              </div>
              <button
                @click="addCheckedToLibrary"
                :disabled="isBulkAdding || newExtractedCheckedCount === 0"
                class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <BookMarked class="w-3 h-3" />
                {{ isBulkAdding ? '新增中...' : `加入辭庫 (${newExtractedCheckedCount})` }}
              </button>
            </div>
          </div>
          <div v-if="extractedTerms.length > 0" class="flex flex-wrap gap-2">
            <label
              v-for="(t, idx) in extractedTerms" :key="idx"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium cursor-pointer select-none border transition-colors"
              :class="t.checked
                ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-100 dark:border-amber-800/40'
                : 'bg-white dark:bg-slate-900 text-slate-400 border-slate-200 dark:border-slate-700'"
            >
              <input type="checkbox" v-model="t.checked" class="sr-only" />
              <Check v-if="t.checked" class="w-3 h-3 shrink-0" />
              {{ t.term }}
              <span v-if="t.inLibrary" class="ml-0.5 text-[10px] text-blue-400 font-normal">辭庫</span>
            </label>
          </div>
          <div v-else class="py-4 text-center text-xs text-slate-400">
            <span v-if="!extractionOutputPath">未上傳補充文件，無法自動萃取</span>
            <span v-else>未萃取到任何術語</span>
            <span class="block mt-1 text-slate-300">您仍可手動新增術語以提升辨識準確率</span>
          </div>
        </div>

        <!-- Manual add -->
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
          <p class="text-xs font-medium text-slate-500 mb-3">手動新增術語（僅用於本次轉錄）</p>
          <div class="flex gap-2">
            <input
              v-model="newTag"
              @keyup.enter="addTag"
              placeholder="輸入術語後按 Enter 或點新增..."
              class="flex-1 px-3 py-2 text-sm border rounded-xl dark:bg-slate-800 border-slate-200 dark:border-slate-700 focus:ring-1 focus:ring-blue-500 outline-none"
            />
            <button @click="addTag" class="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors">新增</button>
          </div>
          <div v-if="manualTags.length > 0" class="flex flex-wrap gap-2 mt-3">
            <div
              v-for="(tag, idx) in manualTags" :key="idx"
              class="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-full text-sm group"
            >
              {{ tag }}
              <button @click="manualTags.splice(idx, 1)" class="hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                <X class="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 3: Transcription -->
    <div v-if="step === 3" class="space-y-6">
      <div v-if="isProcessing" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-12 text-center">
        <div class="mb-6 h-4 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden relative">
          <div class="h-full bg-blue-600 w-1/3 animate-loading"></div>
        </div>
        <h3 class="text-xl font-bold mb-2">AI 語音轉文字中...</h3>
        <p class="text-slate-500">OpenClaw 正在透過本地 Whisper 模型進行語者分離與轉錄</p>
        <p v-if="tags.length > 0" class="text-xs text-blue-500 mt-3">已帶入 {{ tags.length }} 個專有名詞提升辨識準確率</p>
        <p class="text-xs text-slate-400 mt-6">轉錄進度可在右下角聊天視窗查看</p>
        <button
          @click="showCancelConfirm = true"
          class="mt-6 px-5 py-2 text-sm border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors flex items-center gap-2 mx-auto"
        >
          <X class="w-4 h-4" /> 取消並返回上一步
        </button>

        <!-- Cancel confirmation dialog -->
        <div v-if="showCancelConfirm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-xl">
            <h4 class="font-bold text-base mb-2">確認取消轉錄？</h4>
            <p class="text-sm text-slate-500 mb-5">此操作將終止 WhisperX 伺服器上的轉錄任務，進度將無法恢復，確定要取消嗎？</p>
            <div class="flex gap-3 justify-end">
              <button
                @click="showCancelConfirm = false"
                class="px-4 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >繼續等待</button>
              <button
                @click="cancelTranscription"
                :disabled="isCancelling"
                class="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white rounded-xl font-medium transition-colors flex items-center gap-1.5"
              >
                <Loader2 v-if="isCancelling" class="w-3.5 h-3.5 animate-spin" />
                {{ isCancelling ? '取消中...' : '確認取消' }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="space-y-4">
        <!-- Transcription error -->
        <div v-if="transcriptError" class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/30 rounded-xl">
          <div class="flex items-start gap-3">
            <AlertCircle class="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div class="flex-1 min-w-0">
              <p class="font-medium text-red-700 dark:text-red-400 text-sm">轉錄失敗</p>
              <p class="text-xs text-red-600 dark:text-red-500 mt-0.5 break-words">{{ transcriptError }}</p>
            </div>
            <button
              @click="transcriptError = ''; transcriptJobId = null; startTranscription()"
              class="shrink-0 text-xs px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
            >重試</button>
          </div>
        </div>

        <!-- ── Comparison view ── -->
        <div v-if="showComparison" class="space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-xl font-bold">逐字稿比較</h3>
            <button @click="dismissRepair" class="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
              <X class="w-4 h-4" /> 關閉比較
            </button>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <!-- Original -->
            <div class="space-y-2">
              <div class="flex items-center gap-2">
                <h4 class="font-bold text-sm">原始版本</h4>
                <span class="text-xs text-slate-400">{{ transcriptWordCount.toLocaleString() }} 字</span>
              </div>
              <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 h-80 overflow-y-auto">
                <div v-for="line in transcriptLines" :key="line.id" class="mb-4">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded">{{ line.time }}</span>
                    <span class="font-bold text-xs">{{ line.speaker }}</span>
                  </div>
                  <p class="text-slate-600 dark:text-slate-400 pl-3 border-l-2 border-slate-100 dark:border-slate-800 text-sm">{{ line.text }}</p>
                </div>
              </div>
            </div>

            <!-- Repaired -->
            <div class="space-y-2">
              <div class="flex items-center gap-2">
                <h4 class="font-bold text-sm text-emerald-600 dark:text-emerald-400">AI 修復版本</h4>
                <span class="text-xs text-slate-400">{{ repairedWordCount.toLocaleString() }} 字</span>
                <span class="text-[10px] px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full font-medium">已修復</span>
              </div>
              <div class="bg-emerald-50/40 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-900/40 rounded-2xl p-4 h-80 overflow-y-auto">
                <div v-for="line in repairedLines" :key="line.id" class="mb-4">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/30 px-2 py-0.5 rounded">{{ line.time }}</span>
                    <span class="font-bold text-xs">{{ line.speaker }}</span>
                  </div>
                  <p class="text-slate-600 dark:text-slate-400 pl-3 border-l-2 border-emerald-300 dark:border-emerald-700 text-sm">{{ line.text }}</p>
                </div>
              </div>
            </div>
          </div>

          <div class="flex justify-end gap-3">
            <button @click="dismissRepair" class="px-5 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
              忽略修復
            </button>
            <button @click="applyRepair" class="flex items-center gap-2 px-5 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium transition-colors shadow-lg shadow-emerald-500/20">
              <Check class="w-4 h-4" /> 採用修復版本
            </button>
          </div>
        </div>

        <!-- ── Normal view (header + edit/view) ── -->
        <div v-else class="space-y-4">
          <div class="flex justify-between items-center">
            <h3 class="text-xl font-bold">逐字稿預覽</h3>
            <div class="flex items-center gap-2">
              <span class="text-xs text-slate-500">共 {{ transcriptWordCount.toLocaleString() }} 字</span>
              <button
                v-if="!transcriptEditMode && transcriptLines.length > 0"
                @click="enterEditMode"
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <Pencil class="w-3 h-3" /> 編輯
              </button>
              <template v-if="transcriptLines.length > 0">
                <button
                  v-if="!isRepairing"
                  @click="startRepair"
                  class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                >
                  <Sparkles class="w-3 h-3" /> AI 自動修復
                </button>
                <span v-else class="flex items-center gap-1.5 px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 font-medium">
                  <Loader2 class="w-3 h-3 animate-spin" /> AI 修復中...
                </span>
              </template>
            </div>
          </div>

          <!-- Edit mode: textarea -->
          <div v-if="transcriptEditMode">
            <div class="relative">
              <textarea
                v-model="transcriptEditContent"
                class="w-full h-96 font-mono text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 resize-none outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed"
                placeholder="逐字稿內容（Markdown 格式）..."
              ></textarea>
              <span class="absolute bottom-3 right-4 text-[10px] text-slate-400">可直接編輯</span>
            </div>
            <div class="flex justify-end gap-2 mt-2">
              <button @click="cancelEdit" class="px-4 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                取消
              </button>
              <button
                @click="saveTranscript"
                :disabled="isSavingTranscript"
                class="flex items-center gap-1.5 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-xl font-medium transition-colors shadow-lg shadow-blue-500/20"
              >
                <Loader2 v-if="isSavingTranscript" class="w-3.5 h-3.5 animate-spin" />
                {{ isSavingTranscript ? '儲存中...' : '存檔' }}
              </button>
            </div>
          </div>

          <!-- View mode: formatted lines -->
          <div v-else class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 h-96 overflow-y-auto leading-relaxed">
            <div v-if="transcriptLines.length > 0">
              <div v-for="line in transcriptLines" :key="line.id" class="mb-6">
                <div class="flex items-center gap-3 mb-1">
                  <span class="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded">{{ line.time }}</span>
                  <span class="font-bold text-sm">{{ line.speaker }}</span>
                </div>
                <p class="text-slate-600 dark:text-slate-400 pl-4 border-l-2 border-slate-100 dark:border-slate-800 hover:border-blue-500 transition-colors">{{ line.text }}</p>
              </div>
            </div>
            <div v-else-if="!transcriptError" class="flex items-center justify-center h-full text-slate-400 text-sm">
              尚無逐字稿內容
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 4: Meeting Notes & Email -->
    <div v-if="step === 4" class="space-y-6">
      <!-- Loading -->
      <div v-if="isProcessing" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-12 text-center">
        <div class="relative w-24 h-24 mx-auto mb-6">
          <div class="absolute inset-0 rounded-full border-4 border-blue-100 dark:border-slate-800"></div>
          <div class="absolute inset-0 rounded-full border-4 border-blue-600 border-t-transparent animate-spin"></div>
          <div class="absolute inset-0 flex items-center justify-center">
            <FileText class="w-10 h-10 text-blue-600 animate-pulse" />
          </div>
        </div>
        <h3 class="text-xl font-bold mb-2">AI 正在生成會議記錄...</h3>
        <p class="text-slate-500 text-sm">OpenClaw 正在讀取逐字稿、分類並套用對應格式</p>
        <p class="text-xs text-slate-400 mt-4">進度可在右下角聊天視窗查看</p>
      </div>

      <!-- Ready -->
      <div v-else class="space-y-5">
        <!-- Header -->
        <div class="flex items-center justify-between">
          <h3 class="text-xl font-bold">會議記錄</h3>
          <select
            v-model="meetingNotesType"
            class="text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-1.5 outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option>商務會議</option>
            <option>訪談與使用者研究</option>
            <option>知識學習與演講</option>
            <option>專案評審</option>
          </select>
        </div>

        <!-- Editable notes -->
        <div class="relative">
          <textarea
            v-model="meetingNotesContent"
            class="w-full h-96 font-mono text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 resize-none outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed"
            placeholder="會議記錄將在此顯示，您可以直接編輯..."
          ></textarea>
          <span class="absolute bottom-3 right-4 text-[10px] text-slate-400">可直接編輯</span>
        </div>

        <!-- Email section -->
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4">
          <h4 class="font-bold flex items-center gap-2">
            <Mail class="w-4 h-4 text-slate-400" /> 發送會議記錄
          </h4>
          <div class="flex gap-3">
            <input
              v-model="emailTo"
              type="text"
              placeholder="收件者 Email（多位請用 ; 分隔）"
              class="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              @click="sendMeetingEmail"
              :disabled="emailSending || !emailTo.trim() || !meetingNotesContent"
              :class="emailSending || !emailTo.trim() || !meetingNotesContent
                ? 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20'"
              class="px-5 py-2.5 rounded-xl font-bold text-sm transition-all flex items-center gap-2 whitespace-nowrap"
            >
              <Loader2 v-if="emailSending" class="w-4 h-4 animate-spin" />
              <Send v-else class="w-4 h-4" />
              {{ emailSending ? '發送中...' : '發送' }}
            </button>
          </div>
          <p v-if="emailSent" class="text-green-600 dark:text-green-400 text-sm flex items-center gap-1.5">
            <Check class="w-4 h-4" /> 已成功發送至 {{ emailTo }}
          </p>
          <p v-if="emailError" class="text-red-500 text-sm">{{ emailError }}</p>
        </div>
      </div>
    </div>

    <!-- Step 5: Insights -->
    <div v-if="step === 5" class="space-y-6">
      <!-- Processing -->
      <div v-if="isProcessing" class="flex flex-col items-center justify-center py-20 text-center">
        <div class="relative w-32 h-32 mb-8">
          <div class="absolute inset-0 rounded-full border-4 border-blue-100 dark:border-slate-800"></div>
          <div class="absolute inset-0 rounded-full border-4 border-blue-600 border-t-transparent animate-spin"></div>
          <div class="absolute inset-0 flex items-center justify-center">
            <Sparkles class="w-14 h-14 text-blue-600 animate-pulse" />
          </div>
        </div>
        <h3 class="text-2xl font-bold mb-2">正在生成專案洞見...</h3>
        <p class="text-slate-500 mb-2">OpenClaw 正在分析會議內容、比對現有知識庫並進行增量更新</p>
        <p class="text-xs text-slate-400">進度可在右下角聊天視窗查看</p>
      </div>

      <!-- Done -->
      <div v-else class="space-y-5">
        <!-- Success banner -->
        <div class="p-5 bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-900/30 rounded-2xl flex items-start gap-4">
          <div class="w-10 h-10 bg-green-600 rounded-full flex items-center justify-center shrink-0">
            <Check class="text-white w-5 h-5" />
          </div>
          <div>
            <h4 class="font-bold text-green-900 dark:text-green-100">專案知識庫已更新！</h4>
            <p class="text-sm text-green-700 dark:text-green-300 mt-1">
              本次會議內容已成功整合至專案知識庫，可至專案列表進行檢閱與編輯。
            </p>
          </div>
        </div>

        <!-- Updated projects list -->
        <div v-if="insightsProjects.length > 0" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-100 dark:border-slate-800">
            <h4 class="font-bold flex items-center gap-2">
              <Sparkles class="w-4 h-4 text-blue-500" />
              專案知識庫 ({{ insightsProjects.length }})
              <span v-if="newProjectsCount > 0" class="text-xs font-bold px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full">
                {{ newProjectsCount }} 個新增
              </span>
            </h4>
          </div>
          <div class="divide-y divide-slate-100 dark:divide-slate-800">
            <div v-for="p in insightsProjects" :key="p.id || p.name" class="px-6 py-3.5 flex items-center justify-between">
              <div class="min-w-0 flex items-center gap-2 flex-1">
                <span class="font-medium truncate">{{ p.name }}</span>
                <span v-if="isNewInsightProject(p)" class="shrink-0 text-[10px] font-bold px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded">新增</span>
                <span v-if="p.lastUpdated" class="shrink-0 text-xs text-slate-400">{{ p.lastUpdated }}</span>
              </div>
              <span :class="maturityClass(p.maturity)" class="ml-3 shrink-0 text-xs font-bold px-2.5 py-1 rounded-full">
                {{ p.maturity || '—' }}
              </span>
            </div>
          </div>
        </div>

        <!-- Fallback when no projects.json yet -->
        <div v-else class="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-8 text-center text-slate-400 text-sm">
          尚未偵測到更新的專案。若 OpenClaw 仍在處理，請稍候後重新整理。
        </div>

        <!-- Open Reviewer button (secondary) -->
        <button @click="$emit('navigate', 'reviewerOverview')" class="w-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 font-medium py-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all flex items-center justify-center gap-2">
          開啟專案列表 <ExternalLink class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Step 6: Record Distribution -->
    <div v-if="step === 6" class="space-y-6">
      <!-- Distributing -->
      <div v-if="recordDistributing" class="flex flex-col items-center justify-center py-20 text-center">
        <div class="relative w-32 h-32 mb-8">
          <div class="absolute inset-0 rounded-full border-4 border-blue-100 dark:border-slate-800"></div>
          <div class="absolute inset-0 rounded-full border-4 border-blue-600 border-t-transparent animate-spin"></div>
          <div class="absolute inset-0 flex items-center justify-center">
            <BookCopy class="w-14 h-14 text-blue-600 animate-pulse" />
          </div>
        </div>
        <h3 class="text-2xl font-bold mb-2">AI 正在拆分會議記錄...</h3>
        <p class="text-slate-500 mb-2">OpenClaw 正在依專案主題分析並拆分內容</p>
        <p class="text-xs text-slate-400">進度可在右下角聊天視窗查看</p>
        <div v-if="distributedRecords.length > 0" class="mt-6 text-sm text-blue-600 dark:text-blue-400">
          已完成 {{ distributedRecords.length }} / {{ recordExpectedSlugs.length }} 個專案
        </div>
      </div>

      <!-- Done -->
      <div v-else class="space-y-5">
        <!-- Error -->
        <div v-if="recordError" class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/30 rounded-2xl flex items-start gap-3">
          <AlertCircle class="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p class="font-medium text-red-700 dark:text-red-400 text-sm">分發失敗</p>
            <p class="text-xs text-red-600 dark:text-red-500 mt-0.5">{{ recordError }}</p>
          </div>
        </div>

        <!-- Success banner -->
        <div v-if="distributedRecords.length > 0" class="p-5 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/30 rounded-2xl flex items-start gap-4">
          <div class="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center shrink-0">
            <Check class="text-white w-5 h-5" />
          </div>
          <div>
            <h4 class="font-bold text-blue-900 dark:text-blue-100">會議記錄分發完成！</h4>
            <p class="text-sm text-blue-700 dark:text-blue-300 mt-1">
              已將本次會議記錄寫入 {{ distributedRecords.length }} 個專案資料夾（record-專案名稱/{{ meetingDate }}.md）。
            </p>
          </div>
        </div>

        <!-- Distributed list -->
        <div v-if="distributedRecords.length > 0" class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-100 dark:border-slate-800">
            <h4 class="font-bold flex items-center gap-2">
              <BookCopy class="w-4 h-4 text-blue-500" />
              已建立記錄 ({{ distributedRecords.length }})
            </h4>
          </div>
          <div class="divide-y divide-slate-100 dark:divide-slate-800">
            <div v-for="r in distributedRecords" :key="r.slug" class="px-6 py-3.5 flex items-center justify-between">
              <span class="font-medium">{{ r.slug }}</span>
              <span class="text-xs font-mono text-slate-400">record-{{ r.slug }}/{{ r.date }}.md</span>
            </div>
          </div>
        </div>

        <!-- No projects warning (only show if insights step had no projects AND no pending expected slugs) -->
        <div v-else-if="!recordError && insightsProjects.length === 0 && recordExpectedSlugs.length === 0" class="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30 rounded-2xl p-5 flex items-start gap-3">
          <AlertCircle class="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <p class="text-sm text-amber-700 dark:text-amber-300">
            步驟五未偵測到任何專案，無法分發。請確認洞見生成已正確完成。
          </p>
        </div>

        <!-- Open project list -->
        <button @click="$emit('navigate', 'reviewerOverview')" class="w-full bg-slate-900 dark:bg-white dark:text-slate-900 text-white font-bold py-3 rounded-xl hover:opacity-90 transition-all flex items-center justify-center gap-2">
          開啟專案列表 <ExternalLink class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Footer Actions -->
    <div class="mt-12 flex justify-between">
      <button v-if="step > 1" @click="step === 3 && isProcessing ? showCancelConfirm = true : prevStep()" class="px-6 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors flex items-center gap-2">
        <ArrowLeft class="w-4 h-4" /> 上一步
      </button>
      <div v-else></div>
      <button
        v-if="step < 6"
        @click="nextStep"
        :disabled="(step === 1 && !uploadDone) || (step === 3 && isProcessing) || (step === 4 && isProcessing) || (step === 5 && isProcessing)"
        :class="(step === 1 && !uploadDone) || (step === 3 && isProcessing) || (step === 4 && isProcessing) || (step === 5 && isProcessing)
          ? 'bg-blue-300 dark:bg-blue-900 cursor-not-allowed text-white px-8 py-2.5 rounded-xl font-bold flex items-center gap-2'
          : 'bg-blue-600 text-white px-8 py-2.5 rounded-xl font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/20 flex items-center gap-2'"
      >
        繼續下一步 <ArrowRight class="w-4 h-4" />
      </button>
    </div>
    </div><!-- end main workflow content -->
  </div><!-- end flex container -->
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, reactive, watch } from 'vue'
import { marked } from 'marked'
import {
  Check, UploadCloud, FileText, File, X, Brain, Plus, Sparkles,
  ExternalLink, ArrowLeft, ArrowRight, Loader2, AlertCircle, Mail, Send, Calendar,
  Download, Eye, FolderOpen, BookMarked, Pencil, BookCopy
} from 'lucide-vue-next'

const props = defineProps({ projects: Array, initialTask: Object, team: String })
const emit = defineEmits(['navigate', 'extraction-ready', 'toast'])

// ── Files Panel ───────────────────────────────────────────────────────────────
const previewModal = reactive({ show: false, title: '', content: '', filename: '' })

function renderMarkdown(content) {
  return marked.parse(content || '')
}

function openPreview(title, content, filename) {
  previewModal.title = title
  previewModal.content = content
  previewModal.filename = filename
  previewModal.show = true
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function downloadDoc(remotePath, filename) {
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch(`/api/workflow/download-doc?remotePath=${encodeURIComponent(remotePath)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      alert(`下載失敗：${err.error || res.status}`)
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    alert(`下載失敗：${err.message}`)
  }
}

const successDocs = computed(() => uploadedDocs.value.filter(d => !d.uploading && !d.error && d.remotePath))
const hasAnyFiles = computed(() => successDocs.value.length > 0 || !!transcriptRawContent.value || !!meetingNotesContent.value)

// ─────────────────────────────────────────────────────────────────────────────

const step = ref(1)
const stepLabels = ['檔案上傳', '標語萃取', '逐字轉錄', '會議記錄', '洞見生成', '記錄分發']
const isProcessing = ref(false)
const uploadedDocs = ref([])
const docFileInputRef = ref(null)
const isDragOver = ref(false)
const tags = ref([])
const newTag = ref('')
const extractionError = ref('')
const libraryTerms = ref([])
const extractedTerms = ref([])
const manualTags = ref([])
const isBulkAdding = ref(false)
const checkedLibraryCount = computed(() => libraryTerms.value.filter(t => t.checked).length)
const checkedExtractedCount = computed(() => extractedTerms.value.filter(t => t.checked).length)
const newExtractedCheckedCount = computed(() => extractedTerms.value.filter(t => t.checked && !t.inLibrary).length)
const transcriptError = ref('')

const fileInputRef = ref(null)
const selectedFile = ref(null)
const uploadProgress = ref(0)
const uploadDone = ref(false)
const uploadError = ref('')
const uploadedMediaPath = ref(null)
const uploadedOriginalName = ref(null)
const extractionOutputPath = ref(null)
let extractionPollTimer = null

const transcriptLines = ref([])
const transcriptJobId = ref(null)
const transcriptContainerPath = ref(null)
const transcriptRawContent = ref('')
const transcriptWordCount = ref(0)
let transcriptionPollTimer = null
const showCancelConfirm = ref(false)
const isCancelling = ref(false)

// ── Transcript edit / AI repair ───────────────────────────────────────────────
const transcriptEditMode = ref(false)
const transcriptEditContent = ref('')
const isSavingTranscript = ref(false)
const isRepairing = ref(false)
const repairedContent = ref('')
const repairedLines = ref([])
const showComparison = ref(false)
const repairOutputPath = ref(null)
let repairPollTimer = null
const repairedWordCount = computed(() => countWords(repairedContent.value))

function enterEditMode() {
  transcriptEditContent.value = transcriptRawContent.value
  transcriptEditMode.value = true
}

function cancelEdit() {
  transcriptEditMode.value = false
  transcriptEditContent.value = ''
}

async function saveTranscript() {
  if (!transcriptContainerPath.value) {
    transcriptRawContent.value = transcriptEditContent.value
    transcriptLines.value = parseTranscript(transcriptEditContent.value)
    transcriptWordCount.value = countWords(transcriptEditContent.value)
    transcriptEditMode.value = false
    return
  }
  isSavingTranscript.value = true
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/workflow/save-transcript', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcriptContainerPath: transcriptContainerPath.value, content: transcriptEditContent.value }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '儲存失敗')
    transcriptRawContent.value = transcriptEditContent.value
    transcriptLines.value = parseTranscript(transcriptEditContent.value)
    transcriptWordCount.value = countWords(transcriptEditContent.value)
    transcriptEditMode.value = false
    emit('toast', '逐字稿已儲存')
  } catch (err) {
    emit('toast', err.message || '儲存失敗', 'error')
  } finally {
    isSavingTranscript.value = false
  }
}

async function startRepair() {
  if (!transcriptContainerPath.value) {
    emit('toast', '無法取得逐字稿路徑', 'error')
    return
  }
  if (transcriptEditMode.value) await saveTranscript()
  isRepairing.value = true
  repairedContent.value = ''
  repairedLines.value = []
  showComparison.value = false
  repairOutputPath.value = null
  clearTimeout(repairPollTimer)

  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/workflow/prepare-transcript-repair', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcriptContainerPath: transcriptContainerPath.value }),
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '修復準備失敗')
    repairOutputPath.value = data.repairedOutputContainerPath
    emit('extraction-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startRepairPolling()
  } catch (err) {
    emit('toast', err.message || 'AI 修復失敗', 'error')
    isRepairing.value = false
  }
}

function startRepairPolling() {
  clearTimeout(repairPollTimer)
  const poll = async () => {
    if (!repairOutputPath.value) return
    const token = localStorage.getItem('clawpm_token')
    try {
      const res = await fetch(
        `/api/workflow/transcript-repair-result?outputPath=${encodeURIComponent(repairOutputPath.value)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const data = await res.json()
      if (data.ready && data.content) {
        repairedContent.value = data.content
        repairedLines.value = parseTranscript(data.content)
        isRepairing.value = false
        showComparison.value = true
        return
      }
    } catch {}
    repairPollTimer = setTimeout(poll, 5000)
  }
  repairPollTimer = setTimeout(poll, 5000)
}

function applyRepair() {
  transcriptRawContent.value = repairedContent.value
  transcriptLines.value = repairedLines.value
  transcriptWordCount.value = countWords(repairedContent.value)
  if (transcriptEditMode.value) transcriptEditContent.value = repairedContent.value
  showComparison.value = false
  repairedContent.value = ''
  repairedLines.value = []
  repairOutputPath.value = null
  emit('toast', '已採用 AI 修復版本')
}

function dismissRepair() {
  showComparison.value = false
  repairedContent.value = ''
  repairedLines.value = []
  repairOutputPath.value = null
}
// ─────────────────────────────────────────────────────────────────────────────

const meetingDate = ref(new Date().toISOString().slice(0, 10))

const taskId = ref(null)

watch(meetingDate, (val) => {
  if (taskId.value) syncTask({ meetingDate: val })
})

const meetingNotesOutputPath = ref(null)
const meetingNotesContent = ref('')
const meetingNotesType = ref('商務會議')
const emailTo = ref('')
const emailSending = ref(false)
const emailSent = ref(false)
const emailError = ref('')
let meetingNotesPollTimer = null

const insightsOutputDir = ref(null)
const insightsProjects = ref([])
const insightsBeforeMtime = ref(0)
const existingProjectIds = ref([])
let insightsPollTimer = null

const recordDistributing = ref(false)
const distributedRecords = ref([])
const recordError = ref('')
const recordExpectedSlugs = ref([])
let recordDistPollTimer = null

function openFileDialog() {
  if (uploadProgress.value > 0 && !uploadDone.value && !uploadError.value) return
  uploadDone.value = false
  uploadError.value = ''
  selectedFile.value = null
  uploadProgress.value = 0
  fileInputRef.value?.click()
}

function handleFileChange(event) {
  const file = event.target.files?.[0]
  if (!file) return
  selectedFile.value = file
  event.target.value = ''
  uploadFile(file)
}

function uploadFile(file) {
  uploadProgress.value = 0
  uploadDone.value = false
  uploadError.value = ''

  const token = localStorage.getItem('clawpm_token')
  const formData = new FormData()
  formData.append('file', file)
  formData.append('meetingDate', meetingDate.value)

  const xhr = new XMLHttpRequest()

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      uploadProgress.value = Math.min(99, Math.round(e.loaded / e.total * 100))
    }
  })

  xhr.addEventListener('load', () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const data = JSON.parse(xhr.responseText)
        uploadedMediaPath.value = data.remotePath || null
        uploadedOriginalName.value = data.fileName || selectedFile.value?.name || null
      } catch {}
      uploadProgress.value = 100
      uploadDone.value = true
      createWorkflowTask()
    } else {
      let msg = 'FTP 上傳失敗'
      try { msg = JSON.parse(xhr.responseText).error || msg } catch {}
      uploadError.value = msg
      selectedFile.value = null
    }
  })

  xhr.addEventListener('error', () => {
    uploadError.value = '網路錯誤，請重試'
    selectedFile.value = null
  })

  xhr.open('POST', '/api/workflow/upload-media')
  xhr.setRequestHeader('Authorization', `Bearer ${token}`)
  xhr.send(formData)
}

async function createWorkflowTask() {
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingDate: meetingDate.value,
        audioFileName: selectedFile.value?.name || uploadedOriginalName.value || '',
        data: {
          uploadedMediaPath: uploadedMediaPath.value,
          uploadedOriginalName: uploadedOriginalName.value,
          uploadedDocPaths: uploadedDocs.value.filter(d => d.remotePath).map(d => ({ name: d.name, remotePath: d.remotePath })),
        },
      }),
    })
    const data = await res.json()
    if (res.ok) taskId.value = data.id
  } catch {}
}

async function syncTask(updates) {
  if (!taskId.value) return
  const token = localStorage.getItem('clawpm_token')
  try {
    await fetch(`/api/tasks/${taskId.value}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
  } catch {}
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function prevStep() {
  // Reset shared processing state so going back doesn't show wrong step's spinner
  isProcessing.value = false
  extractionError.value = ''
  transcriptError.value = ''
  step.value--
}

async function cancelTranscription() {
  isCancelling.value = true
  clearTimeout(transcriptionPollTimer)

  const jobId = transcriptJobId.value
  if (jobId) {
    const token = localStorage.getItem('clawpm_token')
    try {
      await fetch(`/api/workflow/transcription/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {}
  }

  transcriptJobId.value = null
  transcriptContainerPath.value = null
  transcriptRawContent.value = ''
  transcriptLines.value = []
  transcriptWordCount.value = 0
  transcriptError.value = ''
  isProcessing.value = false
  isCancelling.value = false
  showCancelConfirm.value = false
  step.value = 2
}

async function nextStep() {
  if (step.value === 1) {
    step.value++
    loadLibraryTerms()
    syncTask({ currentStep: 2, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending' }, data: { uploadedDocPaths: uploadedDocs.value.filter(d => d.remotePath).map(d => ({ name: d.name, remotePath: d.remotePath })) } })
    startExtraction()
    return
  }
  if (step.value === 2) {
    tags.value = buildFinalTags()
    step.value++
    syncTask({ currentStep: 3, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'pending', 4: 'pending', 5: 'pending' }, data: { tags: tags.value, extractionOutputPath: extractionOutputPath.value, extractedTerms: extractedTerms.value.map(({ term, checked, inLibrary }) => ({ term, checked, inLibrary })), manualTags: manualTags.value } })
    startTranscription()
    return
  }
  if (step.value === 3) {
    step.value++
    syncTask({ currentStep: 4, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'done', 4: 'pending', 5: 'pending' }, data: { transcriptJobId: transcriptJobId.value, transcriptContainerPath: transcriptContainerPath.value, transcriptRawContent: transcriptRawContent.value } })
    startMeetingNotes()
    return
  }
  if (step.value === 4) {
    step.value++
    syncTask({ currentStep: 5, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'done', 4: 'done', 5: 'pending', 6: 'pending' }, data: { meetingNotesOutputPath: meetingNotesOutputPath.value, meetingNotesContent: meetingNotesContent.value } })
    startInsights()
    return
  }
  if (step.value === 5) {
    step.value++
    syncTask({ currentStep: 6, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'done', 4: 'done', 5: 'done', 6: 'pending' } })
    startRecordDistribution()
    return
  }
}

async function startExtraction() {
  extractionError.value = ''
  const sourceDoc = uploadedDocs.value.find(d => !d.uploading && !d.error && d.remotePath)
  if (!sourceDoc) {
    extractedTerms.value = []
    isProcessing.value = false
    return
  }
  isProcessing.value = true

  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/workflow/prepare-extraction', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: sourceDoc.remotePath, originalName: sourceDoc.name }),
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '準備萃取失敗')

    extractionOutputPath.value = data.outputPath
    syncTask({ data: { extractionOutputPath: data.outputPath } })
    emit('extraction-ready', { sessionKey: data.sessionKey, prompt: data.prompt })
    startExtractionPolling()
  } catch (err) {
    console.error('[extraction] prepare error:', err.message)
    extractionError.value = err.message
    isProcessing.value = false
  }
}

async function startTranscription() {
  transcriptError.value = ''
  if (!uploadedMediaPath.value) {
    transcriptError.value = '未取得音訊檔案路徑，請返回步驟 1 重新上傳'
    isProcessing.value = false
    return
  }
  // Don't re-submit if already have a job ID (e.g. user went back and came forward)
  if (transcriptJobId.value) {
    startTranscriptionPolling()
    return
  }
  isProcessing.value = true

  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/workflow/prepare-transcription', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaPath: uploadedMediaPath.value, tags: tags.value, team: props.team || undefined, taskId: taskId.value || undefined }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.success) throw new Error(data.error || '無法啟動轉錄，請確認 WhisperX 服務是否正常運作')

    transcriptJobId.value = data.jobId
    transcriptContainerPath.value = data.transcriptOutputPath
    syncTask({ data: { transcriptJobId: data.jobId, transcriptContainerPath: data.transcriptOutputPath } })
    startTranscriptionPolling()
  } catch (err) {
    console.error('[transcription] prepare error:', err.message)
    transcriptError.value = err.message
    isProcessing.value = false
  }
}

function startTranscriptionPolling() {
  clearTimeout(transcriptionPollTimer)
  const poll = async () => {
    if (!transcriptJobId.value) return
    const token = localStorage.getItem('clawpm_token')
    try {
      const outputPathParam = transcriptContainerPath.value
        ? `&outputPath=${encodeURIComponent(transcriptContainerPath.value)}`
        : ''
      const res = await fetch(
        `/api/workflow/transcription-result?jobId=${encodeURIComponent(transcriptJobId.value)}${outputPathParam}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        transcriptError.value = err.error || `轉錄伺服器回傳錯誤 (HTTP ${res.status})`
        isProcessing.value = false
        return
      }
      const data = await res.json()
      if (data.ready && data.content) {
        transcriptRawContent.value = data.content
        transcriptLines.value = parseTranscript(data.content)
        transcriptWordCount.value = countWords(data.content)
        isProcessing.value = false
        syncTask({ currentStep: 3, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'done', 4: 'pending', 5: 'pending' }, data: { transcriptRawContent: data.content, transcriptJobId: transcriptJobId.value, transcriptContainerPath: transcriptContainerPath.value } })
        return
      }
    } catch {}
    transcriptionPollTimer = setTimeout(poll, 15000)
  }
  poll()
}

async function startMeetingNotes() {
  if (!transcriptContainerPath.value) {
    isProcessing.value = false
    return
  }
  isProcessing.value = true

  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/workflow/prepare-meeting-notes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcriptContainerPath: transcriptContainerPath.value,
        meetingDate: meetingDate.value,
        docFtpPaths: successDocs.value.map(d => d.remotePath),
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '準備會議記錄失敗')

    meetingNotesOutputPath.value = data.notesOutputContainerPath
    emit('extraction-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startMeetingNotesPolling()
  } catch (err) {
    console.error('[meeting-notes] prepare error:', err.message)
    isProcessing.value = false
  }
}

function startMeetingNotesPolling() {
  clearTimeout(meetingNotesPollTimer)
  const poll = async () => {
    if (!meetingNotesOutputPath.value) return
    const token = localStorage.getItem('clawpm_token')
    try {
      const res = await fetch(
        `/api/workflow/meeting-notes-result?outputPath=${encodeURIComponent(meetingNotesOutputPath.value)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const data = await res.json()
      if (data.ready && data.content) {
        meetingNotesContent.value = data.content
        isProcessing.value = false
        syncTask({ currentStep: 4, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'done', 4: 'done', 5: 'pending' }, data: { meetingNotesOutputPath: meetingNotesOutputPath.value, meetingNotesContent: data.content } })
        return
      }
    } catch {}
    meetingNotesPollTimer = setTimeout(poll, 10000)
  }
  meetingNotesPollTimer = setTimeout(poll, 10000)
}

function styleEmailHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  doc.querySelectorAll('table').forEach(table => {
    table.style.cssText = 'border-collapse:collapse;width:100%;font-size:14px;margin:12px 0;'
  })
  doc.querySelectorAll('th').forEach(th => {
    th.style.cssText = 'background-color:#1e40af;color:#ffffff;padding:8px 12px;border:1px solid #1e3a8a;text-align:left;font-weight:600;'
  })
  doc.querySelectorAll('td').forEach(td => {
    td.style.cssText = 'padding:8px 12px;border:1px solid #cbd5e1;'
  })
  doc.querySelectorAll('tbody tr:nth-child(even)').forEach(tr => {
    tr.style.backgroundColor = '#f8fafc'
  })

  return doc.body.innerHTML
}

async function sendMeetingEmail() {
  emailSending.value = true
  emailSent.value = false
  emailError.value = ''

  const token = localStorage.getItem('clawpm_token')
  const recipients = emailTo.value.split(/[,;]/).map(e => e.trim()).filter(Boolean)

  try {
    const res = await fetch('/api/workflow/send-meeting-email', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients,
        subject: `會議記錄 — ${meetingNotesType.value}`,
        content: styleEmailHtml(marked.parse(meetingNotesContent.value)),
        transcriptContent: transcriptRawContent.value,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '發送失敗')
    emailSent.value = true
  } catch (err) {
    emailError.value = err.message
  } finally {
    emailSending.value = false
  }
}

function parseTranscript(markdown) {
  const lines = []
  let id = 0
  // Match WhisperX format: **[HH:MM:SS → HH:MM:SS] Speaker N:**\ntext
  const blocks = markdown.split(/\n(?=\*\*\[)/)
  for (const block of blocks) {
    const match = block.match(/^\*\*\[([^\]]+)\]\s+([^:*]+):\*\*\s*\n?([\s\S]+)/)
    if (match) {
      const time = match[1].trim()
      const speaker = match[2].trim()
      const text = match[3].replace(/\n+/g, ' ').trim()
      if (text) lines.push({ id: id++, time, speaker, text })
    }
  }
  return lines
}

function countWords(content) {
  const chinese = (content.match(/[一-龥]/g) || []).length
  const english = (content.match(/\b[a-zA-Z]+\b/g) || []).length
  return chinese + english
}

function startExtractionPolling() {
  clearTimeout(extractionPollTimer)
  const poll = async () => {
    if (!extractionOutputPath.value) return
    const token = localStorage.getItem('clawpm_token')
    try {
      const res = await fetch(
        `/api/workflow/extraction-tags?outputPath=${encodeURIComponent(extractionOutputPath.value)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const data = await res.json()
      if (data.ready) {
        const libTermSet = new Set(libraryTerms.value.map(t => t.term))
        extractedTerms.value = (data.tags || []).map(term => ({ term, checked: true, inLibrary: libTermSet.has(term) }))
        tags.value = data.tags || []
        isProcessing.value = false
        syncTask({ currentStep: 2, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'pending', 4: 'pending', 5: 'pending' }, data: { tags: data.tags || [], extractedTerms: extractedTerms.value.map(({ term, checked, inLibrary }) => ({ term, checked, inLibrary })), extractionOutputPath: extractionOutputPath.value } })
        return
      }
    } catch {}
    extractionPollTimer = setTimeout(poll, 3000)
  }
  extractionPollTimer = setTimeout(poll, 3000)
}

function addTag() {
  const term = newTag.value.trim()
  if (!term) return
  const exists = libraryTerms.value.some(t => t.term === term) ||
                 extractedTerms.value.some(t => t.term === term) ||
                 manualTags.value.includes(term)
  if (!exists) manualTags.value.push(term)
  newTag.value = ''
}

async function loadLibraryTerms() {
  try {
    const res = await fetch('/api/terminology', {
      headers: { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
    })
    if (!res.ok) return
    const data = await res.json()
    const termSet = new Set(data.map(t => t.term))
    libraryTerms.value = data.map(t => ({ ...t, checked: true }))
    extractedTerms.value = extractedTerms.value.map(t => ({ ...t, inLibrary: termSet.has(t.term) }))
  } catch {}
}

function buildFinalTags() {
  const lib = libraryTerms.value.filter(t => t.checked).map(t => t.term)
  const ext = extractedTerms.value.filter(t => t.checked).map(t => t.term)
  return [...new Set([...lib, ...ext, ...manualTags.value])]
}

async function addCheckedToLibrary() {
  const toAdd = extractedTerms.value.filter(t => t.checked && !t.inLibrary).map(t => t.term)
  if (toAdd.length === 0) return
  isBulkAdding.value = true
  try {
    const res = await fetch('/api/terminology/bulk-add', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ terms: toAdd })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      emit('toast', data.error || '加入辭庫失敗，請稍後再試', 'error')
      return
    }
    await loadLibraryTerms()
    emit('toast', `已成功加入 ${data.added ?? toAdd.length} 個術語至辭庫`)
  } catch (err) {
    emit('toast', '加入辭庫失敗，請確認伺服器狀態', 'error')
  } finally {
    isBulkAdding.value = false
  }
}

function openDocDialog() {
  docFileInputRef.value?.click()
}

function handleDocFileChange(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  files.forEach(uploadDoc)
}

function handleDocDrop(event) {
  isDragOver.value = false
  const allowed = ['.pdf', '.docx', '.txt', '.csv', '.xls', '.xlsx', '.pptx']
  const files = Array.from(event.dataTransfer.files)
    .filter(f => allowed.some(ext => f.name.toLowerCase().endsWith(ext)))
  files.forEach(uploadDoc)
}

async function uploadDoc(file) {
  const sizeStr = formatFileSize(file.size)
  const idx = uploadedDocs.value.push({ name: file.name, size: sizeStr, uploading: true, error: null }) - 1

  const token = localStorage.getItem('clawpm_token')
  const formData = new FormData()
  formData.append('file', file)

  try {
    const res = await fetch('/api/workflow/upload-doc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '上傳失敗')
    uploadedDocs.value[idx] = { name: file.name, size: sizeStr, uploading: false, error: null, remotePath: data.remotePath }
  } catch (err) {
    uploadedDocs.value[idx] = { name: file.name, size: sizeStr, uploading: false, error: err.message, remotePath: null }
  }
}

async function startInsights() {
  isProcessing.value = true

  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/workflow/prepare-insights', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcriptContainerPath: transcriptContainerPath.value || undefined,
        notesContainerPath: meetingNotesOutputPath.value || undefined,
        meetingDate: meetingDate.value,
        taskId: taskId.value || undefined,
        docFtpPaths: successDocs.value.map(d => d.remotePath),
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '準備洞見失敗')

    insightsOutputDir.value = data.insightsContainerDir
    insightsBeforeMtime.value = data.beforeMtime || 0
    existingProjectIds.value = data.existingProjectIds || []
    emit('extraction-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startInsightsPolling()
  } catch (err) {
    console.error('[insights] prepare error:', err.message)
    isProcessing.value = false
  }
}

function startInsightsPolling() {
  clearTimeout(insightsPollTimer)
  const poll = async () => {
    if (!insightsOutputDir.value) return
    const token = localStorage.getItem('clawpm_token')
    try {
      const res = await fetch(
        `/api/workflow/insights-result?insightsDir=${encodeURIComponent(insightsOutputDir.value)}&beforeMtime=${insightsBeforeMtime.value}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const data = await res.json()
      if (data.ready) {
        insightsProjects.value = data.projects || []
        isProcessing.value = false
        syncTask({ currentStep: 5, status: 'running', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'done', 4: 'done', 5: 'done', 6: 'pending' }, data: { insightsProjects: data.projects || [] } })
        return
      }
    } catch {}
    insightsPollTimer = setTimeout(poll, 10000)
  }
  insightsPollTimer = setTimeout(poll, 10000)
}

async function startRecordDistribution() {
  recordDistributing.value = true
  recordError.value = ''
  distributedRecords.value = []
  recordExpectedSlugs.value = []
  clearTimeout(recordDistPollTimer)

  let projects = insightsProjects.value
    .map(p => ({ slug: p.slug || p.id, name: p.name || p.title || p.slug || p.id }))
    .filter(p => p.slug)

  if (projects.length === 0) {
    try {
      const token = localStorage.getItem('clawpm_token')
      const res = await fetch('/api/project-insights/list', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (res.ok && Array.isArray(data.projects) && data.projects.length > 0) {
        insightsProjects.value = data.projects
        projects = data.projects
          .map(p => ({ slug: p.slug || p.id, name: p.name || p.title || p.slug || p.id }))
          .filter(p => p.slug)
      }
    } catch {}
  }

  if (projects.length === 0) {
    recordDistributing.value = false
    recordError.value = '步驟五未回傳任何專案，且無法從知識庫讀取現有專案，無法分發。'
    return
  }

  if (!meetingNotesOutputPath.value) {
    recordDistributing.value = false
    recordError.value = '找不到會議記錄容器路徑，請確認步驟四已完成。'
    return
  }

  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/meeting-record/prepare-distribution', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingDate: meetingDate.value,
        notesContainerPath: meetingNotesOutputPath.value,
        projects,
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.success) throw new Error(data.error || '準備分發失敗')

    recordExpectedSlugs.value = (data.expectedPaths || []).map(e => e.slug)
    syncTask({ data: { recordExpectedSlugs: recordExpectedSlugs.value } })
    emit('extraction-ready', { sessionKey: data.sessionKey, prompt: data.prompt, newSession: true })
    startRecordDistPoll()
  } catch (err) {
    recordError.value = err.message
    recordDistributing.value = false
  }
}

function startRecordDistPoll() {
  clearTimeout(recordDistPollTimer)
  const slugs = recordExpectedSlugs.value
  if (slugs.length === 0) {
    recordDistributing.value = false
    return
  }

  let lastCompleted = -1
  let staleCount = 0

  const finish = (completed) => {
    distributedRecords.value = (completed || []).map(s => ({ slug: s, date: meetingDate.value }))
    recordDistributing.value = false
    syncTask({ currentStep: 6, status: 'completed', autoAdvanceAt: null, stepStatuses: { 1: 'done', 2: 'done', 3: 'done', 4: 'done', 5: 'done', 6: 'done' }, data: { distributedRecords: distributedRecords.value } })
  }

  const poll = async () => {
    const token = localStorage.getItem('clawpm_token')
    try {
      const res = await fetch(
        `/api/meeting-record/distribution-result?meetingDate=${encodeURIComponent(meetingDate.value)}&slugs=${encodeURIComponent(slugs.join(','))}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const data = await res.json()

      // All expected files written — fully complete
      if (data.ready) {
        finish(data.completed)
        return
      }

      const completedCount = data.completed?.length ?? 0

      // Update live progress
      if (completedCount > 0) {
        distributedRecords.value = (data.completed || []).map(s => ({ slug: s, date: meetingDate.value }))
      }

      // Stale detection: if completed count hasn't changed for 2 consecutive polls,
      // AI has finished (only wrote relevant projects, skipped others)
      if (lastCompleted !== -1 && completedCount === lastCompleted) {
        staleCount++
        if (staleCount >= 2) {
          finish(data.completed)
          return
        }
      } else {
        staleCount = 0
        lastCompleted = completedCount
      }
    } catch {}
    recordDistPollTimer = setTimeout(poll, 8000)
  }
  recordDistPollTimer = setTimeout(poll, 8000)
}

function isNewInsightProject(p) {
  const id = p.id || p.slug || p.name
  return id && !existingProjectIds.value.includes(id)
}

const newProjectsCount = computed(() => insightsProjects.value.filter(isNewInsightProject).length)

function maturityClass(maturity) {
  if (!maturity) return 'bg-slate-100 dark:bg-slate-800 text-slate-500'
  const m = String(maturity).toLowerCase()
  if (m.includes('not ready')) return 'bg-slate-100 dark:bg-slate-800 text-slate-500'
  if (m.includes('internal')) return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
  if (m.includes('soft')) return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
  if (m.includes('public')) return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
  return 'bg-slate-100 dark:bg-slate-800 text-slate-500'
}

function restoreFromTask(task) {
  taskId.value = task.id
  meetingDate.value = task.meetingDate || meetingDate.value

  // Step 1 state
  uploadDone.value = true
  uploadedMediaPath.value = task.data.uploadedMediaPath || null
  uploadedOriginalName.value = task.data.uploadedOriginalName || null
  if (task.data.uploadedOriginalName) {
    selectedFile.value = { name: task.data.uploadedOriginalName, size: 0 }
  }
  uploadedDocs.value = (task.data.uploadedDocPaths || []).map(d => ({
    name: d.name, size: '', uploading: false, error: null, remotePath: d.remotePath,
  }))

  // Step 2 state
  tags.value = task.data.tags || []
  extractionOutputPath.value = task.data.extractionOutputPath || null
  extractedTerms.value = (task.data.extractedTerms || [])
  manualTags.value = task.data.manualTags || []
  loadLibraryTerms()

  // Step 3 state
  transcriptJobId.value = task.data.transcriptJobId || null
  transcriptContainerPath.value = task.data.transcriptContainerPath || null
  transcriptRawContent.value = task.data.transcriptRawContent || ''
  if (task.data.transcriptRawContent) {
    transcriptLines.value = parseTranscript(task.data.transcriptRawContent)
    transcriptWordCount.value = countWords(task.data.transcriptRawContent)
  }

  // Step 4 state
  meetingNotesOutputPath.value = task.data.meetingNotesOutputPath || null
  meetingNotesContent.value = task.data.meetingNotesContent || ''
  meetingNotesType.value = task.data.meetingNotesType || '商務會議'

  // Step 5 state
  insightsOutputDir.value = task.data.insightsOutputDir || null
  insightsBeforeMtime.value = task.data.insightsBeforeMtime || 0
  existingProjectIds.value = task.data.existingProjectIds || []
  insightsProjects.value = task.data.insightsProjects || []

  // Step 6 state
  distributedRecords.value = (task.data.distributedRecords || [])
  recordExpectedSlugs.value = (task.data.recordExpectedSlugs || [])

  // Set current step
  step.value = task.currentStep || 1

  // Resume polling only when data is available; isProcessing follows whether polling started.
  // If we set isProcessing=true without starting a matching poll the spinner never clears.
  if (task.status === 'running') {
    if (task.currentStep === 2 && task.data.extractionOutputPath) {
      isProcessing.value = true
      startExtractionPolling()
    } else if (task.currentStep === 3 && task.data.transcriptJobId) {
      isProcessing.value = true
      startTranscriptionPolling()
    } else if (task.currentStep === 3) {
      // Job ID not saved (navigated away before it was recorded) — prompt to retry
      transcriptError.value = '轉錄任務記錄遺失，請點擊「重試」重新送出'
    } else if (task.currentStep === 4 && task.data.meetingNotesOutputPath) {
      isProcessing.value = true
      startMeetingNotesPolling()
    } else if (task.currentStep === 5 && task.data.insightsOutputDir) {
      isProcessing.value = true
      startInsightsPolling()
    } else if (task.currentStep === 6 && task.data.recordExpectedSlugs?.length > 0) {
      // Resume distribution polling — AI may still be writing files
      recordDistributing.value = true
      startRecordDistPoll()
    }
    // else: insufficient data to resume — leave isProcessing false so UI isn't stuck
  }
}

onMounted(async () => {
  const token = localStorage.getItem('clawpm_token')
  if (!token) return
  try {
    const res = await fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.notificationEmails) emailTo.value = data.notificationEmails
  } catch {}

  if (props.initialTask) {
    restoreFromTask(props.initialTask)
  }
})

onUnmounted(() => {
  clearTimeout(extractionPollTimer)
  clearTimeout(transcriptionPollTimer)
  clearTimeout(meetingNotesPollTimer)
  clearTimeout(insightsPollTimer)
  clearTimeout(repairPollTimer)
  clearTimeout(recordDistPollTimer)
})

async function removeDoc(idx) {
  const file = uploadedDocs.value[idx]
  if (file.uploading) return
  uploadedDocs.value.splice(idx, 1)
  if (!file.remotePath) return

  const token = localStorage.getItem('clawpm_token')
  try {
    await fetch('/api/workflow/delete-doc', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ remotePath: file.remotePath }),
    })
  } catch {}
}
</script>

<style scoped>
.md-preview :deep(h1),
.md-preview :deep(h2),
.md-preview :deep(h3),
.md-preview :deep(h4) {
  font-weight: 700;
  margin-top: 1.25em;
  margin-bottom: 0.5em;
  line-height: 1.3;
}
.md-preview :deep(h1) { font-size: 1.25rem; }
.md-preview :deep(h2) { font-size: 1.1rem; }
.md-preview :deep(h3) { font-size: 1rem; }
.md-preview :deep(p) { margin-bottom: 0.75em; }
.md-preview :deep(ul),
.md-preview :deep(ol) { padding-left: 1.5em; margin-bottom: 0.75em; }
.md-preview :deep(li) { margin-bottom: 0.25em; }
.md-preview :deep(ul) { list-style-type: disc; }
.md-preview :deep(ol) { list-style-type: decimal; }
.md-preview :deep(strong) { font-weight: 700; }
.md-preview :deep(em) { font-style: italic; }
.md-preview :deep(code) {
  background: rgba(100,116,139,0.15);
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
}
.md-preview :deep(pre) {
  background: rgba(100,116,139,0.1);
  padding: 0.75em 1em;
  border-radius: 8px;
  overflow-x: auto;
  margin-bottom: 0.75em;
}
.md-preview :deep(pre code) { background: none; padding: 0; }
.md-preview :deep(blockquote) {
  border-left: 3px solid #94a3b8;
  padding-left: 1em;
  color: #64748b;
  margin-bottom: 0.75em;
}
.md-preview :deep(hr) { border-color: #e2e8f0; margin: 1em 0; }
.md-preview :deep(table) { width: 100%; border-collapse: collapse; margin-bottom: 0.75em; font-size: 0.875em; }
.md-preview :deep(th) { background: #1e40af; color: #fff; padding: 6px 10px; text-align: left; }
.md-preview :deep(td) { padding: 6px 10px; border: 1px solid #cbd5e1; }
.md-preview :deep(tr:nth-child(even) td) { background: #f8fafc; }
</style>
