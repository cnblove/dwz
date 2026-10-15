import { badRequest, notFound, ok } from '../lib/http.js';
import { authorizeCall } from '../lib/openApiCore.js';
import { resolveSlug, releaseSlug } from '../lib/namespace.js';
import { nowSeconds, todayKey } from '../lib/time.js';
import { createResourceSchema, listResourceSchema, slugResourceSchema } from '../schemas/openResource.js';
import { RESOURCE_META } from './catalog.js';

/**
 * 对外资源的增删查。
 *
 * 三个资源（短链 / 活码 / 渠道码）表结构不同，但对外的动作形状一致，
 * 因此这里用「一张描述表 + 三小段 SQL」而不是三份复制粘贴：
 * 复制会让「开放接口只支持了短链」这种半成品状态悄悄固化下来。
 *
 * 权限口径与后台一致：凭证属于谁，就只能操作谁名下的资源。
 * owner 的凭证也一样按 user_id 过滤 —— 后台里 owner 能看到全部，
 * 但一个能被外部脚本持有的 key 不该顺带获得全局读写。
 */

/** 资源私有：只有凭证的主人能碰。 */
function ownedBy(row, cred) {
  return Boolean(row) && row.owner_id === cred.user_id;
}

const TABLE = {
  'short-links': 'short_links',
  codes: 'codes',
  channels: 'channels',
};

function serializer(resource) {
  if (resource === 'short-links') {
    return (row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      targetUrl: row.target_url,
      accessType: row.access_rule,
      status: row.status,
      urlIos: row.url_ios,
      urlAndroid: row.url_android,
      urlDesktop: row.url_desktop,
      rotateDomain: Boolean(row.rotate_domain),
      expiredAt: row.expired_at,
      expiredJump: row.expired_jump,
      hits: row.hits,
      hitsToday: row.hits_today_on === todayKey() ? row.hits_today : 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  if (resource === 'codes') {
    return (row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      kind: row.kind,
      status: row.status,
      hits: row.hits,
      hitsToday: row.hits_today_on === todayKey() ? row.hits_today : 0,
      pickMode: row.pick_mode,
      fallbackUrl: row.fallback_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return (row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    targetUrl: row.target_url,
    accessType: row.access_rule,
    status: row.status,
    hits: row.hits,
    hitsToday: row.hits_today_on === todayKey() ? row.hits_today : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function shortUrl(env, request, slug) {
  const origin = env.SHORT_ORIGIN || new URL(request.url).origin;
  return `${origin}/${slug}`;
}

/* ---------------- 动作 ---------------- */

export async function createResource(env, resource, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, createResourceSchema);
  const db = env.DB;
  const slug = await resolveSlug(db, { slug: input.dv1_slug });
  const now = nowSeconds();
  const meta = RESOURCE_META[resource];

  // 渠道码的访问限制只支持 any / wechat（表上有 CHECK），
  // 与其让数据库抛约束错误，不如在这里明确拒绝。
  if (resource === 'channels' && !['any', 'wechat'].includes(input.dv1_type)) {
    await releaseSlug(db, slug);
    throw badRequest('渠道码的 access_type 只支持 any 或 wechat');
  }

  // 三张表的插入语句各自不同，但都走同一条「插完按 id 回读」的路径 ——
  // 回读而不是拼装返回值，是为了保证对外看到的字段与库里的完全一致。
  const statements = {
    'short-links': () =>
      db
        .prepare(
          `INSERT INTO short_links (slug, title, target_url, access_rule, status, owner_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .bind(slug, input.dv1_title, input.dv1_url, input.dv1_type, cred.user_id, now, now),
    codes: () =>
      db
        .prepare(
          `INSERT INTO codes (slug, kind, title, status, owner_id, created_at, updated_at)
           VALUES (?, 'group', ?, 'active', ?, ?, ?)`,
        )
        .bind(slug, input.dv1_title, cred.user_id, now, now),
    channels: () =>
      db
        .prepare(
          `INSERT INTO channels (slug, title, status, target_url, access_rule, owner_id, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
        )
        .bind(slug, input.dv1_title, input.dv1_url, input.dv1_type, cred.user_id, now, now),
  };

  // 注意：D1 的 D1PreparedStatement（以及测试替身）是 thenable，
  // `await` 一个「返回已绑定语句」的箭头函数会连带 await 那条语句 ——
  // 中间的 `.meta` 就没了。所以这里显式 run()，而不是 await insert()。
  const result = await statements[resource]().run();
  const row = await db
    .prepare(`SELECT * FROM ${TABLE[resource]} WHERE id = ?`)
    .bind(result.meta?.last_row_id)
    .first();

  return ok({
    resource,
    type: meta.name,
    item: serializer(resource)(row),
    // 目标地址是「点开就能用」的那个；codes 的是落地页不是跳转
    url: shortUrl(env, request, slug),
    shortUrl: shortUrl(env, request, slug),
  });
}

export async function listResources(env, resource, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, listResourceSchema);
  const db = env.DB;
  const table = TABLE[resource];

  const where = ['owner_id = ?'];
  const params = [cred.user_id];
  if (input.dv1_keyword) {
    const like = `%${input.dv1_keyword}%`;
    where.push('(title LIKE ? OR slug LIKE ?)');
    params.push(like, like);
  }
  const clause = `WHERE ${where.join(' AND ')}`;

  const total = await db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${clause}`).bind(...params).first();
  const { results = [] } = await db
    .prepare(`SELECT * FROM ${table} ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...params, input.dv1_page_size, (input.dv1_page - 1) * input.dv1_page_size)
    .all();

  return ok({
    resource,
    type: RESOURCE_META[resource].name,
    total: total?.total ?? 0,
    page: input.dv1_page,
    pageSize: input.dv1_page_size,
    items: results.map(serializer(resource)),
  });
}

export async function getResource(env, resource, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, slugResourceSchema);
  const row = await env.DB.prepare(`SELECT * FROM ${TABLE[resource]} WHERE slug = ?`).bind(input.dv1_slug).first();
  if (!ownedBy(row, cred)) throw notFound(`${RESOURCE_META[resource].name}不存在`);

  const payload = { resource, type: RESOURCE_META[resource].name, item: serializer(resource)(row) };

  // 活码顺带给出子码，否则外部拿到宿主也看不出「这个活码有没有可用二维码」
  if (resource === 'codes') {
    const { results = [] } = await env.DB
      .prepare('SELECT * FROM code_qrcodes WHERE code_id = ? ORDER BY id')
      .bind(row.id)
      .all();
    payload.qrcodes = results.map((item) => ({
      id: item.id,
      imageUrl: item.image_url,
      contact: item.contact,
      threshold: item.threshold,
      hits: item.hits,
      status: item.status,
    }));
  }

  return ok(payload);
}

export async function deleteResource(env, resource, body, request) {
  const { cred, input } = await authorizeCall(env, request, body, slugResourceSchema);
  const db = env.DB;
  const row = await db.prepare(`SELECT * FROM ${TABLE[resource]} WHERE slug = ?`).bind(input.dv1_slug).first();
  if (!ownedBy(row, cred)) throw notFound(`${RESOURCE_META[resource].name}不存在`);

  await db.prepare(`DELETE FROM ${TABLE[resource]} WHERE id = ?`).bind(row.id).run();
  // 命名空间是三类资源共用的，删除时必须归还，否则 slug 会被永久占住
  await releaseSlug(db, row.slug);
  return ok({ resource, slug: row.slug, deleted: true });
}
