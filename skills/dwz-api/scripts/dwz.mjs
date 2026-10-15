#!/usr/bin/env node
import { createHmac } from 'node:crypto';

/**
 * dwz 开放 API 的命令行封装。
 *
 * 存在的意义只有一个：把签名这件事做对，让人（和 AI）不必每次手拼 HMAC。
 * 因此这里刻意零依赖、单文件 —— skill 会被复制到别人的机器上跑，
 * 一个 `npm install` 都可能失败，而 `node dwz.mjs` 不会。
 *
 * 配置优先级：命令行参数 > 环境变量。
 *   DWZ_ORIGIN / DWZ_API_KEY / DWZ_API_SECRET
 */

const USAGE = `dwz 开放 API 客户端

用法：
  node dwz.mjs <资源> <动作> [选项]
  node dwz.mjs stats [选项]
  node dwz.mjs catalog | check

资源与动作：
  short-links create|list|get|delete     短链
  codes       create|list|get|delete     活码宿主（群活码 / 客服码）
  qrcodes     list|create|update|delete|reset
                                         活码子码（二维码图片），用 --code 指定宿主
  channels    create|list|get|delete     渠道码
  stats                                  访问分析

通用选项：
  --title <文本>      标题（create 必填）
  --url <链接>        目标链接（create 必填，http/https）
  --type <值>         访问限制：any | wechat | ios | android | mobile | desktop
  --slug <值>         自定义短链（4~32 位字母数字 _-）；get/delete/stats 用它定位资源
  --code <值>         活码 slug，qrcodes 的宿主（等价于 --slug，写起来更清楚）
  --qrcode <值>       子码数字 id，或它在宿主下的序号（从 1 开始）
  --image <链接>      子码二维码图片地址（http/https 或 /media/xxx）
  --contact <文本>    子码绑定的客服微信号
  --threshold <n>     子码阈值；不传按活码类型给默认（群码 200 / 客服码 0）
  --status <值>       子码状态：active | disabled
  --page <n>          分页页码（list，默认 1）
  --page-size <n>     每页条数（list，默认 20，上限 100）
  --keyword <文本>    list 的模糊匹配
  --days <n>          stats 的趋势天数（默认 7，上限 30）
  --day <YYYY-MM-DD>  stats 看某一天的小时分布

其它：
  --json              输出原始 JSON（默认表格/摘要，适合人看）
  --dry-run           只打印即将发送的请求，不发出去
  --origin <地址>     平台地址，覆盖 DWZ_ORIGIN
  --key <api_key>     覆盖 DWZ_API_KEY
  --secret <secret>   覆盖 DWZ_API_SECRET
  -h, --help          看这份说明

例：
  export DWZ_ORIGIN=https://dwz.example.com
  export DWZ_API_KEY=dwz_xxxxxxxxxxxxxxxx
  export DWZ_API_SECRET=<secret>

  node dwz.mjs check
  node dwz.mjs short-links create --title "双十一" --url https://example.com/act
  node dwz.mjs codes list --json
  node dwz.mjs stats --slug 8f14e45f-ceea-467a-9c1e-1b0d2a1b3c4d --days 7

  # 活码子码：先建宿主，再往宿主里加二维码
  node dwz.mjs codes create --title "运营群" --url https://example.com/fallback
  node dwz.mjs qrcodes create --code <活码 slug> --image /media/assets/202610/xxx.png
  node dwz.mjs qrcodes list --code <活码 slug>
  node dwz.mjs qrcodes update --code <活码 slug> --qrcode 1 --status disabled
  node dwz.mjs qrcodes delete --code <活码 slug> --qrcode 2
`;

const RESOURCES = ['short-links', 'codes', 'channels'];
const ACTIONS = ['create', 'list', 'get', 'delete'];

/**
 * 子码是一个独立命令（qrcodes），不是第四个资源。
 *
 * 它没有自己的 slug 命名空间 —— 定位靠「宿主 slug + 子码编号」，
 * 所以放进 RESOURCES 会让 `--slug` 的语义在这里变成两种。
 */
const QRCODE_ACTIONS = ['list', 'create', 'update', 'delete', 'reset'];

/* ---------------- 参数解析 ---------------- */

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      rest.push(item);
      continue;
    }
    const [rawKey, inline] = item.slice(2).split('=');
    const key = rawKey;
    if (inline !== undefined) {
      flags[key] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { flags, rest };
}

function need(flags, name, hint) {
  const value = flags[name];
  if (value === undefined || value === true || value === '') {
    fail(`缺少 --${name}${hint ? `：${hint}` : ''}`);
  }
  return String(value);
}

function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

/* ---------------- 配置 ---------------- */

function config(flags) {
  const origin = String(flags.origin ?? process.env.DWZ_ORIGIN ?? '').trim().replace(/\/+$/, '');
  const apiKey = String(flags.key ?? process.env.DWZ_API_KEY ?? '').trim();
  const apiSecret = String(flags.secret ?? process.env.DWZ_API_SECRET ?? '').trim();

  if (!origin) {
    fail('缺少平台地址。设 DWZ_ORIGIN 环境变量，或加 --origin https://你的域名');
  }
  if (!apiKey || !apiSecret) {
    fail('缺少 api_key / api_secret。设 DWZ_API_KEY 与 DWZ_API_SECRET 环境变量（后台「设置 → 个人 API Key」创建）');
  }
  return { origin, apiKey, apiSecret };
}

/* ---------------- 签名 ---------------- */

/**
 * 签名串按位置拼：标题|访问限制|目标链接|api_key|api_secret。
 *
 * 这三个 tag 位是**按位置**进签名的，读操作一律补空串 ——
 * 把 slug 塞进 tag 位是最常见的签名失败原因，所以这里显式用空串，
 * 不给自己留「顺手填上」的机会。
 */
function signPayload({ apiKey, apiSecret }, tags) {
  const canonical = [
    tags.title ?? '',
    tags.type ?? '',
    tags.url ?? '',
    apiKey,
    apiSecret,
  ].join('|');
  return createHmac('sha256', apiSecret).update(canonical, 'utf8').digest('hex');
}

function buildBody(cfg, tags, extra) {
  return {
    dv1_title: tags.title ?? '',
    dv1_type: tags.type ?? '',
    dv1_url: tags.url ?? '',
    ...extra,
    api_key: cfg.apiKey,
    sign: signPayload(cfg, tags),
  };
}

/* ---------------- 请求 ---------------- */

async function call(cfg, path, body, { dryRun } = {}) {
  const url = `${cfg.origin}/open${path}`;
  if (dryRun) {
    process.stdout.write(`POST ${url}\n`);
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return null;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    fail(`服务返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    fail(`${payload?.msg ?? `请求失败（HTTP ${response.status}）`}`);
  }
  return payload;
}

/* ---------------- 输出 ---------------- */

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function table(rows, columns) {
  if (!rows.length) {
    process.stdout.write('（没有数据）\n');
    return;
  }
  const widths = columns.map((col) =>
    Math.max(col.label.length, ...rows.map((row) => String(col.value(row) ?? '').length)),
  );
  const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');
  process.stdout.write(`${line(columns.map((col) => col.label))}\n`);
  process.stdout.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const row of rows) {
    process.stdout.write(`${line(columns.map((col) => col.value(row)))}\n`);
  }
}


/* ---------------- 命令 ---------------- */

async function cmdCatalog(cfg, flags) {
  const response = await fetch(`${cfg.origin}/open/v1`, { method: 'GET' });
  const payload = await response.json();
  if (!response.ok) fail(payload?.msg ?? `HTTP ${response.status}`);
  if (flags.json) return printJson(payload);

  process.stdout.write(`平台：${payload.origin}（接口版本 ${payload.version}）\n`);
  process.stdout.write(`签名：${payload.signAlgorithm}\n`);
  process.stdout.write(`签名串：${payload.signTemplate}\n\n`);
  for (const resource of payload.resources) {
    process.stdout.write(`${resource.resource} —— ${resource.name}\n`);
    process.stdout.write(`  ${resource.note}\n`);
    for (const action of resource.actions) {
      process.stdout.write(`  - ${action.action.padEnd(7)} ${action.path}  ${action.summary}\n`);
    }
  }
  for (const action of payload.actions) {
    process.stdout.write(`${action.action} —— ${action.summary}\n  - ${action.path}\n`);
  }
}

async function cmdCheck(cfg, flags) {
  const payload = await call(cfg, '/v1/short-links/list?', buildBody(cfg, {}, { dv1_page: 1, dv1_page_size: 1 }));
  if (flags.json) return printJson(payload);
  process.stdout.write('凭据可用。\n');
  process.stdout.write(`平台：${cfg.origin}\n`);
  process.stdout.write(`名下短链：${payload.total} 条\n`);
}

async function cmdResource(cfg, flags, resource, action) {
  const tags = {};
  const extra = {};

  if (action === 'create') {
    tags.title = need(flags, 'title', '短链标题');
    tags.url = need(flags, 'url', '要跳转到的 http/https 地址');
    tags.type = String(flags.type ?? 'any');
    if (flags.slug) extra.dv1_slug = String(flags.slug);
  } else if (action === 'list') {
    if (flags.keyword) extra.dv1_keyword = String(flags.keyword);
    if (flags.page) extra.dv1_page = Number(flags.page);
    if (flags['page-size']) extra.dv1_page_size = Number(flags['page-size']);
  } else {
    extra.dv1_slug = need(flags, 'slug', '用 --slug 指定要操作的资源');
  }

  const body = buildBody(cfg, tags, extra);
  const payload = await call(cfg, `/v1/${resource}/${action}`, body, { dryRun: flags['dry-run'] });
  if (!payload || flags['dry-run']) return payload;

  if (flags.json) return printJson(payload);

  if (action === 'create') {
    process.stdout.write(`已创建${payload.type}：${payload.item.title}\n`);
    process.stdout.write(`地址：${payload.url}\n`);
    process.stdout.write(`slug：${payload.item.slug}\n`);
    if (payload.item.expiredAt) process.stdout.write(`过期时间：${payload.item.expiredAt}\n`);
    if (resource === 'codes') {
      process.stdout.write(
        '\n提示：落地页要先有子码才有二维码可扫，接着跑：\n'
        + `  node dwz.mjs qrcodes create --code ${payload.item.slug} --image <二维码图片地址>\n`,
      );
    }
    return payload;
  }

  if (action === 'get') {
    const item = payload.item;
    process.stdout.write(`${payload.type}：${item.title}\n`);
    process.stdout.write(`slug：${item.slug}\n`);
    process.stdout.write(`状态：${item.status}\n`);
    process.stdout.write(`访问限制：${item.accessType}\n`);
    if (item.targetUrl) process.stdout.write(`目标：${item.targetUrl}\n`);
    process.stdout.write(`累计访问：${item.hits}（今日 ${item.hitsToday}）\n`);
    if (payload.qrcodes) {
      process.stdout.write(`子码 ${payload.qrcodes.length} 张：\n`);
      for (const qrcode of payload.qrcodes) {
        process.stdout.write(`  #${qrcode.id} ${qrcode.status} 已用 ${qrcode.hits}/${qrcode.threshold}${qrcode.contact ? ` 联系：${qrcode.contact}` : ''}\n`);
      }
    }
    return payload;
  }

  if (action === 'delete') {
    process.stdout.write(`已删除：${payload.slug}\n`);
    return payload;
  }

  table(payload.items, [
    { label: 'slug', value: (row) => row.slug },
    { label: '标题', value: (row) => row.title },
    { label: '状态', value: (row) => row.status },
    { label: '访问', value: (row) => row.hits },
    { label: '今日', value: (row) => row.hitsToday },
  ]);
  process.stdout.write(`\n共 ${payload.total} 条，第 ${payload.page} 页（每页 ${payload.pageSize}）\n`);
  return payload;
}

/**
 * 子码命令。
 *
 * 定位参数收两个名字：`--slug`（与其它命令一致）和 `--code`（读起来是「哪个活码」）。
 * 两个都给不冲突，以 `--code` 为准 —— 它更具体。
 */
function codeSlug(flags) {
  const value = flags.code ?? flags.slug;
  if (value === undefined || value === true || value === '') {
    fail('缺少 --code：用 --code <活码 slug> 指定要操作的活码');
  }
  return String(value);
}

async function cmdQrcode(cfg, flags, action) {
  const extra = { dv1_slug: codeSlug(flags) };

  if (action === 'create') {
    extra.dv1_image_url = need(flags, 'image', '子码二维码图片地址（http/https 或 /media/xxx）');
    if (flags.contact) extra.dv1_contact = String(flags.contact);
    if (flags.threshold !== undefined) extra.dv1_threshold = Number(flags.threshold);
  } else if (action === 'update') {
    extra.dv1_qrcode = need(flags, 'qrcode', '子码数字 id 或序号');
    if (flags.image) extra.dv1_image_url = String(flags.image);
    if (flags.contact !== undefined) extra.dv1_contact = String(flags.contact);
    if (flags.threshold !== undefined) extra.dv1_threshold = Number(flags.threshold);
    if (flags.status) extra.dv1_status = String(flags.status);
    if (
      flags.image === undefined
      && flags.contact === undefined
      && flags.threshold === undefined
      && flags.status === undefined
    ) {
      fail('没有要改的字段：至少给 --image / --contact / --threshold / --status 之一');
    }
  } else if (action !== 'list') {
    extra.dv1_qrcode = need(flags, 'qrcode', '子码数字 id 或序号');
  }

  const body = buildBody(cfg, {}, extra);
  const payload = await call(cfg, `/v1/codes/qrcodes/${action}`, body, { dryRun: flags['dry-run'] });
  if (!payload || flags['dry-run']) return payload;
  if (flags.json) return printJson(payload);

  const label = `活码「${payload.code.title}」（${payload.code.slug}）`;

  if (action === 'list') {
    process.stdout.write(`${label}，子码 ${payload.total} 张：\n`);
    for (const row of payload.items) {
      process.stdout.write(
        `  #${row.id}（第 ${row.index} 张）${row.status}  已用 ${row.hits}/${row.threshold}`
        + `${row.contact ? `  联系：${row.contact}` : ''}\n  ${row.imageUrl}\n`,
      );
    }
    if (!payload.items.length) process.stdout.write('  （还没有子码，用 qrcodes create 加一张）\n');
    return payload;
  }

  if (action === 'delete') {
    process.stdout.write(`已删除子码 #${payload.deleted.id}，${label} 现在还有 ${payload.total} 张\n`);
    return payload;
  }

  if (action === 'reset') {
    process.stdout.write(`已重置子码 #${payload.item.id} 的计数，${label}\n`);
    return payload;
  }

  const item = payload.item;
  process.stdout.write(`${action === 'create' ? '已新增' : '已更新'}子码 #${item.id}（第 ${item.index} 张）\n`);
  process.stdout.write(`图片：${item.imageUrl}\n`);
  process.stdout.write(`阈值：${item.threshold}，已用 ${item.hits}，状态 ${item.status}\n`);
  if (item.contact) process.stdout.write(`联系：${item.contact}\n`);
  return payload;
}

async function cmdStats(cfg, flags) {
  const extra = { dv1_slug: need(flags, 'slug', '用 --slug 指定要分析的资源') };
  if (flags.days) extra.dv1_days = Number(flags.days);
  if (flags.day) extra.dv1_day = String(flags.day);

  const payload = await call(cfg, '/v1/stats', buildBody(cfg, {}, extra), { dryRun: flags['dry-run'] });
  if (!payload || flags['dry-run']) return payload;
  if (flags.json) return printJson(payload);

  process.stdout.write(`${payload.title}（${payload.slug}）\n`);
  process.stdout.write(`口径：${payload.source}，统计日 ${payload.day}\n\n`);
  process.stdout.write(`累计访问：${payload.hits}（今日 ${payload.hitsToday}）\n`);
  process.stdout.write(`独立访客：累计 ${payload.visitors.visitorsTotal}，今日 ${payload.visitors.visitorsToday}\n\n`);

  process.stdout.write(`近 ${payload.days} 天：\n`);
  const max = Math.max(1, ...payload.daily.map((row) => row.hits));
  for (const row of payload.daily) {
    const bar = '█'.repeat(Math.round((row.hits / max) * 24));
    process.stdout.write(`  ${row.day}  ${String(row.hits).padStart(5)}  ${bar}\n`);
  }

  const peaks = payload.hourly.filter((row) => row.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, 3);
  if (peaks.length) {
    process.stdout.write(`\n当日高峰时段：${peaks.map((row) => `${row.hour} 时（${row.hits}）`).join('、')}\n`);
  }
  return payload;
}

/* ---------------- 入口 ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    return;
  }

  const { flags, rest } = parseArgs(argv);
  const [first, second] = rest;

  if (first === 'catalog') {
    const cfg = flags.origin || process.env.DWZ_ORIGIN ? partialConfig(flags) : null;
    if (!cfg) fail('缺少平台地址。设 DWZ_ORIGIN 环境变量，或加 --origin https://你的域名');
    return cmdCatalog(cfg, flags);
  }

  const cfg = config(flags);

  if (first === 'check') return cmdCheck(cfg, flags);
  if (first === 'stats') return cmdStats(cfg, flags);

  if (first === 'qrcodes') {
    if (!QRCODE_ACTIONS.includes(second)) {
      fail(`未知动作「${second ?? ''}」，qrcodes 可用：${QRCODE_ACTIONS.join(' / ')}`);
    }
    return cmdQrcode(cfg, flags, second);
  }

  if (!RESOURCES.includes(first)) {
    fail(`未知资源「${first ?? ''}」，可用：${RESOURCES.join(' / ')} / qrcodes / stats / catalog / check`);
  }
  if (!ACTIONS.includes(second)) {
    fail(`未知动作「${second ?? ''}」，可用：${ACTIONS.join(' / ')}`);
  }
  return cmdResource(cfg, flags, first, second);
}

/** catalog 无需鉴权，只要有地址就能跑。 */
function partialConfig(flags) {
  const origin = String(flags.origin ?? process.env.DWZ_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (!origin) fail('缺少平台地址。设 DWZ_ORIGIN 环境变量，或加 --origin https://你的域名');
  return { origin, apiKey: '', apiSecret: '' };
}

main().catch((error) => {
  process.stderr.write(`错误：${error?.message ?? error}\n`);
  process.exit(1);
});
