import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { json } from './http.js';

/**
 * 基于 zod 的请求校验（走 @hono/zod-validator）。
 *
 * 为什么替换掉手搓的 lib/validate.js：
 * 那套是每个 handler 里逐字段 if/throw，行数不少，但真正的坑是
 * 「必填」与「可选」的边界靠手写判断——比如 `body.title !== undefined` 这种
 * 写法，一旦某个字段忘了包一层 undefined 判断，就会把 undefined 写进库。
 * zod 把「字段是否出现」「默认值」「归一化」收敛成一份可读的 schema，
 * 校验规则和 handler 逻辑不再混在一起。
 *
 * 对外契约保持不变：校验失败仍是 400 + {code, msg}。
 */

/**
 * zod 错误 → 前端契约。
 *
 * zod 的 issue 里 message 已经是中文（schema 里逐字段写的），
 * 这里只负责取第一条并转成 {code: 400, msg}，不改变响应形状。
 */
export function formatZodError(error) {
  const issue = error.issues?.[0];
  if (!issue) return '请求参数不合法';

  // 路径能定位到具体字段时附上，前端表单可以直接提示
  const path = issue.path?.filter((p) => p !== '').join('.');
  return path ? issue.message : issue.message;
}

/**
 * zValidator 的封装：hook 里把错误转成统一的 {code, msg} 400。
 *
 * 用 `target` 区分 body/query/param —— zod 的 schema 天然能表达
 * 「可不传」「默认值」「归一化」，所以校验完的结果直接就是 handler 要的形态。
 */
export function validate(target, schema) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return json({ code: 400, msg: formatZodError(result.error) }, { status: 400 });
    }
  });
}

/** 便捷别名，语义更贴近调用点。 */
export const validateBody = (schema) => validate('json', schema);
export const validateQuery = (schema) => validate('query', schema);

export { z };
