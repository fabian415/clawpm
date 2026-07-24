<template>
  <div class="max-w-6xl mx-auto space-y-6 pb-20">
    <div class="flex justify-between items-center gap-4">
      <div>
        <h2 class="text-2xl font-bold">技能管理</h2>
        <p class="text-sm text-slate-400 mt-1">系統範本技能唯讀且會隨更新自動保持最新；自訂技能可自由編輯、複製與刪除。</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="visibleSkills.length > 0"
          @click="showRunModal = true; runPresetSlug = ''"
          class="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-4 py-2.5 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
        >
          <Play class="w-4 h-4" /> 執行技能
        </button>
        <div v-if="isAdmin" class="relative">
          <button @click="showAddMenu = !showAddMenu" class="bg-blue-600 text-white px-4 py-2.5 rounded-xl font-bold flex items-center gap-2 hover:bg-blue-700 transition-colors">
            <Plus class="w-4 h-4" /> 新增技能
          </button>
          <div v-if="showAddMenu" v-click-outside="() => showAddMenu = false" class="absolute right-0 mt-2 w-48 bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-800 overflow-hidden z-10">
            <button @click="showAddMenu = false; showEditor = true; editingSlug = ''; editingContent = ''" class="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2">
              <FileText class="w-4 h-4 text-slate-400" /> 空白建立
            </button>
            <button @click="showAddMenu = false; showWizard = true" class="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2">
              <Sparkles class="w-4 h-4 text-blue-500" /> 用 AI 產生
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="isLoading" class="flex items-center justify-center py-20 text-slate-400">
      <Loader2 class="w-6 h-6 animate-spin" />
    </div>

    <div v-else-if="visibleSkills.length === 0" class="text-center py-20 text-slate-400">
      尚無技能
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div
        v-for="s in visibleSkills" :key="s.slug"
        class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 flex flex-col gap-3"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="font-bold truncate">{{ s.name }}</h3>
              <span
                :class="s.protected ? 'bg-slate-100 dark:bg-slate-800 text-slate-500' : 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-300'"
                class="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0"
              >
                {{ s.protected ? '系統範本' : '自訂' }}
              </span>
            </div>
            <p class="text-xs text-slate-400 font-mono mt-0.5">{{ s.slug }}</p>
          </div>
          <ShieldCheck v-if="s.protected" class="w-4 h-4 text-slate-300 shrink-0" />
        </div>

        <p class="text-sm text-slate-500 dark:text-slate-400 line-clamp-3 flex-1">{{ s.description || '（無說明）' }}</p>

        <div class="flex flex-wrap gap-2 pt-1">
          <button @click="runPresetSlug = s.slug; showRunModal = true" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center gap-1.5">
            <Play class="w-3.5 h-3.5" /> 執行
          </button>
          <template v-if="isAdmin">
            <button v-if="!s.protected" @click="openEditor(s.slug)" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center gap-1.5">
              <Pencil class="w-3.5 h-3.5" /> 編輯
            </button>
            <button @click="cloneSourceSlug = s.slug; showCloneModal = true" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center gap-1.5">
              <Copy class="w-3.5 h-3.5" /> 複製
            </button>
            <button v-if="!s.protected" @click="deleteTarget = s" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 flex items-center gap-1.5">
              <Trash2 class="w-3.5 h-3.5" /> 刪除
            </button>
          </template>
        </div>
      </div>
    </div>

    <SkillEditorModal
      :show="showEditor"
      :slug="editingSlug"
      :initial-content="editingContent"
      @close="showEditor = false"
      @saved="handleSaved"
    />

    <CloneSkillModal
      :show="showCloneModal"
      :source-slug="cloneSourceSlug"
      @close="showCloneModal = false"
      @cloned="handleSaved"
    />

    <GenerateSkillWizard
      :show="showWizard"
      @close="showWizard = false"
      @skill-ready="payload => $emit('skill-ready', payload)"
      @saved="handleWizardSaved"
    />

    <RunSkillModal
      :show="showRunModal"
      :skills="visibleSkills"
      :preset-skill-slug="runPresetSlug"
      @close="showRunModal = false"
      @skill-ready="payload => $emit('skill-ready', payload)"
      @open-report="payload => $emit('open-report', payload)"
    />

    <!-- Delete confirm -->
    <Transition
      enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0"
      leave-active-class="transition duration-150 ease-in" leave-to-class="opacity-0"
    >
      <div v-if="deleteTarget" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
        <div class="bg-white dark:bg-slate-900 w-full max-w-sm rounded-2xl shadow-2xl p-6 space-y-4">
          <h3 class="text-lg font-bold">刪除技能？</h3>
          <p class="text-sm text-slate-500">確定要刪除「{{ deleteTarget.name }}」（{{ deleteTarget.slug }}）嗎？此操作無法復原。</p>
          <div class="flex gap-3 pt-1">
            <button @click="deleteTarget = null" class="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 font-bold hover:bg-slate-50 dark:hover:bg-slate-800">取消</button>
            <button @click="confirmDelete" :disabled="isDeleting" class="flex-1 bg-red-600 text-white py-2.5 rounded-xl font-bold hover:bg-red-700 disabled:opacity-50">
              {{ isDeleting ? '刪除中...' : '確認刪除' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { Plus, Play, Pencil, Copy, Trash2, Sparkles, FileText, Loader2, ShieldCheck } from 'lucide-vue-next'
import SkillEditorModal from '../components/SkillEditorModal.vue'
import CloneSkillModal from '../components/CloneSkillModal.vue'
import GenerateSkillWizard from '../components/GenerateSkillWizard.vue'
import RunSkillModal from '../components/RunSkillModal.vue'

defineProps({ isAdmin: { type: Boolean, default: false } })
defineEmits(['skill-ready', 'open-report'])

const vClickOutside = {
  mounted(el, binding) {
    el.__clickOutside__ = (e) => { if (!el.contains(e.target)) binding.value(e) }
    document.addEventListener('click', el.__clickOutside__, true)
  },
  unmounted(el) {
    document.removeEventListener('click', el.__clickOutside__, true)
  },
}

const HIDDEN_SKILL_SLUGS = new Set([
  'meeting-proper-noun-extractor',
  'meeting-transcription',
  'presentation-generator',
  'project-insight-synthesizer',
  'skill-creator',
])

const skills = ref([])
const visibleSkills = computed(() => skills.value.filter(s => !HIDDEN_SKILL_SLUGS.has(s.slug)))
const isLoading = ref(false)
const showAddMenu = ref(false)

const showEditor = ref(false)
const editingSlug = ref('')
const editingContent = ref('')

const showCloneModal = ref(false)
const cloneSourceSlug = ref('')

const showWizard = ref(false)

const showRunModal = ref(false)
const runPresetSlug = ref('')

const deleteTarget = ref(null)
const isDeleting = ref(false)

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
}

async function fetchSkills() {
  isLoading.value = true
  try {
    const res = await fetch('/api/skills', { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    skills.value = data.skills || []
  } catch (err) {
    console.error('[skills] fetch error:', err.message)
  } finally {
    isLoading.value = false
  }
}

async function openEditor(slug) {
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(slug)}`, { headers: authHeaders() })
    if (!res.ok) return
    const data = await res.json()
    editingSlug.value = slug
    editingContent.value = data.content
    showEditor.value = true
  } catch (err) {
    console.error('[skills] read error:', err.message)
  }
}

function handleSaved() {
  showEditor.value = false
  showCloneModal.value = false
  fetchSkills()
}

function handleWizardSaved() {
  showWizard.value = false
  fetchSkills()
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  isDeleting.value = true
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(deleteTarget.value.slug)}`, { method: 'DELETE', headers: authHeaders() })
    if (res.ok) {
      deleteTarget.value = null
      await fetchSkills()
    }
  } catch (err) {
    console.error('[skills] delete error:', err.message)
  } finally {
    isDeleting.value = false
  }
}

onMounted(fetchSkills)
</script>
