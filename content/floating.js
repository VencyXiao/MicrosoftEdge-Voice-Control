/**
 * floating.js —— 浏览器右侧悬浮球（content script）
 *
 * 行为：
 * - 麦克风授权成功后（storage.micGranted）在所有网页右侧出现
 * - 点击：开启/关闭语音控制（再点一下关闭）
 * - 气泡实时展示：语音识别出的文字（🎤）+ 运行状态（聆听中/分析中/操作中/完成/错误）
 * - 状态由 background 广播（target: 'widget'），与弹窗状态同步
 * - Shadow DOM 隔离样式，避免与页面 CSS 冲突
 */

// 防止重复注入（如页面跳转后脚本重跑）
if (!window.__voiceWidgetInjected) {
  window.__voiceWidgetInjected = true;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  // 挂件结构：状态气泡（识别文字+运行状态） + 悬浮球按钮
  shadow.innerHTML = `
    <style>
      .btn {
        width: 48px; height: 48px; border-radius: 50%;
        border: none; cursor: pointer; font-size: 22px;
        background: rgba(255,255,255,.95); color: #8a93a6;
        box-shadow: 0 2px 12px rgba(0,0,0,.2);
        transition: all .25s; display: flex; align-items: center; justify-content: center;
      }
      .btn:hover { transform: scale(1.08); }
      .btn.on {
        background: #34c759; color: #fff;
        animation: pulse 1.6s ease-in-out infinite;
      }
      @keyframes pulse {
        0%,100% { box-shadow: 0 0 0 0 rgba(52,199,89,.55); }
        50%     { box-shadow: 0 0 0 10px rgba(52,199,89,0); }
      }
      .bubble {
        position: absolute; right: 60px; top: 50%; transform: translateY(-50%);
        max-width: 240px; padding: 8px 12px; border-radius: 10px;
        background: rgba(30,34,44,.92); color: #fff;
        font: 13px/1.5 "Microsoft YaHei", sans-serif;
        white-space: normal; word-break: break-all; text-align: left;
        opacity: 0; pointer-events: none; transition: opacity .25s;
      }
      .bubble .txt { display: block; }
      .bubble .st  { display: block; margin-top: 4px; font-size: 12px; color: #9fe0af; }
      .bubble .st.err { color: #ff9d9d; }
      .wrap { position: relative; }
    </style>
    <div class="wrap">
      <div class="bubble">
        <span class="txt"></span>
        <span class="st"></span>
      </div>
      <button class="btn" title="语音控制">🎙️</button>
    </div>
  `;

  const btn = shadow.querySelector('.btn');
  const bubble = shadow.querySelector('.bubble');
  const txtEl = shadow.querySelector('.txt');
  const stEl = shadow.querySelector('.st');

  let hideTimer = null; // 气泡自动隐藏定时器

  // 显示气泡（文字 + 状态行）；listening=true 时保持显示，否则 4 秒后淡出
  function showBubble(text, status, isErr, keep) {
    if (text !== null) txtEl.textContent = text;
    stEl.textContent = status || '';
    stEl.classList.toggle('err', !!isErr);
    bubble.style.opacity = 1;
    clearTimeout(hideTimer);
    if (!keep) hideTimer = setTimeout(() => { bubble.style.opacity = 0; }, 4000);
  }

  // 按开关状态渲染悬浮球外观
  function render(listening) {
    btn.classList.toggle('on', listening);
    btn.title = listening ? '关闭语音控制' : '开启语音控制';
  }

  // 点击悬浮球：切换语音控制开/关
  btn.addEventListener('click', async () => {
    const { listening } = await chrome.storage.local.get('listening');
    const next = !listening;
    const type = next ? 'START_LISTENING' : 'STOP_LISTENING';
    const resp = await chrome.runtime.sendMessage({ target: 'background', type });
    if (resp && resp.ok === false) {
      if (resp.needAuth) {
        // 未授权：打开麦克风测试页（授权+测试一体）
        showBubble(null, '❌ ' + (resp.error || '请先授权麦克风'), true, false);
        chrome.runtime.sendMessage({ target: 'background', type: 'OPEN_AUTH_PAGE' });
      } else {
        showBubble(null, '❌ ' + (resp.error || '操作失败'), true, false);
      }
      return;
    }
    await chrome.storage.local.set({ listening: next });
    render(next);
    if (next) showBubble(null, '🟢 正在聆听…请说指令', false, true);
    else showBubble(null, '⏸ 已关闭语音控制', false, false);
  });

  // ============ 接收 background 广播：实时文字 + 运行状态 ============
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== 'widget') return;
    switch (msg.type) {
      case 'PARTIAL':   // 实时识别文字（聆听中，保持显示）
        showBubble('🎤 ' + msg.payload, '🟢 正在聆听…', false, true);
        break;
      case 'LISTENING': // 刚开启
        showBubble(null, '🟢 正在聆听…请说指令', false, true);
        break;
      case 'ANALYZING': // 已接收指令，LLM 分析中
        showBubble(null, '🧠 已接收指令，正在分析…', false, true);
        break;
      case 'OPERATING': // 分析完成，执行中
        showBubble(null, '⚡ 分析完成，正在操作…', false, true);
        break;
      case 'DONE':      // 执行完成，4 秒后回到聆听提示
        showBubble(null, msg.payload || '✅ 已执行', false, false);
        break;
      case 'ERROR':     // 错误，短暂显示
        showBubble(null, msg.payload || '❌ 出错了', true, false);
        break;
      case 'NEED_AUTH': // 未授权提示
        showBubble(null, msg.payload, true, false);
        break;
    }
  });

  // ============ 显示控制：授权成功后才出现悬浮球 ============
  function setVisible(show) { host.style.display = show ? 'block' : 'none'; }

  chrome.storage.local.get('micGranted').then(({ micGranted }) => {
    setVisible(!!micGranted);
    return chrome.storage.local.get('listening');
  }).then(({ listening }) => render(!!listening));

  // 授权状态/开关状态全局同步（测试页授权成功、弹窗切换等）
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.micGranted) setVisible(!!changes.micGranted.newValue);
    if (changes.listening) {
      render(!!changes.listening.newValue);
      if (!changes.listening.newValue) showBubble(null, '⏸ 已关闭语音控制', false, false);
    }
  });

  document.documentElement.appendChild(host);
}
