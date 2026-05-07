<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0"
    leave-active-class="transition duration-150 ease-in"
    leave-to-class="opacity-0"
  >
    <div v-if="show" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div class="bg-white dark:bg-slate-900 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-800">
        <div class="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
          <h3 class="text-xl font-bold text-slate-900 dark:text-white">建立新專案</h3>
          <button @click="$emit('close')" class="text-slate-400 hover:text-slate-600"><X class="w-6 h-6" /></button>
        </div>
        <div class="p-6 space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">專案名稱 <span class="text-red-500">*</span></label>
            <input type="text" v-model="name" placeholder="例如：Q2 行銷專案" class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">專案描述</label>
            <textarea rows="3" v-model="desc" placeholder="簡述此專案的目標..." class="w-full bg-slate-50 dark:bg-slate-800 px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none"></textarea>
          </div>
        </div>
        <div class="p-6 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-3">
          <button @click="$emit('close')" class="px-6 py-2 rounded-xl text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700">取消</button>
          <button @click="create" class="bg-blue-600 text-white px-8 py-2 rounded-xl font-bold hover:bg-blue-700 transition-colors">建立專案</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref } from 'vue'
import { X } from 'lucide-vue-next'

defineProps({ show: Boolean })
const emit = defineEmits(['close', 'create'])

const name = ref('')
const desc = ref('')

function create() {
  if (!name.value.trim()) return
  emit('create', { name: name.value, desc: desc.value })
  name.value = ''
  desc.value = ''
}
</script>
