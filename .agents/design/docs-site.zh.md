# 文档站

`docs/` 放给安装和使用 SupaBI 的人看的文档，构建成静态站点。设计材料仍放在 `.agents/`。本文记录文档站的构建方式和页面要遵守的规则。

## 1. 工具选择

使用 Astro Starlight。2026-11-02 用 0.42.8 版本和真实的 `api/openapi.yaml` 试过：

- 全文搜索在浏览器里运行，不需要外部服务。中文搜索都找到了正确的页面，中英文的索引是分开的。
- 内置的界面文字包含简体中文。唯一的例外是搜索框的提示：Pagefind 自带的中文包虽然打进了产物，但运行时退回英文，所以这些文字在 `docs/src/content/i18n/zh-CN.json` 里又写了一份。
- 只需要 `mise.toml` 里已有的 Node 和 pnpm。

其他几个是根据它们的文档和 npm 发布情况判断的，没有实际试过：

- **Hugo** 虽然用 Go 编写，但在这里没有好处。站点和后端不共用代码，而修改主题要在第三方主题上写 Go 模板。
- **VitePress** 基于 Vue，而应用用的是 React，它的 2.0 还在 alpha 阶段。
- **Docusaurus** 最强的是文档版本管理，在没有真实用户时用不上，它的标准搜索方案也是外部服务。

## 2. 目录结构

- `docs/` 是独立的包，有自己的 lockfile。它不属于 `web/` 工作区，也不会嵌入二进制，所以 `make build`、`make build-go` 和 `make test` 都不涉及它。`go.mod` 忽略 `./docs` 的原因和忽略 `./web` 相同。
- 页面放在 `docs/src/content/docs/`：英文在顶层，中文在 `zh-cn/` 下，相对路径相同。
- 侧边栏列在 `docs/astro.config.mjs` 里，新增页面要加到这里。
- 函数参考不是手写的。`docs/src/components/FunctionList.astro` 在构建时读取 `web/apps/app/src/i18n/functions.*.ts`，所以界面和文档用同一份文字。它的分类清单和 `internal/expr/functions.go` 相同，函数没有分类时构建会失败。

## 3. 语言和用词

- 英文在 `/`，中文在 `/zh-cn/`，和 README 保持一致。
- 每个页面都有两种语言，改动一种语言时，另一种语言的同样改动放在同一个提交里。Starlight 用目录区分语言，所以 `.agents/` 的 `*.zh.md` 命名不适用于这里。
- 界面上的名称按语言包原样引用：英文取自 `web/apps/app/src/i18n/en-US.ts`，中文取自 `zh-CN.ts`。
- 教程里的步骤要先在运行中的产品里走一遍，再写下来。
- 用户能看到的改动，要在同一个提交里更新对应的页面。README 只保留简短摘要和 `images/` 里的截图，这些页面是唯一完整描述功能的地方。截图展示的界面变了就要重拍。

## 4. 版本

Starlight 还在 0.x，小版本可能改配置，0.39 就改过侧边栏分组。`docs/package.json` 锁定确切版本，升级作为单独的改动，先读更新日志再做。

## 5. 命令

| 命令 | 说明 |
|---|---|
| `make docs-dev` | 启动站点并实时刷新，地址 http://localhost:4321/supabi/ |
| `make docs-build` | 把静态站点构建到 `docs/dist/`，包括搜索索引 |

## 6. 内容

快速开始、概念，然后是数据、图表、仪表盘、管理和部署各一章，两种语言都有。暂缓的内容见[暂缓事项](../backlog.zh.md)的“文档站”一节。

## 7. 发布

站点由 GitHub Pages 托管，地址是 https://supazd.github.io/supabi/。站点没有自己的域名，所以用的是 GitHub 给仓库的地址。

- `.github/workflows/docs.yml` 用 `make docs-build` 构建站点，然后部署 `docs/dist/`。`main` 上的推送改动了 `docs/`，或者改动了 `FunctionList.astro` 读取的函数语言包（第 2 节）时，它就会运行，也可以手动运行。产物从运行中直接交给 Pages，不会提交进仓库，也没有 `gh-pages` 分支。仓库的 Pages 来源设为 “GitHub Actions”。
- 站点在 `/supabi/` 下，所以 `docs/astro.config.mjs` 里的 `base` 是 `/supabi`，开发时也一样。Astro 会给它自己生成的链接加上 base，但不会给页面里写的链接加。
  - 页面之间照旧从站点根目录写链接，例如 `[数据集](/zh-cn/data/datasets/)`，构建时由 `astro.config.mjs` 里的一个小插件加上 base。页面自己不写 `/supabi`。这个插件运行在 Sätteri 里，它是 Astro 7 默认的 Markdown 处理器；为了在配置里写出这个处理器，`@astrojs/markdown-satteri` 是 `docs/` 的依赖，Starlight 也把它自己的插件加到同一个处理器上。为旧的 unified 处理器写的插件（remark 和 rehype）需要另外安装它，装上后所有 Markdown 都会改由它处理。
  - frontmatter 里的链接（例如首页的按钮）不是 Markdown，插件处理不到，所以写成相对于本页的链接，例如 `getting-started/install/`。
  - Starlight 根据 URL 判断 `<Code>` 组件的语言，但没有先去掉 base，所以在中文页面上会退回英文。`FunctionList.astro` 把页面的语言作为 `locale` 传进去，以后其他用到 `<Code>` 的组件也要这样做。
- 如果以后站点有了自己的域名，把 `site` 改成这个域名，再删掉 `base` 和插件即可，页面不用改。
