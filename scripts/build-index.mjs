#!/usr/bin/env node
// 生成 DSH 插件市场索引（format 1）：market/index.json
//
// 规则来自官方文档 docs/user/guide/plugin-market.md：
//   - 顶层 format 必须严格等于 1，title 必填且是 LocalizedText（对象形式必须含 en）
//   - 每个 plugin 的 versions 非空；version 是精确 SemVer；publishTimestamp 是整数秒
//   - source 只有两种：{ type: "npm" } 或 { type: "git", url, commit(40 位小写 hex), path? }
//   - metadata.category / metadata.labels 里的 id 必须先在顶层 metadata 里声明
//
// 版本列表的口径照官方参考生成器：tag 上的 vX.Y.Z / X.Y.Z，加上默认分支上的 package.json 版本。
//
// 用法：node scripts/build-index.mjs [--out market/index.json]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function git(...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

// 注：v0.1.0 是 annotated tag，`git show -s --format=%ct <tag>` 会连 tag 对象一起输出
// （多行，Number() 得 NaN），所以一律先 ^{commit} 剥到 commit 再取时间。
function commitOf(ref) {
  return git('rev-list', '-n', '1', `${ref}^{commit}`);
}

function commitTime(ref) {
  const seconds = Number(git('show', '-s', '--format=%ct', `${ref}^{commit}`));
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`cannot read commit time of ${ref} (got ${JSON.stringify(seconds)})`);
  }
  return seconds;
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const TAG_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

// https://github.com/eppen/dsh-plugin-cursor-plan.git
const gitUrl = pkg.repository.url.replace(/^git\+/, '');
const webUrl = gitUrl.replace(/\.git$/, '');

// ---- 版本：tag 优先，默认分支的 package.json 版本兜底 ----
/** @type {Map<string, {version: string, publishTimestamp: number, commit: string}>} */
const versions = new Map();

for (const tag of git('tag', '-l').split('\n').filter(Boolean)) {
  const m = tag.match(TAG_RE);
  if (!m) continue;
  const version = m[1];
  if (versions.has(version)) continue;
  versions.set(version, {
    version,
    publishTimestamp: commitTime(tag),
    commit: commitOf(tag),
  });
}

if (!versions.has(pkg.version)) {
  versions.set(pkg.version, {
    version: pkg.version,
    publishTimestamp: commitTime('HEAD'),
    commit: commitOf('HEAD'),
  });
}

const semverKey = (v) => {
  const [main, pre] = v.split('+')[0].split('-');
  return { main: main.split('.').map(Number), pre: pre ?? null };
};

const sorted = [...versions.values()].sort((a, b) => {
  const ka = semverKey(a.version);
  const kb = semverKey(b.version);
  for (let i = 0; i < 3; i += 1) {
    if (ka.main[i] !== kb.main[i]) return kb.main[i] - ka.main[i];
  }
  if (ka.pre === kb.pre) return 0;
  if (ka.pre === null) return -1;
  if (kb.pre === null) return 1;
  return kb.pre.localeCompare(ka.pre);
});

// ---- 图标：内联 data: URL（≤32 KiB），免掉相对路径解析 ----
let icon;
const iconPath = path.join(root, 'market', 'icons', 'cursor-plan.svg');
if (fs.existsSync(iconPath)) {
  const svg = fs.readFileSync(iconPath);
  if (svg.length > 24 * 1024) throw new Error(`icon too large: ${svg.length} bytes`);
  icon = `data:image/svg+xml;base64,${svg.toString('base64')}`;
}

const index = {
  format: 1,
  title: { en: 'eppen · DSH plugins', zh: 'eppen · DSH 插件' },
  description: {
    en: 'Plugins for DeepSeek Harness by eppen.',
    zh: 'eppen 维护的 DeepSeek Harness 插件。',
  },
  metadata: {
    categories: {
      tools: { title: { en: 'Tools', zh: '工具' } },
    },
    labels: {
      plan: { title: { en: 'Plan', zh: '计划' } },
      cursor: { title: { en: 'Cursor', zh: 'Cursor' } },
      'read-only': { title: { en: 'Read-only', zh: '只读' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Cursor Plan', zh: 'Cursor 计划' },
      description: {
        en: pkg.description,
        zh: '以只读的 cursor_plan 工具读取 Cursor Plan 模式产出的 *.plan.md 计划文件。',
      },
      ...(icon ? { icon } : {}),
      author: pkg.author,
      homepage: pkg.homepage,
      repository: { url: webUrl },
      metadata: {
        category: 'tools',
        labels: ['plan', 'cursor', 'read-only'],
      },
      versions: sorted.map((v) => ({
        version: v.version,
        publishTimestamp: v.publishTimestamp,
        source: { type: 'git', url: gitUrl, commit: v.commit },
        ...(pkg.engines?.dsh ? { engines: { dsh: pkg.engines.dsh } } : {}),
      })),
    },
  ],
};

const out = path.resolve(root, arg('--out', 'market/index.json'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);

console.log(`wrote ${path.relative(root, out)}`);
for (const v of sorted) {
  console.log(`  ${v.version}  ${v.commit.slice(0, 8)}  ${new Date(v.publishTimestamp * 1000).toISOString()}`);
}
