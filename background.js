/**
 * background.js —— Service Worker
 *
 * 职责：
 * 1. 管理录音生命周期（popup/悬浮球 -> 本地识别宿主页 server/speech.html）
 * 2. 收到 ASR 识别文本后，调用豆包大模型解析为结构化指令
 * 3. 将指令分发给 content script / 标签页执行
 */

// ============ 指令解析（LLM） ============
// System Prompt：限定模型只能输出预定义 action 枚举，防止幻觉
const SYSTEM_PROMPT = `你是浏览器语音助手的指令解析器。把用户语音解析为 JSON 指令数组，只能输出 JSON。
会同时提供页面上下文（page_context：当前URL、标题、视频列表 videos、链接列表 links，元素带索引 i 和链接 u）。
支持的 action：
- scroll: 滚动。参数 direction("up"/"down"/"top"/"bottom"), amount(像素,默认500)
- search: 搜索。参数 query, where("page"=页面搜索框|"new_tab"=新标签页)
- clean_ads: 清理页面广告。无参数
- open_page: 打开网站。参数 url
- watch: 打开页面上用户指代的视频/链接。参数 url(从 page_context.videos 或 links 中匹配)，用户说"看这个/看xxx/第一个"等时优先用此指令
- play_pause: 播放/暂停当前视频。无参数
- seek: 快进快退。参数 direction("forward"/"back"), seconds(默认30)
- speed: 设置倍速。参数 rate(如 1.5, 2)
- volume: 设置音量百分比。参数 level(0-100)
- like: 点赞当前视频。无参数
- fill_user: 填写登录用户名/账号。参数 value（用户说"用户名填xxx/账号是xxx"时使用，禁止用于密码）
- focus_password: 聚焦密码输入框，等待用户手动输入或浏览器自动填充。无参数
- fill_field: 填写表单字段。参数 field(字段名，优先用 page_context.fields 里的 label，如"姓名"/"电话"/"邮箱"/"验证码"), value(用户给的值，原样保留数字、空格和符号)
- submit_form: 提交当前表单。无参数（用户说"提交/确定/保存/发送"时使用）
- reload: 刷新当前页面。无参数（用户说"刷新/重新加载/刷新页面"时使用）
- back: 返回上一页。无参数（用户说"后退/返回/回到上一页"时使用）
- forward: 前进到下一页。无参数
一句话里包含多个字段时，按口述顺序输出多个 fill_field；用户末尾说"提交"时再追加 {"action":"submit_form"}。
密码一律不用 fill_field/fill_user，只能 focus_password。
无法识别输出 {"actions":[]}
示例：输入"看第三个视频" 输出 {"actions":[{"action":"watch","url":"..."}]}（url取自 page_context）`;

// 组装用户消息：语音文字 + 页面感知上下文
function buildUserMessage(text, pageContext) {
  return pageContext
    ? `${text}\n\npage_context: ${JSON.stringify(pageContext)}`
    : text;
}

// 调用大模型（按厂商），把语音文本+页面上下文解析为结构化指令
async function parseCommand(text, cfg, pageContext) {
  const userMsg = buildUserMessage(text, pageContext);
  if (cfg.provider === 'deepseek') {
    // DeepSeek：OpenAI 兼容接口，deepseek-chat 解析指令
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.deepseekApiKey}` },
      body: JSON.stringify({
        model: cfg.deepseekModel || 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        response_format: { type: 'json_object' }, // DeepSeek 支持 JSON 输出模式
        temperature: 0.1,
      }),
    });
    if (!resp.ok) throw new Error(`DeepSeek API错误 ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  }
  if (cfg.provider === 'qwen') {
    // 阿里云百炼：OpenAI 兼容模式接口，qwen-turbo 解析指令
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.qwenApiKey}` },
      body: JSON.stringify({
        model: cfg.qwenLlmModel || 'qwen-turbo',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    });
    if (!resp.ok) throw new Error(`Qwen API错误 ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  }
  // 火山引擎方舟：豆包模型解析指令
  const resp = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.arkApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.arkModel || 'doubao-lite-32k',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      response_format: { type: 'json_object' }, // 强制 JSON 输出
      temperature: 0.1,
    }),
  });
  if (!resp.ok) throw new Error(`豆包API错误 ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const content = data.choices[0].message.content;
  const parsed = JSON.parse(content);
  return Array.isArray(parsed.actions) ? parsed.actions : [];
}

// 获取活动标签页的页面感知上下文（视频卡片/链接清单），供 LLM 理解指代
async function getPageContext(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_CONTEXT' });
  } catch {
    return null; // 页面未注入 content script（如浏览器设置页）
  }
}

// ============ 指令分发 ============
async function dispatchActions(actions) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  for (const cmd of actions) {
    try {
      switch (cmd.action) {
        case 'open_page':
        case 'watch': { // watch：打开页面感知匹配到的视频/链接 URL
          await chrome.tabs.create({ url: cmd.url });
          break;
        }
        case 'search': {
          // 优先页面内搜索框；content script 找不到时回退到新标签页搜索
          const resp = await chrome.tabs.sendMessage(tab.id, { type: 'EXEC', cmd }).catch(() => null);
          if (!resp || !resp.ok) {
            await chrome.tabs.create({ url: `https://www.bing.com/search?q=${encodeURIComponent(cmd.query)}` });
          }
          break;
        }
        case 'reload':
          await chrome.tabs.reload(tab.id);
          break;
        case 'back':
          await chrome.tabs.goBack(tab.id);
          break;
        case 'forward':
          await chrome.tabs.goForward(tab.id);
          break;
        default: {
          // scroll / clean_ads 等页面操作发给 content script
          await chrome.tabs.sendMessage(tab.id, { type: 'EXEC', cmd });
        }
      }
    } catch (e) {
      console.error('[dispatch] 执行失败:', cmd, e);
    }
  }
}

// ============ 识别宿主页（本地 HTTP 页）管理 ============
// 为什么不用扩展页/offscreen：Edge 对 chrome-extension:// 源的 SpeechRecognition 直接返回
// not-allowed，且根本不会弹出麦克风授权框；只有真实网页源（127.0.0.1 属于可信源）才能正常授权与识别。
// 宿主页由 server/start_server.bat 启动的静态服务提供，扩展只负责打开它并转发消息。
const HOST_PORT = 8765;
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;
const HOST_URL = `${HOST_BASE}/speech.html`;

// 探测本地识别服务是否已启动（未启动时打开标签页只会看到连接失败页）
async function hostAlive() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const resp = await fetch(HOST_URL, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

// 找到识别宿主页（匹配模式不支持端口，这里再按端口前缀过滤）
async function findHostTab() {
  const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
  return tabs.find((t) => t.url && t.url.startsWith(HOST_BASE)) || null;
}

// 确保宿主页存在：固定成小图标 + 禁止自动丢弃，保证切到后台也持续录音
async function ensureHostTab(active) {
  let tab = await findHostTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: HOST_URL, active: !!active, pinned: true });
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
  } else if (active) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  await chrome.storage.local.set({ hostTabId: tab.id });
  return tab;
}

// 给宿主页下指令（消息由 content/host_bridge.js 转成 window.postMessage）
async function tellHost(type, payload) {
  const tab = await findHostTab();
  if (!tab) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { target: 'host', type, payload });
    return true;
  } catch {
    return false;
  }
}

// 向所有标签页的悬浮球广播状态（识别文字/分析中/执行中等）
async function broadcastToWidgets(type, payload) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    chrome.tabs.sendMessage(t.id, { target: 'widget', type, payload }).catch(() => {});
  }
}

// ============ 消息路由 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;

  switch (msg.type) {
    case 'START_LISTENING':
      // popup/悬浮球点开启：后台静默打开识别宿主页
      (async () => {
        const { listening, micGranted } = await chrome.storage.local.get(['listening', 'micGranted']);
        if (listening) { sendResponse({ ok: true }); return; } // 防重复启动
        // 本地识别服务未启动时直接给出可执行的提示，避免打开一个错误页
        if (!(await hostAlive())) {
          const error = '本地识别服务未启动，请先运行 server/start_server.bat';
          broadcastToWidgets('ERROR', '❌ ' + error);
          sendResponse({ ok: false, error });
          return;
        }
        if (!micGranted) {
          // 未授权：前台打开宿主页，由用户点击"授权麦克风"触发浏览器授权框
          await ensureHostTab(true);
          broadcastToWidgets('NEED_AUTH', '请在识别页点击「授权麦克风」');
          sendResponse({ ok: false, needAuth: true, error: '请在识别页点击「授权麦克风」' });
          return;
        }
        await chrome.storage.local.set({ listening: true });
        await ensureHostTab(false);
        await tellHost('START_ASR');
        broadcastToWidgets('LISTENING', '正在聆听…请说指令');
        sendResponse({ ok: true });
      })();
      return true; // 异步 sendResponse

    case 'STOP_LISTENING':
      // 通知识别宿主页停止并关闭标签页
      (async () => {
        await chrome.storage.local.set({ listening: false });
        await tellHost('STOP_ASR');
        const tab = await findHostTab();
        if (tab) setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 300);
        broadcastToWidgets('STOPPED', '⏸ 已关闭语音控制');
        sendResponse({ ok: true });
      })();
      return true;

    case 'OPEN_AUTH_PAGE':
      // 前台打开识别宿主页，让用户完成麦克风授权
      (async () => {
        if (!(await hostAlive())) {
          sendResponse({ ok: false, error: '本地识别服务未启动，请先运行 server/start_server.bat' });
          return;
        }
        await ensureHostTab(true);
        sendResponse({ ok: true });
      })();
      return true;

    // ---------- 宿主页经 host_bridge.js 转发上来的消息 ----------
    case 'HOST_READY':
      // 宿主页就绪：把开关/授权状态同步给它，由它决定是否自动开始识别
      (async () => {
        const { listening, micGranted } = await chrome.storage.local.get(['listening', 'micGranted']);
        if (sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, {
            target: 'host', type: 'SYNC_STATE', payload: { listening: !!listening, micGranted: !!micGranted },
          }).catch(() => {});
        }
      })();
      break;

    case 'MIC_GRANTED':
      // 麦克风已授权且识别器已启动：记录授权并打开开关
      chrome.storage.local.set({ micGranted: true, listening: true });
      broadcastToWidgets('LISTENING', '正在聆听…请说指令');
      break;

    case 'NEED_GESTURE':
      // 后台页无法弹出授权框：把识别页切到前台，让用户手动点击
      (async () => {
        const tab = await findHostTab();
        if (tab) await chrome.tabs.update(tab.id, { active: true });
        broadcastToWidgets('NEED_AUTH', msg.payload || '请在识别页点击「授权麦克风」');
      })();
      break;

    case 'ASR_STOPPED':
      chrome.storage.local.set({ listening: false });
      broadcastToWidgets('STOPPED', '⏸ 已关闭语音控制');
      break;

    // 宿主页报上来的识别结果
    case 'ASR_PARTIAL':
      chrome.runtime.sendMessage({ target: 'popup', type: 'PARTIAL', text: msg.payload }).catch(() => {});
      broadcastToWidgets('PARTIAL', msg.payload);
      break;

    case 'ASR_FINAL':
      (async () => {
        chrome.runtime.sendMessage({ target: 'popup', type: 'FINAL', text: msg.payload }).catch(() => {});
        broadcastToWidgets('ANALYZING', '已接收指令，正在分析…');
        const cfg = await chrome.storage.local.get(
          ['provider', 'arkApiKey', 'arkModel', 'qwenApiKey', 'qwenLlmModel',
           'deepseekApiKey', 'deepseekModel']);
        // 按厂商检查指令解析 Key
        const keyOk = { qwen: cfg.qwenApiKey, deepseek: cfg.deepseekApiKey }[cfg.provider] || cfg.arkApiKey;
        if (!keyOk) {
          chrome.runtime.sendMessage({ target: 'popup', type: 'ERROR', text: '未配置指令解析 API Key' }).catch(() => {});
          broadcastToWidgets('ERROR', '未配置指令解析 API Key');
          return;
        }
        try {
          chrome.runtime.sendMessage({ target: 'popup', type: 'ANALYZING' }).catch(() => {});
          // 页面感知：先取当前页上下文（视频/链接清单），与语音一起喂给 LLM
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const pageContext = tab ? await getPageContext(tab.id) : null;
          const actions = await parseCommand(msg.payload, cfg, pageContext);
          chrome.runtime.sendMessage({ target: 'popup', type: 'OPERATING', actions }).catch(() => {});
          broadcastToWidgets('OPERATING', '分析完成，正在操作…');
          await dispatchActions(actions);
          chrome.runtime.sendMessage({ target: 'popup', type: 'DONE', actions }).catch(() => {});
          broadcastToWidgets('DONE', '✅ 已执行 ' + actions.length + ' 条指令');
        } catch (e) {
          chrome.runtime.sendMessage({ target: 'popup', type: 'ERROR', text: String(e.message) }).catch(() => {});
          broadcastToWidgets('ERROR', '❌ ' + String(e.message));
        }
      })();
      break;

    case 'ASR_ERROR':
      chrome.runtime.sendMessage({ target: 'popup', type: 'ERROR', text: msg.payload }).catch(() => {});
      broadcastToWidgets('ERROR', '❌ ' + msg.payload);
      break;
  }
});

// 宿主页被用户关闭/崩溃：同步关掉开关，避免状态残留
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { hostTabId, listening } = await chrome.storage.local.get(['hostTabId', 'listening']);
  if (tabId !== hostTabId) return;
  await chrome.storage.local.remove('hostTabId');
  if (listening) {
    await chrome.storage.local.set({ listening: false });
    broadcastToWidgets('STOPPED', '⏸ 识别页已关闭，语音控制已停止');
  }
});
