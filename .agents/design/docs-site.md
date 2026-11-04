# Documentation site

`docs/` holds the documentation for people who install and use SupaBI, built into a static site. Design material stays in `.agents/`. This file records how the site is built and the rules its pages follow.

## 1. Choice of tool

Astro Starlight. It was tried on 2026-11-02 at version 0.42.8, with the real `api/openapi.yaml`:

- Full-text search runs in the browser and needs no outside service. Chinese queries found the right pages, and English and Chinese have separate indexes.
- The built-in interface text includes Simplified Chinese. The one exception is the messages of the search box: Pagefind's own Chinese strings are in the build, but at run time it falls back to English, so they are repeated in `docs/src/content/i18n/zh-CN.json`.
- It needs only the Node and pnpm already in `mise.toml`.

The others were judged from their documentation and npm releases, not tried:

- **Hugo** gets no benefit here from being written in Go. The site shares no code with the backend, and changing a theme means Go templates on top of a third-party theme.
- **VitePress** is built on Vue where the app is React, and its 2.0 is still in alpha.
- **Docusaurus** is strongest at versioned documentation, which is not needed while there are no real users, and its standard search is an outside service.

## 2. Layout

- `docs/` is a package of its own with its own lockfile. It is not part of the `web/` workspace and is never embedded in the binary, so `make build`, `make build-go` and `make test` do not touch it. `go.mod` ignores `./docs` for the same reason it ignores `./web`.
- Pages are in `docs/src/content/docs/`: English at the top, Chinese under `zh-cn/` with the same relative path.
- The sidebar is listed in `docs/astro.config.mjs`. A new page has to be added there.
- The function reference is not written by hand. `docs/src/components/FunctionList.astro` reads `web/apps/app/src/i18n/functions.*.ts` at build time, so the interface and the documentation have one text. Its list of categories repeats `internal/expr/functions.go`, and the build fails if a function has no category.

## 3. Languages and wording

- English is served at `/` and Chinese at `/zh-cn/`, in keeping with the README.
- Every page exists in both languages, and a change to one goes in the same commit as the same change to the other. Starlight tells languages apart by directory, so the `*.zh.md` naming of `.agents/` does not apply here.
- Names from the interface are quoted exactly as the language packs have them: `web/apps/app/src/i18n/en-US.ts` for English and `zh-CN.ts` for Chinese.
- Steps in a tutorial are walked through in the running product before they are written down.
- A change that users can see updates the matching page in the same commit. The README keeps only a short summary and the screenshots in `images/`, so the pages are the only full description of features. Those screenshots are retaken when the interface they show changes.

## 4. Versions

Starlight is still at 0.x and a minor release can change its configuration, as 0.39 did with sidebar groups. `docs/package.json` pins exact versions, and an upgrade is a change of its own, made after reading the changelog.

## 5. Commands

| Command | Description |
|---|---|
| `make docs-dev` | Starts the site with live reload, at http://localhost:4321/supabi/ |
| `make docs-build` | Builds the static site into `docs/dist/`, including the search index |

## 6. Contents

Getting started, concepts, then a chapter each for data, charts, dashboards, administration and deployment, in both languages. Anything deferred is in [Deferred items](../backlog.md) under "Documentation site".

## 7. Publishing

The site is served by GitHub Pages at https://supazd.github.io/supabi/. It has no domain of its own, so this is the address GitHub gives the repository.

- `.github/workflows/docs.yml` builds the site with `make docs-build` and deploys `docs/dist/`. It runs when a push to `main` changes `docs/` or the function packs that `FunctionList.astro` reads (section 2), and it can also be run by hand. The output goes from the run straight to Pages: it is never committed, and there is no `gh-pages` branch. The repository's Pages source is set to "GitHub Actions".
- The site lives under `/supabi/`, so `base` in `docs/astro.config.mjs` is `/supabi`, in development too. Astro puts the base in front of the links it builds itself, but not in front of links written in the pages.
  - Pages go on linking to each other from the site root, as in `[Datasets](/data/datasets/)`, and a small plugin in `astro.config.mjs` adds the base when the site is built. Pages never write `/supabi` themselves. The plugin runs in Sätteri, the Markdown processor Astro 7 uses by default, so `@astrojs/markdown-satteri` is a dependency of `docs/` to name it; Starlight adds its own plugins to the same processor. Plugins written for the older unified processor (remark and rehype) would need it installed, and all Markdown would then go through it.
  - Links in frontmatter, such as the buttons on the home pages, are not Markdown and the plugin never sees them, so they are written relative to the page, as in `getting-started/install/`.
  - Starlight works out the language of a `<Code>` component from its URL without removing the base first, so it falls back to English on Chinese pages. `FunctionList.astro` passes the page's language as `locale`, and any other component that uses `<Code>` has to do the same.
- If the site gets a domain of its own, set `site` to it and remove `base` and the plugin. The pages stay as they are.
