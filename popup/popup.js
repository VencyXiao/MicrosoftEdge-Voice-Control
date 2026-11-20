/**
 * popup.js —— 语音控制持久开关 + 内嵌配置
 *
 * 开关是持久状态：开启后 offscreen 持续识别语音并执行指令，
 * 关闭弹窗不影响运行，直到再次点击"关闭语音控制"。
 */
const FIELDS = ['provider', 'arkApiKey', 'arkModel', 'qwenApiKey', 'qwenLlmModel',
  'deepseekApiKey', 'deepseekModel'];

const toggleBtn = document.getElementById('toggle');
const statusBar = document.getElementById('status');      // 状态栏容器（控制呼吸灯/红点）
const statusText = document.getElementById('status-text'); // 状态文字

// ============ 厂商切换：显示对应配置区 + 更新配置状态标识 ============
// 当前厂商的 API Key 已填写时，配置标题旁显示绿点 + "模型配置成功"
function renderProvider() {
  const provider = document.getElementById('provider').value;
  document.getElementById('sec-volc').style.display = provider === 'volc' ? '' : 'none';
  document.getElementById('sec-qwen').style.display = provider === 'qwen' ? '' : 'none';
  document.getElementById('sec-deepseek').style.display = provider === 'deepseek' ? '' : 'none';
  renderCfgStatus();
}

function renderCfgStatus() {
  const provider = document.getElementById('provider').value;
  // 按厂商取对应 Key 输入框判断是否已配置
  const keyInput = { volc: 'arkApiKey', qwen: 'qwenApiKey', deepseek: 'deepseekApiKey' }[provider];
  const configured = !!document.getElementById(keyInput).value.trim();
  const el = document.getElementById('cfg-status');
  el.classList.toggle('show', configured);
  el.innerHTML = configured ? '<span class="dot-ok"></span>模型配置成功' : '';
}
document.getElementById('provider').addEventListener('change', renderProvider);

// ============ 配置加载/保存 ============
chrome.storage.local.get(FIELDS).then((cfg) => {
  FIELDS.forEach((f) => {
    const el = document.getElementById(f);
    if (cfg[f] && el) el.value = cfg[f];
  });
  if (!cfg.provider) document.getElementById('provider').value = 'volc'; // 默认火山
  renderProvider();
});

document.getElementById('save').addEventListener('click', async () => {
  const cfg = {};
  FIELDS.forEach((f) => { cfg[f] = document.getElementById(f).value.trim(); });
  await chrome.storage.local.set(cfg);
  document.getElementById('saved').textContent = '✔ 已保存';
  renderCfgStatus(); // 保存后立即刷新配置状态标识
  setTimeout(() => { document.getElementById('saved').textContent = ''; }, 2000);
});

// ============ 状态渲染 ============
// busy 为空时按开关状态显示默认文案；error 时状态点变红
function render() {
  const busy = statusText.dataset.busy;
  const listening = toggleBtn.classList.contains('on');
  statusBar.classList.toggle('listening', listening && !busy?.startsWith('❌'));
  statusBar.classList.toggle('error', !!busy?.startsWith('❌'));
  statusText.textContent = busy || (listening ? '正在聆听…请说指令' : '未开启');
}

async function renderToggle() {
  const { listening } = await chrome.storage.local.get('listening');
  toggleBtn.textContent = listening ? '⏹ 关闭语音控制' : '▶ 开启语音控制';
  toggleBtn.className = listening ? 'on' : 'off';
  render();
}

// ============ 麦克风授权按钮：打开本地识别宿主页 ============
// 识别必须在真实网页源进行（扩展页无法申请麦克风），后台会打开 127.0.0.1 上的识别页
document.getElementById('auth-mic').addEventListener('click', async () => {
  document.getElementById('auth-tip').style.display = '';
  const resp = await chrome.runtime.sendMessage({ target: 'background', type: 'OPEN_AUTH_PAGE' });
  if (resp && resp.ok === false) {
    statusText.dataset.busy = '❌ ' + resp.error;
    render();
  }
});

toggleBtn.addEventListener('click', async () => {
  const { listening } = await chrome.storage.local.get('listening');
  const next = !listening;
  // 开启时不再预授权：授权由识别页标签页的 SpeechRecognition 自行触发
  const type = next ? 'START_LISTENING' : 'STOP_LISTENING';
  const resp = await chrome.runtime.sendMessage({ target: 'background', type });
  if (resp && resp.ok === false) { // 如缺凭证直接提示，不切换状态
    statusText.dataset.busy = '❌ ' + resp.error;
    render();
    return;
  }
  await chrome.storage.local.set({ listening: next });
  statusText.dataset.busy = ''; // 清空临时状态
  renderToggle();
});

// ============ 接收识别/执行状态（background 转发） ============
// 状态流水线：聆听中 → 已接收指令正在分析 → 分析完成正在操作 → 执行完成 → 回到聆听
let resetTimer = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'popup') return;
  clearTimeout(resetTimer);
  switch (msg.type) {
    case 'PARTIAL':
      // 实时显示正在说的内容
      statusText.dataset.busy = '🎤 ' + msg.text;
      break;
    case 'ANALYZING':
      statusText.dataset.busy = '🧠 已接收指令，正在分析…';
      break;
    case 'OPERATING':
      statusText.dataset.busy = '⚡ 分析完成，正在操作…';
      break;
    case 'DONE':
      statusText.dataset.busy = '✅ 已执行 ' + msg.actions.length + ' 条指令';
      resetTimer = setTimeout(() => { statusText.dataset.busy = ''; render(); }, 2000); // 2s后回到聆听提示
      break;
    case 'ERROR':
      statusText.dataset.busy = '❌ ' + msg.text;
      resetTimer = setTimeout(() => { statusText.dataset.busy = ''; render(); }, 3000);
      break;
  }
  render();
});

renderToggle();
