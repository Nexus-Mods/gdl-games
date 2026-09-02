#!/usr/bin/env node
// Locate and tail a Vortex log. The dev build (run from source, e.g. C:\src\Vortex)
// and an installed build keep entirely separate appdata dirs, so "the log" is
// ambiguous unless you say which. Reading the wrong one shows a stale session
// and looks like nothing happened.
//
//   node tools/vortex-log.mjs [--dev|--prod] [--path] [--lines N] [--grep A|B] [--exclude A|B] [--follow]
//
// --grep/--exclude take `|`-separated literal substrings, matched case-insensitively.
// Not regexes: see the note by their definitions.
//
// --follow is a hand-rolled poll rather than `tail -f` or PowerShell
// `Get-Content -Wait`: Git Bash's tail does not see writes to a file Vortex
// holds open, and PowerShell's object pipeline buffers when redirected, so
// neither delivers a line at a time to a watching process.
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PATHS = {
  dev: join(process.env.APPDATA ?? '', '@vortex', 'main', 'vortex.log'),
  prod: join(process.env.APPDATA ?? '', 'Vortex', 'vortex.log'),
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const channel = args.includes('--prod') ? 'prod' : 'dev';
const log = flag('--file', PATHS[channel]);      // --file: for testing the tail itself

if (args.includes('--path')) {
  for (const [k, v] of Object.entries(PATHS)) {
    const state = existsSync(v)
      ? `${statSync(v).size} bytes, ${statSync(v).mtime.toISOString()}`
      : 'missing';
    console.log(`${k.padEnd(5)} ${v}  (${state})`);
  }
  process.exit(0);
}

if (!existsSync(log)) {
  console.error(`no log at ${log}`);
  process.exit(1);
}

// `|`-separated case-insensitive SUBSTRINGS, not regexes. Every filter this tool
// has ever needed is alternation of literal terms, and building a RegExp from a
// command-line argument is a regex-injection sink (CodeQL js/regex-injection)
// that also lets a stray metacharacter throw or hang the watcher. Substring
// matching is enough and cannot misbehave.
const terms = (rel) => (flag(rel, '') ?? '')
  .split('|')
  .map(t => t.trim().toLowerCase())
  .filter(Boolean);

const include = terms('--grep');
// Vortex's startup is dominated by extension/health-check registration, which
// matches almost any broad filter. Without an exclude the real events are
// buried, and a monitor that floods gets stopped automatically.
const exclude = terms('--exclude');

const emit = (line) => {
  if (!line) return;
  const hay = line.toLowerCase();
  if (exclude.some(t => hay.includes(t))) return;
  if (include.length === 0 || include.some(t => hay.includes(t))) console.log(line);
};

// Backlog: last N lines, filtered.
const tailLines = Number(flag('--lines', '200'));
if (tailLines > 0) {
  const fd = openSync(log, 'r');
  const size = statSync(log).size;
  const want = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(want);
  readSync(fd, buf, 0, want, size - want);
  closeSync(fd);
  buf.toString('utf8').split(/\r?\n/).slice(-tailLines).forEach(emit);
}

if (!args.includes('--follow')) process.exit(0);

// Poll from the byte offset we have already consumed. Reading a file another
// process holds open is fine; we never write.
let offset = statSync(log).size;
let carry = '';
setInterval(() => {
  let size;
  try { size = statSync(log).size; } catch { return; }
  if (size < offset) { offset = 0; carry = ''; }   // log rotated/truncated
  if (size === offset) return;
  const fd = openSync(log, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  offset = size;
  const parts = (carry + buf.toString('utf8')).split(/\r?\n/);
  carry = parts.pop() ?? '';
  parts.forEach(emit);
}, 500);
