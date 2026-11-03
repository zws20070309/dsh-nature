#!/usr/bin/env node
'use strict';

/**
 * baseline.cjs —— 从本地 git clone 离线生成 nature-skills 基线清单（零依赖）。
 *
 * 为什么离线：git blob sha 是内容寻址的，`git ls-tree` 读到的 sha 与 GitHub
 * trees API 返回的完全一致（同一种哈希），不需要联网就能建立基线。
 *
 * 用法：
 *   node baseline.cjs <cloneDir> [statePath]
 *
 *   cloneDir   nature-skills 的本地 git clone（必须含 skills/ 子树）
 *   statePath  插件状态文件位置，默认 $DSH_HOME/dsh-nature-state.json（无
 *              DSH_HOME 时回落 ~/.dsh/）。已存在的 state 只更新清单侧字段，
 *              config（autoCheck/intervalHours/targetDir/mirror）原样保留。
 */

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const STATE_VERSION = 1;
const SKILLS_PREFIX = 'skills/';

function fail(message) {
  console.error('baseline: ' + message);
  process.exit(1);
}

const cloneDir = process.argv[2];
if (cloneDir === undefined) {
  fail('usage: node baseline.cjs <cloneDir> [statePath]');
}
const repoRoot = resolve(cloneDir);
if (!existsSync(join(repoRoot, '.git'))) {
  fail('not a git clone (no .git found): ' + repoRoot);
}
const dshHome =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
const statePath = process.argv[3] !== undefined ? resolve(process.argv[3]) : join(dshHome, 'dsh-nature-state.json');

function git(args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  } catch (error) {
    fail('git ' + args.join(' ') + ' failed: ' + (error && error.message ? error.message : String(error)));
    return ''; // 不可达，仅满足静态分析
  }
}

const headSha = git(['rev-parse', 'HEAD']).trim();
if (!/^[0-9a-f]{40}$/i.test(headSha)) {
  fail('unexpected rev-parse output: ' + JSON.stringify(headSha));
}

// -z：条目以 NUL 结尾且路径不做引号转义 —— 空格/中文/引号文件名都能安全解析。
const raw = git(['ls-tree', '-r', '-z', 'HEAD', '--', SKILLS_PREFIX]);
const files = {};
for (const entry of raw.split('\0')) {
  if (entry.length === 0) continue;
  const tabIndex = entry.indexOf('\t');
  if (tabIndex < 0) fail('malformed ls-tree entry: ' + JSON.stringify(entry));
  const meta = entry.slice(0, tabIndex).split(' '); // <mode> <type> <sha>
  const path = entry.slice(tabIndex + 1);
  if (meta.length !== 3 || meta[1] !== 'blob') continue; // submodule(gitlink)/tree 跳过
  if (!path.startsWith(SKILLS_PREFIX)) continue;
  const rel = path.slice(SKILLS_PREFIX.length);
  // 清单键是 `<skill>/<rel>`；skills/ 顶层散文件不构成 skill，跳过。
  const slash = rel.indexOf('/');
  if (slash <= 0 || slash === rel.length - 1) continue;
  files[rel] = meta[2];
}
if (Object.keys(files).length === 0) {
  fail('no files under ' + SKILLS_PREFIX + ' in ' + repoRoot + ' - wrong clone directory?');
}

let state;
if (existsSync(statePath)) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.version === STATE_VERSION) {
      state = parsed;
    }
  } catch (error) {
    console.error('baseline: existing state is not valid JSON, starting fresh (' + error.message + ')');
  }
}
if (state === undefined || state.version !== STATE_VERSION) state = { version: STATE_VERSION };
state.version = STATE_VERSION;
// 基线 = 当前 clone 的 HEAD："刚写完清单时本地与 clone 一致"是它的本义。
// 若 clone 已落后远端，插件的下次 check 会用 GitHub API 的 headSha 纠正。
state.headSha = headSha;
state.lastCheckedAt = new Date().toISOString();
state.lastCheckStatus = 'upToDate';
state.lastError = null;
state.updateAvailable = false;
state.changedSkills = [];
state.manifest = { headSha, files };
// config 原样保留（不存在才补空对象；默认值由插件 load 时合并）。
if (state.config === null || typeof state.config !== 'object' || Array.isArray(state.config)) {
  state.config = {};
}

// 同目录 tmp + rename 原子写：与插件引擎的写盘方式一致，读者看不到半个文件。
mkdirSync(dirname(statePath), { recursive: true });
const temp = statePath + '.' + process.pid.toString(36) + '-' + Date.now().toString(36) + '.tmp';
writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
try {
  renameSync(temp, statePath);
} catch (error) {
  try {
    unlinkSync(temp);
  } catch {
    /* 临时文件都清理不掉时无能为力，保底不掩盖原始错误 */
  }
  throw error;
}

const skillNames = new Set();
for (const key of Object.keys(files)) skillNames.add(key.slice(0, key.indexOf('/')));
console.log('baseline: ' + Object.keys(files).length + ' files across ' + skillNames.size + ' skills @ ' + headSha.slice(0, 12));
console.log('baseline: state written -> ' + statePath);
