// 解析层单测：迁移自 Luban 的 cursor-plan.js 自测，并补 listPlans 截断/过滤用例
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  fallbackName,
  listPlans,
  parse,
  readPlan,
  roots,
  splitFrontmatter
} from '../lib/plan-store.mjs';

function tmpBase(tag) {
  return path.join(os.tmpdir(), 'dsh-cursor-plan-' + tag + '-' + process.pid + '-' + Date.now());
}

test('splitFrontmatter: CRLF + BOM', () => {
  const r = splitFrontmatter('\ufeff---\r\nname: A\r\n---\r\n正文\r\n');
  assert.equal(r.has, true);
  assert.deepEqual(r.head, ['name: A']);
  assert.equal(r.body, '正文\n');
});

test('splitFrontmatter: missing close → whole text as body', () => {
  const r = splitFrontmatter('---\nname: A\n正文');
  assert.equal(r.has, false);
  assert.ok(r.body.includes('name: A'));
});

test('splitFrontmatter: 前导 <!-- uuid --> 注释后仍能识别 frontmatter', () => {
  const r = splitFrontmatter('<!-- 642d0fd6-822f-4b90-b644-c1646d257f84 -->\n---\ntodos:\n  - id: a\n    content: A\n---\n正文\n');
  assert.equal(r.has, true);
  assert.deepEqual(r.head, ['todos:', '  - id: a', '    content: A']);
  assert.equal(r.body, '正文\n');
});

test('splitFrontmatter: 前导空行 + 未闭合注释 → 整份当正文', () => {
  const a = splitFrontmatter('\n\n---\nname: A\n---\n正文');
  assert.equal(a.has, true);
  assert.equal(a.body, '正文');
  const b = splitFrontmatter('<!-- 没闭合\n---\nname: A\n---\n正文');
  assert.equal(b.has, false);
});

test('parse: name / overview / todos', () => {
  const txt = [
    '---',
    'name: "EOS 导入导出"',
    'overview: 用真实样例钉死格式',
    'todos:',
    '  - id: codec',
    '    content: "新增 Codec（含转义）"',
    '    status: in_progress',
    '  - id: ui',
    '    content: 前端弹窗',
    '    status: completed',
    'isProject: false',
    '---',
    '# 计划',
    '正文'
  ].join('\n');
  const got = parse(txt);
  assert.equal(got.name, 'EOS 导入导出');
  assert.equal(got.overview, '用真实样例钉死格式');
  assert.equal(got.todos.length, 2);
  assert.equal(got.todos[0].id, 'codec');
  assert.equal(got.todos[0].content, '新增 Codec（含转义）');
  assert.equal(got.todos[0].status, 'in_progress');
  assert.equal(got.todos[1].status, 'completed');
  assert.equal(got.body.trim(), '# 计划\n正文');
});

test('parse: todos [] and folded block overview', () => {
  const got = parse('---\nname: A\noverview: >\n  第一段\n  第二段\ntodos: []\n---\nbody');
  assert.equal(got.overview, '第一段 第二段');
  assert.equal(got.todos.length, 0);
});

test('parse: literal block overview keeps newlines', () => {
  const got = parse('---\noverview: |\n  第一行\n  第二行\n---\nbody');
  assert.equal(got.overview, '第一行\n第二行');
});

test('fallbackName', () => {
  assert.equal(fallbackName('eos_单据_导入导出_d5e83329.plan.md'), 'eos_单据_导入导出');
  assert.equal(fallbackName('plain.md'), 'plain');
  assert.equal(fallbackName(''), '');
});

test('roots: home + workspace + extraDirs', () => {
  const got = roots('/h', '/r', ['/x', '', '/y']);
  assert.deepEqual(got, [
    path.join('/h', '.cursor', 'plans'),
    path.join('/r', '.cursor', 'plans'),
    '/x',
    '/y'
  ]);
});

test('listPlans / readPlan on temp dirs', () => {
  const base = tmpBase('list');
  const home = path.join(base, 'home');
  const root = path.join(base, 'root');
  const hd = path.join(home, '.cursor', 'plans');
  const wd = path.join(root, '.cursor', 'plans');
  fs.mkdirSync(hd, { recursive: true });
  fs.mkdirSync(wd, { recursive: true });
  try {
    const oldFile = path.join(hd, 'old_a1b2c3d4.plan.md');
    fs.writeFileSync(oldFile, '---\nname: 旧计划\noverview: 旧\n---\n旧正文\n');
    const newer = path.join(wd, 'new_e5f6a7b8.plan.md');
    fs.writeFileSync(newer, '---\nname: 新计划\ntodos:\n  - id: t1\n    content: 做一件事\n    status: pending\n---\n新正文\n');
    const now = Date.now() / 1000;
    fs.utimesSync(oldFile, now - 3600, now - 3600);

    const list = listPlans({ home: home, root: root });
    assert.equal(list.length, 2);
    assert.equal(list[0].name, '新计划');
    assert.equal(list[0].scope, 'workspace');
    assert.equal(list[1].name, '旧计划');
    assert.equal(list[1].scope, 'home');

    const got = readPlan(newer);
    assert.equal(got.ok, true);
    assert.equal(got.body.trim(), '新正文');
    assert.equal(got.todos.length, 1);
    assert.equal(got.todos[0].content, '做一件事');

    const missing = readPlan(path.join(base, 'nope.md'));
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'read_failed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('listPlans: extraDirs 标记 scope=luban', () => {
  const base = tmpBase('extra');
  const home = path.join(base, 'home');
  const root = path.join(base, 'root');
  const hd = path.join(home, '.cursor', 'plans');
  const ed = path.join(base, 'luban-plans');
  fs.mkdirSync(hd, { recursive: true });
  fs.mkdirSync(ed, { recursive: true });
  try {
    fs.writeFileSync(path.join(hd, 'c1.plan.md'), '---\nname: Cursor 计划\n---\n正文\n');
    fs.writeFileSync(path.join(ed, '20260101-000000-我的计划.md'),
      '---\nname: "Luban 计划"\noverview: 一句话\ntodos:\n  - id: t1\n    content: 做一件事\n    status: pending\nisProject: false\n---\n正文\n');
    const list = listPlans({ home: home, root: root, extraDirs: [ed] });
    assert.equal(list.length, 2);
    const lub = list.filter(function (x) { return x.scope === 'luban'; })[0];
    assert.equal(lub && lub.name, 'Luban 计划');
    const cur = list.filter(function (x) { return x.scope === 'home'; })[0];
    assert.equal(cur && cur.name, 'Cursor 计划');
    const got = readPlan(path.join(ed, '20260101-000000-我的计划.md'));
    assert.equal(got.ok, true);
    assert.equal(got.todos.length, 1);
    assert.equal(got.todos[0].content, '做一件事');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('listPlans: 过滤非 .md、按 mtime 倒序、dirname 不存在不抛', () => {
  const base = tmpBase('filter');
  const home = path.join(base, 'home');
  const hd = path.join(home, '.cursor', 'plans');
  fs.mkdirSync(hd, { recursive: true });
  try {
    fs.writeFileSync(path.join(hd, 'a.plan.md'), '---\nname: A\n---\n');
    fs.writeFileSync(path.join(hd, 'b.plan.md'), '---\nname: B\n---\n');
    fs.writeFileSync(path.join(hd, 'notes.txt'), 'ignored');
    fs.mkdirSync(path.join(hd, 'sub.plan.md'));
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(hd, 'a.plan.md'), now - 7200, now - 7200);
    fs.utimesSync(path.join(hd, 'b.plan.md'), now - 60, now - 60);

    const list = listPlans({ home: home, root: path.join(base, 'no-such-root') });
    assert.equal(list.length, 2);
    assert.deepEqual(list.map(function (x) { return x.name; }), ['B', 'A']);
    assert.equal(list[0].scope, 'home');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('readPlan: 无 frontmatter 的文件整份当正文', () => {
  const base = tmpBase('raw');
  fs.mkdirSync(base, { recursive: true });
  try {
    const f = path.join(base, 'raw.plan.md');
    fs.writeFileSync(f, '# 只有正文\n内容');
    const got = readPlan(f);
    assert.equal(got.ok, true);
    assert.equal(got.body, '# 只有正文\n内容');
    assert.deepEqual(got.todos, []);
    assert.equal(got.name, '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
