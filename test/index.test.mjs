// index 层：workspace 根从 dsh workingDirectory 服务取（会话目录），取不到回落到 process.cwd()
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, cursorPlanTool } from '../index.mjs';

// 每个测试进程一个随机标记，避免与真实 ~/.cursor/plans 里的计划重名/命中
const TAG = 'zzq' + Math.random().toString(36).slice(2, 10);
const PLAN_BASE = TAG + '_ab12cd34.plan.md';
const PLAN_NAME = TAG + ' Demo Plan';
const PLAN_TEXT = [
  '---',
  'name: ' + PLAN_NAME,
  'overview: "' + TAG + ' demo overview"',
  'todos:',
  '  - id: a',
  '    content: first task',
  '    status: pending',
  '---',
  '',
  '# Demo',
  '',
  'body text',
  ''
].join('\n');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cursor-plan-'));
  const dir = path.join(root, '.cursor', 'plans');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PLAN_BASE), PLAN_TEXT);
  return { root, dir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// 只有一个工具的假宿主：ctx.tools.register + ctx.get('workingDirectory')
function mountTool(service) {
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return def;
      }
    },
    get(name) {
      return name === 'workingDirectory' ? service : undefined;
    }
  };
  apply(ctx);
  assert.equal(registered.length, 1);
  return registered[0];
}

function execWith(agent) {
  return agent === undefined ? { signal: new AbortController().signal } : { agent: agent, signal: new AbortController().signal };
}

const AGENT = { session: {} };

function uniqueDirs(dirs) {
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    const abs = path.resolve(d);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(abs);
  }
  return out;
}

test('apply 注册 cursor_plan，带参数与输出 schema', () => {
  const tool = mountTool(undefined);
  assert.equal(tool.name, 'cursor_plan');
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(typeof tool.execute, 'function');
});

test('list 用会话工作目录：项目内计划以 scope=workspace 出现', async () => {
  const { root, dir } = makeProject();
  try {
    const tool = mountTool({ ensure: async () => root });
    const v = await tool.execute({ action: 'list', match: TAG }, execWith(AGENT));
    assert.equal(v.action, 'list');
    assert.equal(v.error, undefined);
    assert.equal(v.count, 1);
    assert.ok(v.roots.includes(path.join(dir)));
    const hit = v.plans.find(function (p) { return p.base === PLAN_BASE; });
    assert.ok(hit, 'workspace plan missing from list');
    assert.equal(hit.scope, 'workspace');
    assert.equal(hit.name, PLAN_NAME);
    assert.equal(hit.overview, TAG + ' demo overview');
  } finally {
    cleanup(root);
  }
});

test('read 能按 basename 读到会话工作目录内的计划', async () => {
  const { root } = makeProject();
  try {
    const tool = mountTool({ ensure: async () => root });
    const v = await tool.execute({ action: 'read', basename: PLAN_BASE }, execWith(AGENT));
    assert.equal(v.error, undefined);
    assert.equal(v.name, PLAN_NAME);
    assert.equal(v.todos.length, 1);
    assert.equal(v.todos[0].content, 'first task');
    assert.match(v.body, /# Demo/);
  } finally {
    cleanup(root);
  }
});

test('read 拒绝来源目录之外的绝对路径', async () => {
  const { root } = makeProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cursor-plan-outside-'));
  const file = path.join(outside, 'secret.plan.md');
  fs.writeFileSync(file, PLAN_TEXT);
  try {
    const tool = mountTool({ ensure: async () => root });
    const v = await tool.execute({ action: 'read', file: file }, execWith(AGENT));
    assert.equal(v.error, 'path-not-allowed');
    assert.equal(v.action, 'read');
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('workingDirectory 服务未挂载时回落到 process.cwd()', async () => {
  const tool = mountTool(undefined);
  const v = await tool.execute({ action: 'list', match: 'no-such-plan-zzz' }, execWith(AGENT));
  const expected = uniqueDirs([path.join(os.homedir(), '.cursor', 'plans'), path.join(process.cwd(), '.cursor', 'plans')]);
  assert.deepEqual(v.roots.map(function (r) { return path.resolve(r); }), expected);
});

test('ensure 抛错时回落到 process.cwd()，不中止工具', async () => {
  const tool = mountTool({
    ensure: async function () { throw new Error('project disappeared'); }
  });
  const v = await tool.execute({ action: 'list', match: 'no-such-plan-zzz' }, execWith(AGENT));
  const expected = uniqueDirs([path.join(os.homedir(), '.cursor', 'plans'), path.join(process.cwd(), '.cursor', 'plans')]);
  assert.deepEqual(v.roots.map(function (r) { return path.resolve(r); }), expected);
});

test('exec.agent 缺失时不调用 workingDirectory.ensure', async () => {
  let calls = 0;
  const tool = mountTool({
    ensure: async function () { calls++; return os.homedir(); }
  });
  const v = await tool.execute({ action: 'list', match: 'no-such-plan-zzz' }, execWith());
  assert.equal(calls, 0);
  const expected = uniqueDirs([path.join(os.homedir(), '.cursor', 'plans'), path.join(process.cwd(), '.cursor', 'plans')]);
  assert.deepEqual(v.roots.map(function (r) { return path.resolve(r); }), expected);
});

test('会话目录与 home 相同时 roots 去重，只剩一份', async () => {
  const tool = mountTool({ ensure: async () => os.homedir() });
  const v = await tool.execute({ action: 'list', match: 'no-such-plan-zzz' }, execWith(AGENT));
  assert.deepEqual(v.roots.map(function (r) { return path.resolve(r); }), [path.resolve(path.join(os.homedir(), '.cursor', 'plans'))]);
});

test('未知 action 返回 bad-action', async () => {
  const tool = mountTool(undefined);
  const v = await tool.execute({ action: 'nope' }, execWith(AGENT));
  assert.equal(v.error, 'bad-action');
});

test('直接 import 的 cursorPlanTool 也能跑（无宿主 ctx）', async () => {
  const v = await cursorPlanTool.execute({ action: 'list', match: 'no-such-plan-zzz' });
  assert.equal(v.action, 'list');
  assert.ok(Array.isArray(v.roots));
});
