// dsh-plugin-cursor-plan — Cursor 计划文件读取（纯 Node，无任何宿主依赖）
//
// Cursor 的 Plan 模式把计划存成 ~/.cursor/plans/*.plan.md（新版也可能放项目内 .cursor/plans）：
//   frontmatter 里有 name / overview / todos[{id,content,status}]，正文是完整 Markdown 计划。
// 这里只做「读出来」：解析 + 目录枚举，不写任何文件，不引入 @deepseek-ai/* 依赖
// （插件通过 file:/// URL 直接加载，因此不能依赖 profile 里的 node_modules 解析）。
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BYTES = 200 * 1024;   // 读回执行的上限（与 Luban 侧一致的保守值）
export const HEAD_BYTES = 32 * 1024;   // 列表只读文件头：name / overview / todos 都在正文之前

export function homePlanDir(home) {
  return path.join(String(home == null ? '' : home), '.cursor', 'plans');
}

export function workspacePlanDir(root) {
  const r = String(root == null ? '' : root);
  return r ? path.join(r, '.cursor', 'plans') : '';
}

// Cursor 计划的两处来源：用户全局目录 + 当前项目内的 .cursor/plans
// extraDirs：额外扫描目录，只影响列表（scope 标成 'luban'），不影响 readPlan
export function roots(home, root, extraDirs) {
  const out = [homePlanDir(home)];
  const ws = workspacePlanDir(root);
  if (ws) { out.push(ws); }
  const extra = Array.isArray(extraDirs) ? extraDirs : [];
  for (let i = 0; i < extra.length; i++) {
    const d = String(extra[i] || '');
    if (d) { out.push(d); }
  }
  return out;
}

// Cursor 有时在 frontmatter 之前写一行 <!-- uuid --> 注释（真实样本 Plan-642d0fd6.plan.md
// 就是这种形态）。跳过「前导空行 + 一个 HTML 注释块」再判定 frontmatter，否则整份计划
// 会被当成正文、todos 全丢。返回 frontmatter 起始行号，没有则 -1。
function frontmatterStart(lines) {
  let i = 0;
  while (i < lines.length && !String(lines[i]).trim()) { i++; }
  if (i < lines.length && String(lines[i]).trim().indexOf('<!--') === 0) {
    while (i < lines.length && String(lines[i]).indexOf('-->') < 0) { i++; }
    if (i >= lines.length) { return -1; }   // 注释没闭合：不当有 frontmatter
    i++;
    while (i < lines.length && !String(lines[i]).trim()) { i++; }
  }
  if (i >= lines.length || String(lines[i]).trim() !== '---') { return -1; }
  return i;
}

// frontmatter 只在文件最开头：没有收尾 --- 就当没有 frontmatter（宁可整份当正文，也不吞内容）
export function splitFrontmatter(text) {
  let txt = String(text == null ? '' : text);
  if (txt.charCodeAt(0) === 0xfeff) { txt = txt.slice(1); }
  const lines = txt.split(/\r?\n/);
  const start = frontmatterStart(lines);
  if (start < 0) {
    return { head: [], body: txt, has: false };
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (String(lines[i]).trim() === '---') {
      return { head: lines.slice(start + 1, i), body: lines.slice(i + 1).join('\n'), has: true };
    }
  }
  return { head: [], body: txt, has: false };
}

// YAML 标量只处理会遇到的形态：双引号（JSON 转义）/ 单引号 / 裸值
export function unquote(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
    try { return JSON.parse(s); } catch (e) { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s.charAt(0) === "'" && s.charAt(s.length - 1) === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

// 顶层字段：支持普通标量与 | / > 块标量（overview 偶尔会折行）
export function fieldOf(head, key) {
  const re = new RegExp('^' + key + '\s*:\s*(.*)$');
  for (let i = 0; i < head.length; i++) {
    const m = re.exec(head[i]);
    if (!m) { continue; }
    const v = m[1].trim();
    if (!/^[|>][+-]?\s*$/.test(v)) { return unquote(v); }
    const buf = [];
    for (let j = i + 1; j < head.length; j++) {
      const line = head[j];
      if (!String(line).trim()) { buf.push(''); continue; }
      if (!/^\s/.test(line)) { break; }
      buf.push(line.replace(/^\s+/, ''));
    }
    while (buf.length && !buf[buf.length - 1]) { buf.pop(); }
    // > 折叠成一行；| 保留换行
    return v.charAt(0) === '>' ? buf.filter(function (x) { return !!x; }).join(' ') : buf.join('\n');
  }
  return '';
}

// todos 是「顶层 key + 缩进列表」：每项 - id / content / status，未知字段忽略
export function todosOf(head) {
  const out = [];
  let inTodos = false;
  let cur = null;
  for (let i = 0; i < head.length; i++) {
    const line = String(head[i]);
    if (!inTodos) {
      const m = /^todos\s*:\s*(.*)$/.exec(line);
      if (!m) { continue; }
      if (m[1].trim() === '[]') { return []; }
      inTodos = !m[1].trim();
      continue;
    }
    if (!line.trim()) { continue; }
    if (!/^\s/.test(line)) { break; }   // 下一个顶层字段：todos 块结束
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      if (cur) { out.push(cur); }
      cur = { id: '', content: '', status: 'pending' };
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(item[1]);
      if (kv) { setTodoField(cur, kv[1], kv[2]); }
      continue;
    }
    if (!cur) { continue; }
    const kv = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) { setTodoField(cur, kv[1], kv[2]); }
  }
  if (cur) { out.push(cur); }
  return out.filter(function (x) { return !!(x.id || x.content); });
}

function setTodoField(todo, key, val) {
  if (key !== 'id' && key !== 'content' && key !== 'status') { return; }
  todo[key] = unquote(val);
}

export function parse(text) {
  const fm = splitFrontmatter(text);
  return {
    hasFrontmatter: fm.has,
    body: fm.body,
    name: fieldOf(fm.head, 'name'),
    overview: fieldOf(fm.head, 'overview'),
    todos: todosOf(fm.head)
  };
}

// 文件名兜底：去掉 .plan.md / .md 与 Cursor 追加的 8 位 hash
export function fallbackName(base) {
  return String(base == null ? '' : base)
    .replace(/\.plan\.md$/i, '')
    .replace(/\.md$/i, '')
    .replace(/_[0-9a-f]{8}$/i, '');
}

export function readHead(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.slice(0, n).toString('utf8');
  } catch (e) {
    return '';
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
}

// 读一份计划：正文去 frontmatter，todos / name / overview 单独给
// code 供调用端映射文案：not_file / too_big / read_failed
export function readPlan(file) {
  const p = String(file == null ? '' : file);
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) { return { ok: false, code: 'not_file', error: '不是文件' }; }
    if (st.size > MAX_BYTES) {
      return { ok: false, code: 'too_big', error: '超过 ' + Math.round(MAX_BYTES / 1024) + 'KB' };
    }
    const got = parse(fs.readFileSync(p, 'utf8'));
    return {
      ok: true, body: got.body, name: got.name, overview: got.overview,
      todos: got.todos, size: st.size, mtimeMs: st.mtimeMs
    };
  } catch (e) {
    return { ok: false, code: 'read_failed', error: String((e && e.message) || e) };
  }
}

// 只要 todos：读不出来就给空数组
export function todosOfFile(file) {
  const got = readPlan(file);
  return got.ok ? (got.todos || []) : [];
}

// 列出各目录下的计划，按修改时间倒序；同一文件在多处出现时只留先扫到的那份
// scope：home / workspace / luban（extraDirs 传进来的额外目录）
export function listPlans(opts) {
  const o = opts || {};
  const extra = Array.isArray(o.extraDirs) ? o.extraDirs : [];
  const dirs = roots(o.home, o.root, extra);
  // scope 按来源标记，不能按下标猜：workspace 目录为空时 extra 会顶到第 1 位
  const scopes = ['home'];
  if (workspacePlanDir(o.root)) { scopes.push('workspace'); }
  for (let i = 0; i < extra.length; i++) {
    if (String(extra[i] || '')) { scopes.push('luban'); }
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < dirs.length; i++) {
    let ents = [];
    try { ents = fs.readdirSync(dirs[i], { withFileTypes: true }); } catch (e) { continue; }
    for (let j = 0; j < ents.length; j++) {
      const ent = ents[j];
      if (!ent.isFile() || !/\.md$/i.test(ent.name)) { continue; }
      const file = path.join(dirs[i], ent.name);
      const key = path.resolve(file).toLowerCase();
      if (seen.has(key)) { continue; }
      seen.add(key);
      let st = null;
      try { st = fs.statSync(file); } catch (e) { continue; }
      const got = parse(readHead(file));
      out.push({
        file: file,
        base: ent.name,
        name: got.name || fallbackName(ent.name),
        overview: got.overview || '',
        size: st.size,
        mtimeMs: st.mtimeMs,
        scope: scopes[i] || 'home'
      });
    }
  }
  out.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
  return out;
}
