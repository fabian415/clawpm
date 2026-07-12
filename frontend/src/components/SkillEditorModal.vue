<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div v-if="show" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-3xl h-[85vh] rounded-2xl shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-800 flex flex-col">
        <div class="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center shrink-0">
          <div>
            <h3 class="text-xl font-bold text-slate-900 dark:text-white">{{ isCreate ? '新增技能' : `編輯技能：${slug}` }}</h3>
            <p class="text-xs text-slate-400 mt-1">直接編輯 SKILL.md 原始內容，需包含 <code>---</code> frontmatter 區塊與 name / description 欄位</p>
          </div>
          <button @click="$emit('close')" class="text-slate-400 hover:text-slate-600"><X class="w-6 h-6" /></button>
        </div>

        <div v-if="isCreate" class="px-6 pt-4 shrink-0">
          <label class="block text-sm font-medium mb-1">技能識別碼（slug） <span class="text-red-500">*</span></label>
          <input
            type="text" v-model="newSlug" placeholder="例如：customer-persona-writer"
            class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm"
          />
          <p class="text-xs text-slate-400 mt-1">僅限小寫英數字與連字號，將作為技能資料夾名稱，建立後無法更改</p>
        </div>

        <div v-if="error" class="mx-6 mt-4 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 text-sm px-4 py-2 rounded-xl shrink-0">
          {{ error }}
        </div>

        <div class="px-6 pt-4 shrink-0">
          <div class="flex items-center gap-2 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded-xl px-3 py-2">
            <Sparkles class="w-4 h-4 text-amber-500 shrink-0" />
            <input
              v-model="reviseInstruction" type="text" :disabled="isRevising"
              placeholder="用一句話描述想怎麼修改，例如：加強 Step 3 的驗證邏輯"
              class="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400 disabled:opacity-60"
            />
            <button
              @click="requestRevision"
              :disabled="!reviseInstruction.trim() || isRevising"
              class="shrink-0 text-xs font-bold bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
            >
              <Loader2 v-if="isRevising" class="w-3.5 h-3.5 animate-spin" />
              AI 修正
            </button>
          </div>
        </div>

        <div class="flex-1 p-6 min-h-0">
          <textarea
            v-model="content"
            spellcheck="false"
            class="w-full h-full bg-[#1e1e1e] text-slate-200 p-4 font-mono text-sm rounded-xl resize-none outline-none leading-relaxed overflow-y-auto"
            placeholder="---&#10;name: my-skill&#10;description: ...&#10;---&#10;&#10;# My Skill&#10;..."
          ></textarea>
        </div>

        <div class="p-6 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-3 shrink-0">
          <button @click="$emit('close')" class="px-6 py-2 rounded-xl text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700">取消</button>
          <button
            @click="save"
            :disabled="isSaving"
            :class="isSaving ? 'opacity-60 cursor-not-allowed' : 'hover:bg-blue-700'"
            class="bg-blue-600 text-white px-8 py-2 rounded-xl font-bold transition-colors flex items-center gap-2"
          >
            <Loader2 v-if="isSaving" class="w-4 h-4 animate-spin" />
            儲存
          </button>
        </div>
      </div>
    </div>
  </Transition>

  <!-- AI revision diff review modal -->
  <div v-if="diffOpen" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
    <div class="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col" style="max-height: 92vh;">
      <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div class="flex items-center gap-3">
          <h4 class="font-bold flex items-center gap-2">
            <Eye class="w-4 h-4 text-blue-500" /> AI 修正結果預覽
          </h4>
          <span v-if="diffChangedCount > 0" class="text-xs font-medium px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full">
            {{ diffChangedCount }} 處變更
          </span>
          <span v-else class="text-xs font-medium px-2 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-500 rounded-full">無差異</span>
        </div>
        <button @click="closeDiff" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
          <X class="w-5 h-5" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 space-y-4 min-h-0">
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-red-400 shrink-0"></span>
              <span class="text-xs font-semibold text-slate-600 dark:text-slate-400">修改前</span>
              <span class="text-[10px] text-slate-400">（紅底 = 被刪除/修改的字詞）</span>
            </div>
            <div ref="diffLeftPanel" @scroll="syncScrollLeft" class="border border-slate-200 dark:border-slate-700 rounded-xl overflow-y-auto h-64 font-mono text-[11px] leading-5 bg-slate-50 dark:bg-slate-800/40">
              <div
                v-for="(line, idx) in diffLines" :key="'orig-' + idx"
                :class="line.type === 'delete' || line.type === 'changed'
                  ? 'bg-red-50 dark:bg-red-900/20'
                  : line.type === 'insert'
                    ? 'bg-slate-100/60 dark:bg-slate-700/20'
                    : 'text-slate-500 dark:text-slate-400'"
                class="px-3 py-px flex gap-2 whitespace-pre-wrap"
              >
                <span class="shrink-0 select-none w-3 text-center opacity-60">{{ line.type === 'delete' || line.type === 'changed' ? '-' : ' ' }}</span>
                <span class="flex-1" v-html="line.type !== 'insert' ? (line.leftHtml ?? '&nbsp;') : '&nbsp;'"></span>
              </div>
            </div>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0"></span>
              <span class="text-xs font-semibold text-emerald-600 dark:text-emerald-400">修改後</span>
              <span class="text-[10px] text-slate-400">（綠底 = 新增/修改後的字詞）</span>
            </div>
            <div ref="diffRightPanel" @scroll="syncScrollRight" class="border border-emerald-200 dark:border-emerald-900/50 rounded-xl overflow-y-auto h-64 font-mono text-[11px] leading-5 bg-emerald-50/40 dark:bg-emerald-900/10">
              <div
                v-for="(line, idx) in diffLines" :key="'corr-' + idx"
                :class="line.type === 'insert' || line.type === 'changed'
                  ? 'bg-emerald-50 dark:bg-emerald-900/20'
                  : line.type === 'delete'
                    ? 'bg-slate-100/60 dark:bg-slate-700/20'
                    : 'text-slate-500 dark:text-slate-400'"
                class="px-3 py-px flex gap-2 whitespace-pre-wrap"
              >
                <span class="shrink-0 select-none w-3 text-center opacity-60">{{ line.type === 'insert' || line.type === 'changed' ? '+' : ' ' }}</span>
                <span class="flex-1" v-html="line.type !== 'delete' ? (line.rightHtml ?? '&nbsp;') : '&nbsp;'"></span>
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-1.5">
          <p class="text-xs font-semibold text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
            <Pencil class="w-3 h-3" /> 可在此直接增減內容，確認後才會套用到 SKILL.md（仍需按「儲存」才會真正落地）
          </p>
          <textarea
            ref="diffEditPanel"
            v-model="correctedEditing"
            rows="10"
            @scroll="syncScrollEdit"
            class="w-full font-mono text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4 resize-none outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed"
          ></textarea>
        </div>
      </div>

      <div class="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
        <p class="text-xs text-slate-400">確認後會套用到編輯器內容，仍需再按一次「儲存」才會真正寫入技能</p>
        <div class="flex items-center gap-3">
          <button @click="closeDiff" class="px-5 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
            取消
          </button>
          <button @click="applyDiff" class="flex items-center gap-2 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold transition-colors shadow-lg shadow-blue-500/20">
            <Check class="w-4 h-4" /> 確認套用修改
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { X, Loader2, Sparkles, Eye, Pencil, Check } from 'lucide-vue-next'

const BLANK_TEMPLATE = `---
name: my-new-skill
description: 描述這個技能做什麼、什麼情境下應該被使用（請包含使用者可能會說的觸發語句）。
---

# My New Skill

## Overview
簡述這個技能的目的。

## Workflow

### Step 1: ...
...

## 輸出格式
...

## 回報給使用者
...
`

const props = defineProps({
  show: Boolean,
  slug: { type: String, default: '' },
  initialContent: { type: String, default: '' },
})
const emit = defineEmits(['close', 'saved'])

const isCreate = computed(() => !props.slug)
const newSlug = ref('')
const content = ref('')
const isSaving = ref(false)
const error = ref('')

// ── AI revision ───────────────────────────────────────────────────────────────
const reviseInstruction = ref('')
const isRevising = ref(false)
const diffOpen = ref(false)
const originalSnapshot = ref('')
const correctedEditing = ref('')

watch(() => props.show, (show) => {
  if (!show) return
  error.value = ''
  isSaving.value = false
  newSlug.value = ''
  content.value = props.initialContent || (isCreate.value ? BLANK_TEMPLATE : '')
  reviseInstruction.value = ''
  isRevising.value = false
  diffOpen.value = false
  originalSnapshot.value = ''
  correctedEditing.value = ''
})

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function save() {
  const slugToUse = isCreate.value ? newSlug.value.trim() : props.slug
  if (isCreate.value && !/^[a-z0-9][a-z0-9-]{0,49}$/.test(slugToUse)) {
    error.value = '技能識別碼僅限小寫英數字與連字號'
    return
  }
  if (!content.value.trim()) {
    error.value = 'SKILL.md 內容不可為空'
    return
  }

  isSaving.value = true
  error.value = ''
  try {
    const url = isCreate.value ? '/api/skills' : `/api/skills/${encodeURIComponent(slugToUse)}`
    const res = await fetch(url, {
      method: isCreate.value ? 'POST' : 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(isCreate.value ? { slug: slugToUse, content: content.value } : { content: content.value }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '儲存失敗')
    emit('saved', { slug: slugToUse })
  } catch (err) {
    error.value = err.message
  } finally {
    isSaving.value = false
  }
}

async function requestRevision() {
  if (!reviseInstruction.value.trim() || isRevising.value) return
  isRevising.value = true
  error.value = ''
  try {
    const res = await fetch('/api/skills/revise', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.value, instruction: reviseInstruction.value.trim() }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'AI 修正失敗')

    originalSnapshot.value = content.value
    correctedEditing.value = data.content
    diffOpen.value = true
  } catch (err) {
    error.value = err.message
  } finally {
    isRevising.value = false
  }
}

function applyDiff() {
  content.value = correctedEditing.value
  closeDiff()
}

function closeDiff() {
  diffOpen.value = false
  originalSnapshot.value = ''
  correctedEditing.value = ''
}

// ── Diff helpers (line + word level LCS diff) ──────────────────────────────────
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function tokenizeForDiff(text) {
  return text.match(/[一-龥　-〿！-￮]|[a-zA-Z0-9À-ɏ]+|[ \t]+|[^\s\w一-龥　-〿！-￮]/g) || [text || '']
}

function buildInlineHtml(a, b) {
  const at = tokenizeForDiff(a)
  const bt = tokenizeForDiff(b)
  const m = at.length, n = bt.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const eq = at[i - 1] === bt[j - 1]
      dp[i][j] = eq ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const ops = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && at[i - 1] === bt[j - 1])
    { ops.unshift({ t: '=', a: at[i - 1], b: bt[j - 1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { ops.unshift({ t: '+', b: bt[j - 1] }); j-- }
    else { ops.unshift({ t: '-', a: at[i - 1] }); i-- }
  }
  let L = '', R = ''
  for (const op of ops) {
    if (op.t === '=') { const e = escapeHtml(op.b); L += e; R += e }
    else if (op.t === '-') L += `<mark style="background:#fee2e2;color:#991b1b;border-radius:2px;padding:0 1px;">${escapeHtml(op.a)}</mark>`
    else R += `<mark style="background:#d1fae5;color:#065f46;border-radius:2px;padding:0 1px;">${escapeHtml(op.b)}</mark>`
  }
  return { leftHtml: L, rightHtml: R }
}

function computeLineDiff(a, b) {
  const aLines = (a || '').split('\n')
  const bLines = (b || '').split('\n')
  const m = aLines.length, n = bLines.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = aLines[i - 1] === bLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const raw = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      raw.unshift({ type: 'equal', aText: aLines[i - 1], bText: aLines[i - 1] }); i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.unshift({ type: 'insert', bText: bLines[j - 1] }); j--
    } else {
      raw.unshift({ type: 'delete', aText: aLines[i - 1] }); i--
    }
  }

  const result = []
  let k = 0
  while (k < raw.length) {
    if (raw[k].type === 'equal') {
      const html = escapeHtml(raw[k].aText)
      result.push({ type: 'equal', leftHtml: html, rightHtml: html })
      k++
    } else {
      const dels = [], ins = []
      while (k < raw.length && raw[k].type !== 'equal') {
        if (raw[k].type === 'delete') dels.push(raw[k].aText)
        else ins.push(raw[k].bText)
        k++
      }
      const maxLen = Math.max(dels.length, ins.length)
      for (let p = 0; p < maxLen; p++) {
        const d = p < dels.length ? dels[p] : null
        const s = p < ins.length ? ins[p] : null
        if (d !== null && s !== null) {
          const { leftHtml, rightHtml } = buildInlineHtml(d, s)
          const hasChanges = leftHtml.includes('<mark') || rightHtml.includes('<mark')
          result.push(hasChanges
            ? { type: 'changed', leftHtml, rightHtml }
            : { type: 'equal', leftHtml: escapeHtml(d), rightHtml: escapeHtml(s) })
        } else if (d !== null) {
          result.push({ type: 'delete', leftHtml: escapeHtml(d), rightHtml: null })
        } else {
          result.push({ type: 'insert', leftHtml: null, rightHtml: escapeHtml(s) })
        }
      }
    }
  }
  return result
}

const diffLines = computed(() => {
  if (!diffOpen.value) return []
  return computeLineDiff(originalSnapshot.value, correctedEditing.value)
})

const diffChangedCount = computed(() => diffLines.value.filter(l => l.type !== 'equal').length)

// Sync scroll across all three diff/edit panels by scroll ratio
const diffLeftPanel = ref(null)
const diffRightPanel = ref(null)
const diffEditPanel = ref(null)
let _syncingScroll = false
function _applyRatio(el, ratio) {
  if (!el) return
  const max = el.scrollHeight - el.clientHeight
  if (max > 0) el.scrollTop = ratio * max
}
function _syncAll(source) {
  if (_syncingScroll) return
  _syncingScroll = true
  const max = source.scrollHeight - source.clientHeight
  const ratio = max > 0 ? source.scrollTop / max : 0
  if (source !== diffLeftPanel.value) _applyRatio(diffLeftPanel.value, ratio)
  if (source !== diffRightPanel.value) _applyRatio(diffRightPanel.value, ratio)
  if (source !== diffEditPanel.value) _applyRatio(diffEditPanel.value, ratio)
  _syncingScroll = false
}
function syncScrollLeft(e) { _syncAll(e.target) }
function syncScrollRight(e) { _syncAll(e.target) }
function syncScrollEdit(e) { _syncAll(e.target) }
</script>
