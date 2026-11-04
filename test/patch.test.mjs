// cordis.patch.yml 结构自检：node:test + 零依赖（正则/字符串断言，不引 yaml 库——
// DSH 自己的 entryListSchema 扩展了 !!js 标签，现成解析器都读不了，结构断言反而是对的刀）。
// 断言清单来自任务契约；行 id 唯一 / workflow 保持禁用两条对应 docs/design.md §4 质量门与 §2 取舍；
// persona.md 逐字一致对应任务 B（「与 patch 里完全一致」）与 docs/design.md §1。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const patchText = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8');
const personaDoc = readFileSync(join(repoRoot, 'preset', 'persona.md'), 'utf8');
const lines = patchText.split(/\r?\n/);

// 取「- id: <rowId>」行的块文本：从该行到下一个同缩进的「- id: 」行之前。
function rowBlock(rowId) {
  const start = lines.findIndex((l) => new RegExp(`^\\s*- id: ${rowId}\\s*$`).test(l));
  assert.notEqual(start, -1, `patch 中找不到行 id: ${rowId}`);
  const indent = lines[start].match(/^\s*/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- id: /.test(lines[i]) && lines[i].match(/^\s*/)[0].length === indent) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

// 从 `prefix: |-` 字面量块标量提取 persona 文本（镜像 YAML 语义：内容缩进取首个内容行，
// 更深缩进原样保留，尾部空行因 |- 剥离符被去掉）。
function personaPrefixFromPatch() {
  const i = lines.findIndex((l) => /^\s*prefix: \|-/.test(l));
  assert.notEqual(i, -1, 'persona prefix 必须是 |- 字面量块标量');
  const parentIndent = lines[i].match(/^\s*/)[0].length;
  const out = [];
  let contentIndent = null;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') {
      out.push('');
      continue;
    }
    const ind = l.match(/^\s*/)[0].length;
    if (ind <= parentIndent) break; // 反缩进即块标量结束
    if (contentIndent === null) contentIndent = ind;
    out.push(l.slice(contentIndent));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n').replace(/\r\n/g, '\n');
}

// persona.md 中 ```text 围栏内的原文（persona 文本不含反引号，非贪婪匹配安全）。
// 行尾统一成 LF 再比：仓库 core.autocrlf=true，Windows 签出的是 CRLF，而 YAML 的 |- 块
// 标量**按规范把换行归一成 LF**——宿主真正加载到的就是 LF 文本。拿 CRLF 的原文去比，
// 在 Windows 上永远不等（这不是文本漂移，是两边行尾表示不同）。
function personaFromDoc() {
  const m = personaDoc.match(/```text\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(m, 'preset/persona.md 必须含一段 ```text 围栏包裹的 persona 原文');
  return m[1].replace(/\r\n/g, '\n');
}

test('文件以 - insert: 开头', () => {
  assert.ok(patchText.startsWith('- insert:'), '首行必须是 - insert:（顶层一个 insert 列表）');
});

test('含 id: preset-nature 与 id: dsh-nature 行，且各出现一次', () => {
  for (const rowId of ['preset-nature', 'dsh-nature']) {
    const hits = lines.filter((l) => new RegExp(`^\\s*- id: ${rowId}\\s*$`).test(l));
    assert.equal(hits.length, 1, `${rowId} 行必须恰好出现一次`);
  }
});

test('插件行 name 为 @zws/dsh-nature', () => {
  const start = lines.findIndex((l) => /^\s*- id: dsh-nature\s*$/.test(l));
  assert.notEqual(start, -1, '缺少 - id: dsh-nature 插件行');
  assert.match(
    lines[start + 1],
    /^\s*name: '@zws\/dsh-nature'\s*$/,
    '插件行 name 必须是 @zws/dsh-nature',
  );
});

test('preset 行身份字段：@deepseek-ai/dsh-agent-preset + id=nature + order=7 + 展示名/描述', () => {
  const block = rowBlock('preset-nature');
  assert.match(block, /^\s*name: '@deepseek-ai\/dsh-agent-preset'\s*$/m);
  assert.match(block, /^\s+id: nature\s*$/m, '预设身份必须是 nature');
  assert.match(block, /^\s*order: 7\s*$/m, 'order 必须是 7（本机已有 5/6）');
  assert.match(block, /^\s*name: 'Nature 论文写作'\s*$/m);
  assert.match(block, /^\s*description: Nature 论文写作/m, '缺少 description');
});

test('preset 行含 tool-presentation 且 mode: ptc（PTC 形态开关）', () => {
  assert.ok(lines.some((l) => /^\s*- id: tool-presentation\s*$/.test(l)), '缺少 tool-presentation 行');
  assert.ok(lines.some((l) => /^\s*mode: ptc\s*$/.test(l)), 'tool-presentation 的 mode 必须是 ptc');
});

test('persona 行不含 complete，也不写 includeRuntimeContext', () => {
  const block = rowBlock('persona');
  assert.ok(!block.includes('complete'), 'complete 会独占提示词、静默丢掉 plan-mode/goal 等段');
  assert.ok(!block.includes('includeRuntimeContext'), '必须保留时间上下文');
});

test('无 tab 字符', () => {
  assert.ok(!patchText.includes('\t'), 'YAML 缩进只允许空格');
});

test('!!js 只出现在 disabled: 行', () => {
  const jsLines = lines.filter((l) => l.includes('!!js'));
  assert.ok(jsLines.length >= 2, 'tool-bash/tool-pwsh 的 !!js 平台表达式应原样保留');
  for (const l of jsLines) {
    assert.match(l, /^\s*disabled: !!js /, `!!js 必须挂在 disabled: 行：${l.trim()}`);
  }
});

test('delegation 组 workflow-ptc / tool-workflow 保持 disabled: true（与 ptc 逐行一致）', () => {
  for (const rowId of ['workflow-ptc', 'tool-workflow']) {
    assert.match(rowBlock(rowId), /^\s*disabled: true\s*$/m, `${rowId} 必须保持禁用`);
  }
});

test('preset/persona.md 与 patch 内 persona.prefix 逐字一致', () => {
  assert.equal(personaPrefixFromPatch(), personaFromDoc());
});
