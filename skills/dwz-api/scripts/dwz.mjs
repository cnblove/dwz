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
  short-links create|list|get|update|delete|reset   短链
  codes       create|list|get|update|delete|reset   活码宿主（群活码 / 客服码）
  qrcodes     list|create|update|delete|reset       活码子码（二维码图片），用 --code 指定宿主
  merges      set|remove                            活码并流（把本活码的访客导去另一个），用 --code 指定宿主
  channels    create|list|get|update|delete|reset|blocks
                                                    渠道码与访客黑名单
  stats                                             访问分析

后台类（多数要加 --grant owner；用 --id 定位记录）：
  domains         list|create|update|delete|probe
  cardkeys        list|create|get|update|delete|append
  assets          list|upload|update|delete         素材库（upload 走 --file）
  notify-channels list|create|update|delete|test
  users           list|create|update|delete
  inspection      list|run
  credentials     list|create|update|delete          再发一串 API Key
  stats-admin     prune|visitors|setting|clear        访客明细与保留天数

通用选项：
  --title <文本>      标题（create 必填）
  --url <链接>        目标链接（create 必填，http/https）
  --type <值>         访问限制：any | wechat | ios | android | mobile | desktop
  --slug <值>         自定义短链（4~32 位字母数字 _-）；get/delete/stats/update 用它定位资源
  --new-slug <值>     update 时改自定义短链（换地址；旧地址随即失效）
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
  --grant <level>     授权级别：owner（后台类动作必须；只对超管的凭证生效）
  --id <n>            后台类动作要操作的记录 id（域名 / 卡密 / 用户 / 素材…）
  --file <路径>       素材上传的本地图片路径
  --host <域名>       域名
  --kind <值>         类型（活码 group/service、域名类型、渠道类型、素材类型等）
  --to-code <值>      并流的目标活码 slug（merges set 必填）
  --notify-channel <n> 活码的通知渠道 id（余量不足时推警）
  --remark <文本>     备注
  --ip <地址>         访客 IP（channels blocks --action add）
  --action <值>       channels blocks：list（默认）/ add / remove
  --name <文本>       名称（卡密批次 / 通知渠道）
  --content <文本>    卡密兑换后展示的内容
  --count <n>         卡密生成 / 追加数量
  --codes <文本>      自带卡密明文（换行分隔或 CSV）
  --username <账号>   用户登录名
  --password <密码>   用户初始密码
  --role <值>         用户角色：owner | member
  --group-id <n>      用户所属用户组 id
  --enabled <0|1>     通知渠道是否启用
  --config <JSON>     通知渠道配置对象
  --keep-days <n>     stats-admin 保留天数
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
  node dwz.mjs short-links update --slug <旧 slug> --new-slug <新 slug>  # 换短链地址
  node dwz.mjs stats --slug 8f14e45f-ceea-467a-9c1e-1b0d2a1b3c4d --days 7

  # 活码子码：先建宿主，再往宿主里加二维码
  node dwz.mjs codes create --title "运营群" --url https://example.com/fallback
  node dwz.mjs qrcodes create --code <活码 slug> --image /media/assets/202610/xxx.png
  node dwz.mjs qrcodes list --code <活码 slug>
  node dwz.mjs qrcodes update --code <活码 slug> --qrcode 1 --status disabled
  node dwz.mjs qrcodes delete --code <活码 slug> --qrcode 2

  # 客服码（不是群活码）与并流
  node dwz.mjs codes create --title "客服小美" --url https://example.com/fallback --kind service
  node dwz.mjs merges set --code <被并流的活码 slug> --to-code <目标活码 slug>
  node dwz.mjs merges remove --code <被并流的活码 slug>
`;

const RESOURCES = ['short-links', 'codes', 'channels'];
const ACTIONS = ['create', 'list', 'get', 'update', 'delete', 'reset'];

/**
 * 后台类命名空间。
 *
 * 它们和「资源」的差别只有定位方式：资源用 slug，后台记录用自增 id。
 * 所以 CLI 不另起一套参数体系，而是共用同一套 `--*`，只是
 * 资源类动作要 `--slug`，后台类动作要 `--id`。少一套体系，
 * 用户就少一次「这个命令该传哪个参数」的犹豫。
 */
const ADMIN_NAMESPACES = {
  domains: ['list', 'create', 'update', 'delete', 'probe'],
  cardkeys: ['list', 'create', 'get', 'update', 'delete', 'append'],
  assets: ['list', 'upload', 'update', 'delete'],
  'notify-channels': ['list', 'create', 'update', 'delete', 'test'],
  users: ['list', 'create', 'update', 'delete'],
  inspection: ['list', 'run'],
  credentials: ['list', 'create', 'update', 'delete'],
  'stats-admin': ['prune', 'visitors', 'setting', 'clear'],
};

/**
 * 子码是一个独立命令（qrcodes），不是第四个资源。
 *
 * 它没有自己的 slug 命名空间 —— 定位靠「宿主 slug + 子码编号」，
 * 所以放进 RESOURCES 会让 `--slug` 的语义在这里变成两种。
 */
const QRCODE_ACTIONS = ['list', 'create', 'update', 'delete', 'reset'];

/**
 * 并流：把本活码的访客导去另一个活码。
 *
 * 和子码同属「活码底下的二级资源」，所以也是独立命令、共用 `--code` 指宿主。
 */
const MERGE_ACTIONS = ['set', 'remove'];

/** 资源改名用 --new-title（`--title` 是创建时的必填项，也占着签名位）。 */
const RESOURCE_PATCH_FLAGS = [
  ['target-url', 'dv1_target_url'],
  ['access-type', 'dv1_access_type'],
  ['status', 'dv1_status'],
  ['url-ios', 'dv1_url_ios'],
  ['url-android', 'dv1_url_android'],
  ['url-desktop', 'dv1_url_desktop'],
  ['expired-jump', 'dv1_expired_jump'],
  ['pick-mode', 'dv1_pick_mode'],
  ['fallback-url', 'dv1_fallback_url'],
  ['remark', 'dv1_remark'],
  ['notify-channel', 'dv1_notify_channel'],
];

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
    tags.grant ?? '',
    apiKey,
    apiSecret,
  ].join('|');
  return createHmac('sha256', apiSecret).update(canonical, 'utf8').digest('hex');
}

function buildBody(cfg, tags, extra) {
  const body = {
    dv1_title: tags.title ?? '',
    dv1_type: tags.type ?? '',
    dv1_url: tags.url ?? '',
    ...extra,
    api_key: cfg.apiKey,
    sign: signPayload(cfg, tags),
  };
  // 授权位只在显式要求时才进 body：把它们当成「总是传」会让签名串
  // 多出两个位置，而服务端读的是 body 里真实存在的值 —— 两边必须一致。
  if (tags.grant) body.dv1_grant = tags.grant;
  return body;
}

/** 授权 tag：--grant / --parent 直接进签名串的那两位。 */
function grantTags(flags) {
  return { grant: flags.grant ? String(flags.grant) : '' };
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
      process.stdout.write(`  - ${String(action.action).padEnd(14)} ${action.path}  ${action.summary}\n`);
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
  const tags = { ...grantTags(flags) };
  const extra = {};

  if (action === 'create') {
    tags.title = need(flags, 'title', '短链标题');
    tags.url = need(flags, 'url', '要跳转到的 http/https 地址');
    tags.type = String(flags.type ?? 'any');
    if (flags.slug) extra.dv1_slug = String(flags.slug);
    // 活码才有这两个：group（群活码，默认）/ service（客服码），以及告警通知渠道
    if (resource === 'codes' && flags.kind) extra.dv1_kind = String(flags.kind);
    if (resource === 'codes' && flags['notify-channel']) {
      extra.dv1_notify_channel = Number(flags['notify-channel']);
    }
  } else if (action === 'list') {
    if (flags.keyword) extra.dv1_keyword = String(flags.keyword);
    if (flags.page) extra.dv1_page = Number(flags.page);
    if (flags['page-size']) extra.dv1_page_size = Number(flags['page-size']);
  } else if (action === 'update') {
    extra.dv1_slug = need(flags, 'slug', '用 --slug 指定要操作的资源');
    for (const [flag, key] of RESOURCE_PATCH_FLAGS) {
      if (flags[flag] !== undefined) extra[key] = String(flags[flag]);
    }
    // 阈值 / 计数这类要保数字类型，分开处理，别让它变成字符串塞进 SQL
    if (flags['new-title'] !== undefined) extra.dv1_new_title = String(flags['new-title']);
    // 改 slug 用 --new-slug（`--slug` 是定位用的旧值，也占着额外参数位）
    if (flags['new-slug'] !== undefined) extra.dv1_new_slug = String(flags['new-slug']);
    if (flags['expired-at'] !== undefined) extra.dv1_expired_at = String(flags['expired-at']) || null;
    const changed = Object.keys(extra).filter((key) => key !== 'dv1_slug');
    if (!changed.length) {
      fail('没有要改的字段：至少给 --new-title / --new-slug / --target-url / --access-type / --status / --fallback-url 等之一');
    }
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

  if (action === 'update' || action === 'reset') {
    const item = payload.item;
    process.stdout.write(`${action === 'update' ? '已更新' : '已重置计数'}：${payload.type}「${item.title}」（${item.slug}）\n`);
    process.stdout.write(`状态：${item.status}，访问限制：${item.accessType ?? (item.pickMode ? `选取 ${item.pickMode}` : '—')}\n`);
    if (item.targetUrl) process.stdout.write(`目标：${item.targetUrl}\n`);
    if (item.fallbackUrl) process.stdout.write(`兜底：${item.fallbackUrl}\n`);
    process.stdout.write(`累计访问：${item.hits}（今日 ${item.hitsToday}）\n`);
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

/**
 * 活码并流。
 *
 * `set` 要两个 slug（被并流的 + 目标），所以用 `--code` 指前者、`--to-code`
 * 指后者 —— 不把两者都塞进 `--slug`，那种「同一个参数传两次」的命令
 * 只能靠位置猜含义。
 */
async function cmdMerge(cfg, flags, action) {
  const slug = need(flags, 'code', '被并流的活码 slug（也可用 --slug）');
  const extra = { dv1_slug: String(flags.slug ?? slug) };
  if (action === 'set') {
    extra.dv1_to_slug = need(flags, 'to-code', '目标活码 slug');
  }

  const body = buildBody(cfg, {}, extra);
  const payload = await call(cfg, `/v1/codes/merges/${action}`, body, { dryRun: flags['dry-run'] });
  if (!payload || flags['dry-run']) return payload;
  if (flags.json) return printJson(payload);

  if (action === 'set') {
    process.stdout.write(`已把「${payload.from}」的访客并流到「${payload.to}」\n`);
    process.stdout.write('取消用：node dwz.mjs merges remove --code ' + payload.from + '\n');
    return payload;
  }
  process.stdout.write(`已取消「${payload.slug}」的并流，它自己的访客不再被导去别处\n`);
  return payload;
}

/**
 * 渠道码的访客黑名单。
 *
 * 三种用法压在一个命令里（list / add / remove），因为它们操作的是
 * 同一张表、在同一块后台面板里；分成三个命令反而要用户先想清楚
 * 「我这个动作属于哪一类」。默认 list，因为「先看看有哪些」是最常见的起点。
 */
async function cmdBlocks(cfg, flags) {
  const action = String(flags.action ?? 'list');
  if (!['list', 'add', 'remove'].includes(action)) {
    fail(`--action 只支持 list / add / remove，收到「${action}」`);
  }

  const extra = { dv1_action: action };
  if (action === 'list' || action === 'add') {
    extra.dv1_slug = need(flags, 'slug', '用 --slug 指定渠道码');
  }
  if (action === 'add') extra.dv1_ip = need(flags, 'ip', '要拉黑的访客 IP');
  if (action === 'remove') extra.dv1_id = Number(need(flags, 'id', '黑名单记录 id（从 list 里拿）'));

  const body = buildBody(cfg, grantTags(flags), extra);
  const payload = await call(cfg, '/v1/channels/blocks', body, { dryRun: flags['dry-run'] });
  if (!payload || flags['dry-run']) return payload;
  if (flags.json) return printJson(payload);

  if (action === 'add') {
    process.stdout.write('已加入黑名单。\n');
    return payload;
  }
  if (action === 'remove') {
    process.stdout.write('已移出黑名单。\n');
    return payload;
  }

  const items = payload.blocks ?? [];
  if (!items.length) {
    process.stdout.write('（黑名单为空）\n');
    return payload;
  }
  table(items, [
    { label: 'id', value: (row) => row.id },
    { label: '访客标识', value: (row) => row.ipHash },
    { label: '加入时间', value: (row) => row.createdAt },
  ]);
  return payload;
}

/* ---------------- 后台类命令 ---------------- */

/**
 * 后台类动作的参数翻译。
 *
 * 键是「动作 → 字段名 → 取值函数」，值跑一遍就得到请求体。
 * 写成表而不是一长串 if，是为了让「哪个动作要哪些参数」一眼可读 ——
 * 这份表和目录（GET /open/v1）描述的是同一件事，改的时候容易对照。
 */
const ADMIN_FIELDS = {
  domains: {
    create: (flags) => ({ dv1_host: need(flags, 'host', '域名'), dv1_kind: flags.kind, dv1_remark: textOrNull(flags.remark) }),
    update: (flags) => pick({ dv1_id: numId(flags), dv1_host: flags.host, dv1_kind: flags.kind, dv1_remark: textOrNull(flags.remark) }),
    delete: (flags) => ({ dv1_id: numId(flags) }),
    probe: (flags) => ({ dv1_host: need(flags, 'host', '域名') }),
    list: (flags) => pick({ dv1_kind: flags.kind }),
  },
  cardkeys: {
    list: (flags) => pick({ dv1_page: num(flags.page), dv1_page_size: num(flags['page-size']), dv1_keyword: flags.keyword }),
    get: (flags) => ({ dv1_id: numId(flags) }),
    create: (flags) => pick({
      dv1_name: need(flags, 'name', '批次名称'),
      dv1_content: flags.content ?? '',
      dv1_count: num(flags.count) ?? 1,
      dv1_codes: flags.codes,
      dv1_expired_at: flags['expired-at'],
      dv1_redirect_url: flags['redirect-url'],
      dv1_low_stock: num(flags['low-stock']),
      dv1_notify_channel: num(flags['notify-channel']),
    }),
    update: (flags) => pick({
      dv1_id: numId(flags),
      dv1_name: flags.name,
      dv1_content: flags.content,
      dv1_status: flags.status,
      dv1_expired_at: flags['expired-at'],
      dv1_redirect_url: flags['redirect-url'],
      dv1_remark: textOrNull(flags.remark),
      dv1_low_stock: num(flags['low-stock']),
      dv1_notify_channel: num(flags['notify-channel']),
    }),
    delete: (flags) => ({ dv1_id: numId(flags) }),
    append: (flags) => pick({ dv1_id: numId(flags), dv1_count: num(flags.count) ?? 1, dv1_codes: flags.codes }),
  },
  assets: {
    list: (flags) => pick({ dv1_page: num(flags.page), dv1_page_size: num(flags['page-size']), dv1_kind: flags.kind, dv1_keyword: flags.keyword }),
    update: (flags) => pick({ dv1_id: numId(flags), dv1_filename: flags.filename, dv1_remark: textOrNull(flags.remark), dv1_kind: flags.kind }),
    delete: (flags) => ({ dv1_id: numId(flags) }),
  },
  'notify-channels': {
    list: () => ({}),
    create: (flags) => pick({
      dv1_name: need(flags, 'name', '渠道名'),
      dv1_kind: need(flags, 'kind', '渠道类型'),
      dv1_config: parseJsonFlag(flags.config),
      dv1_enabled: num(flags.enabled) ?? 1,
    }),
    update: (flags) => pick({
      dv1_id: numId(flags),
      dv1_name: flags.name,
      dv1_enabled: num(flags.enabled),
      dv1_config: parseJsonFlag(flags.config),
    }),
    delete: (flags) => ({ dv1_id: numId(flags) }),
    test: (flags) => ({ dv1_id: numId(flags) }),
  },
  users: {
    list: (flags) => pick({ dv1_page: num(flags.page), dv1_page_size: num(flags['page-size']), dv1_keyword: flags.keyword }),
    create: (flags) => pick({
      dv1_username: need(flags, 'username', '登录账号'),
      dv1_password: need(flags, 'password', '初始密码'),
      dv1_email: flags.email,
      dv1_role: flags.role,
      dv1_remark: textOrNull(flags.remark),
      dv1_group_id: num(flags['group-id']),
      dv1_expires_at: flags['expires-at'],
    }),
    // 注意没有改密：开放接口的凭证不该能替人改登录密码 ——
    // 一张泄露的 key 会因此升级成「接管后台账号」。
    update: (flags) => pick({
      dv1_id: numId(flags),
      dv1_email: flags.email,
      dv1_remark: textOrNull(flags.remark),
      dv1_group_id: num(flags['group-id']),
      dv1_expires_at: flags['expires-at'],
      dv1_user_status: flags['user-status'],
      dv1_role: flags.role,
    }),
    delete: (flags) => ({ dv1_id: numId(flags) }),
  },
  inspection: {
    list: (flags) => pick({ dv1_page: num(flags.page), dv1_page_size: num(flags['page-size']), dv1_kind: flags.kind }),
    run: () => ({}),
  },
  credentials: {
    list: () => ({}),
    create: (flags) => pick({ dv1_quota: num(flags.quota), dv1_expires_at: flags['expires-at'], dv1_ip_allowlist: flags['ip-allowlist'] }),
    update: (flags) => pick({
      dv1_id: numId(flags),
      dv1_credential_status: flags['credential-status'] ?? flags.status,
      dv1_quota: num(flags.quota),
      dv1_expires_at: flags['expires-at'],
      dv1_ip_allowlist: flags['ip-allowlist'],
    }),
    delete: (flags) => ({ dv1_id: numId(flags) }),
  },
  'stats-admin': {
    prune: (flags) => pick({ dv1_keep_days: num(flags['keep-days']) }),
    visitors: (flags) => pick({ dv1_page: num(flags.page), dv1_page_size: num(flags['page-size']) }),
    setting: (flags) => pick({ dv1_keep_days: num(flags['keep-days']) }),
    clear: () => ({}),
  },
};

/** 按扩展名推 MIME。服务端只认白名单里的那几种，所以映射表也只需覆盖它们。 */
function mimeOf(file) {
  const ext = String(file).toLowerCase().split('.').pop();
  const table = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };
  return table[ext] ?? 'application/octet-stream';
}

function num(value) {
  if (value === undefined || value === true || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function numId(flags) {
  const id = Number(need(flags, 'id', '要操作的记录 id'));
  if (!Number.isInteger(id) || id < 1) fail('--id 必须是 1 以上的整数');
  return id;
}

function textOrNull(value) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  return text || null;
}

function parseJsonFlag(value) {
  if (value === undefined || value === true) return undefined;
  try {
    return JSON.parse(String(value));
  } catch {
    fail('--config 必须是合法的 JSON，例如 --config \'{"webhook":"https://..."}\'');
  }
}

/** 丢掉 undefined 的键：传 undefined 上去会被当作「显式清空」。 */
function pick(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 后台类动作的执行。
 *
 * 素材上传单独走一条路：它的请求体是 multipart，签名字段和文件
 * 混在同一个表单里，不能按 JSON 发。
 */
async function cmdAdmin(cfg, flags, namespace, action) {
  if (namespace === 'assets' && action === 'upload') {
    return uploadAsset(cfg, flags);
  }

  const fields = ADMIN_FIELDS[namespace]?.[action];
  if (!fields) fail(`${namespace} 不支持动作「${action}」`);

  const extra = fields(flags);
  const body = buildBody(cfg, grantTags(flags), extra);
  const payload = await call(cfg, `/v1/${namespace}/${action}`, body, { dryRun: flags['dry-run'] });
  if (!payload || flags['dry-run']) return payload;
  if (flags.json) return printJson(payload);

  // 列表用表格，单条用键值对，一次性明文单独醒目提示 ——
  // 这三种形状各自对应「扫一眼」「核对一下」「赶紧存下来」三种意图，
  // 全用同一种输出会让人分不清哪一种是必须立刻处理的。
  if (payload.items) return printAdminList(namespace, payload);
  if (payload.blocks) return printAdminList(namespace, { ...payload, items: payload.blocks });

  process.stdout.write(`${namespace}/${action} 已完成。\n`);
  if (payload.item) printKeyValues(payload.item);
  if (payload.codes) printPlaintext('卡密明文', payload.codes);
  if (payload.apiSecret) {
    printPlaintext('新凭证密钥', [`DWZ_API_KEY=${payload.item.apiKey}`, `DWZ_API_SECRET=${payload.apiSecret}`]);
  }
  if (payload.result) {
    process.stdout.write(`  巡检结果：${formatValue(payload.result)}\n`);
  }
  return payload;
}

/** 列表：只挑几列关键的，别把整个对象铺出来。 */
function printAdminList(namespace, payload) {
  const items = payload.items ?? [];
  if (!items.length) {
    process.stdout.write('（没有数据）\n');
    return payload;
  }

  const columns = LIST_COLUMNS[namespace] ?? defaultColumns(items[0]);
  table(items, columns);
  process.stdout.write(`\n共 ${payload.total ?? items.length} 条\n`);
  return payload;
}

/** 列表展示列：越靠前越关键。只放「一眼要看的」，细节让人加 --json 自己取。 */
const LIST_COLUMNS = {
  users: [
    { label: 'id', value: (r) => r.id },
    { label: '账号', value: (r) => r.username },
    { label: '角色', value: (r) => r.role },
    { label: '状态', value: (r) => r.status },
    { label: '用户组', value: (r) => r.groupName ?? '—' },
  ],
  domains: [
    { label: 'id', value: (r) => r.id },
    { label: '域名', value: (r) => r.host },
    { label: '类型', value: (r) => r.kind },
    { label: '备注', value: (r) => r.remark ?? '—' },
  ],
  cardkeys: [
    { label: 'id', value: (r) => r.id },
    { label: '批次', value: (r) => r.name },
    { label: '剩余/总数', value: (r) => `${r.remaining}/${r.total}` },
    { label: '状态', value: (r) => r.status },
  ],
  assets: [
    { label: 'id', value: (r) => r.id },
    { label: '文件名', value: (r) => r.filename },
    { label: '地址', value: (r) => r.url },
    { label: '备注', value: (r) => r.remark ?? '—' },
  ],
  credentials: [
    { label: 'id', value: (r) => r.id },
    { label: 'apiKey', value: (r) => r.apiKey },
    { label: '已用/配额', value: (r) => (r.quota === null ? `${r.used} / 不限` : `${r.used} / ${r.quota}`) },
    { label: '状态', value: (r) => r.status },
  ],
  inspection: [
    { label: 'id', value: (r) => r.id },
    { label: '类型', value: (r) => r.kind },
    { label: '目标', value: (r) => r.target },
    { label: '结果', value: (r) => (r.ok ? 'ok' : `失败 ${r.detail ?? ''}`.trim()) },
  ],
  'notify-channels': [
    { label: 'id', value: (r) => r.id },
    { label: '名称', value: (r) => r.name },
    { label: '类型', value: (r) => r.kindLabel ?? r.kind },
    { label: '启用', value: (r) => (r.enabled ? '是' : '否') },
  ],
};

function defaultColumns(sample) {
  return Object.keys(sample).map((key) => ({ label: key, value: (row) => formatValue(row[key]) }));
}

function printKeyValues(item) {
  for (const [key, value] of Object.entries(item)) {
    process.stdout.write(`  ${key}: ${formatValue(value)}\n`);
  }
}

/**
 * 一次性明文（卡密 / 新密钥）。
 *
 * 单独一段加粗提示，是因为这些东西**关掉终端就再也拿不到了** ——
 * 混在其它输出里，用户很容易滚屏过去才发现没存。
 */
function printPlaintext(label, lines) {
  process.stdout.write(`\n${label}（只显示这一次，请立刻保存）：\n`);
  for (const line of lines) process.stdout.write(`  ${line}\n`);
}

function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 素材上传：multipart/form-data。
 *
 * 签名规则与 JSON 请求完全一样（只签那几个 tag 位），差别只在
 * 「怎么把参数送上去」——所以签名逻辑复用同一段，不另写一份。
 */
async function uploadAsset(cfg, flags) {
  const file = need(flags, 'file', '本地图片路径');
  const { readFile } = await import('node:fs/promises');
  const { basename } = await import('node:path');

  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    fail(`读不到文件 ${file}：${error?.message ?? error}`);
  }

  const tags = grantTags(flags);
  const sign = signPayload(cfg, tags);
  const form = new FormData();
  form.set('dv1_title', '');
  form.set('dv1_type', '');
  form.set('dv1_url', '');
  if (tags.grant) form.set('dv1_grant', tags.grant);
  form.set('api_key', cfg.apiKey);
  form.set('sign', sign);
  if (flags.remark !== undefined) form.set('dv1_remark', String(flags.remark));
  // Blob 的 type 必须显式给：不给就会以 application/octet-stream 发出去，
  // 而服务端按 MIME 白名单卡格式 —— 结果是「明明选对了图，却报格式不支持」。
  form.set('file', new Blob([bytes], { type: mimeOf(file) }), basename(file));

  if (flags['dry-run']) {
    process.stdout.write(`POST ${cfg.origin}/open/v1/assets/upload\n`);
    process.stdout.write(`（multipart，文件 ${file}，${bytes.byteLength} 字节）\n`);
    return null;
  }

  const response = await fetch(`${cfg.origin}/open/v1/assets/upload`, { method: 'POST', body: form });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    fail(`服务返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) fail(payload?.msg ?? `上传失败（HTTP ${response.status}）`);
  if (flags.json) return printJson(payload);

  process.stdout.write(`已上传：${payload.item.filename}\n地址：${payload.item.url}\n`);
  process.stdout.write('\n这个地址可以直接喂给 qrcodes create --image。\n');
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

  if (first === 'merges') {
    if (!MERGE_ACTIONS.includes(second)) {
      fail(`未知动作「${second ?? ''}」，merges 可用：${MERGE_ACTIONS.join(' / ')}`);
    }
    return cmdMerge(cfg, flags, second);
  }

  if (first === 'channels' && second === 'blocks') {
    return cmdBlocks(cfg, flags);
  }

  if (ADMIN_NAMESPACES[first]) {
    if (!ADMIN_NAMESPACES[first].includes(second)) {
      fail(`未知动作「${second ?? ''}」，${first} 可用：${ADMIN_NAMESPACES[first].join(' / ')}`);
    }
    return cmdAdmin(cfg, flags, first, second);
  }

  if (!RESOURCES.includes(first)) {
    const names = [...RESOURCES, 'qrcodes', 'merges', ...Object.keys(ADMIN_NAMESPACES), 'stats', 'catalog', 'check'];
    fail(`未知资源「${first ?? ''}」，可用：${names.join(' / ')}`);
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
