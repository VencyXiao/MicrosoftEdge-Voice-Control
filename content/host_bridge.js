/**
 * host_bridge.js —— 本地识别宿主页与扩展 background 的消息桥
 *
 * 网页（http://127.0.0.1:8765/speech.html）没有 chrome API 权限，
 * 由本 content script 双向转发消息：
 *   页面 -> window.postMessage({__voiceHost, payload}) -> chrome.runtime.sendMessage -> background
 *   background -> chrome.tabs.sendMessage({target:'host'}) -> window.postMessage({__voiceExt, payload}) -> 页面
 *
 * 只对识别宿主页生效（端口过滤），避免影响本机其他服务的页面。
 */
(function () {
  if (location.port !== '8765') return;

  // 页面 -> background
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;                 // 只接受本页面自身的消息
    if (!e.data || !e.data.__voiceHost) return;
    chrome.runtime.sendMessage({ target: 'background', ...e.data.payload }).catch(() => {});
  });

  // background -> 页面
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== 'host') return;
    window.postMessage({ __voiceExt: true, payload: msg }, '*');
  });
})();
