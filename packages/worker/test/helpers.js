/**
 * 轻量测试替身：
 * 用内存 SQLite（node:sqlite）跑真实 SQL，避免为了测试而 mock 掉数据层语义。
 * Workers 的 D1 接口形如 prepare().bind().first()/run()/all()，这里照抄一层壳。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function createDb() {
  const sqlite = new DatabaseSync(':memory:');
  const schema = readFileSync(join(here, '../migrations/0001_init.sql'), 'utf8');
  sqlite.exec(schema);

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
    async batch(statements) {
      return Promise.all(statements);
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

export function createEnv(overrides = {}) {
  return {
    DB: createDb(),
    VISITOR_SALT: 'test-salt',
    DEFAULT_KEY_LENGTH: '6',
    SHORT_ORIGIN: 'https://short.test',
    WEB_ORIGIN: 'https://web.test',
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

export function makeRequest(url, init = {}) {
  return new Request(url, init);
}
