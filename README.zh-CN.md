# Voice Page Controller（语音控制浏览器）

[English](README.md) | **简体中文**

用语音控制浏览器。说一句指令，插件调用大模型把语音解析成动作，并在当前页面上执行——滚动、搜索、控制视频播放、填写表单、前进后退。

无需注册账号、无需后端服务、不采集任何数据。大模型 API Key 由你自己提供，麦克风只在开启语音控制时采集。

## 功能特性

- **自然语言指令**——「向下滚动」「搜索人工智能」「看第三个视频」。
- **页面感知**——会把当前页面的标题、URL、视频列表和链接作为上下文一起提交，因此「打开第二个链接」能准确命中。
- **视频控制**——播放/暂停、快进快退、倍速、音量、点赞。
- **表单填写**——语音填写用户名、姓名、电话、邮箱、验证码，并可直接说「提交」。
- **模型可选**——火山方舟、阿里 DashScope、DeepSeek（均为 OpenAI 兼容接口）。
- **双入口**——每个页面右侧的悬浮球，以及带配置项的扩展弹窗。
- **隐私优先**——不写开机自启、无后台常驻服务、不采集数据；关闭语音控制即释放麦克风。

## 支持的指令

| 类别 | 示例 | 对应动作 |
| --- | --- | --- |
| 滚动 | 「向下滚动」「回到顶部」 | `scroll` |
| 搜索 | 「搜索 xxx」「查一下 xxx」 | `search` |
| 打开 | 「打开 B 站」「打开第二个链接」 | `open_page`、`watch` |
| 清理 | 「清理广告」 | `clean_ads` |
| 视频 | 「暂停」「快进 10 秒」「1.5 倍速」「音量 60」「点赞」 | `play_pause`、`seek`、`speed`、`volume`、`like` |
| 表单 | 「用户名填 alice」「姓名张三，电话 138…，提交」 | `fill_user`、`fill_field`、`focus_password`、`submit_form` |
| 导航 | 「刷新」「后退」「前进」 | `reload`、`back`、`forward` |

密码框**不会**被语音填写——插件只会把光标聚焦到密码框，由浏览器密码管理器或你手动输入。

## 工作原理

```
 麦克风 ──► 宿主页（http://127.0.0.1:8765/speech.html）
              │  Web Speech API（真实网页源，麦克风授权才能正常弹窗）
              ▼
        host_bridge.js  ──chrome.runtime──►  background.js
              ▲                                  │
              │                                  ├─► 大模型 API（指令 → JSON）
              └──────────── 执行结果 ─────────────┘
                                                 │
                                          当前标签页的 content.js
                                          （滚动 / 填写 / 提交 / 刷新 …）
```

为什么识别不放在扩展内部？Edge 对 `chrome-extension://` 源的 `SpeechRecognition` 直接拒绝且不弹授权框。把识别放到真实的 `http://127.0.0.1` 网页源上，只需授权一次即可长期使用。

## 安装

1. 下载或克隆本仓库。
2. 打开 `edge://extensions`（或 `chrome://extensions`），开启「开发人员模式」。
3. 点击「加载解压缩的扩展」，选择 `voice-control-extension` 目录。

## 使用配置

1. **启动宿主服务**（需要 Python 3）：
   ```bash
   cd voice-control-extension/server
   python -m http.server 8765 --bind 127.0.0.1
   ```
   Windows 下可直接双击 `server/start_server.bat`。使用期间保持该窗口开启，关闭窗口即停止服务，不会写入开机启动项。
2. **授权麦克风**——点扩展图标 → 「授权麦克风」，在打开的页面点击按钮并允许 `127.0.0.1` 使用麦克风。
3. **配置模型**——在弹窗中选择厂商并粘贴 API Key：
   - 火山方舟：`https://ark.cn-beijing.volces.com/api/v3`
   - 阿里 DashScope：`https://dashscope.aliyuncs.com/compatible-mode/v1`
   - DeepSeek：`https://api.deepseek.com`
4. 打开语音控制开关即可说话。宿主页会以固定标签页留在后台，切换网页不会中断识别。

## 目录结构

```
voice-control-extension/
├─ manifest.json          # MV3 清单
├─ background.js          # 服务工作线程：大模型请求、指令分发、宿主页生命周期
├─ content/
│  ├─ content.js          # 页面内动作：滚动、搜索、视频、表单、提交
│  ├─ floating.js         # 悬浮球界面
│  └─ host_bridge.js      # 宿主页的 postMessage ↔ chrome.runtime 消息桥
├─ popup/                 # 配置面板与开关
├─ server/
│  ├─ speech.html         # 宿主页：麦克风授权 + 语音识别
│  └─ start_server.bat    # 一键启动本地静态服务（Windows）
└─ tests/                 # 模型连通性与语音接口测试脚本
```

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 访问 `127.0.0.1:8765` 返回 `404` | 服务启动目录不对。请在 `server/` 目录内启动，或直接双击 `start_server.bat`。 |
| 识别时提示 `not-allowed` | `127.0.0.1` 的麦克风被拒绝，到 `edge://settings/content/microphone` 重新允许。 |
| 大模型接口返回 `401` | API Key 无效或已过期。先用命令行直接向厂商验证 Key，再改代码。 |
| 某些页面没有反应 | 浏览器商店、PDF 阅读器、跨域 iframe 表单等页面会限制扩展脚本注入。 |

## 已知限制

- 识别依赖浏览器内置的 Web Speech 服务，需要联网，Chrome/Edge 下效果最好。
- 跨域 iframe 内的表单（部分银行、政务、统一登录页面）无法填写。
- 图片验证码无法识别，只能填你口述的数字。
- 语音指令执行前没有二次确认，提交前请先核对表单内容。

## 许可证

MIT
