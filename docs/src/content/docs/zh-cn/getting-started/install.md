---
title: 安装 SupaBI
description: 在自己的机器上试用 SupaBI，或者作为服务给团队使用。
---

目前还没有预编译的安装包，SupaBI 需要从源码构建。想先看看，就在自己的机器上用示例数据运行；要给团队使用，就作为服务运行。

## 获取源码

两种方式都要先取得一份仓库代码：

```bash
git clone https://github.com/supazd/supabi.git
cd supabi
```

## 在自己的机器上试用

你需要 [Docker](https://www.docker.com) 和 [mise](https://mise.jdx.dev)，mise 会安装项目使用的 Go、Node 和 pnpm 版本。在仓库根目录运行：

```bash
mise install
make dev-up
make dev-seed
make run
```

`make dev-up` 在 Docker 里启动数据库，`make dev-seed` 载入约 2 万条示例订单，`make run` 构建并启动 SupaBI。这些命令用的密钥在仓库里是公开的，只适合本地试用。

打开 <http://localhost:8080>，创建管理员账号，然后[制作第一个仪表盘](/zh-cn/getting-started/first-dashboard/)。

## 作为服务运行

SupaBI 把账号、仪表盘等自身的数据存在 PostgreSQL 里。启动前先为它建一个空数据库。

### 构建

```bash
make build
```

这会在 `bin/supabi` 生成一个静态二进制文件，里面已包含网页界面。要为其他平台构建，设置 `GOOS` 和 `GOARCH` 即可。

### 配置

生成配置文件和密钥：

```bash
bin/supabi example-config > supabi.yaml
bin/supabi generate-key
chmod 600 supabi.yaml
```

在 `supabi.yaml` 里填上两个必填项：

```yaml
database-url: postgres://supabi:PASSWORD@db.internal:5432/supabi
secret-key: THE_KEY_FROM_GENERATE_KEY
```

:::caution
`secret-key` 用来加密 SupaBI 保存的数据源密码和 AI 服务商密钥。只生成一次，并妥善保管。一旦丢失，这些密码和密钥都要重新填写。
:::

文件里的其他配置项都有说明和默认值，也都可以用命令行参数或环境变量设置：`http-addr` 对应 `--http-addr` 和 `SUPABI_HTTP_ADDR`。命令行参数优先于环境变量，环境变量优先于配置文件。

### 启动

```bash
bin/supabi serve --config supabi.yaml
```

SupaBI 在启动时执行数据库迁移，并监听 `127.0.0.1:8080`。打开这个地址，创建管理员账号。

### 对外提供服务

默认只有本机能连接。要给其他人使用，把 `http-addr` 改成 `0.0.0.0:8080` 这样的地址，并在前面放一个处理 HTTPS 的反向代理，因为 SupaBI 本身只提供 HTTP。

负载均衡器可以使用这两个接口：

| 接口 | 含义 |
|---|---|
| `GET /healthz` | 进程存活 |
| `GET /readyz` | 服务已就绪，元数据库不可用时返回 503 |
