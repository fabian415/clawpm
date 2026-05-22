<template>
  <div class="max-w-4xl mx-auto space-y-8 pb-20">
    <div class="flex justify-between items-center gap-4">
      <h2 class="text-2xl font-bold">帳號管理</h2>
      <button
        @click="showAddMemberModal = true"
        class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-colors"
      >
        <UserPlus class="w-4 h-4" /> 新增成員
      </button>
    </div>

    <section class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
      <div class="p-6 border-b border-slate-100 dark:border-slate-800">
        <h3 class="font-bold flex items-center gap-2"><Users class="w-5 h-5 text-indigo-500" /> 成員列表</h3>
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
import { computed, onMounted, ref } from 'vue'
import { Users, UserPlus } from 'lucide-vue-next'

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

onMounted(fetchMembers)
</script>
