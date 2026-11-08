---
title: 运维
description: 运行多个实例、放在代理后面、升级，以及恢复丢失的密钥。
---

## 角色

一个 SupaBI 进程可以运行三种角色，默认全部运行：

| 角色 | 作用 |
|---|---|
| `api` | 提供网页界面和 API |
| `worker` | 运行导出和清理任务 |
| `scheduler` | 投递过期文件清理和每小时一次的维护任务 |

要拆分时，用 `--roles` 或 `SUPABI_ROLES` 指定：

```bash
bin/supabi serve --config supabi.yaml --roles api
bin/supabi serve --config supabi.yaml --roles worker,scheduler
```

拆分部署时仍然需要 worker 和 scheduler。每小时的维护任务会删除过期的会话、超过保留期的审计事件、陈旧的登录失败计数，以及超过保留期的工作空间。

## 多个实例

所有实例必须使用相同的：

- `secret-key`。启动时会检查，密钥不同的实例拒绝启动。
- 导出存储：在持久化存储上共享 `data-dir`，或者使用 `s3`。见[导出文件](/zh-cn/deployment/exports-and-cache/#导出文件)。
- 查询缓存：要共享缓存就用 `redis`。见[查询缓存](/zh-cn/deployment/exports-and-cache/#查询缓存)。

[通用设置](/zh-cn/admin/system/#通用设置)保存在元数据库里，所有实例看到的值都相同。

## 反向代理

SupaBI 只提供 HTTP，默认监听 `127.0.0.1`。要给其他人使用，设置 `http-addr`，并在前面放一个处理 HTTPS 的反向代理。

- **HTTPS**：传递 `X-Forwarded-Proto: https`。只有检测到 HTTPS 时，会话 Cookie 才带 `Secure` 标记。
- **Host**：按浏览器发来的原样传递 `Host` 请求头。SupaBI 会拒绝来源是别的主机的修改请求，并按这个主机和协议生成 [MCP](/zh-cn/admin/mcp/) 地址和登录用的端点。代理只转发部分路径时，除了 `/api/`，还要包括 `/mcp`、`/oauth/` 和 `/.well-known/`。
- **流式响应**：AI 回答是流式的。代理不能缓冲它，否则文字会全部堆到最后才出来。SupaBI 会发送 `X-Accel-Buffering: no`，nginx 遵守这个响应头，其他代理需要单独配置。
- **超时**：调大[查询超时](/zh-cn/admin/system/#通用设置)时，代理的超时也要相应调大。
- **请求大小**：SupaBI 读取的请求体最大为 [`http-max-body-size`](/zh-cn/deployment/configuration/#基础)，默认 8 MB。代理也要接受这么大的请求。nginx 的 `client_max_body_size` 默认是 `1m`，超过的请求会得到 nginx 的错误页，而不是 SupaBI 的提示。

## 健康检查

| 接口 | 含义 |
|---|---|
| `GET /healthz` | 存活检查，不依赖其他组件 |
| `GET /readyz` | 就绪检查，元数据库不可用时返回 503 |

## 升级

迁移在启动时自动运行。要单独运行，把 `auto-migrate` 设为 `false`，并在启动新版本前执行：

```bash
bin/supabi migrate --config supabi.yaml
```

迁移只能向前，不能回退。

## 备份

备份元数据库，并把 `secret-key` 和备份分开保管。没有密钥的备份无法解密保存的密码和 API 密钥，而密钥和备份放在一起，两者就一起泄露了。

## 日志

`log-level` 和 `log-format` 控制应用日志，`json` 适合接入日志系统。[审计事件](/zh-cn/admin/system/#审计日志)也会出现在日志里，是带 `msg=audit` 的行。

## 丢失密钥

`secret-key` 加密保存的数据源密码、AI 供应商的 API 密钥和邮件服务器的密码。丢失后它们无法解密，SupaBI 也会拒绝用别的密钥启动。恢复步骤：

1. 停止所有实例。
2. 查看将要清除的内容：

   ```bash
   bin/supabi clear-secrets --config supabi.yaml
   ```

3. 执行清除：

   ```bash
   bin/supabi clear-secrets --config supabi.yaml --yes
   ```

4. 用新的 `secret-key` 启动，重新填写数据源密码、API 密钥和邮件密码。数据源、供应商和邮件设置本身都会保留。
