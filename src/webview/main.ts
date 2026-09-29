/**
 * Webview entry point — thin wiring layer.
 * Imports modules, grabs DOM refs, connects event handlers.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ToWebview, FromWebview, TodoItem } from '../types';
import { createInitialState } from './state';
import {
  acknowledgeStartedQueuedMessage,
  createComposerRequestId,
  editQueuedMessage,
  hydrateWebviewQueueState,
  registerSubmittedWebviewMessage,
} from '../webviewQueue';
import { isKnownSlashCommand } from '../slashCommands';
import { primaryAgentActivity, shouldPulseComposer } from '../agentActivity';
import { renderQueuedMessagesMarkup } from './queueControls';
import {
  renderMarkdown, appendDiv, appendMessage, showWaiting,
  formatToolDisplay, renderTodoOverlay, detectTodoUpdate,
  loadHistory, fmtTok,
} from './renderers';
import {
  closeAllDropdowns, buildSessionPicker, setupSessionPickerHandlers,
  buildProfileMenu, setupProfileHandlers,
  buildSkillsMenu, setupSkillsHandlers, updateStatusBar,
  buildSlashCommandMenu, renderAgentActivityBar,
} from './menus';

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();
marked.setOptions({ breaks: true, gfm: true });

// ── State ────────────────────────────────────────────
const S = createInitialState();

// ── DOM refs ─────────────────────────────────────────
const messagesEl       = document.getElementById('messages')!;
const inputEl          = document.getElementById('input') as HTMLTextAreaElement;
const attachBtn        = document.getElementById('attach-btn') as HTMLButtonElement;
const attachChip       = document.getElementById('attach-chip') as HTMLDivElement;
const sendBtn          = document.getElementById('send-btn') as HTMLButtonElement;
const busyBtns         = document.getElementById('busy-btns') as HTMLDivElement;
const stopBtn          = document.getElementById('stop-btn') as HTMLButtonElement;
const queueBtn         = document.getElementById('queue-btn') as HTMLButtonElement;
const queueStatus      = document.getElementById('queue-status') as HTMLDivElement;
const queueItems       = document.getElementById('queue-items') as HTMLDivElement;
const dragHandle       = document.getElementById('input-drag') as HTMLDivElement;
const inputRow         = document.getElementById('input-row') as HTMLDivElement;
const composer         = document.getElementById('composer') as HTMLDivElement;
const statusSessionEl  = document.getElementById('status-session') as HTMLButtonElement;
const newSessionBtn    = document.getElementById('new-session-btn') as HTMLButtonElement;
const statusContextEl  = document.getElementById('status-context')!;
const statusVersionEl  = document.getElementById('status-version')!;
const ctxBarWrap       = document.getElementById('ctx-bar-wrap') as HTMLDivElement;
const ctxBar           = document.getElementById('ctx-bar') as HTMLDivElement;
const ctxBarFresh      = document.getElementById('ctx-bar-fresh') as HTMLDivElement;
const modelBtnHeader   = document.getElementById('model-btn-header') as HTMLButtonElement;
const modelMenu        = document.getElementById('model-menu') as HTMLDivElement;
const profileBtnHeader = document.getElementById('profile-btn-header') as HTMLButtonElement;
const profileLabelEl   = document.getElementById('profile-label') as HTMLSpanElement;
const profileMenu      = document.getElementById('profile-menu') as HTMLDivElement;
const overflowBtn      = document.getElementById('overflow-btn') as HTMLButtonElement;
const overflowMenu     = document.getElementById('overflow-menu') as HTMLDivElement;
const emptyState       = document.getElementById('empty-state') as HTMLDivElement;
const sessionPicker    = document.getElementById('session-picker') as HTMLDivElement;
const logoMark         = document.getElementById('logo-mark')!;
const todoOverlay      = document.getElementById('todo-overlay')!;
const backgroundProcessStatus = document.getElementById('background-process-status')!;
const skillsBtn        = document.getElementById('skills-btn') as HTMLButtonElement;
const skillsMenu       = document.getElementById('skills-menu') as HTMLDivElement;
const cmdArgPopover    = document.getElementById('cmd-arg-popover') as HTMLDivElement;
const remoteLoginOverlay   = document.getElementById('remote-login-overlay') as HTMLDivElement;
const remoteLoginForm      = document.getElementById('remote-login-form') as HTMLFormElement;
const remoteLoginEmail     = document.getElementById('remote-login-email') as HTMLInputElement;
const remoteLoginPassword  = document.getElementById('remote-login-password') as HTMLInputElement;
const remoteLoginSubmit    = document.getElementById('remote-login-submit') as HTMLButtonElement;
const remoteLoginError     = document.getElementById('remote-login-error') as HTMLDivElement;
const remoteLoginSkip      = document.getElementById('remote-login-skip') as HTMLButtonElement;
const remoteConnectedBanner  = document.getElementById('remote-connected-banner') as HTMLDivElement;
const remoteConnectedText    = document.getElementById('remote-connected-text') as HTMLSpanElement;
const remoteConnectedSignout = document.getElementById('remote-connected-signout') as HTMLButtonElement;
// The login screen re-renders every remoteAuthState message; a manual
// dismiss ("Continuar sem remote control") only lasts until the next one,
// which is fine -- it only re-fires on state changes, not on a timer.
let remoteLoginDismissed = false;
let lastRemoteAuthState: { remoteConfigured?: boolean; remotePaired?: boolean; remoteDeviceName?: string } = {};

const settingsBtnHeader    = document.getElementById('settings-btn-header') as HTMLButtonElement;
const settingsOverlay      = document.getElementById('settings-overlay') as HTMLDivElement;
const settingsClose        = document.getElementById('settings-close') as HTMLButtonElement;
const settingsPicker       = document.getElementById('settings-provider-picker') as HTMLSelectElement;
const settingsNameInput    = document.getElementById('settings-provider-name') as HTMLInputElement;
const settingsUrlInput     = document.getElementById('settings-provider-url') as HTMLInputElement;
const settingsModelInput   = document.getElementById('settings-provider-model') as HTMLInputElement;
const settingsKeyInput     = document.getElementById('settings-provider-key') as HTMLInputElement;
const settingsKeyHint      = document.getElementById('settings-key-hint') as HTMLSpanElement;
const settingsTestBtn      = document.getElementById('settings-test-btn') as HTMLButtonElement;
const settingsSaveBtn      = document.getElementById('settings-save-btn') as HTMLButtonElement;
const settingsRemoveBtn    = document.getElementById('settings-remove-btn') as HTMLButtonElement;
const settingsTestResult   = document.getElementById('settings-test-result') as HTMLDivElement;
const settingsError        = document.getElementById('settings-error') as HTMLDivElement;
const settingsRemoteStatus = document.getElementById('settings-remote-status') as HTMLDivElement;
const settingsRemoteSignout = document.getElementById('settings-remote-signout') as HTMLButtonElement;
// Which saved profile the form currently represents -- '' means "+ New
// profile", so Save creates a second profile instead of overwriting
// whichever one happened to be active (see chatPanel.ts's ProviderSettingsInput doc).
let settingsCurrentId = '';
const cmdArgInput      = document.getElementById('cmd-arg-input') as HTMLInputElement;
const cmdArgLabel      = document.getElementById('cmd-arg-label') as HTMLElement;
const agentActivityBar = document.getElementById('agent-activity-bar') as HTMLDivElement;

// The host owns the live queue across webview disposal. Keep submission controls
// unavailable until the ready handshake restores that runtime state.
inputEl.disabled = true;
sendBtn.disabled = true;
queueBtn.disabled = true;

const dropdownEls = { modelMenu, sessionPicker, skillsMenu, overflowMenu, profileMenu, cmdArgPopover };
const statusEls = { statusVersionEl, modelBtnHeader, modelMenu, statusSessionEl, statusContextEl, ctxBarWrap, ctxBar, ctxBarFresh };
const closeFn = () => closeAllDropdowns(dropdownEls);

function renderAgentBar(): void {
  renderAgentActivityBar(
    agentActivityBar,
    primaryAgentActivity(
      S.isBusy,
      S.currentContextUsed,
      S.knownContextSize || undefined,
      S.currentCompressionCount,
    ),
    S.agentActivities,
  );
  composer.classList.toggle('busy-glow', shouldPulseComposer(S.isBusy, S.agentActivities));
}

// ── Helpers ──────────────────────────────────────────
function setBusy(active: boolean, queued = 0): void {
  S.isBusy = active;
  renderAgentBar();
  logoMark.classList.toggle('busy', active);
  sendBtn.style.display = active ? 'none' : 'block';
  busyBtns.style.display = active ? 'flex' : 'none';
  if (queued > 0) {
    queueStatus.style.display = 'block';
    queueStatus.textContent = `${queued} queued`;
  } else {
    queueStatus.style.display = 'none';
    queueStatus.textContent = '';
  }
  renderQueuedMessages();
  requestAnimationFrame(syncComposerHeight);
}

function renderQueuedMessages(): void {
  queueItems.innerHTML = DOMPurify.sanitize(renderQueuedMessagesMarkup(
    S.pendingQueuedMessages,
    S.editingQueuedRequestId,
  ));
  queueItems.style.display = S.pendingQueuedMessages.length > 0 ? 'flex' : 'none';
  if (S.editingQueuedRequestId) {
    const editor = queueItems.querySelector<HTMLTextAreaElement>('.queued-edit-input');
    editor?.focus();
    editor?.setSelectionRange(editor.value.length, editor.value.length);
  }
}

function syncComposerHeight(): void {
  const target = Math.max(44, inputRow.offsetHeight - 10);
  inputEl.style.height = `${target}px`;
}

// Smart scroll — only auto-scroll if the user is near the bottom of the
// messages pane. If they've scrolled up to read earlier content, don't
// yank them back down. Threshold: within 80px of the bottom.
function shouldAutoScroll(): boolean {
  const el = messagesEl;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function autoScroll(): void {
  if (shouldAutoScroll()) messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
}

// Render markdown on a short interval (200ms). Each flush accumulates text
// and schedules a render — the timer coalesces bursts of chunks so we don't
// call marked.parse() on every single token, but still render frequently
// enough to avoid the "plaintext then jump to formatted" flash.
function scheduleMarkdownRender(): void {
  if (S.markdownDebounceTimer) return; // already scheduled
  S.markdownDebounceTimer = setTimeout(() => {
    S.markdownDebounceTimer = null;
    if (S.currentAgentEl && S.currentAgentText) {
      renderMarkdown(S.currentAgentEl, S.currentAgentText);
      autoScroll();
    }
  }, 200);
}

function flushPending(): void {
  if (!S.pendingText) { S.flushScheduled = false; return; }
  if (!S.currentAgentEl) {
    document.getElementById('turn-thinking')?.remove();
    document.getElementById('waiting')?.remove();
    S.currentAgentEl = appendDiv(messagesEl, 'msg agent');
  }
  S.currentAgentText += S.pendingText;
  S.pendingText = ''; S.flushScheduled = false;
  // Render markdown directly — no intermediate .textContent flash.
  // scheduleMarkdownRender coalesces at 100ms so rapid chunks don't
  // each trigger a full marked.parse() + innerHTML replacement.
  scheduleMarkdownRender();
}

function scheduleFlush(): void {
  if (!S.flushScheduled) { S.flushScheduled = true; setTimeout(flushPending, 0); }
}

// ── Send ─────────────────────────────────────────────
function send(): void {
  if (!S.queueHydrated) return;
  const text = inputEl.value.trim();
  if (!text) return;
  const requestId = createComposerRequestId(() => crypto.randomUUID());
  const isSlash = isKnownSlashCommand(text, S.availableCommands);
  registerSubmittedWebviewMessage(S, { requestId, text, isSlashCommand: isSlash });
  inputEl.value = '';
  inputEl.style.height = '';
  attachChip.style.display = 'none'; attachChip.innerHTML = '';
  S.selectedSkillNames.clear();
  skillsBtn.classList.remove('has-skills'); skillsBtn.textContent = '✦';
  if (emptyState) emptyState.style.display = 'none';
  // Rendering waits for the host's started/queued acknowledgement. The local
  // descriptor remains pending so neither direction of a busy-state race can
  // create a duplicate bubble or expose the wrong queue item.
  setBusy(true, S.prevQueueCount);
  vscode.postMessage({ type: 'send', text, requestId });
  requestAnimationFrame(syncComposerHeight);
}

/** Route every slash/menu action through the same queue-aware send path. */
function sendText(text: string): void {
  inputEl.value = text;
  send();
}

// ── Event wiring ─────────────────────────────────────

// Drag handle
let dragActive = false, dragStartY = 0, dragStartH = 0;
dragHandle.addEventListener('mousedown', (e) => {
  dragActive = true; dragStartY = e.clientY; dragStartH = inputEl.offsetHeight;
  document.body.style.userSelect = 'none'; e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!dragActive) return;
  inputEl.style.height = `${Math.max(44, Math.min(400, dragStartH + (dragStartY - e.clientY)))}px`;
});
document.addEventListener('mouseup', () => {
  if (dragActive) { dragActive = false; document.body.style.userSelect = ''; }
});

// Session picker
statusSessionEl.addEventListener('click', (e) => {
  e.stopPropagation(); const open = sessionPicker.style.display !== 'none';
  closeFn(); if (!open) sessionPicker.style.display = 'block';
});
setupSessionPickerHandlers(sessionPicker, vscode, S, closeFn);
newSessionBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeFn();
  vscode.postMessage({ type: 'newSession' } as any);
});

// Model switcher
modelBtnHeader.addEventListener('click', (e) => {
  e.stopPropagation(); const open = modelMenu.style.display !== 'none';
  closeFn(); if (!open) modelMenu.style.display = 'block';
});
modelMenu.addEventListener('click', (e) => {
  const opt = (e.target as HTMLElement).closest<HTMLElement>('.model-option');
  if (!opt?.dataset.command) return;
  closeFn(); vscode.postMessage({ type: 'switchModel', model: opt.dataset.command });
});

// Profile switcher
profileBtnHeader.addEventListener('click', (e) => {
  e.stopPropagation(); const open = profileMenu.style.display !== 'none';
  closeFn(); if (!open) profileMenu.style.display = 'block';
});
setupProfileHandlers(profileMenu, vscode, closeFn);

// Slash-command menu (hybrid dispatch: execute / confirm / prompt-for-arg)
function hideCmdArg(): void {
  cmdArgPopover.style.display = 'none';
  cmdArgInput.value = '';
  cmdArgInput.onkeydown = null;
}

function promptForArg(cmd: string, label: string): void {
  cmdArgLabel.textContent = label;
  cmdArgInput.value = '';
  cmdArgPopover.style.display = 'block';
  setTimeout(() => cmdArgInput.focus(), 0);
  cmdArgInput.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const arg = cmdArgInput.value.trim();
      hideCmdArg();
      if (arg) sendText(`${cmd} ${arg}`);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      hideCmdArg();
    }
  };
}

overflowBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = overflowMenu.style.display !== 'none';
  closeFn(); hideCmdArg();
  if (!open) {
    buildSlashCommandMenu(overflowMenu, S.availableCommands);
    overflowMenu.style.display = 'block';
  }
});

overflowMenu.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('.menu-item[data-cmd]');
  if (!item?.dataset.cmd) return;
  e.stopPropagation();
  const cmd  = item.dataset.cmd;
  const mode = item.dataset.mode ?? 'execute';
  closeFn();

  if (mode === 'execute') {
    sendText(cmd);
  } else if (mode === 'confirm') {
    const msg = item.dataset.confirm ?? `Run ${cmd}?`;
    // eslint-disable-next-line no-alert
    if (confirm(msg)) sendText(cmd);
  } else if (mode === 'prompt') {
    promptForArg(cmd, item.dataset.argLabel ?? 'Argument');
  }
});

// Empty state prompt chips — send immediately on click
emptyState?.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.prompt-chip');
  if (!chip?.dataset.prompt) return;
  inputEl.value = chip.dataset.prompt;
  send();
});

// File attachment
attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachFile' }));
attachChip.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).classList.contains('chip-x')) {
    attachChip.style.display = 'none'; attachChip.innerHTML = '';
    vscode.postMessage({ type: 'clearAttachments' } as any);
  }
});

// Clipboard paste
document.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      e.preventDefault();
      const blob = items[i].getAsFile();
      if (!blob) return;
      const reader = new FileReader();
      const ext = items[i].type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        vscode.postMessage({ type: 'pasteImage', data: base64, ext } as any);
      };
      reader.readAsDataURL(blob); return;
    }
  }
  const files = e.clipboardData?.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) {
        e.preventDefault();
        const ext = files[i].type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          vscode.postMessage({ type: 'pasteImage', data: base64, ext } as any);
        };
        reader.readAsDataURL(files[i]); return;
      }
    }
  }
});

// Drag & drop
document.body.addEventListener('dragover', (e) => {
  e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  messagesEl.style.outline = '2px dashed rgba(245,197,66,0.5)';
  messagesEl.style.outlineOffset = '-4px';
});
document.body.addEventListener('dragleave', () => {
  messagesEl.style.outline = ''; messagesEl.style.outlineOffset = '';
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  messagesEl.style.outline = ''; messagesEl.style.outlineOffset = '';
  const uriList = e.dataTransfer?.getData('text/uri-list');
  if (uriList) {
    const paths = uriList.split('\n').map(u => u.trim()).filter(Boolean);
    if (paths.length > 0) vscode.postMessage({ type: 'dropFiles', uris: paths } as any);
  }
});

// Skills picker
skillsBtn.addEventListener('click', (e) => {
  e.stopPropagation(); const open = skillsMenu.style.display !== 'none';
  closeFn(); if (!open) { buildSkillsMenu(skillsMenu, S); skillsMenu.style.display = 'block'; }
});
setupSkillsHandlers(skillsMenu, skillsBtn, vscode, S);

// Slash commands
document.querySelectorAll<HTMLButtonElement>('.cmd-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cmd = btn.dataset.cmd; if (!cmd) return;
    sendText(cmd);
  });
});

// Send / stop / queue
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
queueBtn.addEventListener('click', send);
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

queueItems.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  const row = button?.closest<HTMLElement>('.queued-item[data-request-id]');
  const requestId = row?.dataset.requestId;
  const action = button?.dataset.action;
  if (!button || !row || !requestId || !action) return;

  if (action === 'edit') {
    S.editingQueuedRequestId = requestId;
    renderQueuedMessages();
    return;
  }
  if (action === 'cancel') {
    S.editingQueuedRequestId = undefined;
    renderQueuedMessages();
    return;
  }
  if (action === 'delete') {
    // Native browser confirm() dialogs are blocked by VS Code's sandboxed
    // webview. Ask the Extension Host to use VS Code's supported modal UI and
    // wait for its authoritative queueState response before changing the row.
    vscode.postMessage({ type: 'deleteQueuedMessage', requestId });
    return;
  }
  if (action === 'save') {
    const editor = row.querySelector<HTMLTextAreaElement>('.queued-edit-input');
    const text = editor?.value.trim();
    if (!text) {
      editor?.focus();
      return;
    }
    editQueuedMessage(S.pendingQueuedMessages, requestId, text, isKnownSlashCommand(text, S.availableCommands));
    S.editingQueuedRequestId = undefined;
    renderQueuedMessages();
    vscode.postMessage({ type: 'editQueuedMessage', requestId, text });
  }
});

// Close dropdowns on outside click
document.addEventListener('click', closeFn);

// Resize
window.addEventListener('resize', () => requestAnimationFrame(syncComposerHeight));
requestAnimationFrame(syncComposerHeight);

// ── Remote control (RIA Atendimento) login ────────────
remoteLoginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = remoteLoginEmail.value.trim();
  const password = remoteLoginPassword.value;
  if (!email || !password) return;
  remoteLoginError.style.display = 'none';
  remoteLoginSubmit.disabled = true;
  remoteLoginSubmit.textContent = 'Entrando…';
  vscode.postMessage({ type: 'remoteLogin', text: email, data: password } as any);
});
remoteLoginSkip.addEventListener('click', () => {
  remoteLoginDismissed = true;
  remoteLoginOverlay.style.display = 'none';
});
remoteConnectedSignout.addEventListener('click', () => {
  vscode.postMessage({ type: 'remoteLogout' } as any);
});

// ── Settings screen (gear icon) ────────────────────────
function renderSettingsRemoteSection(): void {
  if (lastRemoteAuthState.remotePaired) {
    settingsRemoteStatus.textContent = `Connected as "${lastRemoteAuthState.remoteDeviceName ?? ''}"`;
    settingsRemoteSignout.style.display = 'block';
  } else if (lastRemoteAuthState.remoteConfigured) {
    settingsRemoteStatus.textContent = 'Not signed in.';
    settingsRemoteSignout.style.display = 'none';
  } else {
    settingsRemoteStatus.textContent = 'Not configured (hermesRangelTech.remote.baseUrl is empty).';
    settingsRemoteSignout.style.display = 'none';
  }
}
settingsBtnHeader.addEventListener('click', () => {
  settingsError.style.display = 'none';
  settingsTestResult.style.display = 'none';
  renderSettingsRemoteSection();
  settingsOverlay.style.display = 'block';
  vscode.postMessage({ type: 'settingsOpen' } as any);
});
settingsClose.addEventListener('click', () => { settingsOverlay.style.display = 'none'; });
settingsRemoteSignout.addEventListener('click', () => { vscode.postMessage({ type: 'remoteLogout' } as any); });
function settingsDraft() {
  return {
    providerId: settingsCurrentId || undefined,
    providerName: settingsNameInput.value.trim(),
    providerBaseUrl: settingsUrlInput.value.trim(),
    providerModel: settingsModelInput.value.trim(),
    providerApiKey: settingsKeyInput.value || undefined,
  };
}
function clearSettingsFormForNewProfile() {
  settingsCurrentId = '';
  settingsNameInput.value = ''; settingsUrlInput.value = ''; settingsModelInput.value = ''; settingsKeyInput.value = '';
  settingsKeyHint.textContent = '';
  settingsRemoveBtn.style.display = 'none';
  settingsTestResult.style.display = 'none'; settingsError.style.display = 'none';
}
settingsPicker.addEventListener('change', () => {
  if (!settingsPicker.value) { clearSettingsFormForNewProfile(); return; }
  settingsTestBtn.disabled = true; settingsSaveBtn.disabled = true;
  vscode.postMessage({ type: 'settingsSelectProvider', providerId: settingsPicker.value } as any);
});
settingsTestBtn.addEventListener('click', () => {
  settingsError.style.display = 'none';
  settingsTestResult.style.display = 'none';
  settingsTestBtn.disabled = true; settingsSaveBtn.disabled = true;
  vscode.postMessage({ type: 'settingsTestProvider', ...settingsDraft() } as any);
});
settingsSaveBtn.addEventListener('click', () => {
  settingsError.style.display = 'none';
  settingsTestBtn.disabled = true; settingsSaveBtn.disabled = true;
  vscode.postMessage({ type: 'settingsSaveProvider', ...settingsDraft() } as any);
});
settingsRemoveBtn.addEventListener('click', () => {
  if (!settingsCurrentId) return;
  settingsTestBtn.disabled = true; settingsSaveBtn.disabled = true;
  vscode.postMessage({ type: 'settingsRemoveProvider', providerId: settingsCurrentId } as any);
});

// ── Message handler ──────────────────────────────────
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as ToWebview;

  switch (msg.type) {
    case 'append':
      S.pendingText += msg.text ?? '';
      scheduleFlush();
      break;

    case 'backgroundNotification': {
      const notification = appendMessage(messagesEl, 'agent', msg.text ?? '');
      renderMarkdown(notification, msg.text ?? '');
      autoScroll();
      break;
    }

    case 'thinking':
      if (!S.thinkingStatusEl) {
        document.getElementById('waiting')?.remove();
        S.thinkingStatusEl = appendDiv(messagesEl, 'status-line thinking-status');
        S.thinkingStatusEl.id = 'turn-thinking';
      }
      S.thinkingStatusEl.textContent = msg.text ?? '';
      break;

    case 'toolCall': {
      if (!msg.toolName && msg.toolCallId) {
        const existing = document.querySelector(`[data-tool-id="${msg.toolCallId}"]`);
        if (existing) {
          const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
          const isError = msg.toolStatus === 'error';
          const statusEl = existing.querySelector('.tool-status');
          if (statusEl) {
            statusEl.textContent = isDone ? '✓' : isError ? '✗' : '⋯';
            statusEl.className = `tool-status${isDone ? ' done' : isError ? ' error' : ''}`;
          }
        }
        break;
      }
      if (S.pendingText) flushPending();
      if (S.currentAgentEl && S.currentAgentText) renderMarkdown(S.currentAgentEl, S.currentAgentText);
      S.currentAgentEl = null; S.currentAgentText = '';
      document.getElementById('waiting')?.remove();
      const isDone = msg.toolStatus === 'done' || msg.toolStatus === 'completed';
      const isError = msg.toolStatus === 'error';
      const statusIcon = isDone ? '✓' : isError ? '✗' : '⋯';
      const statusClass = isDone ? ' done' : isError ? ' error' : '';
      const toolEl = appendDiv(messagesEl, 'msg tool');
      if (msg.toolCallId) toolEl.dataset.toolId = msg.toolCallId;
      const { label, info } = formatToolDisplay(msg.toolName ?? '', msg.toolKind, msg.toolLocations, msg.toolDetail);
      const infoHtml = info ? `<span class="tool-detail">${DOMPurify.sanitize(info)}</span>` : '';
      toolEl.innerHTML = `<span class="tool-status${statusClass}">${statusIcon}</span><span class="tool-name">${label}</span>${infoHtml}`;
      autoScroll();
      break;
    }

    case 'queueState': {
      const active = msg.active ?? false;
      const queued = msg.queued ?? 0;
      hydrateWebviewQueueState(S, {
        active,
        queued,
        activeSlashCommand: msg.activeSlashCommand ?? false,
        queuedItems: msg.queuedItems ?? [],
      });
      S.editingQueuedRequestId = undefined;
      inputEl.disabled = false;
      sendBtn.disabled = false;
      queueBtn.disabled = false;
      setBusy(active, queued);
      inputEl.focus();
      break;
    }

    case 'busy': {
      const newQueued = msg.queued ?? 0;
      if (msg.active && msg.startedText !== undefined && msg.startedSlashCommand !== undefined) {
        const next = acknowledgeStartedQueuedMessage(
          S,
          msg.startedText,
          msg.startedSlashCommand,
          msg.startedRequestId,
        );
        S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null; S.pendingText = '';
        if (next?.renderUserMessage) {
          appendMessage(messagesEl, 'user', next.text);
        }
        if (next?.showWaiting) showWaiting(messagesEl);
      }
      if (msg.queuedItems !== undefined) {
        S.pendingQueuedMessages = msg.queuedItems.map(message => ({ ...message }));
        if (S.editingQueuedRequestId && !S.pendingQueuedMessages.some(
          message => message.requestId === S.editingQueuedRequestId,
        )) S.editingQueuedRequestId = undefined;
      }
      S.prevQueueCount = newQueued;
      setBusy(msg.active ?? false, newQueued);
      break;
    }

    case 'done':
      if (S.pendingText) flushPending();
      if (S.markdownDebounceTimer) { clearTimeout(S.markdownDebounceTimer); S.markdownDebounceTimer = null; }
      document.getElementById('waiting')?.remove();
      document.getElementById('turn-thinking')?.remove();
      if (S.currentAgentEl && S.currentAgentText) {
        // If this turn was a slash command, restyle the bubble as a centered
        // "system" message instead of a normal agent reply. The content is
        // canned adapter output, not an LLM response — the visual treatment
        // should reflect that.
        if (S.pendingSlashResponse) {
          S.currentAgentEl.classList.remove('agent');
          S.currentAgentEl.classList.add('system');
        } else {
          detectTodoUpdate(S.currentAgentText, todoOverlay);
        }
        renderMarkdown(S.currentAgentEl, S.currentAgentText);
        autoScroll();
      }
      // YOLO state feedback — parse the adapter's /yolo response ("⚡ YOLO mode: ON — ..."
      // or "⚠ YOLO mode: OFF — ...") and toggle the red composer glow. Ground-truth
      // driven: the glow reflects the real HERMES_YOLO_MODE env var inside the
      // adapter subprocess, not an optimistic client guess.
      {
        const m = /YOLO mode:\s*(ON|OFF)/i.exec(S.currentAgentText);
        if (m) composer.classList.toggle('yolo', m[1].toUpperCase() === 'ON');
      }
      S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null;
      S.pendingSlashResponse = false;
      inputEl.focus();
      break;

    case 'error':
      if (S.pendingText) flushPending();
      if (S.markdownDebounceTimer) { clearTimeout(S.markdownDebounceTimer); S.markdownDebounceTimer = null; }
      document.getElementById('waiting')?.remove();
      document.getElementById('turn-thinking')?.remove();
      appendMessage(messagesEl, 'error', `Error: ${msg.text}`);
      S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null;
      break;

    case 'status':
      if (msg.status === 'connecting')       appendMessage(messagesEl, 'tool', 'Connecting to Hermes…');
      else if (msg.status === 'connected')   appendMessage(messagesEl, 'tool', 'Connected');
      else if (msg.status === 'disconnected') {
        appendMessage(messagesEl, 'error', 'Hermes disconnected');
        setBusy(false);
      }
      break;

    case 'notice': {
      const notice = appendDiv(messagesEl, 'status-line');
      notice.textContent = msg.text ?? '';
      autoScroll();
      break;
    }

    case 'clear':
      messagesEl.innerHTML = '';
      S.pendingQueuedMessages = []; S.prevQueueCount = 0; S.knownContextSize = 0; S.flushScheduled = false;
      S.currentContextUsed = undefined; S.currentCompressionCount = undefined;
      S.agentActivities = []; S.availableCommands = [];
      S.editingQueuedRequestId = undefined;
      ctxBarWrap.style.display = 'none';
      S.currentAgentEl = null; S.currentAgentText = ''; S.thinkingStatusEl = null; S.pendingText = '';
      setBusy(false);
      statusContextEl.textContent = ''; statusContextEl.className = '';
      backgroundProcessStatus.className = ''; backgroundProcessStatus.innerHTML = '';
      buildSlashCommandMenu(overflowMenu, S.availableCommands);
      renderAgentBar();
      break;

    case 'statusBar': {
      updateStatusBar(S, statusEls, msg.model, msg.sessionTitle, msg.contextUsed, msg.contextSize, msg.version, msg.cachedTokens);
      if (msg.compressionCount !== undefined) S.currentCompressionCount = msg.compressionCount;
      if (msg.availableCommands !== undefined) {
        S.availableCommands = msg.availableCommands.map(command => ({ ...command }));
        buildSlashCommandMenu(overflowMenu, S.availableCommands);
      }
      if (msg.agentActivities !== undefined) {
        S.agentActivities = msg.agentActivities.map(activity => ({ ...activity }));
      }
      renderAgentBar();
      if (msg.skillGroups && msg.skillGroups.length > 0) S.skillGroupsData = msg.skillGroups;
      if (msg.selectedSkills !== undefined) {
        S.selectedSkillNames = new Set(msg.selectedSkills);
        skillsBtn.classList.toggle('has-skills', S.selectedSkillNames.size > 0);
        skillsBtn.textContent = S.selectedSkillNames.size > 0 ? `✦${S.selectedSkillNames.size}` : '✦';
      }
      if (msg.backgroundProcesses !== undefined) {
        const processes = msg.backgroundProcesses;
        if (processes.length > 0) {
          const ids = processes.map(process => process.id).join(', ');
          backgroundProcessStatus.className = 'active';
          backgroundProcessStatus.replaceChildren();
          const dot = document.createElement('span'); dot.className = 'process-dot';
          const label = document.createElement('span'); label.className = 'process-label'; label.textContent = 'Background work active';
          const idList = document.createElement('span'); idList.className = 'process-ids'; idList.textContent = ids;
          backgroundProcessStatus.append(dot, label, idList);
        } else {
          backgroundProcessStatus.className = '';
          backgroundProcessStatus.innerHTML = '';
        }
      }
      if (msg.todoState && typeof msg.todoState === 'object') {
        const state = msg.todoState as { todos?: TodoItem[] };
        if (state.todos) renderTodoOverlay(todoOverlay, state.todos);
      }
      if (msg.contextAnnotation) {
        const userMsgs = messagesEl.querySelectorAll('.msg.user');
        const lastUser = userMsgs[userMsgs.length - 1];
        if (lastUser) {
          const anno = document.createElement('div');
          anno.className = 'context-annotation';
          anno.innerHTML = DOMPurify.sanitize(msg.contextAnnotation, {
            ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'],
          });
          lastUser.appendChild(anno);
        }
      }
      if (msg.attachedFiles !== undefined) {
        if (msg.attachedFiles && msg.attachedFiles.length > 0) {
          attachChip.innerHTML = msg.attachedFiles.map((f: {name: string}) =>
            `⊕ <span class="chip-name">${f.name}</span>`
          ).join(' ') + ' <span class="chip-x">✕</span>';
          attachChip.style.display = 'flex';
        } else {
          attachChip.style.display = 'none'; attachChip.innerHTML = '';
        }
      }
      break;
    }

    case 'profileList': {
      S.currentProfile = msg.profile ?? '';
      S.profileRestartRequired = !!msg.restartRequired;
      const activeProfileItem = msg.profileItems?.find(item => item.active);
      profileLabelEl.textContent = activeProfileItem?.label ?? (S.currentProfile || 'Default');
      profileBtnHeader.classList.toggle('restart-required', S.profileRestartRequired);
      profileBtnHeader.title = S.profileRestartRequired
        ? 'Switch Hermes profile (restart required to apply current selection)'
        : 'Switch Hermes profile';
      buildProfileMenu(profileMenu, msg.profileItems ?? [], S.profileRestartRequired);
      break;
    }

    case 'sessionList':
      if (msg.sessions && msg.activeSessionId !== undefined) {
        buildSessionPicker(sessionPicker, msg.sessions, msg.activeSessionId, statusSessionEl, S);
      }
      break;

    case 'loadHistory':
      loadHistory(messagesEl, msg.history ?? [], msg.switched ?? false);
      break;

    case 'remoteAuthState': {
      lastRemoteAuthState = {
        remoteConfigured: msg.remoteConfigured, remotePaired: msg.remotePaired, remoteDeviceName: msg.remoteDeviceName,
      };
      if (settingsOverlay.style.display !== 'none') renderSettingsRemoteSection();
      if (!msg.remoteBusy) {
        remoteLoginSubmit.disabled = false;
        remoteLoginSubmit.textContent = 'Entrar no RIA Atendimento';
      }
      if (msg.remoteError) {
        remoteLoginError.textContent = msg.remoteError;
        remoteLoginError.style.display = 'block';
      }
      if (msg.remotePaired) {
        remoteLoginOverlay.style.display = 'none';
        remoteLoginPassword.value = '';
        remoteConnectedBanner.style.display = 'flex';
        remoteConnectedText.textContent = `Hermes agente: conectado como "${msg.remoteDeviceName ?? ''}"`;
      } else {
        remoteConnectedBanner.style.display = 'none';
        const shouldShow = Boolean(msg.remoteConfigured) && !remoteLoginDismissed;
        remoteLoginOverlay.style.display = shouldShow ? 'flex' : 'none';
      }
      break;
    }

    case 'settingsState': {
      settingsTestBtn.disabled = false; settingsSaveBtn.disabled = false;
      // Only overwrite the fields the person hasn't started typing into --
      // a save/test round trip must not clobber an in-progress edit.
      if (document.activeElement !== settingsNameInput) settingsNameInput.value = msg.settingsProviderName ?? '';
      if (document.activeElement !== settingsUrlInput) settingsUrlInput.value = msg.settingsProviderBaseUrl ?? '';
      if (document.activeElement !== settingsModelInput) settingsModelInput.value = msg.settingsProviderModel ?? '';
      settingsKeyHint.textContent = msg.settingsProviderHasKey ? '(a key is already stored)' : '(none stored yet)';

      const profiles = msg.settingsProfiles ?? [];
      const activeProfile = profiles.find(p => p.active);
      settingsCurrentId = activeProfile?.id ?? '';
      settingsPicker.textContent = '';
      for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name; opt.selected = p.id === settingsCurrentId;
        settingsPicker.appendChild(opt);
      }
      const newOpt = document.createElement('option');
      newOpt.value = ''; newOpt.textContent = '+ New profile'; newOpt.selected = !settingsCurrentId;
      settingsPicker.appendChild(newOpt);
      settingsRemoveBtn.style.display = settingsCurrentId ? 'block' : 'none';

      if (msg.settingsRemoved) {
        settingsTestResult.textContent = 'Profile removed.';
        settingsTestResult.className = 'settings-test-result ok';
        settingsTestResult.style.display = 'block';
      }
      if (msg.settingsError) {
        settingsError.textContent = msg.settingsError;
        settingsError.style.display = 'block';
      }
      if (msg.settingsTestSummary) {
        settingsTestResult.textContent = msg.settingsTestSummary;
        settingsTestResult.className = `settings-test-result ${msg.settingsTestOk ? 'ok' : 'fail'}`;
        settingsTestResult.style.display = 'block';
      }
      if (msg.settingsSaved) {
        settingsKeyInput.value = '';
        settingsTestResult.textContent = 'Saved.';
        settingsTestResult.className = 'settings-test-result ok';
        settingsTestResult.style.display = 'block';
      }
      break;
    }
  }
});

// Replace arbitrary initialization delays with an explicit host handshake. The
// host replies with queueState before enabling submission controls.
vscode.postMessage({ type: 'ready' });
