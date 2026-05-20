// Global variables
let socket = null;
let activeTab = 'dashboard';
let activeInstanceSlug = 'primary'; // Configured on startup
let currentStatus = 'disconnected';
let allRules = [];
let allLogs = [];
let allInstances = [];
let currentLogFilter = 'all';
let stats = { sent: 0, received: 0, replies: 0 };
let uptimeInterval = null;
let secondsUptime = 0;
let unreadLogsCount = 0;

// UI Elements: Navigation & Tabs
const menuItems = document.querySelectorAll('.menu-item');
const tabPanes = document.querySelectorAll('.tab-pane');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');
const headerStatus = document.getElementById('header-status');
const headerStatusText = headerStatus.querySelector('.status-text');

// UI Elements: Header Instance Selector
const botSelectorWrapper = document.getElementById('header-bot-selector');
const activeInstanceSelect = document.getElementById('active-instance-select');

// UI Elements: Dashboard Connection Card
const portalBadge = document.getElementById('portal-badge');
const qrContainer = document.getElementById('qr-container');
const qrImage = document.getElementById('qr-image');
const connectingContainer = document.getElementById('connecting-container');
const connectingProgress = document.getElementById('connecting-progress');
const connectedContainer = document.getElementById('connected-container');
const disconnectedContainer = document.getElementById('disconnected-container');

// UI Elements: Uptime and Statistics
const statSent = document.getElementById('stat-sent');
const statReceived = document.getElementById('stat-received');
const statReplies = document.getElementById('stat-replies');
const statUptime = document.getElementById('stat-uptime');

// UI Elements: Profile Widget
const botProfile = document.getElementById('bot-profile');
const botAvatar = document.getElementById('bot-avatar');
const botName = document.getElementById('bot-name');
const botWid = document.getElementById('bot-wid');
const cardDeviceName = document.getElementById('card-device-name');
const cardDevicePlatform = document.getElementById('card-device-platform');
const logoutBtn = document.getElementById('logout-btn');

// UI Elements: Terminals
const dashboardTerminal = document.getElementById('dashboard-terminal-logs');
const fullTerminal = document.getElementById('full-terminal-logs');
const viewAllLogsBtn = document.getElementById('view-all-logs-btn');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const filterBtns = document.querySelectorAll('.filter-btn');
const unreadLogsBadge = document.getElementById('unread-logs');

// UI Elements: Auto-Responders
const rulesContainer = document.getElementById('rules-list-container');
const searchInput = document.getElementById('rule-search-input');
const openAddRuleBtn = document.getElementById('open-add-rule-btn');
const ruleModal = document.getElementById('rule-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const ruleForm = document.getElementById('rule-form');
const modalTitle = document.getElementById('modal-title');
const ruleIdInput = document.getElementById('rule-id');
const ruleTriggerInput = document.getElementById('rule-trigger');
const ruleMatchTypeSelect = document.getElementById('rule-match-type');
const ruleReplyTextarea = document.getElementById('rule-reply');
const ruleEnabledCheckbox = document.getElementById('rule-enabled');
const ruleSendApkCheckbox = document.getElementById('rule-send-apk');
const ruleReplyModeSelect = document.getElementById('rule-reply-mode');

// UI Elements: AI Responder
const aiEnabledToggle = document.getElementById('ai-enabled-toggle');
const aiToggleLabel = document.getElementById('ai-toggle-label');
const aiPromptContainer = document.getElementById('ai-prompt-container');
const aiSystemPromptTextarea = document.getElementById('ai-system-prompt');
const aiProcessReplyTextarea = document.getElementById('ai-process-reply');
const aiApkInstructionsTextarea = document.getElementById('ai-apk-instructions');
const aiApkPreambleInput = document.getElementById('ai-apk-preamble');
const aiSmartApkToggle = document.getElementById('ai-smart-apk-toggle');
const saveAiSettingsBtn = document.getElementById('save-ai-settings-btn');
const clearAiMemoryBtn = document.getElementById('clear-ai-memory-btn');

function collectAiSettingsPayload() {
  return {
    aiEnabled: aiEnabledToggle ? aiEnabledToggle.checked : false,
    aiSystemPrompt: aiSystemPromptTextarea ? aiSystemPromptTextarea.value.trim() : '',
    aiProcessReply: aiProcessReplyTextarea ? aiProcessReplyTextarea.value.trim() : '',
    aiApkInstructions: aiApkInstructionsTextarea ? aiApkInstructionsTextarea.value.trim() : '',
    aiApkPreamble: aiApkPreambleInput ? aiApkPreambleInput.value.trim() : '',
    aiSmartApkEnabled: aiSmartApkToggle ? aiSmartApkToggle.checked : true
  };
}

function applyAiSettingsToForm(data) {
  if (!data) return;
  if (aiSystemPromptTextarea) aiSystemPromptTextarea.value = data.aiSystemPrompt || '';
  if (aiProcessReplyTextarea) aiProcessReplyTextarea.value = data.aiProcessReply || '';
  if (aiApkInstructionsTextarea) aiApkInstructionsTextarea.value = data.aiApkInstructions || '';
  if (aiApkPreambleInput) aiApkPreambleInput.value = data.aiApkPreamble || '';
  if (aiSmartApkToggle) aiSmartApkToggle.checked = data.aiSmartApkEnabled !== false;
}

// UI Elements: Manual Messenger
const messengerForm = document.getElementById('messenger-form');
const recipientInput = document.getElementById('recipient-number');
const typeSelectors = document.querySelectorAll('input[name="message-type"]');
const textMessageGroup = document.getElementById('text-message-group');
const fileAttachmentGroup = document.getElementById('file-attachment-group');
const messageBodyTextarea = document.getElementById('message-body');
const fileDropzone = document.getElementById('file-dropzone');
const fileInput = document.getElementById('file-input');
const dropzonePrompt = fileDropzone.querySelector('.dropzone-prompt');
const filePreview = fileDropzone.querySelector('.dropzone-file-preview');
const previewName = filePreview.querySelector('.preview-name');
const previewSize = filePreview.querySelector('.preview-size');
const btnClearFile = document.getElementById('btn-clear-file');
const fileCaptionInput = document.getElementById('file-caption');
const sendMessageBtn = document.getElementById('send-message-btn');

// Mobile UI Navigation Toggles
const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
const mobileSidebarClose = document.getElementById('mobile-sidebar-close');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const appSidebar = document.getElementById('app-sidebar');

// Toast Notification System
const toastContainer = document.getElementById('toast-container');

// UI Elements: Authentication Portal
const authPortal = document.getElementById('auth-portal');
const authForm = document.getElementById('auth-form');
const authUsernameInput = document.getElementById('auth-username');
const authPasswordInput = document.getElementById('auth-password');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authTitle = document.getElementById('auth-title');
const authSubtitle = document.getElementById('auth-subtitle');
const dashboardLogoutBtn = document.getElementById('dashboard-logout-btn');

// UI Elements: Bot Instances Management
const instancesContainer = document.getElementById('instances-list-container');
const instanceSearchInput = document.getElementById('instance-search-input');
const openAddInstanceBtn = document.getElementById('open-add-instance-btn');
const instanceModal = document.getElementById('instance-modal');
const instanceModalCloseBtn = document.getElementById('instance-modal-close-btn');
const instanceModalCancelBtn = document.getElementById('instance-modal-cancel-btn');
const instanceForm = document.getElementById('instance-form');
const newInstanceNameInput = document.getElementById('new-instance-name');
const newInstanceSlugInput = document.getElementById('new-instance-slug');

// Secure API Client Wrapper
async function apiFetch(url, options = {}) {
  const token = localStorage.getItem('token');
  if (!options.headers) {
    options.headers = {};
  }
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  
  // Automatically inject activeInstanceSlug parameter where necessary
  if (token && !url.includes('/api/auth/') && !url.includes('/api/instances') && activeInstanceSlug) {
    const delimiter = url.includes('?') ? '&' : '?';
    url = `${url}${delimiter}instance=${activeInstanceSlug}`;
  }
  
  const response = await fetch(url, options);
  
  if (response.status === 401 || response.status === 403) {
    showToast('Session expired. Please log in again.', 'error');
    dashboardLogout();
    throw new Error('Unauthorized');
  }
  
  return response;
}

// TAB NAVIGATION MANAGEMENT
menuItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const tabName = item.getAttribute('data-tab');
    switchTab(tabName);
  });
});

viewAllLogsBtn.addEventListener('click', () => switchTab('logs'));

// MOBILE SIDEBAR TOGGLES
mobileMenuToggle.addEventListener('click', () => {
  appSidebar.classList.add('active');
  sidebarOverlay.classList.add('active');
});

mobileSidebarClose.addEventListener('click', () => {
  appSidebar.classList.remove('active');
  sidebarOverlay.classList.remove('active');
});

sidebarOverlay.addEventListener('click', () => {
  appSidebar.classList.remove('active');
  sidebarOverlay.classList.remove('active');
});

function switchTab(tabName) {
  activeTab = tabName;
  
  if (window.innerWidth <= 768) {
    appSidebar.classList.remove('active');
    sidebarOverlay.classList.remove('active');
  }
  
  menuItems.forEach(item => {
    if (item.getAttribute('data-tab') === tabName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  tabPanes.forEach(pane => {
    if (pane.id === `tab-${tabName}`) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });

  if (tabName === 'logs') {
    unreadLogsCount = 0;
    unreadLogsBadge.style.display = 'none';
    unreadLogsBadge.textContent = '0';
  }

  // Update headers
  switch (tabName) {
    case 'dashboard':
      pageTitle.textContent = 'System Overview';
      pageSubtitle.textContent = 'Real-time status and operational health of your WhatsApp Bot.';
      break;
    case 'responders':
      pageTitle.textContent = 'Auto-Responders';
      pageSubtitle.textContent = 'Configure keywords, triggers, and automated workflows.';
      fetchRules();
      break;
    case 'messenger':
      pageTitle.textContent = 'Manual Messenger';
      pageSubtitle.textContent = 'Transmit direct text broadcasts or media attachments manually.';
      break;
    case 'logs':
      pageTitle.textContent = 'System Console';
      pageSubtitle.textContent = 'Verbose technical stream detailing all underlying activities.';
      break;
    case 'instances':
      pageTitle.textContent = 'Bot Instances';
      pageSubtitle.textContent = 'Admin panel to provision, inspect, or delete WhatsApp bot engines.';
      fetchInstances();
      break;
  }
}

// HEADER BOT INSTANCE SELECTOR LISTENER
activeInstanceSelect.addEventListener('change', () => {
  activeInstanceSlug = activeInstanceSelect.value;
  localStorage.setItem('activeInstanceSlug', activeInstanceSlug);
  
  // 1. Clear all stale UI state from the previous instance immediately
  stopUptimeCounter();
  hideProfile();
  showState('disconnected');
  dashboardTerminal.innerHTML = '';
  fullTerminal.innerHTML = '';
  allLogs = [];
  unreadLogsCount = 0;
  unreadLogsBadge.style.display = 'none';
  stats = { sent: 0, received: 0, replies: 0 };
  statSent.textContent = '0';
  statReceived.textContent = '0';
  statReplies.textContent = '0';
  statUptime.textContent = '00:00';
  currentStatus = 'disconnected';
  headerStatus.className = 'connection-status-badge disconnected';
  headerStatusText.textContent = 'Disconnected';
  
  // 2. Re-join websocket room for the new selected bot instance
  if (socket) {
    socket.emit('join_instance', activeInstanceSlug);
  }
  
  // 3. Reload active configuration metrics from the new instance
  syncActiveInstanceData();
  showToast(`Switched to: "${activeInstanceSlug}"`, 'info');
});

// SOCKET CLIENT MANAGEMENT
function connectSocket() {
  const token = localStorage.getItem('token');
  if (!token) return;

  if (socket) {
    socket.disconnect();
  }

  socket = io({
    auth: { token }
  });

  setupSocketListeners();
  
  // Route room links immediately on connection
  socket.on('connect', () => {
    socket.emit('join_instance', activeInstanceSlug);
  });
}

function setupSocketListeners() {
  socket.on('status', (data) => {
    currentStatus = data.status;
    updateStatusUI(data);
  });

  socket.on('qr_code', (base64Url) => {
    showState('qr');
    qrImage.src = base64Url;
  });

  socket.on('log', (log) => {
    allLogs.push(log);
    if (allLogs.length > 200) allLogs.shift();
    
    appendLog(log);
    
    if (activeTab !== 'logs') {
      unreadLogsCount++;
      unreadLogsBadge.style.display = 'block';
      unreadLogsBadge.textContent = unreadLogsCount > 99 ? '99+' : unreadLogsCount;
    }
  });

  socket.on('logs_history', (history) => {
    allLogs = history;
    dashboardTerminal.innerHTML = '';
    fullTerminal.innerHTML = '';
    
    history.forEach(log => {
      appendLog(log);
    });
  });

  socket.on('stat_increment', (type) => {
    if (type === 'sent') {
      stats.sent++;
      statSent.textContent = stats.sent;
    } else if (type === 'replies') {
      stats.replies++;
      statReplies.textContent = stats.replies;
    } else if (type === 'received') {
      stats.received++;
      statReceived.textContent = stats.received;
    }
  });

  socket.on('apk_cached', (data) => {
    showToast(`New APK Cached: "${data.filename}"`, 'success');
    updateApkCard();
  });

  socket.on('apk_cleared', () => {
    showToast('APK Cache cleared from server.', 'info');
    updateApkCard();
  });
}

function updateStatusUI(data) {
  const status = data.status;
  
  headerStatus.className = `connection-status-badge ${status}`;
  headerStatusText.textContent = status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ');

  portalBadge.textContent = status.toUpperCase().replace('_', ' ');
  portalBadge.className = 'badge';
  
  if (status === 'ready') portalBadge.style.background = 'rgba(34, 197, 94, 0.15)', portalBadge.style.color = 'var(--whatsapp)';
  else if (status === 'disconnected') portalBadge.style.background = 'rgba(244, 63, 94, 0.15)', portalBadge.style.color = 'var(--danger)';
  else portalBadge.style.background = 'rgba(6, 182, 212, 0.15)', portalBadge.style.color = 'var(--secondary)';

  if (status === 'disconnected') {
    showState('disconnected');
    stopUptimeCounter();
    hideProfile();
  } else if (status === 'connecting') {
    showState('connecting');
    if (data.message) {
      connectingProgress.textContent = `${data.progress || 0}% - ${data.message}`;
    } else {
      connectingProgress.textContent = 'Preparing browser sandbox. This may take a moment...';
    }
  } else if (status === 'qr_ready') {
    showState('qr');
  } else if (status === 'authenticated') {
    showState('connecting');
    connectingProgress.textContent = 'Establishing WebSocket session...';
  } else if (status === 'ready') {
    showState('connected');
    startUptimeCounter();
    showProfile(data.info);
  }
}

function showState(state) {
  qrContainer.style.display = state === 'qr' ? 'flex' : 'none';
  connectingContainer.style.display = state === 'connecting' ? 'flex' : 'none';
  connectedContainer.style.display = state === 'connected' ? 'flex' : 'none';
  disconnectedContainer.style.display = state === 'disconnected' ? 'flex' : 'none';
}

function showProfile(info) {
  if (!info) return;
  botName.textContent = info.pushname || 'WhatsApp Bot';
  botWid.textContent = info.wid.split('@')[0];
  botAvatar.textContent = (info.pushname || 'WA').substring(0, 2).toUpperCase();
  botProfile.style.display = 'flex';
  logoutBtn.style.display = 'flex';

  cardDeviceName.textContent = info.pushname || 'Primary WhatsApp Session';
  cardDevicePlatform.textContent = info.platform ? info.platform.toUpperCase() : 'WEB';
}

function hideProfile() {
  botProfile.style.display = 'none';
  logoutBtn.style.display = 'none';
}

// UPTIME COUNTER
function startUptimeCounter() {
  if (uptimeInterval) return;
  secondsUptime = 0;
  statUptime.textContent = '00:00';
  uptimeInterval = setInterval(() => {
    secondsUptime++;
    const hrs = Math.floor(secondsUptime / 3600);
    const mins = Math.floor((secondsUptime % 3600) / 60);
    const secs = secondsUptime % 60;
    
    let timeStr = '';
    if (hrs > 0) timeStr += (hrs < 10 ? '0' + hrs : hrs) + ':';
    timeStr += (mins < 10 ? '0' + mins : mins) + ':';
    timeStr += (secs < 10 ? '0' + secs : secs);
    
    statUptime.textContent = timeStr;
  }, 1000);
}

function stopUptimeCounter() {
  if (uptimeInterval) {
    clearInterval(uptimeInterval);
    uptimeInterval = null;
  }
  secondsUptime = 0;
  statUptime.textContent = '00:00';
}

// Logs append renderer
function appendLog(log) {
  const rowHtml = `
    <div class="log-row ${log.type}" data-type="${log.type}">
      <span class="log-time">${log.timestamp}</span>
      <span class="log-badge">[${log.type}]</span>
      <span class="log-message">${escapeHtml(log.message)}</span>
    </div>
  `;
  
  dashboardTerminal.insertAdjacentHTML('beforeend', rowHtml);
  dashboardTerminal.scrollTop = dashboardTerminal.scrollHeight;
  if (dashboardTerminal.children.length > 50) {
    dashboardTerminal.removeChild(dashboardTerminal.firstChild);
  }

  if (currentLogFilter === 'all' || log.type === currentLogFilter) {
    fullTerminal.insertAdjacentHTML('beforeend', rowHtml);
    fullTerminal.scrollTop = fullTerminal.scrollHeight;
  }
}

clearLogsBtn.addEventListener('click', () => {
  fullTerminal.innerHTML = '';
  showToast('Terminal logs cleared locally.', 'info');
});

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    currentLogFilter = btn.getAttribute('data-filter');
    renderFilteredLogs();
  });
});

function renderFilteredLogs() {
  fullTerminal.innerHTML = '';
  allLogs.forEach(log => {
    if (currentLogFilter === 'all' || log.type === currentLogFilter) {
      const rowHtml = `
        <div class="log-row ${log.type}" data-type="${log.type}">
          <span class="log-time">${log.timestamp}</span>
          <span class="log-badge">[${log.type}]</span>
          <span class="log-message">${escapeHtml(log.message)}</span>
        </div>
      `;
      fullTerminal.insertAdjacentHTML('beforeend', rowHtml);
    }
  });
  fullTerminal.scrollTop = fullTerminal.scrollHeight;
}

// AUTO RESPONDER RULES: Fetch and Render
async function fetchRules() {
  try {
    const res = await apiFetch('/api/rules');
    allRules = await res.json();
    renderRules();
  } catch (err) {
    showToast('Failed to load auto-responder rules.', 'error');
  }
}

function renderRules() {
  const searchTerm = searchInput.value.toLowerCase().trim();
  rulesContainer.innerHTML = '';

  const filteredRules = allRules.filter(rule => {
    return rule.trigger.toLowerCase().includes(searchTerm) || 
           rule.reply.toLowerCase().includes(searchTerm);
  });

  if (filteredRules.length === 0) {
    rulesContainer.innerHTML = `
      <div class="glass-card full-width-card" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
        <i data-lucide="help-circle" style="width: 48px; height: 48px; margin-bottom: 15px; opacity: 0.5;"></i>
        <h4>No Rules Found</h4>
        <p>Try refining your search terms or click "Add Auto-Reply Rule" to create one.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  filteredRules.forEach(rule => {
    const cardHtml = `
      <div class="glass-card rule-card" id="card-${rule.id}">
        <div class="rule-card-header">
          <div class="trigger-tag" title="${escapeHtml(rule.trigger)}">${escapeHtml(rule.trigger)}</div>
          <div class="rule-actions">
            <button class="btn-action edit" onclick="openEditRuleModal('${rule.id}')" title="Edit Rule">
              <i data-lucide="edit-3"></i>
            </button>
            <button class="btn-action delete" onclick="deleteRule('${rule.id}')" title="Delete Rule">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>

        <span class="rule-match-pill">${rule.matchType.replace('_', ' ')}</span>
        
        <div class="rule-reply-preview">${escapeHtml(rule.reply)}</div>

        <div class="rule-card-footer">
          <label class="toggle-container">
            <input type="checkbox" ${rule.enabled ? 'checked' : ''} onchange="toggleRuleEnabled('${rule.id}', this.checked)">
            <span class="toggle-slider"></span>
            <span class="toggle-label">${rule.enabled ? 'Active' : 'Muted'}</span>
          </label>
        </div>
      </div>
    `;
    rulesContainer.insertAdjacentHTML('beforeend', cardHtml);
  });

  lucide.createIcons();
}

searchInput.addEventListener('input', renderRules);

// Modal Handling
openAddRuleBtn.addEventListener('click', () => {
  ruleForm.reset();
  ruleIdInput.value = '';
  modalTitle.textContent = 'Create Auto-Reply Rule';
  ruleModal.classList.add('active');
});

function closeModal() {
  ruleModal.classList.remove('active');
}

modalCloseBtn.addEventListener('click', closeModal);
modalCancelBtn.addEventListener('click', closeModal);

ruleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const id = ruleIdInput.value;
  const trigger = ruleTriggerInput.value.trim();
  const matchType = ruleMatchTypeSelect.value;
  const reply = ruleReplyTextarea.value.trim();
  const enabled = ruleEnabledCheckbox.checked;
  const sendApk = ruleSendApkCheckbox ? ruleSendApkCheckbox.checked : false;
  const replyMode = ruleReplyModeSelect ? ruleReplyModeSelect.value : 'sequential';

  if (!reply && !sendApk) {
    showToast('Please enter an automated reply message or check the Attach APK option!', 'error');
    return;
  }

  const payload = { trigger, matchType, reply, enabled, sendApk, replyMode };
  const url = id ? `/api/rules/${id}` : '/api/rules';
  const method = id ? 'PUT' : 'POST';

  try {
    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      closeModal();
      showToast(id ? 'Rule updated successfully!' : 'New rule created successfully!', 'success');
      fetchRules();
    } else {
      const errData = await res.json();
      showToast(errData.error || 'Failed to save rule.', 'error');
    }
  } catch (err) {
    showToast('Network error, failed to save rule.', 'error');
  }
});

window.openEditRuleModal = function(id) {
  const rule = allRules.find(r => r.id === id);
  if (!rule) return;

  ruleIdInput.value = rule.id;
  ruleTriggerInput.value = rule.trigger;
  ruleMatchTypeSelect.value = rule.matchType;
  ruleReplyTextarea.value = rule.reply;
  ruleEnabledCheckbox.checked = rule.enabled;
  if (ruleSendApkCheckbox) {
    ruleSendApkCheckbox.checked = !!rule.sendApk;
  }
  if (ruleReplyModeSelect) {
    ruleReplyModeSelect.value = rule.replyMode || 'sequential';
  }

  modalTitle.textContent = 'Edit Auto-Reply Rule';
  ruleModal.classList.add('active');
};

window.deleteRule = async function(id) {
  if (!confirm('Are you sure you want to permanently delete this rule?')) return;

  try {
    const res = await apiFetch(`/api/rules/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Rule deleted successfully!', 'success');
      fetchRules();
    } else {
      showToast('Failed to delete rule.', 'error');
    }
  } catch (err) {
    showToast('Network error, failed to delete rule.', 'error');
  }
};

window.toggleRuleEnabled = async function(id, enabled) {
  try {
    const res = await apiFetch(`/api/rules/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });

    if (res.ok) {
      const rule = allRules.find(r => r.id === id);
      if (rule) rule.enabled = enabled;
      
      const card = document.getElementById(`card-${id}`);
      const toggleLabel = card.querySelector('.toggle-label');
      toggleLabel.textContent = enabled ? 'Active' : 'Muted';
      
      showToast(enabled ? 'Rule enabled!' : 'Rule muted.', 'info');
    } else {
      showToast('Failed to update status.', 'error');
      fetchRules();
    }
  } catch (err) {
    showToast('Network error updating rule status.', 'error');
    fetchRules();
  }
};

// MANUAL MESSENGER
typeSelectors.forEach(radio => {
  radio.addEventListener('change', () => {
    document.querySelectorAll('.type-selector').forEach(sel => sel.classList.remove('active'));
    radio.closest('.type-selector').classList.add('active');

    if (radio.value === 'text') {
      textMessageGroup.style.display = 'block';
      fileAttachmentGroup.style.display = 'none';
      messageBodyTextarea.required = true;
      fileInput.required = false;
    } else {
      textMessageGroup.style.display = 'none';
      fileAttachmentGroup.style.display = 'block';
      messageBodyTextarea.required = false;
    }
  });
});

fileDropzone.addEventListener('click', () => fileInput.click());

fileDropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDropzone.style.borderColor = 'var(--secondary)';
  fileDropzone.style.background = 'rgba(6, 182, 212, 0.04)';
});

['dragleave', 'dragend'].forEach(type => {
  fileDropzone.addEventListener(type, () => {
    fileDropzone.style.borderColor = 'rgba(255, 255, 255, 0.15)';
    fileDropzone.style.background = 'rgba(255, 255, 255, 0.01)';
  });
});

fileDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDropzone.style.borderColor = 'rgba(255, 255, 255, 0.15)';
  fileDropzone.style.background = 'rgba(255, 255, 255, 0.01)';
  
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    updateFilePreview();
  }
});

fileInput.addEventListener('change', updateFilePreview);

function updateFilePreview() {
  if (fileInput.files.length) {
    const file = fileInput.files[0];
    previewName.textContent = file.name;
    previewSize.textContent = formatBytes(file.size);
    
    dropzonePrompt.style.display = 'none';
    filePreview.style.display = 'flex';
  }
}

btnClearFile.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.value = '';
  filePreview.style.display = 'none';
  dropzonePrompt.style.display = 'flex';
});

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

messengerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  if (currentStatus !== 'ready') {
    showToast('Cannot send message. WhatsApp bot is currently offline.', 'error');
    return;
  }

  const number = recipientInput.value.trim();
  const type = document.querySelector('input[name="message-type"]:checked').value;
  const submitBtn = sendMessageBtn;
  const originalBtnText = submitBtn.innerHTML;

  submitBtn.disabled = true;
  submitBtn.innerHTML = `
    <div class="spinner-loader" style="width: 20px; height: 20px; margin-right: 8px;">
      <div class="double-bounce1"></div>
      <div class="double-bounce2"></div>
    </div>
    <span>Transmitting Broadcast...</span>
  `;

  try {
    let res;
    
    if (type === 'text') {
      const message = messageBodyTextarea.value.trim();
      res = await apiFetch('/api/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, message })
      });
    } else {
      const file = fileInput.files[0];
      const caption = fileCaptionInput.value.trim();
      
      if (!file) {
        showToast('Please attach a media file first.', 'error');
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
        return;
      }

      const formData = new FormData();
      formData.append('number', number);
      formData.append('file', file);
      formData.append('caption', caption);

      res = await apiFetch('/api/send-file', {
        method: 'POST',
        body: formData
      });
    }

    if (res.ok) {
      showToast('Broadcast transmitted successfully!', 'success');
      recipientInput.value = '';
      messageBodyTextarea.value = '';
      fileCaptionInput.value = '';
      fileInput.value = '';
      filePreview.style.display = 'none';
      dropzonePrompt.style.display = 'flex';
    } else {
      const errData = await res.json();
      showToast(errData.error || 'Failed to transmit broadcast.', 'error');
    }
  } catch (err) {
    showToast('Network error sending message.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalBtnText;
  }
});

// DISCONNECT WHATSAPP BOT SESSION HANDLER
logoutBtn.addEventListener('click', async () => {
  if (!confirm(`Are you sure you want to disconnect and delete your active WhatsApp login cache for instance "${activeInstanceSlug}"? You will have to scan a fresh QR code next time.`)) return;
  
  logoutBtn.disabled = true;
  logoutBtn.textContent = 'Disconnecting...';
  
  try {
    const res = await apiFetch('/api/logout', { method: 'POST' });
    if (res.ok) {
      showToast('WhatsApp session logged out and cleared successfully.', 'success');
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      showToast('Failed to clear session properly.', 'error');
      logoutBtn.disabled = false;
      logoutBtn.innerHTML = '<i data-lucide="log-out"></i><span>Disconnect WhatsApp</span>';
      lucide.createIcons();
    }
  } catch (err) {
    showToast('Network error occurred during logout.', 'error');
    logoutBtn.disabled = false;
    logoutBtn.innerHTML = '<i data-lucide="log-out"></i><span>Disconnect WhatsApp</span>';
    lucide.createIcons();
  }
});

// =============================================================
// APK CACHE UI UPDATES
// =============================================================
const apkFilename = document.getElementById('apk-filename');
const apkMeta = document.getElementById('apk-meta');
const apkDetailsSection = document.getElementById('apk-details-section');
const apkUploader = document.getElementById('apk-uploader');
const apkTime = document.getElementById('apk-time');
const apkSize = document.getElementById('apk-size');
const btnDownloadApk = document.getElementById('btn-download-apk');
const btnClearApk = document.getElementById('btn-clear-apk');
const apkIconWrapper = document.getElementById('apk-icon-wrapper');

async function updateApkCard() {
  if (!apkFilename) return; // Guard for non-logged in or elements missing
  
  try {
    const res = await apiFetch('/api/apk/status');
    const data = await res.json();
    
    if (data.cached) {
      apkFilename.textContent = data.filename;
      apkMeta.innerHTML = 'Latest APK currently cached in memory and disk.';
      apkDetailsSection.style.display = 'block';
      apkUploader.textContent = data.uploadedBy;
      apkTime.textContent = new Date(data.uploadedAt).toLocaleString();
      apkSize.textContent = data.size;
      
      btnDownloadApk.style.display = 'inline-flex';
      btnClearApk.style.display = 'inline-flex';
      
      // Polish design dynamically
      if (apkIconWrapper) {
        apkIconWrapper.style.background = 'rgba(34, 197, 94, 0.08)';
        apkIconWrapper.style.color = 'var(--whatsapp)';
        apkIconWrapper.style.borderColor = 'rgba(34, 197, 94, 0.15)';
      }
    } else {
      apkFilename.textContent = 'No APK Cached';
      apkMeta.innerHTML = 'The cache is empty. Upload an <strong>.apk</strong> file to any linked group chat to store it.';
      apkDetailsSection.style.display = 'none';
      
      btnDownloadApk.style.display = 'none';
      btnClearApk.style.display = 'none';
      
      if (apkIconWrapper) {
        apkIconWrapper.style.background = 'rgba(6, 182, 212, 0.08)';
        apkIconWrapper.style.color = 'var(--secondary)';
        apkIconWrapper.style.borderColor = 'rgba(6, 182, 212, 0.15)';
      }
    }
  } catch (err) {
    console.error('Failed to update APK Card:', err);
  }
}

if (btnDownloadApk) {
  btnDownloadApk.addEventListener('click', async () => {
    try {
      showToast('Downloading APK file...', 'info');
      const res = await apiFetch('/api/apk/download');
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = apkFilename.textContent || 'app.apk';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        showToast('APK download started successfully!', 'success');
      } else {
        showToast('Failed to download APK file.', 'error');
      }
    } catch (err) {
      showToast('Error downloading APK.', 'error');
    }
  });
}

if (btnClearApk) {
  btnClearApk.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to delete the cached APK file from both memory and disk? Users will no longer be able to request it until a new one is uploaded.')) return;
    
    try {
      const res = await apiFetch('/api/apk/clear', { method: 'POST' });
      if (res.ok) {
        showToast('APK Cache cleared successfully.', 'success');
        updateApkCard();
      } else {
        showToast('Failed to clear APK cache.', 'error');
      }
    } catch (err) {
      showToast('Error clearing APK cache.', 'error');
    }
  });
}

// DASHBOARD EXIT SYSTEM (AUTHENTICATION)
function dashboardLogout() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  localStorage.removeItem('activeInstanceSlug');
  
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  
  authPortal.classList.add('active');
  document.querySelector('.app-container').style.display = 'none';
  dashboardLogoutBtn.style.display = 'none';
  botSelectorWrapper.style.display = 'none';
  
  stopUptimeCounter();
  hideProfile();
}

dashboardLogoutBtn.addEventListener('click', () => {
  if (confirm('Are you sure you want to log out of the dashboard? Your active WhatsApp bot instances will continue auto-replying in the background!')) {
    dashboardLogout();
    showToast('Logged out of dashboard successfully.', 'info');
  }
});

// AUTH PORTAL: Form Submit
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = authUsernameInput.value.trim();
  const password = authPasswordInput.value;
  
  if (!username || !password) return;
  
  const submitText = authSubmitBtn.querySelector('span');
  authSubmitBtn.disabled = true;
  submitText.textContent = 'Signing In...';
  
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    
    if (res.ok) {
      showToast('Logged in successfully!', 'success');
      localStorage.setItem('token', data.token);
      localStorage.setItem('username', data.username);
      
      authPortal.classList.remove('active');
      document.querySelector('.app-container').style.display = 'flex';
      dashboardLogoutBtn.style.display = 'flex';
      botSelectorWrapper.style.display = 'flex';
      
      const storedSlug = localStorage.getItem('activeInstanceSlug');
      activeInstanceSlug = storedSlug || 'primary';

      connectSocket();
      init();
      
      authForm.reset();
    } else {
      showToast(data.error || 'Authentication failed', 'error');
    }
  } catch (err) {
    showToast('Network error during authentication.', 'error');
  } finally {
    authSubmitBtn.disabled = false;
    submitText.textContent = 'Sign In';
  }
});

// =============================================================
// ADMINISTRATOR BOT INSTANCES MANAGEMENT PANEL
// =============================================================

async function fetchInstances() {
  try {
    const res = await apiFetch('/api/instances');
    allInstances = await res.json();
    renderInstances();
    populateHeaderDropdown();
  } catch (err) {
    showToast('Failed to load bot instances.', 'error');
  }
}

function populateHeaderDropdown() {
  const currentVal = activeInstanceSelect.value || activeInstanceSlug;
  activeInstanceSelect.innerHTML = '';
  
  allInstances.forEach(inst => {
    const opt = document.createElement('option');
    opt.value = inst.slug;
    opt.textContent = `${inst.name} (${inst.slug})`;
    activeInstanceSelect.appendChild(opt);
  });

  if (allInstances.some(inst => inst.slug === currentVal)) {
    activeInstanceSelect.value = currentVal;
    activeInstanceSlug = currentVal;
  } else if (allInstances.length > 0) {
    activeInstanceSelect.value = allInstances[0].slug;
    activeInstanceSlug = allInstances[0].slug;
  }
}

function renderInstances() {
  const searchTerm = instanceSearchInput.value.toLowerCase().trim();
  instancesContainer.innerHTML = '';
  
  const filtered = allInstances.filter(inst => 
    inst.name.toLowerCase().includes(searchTerm) || 
    inst.slug.toLowerCase().includes(searchTerm)
  );

  if (filtered.length === 0) {
    instancesContainer.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 40px;">
          <i data-lucide="help-circle" style="width: 32px; height: 32px; margin-bottom: 10px; opacity: 0.5;"></i>
          <p>No bot instances match "${escapeHtml(searchTerm)}".</p>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  filtered.forEach(inst => {
    const isActive = inst.slug === activeInstanceSlug;
    const rowHtml = `
      <tr style="${isActive ? 'background: rgba(6, 182, 212, 0.03);' : ''}">
        <td style="padding: 16px 20px; font-weight: 600; display: flex; align-items: center; gap: 12px;">
          <div class="avatar" style="width: 34px; height: 34px; font-size: 0.8rem; background: ${isActive ? 'rgba(6, 182, 212, 0.15)' : 'rgba(255, 255, 255, 0.05)'}; border: 1px solid ${isActive ? 'rgba(6, 182, 212, 0.25)' : 'rgba(255, 255, 255, 0.08)'}; color: ${isActive ? 'var(--secondary)' : 'var(--text-light)'}; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700;">
            ${inst.name.substring(0, 2).toUpperCase()}
          </div>
          <span>
            ${escapeHtml(inst.name)} 
            ${isActive ? '<span style="color: var(--secondary); font-size: 0.75rem; font-weight: 600; margin-left: 5px;">(Active)</span>' : ''}
          </span>
        </td>
        <td style="padding: 16px 20px; font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-muted);">
          ${escapeHtml(inst.slug)}
        </td>
        <td style="padding: 16px 20px;">
          <span class="connection-status-badge ${inst.status}" style="padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px;">
            <span class="status-dot" style="width: 8px; height: 8px; border-radius: 50%; display: inline-block;"></span>
            <span class="status-text" style="font-weight: 500;">${inst.status.charAt(0).toUpperCase() + inst.status.slice(1).replace('_', ' ')}</span>
          </span>
        </td>
        <td style="padding: 16px 20px; text-align: right;">
          <button class="btn btn-danger btn-sm" onclick="deleteInstance('${inst.slug}')" ${allInstances.length <= 1 ? 'disabled style="opacity: 0.4; cursor: not-allowed;"' : ''} title="${allInstances.length <= 1 ? 'You must keep at least one active WhatsApp bot instance' : 'Delete bot instance'}">
            <i data-lucide="trash-2" style="width: 14px; height: 14px; margin-right: 4px;"></i>
            <span>Delete</span>
          </button>
        </td>
      </tr>
    `;
    instancesContainer.insertAdjacentHTML('beforeend', rowHtml);
  });

  lucide.createIcons();
}

instanceSearchInput.addEventListener('input', renderInstances);

// Auto-slugify friendly name into a clean alphanumeric identifier slug
newInstanceNameInput.addEventListener('input', () => {
  const currentSlug = newInstanceSlugInput.value.trim();
  const autoSlug = newInstanceNameInput.value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Keep alphanumeric, spaces and hyphens
    .trim()
    .replace(/[\s_]+/g, '-')       // Replace spaces and underscores with hyphens
    .replace(/-+/g, '-');          // Remove duplicate hyphens
  
  newInstanceSlugInput.value = autoSlug;
});

// Modal Toggles
openAddInstanceBtn.addEventListener('click', () => {
  instanceForm.reset();
  instanceModal.classList.add('active');
});

function closeInstanceModal() {
  instanceModal.classList.remove('active');
}

instanceModalCloseBtn.addEventListener('click', closeInstanceModal);
instanceModalCancelBtn.addEventListener('click', closeInstanceModal);

// Create instance form submit
instanceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const name = newInstanceNameInput.value.trim();
  const slug = newInstanceSlugInput.value.trim().toLowerCase().replace(/[^a-z0-9\-]/g, '');

  if (slug.length < 3) {
    showToast('Slug identifier must be at least 3 characters long.', 'error');
    return;
  }

  try {
    const res = await apiFetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, slug })
    });

    if (res.ok) {
      closeInstanceModal();
      showToast(`Bot instance "${name}" created successfully! Starting engine in the background...`, 'success');
      fetchInstances();
    } else {
      const errData = await res.json();
      showToast(errData.error || 'Failed to create bot instance.', 'error');
    }
  } catch (err) {
    showToast('Network error creating bot instance.', 'error');
  }
});

// Delete instance action
window.deleteInstance = async function(slug) {
  if (allInstances.length <= 1) {
    showToast('You must keep at least one active WhatsApp bot instance!', 'error');
    return;
  }

  if (!confirm(`Are you absolutely sure you want to permanently delete bot instance "${slug}"?\n\nThis will instantly terminate its active Puppeteer browser sandbox, wipe all rules configs, and permanently delete its physical session directory caches!`)) return;

  try {
    const res = await apiFetch(`/api/instances/${slug}`, {
      method: 'DELETE'
    });

    if (res.ok) {
      showToast(`Bot instance "${slug}" deleted successfully.`, 'success');
      
      // If we just deleted the active bot instance, fall back to another available slug
      if (slug === activeInstanceSlug) {
        const remaining = allInstances.filter(i => i.slug !== slug);
        if (remaining.length > 0) {
          activeInstanceSlug = remaining[0].slug;
          localStorage.setItem('activeInstanceSlug', activeInstanceSlug);
        }
      }
      
      fetchInstances();
      syncActiveInstanceData();
    } else {
      const errData = await res.json();
      showToast(errData.error || 'Failed to delete bot instance.', 'error');
    }
  } catch (err) {
    showToast('Network error deleting bot instance.', 'error');
  }
};

// TOAST NOTIFICATIONS DISPATCHER
function showToast(message, type = 'info') {
  const id = 'toast_' + Date.now();
  let icon = 'info';
  if (type === 'success') icon = 'check-circle-2';
  if (type === 'error') icon = 'alert-octagon';
  
  const toastHtml = `
    <div class="toast ${type}" id="${id}">
      <i data-lucide="${icon}" class="toast-icon"></i>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
  
  toastContainer.insertAdjacentHTML('beforeend', toastHtml);
  lucide.createIcons();
  
  const toastEl = document.getElementById(id);
  
  setTimeout(() => {
    toastEl.style.animation = 'slideIn 0.3s ease reverse forwards';
    setTimeout(() => {
      if (toastEl && toastEl.parentNode) {
        toastEl.parentNode.removeChild(toastEl);
      }
    }, 300);
  }, 4000);
}

// UTILITIES
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function syncActiveInstanceData() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    currentStatus = data.status;
    updateStatusUI(data);
    
    // Always reset logs and rebuild from server snapshot
    allLogs = data.logs || [];
    dashboardTerminal.innerHTML = '';
    fullTerminal.innerHTML = '';
    allLogs.forEach(log => appendLog(log));
    
    // Always reset stats (even if 0 for a fresh/new instance)
    stats = data.stats || { sent: 0, received: 0, replies: 0 };
    statSent.textContent = stats.sent;
    statReceived.textContent = stats.received;
    statReplies.textContent = stats.replies;
    
    allRules = data.rules || [];
    if (activeTab === 'responders') {
      renderRules();
    }
    
    // Populate AI Smart Responder configurations for this instance
    if (aiEnabledToggle) {
      aiEnabledToggle.checked = !!data.aiEnabled;
      aiToggleLabel.textContent = data.aiEnabled ? 'Enabled' : 'Disabled';
      aiPromptContainer.style.display = data.aiEnabled ? 'block' : 'none';
      applyAiSettingsToForm(data);
    }
    
    // Populate Admin Media Forwarding Number
    const adminForwardNumberInput = document.getElementById('admin-forward-number');
    if (adminForwardNumberInput) {
      adminForwardNumberInput.value = data.adminForwardNumber || '';
    }

    // Populate Block Trigger Phrase
    const blockTriggerInput = document.getElementById('block-trigger-text');
    if (blockTriggerInput) {
      blockTriggerInput.value = data.blockTriggerText || '';
    }

    // Refresh the APK Cache Manager Card UI
    updateApkCard();
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      showToast('Failed to sync active instance data.', 'error');
    }
  }
}

// =============================================================
// AI SMART RESPONDER CONTROLS & LISTENERS
// =============================================================
if (aiEnabledToggle) {
  aiEnabledToggle.addEventListener('change', async () => {
    const isEnabled = aiEnabledToggle.checked;
    aiToggleLabel.textContent = isEnabled ? 'Enabled' : 'Disabled';
    aiPromptContainer.style.display = isEnabled ? 'block' : 'none';
    
    // Automatically save state instantly to backend database!
    try {
      const res = await apiFetch(`/api/instances/${activeInstanceSlug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectAiSettingsPayload())
      });
      
      if (res.ok) {
        showToast(`AI Smart Responder successfully ${isEnabled ? 'enabled' : 'disabled'}!`, 'success');
        fetchInstances(); // sync local list state
      } else {
        const errData = await res.json();
        showToast(errData.error || 'Failed to update AI state.', 'error');
      }
    } catch (err) {
      showToast('Network error, failed to save toggle state.', 'error');
    }
  });
}

if (saveAiSettingsBtn) {
  saveAiSettingsBtn.addEventListener('click', async () => {
    const payload = collectAiSettingsPayload();
    if (payload.aiEnabled && !payload.aiSystemPrompt) {
      showToast('Add an AI Persona before enabling the responder.', 'error');
      return;
    }

    saveAiSettingsBtn.disabled = true;
    const originalBtnText = saveAiSettingsBtn.innerHTML;
    saveAiSettingsBtn.innerHTML = '<span>Saving...</span>';
    
    try {
      const res = await apiFetch(`/api/instances/${activeInstanceSlug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        showToast('AI settings saved successfully!', 'success');
        fetchInstances(); // sync local list
      } else {
        const errData = await res.json();
        showToast(errData.error || 'Failed to update AI configuration.', 'error');
      }
    } catch (err) {
      showToast('Network error, failed to update AI settings.', 'error');
    } finally {
      saveAiSettingsBtn.disabled = false;
      saveAiSettingsBtn.innerHTML = originalBtnText;
    }
  });
}

const saveForwardNumberBtn = document.getElementById('save-forward-number-btn');
if (saveForwardNumberBtn) {
  saveForwardNumberBtn.addEventListener('click', async () => {
    const adminForwardNumberInput = document.getElementById('admin-forward-number');
    const adminForwardNumber = adminForwardNumberInput ? adminForwardNumberInput.value.trim() : '';
    
    saveForwardNumberBtn.disabled = true;
    const originalBtnText = saveForwardNumberBtn.innerHTML;
    saveForwardNumberBtn.innerHTML = '<span>Saving...</span>';
    
    try {
      const res = await apiFetch(`/api/instances/${activeInstanceSlug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminForwardNumber })
      });
      
      if (res.ok) {
        showToast('Admin forwarding number saved successfully!', 'success');
        fetchInstances();
      } else {
        const errData = await res.json();
        showToast(errData.error || 'Failed to update forwarding number.', 'error');
      }
    } catch (err) {
      showToast('Network error, failed to update admin forwarding number.', 'error');
    } finally {
      saveForwardNumberBtn.disabled = false;
      saveForwardNumberBtn.innerHTML = originalBtnText;
    }
  });
}

const saveBlockTriggerBtn = document.getElementById('save-block-trigger-btn');
if (saveBlockTriggerBtn) {
  saveBlockTriggerBtn.addEventListener('click', async () => {
    const blockTriggerInput = document.getElementById('block-trigger-text');
    const blockTriggerText = blockTriggerInput ? blockTriggerInput.value.trim() : '';
    
    saveBlockTriggerBtn.disabled = true;
    const originalBtnText = saveBlockTriggerBtn.innerHTML;
    saveBlockTriggerBtn.innerHTML = '<span>Saving...</span>';
    
    try {
      const res = await apiFetch(`/api/instances/${activeInstanceSlug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockTriggerText })
      });
      
      if (res.ok) {
        showToast('Auto-block trigger phrase saved successfully!', 'success');
        fetchInstances();
      } else {
        const errData = await res.json();
        showToast(errData.error || 'Failed to update block trigger phrase.', 'error');
      }
    } catch (err) {
      showToast('Network error, failed to update block trigger phrase.', 'error');
    } finally {
      saveBlockTriggerBtn.disabled = false;
      saveBlockTriggerBtn.innerHTML = originalBtnText;
    }
  });
}

const sendReportNowBtn = document.getElementById('send-report-now-btn');
if (sendReportNowBtn) {
  sendReportNowBtn.addEventListener('click', async () => {
    sendReportNowBtn.disabled = true;
    const originalBtnText = sendReportNowBtn.innerHTML;
    sendReportNowBtn.innerHTML = '<span>Sending Report...</span>';
    
    try {
      const res = await apiFetch(`/api/instances/${activeInstanceSlug}/send-report`, {
        method: 'POST'
      });
      
      if (res.ok) {
        showToast('Activity report sent successfully to Admin!', 'success');
      } else {
        const errData = await res.json();
        showToast(errData.error || 'Failed to send activity report.', 'error');
      }
    } catch (err) {
      showToast('Network error, failed to send activity report.', 'error');
    } finally {
      sendReportNowBtn.disabled = false;
      sendReportNowBtn.innerHTML = originalBtnText;
    }
  });
}

// ── Spam Muted Users Panel ────────────────────────────────────────────────────
function formatRemainingTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}

async function loadMutedUsers() {
  const list = document.getElementById('muted-users-list');
  if (!list || !activeInstanceSlug) return;
  list.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted);margin:0;text-align:center;padding:12px;">Loading...</p>';

  try {
    const res = await apiFetch(`/api/instances/${activeInstanceSlug}/muted-users`);
    const data = await res.json();
    if (!data.muted || data.muted.length === 0) {
      list.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted);margin:0;text-align:center;padding:12px;">✅ No users are currently spam-muted.</p>';
      return;
    }
    list.innerHTML = data.muted.map(u => `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;
        padding:10px 14px;background:rgba(255,159,10,0.08);border:1px solid rgba(255,159,10,0.25);
        border-radius:8px;">
        <div>
          <span style="font-size:0.85rem;font-weight:600;color:var(--text-light);">+${u.number}</span>
          <span style="font-size:0.75rem;color:#ff9f0a;margin-left:10px;">⏳ ${formatRemainingTime(u.remainingMs)} remaining</span>
        </div>
        <button class="btn btn-secondary btn-sm unmute-inline-btn"
          data-number="${u.number}"
          style="background:linear-gradient(135deg,#ff9f0a 0%,#ff6b00 100%);border-color:transparent;color:white;font-size:0.75rem;padding:5px 10px;">
          <i data-lucide="volume-2" style="width:12px;height:12px;margin-right:4px;"></i> Unmute
        </button>
      </div>`).join('');

    // Re-init lucide for new icons
    if (window.lucide) lucide.createIcons();

    // Inline unmute buttons
    list.querySelectorAll('.unmute-inline-btn').forEach(btn => {
      btn.addEventListener('click', () => unmuteUser(btn.dataset.number));
    });
  } catch (err) {
    list.innerHTML = '<p style="font-size:0.8rem;color:#ff3b30;margin:0;text-align:center;padding:12px;">Failed to load muted users.</p>';
  }
}

async function unmuteUser(number) {
  if (!number || !activeInstanceSlug) return;
  try {
    const res = await apiFetch(`/api/instances/${activeInstanceSlug}/unmute-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || `User +${number} unmuted.`, 'success');
      const input = document.getElementById('unmute-number-input');
      if (input) input.value = '';
      await loadMutedUsers();
    } else {
      showToast(data.error || 'Failed to unmute user.', 'error');
    }
  } catch (err) {
    showToast('Network error while unmuting user.', 'error');
  }
}

const refreshMutedBtn = document.getElementById('refresh-muted-btn');
if (refreshMutedBtn) {
  refreshMutedBtn.addEventListener('click', loadMutedUsers);
}

const unmuteUserBtn = document.getElementById('unmute-user-btn');
if (unmuteUserBtn) {
  unmuteUserBtn.addEventListener('click', () => {
    const input = document.getElementById('unmute-number-input');
    const number = (input ? input.value : '').trim();
    if (!number) { showToast('Please enter a phone number to unmute.', 'error'); return; }
    unmuteUser(number);
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Blocked (Permanently Ignored) Users Panel ────────────────────────────────
async function loadBlockedUsers() {
  const list = document.getElementById('blocked-users-list');
  if (!list || !activeInstanceSlug) return;
  list.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted);margin:0;text-align:center;padding:12px;">Loading...</p>';
  try {
    const res = await apiFetch(`/api/instances/${activeInstanceSlug}/ignored-users`);
    const data = await res.json();
    if (!data.ignored || data.ignored.length === 0) {
      list.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted);margin:0;text-align:center;padding:12px;">✅ No users are permanently blocked.</p>';
      return;
    }
    list.innerHTML = data.ignored.map(number => `
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;
        padding:10px 14px;background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.25);
        border-radius:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <i data-lucide="ban" style="width:15px;height:15px;color:#ff3b30;flex-shrink:0;"></i>
          <span style="font-size:0.85rem;font-weight:600;color:var(--text-light);">+${number}</span>
          <span style="font-size:0.72rem;color:#ff3b30;background:rgba(255,59,48,0.15);padding:2px 8px;border-radius:20px;">Permanently Blocked</span>
        </div>
        <button class="btn btn-secondary btn-sm unblock-inline-btn"
          data-number="${number}"
          style="background:linear-gradient(135deg,#30d158 0%,#25a244 100%);border-color:transparent;color:white;font-size:0.75rem;padding:5px 10px;">
          <i data-lucide="user-check" style="width:12px;height:12px;margin-right:4px;"></i> Unblock
        </button>
      </div>`).join('');

    if (window.lucide) lucide.createIcons();

    list.querySelectorAll('.unblock-inline-btn').forEach(btn => {
      btn.addEventListener('click', () => unblockUser(btn.dataset.number));
    });
  } catch (err) {
    list.innerHTML = '<p style="font-size:0.8rem;color:#ff3b30;margin:0;text-align:center;padding:12px;">Failed to load blocked users.</p>';
  }
}

async function unblockUser(number) {
  if (!number || !activeInstanceSlug) return;
  try {
    const res = await apiFetch(`/api/instances/${activeInstanceSlug}/unblock-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || `User +${number} unblocked.`, 'success');
      const input = document.getElementById('unblock-number-input');
      if (input) input.value = '';
      await loadBlockedUsers();
    } else {
      showToast(data.error || 'Failed to unblock user.', 'error');
    }
  } catch (err) {
    showToast('Network error while unblocking user.', 'error');
  }
}

const refreshBlockedBtn = document.getElementById('refresh-blocked-btn');
if (refreshBlockedBtn) {
  refreshBlockedBtn.addEventListener('click', loadBlockedUsers);
}

const unblockUserBtn = document.getElementById('unblock-user-btn');
if (unblockUserBtn) {
  unblockUserBtn.addEventListener('click', () => {
    const input = document.getElementById('unblock-number-input');
    const number = (input ? input.value : '').trim();
    if (!number) { showToast('Please enter a phone number to unblock.', 'error'); return; }
    unblockUser(number);
  });
}
// ─────────────────────────────────────────────────────────────────────────────

if (clearAiMemoryBtn) {
  clearAiMemoryBtn.addEventListener('click', async () => {
    if (!confirm('Are you absolutely sure you want to clear all conversational memory context history for this active bot? This resets the AI chat history for all of your contacts!')) {
      return;
    }
    
    clearAiMemoryBtn.disabled = true;
    const originalBtnText = clearAiMemoryBtn.innerHTML;
    clearAiMemoryBtn.innerHTML = '<span>Clearing Memory...</span>';
    
    try {
      const res = await apiFetch('/api/memory', { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        showToast(`Bot conversational memory cleared successfully! (${data.deletedCount || 0} contacts reset)`, 'success');
      } else {
        const errData = await res.json();
        showToast(errData.error || 'Failed to clear memory.', 'error');
      }
    } catch (err) {
      showToast('Network error, failed to clear bot memory.', 'error');
    } finally {
      clearAiMemoryBtn.disabled = false;
      clearAiMemoryBtn.innerHTML = originalBtnText;
    }
  });
}

// Initial API triggers on page load
async function init() {
  const token = localStorage.getItem('token');
  const username = localStorage.getItem('username');
  
  if (!token) {
    authPortal.classList.add('active');
    document.querySelector('.app-container').style.display = 'none';
    dashboardLogoutBtn.style.display = 'none';
    botSelectorWrapper.style.display = 'none';
    return;
  }
  
  authPortal.classList.remove('active');
  document.querySelector('.app-container').style.display = 'flex';
  dashboardLogoutBtn.style.display = 'flex';
  botSelectorWrapper.style.display = 'flex';
  
  // Set instance slug parameter from localStorage cache or fallback
  const storedSlug = localStorage.getItem('activeInstanceSlug');
  activeInstanceSlug = storedSlug || 'primary';

  // Set brand subtext to show admin's panel name
  const brandSubText = document.querySelector('.brand-text span');
  if (brandSubText) {
    brandSubText.textContent = `${username}'s Hub`;
  }

  lucide.createIcons();
  
  try {
    // 1. Fetch active engines from server
    const instancesRes = await apiFetch('/api/instances');
    allInstances = await instancesRes.json();
    populateHeaderDropdown();
    
    // 2. Synchronize selected engine details
    await syncActiveInstanceData();
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      showToast('System backend is currently unresponsive. Ensure Node server is running.', 'error');
    }
  }
}

// Check auth state on startup
const startupToken = localStorage.getItem('token');
if (startupToken) {
  const storedSlug = localStorage.getItem('activeInstanceSlug');
  activeInstanceSlug = storedSlug || 'primary';
  connectSocket();
  init();
} else {
  authPortal.classList.add('active');
  document.querySelector('.app-container').style.display = 'none';
  dashboardLogoutBtn.style.display = 'none';
  botSelectorWrapper.style.display = 'none';
  lucide.createIcons();
}
