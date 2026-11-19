# New API Reserve Input Gateway

独立的 HTTP 反向代理：保留 New API 的鉴权、渠道、额度和上游路由。命中模型规则时，在原有系统指令之后追加固定提示词；也可按配置重试指定的上游错误。

## 特性

- 面板可启用临时 Debug 抓取（默认关闭）：按请求独立记录实际转发正文和发送给客户端的响应正文。记录仅保存在进程内存，最多 20 条；请求和响应各保留最多 256 KiB，超出会标记截断。关闭、清空或重启服务会删除记录；正文可能包含敏感信息，不写入普通日志、不保存认证头和 Cookie。
- 对三个创建接口按协议追加系统提示词，不改写用户输入、多模态内容或工具调用：
  - `POST /v1/messages`：追加到 `system` 字符串，或在 `system` 数组末尾追加独立文本块；保留原有块与 `cache_control`。
  - `POST /v1/responses`：追加到 `instructions` 字符串；带 `previous_response_id` 的请求也独立处理，不读取历史轮次。
  - `POST /v1/chat/completions`：在开头连续的 `system` / `developer` 消息之后插入独立消息；存在 `developer` 时沿用该角色，否则使用 `system`。指令和对话交错时原样转发，不重排历史。
- 未匹配模型、规则停用或提示词为空时不改写。不为 `/v1/chat/completion`、`/v1/completions`、模型列表或 token 计数请求注入。
- Responses 非流式错误重试，以及有界 SSE 前置阶段重试；不会缓存整段正常 SSE。
- JSON 文件持久化，无需外部数据库；配置快照在单次请求内保持一致。
- 管理面板和 cookie 会话认证；密码使用 Node `scrypt` 哈希，日志不记录密钥、提示词和响应。
- Node.js 原生模块实现，运行时无第三方依赖。

## 启动

```sh
cp .env.example .env
# 编辑 .env，至少设置 NEW_API_BASE_URL 和 ADMIN_PASSWORD
npm test
npm start
```

打开 `http://127.0.0.1:8787/admin/` 登录。首次启动必须通过 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建管理员；已有 `data/admin.json` 时环境变量不会覆盖已存储凭据。

## 配置

完整变量见 [.env.example](.env.example)。`NEW_API_BASE_URL` 可以包含路径前缀，例如 `https://new-api.example/internal`；客户端的原始路径和查询参数会接在该前缀之后。逐跳请求头由代理剔除，`Authorization`、`x-api-key` 等端到端头会保留且不会写入日志。

管理员可配置：

- 模型提示词规则：模型 ID 精确匹配、独立正文/启停/统计。
- Responses 重试：全局开关、HTTP 状态码精确规则（适用于 Chat Completions、Responses、Anthropic Messages 三个 POST 接口）、JSON `error.code` 精确规则、`message` 精确或大小写不敏感子串规则、最大重试次数、退避、总时限和 SSE 前置缓存上限。任一启用的状态码、code 或 message 规则命中即满足重试条件。
- 系统设置：上游地址、监听设置展示和运行限制展示。

## 重试边界

默认关闭重试。状态码重试仅适用于三个 `POST` 创建接口：`/v1/chat/completions`、`/v1/responses` 和 `/v1/messages`；其他路径和网络异常不会隐式重试。JSON `error.code`/`message` 错误匹配仍仅适用于 Responses API。非流式响应会在交付前检查 HTTP 状态码规则和明确的 JSON 错误对象。流式请求会先检查匹配的 HTTP 状态码；Responses 还会在尚未交付实质输出的有界前置事件阶段检查 SSE 错误；一旦透传开始，后续失败按上游原始 SSE 语义交付，不会伪装成无缝重试。Chat Completions 和 Anthropic Messages 的正常流式响应不经过不必要的 SSE 前置缓存。重试请求复用已经完成的提示词改写体，因此不会重复注入。

## 生产部署

建议将服务绑定在内网或 TLS 反向代理之后，使用随机长密码，并把 `data/` 放在权限受限的持久卷。生产环境设置 `COOKIE_SECURE=true`；管理端点不要直接暴露公网。Docker Compose 默认只绑定宿主机回环地址，外部 TLS 代理应通过受控网络接入。健康检查为 `GET /healthz`，返回上游配置状态但不包含凭据。容器示例见 `Dockerfile` 和 `docker-compose.yml`。本项目不会安装、修改或重启 New API。

## 开发

```sh
npm run check
npm test
npm run dev
```

测试使用本地 Node HTTP 模拟上游，覆盖透明转发、三种协议注入、热更新、非流式和 SSE 重试、分块 SSE 解析、重试边界和认证。
