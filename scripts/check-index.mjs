#!/usr/bin/env node
// 按官方 docs/user/guide/plugin-market.md 的规则校验 market/index.json（format 1）。
//
// 真正的判定权在 DSH 自己的 @deepseek-ai/dsh-plugin-market-index（跑在 app.asar 里，
// Node 不能直接 import）；这里逐条实现同一套规则，方便在提交前离线自查。
// 端到端验证只有一条：在 Discover 里加索引 URL，看能不能列出来。
//
// 用法：node scripts/check-index.mjs [market/index.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? 'market/index.json';

const errors = [];
const fail = (at, msg) => errors.push(`${at}: ${msg}`);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string' && v.length > 0;

// LocalizedText：字符串，或以小写语言 id 为键的对象，且对象必须含 en
function checkLocalized(value, at) {
  if (typeof value === 'string') return isString(value) || fail(at, 'empty string');
  if (!isObject(value)) return fail(at, 'must be a string or an object keyed by language id');
  if (!isString(value.en)) fail(`${at}.en`, 'required');
  for (const [lang, text] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(lang)) fail(`${at}.${lang}`, 'language id must be lowercase');
    if (!isString(text)) fail(`${at}.${lang}`, 'must be a non-empty string');
  }
  return true;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const HTTPS = /^https:\/\/[^\s]+$/;
const HTTP = /^https?:\/\/[^\s]+$/;
const MAX_ICON = 32 * 1024;

let raw;
try {
  raw = fs.readFileSync(path.resolve(root, file), 'utf8');
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  process.exit(1);
}

let index;
try {
  index = JSON.parse(raw);
} catch (e) {
  console.error(`${file} is not valid JSON: ${e.message}`);
  process.exit(1);
}

if (!isObject(index)) {
  console.error('index must be a JSON object');
  process.exit(1);
}

if (index.format !== 1) fail('$.format', `must be exactly 1, got ${JSON.stringify(index.format)}`);
if (index.title === undefined) fail('$.title', 'required');
else checkLocalized(index.title, '$.title');
if (index.description !== undefined) checkLocalized(index.description, '$.description');

// ---- 顶层声明表 ----
const declared = { categories: new Set(), labels: new Set(), sortKeys: new Set() };
for (const key of ['categories', 'labels', 'sortKeys']) {
  const table = index.metadata?.[key];
  if (table === undefined) continue;
  if (!isObject(table)) {
    fail(`$.metadata.${key}`, 'must be an object mapping id to a declaration');
    continue;
  }
  for (const [id, decl] of Object.entries(table)) {
    declared[key].add(id);
    const at = `$.metadata.${key}.${id}`;
    if (!isObject(decl)) {
      fail(at, 'declaration must be an object');
      continue;
    }
    if (decl.title === undefined) fail(`${at}.title`, 'required');
    else checkLocalized(decl.title, `${at}.title`);
    if (key === 'sortKeys' && decl.order !== undefined && !['asc', 'desc'].includes(decl.order)) {
      fail(`${at}.order`, 'must be "asc" or "desc"');
    }
  }
}

// ---- plugins ----
if (!Array.isArray(index.plugins)) {
  fail('$.plugins', 'required array');
} else {
  const names = new Set();
  index.plugins.forEach((plugin, i) => {
    const at = `$.plugins[${i}]`;
    if (!isObject(plugin)) return fail(at, 'must be an object');

    if (!isString(plugin.name)) fail(`${at}.name`, 'required');
    else if (!NPM_NAME.test(plugin.name)) fail(`${at}.name`, `not a valid npm package name: ${plugin.name}`);
    else if (names.has(plugin.name)) fail(`${at}.name`, `duplicate plugin name: ${plugin.name}`);
    else names.add(plugin.name);

    if (plugin.title !== undefined) checkLocalized(plugin.title, `${at}.title`);
    if (plugin.description !== undefined) checkLocalized(plugin.description, `${at}.description`);

    if (plugin.icon !== undefined) {
      const icon = plugin.icon;
      if (typeof icon !== 'string' || icon === '') fail(`${at}.icon`, 'must be a URL string');
      else if (icon.startsWith('data:')) {
        const m = icon.match(/^data:image\/(svg\+xml|png|jpeg|webp);base64,/);
        if (!m) fail(`${at}.icon`, 'inline icon must be a base64 data: URL of type svg+xml, png, jpeg or webp');
        const bytes = Buffer.from(icon.slice(icon.indexOf(',') + 1), 'base64').length;
        if (bytes > MAX_ICON) fail(`${at}.icon`, `inline icon is ${bytes} bytes, limit is 32 KiB`);
      } else if (/^https:\/\//.test(icon) || /^http:\/\//.test(icon)) {
        // 跨源绝对图标必须 https:；同源 http 由索引 URL 决定，这里只认 https
        if (!HTTPS.test(icon)) fail(`${at}.icon`, 'absolute icon URL must use https:');
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(icon)) {
        fail(`${at}.icon`, 'unsupported URL scheme');
      }
      // 相对路径按索引 URL 解析，这里不做网络校验
    }

    if (plugin.homepage !== undefined && !HTTP.test(plugin.homepage ?? '')) {
      fail(`${at}.homepage`, 'must be an absolute http(s) URL');
    }

    if (plugin.repository !== undefined) {
      if (!isObject(plugin.repository)) fail(`${at}.repository`, 'must be an object');
      else {
        if (!HTTP.test(plugin.repository.url ?? '')) fail(`${at}.repository.url`, 'must be an absolute http(s) URL');
        if (plugin.repository.directory !== undefined && !isString(plugin.repository.directory)) {
          fail(`${at}.repository.directory`, 'must be a non-empty string');
        }
      }
    }

    if (plugin.metadata !== undefined) {
      if (!isObject(plugin.metadata)) fail(`${at}.metadata`, 'must be an object');
      else {
        const { category, labels, sortKeys } = plugin.metadata;
        if (category !== undefined && category !== null && !declared.categories.has(category)) {
          fail(`${at}.metadata.category`, `undeclared category id: ${category}`);
        }
        if (labels !== undefined) {
          if (!Array.isArray(labels)) fail(`${at}.metadata.labels`, 'must be an array');
          else {
            for (const label of labels) {
              if (!declared.labels.has(label)) fail(`${at}.metadata.labels`, `undeclared label id: ${label}`);
            }
          }
        }
        if (sortKeys !== undefined) {
          if (!isObject(sortKeys)) fail(`${at}.metadata.sortKeys`, 'must be an object');
          else {
            for (const [id, value] of Object.entries(sortKeys)) {
              if (!declared.sortKeys.has(id)) fail(`${at}.metadata.sortKeys`, `undeclared sort key id: ${id}`);
              if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
                fail(`${at}.metadata.sortKeys.${id}`, 'must be a finite number or null');
              }
            }
          }
        }
      }
    }

    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
      fail(`${at}.versions`, 'required, at least one version');
      return;
    }

    const seen = new Set();
    plugin.versions.forEach((entry, j) => {
      const vAt = `${at}.versions[${j}]`;
      if (!isObject(entry)) return fail(vAt, 'must be an object');

      if (!isString(entry.version) || !SEMVER.test(entry.version)) {
        fail(`${vAt}.version`, `must be an exact SemVer version, got ${JSON.stringify(entry.version)}`);
      } else if (seen.has(entry.version)) {
        fail(`${vAt}.version`, `duplicate version: ${entry.version}`);
      } else {
        seen.add(entry.version);
      }

      const ts = entry.publishTimestamp;
      if (!Number.isInteger(ts) || ts < 0 || ts >= 1e11) {
        fail(`${vAt}.publishTimestamp`, 'must be an integer number of Unix seconds');
      }

      const source = entry.source;
      if (!isObject(source)) fail(`${vAt}.source`, 'required object');
      else if (source.type === 'npm') {
        if (source.registry !== undefined && !HTTP.test(source.registry ?? '')) {
          fail(`${vAt}.source.registry`, 'must be an absolute http(s) URL');
        }
      } else if (source.type === 'git') {
        if (!HTTPS.test(source.url ?? '')) fail(`${vAt}.source.url`, 'git source url must be https');
        if (!/^[0-9a-f]{40}$/.test(source.commit ?? '')) {
          fail(`${vAt}.source.commit`, 'must be a 40-character lowercase hex commit id');
        }
        if (source.path !== undefined && !isString(source.path)) {
          fail(`${vAt}.source.path`, 'must be a non-empty string');
        }
      } else {
        fail(`${vAt}.source.type`, 'must be "npm" or "git"');
      }

      if (entry.engines?.dsh !== undefined && !isString(entry.engines.dsh)) {
        fail(`${vAt}.engines.dsh`, 'must be a non-empty SemVer range string');
      }
    });
  });
}

if (errors.length) {
  console.error(`✗ ${file}: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const plugins = index.plugins ?? [];
const count = plugins.reduce((n, p) => n + (p.versions?.length ?? 0), 0);
console.log(`✓ ${file}: format 1, ${plugins.length} plugin(s), ${count} version(s)`);
for (const plugin of plugins) {
  console.log(`  ${plugin.name}: ${plugin.versions.map((v) => v.version).join(', ')}`);
}
