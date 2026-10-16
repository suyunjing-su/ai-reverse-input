# New API Reserve Input Gateway

独立的 HTTP 反向代理：保留 New API 的鉴权、渠道、额度和上游路由，只在精确命中规则时改写模型用户输入，并可对 OpenAI Responses 创建端点执行显式配置的错误重试。

## 特性

- 默认透明转发：未命中规则的请求体按原始字节发送。
- Chat Completions、Responses、Anthropic Messages 的独立提示词适配器。
- 只修改最后一个实际 `user` 消息中的文本，保留系统消息、多模态内容和其他字段。
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
