---
title: 导出与查询缓存
description: 导出文件存在哪里，查询结果保存在哪里。
---

## 导出文件

导出文件默认放在[数据目录](/zh-cn/deployment/configuration/#基础)下的 `exports`。运行多个实例时，`api` 和 `worker` 角色必须在持久化存储上共享这个目录，或者把导出移到对象存储。

把 `export-storage` 设为 `s3` 后，使用 AWS S3 或兼容的存储（RustFS、Ceph RGW、各云厂商的对象存储），不再需要共享卷。文件仍由 API 转发给浏览器，每次下载都检查权限并写审计记录，不使用预签名链接。

| 配置项 | 含义 |
|---|---|
| `export-storage` | `local`（默认，数据目录）或 `s3` |
| `s3-endpoint` | 兼容存储的地址，比如 `https://s3.example.com`。留空时使用 AWS S3 |
| `s3-region` | 默认 `us-east-1`，请求按它签名 |
| `s3-bucket` | 存放文件的 bucket，必须事先创建 |
| `s3-prefix` | 对象键的前缀，用于多套部署共用一个 bucket，比如 `prod/` |
| `s3-path-style` | 用 `endpoint/bucket` 的形式访问 bucket。自建的 RustFS 和 Ceph 通常要打开 |
| `s3-access-key-id`、`s3-secret-access-key` | 访问密钥，要么都设置，要么都不设置 |

两个密钥都没有设置时，使用 AWS SDK 的默认凭证，比如 `AWS_ACCESS_KEY_ID` 等环境变量，或者 EKS、ECS、EC2 上的 IAM 角色。

启动时会检查 bucket 是否可以访问，不能访问就拒绝启动。

:::caution
切换存储不会迁移已有文件。切换之前生成、尚未过期的导出将无法下载。
:::

导出的限制（最大行数、文件保留时间等）在[通用设置](/zh-cn/admin/system/#通用设置)里。运行导出的后台任务属于 `worker` 角色，`export-workers` 设置每个进程同时运行多少个。

## 查询缓存

查询结果默认在每个实例的内存里保留 10 分钟，相同的查询直接使用上次的结果，同时进行的相同查询只执行一次。有效期在[通用设置](/zh-cn/admin/system/#通用设置)里修改，[数据源](/zh-cn/data/datasources/#查询设置)也可以单独设置。

| 配置项 | 含义 |
|---|---|
| `query-cache` | `memory`（默认，各实例独立缓存）、`redis`（实例之间共享）或 `off` |
| `query-cache-size` | `memory` 模式下使用的最大内存，比如 `256MB` |
| `redis-url` | 使用的 Redis，比如 `rediss://:PASSWORD@host:6379/0` |
| `redis-key-prefix` | 写入 Redis 的键的前缀，默认 `supabi:` |

运行多个实例时使用 `redis`，并注意：

- 缓存的总大小由 Redis 自己控制：设置 `maxmemory`，淘汰策略用 `allkeys-lru` 或 `volatile-lru`。
- Redis 里存的是查询结果，也就是业务数据，所以只对 SupaBI 开放，并设置密码。
- Redis 不可用时，查询照常运行，只是没有缓存，日志里会有警告。

数据权限不同的人不会共用缓存结果。
