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

test('qrcodes 子码：从 CLI 建、列、改、删，落地页同步变化', async () => {
  const created = await cli([
    'codes', 'create',
    '--title', 'CLI 群活码',
    '--url', 'https://example.com/fallback',
    '--slug', 'skill-code-1',
    '--json',
  ]);
  assert.equal(created.code, 0, created.stderr);

  const added = await cli([
    'qrcodes', 'create',
    '--code', 'skill-code-1',
    '--image', '/media/assets/202610/skill.png',
    '--contact', 'kefu001',
    '--json',
  ]);
  assert.equal(added.code, 0, added.stderr);
  const item = JSON.parse(added.stdout).item;
  assert.equal(item.index, 1);
  assert.equal(item.contact, 'kefu001');

  // 落地页必须真的用上这张图，否则「建了子码」只是库里多一行
  const page = await fetch(`${origin}/skill-code-1`);
  assert.match(await page.text(), /skill\.png/);

  const listed = await cli(['qrcodes', 'list', '--code', 'skill-code-1']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /子码 1 张/);

  // 序号 1 与 id 都指向同一张，禁用后落地页不再展示
  const disabled = await cli(['qrcodes', 'update', '--code', 'skill-code-1', '--qrcode', '1', '--status', 'disabled']);
  assert.equal(disabled.code, 0, disabled.stderr);
  const afterDisable = await fetch(`${origin}/skill-code-1`);
  assert.doesNotMatch(await afterDisable.text(), /skill\.png/);

  const removed = await cli(['qrcodes', 'delete', '--code', 'skill-code-1', '--qrcode', String(item.id)]);
  assert.equal(removed.code, 0, removed.stderr);

  const empty = await cli(['qrcodes', 'list', '--code', 'skill-code-1', '--json']);
  assert.equal(JSON.parse(empty.stdout).total, 0);
});

test('qrcodes 的参数错误在本地就报出来，不发请求', async () => {
  const noCode = await cli(['qrcodes', 'list']);
  assert.equal(noCode.code, 1);
  assert.match(noCode.stderr, /--code/);

  const noImage = await cli(['qrcodes', 'create', '--code', 'whatever']);
  assert.equal(noImage.code, 1);
  assert.match(noImage.stderr, /--image/);

  const noPatch = await cli(['qrcodes', 'update', '--code', 'whatever', '--qrcode', '1']);
  assert.equal(noPatch.code, 1);
  assert.match(noPatch.stderr, /--status|没有要改的字段/);

  const badAction = await cli(['qrcodes', 'publish', '--code', 'x']);
  assert.equal(badAction.code, 1);
  assert.match(badAction.stderr, /reset/);
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

/* ---------------- 补齐的动作（update / admin / 素材） ---------------- */

test('update：改短链的目标链接，slug 不变且真的跳新地址', async () => {
  const created = await cli([
    'short-links', 'create', '--title', '待改', '--url', 'https://example.com/old',
    '--slug', 'cli-patch-1', '--json',
  ]);
  assert.equal(created.code, 0, created.stderr);

  const patched = await cli([
    'short-links', 'update', '--slug', 'cli-patch-1',
    '--new-title', '改过了', '--target-url', 'https://example.com/new', '--json',
  ]);
  assert.equal(patched.code, 0, patched.stderr);
  const payload = JSON.parse(patched.stdout);
  assert.equal(payload.item.title, '改过了');
  assert.equal(payload.item.slug, 'cli-patch-1');

  // 跳转必须真的变了 —— 只在库里改字段不算数
  const redirect = await fetch(`${origin}/cli-patch-1`, { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), 'https://example.com/new');
});

test('update：什么都没给时会明确报错，而不是静默成功', async () => {
  await cli(['short-links', 'create', '--title', '占位', '--url', 'https://example.com/x', '--slug', 'cli-patch-2', '--json']);
  const result = await cli(['short-links', 'update', '--slug', 'cli-patch-2']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /没有要改的字段/);
});

test('reset：清零访问计数，链接仍然可用', async () => {
  await cli(['short-links', 'create', '--title', '计数', '--url', 'https://example.com/c', '--slug', 'cli-reset-1', '--json']);
  await fetch(`${origin}/cli-reset-1`, { redirect: 'manual' });

  const reset = await cli(['short-links', 'reset', '--slug', 'cli-reset-1', '--json']);
  assert.equal(reset.code, 0, reset.stderr);
  assert.equal(JSON.parse(reset.stdout).item.hits, 0);

  const redirect = await fetch(`${origin}/cli-reset-1`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
});

test('channels blocks：加黑名单、列出来、再解封', async () => {
  await cli(['channels', 'create', '--title', '渠道', '--url', 'https://example.com/ch', '--slug', 'cli-block-1', '--json']);

  const added = await cli(['channels', 'blocks', '--slug', 'cli-block-1', '--action', 'add', '--ip', '9.9.9.9', '--json']);
  assert.equal(added.code, 0, added.stderr);

  const listed = await cli(['channels', 'blocks', '--slug', 'cli-block-1', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  const block = JSON.parse(listed.stdout).blocks[0];
  assert.ok(block.ipHash);

  const removed = await cli(['channels', 'blocks', '--action', 'remove', '--id', String(block.id), '--json']);
  assert.equal(removed.code, 0, removed.stderr);

  const after = await cli(['channels', 'blocks', '--slug', 'cli-block-1', '--json']);
  assert.equal(JSON.parse(after.stdout).blocks.length, 0);
});

test('后台类命令：不带 --grant owner 会被拒，带上才能用', async () => {
  const denied = await cli(['users', 'list', '--json']);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /超级管理员/);

  const allowed = await cli(['users', 'list', '--grant', 'owner', '--json']);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.ok(Array.isArray(JSON.parse(allowed.stdout).items));
});

test('后台类命令：域名增删查', async () => {
  const created = await cli(['domains', 'create', '--grant', 'owner', '--host', 'cli.example.com', '--kind', 'short', '--json']);
  assert.equal(created.code, 0, created.stderr);
  const id = JSON.parse(created.stdout).item.id;

  const listed = await cli(['domains', 'list', '--grant', 'owner', '--json']);
  assert.match(listed.stdout, /cli\.example\.com/);

  const deleted = await cli(['domains', 'delete', '--grant', 'owner', '--id', String(id), '--json']);
  assert.equal(deleted.code, 0, deleted.stderr);
});

test('后台类命令：素材上传拿到地址，直接当子码图片用', async () => {
  await cli(['codes', 'create', '--title', '图床', '--url', 'https://example.com/fb', '--slug', 'cli-asset-1', '--json']);

  const dir = await mkdtemp(join(tmpdir(), 'dwz-asset-'));
  const file = join(dir, 'qr.png');
  // 一个最小可用的 PNG 头就够：服务端只校验 MIME，不解析像素
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const uploaded = await cli(['assets', 'upload', '--grant', 'owner', '--file', file, '--json']);
  assert.equal(uploaded.code, 0, uploaded.stderr);
  const url = JSON.parse(uploaded.stdout).item.url;
  assert.match(url, /^\/media\//);

  // 上传的地址必须是「能直接用」的那种，否则上传这件事本身就白做了
  const qrcode = await cli(['qrcodes', 'create', '--code', 'cli-asset-1', '--image', url, '--json']);
  assert.equal(qrcode.code, 0, qrcode.stderr);

  await rm(dir, { recursive: true, force: true });
});

test('后台类命令：一次调用发出新凭证并确认能用', async () => {
  const created = await cli(['credentials', 'create', '--grant', 'owner', '--json']);
  assert.equal(created.code, 0, created.stderr);
  const item = JSON.parse(created.stdout).item;
  assert.match(item.apiKey, /^dwz_/);

  // 新 key 得真的能用，否则「自助发 key」只是一次数据库写入
  const used = await cli(['short-links', 'list', '--key', item.apiKey, '--secret', item.apiSecret, '--json']);
  assert.equal(used.code, 0, used.stderr);
});

test('catalog 把新补的动作也摊出来了', async () => {
  const { stdout, code } = await cli(['catalog', '--json'], {
    env: { ...process.env, DWZ_ORIGIN: origin, DWZ_API_KEY: '', DWZ_API_SECRET: '' },
  });
  assert.equal(code, 0, stdout);
  const payload = JSON.parse(stdout);

  const shortLinks = payload.resources.find((item) => item.resource === 'short-links');
  assert.ok(shortLinks.actions.some((action) => action.action === 'update'), '短链必须有 update');
  assert.ok(payload.resources.some((item) => item.resource === 'users'));
  assert.ok(payload.resources.some((item) => item.resource === 'cardkeys'));
  assert.match(payload.signTemplate, /dv1_grant/);
});

test('后台类命令：列表用表格，一次性明文单独提示', async () => {
  const created = await cli([
    'cardkeys', 'create', '--grant', 'owner',
    '--name', '输出格式', '--content', '说明', '--count', '2',
  ]);
  assert.equal(created.code, 0, created.stderr);
  // 明文必须有一句「只显示这一次」的醒目提示，否则用户滚屏过去才发现没存
  assert.match(created.stdout, /只显示这一次/);
  assert.match(created.stdout, /DWZ-[0-9A-F]{8}/);

  const listed = await cli(['cardkeys', 'list', '--grant', 'owner']);
  assert.equal(listed.code, 0, listed.stderr);
  // 表格要有表头和「共 N 条」的收尾，不然人不知道这是全部还是截断的
  assert.match(listed.stdout, /剩余\/总数/);
  assert.match(listed.stdout, /共 \d+ 条/);
});

test('codes create --kind service 建出客服码，子码默认阈值是 0', async () => {
  const created = await cli([
    'codes', 'create', '--title', 'CLI 客服码', '--url', 'https://example.com/kefu', '--kind', 'service', '--json',
  ]);
  assert.equal(created.code, 0, created.stderr);
  const code = JSON.parse(created.stdout).item;
  assert.equal(code.kind, 'service');

  const qr = await cli(['qrcodes', 'create', '--code', code.slug, '--image', '/media/kefu.png', '--json']);
  assert.equal(qr.code, 0, qr.stderr);
  assert.equal(JSON.parse(qr.stdout).item.threshold, 0, '客服码的默认阈值应与后台一致（0）');
});

test('merges：把 A 的访客并到 B，再取消', async () => {
  const a = await cli(['codes', 'create', '--title', '并流A', '--url', 'https://example.com/a', '--slug', 'merge-a-1', '--json']);
  const b = await cli(['codes', 'create', '--title', '并流B', '--url', 'https://example.com/b', '--slug', 'merge-b-1', '--json']);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);

  const set = await cli(['merges', 'set', '--code', 'merge-a-1', '--to-code', 'merge-b-1']);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /merge-a-1/);
  assert.match(set.stdout, /merge-b-1/);
  // 取消的命令要能直接复制走，否则人得回头看 help
  assert.match(set.stdout, /merges remove --code merge-a-1/);

  const removed = await cli(['merges', 'remove', '--code', 'merge-a-1']);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /不再被导去别处/);

  // 没并流再取消要说清楚，而不是谎报成功
  const again = await cli(['merges', 'remove', '--code', 'merge-a-1']);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /并流/);
});

test('merges 缺 --to-code 时不发请求就说清楚缺什么', async () => {
  const res = await cli(['merges', 'set', '--code', 'whatever']);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /--to-code/);
});

test('merges 的动作清单也摊在 catalog 里', async () => {
  const { stdout, code } = await cli(['catalog', '--json'], {
    env: { ...process.env, DWZ_ORIGIN: origin, DWZ_API_KEY: '', DWZ_API_SECRET: '' },
  });
  assert.equal(code, 0, stdout);
  const payload = JSON.parse(stdout);
  const codes = payload.resources.find((item) => item.resource === 'codes');
  const paths = codes.actions.map((item) => item.path);
  assert.ok(paths.includes('/open/v1/codes/merges/set'), '目录要有 merges/set');
  assert.ok(paths.includes('/open/v1/codes/merges/remove'), '目录要有 merges/remove');
});
