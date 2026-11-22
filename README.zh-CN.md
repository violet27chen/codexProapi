# Codex Pro API

将账号可用的 Codex 模型动态获取并以 OpenAI 兼容 API 形式暴露，可在 Cline、Cursor 等支持 OpenAI 接口的客户端中使用。支持 Chat Completions（/v1/chat/completions）、Responses API（/v1/responses）和图像生成（/v1/images/generations）。

英文说明请参阅 README.md。

---

## 核心功能

- 多账号轮询与故障切换：请求在您配置的多个账号间自动轮询。若某一账号请求失败，代理将自动尝试使用下一个可用账号重试。
- 独立账号代理配置：支持为每个账号绑定单独的代理服务器（支持 HTTP、HTTPS、SOCKS 协议）。该账号的所有后端请求与 Token 刷新操作都将通过所绑定的代理进行路由。
- Token 自动刷新与健康恢复：后台自动定时刷新 OAuth access_token（最小时间间隔可配置为 5 分钟）。当刷新成功时，系统将自动清除该账号的“不可用”标记，使其重新参与轮询。
- 账号批量导入：支持通过粘贴或上传文本文件（.txt）方式批量导入 Refresh Token（一行一个），系统将自动换取 access_token 并保存账号。
- 优雅的交互式看板：集成账户管理、代理配置、实时请求监测、详细日志查看、模型可用性探测以及用量统计等功能。
- 中英双语支持：系统界面和请求日志均提供完整的英文与简体中文支持。

---

## 架构示意

![Codex Pro API 架构图](architecture-zh.png)

客户端（Cline、Cursor 等）通过 OpenAI 兼容接口访问本服务；服务使用已配置的 Codex 账号轮询请求并转发至 Codex 后端（chatgpt.com），并可根据账号单独的代理配置进行网络路由。

---

## 演示说明

**账号页 — 通过 OAuth 登录、手动填写 JSON 或批量导入添加账号，并可对每个账号绑定独立代理：**

![账号页](accounts.png)

**模型页 — 查看可用模型状态、延迟和配额：**

![模型页](models.png)

---

## 如何开始使用

### 方式一：桌面版（推荐）

不想使用命令行时，可直接安装桌面版：

1. 打开 GitHub Releases：https://github.com/violettoolssite/codexProapi/releases。
2. 选择最新版本，在 Assets 中下载 Windows 安装包：Codex Pro API Setup x.x.x.exe（安装时可选路径、桌面/开始菜单快捷方式）。
   说明：桌面版目前仅提供 Windows 版本。
3. 安装并运行。配置页会直接在软件窗口内打开，关闭软件后，本地服务会随之关闭。账号与数据保存在本机的用户数据目录下，与安装目录分离。

### 本地构建 Windows 安装包（开发者）

在项目目录执行以下命令，打包输出在 release/ 目录下：
```bash
npm run dist:win
```
若出现“Cannot create symbolic link”错误，请以管理员身份运行终端，或开启开发者模式（设置 -> 更新和安全 -> 开发者选项）后重试。

---

## 在客户端中使用（Cline、Cursor 等）

| 配置项 | 填写内容 |
|--------|----------|
| Base URL | http://localhost:1455/v1（必须包含 /v1；若使用自定义主机或端口，请改为对应地址 + /v1） |
| 模型 | 使用 `GET /v1/models` 返回的模型；可在系统设置选择默认模型，也可在每次请求中传入模型 ID |
| API Key | 任意填写（不进行强校验，认证基于您配置的 Codex 账号） |

### OpenAI 两种请求格式

Chat Completions 使用 `messages` 和 `/v1/chat/completions`；Responses API 使用文本/图片 `input` 和 `/v1/responses`，非流式响应为标准 `response` 对象，`stream: true` 时返回 Responses 事件流。Responses API 暂不支持 tools / function calling。

```bash
# Chat Completions
curl http://localhost:1455/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"自动获取的模型 ID","messages":[{"role":"user","content":"你好"}],"stream":false}'

# Responses API
curl http://localhost:1455/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"自动获取的模型 ID","input":"你好","stream":false}'
```

### 操作步骤：

1. 在 http://localhost:1455/ 的“账号”页选择网页登录、手动粘贴 auth.json、批量导入，或点击“导入本机 Codex”。使用本机导入前，先在运行 Codex Pro API 的设备上执行 `codex login`。
2. 如需为账号绑定专用代理，点击账号列表中“代理”列的“修改”按钮，输入代理 URL（如 http://127.0.0.1:7890）。
3. 在客户端中按照上表设置 Base URL 和模型，API Key 随意填写。
4. 发起对话即可，代理会自动处理轮询、异常重试以及 Token 刷新。

---

## 代理与 Token 刷新管理

### 网络代理与独立代理

若在登录时遇到地区限制或 access_denied：
1. 全局代理：确保系统代理或全局代理已开启，且浏览器访问 OpenAI 登录页也通过代理进行。
2. 独立代理：在账号列表的“代理”列为账号绑定单独的代理 URL。后续该账号的数据请求和 Token 刷新请求将直接通过该独立代理转发，无需开启系统全局代理。

### Token 自动刷新

可在系统设置页进行配置，后台刷新调度器定时运行（最小间隔为 5 分钟）。
- 成功刷新的账号将自动解除“不可用”状态，恢复使用。
- 设置页提供“立即刷新”按钮，可手动触发一次所有账号的 Token 刷新。

### 批量导入

在账号管理页点击“批量导入”按钮：
- 支持粘贴或上传含有多行 Refresh Token 的文本文件（一行一个）。
- 服务器会串行请求 OAuth 接口将每个 Refresh Token 换取为 access_token，并自动拉取账号 ID 后录入系统。

---

## 常见问题排查

### 登录时提示「地区限制」或 access_denied

- 确保登录页也走代理：点击“使用 Codex 登录”后跳转的 OpenAI 页面也必须走代理。如果仅有终端走代理而浏览器直连，依然会提示限制。
- 更换代理节点或 VPN 服务：部分节点可能存在 IP 泄漏或已被标记。建议尝试更换其他地区的可用节点。
- 改用粘贴 auth.json：在能正常登录的设备上提取 auth.json 文件（Windows 路径：%USERPROFILE%\.codex\auth.json），复制内容并通过“添加账号” -> “粘贴 JSON”添加。

### 后端报 400 "Missing required parameter: tool..."

当使用包含工具调用或函数调用的客户端时，如果后端由于格式不兼容返回 400，可尝试在客户端侧关闭工具/函数调用，或切换为纯文本对话模式。服务在无工具时会自动注入 tool_choice: none，但部分客户端发送的特殊 tools 字段仍可能被后端拦截。

### 请求接口返回 "fetch failed" / proxy_error

- 检查账号：确认已至少添加了一个有效的 Codex 账号。
- 检查网络连通性：在服务器环境运行 `curl -I https://chatgpt.com`。如果超时或连接失败，需要为账号配置独立代理或在服务器上开启全局代理。

---

## Claude Messages 兼容接口

`POST /v1/messages` 接收 Claude Messages 格式，请求可使用 `Authorization: Bearer <API_KEY>` 或 `x-api-key: <API_KEY>` 鉴权。响应保持 OpenAI `chat.completion` 或 `chat.completion.chunk` 格式。

```bash
curl -X POST http://localhost:1455/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{"model":"自动获取的模型 ID","max_tokens":1024,"system":"You are a helpful assistant.","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

---

## 图像生成

支持通过 POST /v1/images/generations（OpenAI 兼容格式）调用图像生成服务，由 picture_v2 协议支持。
- 支持的图片模型由上游模型目录和账号能力自动发现，不再固定列表。
- 返回值：返回一个本地代理 URL，浏览器可直接打开，缓存有效期为 30 分钟。

调用示例：
```bash
curl -X POST http://localhost:1455/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一只猫","n":1,"size":"1024x1024"}'
```

---

## 开源协议

MIT。问题与建议请前往 GitHub Issues 提交：https://github.com/violettoolssite/codexProapi/issues。
