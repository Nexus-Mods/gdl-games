#!/usr/bin/env node
/**
 * list-archive.mjs — build corpus manifests WITHOUT the Nexus file-metadata endpoint.
 *
 * Nexus stopped generating file-preview manifests for uploads with UUID-style `uri`s
 * (~11 June 2026), so `gdl test:corpus --fetch` fetches nothing for any recent upload.
 * The archives themselves are still downloadable, so we reconstruct the same file
 * listings the corpus needs:
 *
 *   .zip          → HTTP Range-read the tail, walk the ZIP central directory (a few KB,
 *                   even for a multi-GB archive)
 *   .7z / .rar    → full download + `7z l -ba -slt`
 *
 * Output goes to games/<id>/tests/cache/ in the same shape and filename `--fetch` uses,
 * so `test-corpus` (WITHOUT --fetch) then routes them normally.
 *
 * See docs/corpus-manifests.md. DELETE THIS TOOL once Nexus restores manifests.
 *
 * Usage:
 *   node tools/corpus/list-archive.mjs --domain <domain> --game-id <n> --all \
 *     --out games/<domain>/tests/cache
 *   node tools/corpus/list-archive.mjs --domain <d> --game-id <n> --mod 9,22,35 --out <dir>
 *
 * Requires NEXUS_API_KEY (premium account — download links are premium-only).
 * Exits non-zero if any mod fails, so a partial run can never look like success.
 */

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const API = 'https://api.nexusmods.com';
const TAIL_BYTES = 96 * 1024;   // EOCD + central directory for typical mod archives
const KEY = process.env.NEXUS_API_KEY;

// ---------------------------------------------------------------- args

const parseArgs = (argv) => {
  const out = { mods: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domain')       out.domain = argv[++i];
    else if (a === '--game-id') out.gameId = Number(argv[++i]);
    else if (a === '--out')     out.out = argv[++i];
    else if (a === '--all')     out.all = true;
    else if (a === '--mod' || a === '--mods') {
      out.mods = String(argv[++i]).split(',').map(s => Number(s.trim())).filter(Number.isFinite);
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
};

const usage = `Usage:
  node tools/corpus/list-archive.mjs --domain <domain> --game-id <n> (--all | --mod 1,2,3) --out <dir>

Env: NEXUS_API_KEY (premium account required)
Docs: docs/corpus-manifests.md`;

// ---------------------------------------------------------------- http

const headers = () => ({ apikey: KEY, 'User-Agent': 'gdl-games/1.0' });

const getJson = async (path) => {
  const res = await fetch(API + path, { headers: headers() });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json();
};

const gql = async (query, variables) => {
  const res = await fetch(`${API}/v2/graphql`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`graphql → ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`graphql: ${body.errors.map(e => e.message).join('; ')}`);
  return body.data;
};

// ---------------------------------------------------------------- nexus

const publishedModIds = async (domain) => {
  const data = await gql(
    `query($d:String!,$c:Int!,$o:Int!){ mods(filter:{gameDomainName:{value:$d,op:EQUALS},
       status:{value:"published",op:EQUALS}}, count:$c, offset:$o){ totalCount nodes{ modId } } }`,
    { d: domain, c: 50, o: 0 });
  const { totalCount, nodes } = data.mods;
  const ids = nodes.map(n => n.modId);
  for (let offset = ids.length; offset < totalCount;) {
    const page = await gql(
      `query($d:String!,$c:Int!,$o:Int!){ mods(filter:{gameDomainName:{value:$d,op:EQUALS},
         status:{value:"published",op:EQUALS}}, count:$c, offset:$o){ nodes{ modId } } }`,
      { d: domain, c: 50, o: offset });
    if (page.mods.nodes.length === 0) break;
    ids.push(...page.mods.nodes.map(n => n.modId));
    offset = ids.length;
  }
  return [...new Set(ids)].sort((a, b) => a - b);
};

/** Mirrors gdl's pickDefaultFile: newest MAIN, else newest of any category. */
const pickDefaultFile = (files) => {
  const main = files.filter(f => (f.category_name ?? '').toUpperCase() === 'MAIN')
    .sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp);
  if (main.length) return main[0];
  return [...files].sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];
};

// ---------------------------------------------------------------- zip central directory

const rangeGet = async (url, start, end) => {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok && res.status !== 206) throw new Error(`range GET → ${res.status} ${res.statusText}`);
  const total = Number((res.headers.get('content-range') ?? '').split('/')[1]) || undefined;
  return { buf: Buffer.from(await res.arrayBuffer()), total };
};

/**
 * Parse a ZIP's central directory via range requests.
 * ZIP64 is deliberately unsupported — it throws so the caller falls back to a full
 * download rather than silently emitting a truncated listing.
 */
const zipNamesViaRange = async (url) => {
  const probe = await rangeGet(url, 0, 0);
  const size = probe.total;
  if (!size) throw new Error('server did not report a size (no Content-Range)');

  const start = Math.max(0, size - TAIL_BYTES);
  let { buf } = await rangeGet(url, start, size - 1);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`no EOCD in the last ${TAIL_BYTES} bytes`);

  let count  = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff  = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error('ZIP64 central directory');

  // If the central directory starts before our tail window, fetch it exactly.
  let base = start;
  if (cdOff < start) {
    ({ buf } = await rangeGet(url, cdOff, cdOff + cdSize - 1));
    base = cdOff;
  }

  const names = [];
  let p = cdOff - base;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central-directory header at entry ${i}`);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (!name.endsWith('/')) names.push(name.replace(/\\/g, '/'));
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return names;
};

// ---------------------------------------------------------------- 7z / rar

const have7z = () => spawnSync('7z', ['--help'], { encoding: 'utf8' }).status === 0;

/**
 * List a non-zip archive with 7-Zip.
 *
 * GOTCHA: `-ba` suppresses the header, so EVERY "Path = " line is a real entry — do NOT
 * drop the first one. Dropping it silently reports single-file archives as EMPTY, which
 * once hid an entire mod category. Directory rows carry "Folder = +" and are filtered.
 */
const namesVia7z = (file) => {
  const r = spawnSync('7z', ['l', '-ba', '-slt', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`7z failed: ${(r.stderr || '').trim().split('\n')[0]}`);
  const names = [];
  let cur = null;
  const flush = () => { if (cur && cur.path && cur.folder !== '+') names.push(cur.path.replace(/\\/g, '/')); };
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('Path = '))        { flush(); cur = { path: line.slice(7).trim() }; }
    else if (line.startsWith('Folder = ')) { if (cur) cur.folder = line.slice(9).trim(); }
  }
  flush();
  return names;
};

const namesViaDownload = async (url, ext) => {
  const tmp = join(tmpdir(), `gdl-corpus-${process.pid}-${Date.now()}${ext}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download → ${res.status} ${res.statusText}`);
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  try { return namesVia7z(tmp); }
  finally { await unlink(tmp).catch(() => {}); }
};

// ---------------------------------------------------------------- manifest tree

const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Build the {name,path,type,children} tree gdl's flattenManifest expects. */
const buildTree = (paths) => {
  const root = { name: '', path: '', type: 'directory', children: [] };
  const dirFor = (parts) => {
    let node = root;
    parts.forEach((part, i) => {
      let next = node.children.find(c => c.type === 'directory' && c.name === part);
      if (!next) {
        next = { name: part, path: parts.slice(0, i + 1).join('/'), type: 'directory', children: [] };
        node.children.push(next);
      }
      node = next;
    });
    return node;
  };
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path || path.endsWith('/')) continue;
    const parts = path.split('/');
    const parent = parts.length > 1 ? dirFor(parts.slice(0, -1)) : root;
    parent.children.push({ name: parts.at(-1), path, type: 'file', size: '1 KB' });
  }
  return root;
};

// ---------------------------------------------------------------- main

const main = async () => {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`${e.message}\n\n${usage}`); process.exit(2); }

  if (args.help) { console.log(usage); return; }
  if (!KEY) { console.error('NEXUS_API_KEY is not set (premium account required).'); process.exit(2); }
  if (!args.domain || !Number.isFinite(args.gameId) || !args.out) {
    console.error(`--domain, --game-id and --out are required.\n\n${usage}`); process.exit(2);
  }
  if (!args.all && args.mods.length === 0) {
    console.error(`pass --all or --mod <ids>.\n\n${usage}`); process.exit(2);
  }

  await mkdir(args.out, { recursive: true });

  const modIds = args.all ? await publishedModIds(args.domain) : args.mods;
  console.log(`${args.domain} (game ${args.gameId}): ${modIds.length} mod(s) to list`);

  let listed = 0;
  const failures = [];
  const skipped = [];
  let sevenZipMissing = false;

  for (const modId of modIds) {
    let label = `mod ${modId}`;
    try {
      const { files } = await getJson(`/v1/games/${args.domain}/mods/${modId}/files.json`);
      const file = pickDefaultFile(files ?? []);
      if (!file) { failures.push(`${label}: no files`); console.error(`  ✖ ${label}: no files`); continue; }

      label = `mod ${modId} (${file.file_name})`;
      const links = await getJson(
        `/v1/games/${args.domain}/mods/${modId}/files/${file.file_id}/download_link.json`);
      const url = links?.[0]?.URI;
      if (!url) throw new Error('no download link returned');

      const ext = (file.file_name.match(/\.[A-Za-z0-9]+$/) ?? ['.zip'])[0].toLowerCase();

      // A bare .exe upload is an installer, not a mod archive — the corpus has nothing
      // to route. Report it as a deliberate skip so it doesn't inflate the failure count.
      if (ext === '.exe') {
        skipped.push(`${label}: .exe installer, not a mod archive`);
        console.log(`  · ${label}: skipped (.exe installer)`);
        continue;
      }

      let names;
      if (ext === '.zip') {
        try {
          names = await zipNamesViaRange(url);
        } catch (e) {
          console.error(`    · range read failed (${e.message}); downloading in full`);
          names = await namesViaDownload(url, ext);
        }
      } else {
        if (!have7z()) {
          sevenZipMissing = true;
          throw new Error(`7z not found on PATH — cannot list ${ext} archives`);
        }
        names = await namesViaDownload(url, ext);
      }

      if (names.length === 0) throw new Error('archive listed as empty — check the 7z/zip parser');

      // Nexus `uri` is not exposed by the v1 files endpoint; the filename is what
      // matters for cache identity, and file_name keeps it human-readable.
      const out = join(args.out, `${args.gameId}_${modId}_${file.file_id}_${safe(file.file_name)}.json`);
      await writeFile(out, JSON.stringify(buildTree(names)), 'utf8');
      listed++;
      console.log(`  ✓ ${label}: ${names.length} entries`);
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
      console.error(`  ✖ ${label}: ${e.message}`);
    }
  }

  console.log(`\nlisted ${listed} / ${modIds.length} mods, `
    + `${skipped.length} skipped, ${failures.length} failed`);
  if (skipped.length) {
    console.log('skipped (nothing for the corpus to route):');
    for (const s of skipped) console.log(`  - ${s}`);
  }
  if (sevenZipMissing) console.error('note: install 7-Zip to list .7z/.rar archives');
  if (failures.length) {
    console.error('\nfailures:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('\nA 403 "quarantined" is Nexus moderation, not a coverage gap — see docs/corpus-manifests.md');
    // Set exitCode rather than calling process.exit(): an immediate exit while stderr
    // still has queued writes trips a libuv assertion on Windows (exit 127), which
    // would misreport a handled failure as a crash.
    process.exitCode = 1;
  }
};

main().catch(e => { console.error(e); process.exitCode = 1; });
