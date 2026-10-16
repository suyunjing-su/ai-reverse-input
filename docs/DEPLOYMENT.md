# 部署说明

1. 在 New API 前启动本网关，`NEW_API_BASE_URL` 指向 New API 的可达地址。
2. 生产环境设置 `COOKIE_SECURE=true` 并通过 HTTPS 访问管理面板。首次启动设置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。服务会将用户名与 `scrypt` 哈希写入 `DATA_DIR/admin.json`；之后删除环境变量也不会删除凭据。
3. 保护 `DATA_DIR`，它包含规则、策略和管理员哈希。不要把它提交到 Git。
4. 用外部 TLS 终止代理保护管理面板和客户端 API；上游 URL 使用 HTTPS 时，网关到 New API 的链路同样加密。Compose 默认仅将端口绑定到 `127.0.0.1`。
5. 通过 `/healthz` 做存活探针。它不验证上游可用性，不应用客户端鉴权。
6. 优雅关闭会停止接收新连接，现有流请求由 Node 处理；编排系统应等待进程退出。

## 代理行为

请求路径保持客户端原值，并与 `NEW_API_BASE_URL` 的路径前缀合并一次。请求体只有在支持的 JSON 协议、规则命中且能定位文本时才重写；否则原始字节透传。改写后的请求使用新的 `Content-Length`，并删除不适用的逐跳/传输头。

## 安全边界

管理 API 全部要求登录 cookie；登录 cookie 是内存会话，重启后失效。日志只记录方法、路径类别、状态、耗时、尝试次数和脱敏错误类型。不会记录 `Authorization`、`x-api-key`、完整请求/响应或提示词。
