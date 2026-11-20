/**
 * content.js —— 页面执行器（content script）
 *
 * 接收 Service Worker 的指令并操作 DOM：
 * - scroll / search / clean_ads：基础页面操作
 * - play_pause / seek / speed / volume：视频播放器控制
 * - like：点赞（站点选择器匹配）
 * - getPageContent：页面感知——扫描可见视频卡片与链接，供 LLM 理解"看这个"等指代
 */

// ============ 常见广告节点匹配规则 ============
const AD_SELECTORS = [
  '[class*="ad-"]', '[class*="_ad"]', '[class*="advert"]', '[id*="advert"]',
  '[class*="banner"]', '[id*="banner"]', '[class*="promotion"]',
  'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]',
  'ins.adsbygoogle', '[data-ad]', '[data-ads]', '[id^="google_ads"]',
];

// 点赞按钮选择器（B站优先，兼容通用命名）
const LIKE_SELECTORS = [
  '.video-toolbar-left_main .like:not(.on)',   // B站新版工具栏（未点赞状态）
  '.video-toolbar-left .like',                 // B站旧版
  '.video-like', '[class*="like-btn"]', '.like-btn',
];

// ============ 消息入口 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'EXEC' && msg.type !== 'GET_CONTEXT') return;
  if (msg.type === 'GET_CONTEXT') {
    sendResponse(getPageContent());   // 页面感知：同步返回扫描结果
    return false;
  }
  execute(msg.cmd)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message) }));
  return true; // 异步响应
});

async function execute(cmd) {
  switch (cmd.action) {
    case 'scroll': return doScroll(cmd);
    case 'search': return doSearch(cmd);
    case 'clean_ads': return doCleanAds();
    case 'play_pause': return doPlayPause();
    case 'seek': return doSeek(cmd);
    case 'speed': return doSpeed(cmd);
    case 'volume': return doVolume(cmd);
    case 'like': return doLike();
    case 'fill_user': return doFillUser(cmd);
    case 'focus_password': return doFocusPassword();
    case 'fill_field': return doFillField(cmd);
    case 'submit_form': return doSubmitForm();
    default: throw new Error('未知指令: ' + cmd.action);
  }
}

// ============ 页面感知 ============
// 扫描可见视频卡片与主要链接，压缩为紧凑 JSON 供 LLM 理解页面内容与指代
function getPageContent() {
  const ctx = {
    url: location.href,
    title: document.title,
    hasVideo: !!document.querySelector('video'),
    videos: [],   // 视频卡片 [{i, t:标题, u:链接}]
    links: [],    // 主要链接 [{i, t:文字, u:链接}]
  };

  // --- B站视频卡片 ---
  document.querySelectorAll('.bili-video-card, .feed-card').forEach((card) => {
    if (ctx.videos.length >= 20) return;
    const a = card.querySelector('a[href*="/video/"], a[href*="/bangumi/"]');
    const tit = card.querySelector('.bili-video-card__info--tit, .bili-video-card__info--author-and-desc, h3');
    if (a && tit && isVisible(a)) {
      ctx.videos.push({ i: ctx.videos.length, t: clean(tit.textContent), u: absUrl(a.href) });
    }
  });

  // --- 通用兜底：页面内含 BV/video 的链接，或正文文字较长的可见链接 ---
  if (ctx.videos.length === 0) {
    document.querySelectorAll('a[href]').forEach((a) => {
      if (ctx.videos.length >= 20) return;
      const text = clean(a.textContent);
      if (text.length > 4 && text.length < 60 && isVisible(a) &&
          (/\/video\//.test(a.href) || /BV[0-9A-Za-z]+/.test(a.href))) {
        ctx.videos.push({ i: ctx.videos.length, t: text, u: absUrl(a.href) });
      }
    });
  }

  // --- 主要链接（导航/其他可点击目标，供"打开xx"等指令匹配）---
  document.querySelectorAll('a[href]').forEach((a) => {
    if (ctx.links.length >= 15) return;
    const text = clean(a.textContent);
    if (text.length >= 2 && text.length < 20 && isVisible(a) &&
        !ctx.videos.some((v) => v.u === absUrl(a.href))) {
      ctx.links.push({ i: ctx.links.length, t: text, u: absUrl(a.href) });
    }
  });

  // 登录表单状态：告诉模型页面上是否有可填的用户名/密码框
  ctx.loginForm = {
    user: !!findUsernameInput(),
    password: [...document.querySelectorAll('input[type="password"]')].some(isVisible),
  };

  // 可见表单字段：只给字段名和类型，不读取用户已填的内容（隐私）
  ctx.fields = getFormFields().map((el, i) => ({
    i,
    label: fieldLabel(el),
    name: el.name || '',
    type: (el.tagName === 'SELECT' ? 'select' : el.type) || 'text',
  }));

  return ctx;
}

// ============ 登录表单（只语音填用户名，密码交给浏览器密码管理器） ============
// 按常见登录框特征找用户名输入框：优先语义化属性，最后回退到"密码框之前最近的可见文本框"
function findUsernameInput() {
  const usable = (el) => el && isVisible(el) && !el.disabled && !el.readOnly && el.type !== 'password';
  const selectors = [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name*="user" i]', 'input[id*="user" i]',
    'input[name*="account" i]', 'input[id*="account" i]',
    'input[name*="login" i]', 'input[id*="login" i]',
    'input[placeholder*="用户名"]', 'input[placeholder*="账号"]',
    'input[placeholder*="邮箱"]', 'input[placeholder*="手机"]',
  ];
  for (const s of selectors) {
    const el = [...document.querySelectorAll(s)].find(usable);
    if (el) return el;
  }
  // 回退：密码框之前、文档顺序最近的可见文本框（多数登录页都是"账号在上、密码在下"）
  const pwd = [...document.querySelectorAll('input[type="password"]')].find(isVisible);
  if (!pwd) return null;
  const texts = [...document.querySelectorAll('input')].filter(
    (el) => usable(el) && /^(text|email|tel|)$/i.test(el.type)
  );
  const before = texts.filter((el) => el.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING);
  return before.length ? before[before.length - 1] : null;
}

// 用原生 setter 写入并派发事件，兼容 React/Vue 的受控输入框（input 和 textarea 都支持）
function fillInput(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// 语音填写用户名（密码不做语音输入，避免明文经过识别服务和大模型）
function doFillUser(cmd) {
  if (!cmd.value) throw new Error('缺少用户名内容');
  const input = findUsernameInput();
  if (!input) throw new Error('页面未找到用户名输入框');
  input.focus();
  fillInput(input, String(cmd.value));
  return { done: 'filled_user' };
}

// 聚焦密码框：等待浏览器密码管理器自动填充，或由用户手动输入
function doFocusPassword() {
  const pwd = [...document.querySelectorAll('input[type="password"]')].find((el) => isVisible(el) && !el.disabled);
  if (!pwd) throw new Error('页面未找到密码输入框');
  pwd.focus();
  return { done: 'focused_password' };
}

// ============ 通用表单填写（姓名/电话/邮箱/验证码等） ============
// 取页面上可编辑的字段（排除密码、隐藏、按钮类），最多 20 个
function getFormFields() {
  const skip = new Set(['hidden', 'password', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);
  return [...document.querySelectorAll('input, textarea, select')]
    .filter((el) => !skip.has((el.type || '').toLowerCase()) && isVisible(el) && !el.disabled && !el.readOnly)
    .slice(0, 20);
}

// 解析字段的可读名称：label[for] > 包裹的 label > aria-label/placeholder/name/id > 前置兄弟文本
function fieldLabel(el) {
  if (el.id) {
    try {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return clean(l.textContent);
    } catch (e) { /* 选择器异常时走后续兜底 */ }
  }
  const wrap = el.closest('label');
  if (wrap) return clean(wrap.textContent);
  const attr = el.getAttribute('aria-label') || el.placeholder || el.name || el.id;
  if (attr) return clean(attr);
  const prev = el.previousElementSibling;
  return prev ? clean(prev.textContent) : '';
}

// 常见字段别名，口语里的叫法和页面标签对不上时用（例：说"手机号"，页面写"联系电话"）
const FIELD_ALIASES = [
  ['姓名', '名字', '真实姓名', 'name', 'fullname', 'username'],
  ['电话', '手机', '手机号', '联系电话', '联系方式', 'phone', 'mobile', 'tel'],
  ['邮箱', '邮件', '电子邮箱', 'email', 'e-mail', 'mail'],
  ['验证码', '校验码', '短信验证码', 'code', 'captcha', 'verify'],
  ['地址', '收货地址', '住址', 'address'],
];

// 按字段名找输入框：完全匹配 > 标签包含 > 别名/属性包含
function findFieldByName(name) {
  const key = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (!key) return null;
  const group = FIELD_ALIASES.find((g) => g.some((a) => a.toLowerCase() === key || key.includes(a.toLowerCase())));
  const terms = group ? group.map((s) => s.toLowerCase()) : [key];

  let best = null;
  let bestScore = 0;
  for (const el of getFormFields()) {
    const label = fieldLabel(el).toLowerCase().replace(/\s+/g, '');
    const hay = [label, (el.placeholder || '').toLowerCase(), (el.name || '').toLowerCase(), (el.id || '').toLowerCase()].join('|');
    let score = 0;
    for (const t of terms) {
      if (!t) continue;
      if (label === t) score = Math.max(score, 100);
      else if (label.includes(t)) score = Math.max(score, 80);
      else if (hay.includes(t)) score = Math.max(score, 60);
    }
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

// 语音填写任意表单字段（密码类字段被 getFormFields 排除）
function doFillField(cmd) {
  if (!cmd.field) throw new Error('缺少字段名');
  if (cmd.value === undefined || cmd.value === null || cmd.value === '') throw new Error('缺少字段内容');
  const el = findFieldByName(cmd.field);
  if (!el) throw new Error('未找到字段: ' + cmd.field);

  el.focus();
  if (el.tagName === 'SELECT') {
    // 下拉框：按选项文字或值匹配
    const v = String(cmd.value);
    const opt = [...el.options].find((o) => o.textContent.trim() === v || o.value === v);
    if (!opt) throw new Error('下拉框无匹配选项: ' + v);
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    fillInput(el, String(cmd.value));
  }
  return { done: 'filled', field: fieldLabel(el) };
}

// 提交表单：优先当前焦点所在表单的提交按钮，其次按常见文案找按钮，最后兜底 requestSubmit
function doSubmitForm() {
  const active = document.activeElement;
  const form = (active && active.closest && active.closest('form')) || null;
  const scope = form || document;

  const submitBtn = [...scope.querySelectorAll('button[type="submit"], input[type="submit"]')]
    .find((b) => isVisible(b) && !b.disabled);
  if (submitBtn) { submitBtn.click(); return { done: 'submitted' }; }

  const TEXTS = ['提交', '确认提交', '立即提交', '确定', '保存', '注册', '登录', '发送', '下一步', '完成'];
  const textBtn = [...scope.querySelectorAll('button, input[type="button"], a[role="button"]')]
    .find((b) => isVisible(b) && !b.disabled && TEXTS.some((t) => (b.textContent || b.value || '').includes(t)));
  if (textBtn) { textBtn.click(); return { done: 'submitted' }; }

  if (form && form.requestSubmit) { form.requestSubmit(); return { done: 'submitted' }; }
  throw new Error('页面未找到提交按钮');
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function clean(s) { return (s || '').replace(/\s+/g, ' ').trim().slice(0, 50); }
function absUrl(href) {
  try { return new URL(href, location.href).href; } catch { return href; }
}

// ============ 播放器控制 ============
function getVideo() {
  // 取页面主视频（面积最大的 video 元素，避免命中小窗/预览）
  const videos = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0);
  if (!videos.length) throw new Error('页面无视频');
  return videos.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
}

function doPlayPause() {
  const v = getVideo();
  if (v.paused) v.play(); else v.pause();
  return { done: v.paused ? 'paused' : 'playing' };
}

function doSeek(cmd) {
  const v = getVideo();
  const sec = Number(cmd.seconds) || 30;
  // forward/back 前后快进快退
  v.currentTime = Math.max(0, v.currentTime + (cmd.direction === 'back' ? -sec : sec));
  return { done: 'seek', time: Math.round(v.currentTime) };
}

function doSpeed(cmd) {
  const v = getVideo();
  const rate = Number(cmd.rate) || 1.5;
  v.playbackRate = Math.min(4, Math.max(0.5, rate)); // 限制在 0.5~4 倍速
  return { done: 'speed', rate: v.playbackRate };
}

function doVolume(cmd) {
  const v = getVideo();
  v.volume = Math.min(1, Math.max(0, (Number(cmd.level) || 50) / 100));
  v.muted = v.volume === 0;
  return { done: 'volume', volume: v.volume };
}

// 点赞：按站点选择器模拟点击
function doLike() {
  const btn = LIKE_SELECTORS.map((s) => document.querySelector(s)).find((el) => el && isVisible(el));
  if (!btn) throw new Error('未找到点赞按钮');
  btn.click();
  return { done: 'liked' };
}

// ============ 基础操作 ============
function doScroll(cmd) {
  const amount = Number(cmd.amount) || 500;
  if (cmd.direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
  else if (cmd.direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  else window.scrollBy({ top: cmd.direction === 'up' ? -amount : amount, behavior: 'smooth' });
  return { done: 'scrolled' };
}

// 页面搜索：尝试常见搜索框选择器，填词、触发事件并提交
function doSearch(cmd) {
  const selectors = [
    'input[type="search"]', 'input[name="q"]', 'input[name="wd"]', 'input[name="kw"]', 'input[name="keyword"]',
    '#kw', '#input', '.search input', 'input[placeholder*="搜索"]',
  ];
  const input = selectors.map((s) => document.querySelector(s)).find((el) => el && !el.disabled);
  if (!input) throw new Error('页面无搜索框'); // background 收到失败后回退新标签页搜索

  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, cmd.query); // 用原生 setter 绕过 React/Vue 的值劫持
  input.dispatchEvent(new Event('input', { bubbles: true })); // 触发框架监听
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const form = input.closest('form');
  if (form) form.submit();
  return { done: 'searched' };
}

// 清理广告：首次开启后用 MutationObserver 持续清理；再次调用切换关闭
function doCleanAds() {
  if (doCleanAds.on) {
    doCleanAds.on = false;
    if (doCleanAds.observer) { doCleanAds.observer.disconnect(); doCleanAds.observer = null; }
    document.querySelectorAll('[data-voice-hidden]').forEach((el) => {
      el.style.display = el.dataset.voiceHidden;
      delete el.dataset.voiceHidden;
    });
    return { done: 'ads_clean_off' };
  }
  const hideIn = (root) => {
    root.querySelectorAll(AD_SELECTORS.join(',')).forEach((el) => {
      if (el.dataset.voiceHidden) return;
      el.dataset.voiceHidden = el.style.display;
      el.style.display = 'none';
    });
  };
  hideIn(document);
  doCleanAds.on = true;
  doCleanAds.observer = new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach((n) => n.nodeType === 1 && hideIn(n.parentElement || document));
  });
  doCleanAds.observer.observe(document.body, { childList: true, subtree: true });
  return { done: 'ads_clean_on' };
}
