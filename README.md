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

dsh's plugin market (the Web UI **Discover** tab) is a **plugin index**: a UTF-8 JSON file listing installable bundles with title, icon, author and version, hosted on any static site. There is no single official market; indexes are published by communities and teams.

This package is already set up for it:

- `package.json` declares `dsh.bundle.patch` (the market generator only indexes bundle packages)
- no `"private": true` (the generator skips git-source packages that set it)
- `engines.dsh` declares the compatible range
- `locale/en.json` / `locale/zh.json` provide the market card title and description
- `keywords` feed Discover search
- `README.md` (English) / `README.zh.md` (Chinese) bilingual docs

Publishing steps:

1. **Push to GitHub** (public repo): `git init` → `git remote add origin https://github.com/eppen/dsh-plugin-cursor-plan.git` → push
2. **Add the `dsh-plugin` topic** to the repo (the official README's discoverability mechanism)
3. **Tag a version**: git-source versions come from `vX.Y.Z` / `X.Y.Z` / `@X.Y.Z` tags and the default branch
4. **Generate the index** with the official reference generator (inside the deepseek-harness repo, `apps/plugin-market-generator`):

   ```sh
   # one source per line
   echo "https://github.com/eppen/dsh-plugin-cursor-plan" > plugins.txt
   pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
     --input plugins.txt --output site/index.json --title "My DSH plugins"
   ```

   or hand-write `index.json` (`format: 1`, `source.type: "git"`, `commit` = 40-char sha) and host it over https (GitHub Pages / object storage / etc.)
5. **User side**: Web UI → Plugins → enable the experimental **Custom plugin indexes** → Discover → Add index source with the index URL; browse, confirm, install.

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
