---
title: 配置
description: 所有启动配置项，以及配置怎样传给 SupaBI。
---

启动配置只包含属于每个实例的内容，以及连接元数据库之前需要的内容。全组织共用的设置（比如导出限制、查询超时）不在这里，由系统管理员在[通用设置](/zh-cn/admin/system/#通用设置)里修改。

## 设置方式

所有配置都可以写在一个 YAML 文件里，用 `--config` 或环境变量 `SUPABI_CONFIG` 指定：

```bash
bin/supabi example-config > supabi.yaml   # 列出所有配置项，带说明和默认值
bin/supabi serve --config supabi.yaml
```

每一项也可以用命令行参数或环境变量设置：`http-addr` 对应 `--http-addr` 和 `SUPABI_HTTP_ADDR`。命令行参数优先于环境变量，环境变量优先于配置文件。配置文件里被覆盖的项会在启动日志中列出。不用配置文件、只用环境变量和命令行参数也可以运行。

相对路径从工作目录算起，建议使用绝对路径。

如果配置里还留着已迁到系统管理的设置，SupaBI 会拒绝启动，并说明它迁到了哪里。

## 配置项

### 基础

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `database-url` | 必填 | PostgreSQL 元数据库 |
| `secret-key` | 必填 | 加密保存的密码和 API 密钥。用 `supabi generate-key` 生成一次 |
| `roles` | 全部 | 要运行的角色，取自 `api`、`worker`、`scheduler`，用逗号分隔 |
| `http-addr` | `127.0.0.1:8080` | `api` 角色的监听地址 |
| `auto-migrate` | `true` | 启动时执行待处理的迁移。关闭后，启动新版本前要先运行 `supabi migrate` |
| `data-dir` | `data` | 数据目录。`export-storage: local` 时导出文件存在这里 |

### 日志

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `log-level` | `info` | `debug`、`info`、`warn` 或 `error` |
| `log-format` | `text` | `text` 或 `json` |

### 导出

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `export-storage` | `local` | `local` 表示数据目录，`s3` 表示对象存储 |
| `export-workers` | `2` | 每个 worker 进程同时运行的后台任务数，1 到 32 |

S3 配置项见[导出与查询缓存](/zh-cn/deployment/exports-and-cache/#导出文件)。

### 查询缓存

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `query-cache` | `memory` | `memory` 表示各实例独立缓存，`redis` 表示共享，`off` 表示关闭 |
| `query-cache-size` | `256MB` | `memory` 模式下缓存占用的最大内存 |
| `redis-url` | | `redis` 模式下使用的 Redis |
| `redis-key-prefix` | `supabi:` | 写入 Redis 的键的前缀 |

## 密钥

`secret-key`、`s3-access-key-id` 和 `s3-secret-access-key` 没有命令行参数，所以不会出现在进程列表里。`redis-url` 可能包含密码，也不要写在命令行参数里。

配置文件里有密钥后，应该只让运行 SupaBI 的用户能读取：

```bash
chmod 600 supabi.yaml
```

要把配置文件放进版本控制或配置中心，就删掉这几行，改用环境变量提供。

## 命令

| 命令 | 含义 |
|---|---|
| `supabi serve` | 运行服务。全部参数见 `supabi serve -h` |
| `supabi migrate` | 执行待处理的迁移后退出 |
| `supabi clear-secrets` | 丢失密钥后清除保存的密码和 API 密钥，见[运维](/zh-cn/deployment/operations/#丢失密钥) |
| `supabi example-config` | 输出包含所有配置项的配置文件 |
| `supabi generate-key` | 输出一个新的 `secret-key` |
| `supabi version` | 输出版本信息 |
