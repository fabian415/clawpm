<template>
  <div class="max-w-4xl mx-auto space-y-8 pb-20">
    <div class="flex justify-between items-center gap-4">
      <h2 class="text-2xl font-bold">系統設定</h2>
      <div v-if="isAdmin" class="flex items-center gap-2">
        <button @click="$emit('restart')" class="bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400 px-4 py-2 rounded-lg font-bold flex items-center gap-2 hover:bg-amber-100 dark:hover:bg-amber-900 transition-all">
          <RotateCw class="w-4 h-4" /> 重啟 Container
        </button>
        <button @click="$emit('destroy')" class="bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400 px-4 py-2 rounded-lg font-bold flex items-center gap-2 hover:bg-red-100 dark:hover:bg-red-900 transition-all">
          <Trash2 class="w-4 h-4" /> 刪除設定
        </button>
      </div>
    </div>

    <!-- Container Info -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><Server class="w-5 h-5 text-emerald-500" /> OpenClaw 系統資訊</h3>
      </div>
      <div class="p-8 space-y-5">
        <div v-if="!containerConfig" class="text-sm text-slate-400 italic">尚未建立系統設定，請先完成初始化。</div>
        <template v-else>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">Workspace 路徑</label>
            <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm break-all">
              <FolderOpen class="w-4 h-4 text-slate-400 shrink-0" />
              <span>{{ containerConfig.workspacePath || '--' }}</span>
            </div>
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">Gateway 設定路徑</label>
            <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm break-all">
              <FolderOpen class="w-4 h-4 text-slate-400 shrink-0" />
              <span>{{ containerConfig.gatewayWorkspacePath || containerConfig.gatewayConfigPath || '--' }}</span>
            </div>
          </div>
          <div class="space-y-2">
            <label class="text-sm font-medium text-slate-500">Gateway Token</label>
            <div class="relative">
              <div class="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm pr-12 break-all">
                <KeyRound class="w-4 h-4 text-slate-400 shrink-0" />
                <span>{{ showToken ? (containerConfig.gatewayToken || '--') : maskToken(containerConfig.gatewayToken) }}</span>
              </div>
              <button @click="showToken = !showToken" class="absolute right-3 top-3 text-slate-400 hover:text-slate-600" type="button" aria-label="切換 Gateway Token 顯示">
                <EyeOff v-if="showToken" class="w-4 h-4" />
                <Eye v-else class="w-4 h-4" />
              </button>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Gateway Port</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ containerConfig.gatewayPort || '--' }}
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-medium text-slate-400 uppercase tracking-wide">Bridge Port</label>
              <div class="bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 font-mono text-sm">
                {{ containerConfig.bridgePort || '--' }}
              </div>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- AI Keys -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <div class="flex items-center justify-between gap-4">
          <h3 class="font-bold flex items-center gap-2"><KeyRound class="w-5 h-5 text-blue-500" /> AI 服務金鑰</h3>
          <span v-if="providerLabel" class="text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300">
            {{ providerLabel }}
          </span>
        </div>
      </div>
      <div class="p-8 space-y-5">
        <div v-if="isLoadingUserSettings" class="text-sm text-slate-400 italic">正在讀取 AI 服務設定...</div>
        <div v-else-if="settingsError" class="text-sm text-red-500">{{ settingsError }}</div>
        <div v-else-if="!llmProvider" class="text-sm text-slate-400 italic">尚未選擇 LLM Provider。</div>

        <template v-else-if="llmProvider === 'gemini'">
          <SecretField
            label="GEMINI API KEY"
            :value="llmConfig.apiKey"
            :visible="showKeys"
            @toggle="showKeys = !showKeys"
          />
        </template>

        <template v-else-if="llmProvider === 'custom'">
          <ReadOnlyField label="BASE URL" :value="llmConfig.baseUrl" />
          <SecretField
            label="API Key"
            :value="llmConfig.apiKey"
            :visible="showKeys"
            @toggle="showKeys = !showKeys"
          />
          <ReadOnlyField label="模型名稱" :value="llmConfig.model" mono />
        </template>
      </div>
    </section>

    <!-- Transcription Settings -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><AudioWaveform class="w-5 h-5 text-purple-500" /> 轉錄設定</h3>
      </div>
      <div class="p-8 space-y-6">
        <div class="space-y-2">
          <label class="text-sm font-medium">Whisper 模型選擇</label>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div
              v-for="m in whisperModels" :key="m.name"
              @click="selectedModel = m.name"
              :class="selectedModel === m.name ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-slate-200 dark:border-slate-800 hover:border-slate-300'"
              class="p-4 rounded-xl border-2 cursor-pointer transition-colors"
            >
              <div class="font-bold mb-1">{{ m.name }}</div>
              <div class="text-[10px] text-slate-500 uppercase">{{ m.desc }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Notification Settings -->
    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><Mail class="w-5 h-5 text-orange-500" /> 通知設定</h3>
      </div>
      <div class="p-8">
        <div class="space-y-2">
          <label class="text-sm font-medium">Email 收件人</label>
          <input
            v-model="notificationEmails"
            type="text"
            placeholder="jason.su@example.com; alice@example.com"
            class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 focus:ring-blue-500"
          />
          <p class="text-xs text-slate-400">多位收件人請用 <code class="bg-slate-100 dark:bg-slate-800 px-1 rounded">;</code> 分隔，會議記錄發送時將自動帶入</p>
        </div>
      </div>
    </section>

    <div class="flex justify-end pt-4">
      <button @click="handleSave" :disabled="isSaving" class="bg-blue-600 text-white px-10 py-3 rounded-xl font-bold hover:bg-blue-700 shadow-xl shadow-blue-500/20 transition-all disabled:opacity-60">
        {{ isSaving ? '儲存中...' : '儲存設定' }}
      </button>
    </div>

    <!-- Account Management (admin only) -->
    <section v-if="isAdmin" id="account-management-section" class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <h3 class="font-bold flex items-center gap-2"><Users class="w-5 h-5 text-indigo-500" /> 帳號管理</h3>
        <button
          @click="showAddMemberModal = true"
          class="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg font-medium transition-colors"
        >
          + 新增成員
        </button>
      </div>
      <div class="p-6">
        <div v-if="isMembersLoading" class="text-sm text-slate-400 italic">載入中...</div>
        <div v-else-if="membersError" class="text-sm text-red-500">{{ membersError }}</div>
        <div v-else-if="members.length === 0" class="text-sm text-slate-400 italic">尚無成員</div>
        <div v-else class="divide-y divide-slate-100 dark:divide-slate-800">
          <div v-for="m in members" :key="m.id" class="flex items-center gap-4 py-3">
            <div class="flex-1 min-w-0">
              <div class="font-medium truncate">{{ m.name }}</div>
              <div class="text-xs text-slate-500 truncate">{{ m.email }}</div>
            </div>
            <span
              class="text-xs font-semibold px-2.5 py-1 rounded-full"
              :class="m.role === 'admin' ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'"
            >
              {{ m.role === 'admin' ? 'Admin' : 'User' }}
            </span>
            <button
              v-if="!(m.id === currentUserId && m.role === 'admin')"
              @click="toggleRole(m)"
              :disabled="roleUpdatingId === m.id"
              class="text-xs px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
            >
              {{ m.role === 'admin' ? '降為 User' : '升為 Admin' }}
            </button>
            <button
              v-if="m.id !== currentUserId"
              @click="removeMember(m)"
              :disabled="deletingId === m.id"
              class="text-xs px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50"
            >
              刪除
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Add Member Modal -->
    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" leave-active-class="transition duration-150 ease-in" leave-to-class="opacity-0">
      <div v-if="showAddMemberModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl shadow-2xl p-8">
          <h3 class="text-lg font-bold mb-5">新增成員</h3>
          <div v-if="addMemberError" class="mb-4 px-4 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 text-sm">{{ addMemberError }}</div>
          <form @submit.prevent="submitAddMember" class="space-y-4">
            <div>
              <label class="block text-sm font-medium mb-1">姓名</label>
              <input v-model="newMember.name" type="text" placeholder="王小明" class="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 dark:bg-slate-800 outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">Email</label>
              <input v-model="newMember.email" type="email" required placeholder="member@example.com" class="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 dark:bg-slate-800 outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label class="block text-sm font-medium mb-1">初始密碼</label>
              <input v-model="newMember.password" type="password" required placeholder="••••••••" class="w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 dark:bg-slate-800 outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div class="flex gap-3 pt-2">
              <button type="button" @click="showAddMemberModal = false" class="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 font-medium hover:bg-slate-50 dark:hover:bg-slate-800">取消</button>
              <button type="submit" :disabled="isAddingMember" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl font-medium disabled:opacity-50">
                {{ isAddingMember ? '新增中...' : '新增' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, onMounted, ref } from 'vue'
import { RotateCw, Trash2, KeyRound, Eye, EyeOff, AudioWaveform, Mail, Server, FolderOpen, Users } from 'lucide-vue-next'

const props = defineProps({
  containerConfig: { type: Object, default: null },
  isAdmin: { type: Boolean, default: false }
})
const emit = defineEmits(['restart', 'destroy', 'save'])

const showKeys = ref(false)
const showToken = ref(false)
const selectedModel = ref('large-v3')
const userSettings = ref(null)
const isLoadingUserSettings = ref(false)
const settingsError = ref('')
const notificationEmails = ref('')
const isSaving = ref(false)

const whisperModels = [
  { name: 'large-v3', desc: '高準確度' },
  { name: 'medium', desc: '平衡速度' },
  { name: 'small', desc: '快速處理' }
]

const llmConfig = computed(() => userSettings.value?.team?.setupConfig ?? userSettings.value?.setupConfig ?? {})
const llmProvider = computed(() => llmConfig.value.provider ?? '')
const providerLabel = computed(() => {
  if (llmProvider.value === 'gemini') return 'Google Gemini'
  if (llmProvider.value === 'custom') return 'Custom Provider'
  return ''
})

const fieldBaseClass = 'w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl outline-none ring-1 ring-slate-200 dark:ring-slate-700 text-sm break-all'

const ReadOnlyField = defineComponent({
  name: 'ReadOnlyField',
  props: {
    label: { type: String, required: true },
    value: { type: String, default: '' },
    mono: { type: Boolean, default: false }
  },
  setup(props) {
    return () => h('div', { class: 'space-y-2' }, [
      h('label', { class: 'text-sm font-medium' }, props.label),
      h('div', { class: [fieldBaseClass, props.mono ? 'font-mono' : ''] }, props.value || '--')
    ])
  }
})

const SecretField = defineComponent({
  name: 'SecretField',
  props: {
    label: { type: String, required: true },
    value: { type: String, default: '' },
    visible: { type: Boolean, default: false }
  },
  emits: ['toggle'],
  setup(props, { emit }) {
    return () => h('div', { class: 'space-y-2' }, [
      h('label', { class: 'text-sm font-medium' }, props.label),
      h('div', { class: 'relative' }, [
        h('div', { class: `${fieldBaseClass} pr-12 font-mono` }, props.visible ? (props.value || '--') : maskSecret(props.value)),
        h('button', {
          class: 'absolute right-3 top-3 text-slate-400 hover:text-slate-600',
          type: 'button',
          'aria-label': '切換金鑰顯示',
          onClick: () => emit('toggle')
        }, [
          h(props.visible ? EyeOff : Eye, { class: 'w-4 h-4' })
        ])
      ])
    ])
  }
})

function maskSecret(value) {
  if (!value) return '--'
  if (value.length <= 10) return '*'.repeat(value.length)
  return `${value.slice(0, 6)}${'*'.repeat(12)}${value.slice(-4)}`
}

function maskToken(token) {
  if (!token) return '--'
  return `${token.slice(0, 8)}${'*'.repeat(16)}${token.slice(-4)}`
}

async function fetchUserSettings() {
  const token = localStorage.getItem('clawpm_token')
  if (!token) return

  isLoadingUserSettings.value = true
  settingsError.value = ''
  try {
    const res = await fetch('/api/user/me', {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '讀取 AI 服務設定失敗')
    userSettings.value = data
  } catch (err) {
    settingsError.value = err.message || '讀取 AI 服務設定失敗'
  } finally {
    isLoadingUserSettings.value = false
  }
}

async function fetchAppSettings() {
  const token = localStorage.getItem('clawpm_token')
  if (!token) return
  try {
    const res = await fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.notificationEmails) notificationEmails.value = data.notificationEmails
  } catch {}
}

async function handleSave() {
  isSaving.value = true
  const token = localStorage.getItem('clawpm_token')
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationEmails: notificationEmails.value })
    })
  } catch {}
  isSaving.value = false
  emit('save')
}

// ── Member management ─────────────────────────────────────────────────────────

const currentUserId = computed(() => {
  try { return JSON.parse(localStorage.getItem('clawpm_user') ?? 'null')?.userId ?? null } catch { return null }
})

const members = ref([])
const isMembersLoading = ref(false)
const membersError = ref('')
const roleUpdatingId = ref(null)
const deletingId = ref(null)
const showAddMemberModal = ref(false)
const isAddingMember = ref(false)
const addMemberError = ref('')
const newMember = ref({ name: '', email: '', password: '' })

async function fetchMembers() {
  if (!props.isAdmin) return
  isMembersLoading.value = true
  membersError.value = ''
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/team/members', { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '讀取成員列表失敗')
    members.value = data
  } catch (err) {
    membersError.value = err.message
  } finally {
    isMembersLoading.value = false
  }
}

async function toggleRole(member) {
  const newRole = member.role === 'admin' ? 'user' : 'admin'
  roleUpdatingId.value = member.id
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch(`/api/team/members/${member.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: newRole })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '更新角色失敗')
    member.role = newRole
  } catch (err) {
    membersError.value = err.message
  } finally {
    roleUpdatingId.value = null
  }
}

async function removeMember(member) {
  if (!confirm(`確定要刪除 ${member.name || member.email}？`)) return
  deletingId.value = member.id
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch(`/api/team/members/${member.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '刪除失敗')
    members.value = members.value.filter(m => m.id !== member.id)
  } catch (err) {
    membersError.value = err.message
  } finally {
    deletingId.value = null
  }
}

async function submitAddMember() {
  addMemberError.value = ''
  isAddingMember.value = true
  const token = localStorage.getItem('clawpm_token')
  try {
    const res = await fetch('/api/team/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(newMember.value)
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '新增失敗')
    members.value.push(data)
    showAddMemberModal.value = false
    newMember.value = { name: '', email: '', password: '' }
  } catch (err) {
    addMemberError.value = err.message
  } finally {
    isAddingMember.value = false
  }
}

onMounted(() => {
  fetchUserSettings()
  fetchAppSettings()
  fetchMembers()
})
</script>
