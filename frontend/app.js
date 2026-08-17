const API_BASE = (window.__DEEP_SEARCH_API_BASE__ || 'http://localhost:8000').replace(/\/$/, '');
const HISTORY_KEY = 'deep-search-pro.history.v1';

const state = {
  threadId: crypto.randomUUID(),
  socket: null,
  messages: [],
  uploadedFiles: [],
  outputDir: '',
  generatedFiles: [],
  busy: false,
};

const form = document.querySelector('#composer-form');
const queryInput = document.querySelector('#query-input');
const sendButton = document.querySelector('#send-button');
const messageList = document.querySelector('#message-list');
const fileInput = document.querySelector('#file-input');
const uploadedList = document.querySelector('#uploaded-list');
const uploadedCount = document.querySelector('#uploaded-count');
const generatedList = document.querySelector('#generated-list');
const newChatButton = document.querySelector('#new-chat-button');
const historyList = document.querySelector('#history-list');
const historyCount = document.querySelector('#history-count');

function renderMessage(message) {
  const item = document.createElement('div');
  item.textContent = message.content;
  return item;
}

function renderMessages() {
  messageList.replaceChildren();
  state.messages.forEach((message) => messageList.append(renderMessage(message)));
}

function renderFileNames(target, files) {
  target.replaceChildren();
  files.forEach((file) => {
    const item = document.createElement('div');
    item.textContent = file.name;
    target.append(item);
  });
}

function renderUploadedFiles() {
  renderFileNames(uploadedList, state.uploadedFiles);
  uploadedCount.textContent = String(state.uploadedFiles.length);
}

function createDownloadLink(file) {
  const link = document.createElement('a');
  link.href = `${API_BASE}/api/download?path=${encodeURIComponent(file.path)}`;
  link.textContent = '下载';
  link.setAttribute('download', file.name);
  return link;
}

function renderGeneratedFiles() {
  generatedList.replaceChildren();
  state.generatedFiles.forEach((file) => {
    const row = document.createElement('div');
    row.textContent = file.name;
    row.append(createDownloadLink(file));
    generatedList.append(row);
  });
}

function getHistory() {
  try {
    return JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function completedMessages() {
  return state.messages.filter((message) => !message.pending);
}

function saveCurrentHistory() {
  const firstUserMessage = state.messages.find((message) => message.role === 'user');
  if (!firstUserMessage) return;
  const history = getHistory().filter((item) => item.threadId !== state.threadId);
  history.unshift({
    threadId: state.threadId,
    title: firstUserMessage.content,
    messages: completedMessages(),
    outputDir: state.outputDir,
    uploadedFiles: state.uploadedFiles,
  });
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 30)));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  historyList.replaceChildren();
  historyCount.textContent = String(history.length);
  history.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.title;
    button.addEventListener('click', () => loadHistory(item));
    historyList.append(button);
  });
}

function renderSessionPanels() {
  renderMessages();
  renderUploadedFiles();
  renderGeneratedFiles();
}

function loadHistory(item) {
  if (state.busy) return;
  closeSocket();
  state.threadId = item.threadId;
  state.messages = item.messages || [];
  state.outputDir = item.outputDir || '';
  state.uploadedFiles = item.uploadedFiles || [];
  state.generatedFiles = [];
  renderSessionPanels();
  if (state.outputDir) refreshGeneratedFiles();
}

async function refreshGeneratedFiles() {
  if (!state.outputDir) return;
  const response = await fetch(`${API_BASE}/api/files?path=${encodeURIComponent(state.outputDir)}`);
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || '文件列表读取失败');
  state.generatedFiles = result.files || [];
  renderGeneratedFiles();
}

async function readExpectedResponse(response, expectedStatus, fallbackMessage) {
  const result = await response.json();
  if (!response.ok || result.status !== expectedStatus) {
    throw new Error(result.error || fallbackMessage);
  }
  return result;
}

async function uploadFiles(files) {
  if (!files.length) return;
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  formData.append('thread_id', state.threadId);

  const response = await fetch(`${API_BASE}/api/upload`, {
    method: 'POST',
    body: formData,
  });
  const result = await readExpectedResponse(response, 'uploaded', '上传失败');
  state.uploadedFiles = (result.files || []).map((name) => ({ name }));
  renderUploadedFiles();
}

function socketUrl() {
  const url = new URL(API_BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/ws/${encodeURIComponent(state.threadId)}`;
  url.search = '';
  return url.toString();
}

function settlePendingMessage(content) {
  const pending = [...state.messages].reverse().find((message) => message.pending);
  if (!pending) return;
  pending.content = content;
  pending.pending = false;
}

function finishTask(result) {
  settlePendingMessage(result);
  state.busy = false;
  sendButton.disabled = false;
  renderMessages();
  saveCurrentHistory();
}

function failTask(message) {
  settlePendingMessage(`无法启动任务：${message}`);
  state.busy = false;
  sendButton.disabled = false;
  renderMessages();
}

function handleSocketMessage(event) {
  const payload = JSON.parse(event.data);
  if (payload.type !== 'monitor_event') return;
  if (payload.event === 'session_created' && payload.data?.path) {
    state.outputDir = payload.data.path;
    refreshGeneratedFiles();
    return;
  }
  if (payload.event !== 'task_result') return;
  finishTask(payload.data?.result || payload.message || '任务已完成');
}

function connectSocket() {
  if (state.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl());
    state.socket = socket;
    socket.addEventListener('message', (event) => {
      if (state.socket === socket) handleSocketMessage(event);
    });
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
}

function closeSocket() {
  if (state.socket) state.socket.close();
  state.socket = null;
}

function clearSessionState() {
  state.messages = [];
  state.uploadedFiles = [];
  state.generatedFiles = [];
  state.outputDir = '';
  queryInput.value = '';
}

function newChat() {
  if (state.busy) return;
  closeSocket();
  state.threadId = crypto.randomUUID();
  clearSessionState();
  renderSessionPanels();
}

async function sendMessage(event) {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (!query || state.busy) return;

  state.busy = true;
  sendButton.disabled = true;
  state.messages.push({ role: 'user', content: query });
  state.messages.push({ role: 'assistant', content: '正在准备研究任务', pending: true });
  queryInput.value = '';
  renderMessages();

  try {
    await connectSocket();
    const response = await fetch(`${API_BASE}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, thread_id: state.threadId }),
    });
    await readExpectedResponse(response, 'started', '任务启动失败');
  } catch (error) {
    failTask(error.message);
  }
}

form.addEventListener('submit', sendMessage);
fileInput.addEventListener('change', (event) => {
  const upload = uploadFiles([...event.target.files]);
  event.target.value = '';
  return upload;
});
newChatButton.addEventListener('click', newChat);
renderHistory();
