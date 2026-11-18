// SPDX-License-Identifier: MIT
// kara-forge: a single-process GitHub-compatible git forge (Node 22, stdlib only).
// One in-memory store shared by git smart HTTP, REST v3, GraphQL v4 and MCP.
// Deterministic timestamps: a monotonic counter from 2025-01-01T00:00:00Z, so two
// runs fed the same seeded requests produce the same ordering and the same values.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
const ZERO = '0'.repeat(40);
const EPOCH_MS = 1735689600000; // 2025-01-01T00:00:00Z
const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------- utilities
function sha1hex(b: Buffer): string { return createHash('sha1').update(b).digest('hex'); }
function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1hex(Buffer.concat([head, data]));
}
function b64url(s: string): string { return Buffer.from(s, 'utf8').toString('base64url'); }
function b64dec(s: string): Buffer { return Buffer.from(s.replace(/\s/g, ''), 'base64'); }
function esc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
let tick = 0;
function nowIso(): string { tick += 1; return new Date(EPOCH_MS + tick * 1000).toISOString(); }
function nowEpoch(): number { return 1735689600 + tick; }
let reqSeq = 0;
function nextReqId(): string { reqSeq += 1; return `req-${reqSeq}`; }
function isSha(s: unknown): s is string { return typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s); }
function linesOf(b: Buffer): number { let n = 0; for (let i = 0; i < b.length; i++) if (b[i] === 10) n += 1; return n; }

// ---------------------------------------------------------------- store
interface Obj { type: string; data: Buffer }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: { name: string; color: string }[]; user: any; createdAt: string; updatedAt: string;
  closedAt: string | null; seq: number; comments: { id: number; body: string; user: any; createdAt: string }[];
}
interface PR {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeSha: string | null; seq: number;
  files: { filename: string; status: string; additions: number; deletions: number; changes: number }[];
  baseTreeFlat: Map<string, string>; headTreeFlat: Map<string, string>;
}
interface Repo {
  id: number; owner: string; name: string; description: string; priv: boolean;
  defaultBranch: string; createdAt: string; updatedAt: string; seq: number;
  objects: Map<string, Obj>; refs: Map<string, string>;
  issues: Issue[]; prs: PR[]; labels: Map<string, { name: string; color: string }>;
  nextNumber: number; nextCommentId: number;
}
const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let nextGlobalId = 100000;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
function createRepoRecord(owner: string, name: string, description: string, priv: boolean): Repo {
  const r: Repo = {
    id: nextRepoId++, owner, name, description: description ?? '', priv: !!priv,
    defaultBranch: 'main', createdAt: nowIso(), updatedAt: nowIso(), seq: tick,
    objects: new Map(), refs: new Map(), issues: [], prs: [],
    labels: new Map(), nextNumber: 1, nextCommentId: 1,
  };
  repos.set(repoKey(owner, name), r);
  return r;
}
function userObj(login = VIEWER.login, id = VIEWER.id): any {
  return { login, id, node_id: b64url(`User:${id}`), avatar_url: '', gravatar_id: '', url: `/api/v3/users/${login}`, html_url: `https://example.invalid/${login}`, type: 'User', site_admin: false };
}
function globalId(kind: string, repo: Repo, n: number): string { return b64url(`${kind}:${repo.id}:${n}`); }
function repoGlobalId(repo: Repo): string { return b64url(`Repository:${repo.id}:0`); }

// ---------------------------------------------------------------- git objects
function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const out: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}
function treeSortKey(name: string, mode: string): string { return mode === '40000' ? `${name}/` : name; }
function buildTree(repo: Repo, entries: { mode: string; name: string; oid: string }[]): string {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a.name, a.mode) < treeSortKey(b.name, b.mode) ? -1 : treeSortKey(a.name, a.mode) > treeSortKey(b.name, b.mode) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
  return oid;
}
function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; raw: Buffer } {
  const text = data.toString('utf8');
  const idx = text.indexOf('\n\n');
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const message = idx >= 0 ? text.slice(idx + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: data };
}
function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  let object = '', type = '', tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const epoch = nowEpoch();
  const ident = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
  let s = `tree ${treeOid}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  const data = Buffer.from(s, 'utf8');
  const oid = hashObject('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  return oid;
}
// flat path -> blob oid for a tree (recursive)
function flatTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flatTree(repo, e.oid, path, out);
    else out.set(path, e.oid);
  }
  return out;
}
function treeFromFlat(repo: Repo, flat: Map<string, string>): string {
  // group by first segment
  const groups = new Map<string, { mode: string; name: string; oid: string }[]>();
  const files: { mode: string; name: string; oid: string }[] = [];
  const dirs = new Map<string, Map<string, string>>();
  for (const [path, oid] of flat) {
    const slash = path.indexOf('/');
    if (slash < 0) files.push({ mode: '100644', name: path, oid });
    else {
      const dir = path.slice(0, slash);
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir)!.set(path.slice(slash + 1), oid);
    }
  }
  const entries = [...files];
  for (const [dir, sub] of dirs) entries.push({ mode: '40000', name: dir, oid: treeFromFlat(repo, sub) });
  return buildTree(repo, entries);
}
function commitTreeFlat(repo: Repo, commitOid: string): Map<string, string> {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flatTree(repo, parseCommit(obj.data).tree);
}
function ancestors(repo: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!cur || cur === ZERO || seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj && obj.type === 'commit') { for (const p of parseCommit(obj.data).parents) stack.push(p); }
    else if (obj && obj.type === 'tag') { stack.push(parseTag(obj.data).object); }
  }
  return seen;
}
function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  return ancestors(repo, desc).has(anc);
}
function reachable(repo: Repo, tips: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!cur || cur === ZERO || out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    out.add(cur);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}
function diffFlat(base: Map<string, string>, head: Map<string, string>): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const all = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...all].sort()) {
    const b = base.get(path); const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) files.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
    else if (h === undefined) files.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    else files.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
  }
  return files;
}
// fix additions/deletions from actual blob line counts when repo available
function enrichDiff(repo: Repo, base: Map<string, string>, head: Map<string, string>): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  return diffFlat(base, head).map((f) => {
    const h = head.get(f.filename); const b = base.get(f.filename);
    const hLines = h ? linesOf(repo.objects.get(h)?.data ?? Buffer.alloc(0)) : 0;
    const bLines = b ? linesOf(repo.objects.get(b)?.data ?? Buffer.alloc(0)) : 0;
    if (f.status === 'added') return { ...f, additions: Math.max(1, hLines), deletions: 0, changes: Math.max(1, hLines) };
    if (f.status === 'removed') return { ...f, additions: 0, deletions: Math.max(1, bLines), changes: Math.max(1, bLines) };
    const add = Math.max(1, hLines); return { ...f, additions: add, deletions: Math.max(0, bLines), changes: add + Math.max(0, bLines) };
  });
}

// ---------------------------------------------------------------- HTTP helpers
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); if (Buffer.concat(chunks).length > 64 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': nextReqId(), ...extra };
  if (body !== null) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(buf.length), 'x-github-request-id': nextReqId(), ...extra });
  res.end(buf);
}
function errJson(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { message }); }
function expectedToken(): string { return process.env.MAKEFUN_SHOP_TOKEN ?? ''; }
function authOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7).trim();
  if (!tok) return false;
  const exp = expectedToken();
  return exp === '' ? true : tok === exp;
}
function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (authOk(req)) return true;
  errJson(res, 401, 'Requires authentication');
  return false;
}
function urlOf(req: IncomingMessage): { path: string; query: URLSearchParams; segments: string[] } {
  const u = new URL(req.url ?? '/', 'http://entry');
  const path = u.pathname;
  return { path, query: u.searchParams, segments: path.split('/').filter((s) => s.length > 0) };
}
function parseJsonBody(buf: Buffer): { ok: true; value: any } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
}
function decodePath(p: string): string { try { return decodeURIComponent(p); } catch { return p; } }

// repo JSON shapes
function repoJson(r: Repo): any {
  return {
    id: r.id, node_id: repoGlobalId(r), name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: userObj(r.owner, r.owner === VIEWER.login ? VIEWER.id : 1001),
    private: r.priv, html_url: `https://example.invalid/${r.owner}/${r.name}`,
    description: r.description, fork: false, url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.createdAt, updated_at: r.updatedAt, pushed_at: r.updatedAt,
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, mirror_url: null, archived: false, disabled: false,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false, visibility: r.priv ? 'private' : 'public',
    forks: 0, open_issues: 0, watchers: 0, default_branch: r.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function issueJson(r: Repo, i: Issue): any {
  return {
    id: i.id, node_id: globalId('Issue', r, i.number), number: i.number, title: i.title, body: i.body,
    state: i.state, user: i.user, labels: i.labels.map((l) => ({ id: 1000 + l.name.length, node_id: b64url(`Label:${l.name}`), name: l.name, color: l.color, description: '', url: `/api/v3/repos/${r.owner}/${r.name}/labels/${encodeURIComponent(l.name)}`, default: l.name === 'bug' })),
    assignee: null, assignees: [], milestone: null, locked: false, comments: i.comments.length,
    created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt,
    author_association: 'OWNER', html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
    comments_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}/comments`,
    events_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}/events`,
  };
}
function prJson(r: Repo, p: PR): any {
  const headRepo = repoJson(r);
  return {
    id: p.id, node_id: globalId('PullRequest', r, p.number), number: p.number, title: p.title, body: p.body,
    state: p.state, locked: false, user: userObj(), created_at: '', updated_at: '',
    closed_at: p.state === 'closed' ? (p.mergedAt ?? nowIso()) : null,
    merged_at: p.mergedAt, merge_commit_sha: p.mergeSha, merged: p.merged, mergeable: true, mergeable_state: 'clean',
    merge_method: 'squash', draft: false, html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    head: { label: `${r.owner}:${p.headRef}`, ref: p.headRef, sha: p.headSha, user: userObj(), repo: headRepo },
    base: { label: `${r.owner}:${p.baseRef}`, ref: p.baseRef, sha: p.baseSha, user: userObj(), repo: headRepo },
    author_association: 'OWNER', additions: p.files.reduce((a, f) => a + f.additions, 0),
    deletions: p.files.reduce((a, f) => a + f.deletions, 0), changed_files: p.files.length,
    commits: 1,
  };
}
function branchTip(r: Repo, ref: string): string {
  // ref may be branch name, full ref, or oid
  if (isSha(ref)) return ref;
  const full = ref.startsWith('refs/heads/') ? ref : `refs/heads/${ref}`;
  return r.refs.get(full) ?? '';
}
function resolveRefTip(r: Repo, ref: string | null): string {
  if (!ref) return r.refs.get(`refs/heads/${r.defaultBranch}`) ?? '';
  return branchTip(r, ref);
}
function createIssueRecord(r: Repo, title: string, body: string, labels: string[]): Issue {
  const n = r.nextNumber++;
  const now = nowIso();
  const iss: Issue = {
    id: nextGlobalId++, number: n, title: title ?? '', body: body ?? '', state: 'open',
    labels: labels.map((name) => { const l = r.labels.get(name); return { name, color: l ? l.color : 'ededed' }; }),
    user: userObj(), createdAt: now, updatedAt: now, closedAt: null, seq: tick, comments: [],
  };
  r.issues.push(iss);
  return iss;
}
function createPRRecord(r: Repo, title: string, body: string, head: string, base: string): PR | null {
  const headSha = branchTip(r, head);
  const baseSha = branchTip(r, base);
  if (!headSha || !baseSha) return null;
  const baseFlat = commitTreeFlat(r, baseSha);
  const headFlat = commitTreeFlat(r, headSha);
  const n = r.nextNumber++;
  const pr: PR = {
    id: nextGlobalId++, number: n, title: title ?? '', body: body ?? '', state: 'open',
    headRef: head, baseRef: base, headSha, baseSha, merged: false, mergedAt: null, mergeSha: null, seq: tick,
    files: enrichDiff(r, baseFlat, headFlat), baseTreeFlat: baseFlat, headTreeFlat: headFlat,
  };
  r.prs.push(pr);
  return pr;
}
function prMergeable(r: Repo, p: PR): boolean {
  if (p.state !== 'open') return false;
  const curBaseTip = branchTip(r, p.baseRef);
  if (!curBaseTip || curBaseTip === p.baseSha) return true;
  const curBaseFlat = commitTreeFlat(r, curBaseTip);
  const changedSinceBase = new Set<string>();
  for (const [path, oid] of curBaseFlat) if (p.baseTreeFlat.get(path) !== oid) changedSinceBase.add(path);
  for (const [path, oid] of p.baseTreeFlat) if (!curBaseFlat.has(path)) changedSinceBase.add(path);
  for (const f of p.files) if (changedSinceBase.has(f.filename)) return false;
  return true;
}
function doMerge(r: Repo, p: PR): { ok: boolean; sha?: string; status?: number } {
  if (p.state !== 'open') return { ok: false, status: 405 };
  if (!prMergeable(r, p)) return { ok: false, status: 405 };
  const curBaseTip = branchTip(r, p.baseRef);
  const curBaseFlat = commitTreeFlat(r, curBaseTip);
  const merged = new Map(curBaseFlat);
  for (const [path, oid] of p.headTreeFlat) merged.set(path, oid);
  for (const f of p.files) if (f.status === 'removed') merged.delete(f.filename);
  const treeOid = treeFromFlat(r, merged);
  const parents = curBaseTip && curBaseTip !== ZERO ? [curBaseTip] : [];
  const msg = `Merge pull request #${p.number} from ${r.owner}/${p.headRef}\n\n${p.title}\n`;
  const sha = makeCommit(r, treeOid, parents, msg);
  r.refs.set(`refs/heads/${p.baseRef}`, sha);
  p.state = 'closed'; p.merged = true; p.mergedAt = nowIso(); p.mergeSha = sha;
  return { ok: true, sha };
}
function contentCommit(r: Repo, branch: string, path: string, content: Buffer, message: string, blobShaProvided?: string): { status: number; body: any } {
  const tip = branchTip(r, branch);
  const flat = tip ? commitTreeFlat(r, tip) : new Map<string, string>();
  const cur = flat.get(path);
  if (blobShaProvided !== undefined && blobShaProvided !== null) {
    if (!cur || cur.toLowerCase() !== String(blobShaProvided).toLowerCase()) {
      return { status: 409, body: { message: 'sha does not match the current blob' } };
    }
  }
  const blobOid = hashObject('blob', content);
  if (!r.objects.has(blobOid)) r.objects.set(blobOid, { type: 'blob', data: content });
  const isUpdate = cur !== undefined;
  const next = new Map(flat); next.set(path, blobOid);
  const treeOid = treeFromFlat(r, next);
  const parents = tip && tip !== ZERO ? [tip] : [];
  const commitSha = makeCommit(r, treeOid, parents, message || 'Update file');
  r.refs.set(`refs/heads/${branch}`, commitSha);
  return { status: isUpdate ? 200 : 201, body: { content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, url: `/api/v3/repos/${r.owner}/${r.name}/contents/${path}`, html_url: '', git_url: '', download_url: '', type: 'file', encoding: 'base64', _links: {} }, commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } } } };
}

// ---------------------------------------------------------------- REST v3
async function handleRest(req: IncomingMessage, res: ServerResponse, seg: string[], query: URLSearchParams, bodyBuf: Buffer): Promise<boolean> {
  // seg[0]='api', seg[1]='v3', rest follows. Returns true if handled.
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const rest = seg.slice(2);
  const method = req.method ?? 'GET';
  // API root + meta (auth required like other API calls, except keep root open if no token? enforce auth)
  if (rest.length === 0) {
    if (!requireAuth(req, res)) return true;
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    if (!requireAuth(req, res)) return true;
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    if (!requireAuth(req, res)) return true;
    sendJson(res, 200, { ...userObj(), name: VIEWER.name, email: VIEWER.email, public_repos: repos.size, followers: 0, following: 0, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' });
    return true;
  }
  // POST /user/repos and GET /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (!requireAuth(req, res)) return true;
    if (method === 'POST') {
      const parsed = parseJsonBody(bodyBuf);
      if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
      const b = parsed.value ?? {};
      const name = String(b.name ?? '');
      if (!name) { errJson(res, 422, 'name is required'); return true; }
      if (getRepo(VIEWER.login, name)) { errJson(res, 422, 'Repository already exists'); return true; }
      const r = createRepoRecord(VIEWER.login, name, String(b.description ?? ''), !!b.private);
      sendJson(res, 201, repoJson(r));
      return true;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const extra: Record<string, string> = {};
      if (start + perPage < all.length) {
        const host = req.headers.host ?? '127.0.0.1';
        const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        extra.link = `<${nextUrl}>; rel="next"`;
      }
      sendJson(res, 200, items.map(repoJson), extra);
      return true;
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  // /repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodePath(rest[1]);
    const name = decodePath(rest[2]);
    const tail = rest.slice(3);
    if (!requireAuth(req, res)) return true;
    // wrong owner -> 404 (never 403), even if repo exists under viewer
    if (owner !== VIEWER.login) { errJson(res, 404, 'Not Found'); return true; }
    const repo = getRepo(owner, name);
    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, repoJson(repo)); return true;
      }
      if (method === 'PATCH') {
        if (!repo) { errJson(res, 404, 'Not Found'); return true; }
        const parsed = parseJsonBody(bodyBuf);
        if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.default_branch === 'string') repo.defaultBranch = parsed.value.default_branch;
        repo.updatedAt = nowIso();
        sendJson(res, 200, repoJson(repo)); return true;
      }
      if (method === 'DELETE') {
        if (!repo) { errJson(res, 404, 'Not Found'); return true; }
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { 'x-github-request-id': nextReqId() }); res.end(); return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    if (!repo) { errJson(res, 404, 'Not Found'); return true; }
    const head = tail[0];
    // branches
    if (head === 'branches' && tail.length === 1 && method === 'GET') {
      const list: any[] = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort()) {
        if (ref.startsWith('refs/heads/')) list.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false });
      }
      sendJson(res, 200, list); return true;
    }
    if (head === 'branches' && tail.length === 2 && method === 'GET') {
      const branch = decodePath(tail[1]);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) { errJson(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, { name: branch, commit: { sha: tip, url: '' }, protected: false }); return true;
    }
    // commits
    if (head === 'commits' && method === 'GET' && tail.length === 1) {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRefTip(repo, ref);
      const list: any[] = [];
      if (tip) {
        const seen = new Set<string>();
        const stack = [tip];
        // BFS/DFS in commit order: newest first via parent chain (linear histories in suite)
        const ordered: string[] = [];
        const q = [tip];
        while (q.length) {
          const cur = q.shift()!;
          if (!cur || cur === ZERO || seen.has(cur)) continue;
          seen.add(cur);
          const obj = repo.objects.get(cur);
          if (!obj || obj.type !== 'commit') continue;
          ordered.push(cur);
          for (const p of parseCommit(obj.data).parents) q.push(p);
        }
        for (const oid of ordered) {
          const c = parseCommit(repo.objects.get(oid)!.data);
          list.push({ sha: oid, commit: { message: c.message, author: { name: VIEWER.name, email: VIEWER.email, date: '2025-01-01T00:00:00Z' }, committer: { name: VIEWER.name, email: VIEWER.email, date: '2025-01-01T00:00:00Z' }, tree: { sha: c.tree } }, author: userObj(), committer: userObj(), parents: c.parents.map((p) => ({ sha: p })) });
        }
      }
      sendJson(res, 200, list); return true;
    }
    // git refs
    if (head === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = parseJsonBody(bodyBuf);
        if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
        const ref = String(parsed.value.ref ?? '');
        const sha = String(parsed.value.sha ?? '');
        if (!ref.startsWith('refs/') || !isSha(sha)) { errJson(res, 422, 'invalid ref'); return true; }
        repo.refs.set(ref, sha.toLowerCase());
        sendJson(res, 201, { ref, node_id: b64url(`Ref:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha: sha.toLowerCase(), type: 'commit', url: '' } });
        return true;
      }
      if (method === 'GET') {
        const refPath = tail.slice(2).map(decodePath).join('/');
        if (!refPath) {
          const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: b64url(`Ref:${ref}`), url: '', object: { sha, type: 'commit', url: '' } }));
          sendJson(res, 200, all); return true;
        }
        const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
        const oid = repo.refs.get(full);
        if (!oid) { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { ref: full, node_id: b64url(`Ref:${full}`), url: '', object: { sha: oid, type: 'commit', url: '' } });
        return true;
      }
      if (method === 'PATCH' && tail.length > 2) {
        const parsed = parseJsonBody(bodyBuf);
        if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
        const refPath = tail.slice(2).map(decodePath).join('/');
        const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
        const sha = String(parsed.value.sha ?? '');
        if (!isSha(sha)) { errJson(res, 422, 'invalid sha'); return true; }
        repo.refs.set(full, sha.toLowerCase());
        sendJson(res, 200, { ref: full, object: { sha: sha.toLowerCase(), type: 'commit', url: '' } });
        return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    // contents
    if (head === 'contents') {
      const path = tail.slice(1).map(decodePath).join('/');
      const ref = query.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = resolveRefTip(repo, ref ?? null);
        if (!tip) { errJson(res, 404, 'Not Found'); return true; }
        const flat = commitTreeFlat(repo, tip);
        if (flat.has(path)) {
          const oid = flat.get(path)!;
          const obj = repo.objects.get(oid);
          const data = obj ? obj.data : Buffer.alloc(0);
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path, content: data.toString('base64'), sha: oid, url: '', html_url: '', git_url: '', download_url: '', _links: {} });
          return true;
        }
        // directory?
        const prefix = path === '' ? '' : `${path}/`;
        const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
        const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
        // walk immediate children of the directory tree
        let dirTree = treeOid;
        if (path !== '') {
          const parts = path.split('/');
          let cur: string | null = treeOid;
          for (const part of parts) {
            const obj = cur ? repo.objects.get(cur) : undefined;
            if (!obj) { cur = null; break; }
            const e = parseTree(obj.data).find((x) => x.name === part);
            cur = e ? e.oid : null;
          }
          if (!cur) { errJson(res, 404, 'Not Found'); return true; }
          dirTree = cur;
        }
        const dobj = repo.objects.get(dirTree);
        if (!dobj || dobj.type !== 'tree') { errJson(res, 404, 'Not Found'); return true; }
        for (const e of parseTree(dobj.data)) {
          entries.set(e.name, { type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: prefix + e.name, sha: e.oid });
        }
        if (entries.size === 0 && path !== '') { errJson(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, [...entries.values()]); return true;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(bodyBuf);
        if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
        const b = parsed.value ?? {};
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const content = b64dec(String(b.content ?? ''));
        const result = contentCommit(repo, branch, path, content, String(b.message ?? 'Update file'), b.sha !== undefined ? String(b.sha) : undefined);
        sendJson(res, result.status, result.body); return true;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(bodyBuf);
        if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
        const b = parsed.value ?? {};
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const tip = branchTip(repo, branch);
        const flat = tip ? commitTreeFlat(repo, tip) : new Map<string, string>();
        if (!flat.has(path)) { errJson(res, 404, 'Not Found'); return true; }
        if (b.sha !== undefined && String(b.sha).toLowerCase() !== (flat.get(path) ?? '').toLowerCase()) { errJson(res, 409, 'sha does not match'); return true; }
        const next = new Map(flat); next.delete(path);
        const treeOid = treeFromFlat(repo, next);
        const parents = tip && tip !== ZERO ? [tip] : [];
        const commitSha = makeCommit(repo, treeOid, parents, String(b.message ?? 'Delete file'));
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message: b.message ?? 'Delete file' } });
        return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    // labels
    if (head === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const parsed = parseJsonBody(bodyBuf);
        if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
        const name = String(parsed.value.name ?? '');
        if (!name) { errJson(res, 422, 'name is required'); return true; }
        const color = String(parsed.value.color ?? 'ededed');
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { id: 1000 + name.length, node_id: b64url(`Label:${name}`), name, color, description: String(parsed.value.description ?? ''), url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(name)}`, default: false });
        return true;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: 1000 + l.name.length, name: l.name, color: l.color, description: '', url: '' })));
        return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    // issues
    if (head === 'issues') {
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(bodyBuf);
        if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
        const b = parsed.value ?? {};
        const labels: string[] = Array.isArray(b.labels) ? b.labels.map((x: any) => typeof x === 'string' ? x : String(x?.name ?? '')) : [];
        for (const l of labels) if (!repo.labels.has(l)) { errJson(res, 422, `label does not exist: ${l}`); return true; }
        const iss = createIssueRecord(repo, String(b.title ?? ''), String(b.body ?? ''), labels);
        sendJson(res, 201, issueJson(repo, iss)); return true;
      }
      if (tail.length === 1 && method === 'GET') {
        let list = [...repo.issues];
        const state = query.get('state');
        if (state && state !== 'all') list = list.filter((i) => i.state === state);
        const sort = query.get('sort');
        const dir = query.get('direction') ?? 'desc';
        if (sort === 'created') list.sort((a, b) => dir === 'asc' ? a.seq - b.seq : b.seq - a.seq);
        else list.sort((a, b) => a.seq - b.seq);
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '100') || 100));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        const start = (page - 1) * perPage;
        sendJson(res, 200, list.slice(start, start + perPage).map((i) => issueJson(repo, i))); return true;
      }
      if (tail.length >= 2) {
        const num = Number(tail[1]);
        const iss = repo.issues.find((i) => i.number === num);
        if (tail.length === 2 && method === 'GET') {
          if (!iss) { errJson(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, issueJson(repo, iss)); return true;
        }
        if (tail.length === 2 && method === 'PATCH') {
          if (!iss) { errJson(res, 404, 'Not Found'); return true; }
          const parsed = parseJsonBody(bodyBuf);
          if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
          const b = parsed.value ?? {};
          if (typeof b.title === 'string') iss.title = b.title;
          if (typeof b.body === 'string') iss.body = b.body;
          if (b.state === 'closed' || b.state === 'open') { iss.state = b.state; iss.closedAt = b.state === 'closed' ? nowIso() : null; }
          if (Array.isArray(b.labels)) {
            const labels: string[] = b.labels.map((x: any) => typeof x === 'string' ? x : String(x?.name ?? ''));
            for (const l of labels) if (!repo.labels.has(l)) { errJson(res, 422, `label does not exist: ${l}`); return true; }
            iss.labels = labels.map((name) => { const l = repo.labels.get(name); return { name, color: l ? l.color : 'ededed' }; });
          }
          iss.updatedAt = nowIso();
          sendJson(res, 200, issueJson(repo, iss)); return true;
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (!iss) { errJson(res, 404, 'Not Found'); return true; }
          if (method === 'POST') {
            const parsed = parseJsonBody(bodyBuf);
            if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
            const id = repo.nextCommentId++;
            const c = { id, body: String(parsed.value.body ?? ''), user: userObj(), createdAt: nowIso() };
            iss.comments.push(c);
            sendJson(res, 201, { id: c.id, node_id: b64url(`IssueComment:${repo.id}:${iss.number}:${id}`), body: c.body, user: c.user, created_at: c.createdAt, updated_at: c.createdAt, html_url: '', url: '' });
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, iss.comments.map((c) => ({ id: c.id, node_id: b64url(`IssueComment:${repo.id}:${iss.number}:${c.id}`), body: c.body, user: c.user, created_at: c.createdAt, updated_at: c.createdAt, html_url: '', url: '' })));
            return true;
          }
        }
        errJson(res, 404, 'Not Found'); return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    // pulls
    if (head === 'pulls') {
      if (tail.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(bodyBuf);
        if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
        const b = parsed.value ?? {};
        const pr = createPRRecord(repo, String(b.title ?? ''), String(b.body ?? ''), String(b.head ?? ''), String(b.base ?? repo.defaultBranch));
        if (!pr) { errJson(res, 422, 'head or base branch not found'); return true; }
        sendJson(res, 201, prJson(repo, pr)); return true;
      }
      if (tail.length === 1 && method === 'GET') {
        let list = [...repo.prs];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '100') || 100));
        const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
        const start = (page - 1) * perPage;
        sendJson(res, 200, list.slice(start, start + perPage).map((p) => prJson(repo, p))); return true;
      }
      if (tail.length >= 2) {
        const num = Number(tail[1]);
        const pr = repo.prs.find((p) => p.number === num);
        if (tail.length === 2 && method === 'GET') {
          if (!pr) { errJson(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, prJson(repo, pr)); return true;
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          if (!pr) { errJson(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, pr.files.map((f) => ({ sha: '', filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '' })));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          if (!pr) { errJson(res, 404, 'Not Found'); return true; }
          const parsed = parseJsonBody(bodyBuf);
          if (!parsed.ok) { errJson(res, 400, 'malformed JSON body'); return true; }
          const result = doMerge(repo, pr);
          if (!result.ok) { errJson(res, result.status ?? 405, 'merge conflict'); return true; }
          sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
          return true;
        }
        errJson(res, 404, 'Not Found'); return true;
      }
      errJson(res, 404, 'Not Found'); return true;
    }
    errJson(res, 404, 'Not Found'); return true;
  }
  // unknown /api/v3 route
  if (!requireAuth(req, res)) return true;
  errJson(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- pkt-line
function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
function pktLines(buf: Buffer, stopAtFlush = false): { lines: string[]; rest: Buffer; ok: boolean } {
  const lines: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { lines, rest: buf.subarray(i), ok: false };
    const len = parseInt(hex, 16);
    if (len === 0) { i += 4; lines.push('\0FLUSH'); if (stopAtFlush) return { lines, rest: buf.subarray(i), ok: true }; continue; }
    if (len === 1) { i += 4; lines.push('\0DELIM'); continue; }
    if (len === 2) { i += 4; lines.push('\0END'); continue; }
    if (i + len > buf.length) return { lines, rest: buf.subarray(i), ok: false };
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  return { lines, rest: buf.subarray(i), ok: true };
}
function sideband(data: Buffer, band = 1): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += 65515) {
    const chunk = data.subarray(i, Math.min(data.length, i + 65515));
    out.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pkt(Buffer.from([band])));
  return Buffer.concat(out);
}
// ---------------------------------------------------------------- packfile
function encodeVarintSize(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let s = size;
  let first = ((type & 7) << 4) | (s & 0x0f);
  s >>= 4;
  if (s > 0) first |= 0x80;
  bytes.push(first);
  while (s > 0) { let b = s & 0x7f; s >>= 7; if (s > 0) b |= 0x80; bytes.push(b); }
  return Buffer.from(bytes);
}
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
function writePack(repo: Repo, oids: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const ver = Buffer.alloc(4); ver.writeUInt32BE(2, 0); parts.push(ver);
  const cnt = Buffer.alloc(4); cnt.writeUInt32BE(oids.length, 0); parts.push(cnt);
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    const code = TYPE_CODE[obj.type] ?? 0;
    parts.push(encodeVarintSize(code, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1hex(body), 'hex')]);
}
function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0; let shift = 0; let i = off;
  while (i < buf.length) { const b = buf[i]; value |= (b & 0x7f) << shift; shift += 7; i += 1; if (!(b & 0x80)) break; }
  return { value, next: i };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const src = readVarint(delta, off); off = src.next;
  const tgt = readVarint(delta, off); off = tgt.next;
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let k = 0; k < 4; k++) if (op & (1 << k)) { cpOff |= delta[off++] << (8 * k); }
      for (let k = 0; k < 3; k++) if (op & (0x10 << k)) { cpSize |= delta[off++] << (8 * k); }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(cpOff, cpOff + cpSize)); produced += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op)); produced += op; off += op;
    } else throw new Error('delta opcode 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== tgt.value) throw new Error('delta target size mismatch');
  return result;
}
function readPack(repo: Repo, pack: Buffer): Map<string, Obj> {
  const out = new Map<string, Obj>();
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  let off = 12;
  const byOffset = new Map<number, string>();
  const pending: { offset: number; type: number; data: Buffer; baseOid?: string; baseOffset?: number }[] = [];
  for (let idx = 0; idx < count; idx++) {
    const entryOff = off;
    const first = pack[off++];
    const type = (first >> 4) & 7;
    let size = first & 0x0f;
    let shift = 4;
    while (first & 0x80 || (pack[off - 1] & 0x80)) {
      // continuation handling: loop while previous byte had bit 7
      const b = pack[off++];
      size |= (b & 0x7f) << shift; shift += 7;
      if (!(b & 0x80)) break;
    }
    let baseOid: string | undefined; let baseOffset: number | undefined;
    if (type === 6) {
      let byte = pack[off++];
      let v = byte & 0x7f;
      while (byte & 0x80) { byte = pack[off++]; v = ((v + 1) << 7) | (byte & 0x7f); }
      baseOffset = entryOff - v;
    } else if (type === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20;
    }
    // inflate zlib stream: inflateSync needs exact slice; find end by trying lengths is slow.
    // Use inflateSync on the remainder and track consumed via a streaming approach: use zlib inflate with chunk?
    // Simpler: use Node's inflateSync on a slice grown until it succeeds and size matches.
    let data: Buffer | null = null; let consumed = 0;
    // binary search the zlib stream end using inflateSync trial on prefixes (pack data is small in tests)
    let lo = 1; let hi = pack.length - off;
    // find minimal prefix that inflates to `size` bytes
    let found = -1;
    let l = 1; let r = hi;
    while (l <= r) {
      const mid = (l + r) >> 1;
      try { const d = inflateSync(pack.subarray(off, off + mid)); if (d.length === size) { found = mid; r = mid - 1; } else if (d.length < size) l = mid + 1; else r = mid - 1; } catch { l = mid + 1; }
    }
    if (found < 0) throw new Error('pack inflate failed');
    data = inflateSync(pack.subarray(off, off + found));
    consumed = found;
    off += consumed;
    pending.push({ offset: entryOff, type, data, baseOid, baseOffset });
    byOffset.set(entryOff, '');
  }
  // resolve entries (plain first, then deltas)
  const resolved = new Map<string, Obj>();
  const resolveOne = (entry: { offset: number; type: number; data: Buffer; baseOid?: string; baseOffset?: number }, depth: number): Obj => {
    if (depth > 100) throw new Error('delta cycle');
    if (entry.type === 6 || entry.type === 7) {
      let baseObj: Obj | undefined;
      if (entry.baseOid) {
        const oid = entry.baseOid;
        baseObj = resolved.get(oid) ?? out.get(oid) ?? repo.objects.get(oid);
        if (!baseObj) {
          const be = pending.find((p) => hashObject(typeName(p.type), p.data) === oid);
          if (be) baseObj = resolveOne(be, depth + 1);
        }
      } else if (entry.baseOffset !== undefined) {
        const be = pending.find((p) => p.offset === entry.baseOffset);
        if (!be) throw new Error('ofs-delta base missing');
        baseObj = resolveOne(be, depth + 1);
      }
      if (!baseObj) throw new Error('delta base missing');
      const data = applyDelta(baseObj.data, entry.data);
      return { type: baseObj.type, data };
    }
    return { type: typeName(entry.type), data: entry.data };
  };
  for (const e of pending) {
    const obj = resolveOne(e, 0);
    const oid = hashObject(obj.type, obj.data);
    out.set(oid, obj);
    byOffset.set(e.offset, oid);
  }
  return out;
}
function typeName(code: number): string { return code === 1 ? 'commit' : code === 2 ? 'tree' : code === 3 ? 'blob' : code === 4 ? 'tag' : 'blob'; }
// ---------------------------------------------------------------- git HTTP
function gitCaps(repo: Repo, service: string): string {
  const head = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const sym = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (service === 'git-receive-pack') return `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=kara-forge/1.0 ${sym}`;
  return `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=kara-forge/1.0 ${sym}`;
}
function v0Advert(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`)];
  const refs = [...repo.refs.entries()].sort();
  const caps = gitCaps(repo, service);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([ref, oid], i) => {
      parts.push(pkt(i === 0 ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = parseTag(obj.data).object;
        parts.push(pkt(`${peeled} ${ref}^{}\n`));
      }
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function v2Advert(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=kara-forge/1.0\n'),
    pkt('fetch=shallow filter\n'),
    pkt('ls-refs=unborn\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}
function lsRefsReply(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  const parts: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort();
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const match = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (symrefs && match('HEAD') && mainTip) parts.push(pkt(`${mainTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  for (const [ref, oid] of refs) {
    if (!match(ref)) continue;
    const obj = repo.objects.get(oid);
    let line = `${oid} ${ref}`;
    if (peel && obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
interface FetchReq { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null; done: boolean }
function reachableShallow(repo: Repo, tips: string[], boundaries: string[]): Set<string> {
  // Reachable closure, but a shallow-boundary commit contributes itself + its tree,
  // never its parents (the client does not hold them).
  const bound = new Set(boundaries);
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!cur || cur === ZERO || out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    out.add(cur);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!bound.has(cur)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}
function computeFetch(repo: Repo, f: FetchReq): { oids: string[]; shallowOut: string[]; unshallowOut: string[]; ack: string | null } {
  const haveSet = new Set<string>();
  for (const h of f.haves) for (const o of reachableShallow(repo, [h], f.shallow)) haveSet.add(o);
  let ack: string | null = null;
  for (const h of f.haves) if (f.wants.some((w) => isAncestor(repo, h, w) || h === w)) { ack = h; break; }
  if (f.deepen === null) {
    const wantReach = new Set<string>();
    for (const w of f.wants) for (const o of reachable(repo, [w])) wantReach.add(o);
    const oids = [...wantReach].filter((o) => !haveSet.has(o));
    return { oids, shallowOut: [], unshallowOut: [], ack };
  }
  // shallow / deepen
  const gen = new Map<string, number>();
  const queue: { oid: string; g: number }[] = f.wants.map((w) => ({ oid: w, g: 0 }));
  while (queue.length) {
    const { oid, g } = queue.shift()!;
    if (gen.has(oid)) continue;
    gen.set(oid, g);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, g: g + 1 });
    else if (obj && obj.type === 'tag') queue.push({ oid: parseTag(obj.data).object, g: g + 1 });
  }
  const sendCommits = new Set<string>();
  for (const [oid, g] of gen) {
    if (g < f.deepen && !haveSet.has(oid)) sendCommits.add(oid);
  }
  const send = new Set<string>();
  for (const c of sendCommits) {
    const obj = repo.objects.get(c);
    if (!obj) continue;
    if (obj.type === 'commit') {
      send.add(c);
      const t = parseCommit(obj.data).tree;
      for (const o of reachable(repo, [t])) if (!haveSet.has(o)) send.add(o);
    } else if (obj.type === 'tag') {
      send.add(c);
      for (const o of reachable(repo, [parseTag(obj.data).object])) if (!haveSet.has(o)) send.add(o);
    }
  }
  const shallowOut: string[] = [];
  for (const c of sendCommits) {
    const obj = repo.objects.get(c);
    if (obj && obj.type === 'commit') {
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.some((p) => !sendCommits.has(p) && !haveSet.has(p))) shallowOut.push(c);
      if (parents.length === 0) { /* root commit is not a boundary */ }
    }
  }
  // depth-1 fresh clone: tips have parents but gen==deepen-1==0 -> they are boundaries (handled above)
  const unshallowOut: string[] = [];
  for (const s of f.shallow) {
    if (f.wants.includes(s) && (f.deepen ?? 0) > 1) unshallowOut.push(s);
  }
  return { oids: [...send].sort(), shallowOut, unshallowOut, ack };
}
async function handleGit(req: IncomingMessage, res: ServerResponse, seg: string[], query: URLSearchParams, bodyBuf: Buffer): Promise<boolean> {
  // seg: [owner, '<repo>.git', ...]
  if (seg.length < 2 || !seg[1].endsWith('.git')) return false;
  const owner = decodePath(seg[0]);
  const repoName = decodePath(seg[1].slice(0, -4));
  const method = req.method ?? 'GET';
  if (!requireAuth(req, res)) return true;
  if (owner !== VIEWER.login) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const repo = getRepo(owner, repoName);
  const tail = seg.slice(2);
  // info/refs
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service') ?? '';
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      if (wantV2) { sendRaw(res, 200, v2Advert(), 'application/x-git-upload-pack-advertisement'); return true; }
      sendRaw(res, 200, v0Advert(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement'); return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advert(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement'); return true;
    }
    sendJson(res, 404, { message: 'Not Found' }); return true;
  }
  // upload-pack
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const parsed = pktLines(bodyBuf);
    if (!parsed.ok || parsed.lines.length === 0) { errJson(res, 400, 'malformed pkt-line'); return true; }
    const first = parsed.lines[0];
    if (first.startsWith('command=ls-refs') && wantV2) {
      const prefixes: string[] = [];
      let peel = true; let symrefs = true;
      for (const l of parsed.lines.slice(1)) {
        if (l === '\0DELIM' || l === '\0FLUSH' || l === '\0END') continue;
        const t = l.trim();
        if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
        else if (t === 'peel') peel = true;
        else if (t === 'symrefs') symrefs = true;
      }
      sendRaw(res, 200, lsRefsReply(repo, prefixes, peel, symrefs), 'application/x-git-upload-pack-result');
      return true;
    }
    // fetch (v2 or v0)
    const f: FetchReq = { wants: [], haves: [], shallow: [], deepen: null, done: false };
    if (wantV2 && first.startsWith('command=fetch')) {
      for (const l of parsed.lines.slice(1)) {
        if (l === '\0DELIM' || l === '\0FLUSH' || l === '\0END') continue;
        const t = l.trim();
        if (t.startsWith('want ')) f.wants.push(t.slice(5).trim());
        else if (t.startsWith('have ')) f.haves.push(t.slice(5).trim());
        else if (t.startsWith('shallow ')) f.shallow.push(t.slice(8).trim());
        else if (t.startsWith('deepen ')) f.deepen = Number(t.slice(7).trim());
        else if (t === 'done') f.done = true;
      }
    } else if (!wantV2) {
      // v0: section1 until flush, then section2
      let section = 1;
      for (const l of parsed.lines) {
        if (l === '\0FLUSH') { section += 1; continue; }
        const t = l.trim();
        if (section === 1) {
          if (t.startsWith('want ')) { const parts = t.split(/\s+/); f.wants.push(parts[1]); }
          else if (t.startsWith('shallow ')) f.shallow.push(t.slice(8).trim());
          else if (t.startsWith('deepen ')) f.deepen = Number(t.slice(7).trim());
        } else {
          if (t.startsWith('have ')) f.haves.push(t.slice(5).trim());
          else if (t === 'done') f.done = true;
        }
      }
      if (f.wants.length === 0 && !first.startsWith('want ')) { errJson(res, 400, 'malformed fetch request'); return true; }
    } else {
      errJson(res, 400, 'unknown upload-pack command'); return true;
    }
    const result = computeFetch(repo, f);
    const pack = writePack(repo, result.oids);
    if (wantV2) {
      const parts: Buffer[] = [];
      parts.push(pkt('acknowledgments\n'));
      parts.push(pkt(result.ack ? `ACK ${result.ack}\nready\n` : 'NAK\n'));
      parts.push(FLUSH);
      if (f.deepen !== null || result.shallowOut.length || result.unshallowOut.length) {
        parts.push(pkt('shallow-info\n'));
        for (const s of result.shallowOut) parts.push(pkt(`shallow ${s}\n`));
        for (const s of result.unshallowOut) parts.push(pkt(`unshallow ${s}\n`));
        parts.push(FLUSH);
      }
      parts.push(pkt('packfile\n'));
      parts.push(sideband(pack, 1));
      parts.push(FLUSH);
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return true;
    }
    // v0 response
    const parts: Buffer[] = [];
    if (result.ack) parts.push(pkt(`ACK ${result.ack}\n`)); else parts.push(pkt('NAK\n'));
    for (const s of result.shallowOut) parts.push(pkt(`shallow ${s}\n`));
    for (const s of result.unshallowOut) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(sideband(pack, 1));
    parts.push(FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return true;
  }
  // receive-pack
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const parsed = pktLines(bodyBuf, true);
    if (!parsed.ok || parsed.lines.length === 0) { errJson(res, 400, 'malformed pkt-line'); return true; }
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    let sideband64 = false;
    let flushIdx = -1;
    for (let i = 0; i < parsed.lines.length; i++) {
      const l = parsed.lines[i];
      if (l === '\0FLUSH') { flushIdx = i; break; }
      const clean = l.replace(/\n$/, '');
      const nul = clean.indexOf('\0');
      let cmdPart = clean; let caps = '';
      if (nul >= 0) { cmdPart = clean.slice(0, nul); caps = clean.slice(nul + 1); }
      if (i === 0 && caps.includes('side-band-64k')) sideband64 = true;
      const m = cmdPart.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/i);
      if (!m) { errJson(res, 400, 'malformed receive-pack command'); return true; }
      commands.push({ oldOid: m[1].toLowerCase(), newOid: m[2].toLowerCase(), ref: m[3] });
    }
    if (flushIdx < 0) { errJson(res, 400, 'missing flush in receive-pack'); return true; }
    // pack bytes start after the flush packet in the raw body: recompute offset
    let rawOff = 0; let seenFlush = false;
    while (rawOff + 4 <= bodyBuf.length) {
      const hex = bodyBuf.subarray(rawOff, rawOff + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      const len = parseInt(hex, 16);
      if (len === 0) { rawOff += 4; seenFlush = true; break; }
      if (len < 4) break;
      rawOff += len;
    }
    const packBytes = seenFlush ? bodyBuf.subarray(rawOff) : Buffer.alloc(0);
    let unpackOk = true;
    if (packBytes.length > 0) {
      try {
        const objs = readPack(repo, packBytes);
        for (const [oid, obj] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      } catch { unpackOk = false; }
    }
    const reportLines: string[] = [];
    reportLines.push(unpackOk ? 'unpack ok' : 'unpack error');
    for (const cmd of commands) {
      const cur = repo.refs.get(cmd.ref);
      let ok = false; let reason = 'non-fast-forward';
      if (cmd.newOid === ZERO) {
        // delete
        if (cur !== undefined && cur.toLowerCase() === cmd.oldOid) ok = true; else reason = 'old value does not match';
      } else if (cmd.oldOid === ZERO) {
        if (cur === undefined) ok = true; else reason = 'ref already exists';
      } else {
        if (cur !== undefined && cur.toLowerCase() === cmd.oldOid && isAncestor(repo, cmd.oldOid, cmd.newOid)) ok = true;
        else if (cur === undefined) { reason = 'ref does not exist'; }
      }
      if (ok) {
        if (cmd.newOid === ZERO) repo.refs.delete(cmd.ref);
        else repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      } else {
        reportLines.push(`ng ${cmd.ref} ${reason}`);
      }
    }
    const reportText = reportLines.map((l) => pkt(`${l}\n`));
    const reportBuf = Buffer.concat(reportText);
    const body = sideband64 ? Buffer.concat([sideband(reportBuf, 1), FLUSH]) : Buffer.concat([reportBuf, FLUSH]);
    sendRaw(res, 200, body, 'application/x-git-receive-pack-result');
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// ---------------------------------------------------------------- GraphQL
// Minimal GraphQL executor for the fixed documents the suite sends.
interface GField { alias: string; name: string; args: Record<string, any>; children: GField[]; fragment?: string }
function gqlParse(query: string): { op: string; name: string; fields: GField[] } {
  let i = 0;
  const s = query;
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const readName = (): string => { skipWs(); let st = i; while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++; return s.slice(st, i); };
  const readValue = (): any => {
    skipWs();
    if (s[i] === '$') { i++; return { $var: readName() }; }
    if (s[i] === '"') { i++; let out = ''; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') { i++; out += s[i] ?? ''; i++; } else { out += s[i]; i++; } } i++; return out; }
    if (s[i] === '{') { i++; const obj: Record<string, any> = {}; while (true) { skipWs(); if (s[i] === '}') { i++; break; } const k = readName(); skipWs(); if (s[i] === ':') i++; obj[k] = readValue(); skipWs(); if (s[i] === ',') i++; } return obj; }
    if (s[i] === '[') { i++; const arr: any[] = []; while (true) { skipWs(); if (s[i] === ']') { i++; break; } arr.push(readValue()); skipWs(); if (s[i] === ',') i++; } return arr; }
    if (s[i] === '-' || /[0-9]/.test(s[i])) { let st = i; while (i < s.length && /[0-9.\-eE]/.test(s[i])) i++; return Number(s.slice(st, i)); }
    const w = readName();
    if (w === 'true') return true; if (w === 'false') return false; if (w === 'null') return null;
    return { $enum: w };
  };
  const parseArgs = (): Record<string, any> => {
    const args: Record<string, any> = {};
    skipWs();
    if (s[i] !== '(') return args;
    i++;
    while (true) { skipWs(); if (s[i] === ')') { i++; break; } const k = readName(); skipWs(); if (s[i] === ':') i++; args[k] = readValue(); skipWs(); if (s[i] === ',') i++; }
    return args;
  };
  const parseSelection = (): GField[] => {
    const fields: GField[] = [];
    skipWs();
    if (s[i] !== '{') return fields;
    i++;
    while (true) {
      skipWs();
      if (i >= s.length) break;
      if (s[i] === '}') { i++; break; }
      if (s.startsWith('...', i)) {
        i += 3; skipWs();
        if (s.startsWith('on', i)) { i += 2; const typeName = readName(); const children = parseSelection(); fields.push({ alias: '', name: '__fragment', args: {}, children, fragment: typeName }); }
        else { readName(); }
        continue;
      }
      const first = readName();
      skipWs();
      let alias = first; let name = first;
      if (s[i] === ':') { i++; name = readName(); }
      const args = parseArgs();
      const children = parseSelection();
      fields.push({ alias, name, args, children });
    }
    return fields;
  };
  skipWs();
  let op = 'query'; let name = '';
  if (s.startsWith('query', i) || s.startsWith('mutation', i)) {
    op = s.startsWith('query', i) ? 'query' : 'mutation';
    i += op.length;
    skipWs();
    if (i < s.length && /[A-Za-z_]/.test(s[i])) name = readName();
    // variable definitions (...) - skip balanced parens
    skipWs();
    if (s[i] === '(') { let depth = 0; while (i < s.length) { if (s[i] === '(') depth++; else if (s[i] === ')') { depth--; i++; if (depth === 0) break; continue; } i++; } }
  }
  const fields = parseSelection();
  return { op, name, fields };
}
function resolveVars(v: any, variables: Record<string, any>): any {
  if (v && typeof v === 'object' && '$var' in v) return variables[(v as any).$var];
  if (v && typeof v === 'object' && '$enum' in v) return (v as any).$enum;
  if (Array.isArray(v)) return v.map((x) => resolveVars(x, variables));
  if (v && typeof v === 'object') { const o: Record<string, any> = {}; for (const k of Object.keys(v)) o[k] = resolveVars(v[k], variables); return o; }
  return v;
}
function resolveArgs(f: GField, variables: Record<string, any>): Record<string, any> {
  const o: Record<string, any> = {};
  for (const k of Object.keys(f.args)) o[k] = resolveVars(f.args[k], variables);
  return o;
}
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  IssueComment: ['id', 'body'],
  CommentEdge: ['node'],
  Ref: ['name'],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};
function gqlState(state: string, merged: boolean): string { return merged ? 'MERGED' : state === 'open' ? 'OPEN' : 'CLOSED'; }
function decodeGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
  try {
    const s = Buffer.from(id, 'base64url').toString('utf8');
    const parts = s.split(':');
    if (parts.length < 3) return null;
    return { kind: parts[0], repoId: Number(parts[1]), num: Number(parts[2]) };
  } catch { return null; }
}
function repoById(id: number): Repo | undefined { return [...repos.values()].find((r) => r.id === id); }
function issueObj(r: Repo, iss: Issue, fields: GField[], variables: Record<string, any>): any {
  const out: any = {};
  for (const f of fields) {
    if (f.name === 'id') out[f.alias] = globalId('Issue', r, iss.number);
    else if (f.name === 'number') out[f.alias] = iss.number;
    else if (f.name === 'title') out[f.alias] = iss.title;
    else if (f.name === 'state') out[f.alias] = iss.state === 'open' ? 'OPEN' : 'CLOSED';
    else if (f.name === 'body') out[f.alias] = iss.body;
    else if (f.name === 'createdAt') out[f.alias] = iss.createdAt;
    else if (f.name === 'updatedAt') out[f.alias] = iss.updatedAt;
  }
  return out;
}
function prObj(r: Repo, p: PR, fields: GField[], variables: Record<string, any>): any {
  const out: any = {};
  for (const f of fields) {
    if (f.name === 'id') out[f.alias] = globalId('PullRequest', r, p.number);
    else if (f.name === 'number') out[f.alias] = p.number;
    else if (f.name === 'title') out[f.alias] = p.title;
    else if (f.name === 'state') out[f.alias] = gqlState(p.state, p.merged);
    else if (f.name === 'body') out[f.alias] = p.body;
    else if (f.name === 'headRefName') out[f.alias] = p.headRef;
    else if (f.name === 'baseRefName') out[f.alias] = p.baseRef;
    else if (f.name === 'mergeable') out[f.alias] = prMergeable(r, p) ? 'MERGEABLE' : 'CONFLICTING';
    else if (f.name === 'merged') out[f.alias] = p.merged;
    else if (f.name === 'files') {
      const args = resolveArgs(f, variables);
      const first = typeof args.first === 'number' ? args.first : 10;
      const nodesField = f.children.find((c) => c.name === 'nodes');
      const nodeFields = nodesField?.children ?? f.children;
      out[f.alias] = { nodes: p.files.slice(0, first).map((x) => { const node: any = {}; for (const cf of nodeFields) if (cf.name === 'path') node[cf.alias] = x.filename; else if (cf.name === 'filename') node[cf.alias] = x.filename; else if (cf.name === 'status') node[cf.alias] = x.status; return node; }) };
    }
  }
  return out;
}
function repoObj(r: Repo, fields: GField[], variables: Record<string, any>): any {
  const out: any = {};
  for (const f of fields) {
    const args = resolveArgs(f, variables);
    if (f.name === 'id') out[f.alias] = repoGlobalId(r);
    else if (f.name === 'databaseId') out[f.alias] = r.id;
    else if (f.name === 'name') out[f.alias] = r.name;
    else if (f.name === 'nameWithOwner') out[f.alias] = `${r.owner}/${r.name}`;
    else if (f.name === 'owner') { const o: any = {}; for (const cf of f.children) if (cf.name === 'login') o[cf.alias] = r.owner; out[f.alias] = o; }
    else if (f.name === 'defaultBranchRef') out[f.alias] = { name: r.defaultBranch };
    else if (f.name === 'viewerPermission') out[f.alias] = 'ADMIN';
    else if (f.name === 'hasIssuesEnabled') out[f.alias] = true;
    else if (f.name === 'issue') {
      const iss = r.issues.find((i) => i.number === args.number);
      out[f.alias] = iss ? issueObj(r, iss, f.children, variables) : null;
    } else if (f.name === 'issues') {
      let list = [...r.issues];
      if (Array.isArray(args.states) && args.states.length) {
        const want = new Set(args.states.map((s: string) => String(s).toLowerCase()));
        list = list.filter((i) => want.has(i.state));
      }
      if (args.orderBy && args.orderBy.field === 'CREATED_AT') {
        list.sort((a, b) => args.orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq);
      } else list.sort((a, b) => a.seq - b.seq);
      // cursor pagination
      let startIdx = 0;
      if (typeof args.after === 'string' && args.after) {
        try { const dec = Buffer.from(args.after, 'base64url').toString('utf8'); const n = Number(dec.split(':')[1]); const idx = list.findIndex((i) => i.number === n); if (idx >= 0) startIdx = idx + 1; } catch { /* ignore */ }
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(startIdx, startIdx + first);
      const hasNext = startIdx + first < list.length;
      const endCursor = page.length ? b64url(`cursor:${page[page.length - 1].number}`) : null;
      out[f.alias] = { nodes: page.map((i) => issueObj(r, i, f.children.find((c) => c.name === 'nodes')?.children ?? [], variables)), pageInfo: { hasNextPage: hasNext, endCursor } };
      // children may include pageInfo directly; handle generic
      const pageInfoField = f.children.find((c) => c.name === 'pageInfo');
      if (pageInfoField) { const pi: any = {}; for (const cf of pageInfoField.children) { if (cf.name === 'hasNextPage') pi[cf.alias] = hasNext; else if (cf.name === 'endCursor') pi[cf.alias] = endCursor; } out[f.alias].pageInfo = pi; }
    } else if (f.name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : r.prs.length;
      const nodesField = f.children.find((c) => c.name === 'nodes');
      out[f.alias] = { nodes: r.prs.slice(0, first).map((p) => prObj(r, p, nodesField?.children ?? [], variables)) };
    } else if (f.name === 'pullRequest') {
      const p = r.prs.find((x) => x.number === args.number);
      out[f.alias] = p ? prObj(r, p, f.children, variables) : null;
    }
  }
  return out;
}
function validateFields(fields: GField[], typeName: string, errors: { message: string }[]): void {
  const allowed = TYPE_FIELDS[typeName];
  if (!allowed) return;
  for (const f of fields) {
    if (f.name === '__fragment') { validateFields(f.children, f.fragment ?? typeName, errors); continue; }
    if (f.name === '__typename') continue;
    if (!allowed.includes(f.name)) errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
    else if (f.children.length) {
      const childType = f.name === 'owner' ? 'User' : f.name === 'issue' || f.name === 'issues' ? 'Issue' : f.name === 'pullRequest' || f.name === 'pullRequests' ? 'PullRequest' : f.name === 'nodes' ? (typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile') : f.name === 'defaultBranchRef' ? 'Ref' : f.name === 'files' ? 'PullRequestChangedFileConnection' : f.name === 'node' ? 'IssueComment' : '';
      if (childType && TYPE_FIELDS[childType]) {
        // nodes children are the element type
        if (f.name === 'nodes') validateFields(f.children, childType, errors);
        else if (f.name === 'issues' || f.name === 'pullRequests' || f.name === 'files') {
          const nodes = f.children.find((c) => c.name === 'nodes');
          if (nodes) validateFields(nodes.children, childType === 'IssueConnection' ? 'Issue' : childType === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile', errors);
          const pi = f.children.find((c) => c.name === 'pageInfo');
          if (pi) { for (const cf of pi.children) if (!['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'].includes(cf.name)) errors.push({ message: `Cannot query field "${cf.name}" on type "PageInfo".` }); }
        } else validateFields(f.children, childType, errors);
      }
    }
  }
}
function executeGraphQL(query: string, variables: Record<string, any>): { data: any; errors?: { message: string }[] } {
  let parsed: { op: string; name: string; fields: GField[] };
  try { parsed = gqlParse(query); } catch (e: any) { return { data: null, errors: [{ message: String(e?.message ?? e) }] }; }
  const errors: { message: string }[] = [];
  const data: any = {};
  for (const f of parsed.fields) {
    if (f.name === '__type') {
      const args = resolveArgs(f, variables);
      const typeName = String(args.name ?? '');
      const fields = TYPE_FIELDS[typeName];
      const enums = TYPE_ENUMS[typeName];
      const out: any = { name: typeName };
      for (const cf of f.children) {
        if (cf.name === 'fields') out[cf.alias] = fields ? fields.map((n) => ({ name: n })) : [];
        else if (cf.name === 'enumValues') out[cf.alias] = enums ? enums.map((n) => ({ name: n })) : [];
        else if (cf.name === 'name') out[cf.alias] = typeName;
        else if (cf.name === 'kind') out[cf.alias] = enums ? 'ENUM' : 'OBJECT';
      }
      data[f.alias] = fields || enums ? out : null;
      continue;
    }
    if (parsed.op === 'query' && f.name === 'viewer') {
      // validate viewer fields
      for (const cf of f.children) if (cf.name !== 'login' && cf.name !== 'id') errors.push({ message: `Cannot query field "${cf.name}" on type "Viewer".` });
      if (errors.length) continue;
      const o: any = {};
      for (const cf of f.children) if (cf.name === 'login') o[cf.alias] = VIEWER.login; else if (cf.name === 'id') o[cf.alias] = b64url(`User:${VIEWER.id}`);
      data[f.alias] = o;
      continue;
    }
    if (parsed.op === 'query' && f.name === 'repository') {
      const args = resolveArgs(f, variables);
      const r = args.owner === VIEWER.login ? getRepo(String(args.owner), String(args.name)) : undefined;
      if (!r) { data[f.alias] = null; continue; }
      validateFields(f.children, 'Repository', errors);
      if (errors.length) continue;
      data[f.alias] = repoObj(r, f.children, variables);
      continue;
    }
    if (parsed.op === 'query' && f.name === 'node') {
      const args = resolveArgs(f, variables);
      const dec = decodeGlobalId(String(args.id ?? ''));
      let node: any = null;
      if (dec && dec.kind === 'Repository') {
        const r = repoById(dec.repoId);
        if (r) {
          node = { id: repoGlobalId(r) };
          for (const cf of f.children) {
            if (cf.name === '__fragment' && cf.fragment === 'Repository') {
              for (const sf of cf.children) { if (sf.name === 'name') node[sf.alias] = r.name; else if (sf.name === 'nameWithOwner') node[sf.alias] = `${r.owner}/${r.name}`; else if (sf.name === 'id') node[sf.alias] = repoGlobalId(r); }
            } else if (cf.name === 'id') node[cf.alias] = repoGlobalId(r);
          }
        }
      }
      data[f.alias] = node;
      continue;
    }
    if (parsed.op === 'mutation' && f.name === 'createIssue') {
      const args = resolveArgs(f, variables);
      const input = args.input ?? {};
      const dec = decodeGlobalId(String(input.repositoryId ?? ''));
      const r = dec ? repoById(dec.repoId) : undefined;
      if (!r) { errors.push({ message: 'repository not found' }); continue; }
      const iss = createIssueRecord(r, String(input.title ?? ''), String(input.body ?? ''), []);
      const o: any = {};
      for (const cf of f.children) if (cf.name === 'issue') { const io: any = {}; for (const sf of cf.children) { if (sf.name === 'number') io[sf.alias] = iss.number; else if (sf.name === 'id') io[sf.alias] = globalId('Issue', r, iss.number); else if (sf.name === 'title') io[sf.alias] = iss.title; else if (sf.name === 'state') io[sf.alias] = 'OPEN'; } o[cf.alias] = io; }
      data[f.alias] = o;
      continue;
    }
    if (parsed.op === 'mutation' && f.name === 'closeIssue') {
      const args = resolveArgs(f, variables);
      const input = args.input ?? {};
      const dec = decodeGlobalId(String(input.issueId ?? ''));
      let found: { r: Repo; iss: Issue } | null = null;
      if (dec && dec.kind === 'Issue') { const r = repoById(dec.repoId); const iss = r?.issues.find((i) => i.number === dec.num); if (r && iss) found = { r, iss }; }
      if (!found) { errors.push({ message: 'issue not found' }); continue; }
      found.iss.state = 'closed'; found.iss.closedAt = nowIso(); found.iss.updatedAt = nowIso();
      const o: any = {};
      for (const cf of f.children) if (cf.name === 'issue') { const io: any = {}; for (const sf of cf.children) { if (sf.name === 'number') io[sf.alias] = found.iss.number; else if (sf.name === 'id') io[sf.alias] = globalId('Issue', found.r, found.iss.number); else if (sf.name === 'state') io[sf.alias] = 'CLOSED'; } o[cf.alias] = io; }
      data[f.alias] = o;
      continue;
    }
    if (parsed.op === 'mutation' && f.name === 'createPullRequest') {
      const args = resolveArgs(f, variables);
      const input = args.input ?? {};
      const dec = decodeGlobalId(String(input.repositoryId ?? ''));
      const r = dec ? repoById(dec.repoId) : undefined;
      if (!r) { errors.push({ message: 'repository not found' }); continue; }
      const pr = createPRRecord(r, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? 'main'));
      if (!pr) { errors.push({ message: 'head or base branch not found' }); continue; }
      const o: any = {};
      for (const cf of f.children) if (cf.name === 'pullRequest') { const po: any = {}; for (const sf of cf.children) { if (sf.name === 'number') po[sf.alias] = pr.number; else if (sf.name === 'id') po[sf.alias] = globalId('PullRequest', r, pr.number); else if (sf.name === 'state') po[sf.alias] = 'OPEN'; else if (sf.name === 'headRefName') po[sf.alias] = pr.headRef; else if (sf.name === 'baseRefName') po[sf.alias] = pr.baseRef; } o[cf.alias] = po; }
      data[f.alias] = o;
      continue;
    }
    if (parsed.op === 'mutation' && f.name === 'mergePullRequest') {
      const args = resolveArgs(f, variables);
      const input = args.input ?? {};
      const dec = decodeGlobalId(String(input.pullRequestId ?? ''));
      let found: { r: Repo; pr: PR } | null = null;
      if (dec && dec.kind === 'PullRequest') { const r = repoById(dec.repoId); const pr = r?.prs.find((p) => p.number === dec.num); if (r && pr) found = { r, pr }; }
      if (!found) { errors.push({ message: 'pull request not found' }); continue; }
      const result = doMerge(found.r, found.pr);
      if (!result.ok) { errors.push({ message: 'merge conflict' }); continue; }
      const o: any = {};
      for (const cf of f.children) if (cf.name === 'pullRequest') { const po: any = {}; for (const sf of cf.children) { if (sf.name === 'number') po[sf.alias] = found.pr.number; else if (sf.name === 'id') po[sf.alias] = globalId('PullRequest', found.r, found.pr.number); else if (sf.name === 'merged') po[sf.alias] = true; else if (sf.name === 'state') po[sf.alias] = 'MERGED'; } o[cf.alias] = po; }
      data[f.alias] = o;
      continue;
    }
    if (parsed.op === 'mutation' && f.name === 'addComment') {
      const args = resolveArgs(f, variables);
      const input = args.input ?? {};
      const dec = decodeGlobalId(String(input.subjectId ?? ''));
      let found: { r: Repo; iss: Issue } | null = null;
      if (dec && dec.kind === 'Issue') { const r = repoById(dec.repoId); const iss = r?.issues.find((i) => i.number === dec.num); if (r && iss) found = { r, iss }; }
      if (!found) { errors.push({ message: 'subject not found' }); continue; }
      const id = found.r.nextCommentId++;
      const c = { id, body: String(input.body ?? ''), user: userObj(), createdAt: nowIso() };
      found.iss.comments.push(c);
      const o: any = {};
      for (const cf of f.children) if (cf.name === 'commentEdge') { const eo: any = {}; for (const sf of cf.children) if (sf.name === 'node') { const no: any = {}; for (const tf of sf.children) { if (tf.name === 'id') no[tf.alias] = b64url(`IssueComment:${found.r.id}:${found.iss.number}:${id}`); else if (tf.name === 'body') no[tf.alias] = c.body; } eo[sf.alias] = no; } o[cf.alias] = eo; }
      data[f.alias] = o;
      continue;
    }
    errors.push({ message: `Cannot query field "${f.name}" on type "Query".` });
  }
  if (errors.length) return { data: Object.keys(data).length ? data : null, errors };
  return { data };
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<void> {
  if (!requireAuth(req, res)) return;
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) { sendJson(res, 400, { message: 'malformed JSON body' }); return; }
  const v = parsed.value;
  if (Array.isArray(v)) {
    const out = v.map((op) => {
      if (!op || typeof op.query !== 'string') return { data: null, errors: [{ message: 'invalid operation' }] };
      return executeGraphQL(op.query, op.variables ?? {});
    });
    sendJson(res, 200, out); return;
  }
  if (!v || typeof v.query !== 'string') { sendJson(res, 400, { message: 'query is required' }); return; }
  sendJson(res, 200, executeGraphQL(v.query, v.variables ?? {}));
}

// ---------------------------------------------------------------- MCP
const MCP_TOOLS = [
  { name: 'create_repo', description: 'Create a new repository for the viewer.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, owner: { type: 'string', description: 'Owner login' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function normName(s: string): string { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function findTool(name: string): any {
  const n = normName(name);
  for (const t of MCP_TOOLS) if (normName(t.name) === n) return t;
  for (const t of MCP_TOOLS) if (normName(t.name).endsWith(n) && normName(t.name).length > n.length) return t;
  return null;
}
function toolResult(obj: any): any {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}
function mcpCall(name: string, args: Record<string, any>): { ok: boolean; result?: any; error?: { code: number; message: string } } {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: { code: -32601, message: `unknown tool: ${name}` } };
  const required: string[] = tool.inputSchema.required ?? [];
  for (const r of required) {
    if (args[r] === undefined || args[r] === null || args[r] === '') {
      // synonyms: pull_number may arrive as number, etc.
      if (r === 'pull_number' && (args.number !== undefined || args.pr_number !== undefined)) continue;
      return { ok: false, error: { code: -32602, message: `missing required argument: ${r}` } };
    }
  }
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.repository ?? args.name ?? '');
  if (tool.name === 'create_repo') {
    const nm = String(args.name ?? '');
    if (getRepo(owner, nm)) return { ok: true, result: toolResult({ ...repoJson(getRepo(owner, nm)!), full_name: `${owner}/${nm}` }) };
    const r = createRepoRecord(owner, nm, String(args.description ?? ''), !!args.private);
    return { ok: true, result: toolResult({ ...repoJson(r), full_name: `${owner}/${nm}` }) };
  }
  if (owner !== VIEWER.login) return { ok: false, result: { content: [{ type: 'text', text: JSON.stringify({ message: 'Not Found' }) }], structuredContent: { message: 'Not Found' }, isError: true } };
  const repo = getRepo(owner, repoName);
  if (tool.name === 'get_repo') {
    if (!repo) return { ok: false, result: { content: [{ type: 'text', text: JSON.stringify({ message: 'Not Found' }) }], structuredContent: { message: 'Not Found' }, isError: true } };
    return { ok: true, result: toolResult({ ...repoJson(repo), full_name: `${owner}/${repoName}` }) };
  }
  if (!repo) return { ok: false, result: { content: [{ type: 'text', text: JSON.stringify({ message: 'Not Found' }) }], structuredContent: { message: 'Not Found' }, isError: true } };
  if (tool.name === 'create_issue') {
    const iss = createIssueRecord(repo, String(args.title ?? ''), String(args.body ?? ''), []);
    return { ok: true, result: toolResult({ number: iss.number, id: iss.id, node_id: globalId('Issue', repo, iss.number), title: iss.title, body: iss.body, state: iss.state }) };
  }
  if (tool.name === 'list_issues') {
    let list = [...repo.issues];
    if (typeof args.state === 'string' && args.state && args.state !== 'all') list = list.filter((i) => i.state === args.state);
    const items = list.map((i) => ({ number: i.number, id: i.id, title: i.title, body: i.body, state: i.state }));
    return { ok: true, result: toolResult({ issues: items }) };
  }
  if (tool.name === 'create_pull_request') {
    const pr = createPRRecord(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? 'main'));
    if (!pr) return { ok: false, result: { content: [{ type: 'text', text: 'head or base branch not found' }], isError: true } };
    return { ok: true, result: toolResult({ number: pr.number, id: pr.id, title: pr.title, state: pr.state, head: { ref: pr.headRef, sha: pr.headSha }, base: { ref: pr.baseRef, sha: pr.baseSha } }) };
  }
  if (tool.name === 'merge_pull_request') {
    const num = Number(args.pull_number ?? args.number ?? args.pr_number);
    const pr = repo.prs.find((p) => p.number === num);
    if (!pr) return { ok: false, result: { content: [{ type: 'text', text: 'pull request not found' }], isError: true } };
    const result = doMerge(repo, pr);
    if (!result.ok) return { ok: false, result: { content: [{ type: 'text', text: 'merge conflict' }], isError: true } };
    return { ok: true, result: toolResult({ number: pr.number, merged: true, sha: result.sha }) };
  }
  return { ok: false, error: { code: -32601, message: `unknown tool: ${name}` } };
}
async function handleMcp(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<void> {
  if (!requireAuth(req, res)) return;
  const text = bodyBuf.toString('utf8');
  let v: any;
  try { v = JSON.parse(text); } catch {
    const m = text.match(/"id"\s*:\s*(\d+|"[^"]*")/);
    const id = m ? (m[1].startsWith('"') ? m[1].slice(1, -1) : Number(m[1])) : null;
    sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = v && typeof v === 'object' ? (v.id ?? null) : null;
  const method = v?.method;
  const reply = (payload: any) => sendJson(res, 200, payload);
  if (method === 'server/discover') {
    reply({ jsonrpc: '2.0', id, result: { supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: {} }, serverInfo: { name: 'kara-forge', version: '1.0.0' }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'kara-forge', version: '1.0.0' } } } });
    return;
  }
  if (method === 'initialize') {
    const offered = v?.params?.protocolVersion ?? '2025-11-25';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const ver = supported.includes(offered) ? offered : '2025-11-25';
    reply({ jsonrpc: '2.0', id, result: { protocolVersion: ver, capabilities: { tools: {} }, serverInfo: { name: 'kara-forge', version: '1.0.0' } } });
    return;
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextReqId() }); res.end(); return;
  }
  if (method === 'ping') { reply({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    reply({ jsonrpc: '2.0', id, result: { tools: JSON.parse(JSON.stringify(MCP_TOOLS)) } });
    return;
  }
  if (method === 'tools/call') {
    const params = v?.params ?? {};
    const toolName = String(params.name ?? '');
    const args = params.arguments ?? {};
    const out = mcpCall(toolName, args);
    if (out.error) { reply({ jsonrpc: '2.0', id, error: out.error }); return; }
    reply({ jsonrpc: '2.0', id, result: out.result });
    return;
  }
  reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}
// ---------------------------------------------------------------- server
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const { path, query, segments } = urlOf(req);
      const method = req.method ?? 'GET';
      const bodyBuf = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      if (path === '/api/graphql' && method === 'POST') { await handleGraphQL(req, res, bodyBuf); return; }
      if (path === '/mcp') {
        if (method === 'POST') { await handleMcp(req, res, bodyBuf); return; }
        if (method === 'DELETE') { res.writeHead(200, { 'x-github-request-id': nextReqId() }); res.end(); return; }
        sendJson(res, 404, { message: 'Not Found' }); return;
      }
      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        // malformed JSON on REST writes must be 400 even for unknown routes: handled inside
        await handleRest(req, res, segments, query, bodyBuf);
        return;
      }
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        await handleGit(req, res, segments, query, bodyBuf);
        return;
      }
      // unknown route: JSON 404 (auth not required for non-API paths, matching starter)
      sendJson(res, 404, { message: 'Not Found' });
    } catch (e: any) {
      if (!res.headersSent) { try { errJson(res, 500, String(e?.message ?? e)); } catch { /* ignore */ } }
    }
  });
}
