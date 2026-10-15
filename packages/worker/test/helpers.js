/**
 * 轻量测试替身：
 * 用内存 SQLite（node:sqlite）跑真实 SQL，避免为了测试而 mock 掉数据层语义。
 * Workers 的 D1 接口形如 prepare().bind().first()/run()/all()，这里照抄一层壳。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../migrations');

/** 按文件名顺序执行全部迁移，保证测试库与线上结构一致。 */
function applyMigrations(sqlite) {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    sqlite.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
}

export function createDb() {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite);

  return {
    raw: sqlite,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              const stmt = sqlite.prepare(sql);
              return stmt.get(...normalize(params)) ?? null;
            },
            async all() {
              const stmt = sqlite.prepare(sql);
              return { results: stmt.all(...normalize(params)) };
            },
            async run() {
              const stmt = sqlite.prepare(sql);
              const info = stmt.run(...normalize(params));
              return {
                meta: {
                  changes: Number(info.changes),
                  last_row_id: Number(info.lastInsertRowid),
                },
              };
            },
          };
        },
        async first() {
          return sqlite.prepare(sql).get() ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all() };
        },
        async run() {
          const info = sqlite.prepare(sql).run();
          return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
        },
      };
    },
    /**
     * D1 的 batch：语句按顺序执行。
     * 测试替身里 bind() 返回的是普通对象，因此显式调用其 run()，
     * 与真实 D1 的「批量执行已绑定语句」语义对齐。
     */
    async batch(statements) {
      const out = [];
      for (const statement of statements) {
        out.push(await (typeof statement.run === 'function' ? statement.run() : statement));
      }
      return out;
    },
  };
}

/** SQLite 只接受 null/number/string/bigint/buffer，布尔与 undefined 需要归一。 */
function normalize(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return Number.isInteger(value) ? value : value;
    return value;
  });
}

/**
 * R2 桶替身：内存 Map 存对象，接口对齐 Workers R2Bucket 里我们用到的部分
 * （put / get / delete）。不 mock 掉语义，测的是「存进去能不能取出来」。
 */
export function createBucket(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async put(key, value, options = {}) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : typeof value === 'string'
          ? new TextEncoder().encode(value)
          : new Uint8Array(await new Response(value).arrayBuffer());
      store.set(key, { bytes, httpMetadata: options.httpMetadata ?? {} });
      return { key };
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: item.bytes,
        size: item.bytes.byteLength,
        httpEtag: `"${key}"`,
        httpMetadata: item.httpMetadata,
      };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

export function createEnv(overrides = {}) {
  return {
    DB: createDb(),
    VISITOR_SALT: 'test-salt',
    DEFAULT_KEY_LENGTH: '6',
    PASSWORD_ITERATIONS: '20000',
    SHORT_ORIGIN: 'https://short.test',
    WEB_ORIGIN: 'https://web.test',
    MEDIA: createBucket(),
    ...overrides,
  };
}

/** Workers 的 ExecutionContext 替身：waitUntil 同步收集，测试里可 await 到底。 */
export function createCtx() {
  const pending = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException() {},
    async settle() {
      await Promise.allSettled(pending);
    },
  };
}

export function uuid() {
  return crypto.randomUUID();
}

export function makeRequest(url, init = {}) {
  return new Request(url, init);
}
