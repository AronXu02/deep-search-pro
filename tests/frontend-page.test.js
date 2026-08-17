const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('用户打开页面后可以输入研究问题并发送任务', () => {
  const pagePath = path.join(__dirname, '..', 'frontend', 'index.html');
  const html = fs.readFileSync(pagePath, 'utf8');

  assert.match(html, /<title>Deep Search Pro<\/title>/);
  assert.match(html, /id="query-input"/);
  assert.match(html, /id="send-button"/);
  assert.match(html, /id="message-list"/);
});

test('页面提供基础样式并在窄屏下调整布局', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'styles.css'), 'utf8');

  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(styles, /box-sizing:\s*border-box/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)/);
});

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.href = '';
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, event = {}) {
    return this.listeners.get(type)?.(event);
  }

  append(...items) {
    this.children.push(...items);
  }

  replaceChildren(...items) {
    this.children = items;
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, payload = {}) {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN;
    this.listeners.get(type)?.(payload);
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

class FakeFormData {
  constructor() {
    this.fields = [];
  }

  append(name, value) {
    this.fields.push({ name, value });
  }
}

class FakeStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) || null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function loadApp(fetchImpl, storage = new FakeStorage()) {
  const elements = new Map([
    ['composer-form', new FakeElement()],
    ['query-input', new FakeElement()],
    ['send-button', new FakeElement()],
    ['message-list', new FakeElement()],
    ['file-input', new FakeElement()],
    ['uploaded-list', new FakeElement()],
    ['uploaded-count', new FakeElement()],
    ['generated-list', new FakeElement()],
    ['new-chat-button', new FakeElement()],
    ['history-list', new FakeElement()],
    ['history-count', new FakeElement()],
  ]);
  FakeWebSocket.instances = [];
  const context = {
    window: { __DEEP_SEARCH_API_BASE__: 'http://localhost:8000', localStorage: storage },
    document: {
      querySelector: (selector) => elements.get(selector.slice(1)),
      createElement: (tagName) => new FakeElement(tagName),
    },
    crypto: { randomUUID: () => 'thread-under-test' },
    fetch: fetchImpl,
    WebSocket: FakeWebSocket,
    FormData: FakeFormData,
    URL,
    JSON,
    Promise,
    Error,
    Set,
    console,
  };
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  vm.runInNewContext(appSource, context, { filename: 'frontend/app.js' });
  return { elements, socket: () => FakeWebSocket.instances.at(-1), storage };
}

test('用户发送非空研究问题后，页面立即显示消息并提交当前会话', async () => {
  const requests = [];
  const app = loadApp(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ status: 'started', thread_id: 'thread-under-test' }) };
  });

  const input = app.elements.get('query-input');
  input.value = '  分析这份研究资料  ';
  const submit = app.elements.get('composer-form').emit('submit', { preventDefault() {} });
  app.socket()?.emit('open');
  await submit;

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:8000/api/task');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    query: '分析这份研究资料',
    thread_id: 'thread-under-test',
  });
  assert.equal(input.value, '');
  assert.equal(app.elements.get('send-button').disabled, true);
  assert.equal(app.elements.get('message-list').children.length, 2);
});

test('任务完成事件会替换等待消息并恢复发送按钮', async () => {
  const app = loadApp(async () => ({
    ok: true,
    json: async () => ({ status: 'started', thread_id: 'thread-under-test' }),
  }));

  app.elements.get('query-input').value = '查询最新进展';
  const submit = app.elements.get('composer-form').emit('submit', { preventDefault() {} });
  const socket = app.socket();
  socket.emit('open');
  await submit;

  socket.emit('message', {
    data: JSON.stringify({
      type: 'monitor_event',
      event: 'task_result',
      data: { result: '任务已完成' },
    }),
  });

  assert.equal(app.elements.get('message-list').children.length, 2);
  assert.equal(app.elements.get('message-list').children.at(-1).textContent, '任务已完成');
  assert.equal(app.elements.get('send-button').disabled, false);
});

test('用户选择文档后，文件会关联当前会话并显示在上传列表', async () => {
  const requests = [];
  const app = loadApp(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ status: 'uploaded', files: ['notes.md'] }) };
  });
  const input = app.elements.get('file-input');
  input.files = [{ name: 'notes.md', size: 12 }];

  await input.emit('change', { target: input });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:8000/api/upload');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(requests[0].options.body.fields.map(({ name }) => name), ['files', 'thread_id']);
  assert.equal(requests[0].options.body.fields[1].value, 'thread-under-test');
  assert.equal(app.elements.get('uploaded-count').textContent, '1');
  assert.equal(app.elements.get('uploaded-list').children.length, 1);
  assert.equal(app.elements.get('uploaded-list').children[0].textContent, 'notes.md');
});

test('会话工作目录创建后，页面会刷新并展示生成文件', async () => {
  const requests = [];
  const app = loadApp(async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/api/files')) {
      return {
        ok: true,
        json: async () => ({ files: [{ name: 'report.md', size: 12, path: 'C:/output/report.md' }] }),
      };
    }
    return { ok: true, json: async () => ({ status: 'started', thread_id: 'thread-under-test' }) };
  });

  app.elements.get('query-input').value = '生成研究报告';
  const submit = app.elements.get('composer-form').emit('submit', { preventDefault() {} });
  const socket = app.socket();
  socket.emit('open');
  await submit;
  socket.emit('message', {
    data: JSON.stringify({
      type: 'monitor_event',
      event: 'session_created',
      data: { path: 'C:/output' },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const filesRequest = requests.find(({ url }) => url.includes('/api/files'));
  assert.match(filesRequest.url, /path=C%3A%2Foutput/);
  assert.equal(app.elements.get('generated-list').children[0].textContent, 'report.md');
});

test('用户新建对话后，旧连接关闭且迟到结果不污染新会话', async () => {
  const app = loadApp(async () => ({
    ok: true,
    json: async () => ({ status: 'started', thread_id: 'thread-under-test' }),
  }));

  app.elements.get('query-input').value = '旧会话任务';
  const submit = app.elements.get('composer-form').emit('submit', { preventDefault() {} });
  const oldSocket = app.socket();
  oldSocket.emit('open');
  await submit;
  oldSocket.emit('message', {
    data: JSON.stringify({ type: 'monitor_event', event: 'task_result', data: { result: '旧结果' } }),
  });

  app.elements.get('new-chat-button').emit('click');
  oldSocket.emit('message', {
    data: JSON.stringify({ type: 'monitor_event', event: 'task_result', data: { result: '迟到旧结果' } }),
  });

  assert.equal(oldSocket.readyState, 3);
  assert.equal(app.elements.get('message-list').children.length, 0);
});

test('任务完成后会把已完成消息保存到浏览器本地历史', async () => {
  const storage = new FakeStorage();
  const app = loadApp(async () => ({
    ok: true,
    json: async () => ({ status: 'started', thread_id: 'thread-under-test' }),
  }), storage);

  app.elements.get('query-input').value = '保存这次研究';
  const submit = app.elements.get('composer-form').emit('submit', { preventDefault() {} });
  const socket = app.socket();
  socket.emit('open');
  await submit;
  socket.emit('message', {
    data: JSON.stringify({ type: 'monitor_event', event: 'task_result', data: { result: '已完成' } }),
  });

  const history = JSON.parse(storage.getItem('deep-search-pro.history.v1'));
  assert.equal(history.length, 1);
  assert.equal(history[0].title, '保存这次研究');
  assert.deepEqual(history[0].messages.map(({ content }) => content), ['保存这次研究', '已完成']);
});

test('任务启动失败后会展示错误并恢复发送按钮', async () => {
  const app = loadApp(async () => ({
    ok: false,
    json: async () => ({ error: '服务暂不可用' }),
  }));

  app.elements.get('query-input').value = '重试这个任务';
  const submit = app.elements.get('composer-form').emit('submit', { preventDefault() {} });
  const socket = app.socket();
  socket.emit('open');
  await submit;

  assert.equal(app.elements.get('send-button').disabled, false);
  assert.equal(app.elements.get('message-list').children.at(-1).textContent, '无法启动任务：服务暂不可用');
});

test('用户可以从浏览器本地历史恢复已完成会话', () => {
  const storage = new FakeStorage();
  storage.setItem('deep-search-pro.history.v1', JSON.stringify([
    {
      threadId: 'history-thread',
      title: '历史研究任务',
      messages: [{ role: 'user', content: '历史问题' }, { role: 'assistant', content: '历史结果' }],
      outputDir: '',
      uploadedFiles: [],
    },
  ]));
  const app = loadApp(async () => ({ ok: true, json: async () => ({ files: [] }) }), storage);

  assert.equal(app.elements.get('history-count').textContent, '1');
  assert.equal(app.elements.get('history-list').children.length, 1);
  app.elements.get('history-list').children[0].emit('click');

  assert.equal(app.elements.get('message-list').children.length, 2);
  assert.equal(app.elements.get('message-list').children[1].textContent, '历史结果');
});

test('生成文件列表会提供经过编码的下载链接', async () => {
  const app = loadApp(async (url) => {
    if (url.includes('/api/files')) {
      return {
        ok: true,
        json: async () => ({ files: [{ name: '研究报告.md', path: 'C:/output/研究报告.md' }] }),
      };
    }
    return { ok: true, json: async () => ({ status: 'started', thread_id: 'thread-under-test' }) };
  });

  app.elements.get('query-input').value = '生成下载文件';
  const submit = app.elements.get('composer-form').emit('submit', { preventDefault() {} });
  const socket = app.socket();
  socket.emit('open');
  await submit;
  socket.emit('message', {
    data: JSON.stringify({ type: 'monitor_event', event: 'session_created', data: { path: 'C:/output' } }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const link = app.elements.get('generated-list').children[0].children[0];
  assert.equal(link.tagName, 'A');
  assert.equal(link.href, 'http://localhost:8000/api/download?path=C%3A%2Foutput%2F%E7%A0%94%E7%A9%B6%E6%8A%A5%E5%91%8A.md');
});
