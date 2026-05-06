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
      :recent-projects="recentProjects"
      :container-status="containerStatus"
      :container-status-color="containerStatusColor"
      :container-status-text-color="containerStatusTextColor"
      :is-dark="isDark"
      @navigate="currentPage = $event"
      @select-project="selectProject"
      @toggle-theme="toggleTheme"
    />

    <main class="flex-1 flex flex-col min-w-0 bg-white dark:bg-slate-950 transition-colors">
      <AppTopbar :breadcrumb="breadcrumb" :current-user="currentUser" @navigate="currentPage = $event" @logout="logout" />

      <div class="flex-1 overflow-y-auto p-8">
        <SetupWizard
          v-if="currentPage === 'dashboard' && isNewUser"
          :is-dark="isDark"
          @complete="completeSetup"
        />
        <DashboardView
          v-else-if="currentPage === 'dashboard'"
          :recent-projects="recentProjects"
          :container-status="containerStatus"
          :container-status-color="containerStatusColor"
          @navigate="currentPage = $event"
          @select-project="selectProject"
          @new-project="showNewProjectModal = true"
        />

        <ProjectListView
          v-else-if="currentPage === 'projects'"
          :projects="projects"
          @select-project="selectProject"
          @new-project="showNewProjectModal = true"
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
          :mock-transcript="mockTranscript"
          @navigate="currentPage = $event"
        />

        <ReviewerView v-else-if="currentPage === 'reviewer'" />

        <SettingsView
          v-else-if="currentPage === 'settings'"
          :container-config="containerConfig"
          @restart="showRestartConfirm = true"
          @destroy="showDestroyConfirm = true"
          @save="saveSettings"
        />
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
      :is-connected="chat.isConnected.value"
      :is-loading="chat.isLoading.value"
      @close="chat.closePanel()"
      @send="chat.sendMessage"
      @new-session="chat.newSession()"
    />
  </template>
</template>

<script setup>
import { watch } from 'vue'
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
import LoginView from './views/LoginView.vue'
import DashboardView from './views/DashboardView.vue'
import ProjectListView from './views/ProjectListView.vue'
import ProjectDetailView from './views/ProjectDetailView.vue'
import WorkflowView from './views/WorkflowView.vue'
import ReviewerView from './views/ReviewerView.vue'
import SettingsView from './views/SettingsView.vue'

const {
  currentPage, sidebarCollapsed, isDark, isConfiguring, configProgress,
  showNewProjectModal, showRestartConfirm, isRestarting, restartProgress,
  showDestroyConfirm, isDestroying, containerConfig,
  toast, containerStatus, containerStatusColor, containerStatusTextColor,
  isNewUser, projects, recentProjects, selectedProject, mockMeetings, mockTranscript,
  breadcrumb, authError, isAuthLoading, currentUser,
  toggleTheme, selectProject, handleAuth, logout, saveSettings, handleRestart, handleDestroy, showToast,
  completeSetup
} = useApp()

const chat = useChat()

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
