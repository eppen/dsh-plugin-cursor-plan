# dsh-plugin-cursor-plan

English | [中文](README.zh.md)

A cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that registers a **read-only** `cursor_plan` tool, letting the model list and read `*.plan.md` plan files produced by Cursor's Plan mode.

- Pure ESM, zero dependencies — only `node:fs` / `node:path` / `node:os`
- Imports no `@deepseek-ai/*`; implements the dsh-tools tool contract directly
- **Read-only**: never writes, edits, or deletes files (the only writer in a dsh setup is the harness session log, unrelated to this plugin)

## Install

### One-liner (git source, recommended)

```bash
dsh plugin --profile web add "github:eppen/dsh-plugin-cursor-plan#main"
```

`dsh plugin` runs `pnpm add` inside the profile, then mounts this package (which declares `dsh.bundle`) into the profile's bundle layer stack — no manual `cordis.patch.yml` edit. Then **restart** `dsh web` (the web profile has `hmr` disabled by the `dsh-web-app` patch, so plugin changes are not hot-reloaded).

> Requires `pnpm` on the machine (`dsh plugin` is a pnpm forwarder).

### Local development (mount `file:///` directly)

Instead of installing into the profile's `node_modules`, mount the source into the user patch layer. Add this entry to `~/.dsh/profiles/web/cordis.patch.yml` (the file is a top-level YAML array):

```yaml
- insert:
    - id: cursor-plan
      name: 'file:///D:/Tools/dsh-plugin-cursor-plan/index.mjs'
```

Then **restart** `dsh web`.

The `file:///` prefix matters: cordis's loader calls `import(name)` for specifiers that don't start with `.`, so a bare `D:/...` is treated as a package name and fails.

> Pick one: after a bundle install, remove the user-layer `file:///` insert with the same `id` (the user layer applies after bundle layers and would shadow it).

### Verify

```bash
dsh --profile web --dump-config | grep -A3 cursor-plan
```

Expect `id: cursor-plan` plus `name: 'dsh-plugin-cursor-plan'` (bundle install) or `name: 'file:///...'` (direct mount), with existing nodes such as `id: tools` and `id: plan-mode` still present.

## Uninstall

- Bundle install: `dsh plugin --profile web remove dsh-plugin-cursor-plan`, then restart `dsh web`
- Direct mount: delete that `insert` entry from `cordis.patch.yml` (an empty array `[]` also works), then restart `dsh web`

## Tool signature

Name: `cursor_plan`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"list"` \| `"read"` | yes | list / read |
| `match` | string | no | `list` only: **case-insensitive** substring filter on name / overview / filename |
| `limit` | integer | no | `list` only: max rows, default `20`, hard cap `100` (values above are clamped; `<=0` falls back to 20) |
| `file` | string | no | `read` only: absolute plan path that must live inside one of the source dirs below |
| `basename` | string | no | `read` only: plan file name (e.g. `Plan-642d0fd6.plan.md`), or the `name` returned by `list` |

`read` takes exactly one of `file` / `basename`; when both are given, `file` wins.

The model receives text like:

```
Cursor plans: 20/1082 (limit 20)
roots: C:\Users\<you>\.cursor\plans | D:\work\proj\.cursor\plans
1. [home] Plan name — overview summary (file.plan.md, 2026-11-18 11:33)
   file: C:\Users\<you>\.cursor\plans\file.plan.md
… 1062 more not shown; narrow with match or raise limit (max 100)
```

`read` returns `name` / `overview` / `todos` (`[status] id: content`) plus the body Markdown; bodies longer than 20000 chars are truncated with a notice.

## Source directories (allowlist)

Only these two locations are scanned and only they are readable:

1. `~/.cursor/plans` — scope `home`
2. `.cursor/plans` under the current **session working directory** — scope `workspace`. The session directory comes from dsh's `workingDirectory` service (changing it per session takes effect immediately); when that service is unavailable (programmatic calls, not mounted) the plugin falls back to the dsh process launch directory `process.cwd()`. The two roots are de-duplicated when they resolve to the same directory: `roots` shows a single entry and the listing is not duplicated.

Path validation for `read`: `path.resolve(file)`, then `path.relative` must place the target **inside** one of the directories above; `..` traversal and anything outside is rejected with `error: "path-not-allowed"`.

Parsing rules:

- frontmatter may be separated from the start of the file by a leading HTML comment (the `<!-- uuid -->` Cursor writes) and blank lines — real files look like this
- frontmatter without a closing `---` is treated as body; nothing is swallowed
- `todos` accepts `[]` or an indented `- id/content/status` list; `overview` accepts `|` / `>` block scalars
- single-file read cap 200KB (over → `error: "too-big"`); listing reads only the first 32KB of each file

Error codes (returned as canonical values, never thrown): `bad-action` / `path-not-allowed` / `not-found` / `ambiguous` / `not-file` / `too-big` / `read-failed`.

## Publishing to the plugin market

dsh has **no official market**. The Web UI's **Discover** tab lists only the *plugin indexes* the user adds itself — official docs `docs/user/guide/plugin-market.md`: "DSH ships no index source". A plugin index is one UTF-8 JSON file (**format 1**) listing installable bundles with their titles, icons, authors and versions, served from any static host. The only discovery channel the official README names is the singular **`dsh-plugin`** GitHub topic.

This package is set up for both:

- `package.json` declares `dsh.bundle.patch` and does **not** set `"private": true` (generators skip git-source packages that do)
- `engines.dsh` declares the compatible range
- `locale/en.json` / `locale/zh.json` provide the card title and description
- `market/index.json` is a ready-to-host format-1 index, and the repo carries the `dsh-plugin` topic

### The index in this repo

`market/index.json` is generated from `package.json` plus git tags:

```bash
npm run build:index     # node scripts/build-index.mjs
npm run check:index     # offline check of every format-1 rule
```

Each version is pinned to a 40-character commit (`source.type: "git"`), which installs as `git+https://github.com/eppen/dsh-plugin-cursor-plan.git#<commit>`. **Rebuild the index after tagging, never before** — otherwise a version points at a commit whose `package.json` still carries the old version.

`npm run check:index` mirrors the official rules; the authoritative validator (`@deepseek-ai/dsh-plugin-market-index`) runs inside dsh's `app.asar`, so the only end-to-end check is adding the URL in Discover. This index has been validated with that package's `parseMarketIndex`.

### Hosting

The icon is inlined as a ~0.5 KB `data:` URL, so the index is a single self-contained file — any static host works:

| Host | URL to add as an index source |
|---|---|
| jsDelivr over GitHub (no setup) | `https://cdn.jsdelivr.net/gh/eppen/dsh-plugin-cursor-plan@main/market/index.json` |
| GitHub Pages (repo Settings → Pages) | `https://eppen.github.io/dsh-plugin-cursor-plan/market/index.json` |
| your own site / object store | any https URL serving `market/index.json` |

dsh gives an index source only 15 seconds, so prefer a CDN over a slow origin. Tags make the URL pinnable, and from `v0.1.2` on `market/index.json` also exists inside the tagged tree, so `.../@v0.1.2/market/index.json` resolves: `main` stays the canonical copy and a tag's copy is frozen at that release.

### User side

1. Plugins → **Experimental plugins** → enable **Custom plugin indexes**
2. **Discover** → **Add index source** → paste one of the URLs above
3. Pick the card → **Install** → confirm the source → restart `dsh web`

### Other channels

- **`dsh-plugin` topic** (singular — the plural `dsh-plugins` is not what the official README asks for). This is what every automatic scanner reads; npm `keywords` does **not** set the GitHub topic.
- **[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)** is the curated list most markets consume — `dsh-market` / `dshmarket` read its `plugins.json` and reject other sources, so an entry there is the only way into those markets. Submission = one PR adding `data/plugins/<owner>__<repo>.yml` (do not PR against the market app itself).
- Several markets scan `topic:dsh-plugin` live and need no submission at all.

## Development / tests

```bash
cd /d/Tools/dsh-plugin-cursor-plan
node --test test/                 # 23 cases: 13 parser + 10 index/workspace-root
node -e "import('./index.mjs').then(m=>console.log(m.name, Object.keys(m.cursorPlanTool)))"
```

Try the tool without running dsh:

```bash
node -e "
import('./index.mjs').then(async (m) => {
  const t = m.cursorPlanTool;
  const v = await t.execute({ action: 'list', match: 'plan', limit: 3 });
  console.log(t.output.render({ action: 'list' }, v)[0].text);
});"
```

## Scope vs. built-in dsh features

- This plugin does **not** integrate with the harness's own `plan-mode` (`exit_plan_mode` / `/plan` command) and injects no system prompt; it only adds a read-only tool for Cursor plans.
- It does not read Cursor sessions (composer / chat logs); only `*.plan.md`.
- It never writes: creating / modifying / deleting plans and writing back todo statuses are out of scope.
