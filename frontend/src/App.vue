<template>
  <!-- Auth Pages -->
  <div v-if="currentPage === 'login' || currentPage === 'register'" class="min-h-screen bg-slate-50 dark:bg-slate-950 transition-colors duration-300">
    <LoginView
      :is-configuring="isConfiguring"
      :config-progress="configProgress"
      :auth-error="authError"
      :is-loading="isAuthLoading"
      @auth="handleAuth"
    />
  </div>

  <!-- Main App Layout -->
  <div v-else class="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950 transition-colors duration-300">
    <AppSidebar
      v-model:collapsed="sidebarCollapsed"
      :current-page="currentPage"
      :container-status="containerStatus"
      :container-status-color="containerStatusColor"
      :container-status-text-color="containerStatusTextColor"
      :is-dark="isDark"
      :is-admin="isAdmin"
      @navigate="page => { if (page === 'workflow') selectedTask = null; currentPage = page }"
      @open-reviewer-project="openReviewerProject"
      @toggle-theme="toggleTheme"
    />

    <main class="flex-1 flex flex-col min-w-0 bg-white dark:bg-slate-950 transition-colors">
      <AppTopbar :breadcrumb="breadcrumb" :current-user="currentUser" @navigate="currentPage = $event" @logout="logout" />

      <div class="flex-1 overflow-y-auto p-8">
        <SetupWizard
          v-if="currentPage === 'dashboard' && isNewUser && isAdmin"
          :is-dark="isDark"
          @complete="completeSetup"
        />
        <div
          v-else-if="currentPage === 'dashboard' && isNewUser && !isAdmin"
          class="flex flex-col items-center justify-center h-64 text-center gap-4"
        >
          <div class="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <svg class="w-8 h-8 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <h2 class="text-lg font-bold">等待 Admin 完成系統設定</h2>
          <p class="text-slate-500 text-sm">請聯繫您的 Admin 完成容器初始化後再使用。</p>
        </div>
        <DashboardView
          v-else-if="currentPage === 'dashboard'"
          :container-status="containerStatus"
          :container-status-color="containerStatusColor"
          :current-user="currentUser"
          :container-stats="containerStats"
          :is-admin="isAdmin"
          @navigate="handleNavigate"
          @open-reviewer-project="openReviewerProject"
        />

        <ProjectListView
          v-else-if="currentPage === 'projects'"
          @select-project="selectProject"
          @new-project="showNewProjectModal = true"
          @swot-project="openSwotProject"
        />

        <ProjectDetailView
          v-else-if="currentPage === 'projectDetail'"
          :project="selectedProject"
          :meetings="mockMeetings"
          @navigate="currentPage = $event"
        />

        <WorkflowView
          v-else-if="currentPage === 'workflow'"
          :projects="projects"
          :initial-task="selectedTask"
          :team="currentUser?.teamName"
          @navigate="page => { currentPage = page; selectedTask = null }"
          @extraction-ready="handleExtractionReady"
          @toast="(msg, type) => showToast(msg, type)"
        />

        <ReviewerView v-else-if="currentPage === 'reviewer'" :initial-slug="reviewerInitialSlug" @swot-project="openSwotProject" />

        <SwotReportView
          v-else-if="currentPage === 'swotReport' && swotProject"
          :project-slug="swotProject.slug || swotProject.id"
          :project-name="swotProject.name || swotProject.title"
          @swot-analysis-ready="handleSwotAnalysisReady"
        />

        <SpeakerManagementView v-else-if="currentPage === 'speakers'" :team="currentUser?.teamName" />

        <TasksView
          v-else-if="currentPage === 'tasks'"
          @navigate="currentPage = $event"
          @select-task="openTaskDetail"
        />

        <SessionsView
          v-else-if="currentPage === 'sessions'"
          :fetch-sessions="chat.fetchSessions"
          :delete-session="chat.deleteSession"
          :delete-all-sessions="chat.deleteAllSessions"
          :fetch-trajectory="chat.fetchTrajectory"
          :fetch-raw="chat.fetchRaw"
          :sessions="chat.sessions.value"
          :sessions-loading="chat.sessionsLoading.value"
          :current-session-key="chat.sessionKey.value"
          @toast="(msg, type) => showToast(msg, type)"
          @select-session="handleSelectSession"
        />


        <SettingsView
          v-else-if="currentPage === 'settings'"
          :container-config="containerConfig"
          @save="saveSettings"
          @logout="logout"
        />

        <AccountView
          v-else-if="currentPage === 'account' && isAdmin"
        />

        <ContainerView
          v-else-if="currentPage === 'container' && isAdmin"
          :container-config="containerConfig"
          :is-admin="isAdmin"
          @restart="showRestartConfirm = true"
          @destroy="showDestroyConfirm = true"
        />

        <ReleaseNoteView v-else-if="currentPage === 'releaseNote'" />

        <TerminologyView v-else-if="currentPage === 'terminology'" @toast="(msg, type) => showToast(msg, type)" />
      </div>
    </main>
  </div>

  <!-- Modals -->
  <NewProjectModal
    :show="showNewProjectModal"
    @close="showNewProjectModal = false"
    @create="createProject"
  />

  <RestartModal
    :show="showRestartConfirm"
    :is-restarting="isRestarting"
    :restart-progress="restartProgress"
    @close="showRestartConfirm = false"
    @confirm="handleRestart"
  />

  <DestroyModal
    :show="showDestroyConfirm"
    :is-destroying="isDestroying"
    :container-config="containerConfig"
    @close="showDestroyConfirm = false"
    @confirm="handleDestroy"
  />

  <!-- Toast -->
  <ToastNotification :toast="toast" />

  <!-- Chat (only when logged in) -->
  <template v-if="currentPage !== 'login' && currentPage !== 'register'">
    <ChatButton
      :unread-count="chat.unreadCount.value"
      :is-connected="chat.isConnected.value"
      @click="chat.isOpen.value ? chat.closePanel() : chat.openPanel()"
    />
    <ChatPanel
      :show="chat.isOpen.value"
      :messages="chat.messages.value"
      :streaming-messages="chat.streamingMessages.value"
      :is-connected="chat.isConnected.value"
      :is-loading="chat.isLoading.value"
      @close="chat.closePanel()"
      @send="chat.sendMessage"
      @new-session="chat.newSession()"
    />
  </template>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useApp } from './composables/useApp.js'
import { useChat } from './composables/useChat.js'
import AppSidebar from './components/AppSidebar.vue'
import AppTopbar from './components/AppTopbar.vue'
import ToastNotification from './components/ToastNotification.vue'
import NewProjectModal from './components/NewProjectModal.vue'
import RestartModal from './components/RestartModal.vue'
import DestroyModal from './components/DestroyModal.vue'
import SetupWizard from './components/SetupWizard.vue'
import ChatButton from './components/ChatButton.vue'
import ChatPanel from './components/ChatPanel.vue'
import SessionsView from './views/SessionsView.vue'
import SwotReportView from './views/SwotReportView.vue'
import LoginView from './views/LoginView.vue'
import DashboardView from './views/DashboardView.vue'
import ProjectListView from './views/ProjectListView.vue'
import ProjectDetailView from './views/ProjectDetailView.vue'
import WorkflowView from './views/WorkflowView.vue'
import ReviewerView from './views/ReviewerView.vue'
import SettingsView from './views/SettingsView.vue'
import AccountView from './views/AccountView.vue'
import ContainerView from './views/ContainerView.vue'
import SpeakerManagementView from './views/SpeakerManagementView.vue'
import TasksView from './views/TasksView.vue'
import ReleaseNoteView from './views/ReleaseNoteView.vue'
import TerminologyView from './views/TerminologyView.vue'

const {
  currentPage, sidebarCollapsed, isDark, isConfiguring, configProgress,
  showNewProjectModal, showRestartConfirm, isRestarting, restartProgress,
  showDestroyConfirm, isDestroying, containerConfig,
  toast, containerStatus, containerStats, containerStatusColor, containerStatusTextColor,
  isNewUser, projects, recentProjects, selectedProject, mockMeetings, mockTranscript,
  breadcrumb, authError, isAuthLoading, currentUser, isAdmin,
  toggleTheme, selectProject, handleAuth, logout, saveSettings, handleRestart, handleDestroy, showToast,
  completeSetup
} = useApp()

const reviewerInitialSlug = ref(null)
const selectedTask = ref(null)
const swotProject = ref(null)

async function openTaskDetail(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('clawpm_token')}` }
    })
    if (res.ok) selectedTask.value = await res.json()
  } catch {}
  currentPage.value = 'workflow'
}

function openReviewerProject(slug) {
  reviewerInitialSlug.value = slug
  currentPage.value = 'reviewer'
}

function openSwotProject(project) {
  swotProject.value = project
  currentPage.value = 'swotReport'
}

function handleSwotAnalysisReady({ sessionKey, prompt, newSession }) {
  if (newSession) {
    chat.newSession()
  } else {
    chat.setSession(sessionKey)
  }
  chat.sendMessage(prompt)
  chat.openPanel()
}

function handleNavigate(page) {
  currentPage.value = page
}

const chat = useChat()

async function handleSelectSession(session) {
  await chat.switchSession(session)
  chat.openPanel()
}

// Connect WebSocket when user logs in; disconnect on logout
watch(currentPage, (page) => {
  const loggedIn = page !== 'login' && page !== 'register'
  if (loggedIn) {
    chat.connect()
  } else {
    chat.disconnect()
    chat.messages.value = []
    chat.unreadCount.value = 0
    chat.isOpen.value = false
  }
}, { immediate: true })

function handleExtractionReady({ sessionKey, prompt, newSession }) {
  if (newSession) {
    chat.newSession()
  } else {
    chat.setSession(sessionKey)
  }
  chat.sendMessage(prompt)
  chat.openPanel()
}

function createProject(data) {
  projects.value.push({
    id: Date.now(),
    name: data.name,
    desc: data.desc,
    created: new Date().toISOString().slice(0, 10),
    updated: '剛剛',
    meetings: 0
  })
  showNewProjectModal.value = false
  showToast('專案已建立！')
}
</script>
