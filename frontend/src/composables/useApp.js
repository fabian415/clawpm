import { ref, computed } from 'vue'

export function useApp() {
  const currentPage = ref('login')
  const sidebarCollapsed = ref(false)
  const isDark = ref(false)
  const password = ref('')
  const isConfiguring = ref(false)
  const configProgress = ref(0)

  const workflowStep = ref(1)
  const workflowStepLabels = ['檔案上傳', '標語萃取', '逐字轉錄', '洞見生成']
  const isProcessing = ref(false)
  const uploadProgress = ref(0)
  const uploadedDocs = ref([{ name: '需求規格書.pdf', size: '2.4MB' }])
  const tags = ref(['ClawPM', 'Vue 3', 'Tailwind', 'AI 專案管理', 'GPU 加速', '前端架構'])
  const newTag = ref('')

  const reviewerMode = ref('split')
  const showKeys = ref(false)
  const isNewUser = ref(false)
  const showRestartConfirm = ref(false)
  const isRestarting = ref(false)
  const restartProgress = ref(0)
  const showNewProjectModal = ref(false)
  const toast = ref({ show: false, message: '', icon: 'CheckCircle' })
  const containerStatus = ref('Running')
  const editingProjectInfo = ref(false)

  const projects = ref([
    { id: 1, name: 'OpenClaw 前端 UI 設計', desc: '負責設計全新的 AI 輔助專案管理平台介面。', created: '2024-05-01', updated: '2小時前', meetings: 3 },
    { id: 2, name: '後端模型串接 API', desc: '整合 Gemini 與 Azure OpenAI 服務之相關後端開發。', created: '2024-04-15', updated: '昨日 14:30', meetings: 5 },
    { id: 3, name: '市場競品分析報告', desc: '針對市場上主流專案管理軟體進行深度調研。', created: '2024-03-20', updated: '3日前', meetings: 2 }
  ])

  const recentProjects = computed(() => projects.value.slice(0, 5))
  const selectedProject = ref(projects.value[0])

  const mockMeetings = ref([
    { id: 101, title: '介面初稿審查會議', date: '2024-05-04', duration: '45 min', step: 4, expanded: false, summaryPreview: '會議討論了左側 Sidebar 的樹狀結構與頂部 Topbar 的麵包屑導覽，確認將採用中性深色系底色。' },
    { id: 102, title: '技術選型研討', date: '2024-05-02', duration: '1.2 hr', step: 3, expanded: false, summaryPreview: '確認使用 Vue 3 + Tailwind CSS，並強調所有非同步操作需提供進度條反饋。' },
    { id: 103, title: '需求訪談：專案經理', date: '2024-04-28', duration: '30 min', step: 1, expanded: false, summaryPreview: '檔案上傳需支援 500MB 以上大檔案。' }
  ])

  const mockTranscript = [
    { id: 1, time: '00:00', speaker: 'Jason', text: '大家好，今天我們要討論 ClawPM 的前端介面設計。' },
    { id: 2, time: '00:15', speaker: 'Alice', text: '我覺得側邊欄應該支援折疊，這樣使用者在小螢幕上比較好操作。' },
    { id: 3, time: '00:32', speaker: 'Jason', text: '沒錯，我們還要加上容器狀態指示燈，讓用戶知道後端 AI 是否運行中。' },
    { id: 4, time: '00:50', speaker: 'Bob', text: '關於 Markdown Reviewer，我希望能有雙欄即時預覽功能。' }
  ]

  const containerStatusColor = computed(() => {
    if (containerStatus.value === 'Running') return 'bg-green-500'
    if (containerStatus.value === 'Stopped') return 'bg-red-500'
    return 'bg-yellow-500'
  })

  const containerStatusTextColor = computed(() => {
    if (containerStatus.value === 'Running') return 'text-green-500'
    if (containerStatus.value === 'Stopped') return 'text-red-500'
    return 'text-yellow-500'
  })

  const breadcrumb = computed(() => {
    const map = {
      dashboard: '總覽儀表板',
      projects: '所有專案',
      projectDetail: selectedProject.value?.name ?? '',
      workflow: '會議處理流程',
      reviewer: 'Markdown Reviewer',
      settings: '系統設定'
    }
    return map[currentPage.value] ?? ''
  })

  const passwordStrength = computed(() => {
    if (!password.value) return 0
    let s = 0
    if (password.value.length > 6) s += 40
    if (/[A-Z]/.test(password.value)) s += 30
    if (/[0-9]/.test(password.value)) s += 30
    return s
  })

  const passwordStrengthText = computed(() => {
    if (passwordStrength.value < 40) return '弱'
    if (passwordStrength.value < 80) return '中等'
    return '強'
  })

  const passwordStrengthClass = computed(() => {
    if (passwordStrength.value < 40) return 'bg-red-500'
    if (passwordStrength.value < 80) return 'bg-yellow-500'
    return 'bg-green-500'
  })

  function showToast(msg, icon = 'CheckCircle') {
    toast.value = { show: true, message: msg, icon }
    setTimeout(() => { toast.value.show = false }, 3000)
  }

  function toggleTheme() {
    isDark.value = !isDark.value
    document.documentElement.classList.toggle('dark', isDark.value)
  }

  function selectProject(p) {
    selectedProject.value = p
    currentPage.value = 'projectDetail'
  }

  function handleAuth(mode) {
    if (mode === 'register') {
      isConfiguring.value = true
      const interval = setInterval(() => {
        configProgress.value += 5
        if (configProgress.value >= 100) {
          clearInterval(interval)
          setTimeout(() => {
            isConfiguring.value = false
            isNewUser.value = true
            currentPage.value = 'dashboard'
          }, 500)
        }
      }, 100)
    } else {
      currentPage.value = 'dashboard'
    }
  }

  function completeSetup() {
    isNewUser.value = false
    containerStatus.value = 'Running'
    showToast('容器設定完成，歡迎使用 ClawPM！', 'Server')
  }

  function simulateUpload() {
    uploadProgress.value = 0
    const interval = setInterval(() => {
      uploadProgress.value += 10
      if (uploadProgress.value >= 100) clearInterval(interval)
    }, 200)
  }

  function nextWorkflowStep() {
    isProcessing.value = true
    setTimeout(() => {
      isProcessing.value = false
      workflowStep.value++
    }, 2000)
  }

  function addTag() {
    if (newTag.value.trim()) {
      tags.value.push(newTag.value.trim())
      newTag.value = ''
    }
  }

  function saveSettings() {
    showToast('設定已更新，重啟 container 以套用')
  }

  function handleRestart() {
    isRestarting.value = true
    restartProgress.value = 0
    containerStatus.value = 'Provisioning'
    const interval = setInterval(() => {
      restartProgress.value += 4
      if (restartProgress.value >= 100) {
        clearInterval(interval)
        setTimeout(() => {
          isRestarting.value = false
          showRestartConfirm.value = false
          containerStatus.value = 'Running'
          showToast('容器重啟成功！', 'Server')
        }, 500)
      }
    }, 100)
  }

  return {
    currentPage, sidebarCollapsed, isDark, password, isConfiguring, configProgress,
    workflowStep, workflowStepLabels, isProcessing, uploadProgress, uploadedDocs,
    tags, newTag, reviewerMode, showKeys, showRestartConfirm, isRestarting,
    restartProgress, showNewProjectModal, toast, containerStatus, editingProjectInfo,
    isNewUser, projects, recentProjects, selectedProject, mockMeetings, mockTranscript,
    containerStatusColor, containerStatusTextColor, breadcrumb,
    passwordStrength, passwordStrengthText, passwordStrengthClass,
    toggleTheme, selectProject, handleAuth, simulateUpload, nextWorkflowStep,
    addTag, saveSettings, handleRestart, showToast, completeSetup
  }
}
