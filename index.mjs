// dsh-plugin-cursor-plan — DeepSeek Harness（cordis）插件
//
// 注册一个只读工具 `cursor_plan`，用来列出 / 读取 Cursor Plan 模式产出的 *.plan.md：
//   - 来源只有两个目录：~/.cursor/plans 与 <cwd>/.cursor/plans
//   - 只读：不写、不改、不删任何文件
//   - 工具契约来自 @deepseek-ai/dsh-tools（不 import，只按契约实现）
import os from 'node:os';
import path from 'node:path';

import { fallbackName, listPlans, readPlan, roots as planRoots } from './lib/plan-store.mjs';

export const name = 'cursor-plan';
export const inject = ['tools'];

const TOOL_NAME = 'cursor_plan';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_BODY_CHARS = 20000;   // 渲染时截断，避免超长计划把上下文塞满

const DESCRIPTION = [
  'Read Cursor Plan-mode plans stored as *.plan.md files (read-only; never writes).',
  'Sources: "~/.cursor/plans" (scope=home) and "<session-cwd>/.cursor/plans" (scope=workspace);',
  'when the Session working directory is unavailable, the dsh launch directory is used.',
  'Each plan is Markdown with an optional YAML frontmatter carrying name, overview and',
  'todos[{id, content, status}] (status: pending | in_progress | completed | cancelled).',
  'The frontmatter todos are the authoritative checklist; the body is the full plan.',
  '',
  'action="list" enumerates plans newest-first; optional "match" filters name/overview/filename',
  'case-insensitively, optional "limit" caps the number returned (default 20, max 100).',
  'action="read" returns one plan; pass either "file" (absolute path inside a source dir) or',
  '"basename" (the plan file name, e.g. "Plan-642d0fd6.plan.md").'
].join('\n');

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'read'],
      description: 'list = enumerate plans, read = read one plan by file or basename'
    },
    file: {
      type: 'string',
      description: 'read 时可用：计划的绝对路径，必须位于 ~/.cursor/plans 或当前会话工作目录的 .cursor/plans 之内'
    },
    basename: {
      type: 'string',
      description: 'read 时可用：计划文件名（或用 list 返回的 name），在两个来源目录内唯一匹配'
    },
    match: {
      type: 'string',
      description: 'list 时可用：按 name / overview / 文件名做不区分大小写的子串过滤'
    },
    limit: {
      type: 'integer',
      description: 'list 时可用：最多返回多少条（默认 20，上限 100）'
    }
  },
  required: ['action'],
  additionalProperties: false
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    error: {
      type: 'string',
      description: '领域错误码：bad-action / path-not-allowed / not-found / ambiguous / not-file / too-big / read-failed'
    },
    message: { type: 'string' },
    count: { type: 'integer', description: '匹配到的总数（截断前）' },
    shown: { type: 'integer', description: '实际返回的条数' },
    limit: { type: 'integer' },
    roots: { type: 'array', items: { type: 'string' } },
    plans: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          base: { type: 'string' },
          name: { type: 'string' },
          overview: { type: 'string' },
          size: { type: 'integer' },
          mtimeMs: { type: 'number' },
          scope: { type: 'string' }
        },
        additionalProperties: true
      }
    },
    file: { type: 'string' },
    name: { type: 'string' },
    overview: { type: 'string' },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          content: { type: 'string' },
          status: { type: 'string' }
        },
        additionalProperties: true
      }
    },
    body: { type: 'string' },
    size: { type: 'integer' },
    mtimeMs: { type: 'number' },
    truncated: { type: 'boolean' }
  },
  additionalProperties: true
};

// ── 路径与参数 ───────────────────────────────────────────────────────────────

// 计划来源根目录：~/.cursor/plans + 当前会话工作目录下的 .cursor/plans。
// 会话目录来自 dsh 的 workingDirectory 服务；取不到时（程序化直接调用、服务未挂载、
// 目录不可用）回落到 dsh 进程启动目录 process.cwd()。
function getService(ctx, serviceName) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined;
  } catch (e) {
    return undefined;
  }
}

async function workspaceRootOf(ctx, exec) {
  const service = getService(ctx, 'workingDirectory');
  const agent = exec && exec.agent;
  if (service && typeof service.ensure === 'function' && agent) {
    try {
      const dir = await service.ensure(agent, exec.signal);
      if (typeof dir === 'string' && dir.trim()) { return dir; }
    } catch (e) { /* 会话目录不可用：回落 */ }
  }
  return process.cwd();
}

// 去重后的来源目录：home 与 workspace 指向同一目录时只留一份（Linux 大小写敏感，不合并）
function planDirs(workspaceRoot) {
  const seen = new Set();
  const out = [];
  const dirs = planRoots(os.homedir(), workspaceRoot).filter(function (d) { return !!d; });
  for (let i = 0; i < dirs.length; i++) {
    const abs = path.resolve(dirs[i]);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function isInside(file, dirs) {
  const target = path.resolve(file);
  for (let i = 0; i < dirs.length; i++) {
    const rel = path.relative(dirs[i], target);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { return true; }
  }
  return false;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function asLimit(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) { return DEFAULT_LIMIT; }
  const n = Math.floor(v);
  if (n <= 0) { return DEFAULT_LIMIT; }
  return Math.min(n, MAX_LIMIT);
}

function fmtTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) { return '?'; }
  const d = new Date(ms);
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── list ─────────────────────────────────────────────────────────────────────

function doList(args, workspaceRoot) {
  const limit = asLimit(args.limit);
  const match = str(args.match).trim().toLowerCase();
  const dirs = planDirs(workspaceRoot);
  const all = listPlans({ home: os.homedir(), root: workspaceRoot });
  const hit = match
    ? all.filter(function (p) {
      return (p.name + '\n' + p.overview + '\n' + p.base).toLowerCase().includes(match);
    })
    : all;
  return {
    action: 'list',
    count: hit.length,
    shown: Math.min(hit.length, limit),
    limit: limit,
    roots: dirs,
    plans: hit.slice(0, limit).map(function (p) {
      return {
        file: p.file,
        base: p.base,
        name: p.name,
        overview: p.overview,
        size: p.size,
        mtimeMs: p.mtimeMs,
        scope: p.scope
      };
    })
  };
}

// ── read ─────────────────────────────────────────────────────────────────────

function pickByBasename(basename, all) {
  const want = basename.trim().toLowerCase();
  const exact = all.filter(function (p) { return p.base.toLowerCase() === want; });
  if (exact.length) { return exact; }
  return all.filter(function (p) {
    return fallbackName(p.base).toLowerCase() === want || p.name.toLowerCase() === want;
  });
}

function doRead(args, workspaceRoot) {
  const dirs = planDirs(workspaceRoot);
  const file = str(args.file).trim();
  const basename = str(args.basename).trim();
  if (!file && !basename) {
    return { action: 'read', error: 'bad-action', message: 'read 需要 file 或 basename 之一' };
  }

  let target = '';
  if (file) {
    if (!isInside(file, dirs)) {
      return {
        action: 'read', error: 'path-not-allowed', file: file,
        message: '只允许读取以下目录内的计划：' + dirs.join(' | ')
      };
    }
    target = path.resolve(file);
  } else {
    const hits = pickByBasename(basename, listPlans({ home: os.homedir(), root: workspaceRoot }));
    if (!hits.length) {
      return { action: 'read', error: 'not-found', message: '找不到计划：' + basename };
    }
    if (hits.length > 1 && hits[0].base.toLowerCase() !== basename.trim().toLowerCase()) {
      return {
        action: 'read', error: 'ambiguous',
        message: '有多个计划匹配 "' + basename + '"，请改用 file: ' + hits.map(function (p) { return p.file; }).join(' , ')
      };
    }
    target = hits[0].file;
  }

  const got = readPlan(target);
  if (!got.ok) {
    const code = got.code === 'not_file' ? 'not-file' : got.code === 'too_big' ? 'too-big' : 'read-failed';
    return { action: 'read', error: code, file: target, message: got.error };
  }
  const todos = (got.todos || []).map(function (t) {
    return { id: t.id, content: t.content, status: t.status };
  });
  const body = got.body || '';
  const truncated = body.length > MAX_BODY_CHARS;
  return {
    action: 'read',
    file: target,
    name: got.name || fallbackName(path.basename(target)),
    overview: got.overview || '',
    todos: todos,
    body: truncated ? body.slice(0, MAX_BODY_CHARS) : body,
    truncated: truncated,
    size: got.size,
    mtimeMs: got.mtimeMs
  };
}

// ── render（模型可见内容，纯函数，不许抛） ───────────────────────────────────

const ERROR_TEXT = {
  'bad-action': '参数不合法',
  'path-not-allowed': '路径不在允许读取的计划目录内',
  'not-found': '没有找到匹配的计划',
  ambiguous: '匹配到多个计划，请用 file 指定',
  'not-file': '目标不是文件',
  'too-big': '文件超过大小上限',
  'read-failed': '读取失败'
};

function renderList(value) {
  const lines = [];
  lines.push('Cursor plans: ' + value.shown + '/' + value.count + ' (limit ' + value.limit + ')');
  lines.push('roots: ' + (value.roots || []).join(' | '));
  const plans = Array.isArray(value.plans) ? value.plans : [];
  if (!plans.length) { lines.push('(no plan matched)'); }
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    const ov = p.overview ? ' — ' + p.overview : '';
    lines.push((i + 1) + '. [' + p.scope + '] ' + p.name + ov + ' (' + p.base + ', ' + fmtTime(p.mtimeMs) + ')');
    lines.push('   file: ' + p.file);
  }
  if (value.count > value.shown) {
    lines.push('… ' + (value.count - value.shown) + ' more not shown; narrow with match or raise limit (max ' + MAX_LIMIT + ')');
  }
  return lines.join('\n');
}

function renderRead(value) {
  if (value.error) {
    const head = 'cursor_plan error: ' + value.error + ' — ' + (ERROR_TEXT[value.error] || value.error);
    const where = value.file ? '\nfile: ' + value.file : '';
    const tail = value.message ? '\n' + value.message : '';
    return head + where + tail;
  }
  const lines = [];
  lines.push('name: ' + (value.name || '(unnamed)'));
  if (value.overview) { lines.push('overview: ' + value.overview); }
  lines.push('file: ' + value.file);
  const todos = Array.isArray(value.todos) ? value.todos : [];
  lines.push('');
  lines.push('todos (' + todos.length + '):');
  if (!todos.length) { lines.push('(none)'); }
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i];
    lines.push('  - [' + (t.status || 'pending') + '] ' + (t.id ? t.id + ': ' : '') + t.content);
  }
  lines.push('');
  lines.push('body:');
  lines.push(value.body || '(empty)');
  if (value.truncated) {
    lines.push('');
    lines.push('… body truncated at ' + MAX_BODY_CHARS + ' chars (file size ' + value.size + ' bytes)');
  }
  return lines.join('\n');
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return '"[unserializable]"'; }
}

function render(args, value) {
  const v = value && typeof value === 'object' ? value : {};
  let text = '';
  try {
    if (v.action === 'read' || v.error) { text = renderRead(v); }
    else { text = renderList(v); }
  } catch (e) {
    text = 'cursor_plan: 渲染失败（' + String((e && e.message) || e) + '），规范值：' + safeJson(v);
  }
  return [{ type: 'text', text: text }];
}

// ── 工具定义 ─────────────────────────────────────────────────────────────────

async function executeTool(args, exec, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  const action = str(a.action).trim();
  if (action === 'list') { return doList(a, await workspaceRootOf(ctx, exec)); }
  if (action === 'read') { return doRead(a, await workspaceRootOf(ctx, exec)); }
  return {
    action: action || '(missing)',
    error: 'bad-action',
    message: 'action 必须是 "list" 或 "read"'
  };
}

function defineTool(ctx) {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: render },
    execute(args, exec) {
      return executeTool(args, exec, ctx);
    }
  };
}

// 供直接 import 使用（README 里的自测片段）；没有宿主 ctx 时按 process.cwd() 找 workspace
export const cursorPlanTool = defineTool(undefined);

export function apply(ctx) {
  return ctx.tools.register(defineTool(ctx));
}
