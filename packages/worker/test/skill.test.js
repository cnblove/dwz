import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import worker from '../src/index.js';
import { createCtx, createEnv, makeRequest } from './helpers.js';

/**
 * skill 命令行工具（skills/dwz-api/scripts/dwz.mjs）的端到端测试。
 *
 * 为什么值得单独测：skill 是用户拿到的**唯一入口**，
 * 它和 Worker 之间的契约（签名串的拼法、dv1_* 参数名、返回结构）
 * 一旦漂移，表现是「命令跑不通」而不是「测试挂了」——
 * 那种问题在用户提 issue 之前没人会发现。
 *
 * 这里起一个真的 HTTP 服务把 Worker 挂上去，再用子进程跑 CLI，
 * 覆盖的正是用户实际走的那条路径。
 */
const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../../../skills/dwz-api/scripts/dwz.mjs');

let server;
let origin;
let env;
let apiKey;
let apiSecret;

before(async () => {
  env = createEnv({ SHORT_ORIGIN: 'http://127.0.0.1:0' });
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const ctx = createCtx();
    const response = await worker.fetch(request, env, ctx);
    await ctx.settle();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  env.SHORT_ORIGIN = origin;

  const registered = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'supersecret1' }),
  });
  const { token } = await registered.json();
  const created = await fetch(`${origin}/api/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  const { item } = await created.json();
  apiKey = item.apiKey;
  apiSecret = item.apiSecret;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** 跑 CLI，返回 {stdout, stderr, code}。失败不抛，让用例自己断言退出码。 */
async function cli(args, extra = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...process.env, DWZ_ORIGIN: origin, DWZ_API_KEY: apiKey, DWZ_API_SECRET: apiSecret },
      ...extra,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 };
  }
}

test('catalog 无需凭据即可自描述', async () => {
  const { stdout, code } = await cli(['catalog'], {
    env: { ...process.env, DWZ_ORIGIN: origin, DWZ_API_KEY: '', DWZ_API_SECRET: '' },
  });
  assert.equal(code, 0);
  assert.match(stdout, /short-links/);
  assert.match(stdout, /HMAC-SHA256/);
});

test('check 验证凭据可用', async () => {
  const { stdout, code } = await cli(['check']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /凭据可用/);
});

test('create 建出的短链真的能跳转', async () => {
  const created = await cli([
    'short-links', 'create',
    '--title', '从 skill 建的',
    '--url', 'https://example.com/from-skill',
    '--json',
  ]);
  assert.equal(created.code, 0, created.stderr);
  const payload = JSON.parse(created.stdout);
  assert.equal(payload.item.title, '从 skill 建的');
  assert.match(payload.url, new RegExp(`^${origin}/`));

  const redirect = await fetch(payload.url, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/from-skill');
});

test('list 与 get 能看到刚建的资源', async () => {
  const listed = await cli(['short-links', 'list', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.ok(payload.total >= 1);

  const slug = payload.items[0].slug;
  const detail = await cli(['short-links', 'get', '--slug', slug]);
  assert.equal(detail.code, 0, detail.stderr);
  assert.match(detail.stdout, new RegExp(slug));
});

test('stats 能读回访问数据（含小时分布与趋势）', async () => {
  const created = await cli(['short-links', 'create', '--title', '统计用', '--url', 'https://example.com/s', '--json']);
  const slug = JSON.parse(created.stdout).item.slug;
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await fetch(`${origin}/${slug}`, { redirect: 'manual' });
  }

  const stats = await cli(['stats', '--slug', slug, '--days', '7', '--json']);
  assert.equal(stats.code, 0, stats.stderr);
  const payload = JSON.parse(stats.stdout);
  assert.equal(payload.hits, 3);
  assert.equal(payload.hourly.length, 24);
  assert.equal(payload.daily.length, 7);
  assert.equal(payload.visitors.visitorsToday, 1);
});

test('delete 之后资源与 slug 一起消失', async () => {
  const created = await cli([
    'channels', 'create',
    '--title', '待删渠道',
    '--url', 'https://example.com/ch',
    '--type', 'wechat',
    '--slug', 'skill-del-1',
    '--json',
  ]);
  assert.equal(created.code, 0, created.stderr);

  const removed = await cli(['channels', 'delete', '--slug', 'skill-del-1']);
  assert.equal(removed.code, 0, removed.stderr);

  const missing = await fetch(`${origin}/skill-del-1`, { redirect: 'manual' });
  assert.equal(missing.status, 404);
});

test('--dry-run 只打印请求，不发出去', async () => {
  const { stdout, code } = await cli(['short-links', 'create', '--title', 'x', '--url', 'https://example.com/x', '--dry-run']);
  assert.equal(code, 0);
  assert.match(stdout, /POST http/);
  assert.match(stdout, /"dv1_title": "x"/);
  // 签名必须在 dry-run 输出里就能看到，便于对照排查
  assert.match(stdout, /"sign": "[0-9a-f]{64}"/);
});

test('凭据缺失时报错清楚，而不是抛栈', async () => {
  const { stderr, code } = await cli(['short-links', 'list'], {
    env: { ...process.env, DWZ_ORIGIN: origin, DWZ_API_KEY: '', DWZ_API_SECRET: '' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /DWZ_API_KEY/);
});

test('签名错误时把服务端的话原样带出来', async () => {
  const { stderr, code } = await cli(['short-links', 'list'], {
    env: { ...process.env, DWZ_ORIGIN: origin, DWZ_API_KEY: apiKey, DWZ_API_SECRET: 'wrong-secret' },
  });
  assert.equal(code, 1);
  assert.match(stderr, /签名校验失败/);
});

test('未知资源与未知动作给出可用清单', async () => {
  const bad = await cli(['nope', 'list']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /short-links/);

  const badAction = await cli(['short-links', 'publish']);
  assert.equal(badAction.code, 1);
  assert.match(badAction.stderr, /create/);
});

test('缺参数时不发请求，直接报缺什么', async () => {
  const { stderr, code } = await cli(['short-links', 'create', '--title', '只有标题']);
  assert.equal(code, 1);
  assert.match(stderr, /--url/);
});

test('makeRequest 与 worker 的契约：目录路径可用', async () => {
  // 顺带确认 /open/v1 在 Worker 里是 GET 且无需鉴权（目录被别人镜像走也没关系，它不含私密数据）
  const response = await worker.fetch(makeRequest(`${origin}/open/v1`), env, createCtx());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, 'v1');
});

/* ---------------- 一键安装脚本 ---------------- */

/**
 * install.sh 的测试。
 *
 * 它是个会写用户 home 的脚本，最怕两件事：装错位置、覆盖别人的东西。
 * 所以这里给它一个假的 HOME，验证「skill 就位 + 链进助手目录 + 不覆盖已存在项」。
 * 脚本只链到「已经存在的助手目录」，因此 HOME 下先造出 .claude / .codebuddy。
 */
test('install.sh 把 skill 装到 home 并链进助手目录', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dwz-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codebuddy'), { recursive: true });

  const script = join(here, '../../../skills/install.sh');
  const { stdout } = await execFileAsync('sh', [script], { env: { ...process.env, HOME: home } });

  assert.match(stdout, /skill 已就位/);
  // 本体落在 .agents/skills，两个助手目录各自软链过去
  assert.ok(existsSync(join(home, '.agents/skills/dwz-api/SKILL.md')), '应安装 SKILL.md');
  assert.ok(existsSync(join(home, '.agents/skills/dwz-api/scripts/dwz.mjs')), '应带上 CLI');
  assert.equal(realpathSync(join(home, '.claude/skills/dwz-api')), realpathSync(join(home, '.agents/skills/dwz-api')));
  assert.equal(realpathSync(join(home, '.codebuddy/skills/dwz-api')), realpathSync(join(home, '.agents/skills/dwz-api')));

  await rm(home, { recursive: true, force: true });
});

test('install.sh 不覆盖已存在的同名 skill', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dwz-home-'));
  await mkdir(join(home, '.claude/skills/dwz-api'), { recursive: true });
  await writeFile(join(home, '.claude/skills/dwz-api/keep.txt'), 'mine');

  const script = join(here, '../../../skills/install.sh');
  const { stderr } = await execFileAsync('sh', [script], { env: { ...process.env, HOME: home } });

  assert.match(stderr, /已存在/);
  assert.equal(readFileSync(join(home, '.claude/skills/dwz-api/keep.txt'), 'utf8'), 'mine');

  await rm(home, { recursive: true, force: true });
});
