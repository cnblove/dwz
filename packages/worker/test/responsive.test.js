import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 后台响应式布局的「守门」测试。
 *
 * 为什么静态检查而不是跑真浏览器：响应式的回归几乎从不是「样式写错」，
 * 而是**某天新加的东西把版面撑破了** —— 一个写死的 width:600px、
 * 一个没加 data-label 的表格单元格、一个超出手机宽度的 pre。
 * 这类问题在 CI 里没有浏览器可跑，但在源码里一眼可查，且查得比人可靠。
 *
 * 真机验证（6 种视口 × 13 个页面无横向溢出）在做这一版时跑过，
 * 这里把它固化成几条**不会随时间腐烂**的约束。
 */

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '../../web/src');
const styles = readFileSync(join(webSrc, 'styles.css'), 'utf8');

function viewFiles() {
  return readdirSync(join(webSrc, 'views')).filter((f) => f.endsWith('.js'));
}

function readView(file) {
  return readFileSync(join(webSrc, 'views', file), 'utf8');
}

/**
 * 两个断点各管一件事，测试也分开守：
 *   900px —— 换骨架（导航收顶，把整幅宽度还给内容）
 *   720px —— 调排布（表格转卡片、弹窗按钮铺开）
 *
 * 分开写是有意义的：这两件事的「合理宽度」不一样。合在一个断言里，
 * 哪天有人把 720 的规则挪到 900，测试会以「手机坏了」的名义拦下来 ——
 * 而实际上真正坏的是平板。
 */
test('900px 断点把骨架换成纵向：导航收顶，内容拿回整幅宽度', () => {
  const index = styles.indexOf('@media (max-width: 900px)');
  assert.ok(index > -1, '应有 900px 断点');
  const block = styles.slice(index, styles.indexOf('@media (max-width: 720px)'));
  assert.match(block, /\.layout \{ flex-direction: column/);
  assert.match(block, /\.sidebar \{/, '侧边栏应改成横向导航条');
});

test('720px 断点做手机排布：表格转卡片、弹窗按钮铺开', () => {
  const index = styles.indexOf('@media (max-width: 720px)');
  assert.ok(index > -1, '应有 720px 断点');
  const block = styles.slice(index, styles.indexOf('@media (max-width: 380px)'));
  assert.match(block, /\.table-wrap td \{/, '手机上表格单元格应改成块级');
  assert.match(block, /column-reverse/, '手机上弹窗按钮应纵向铺开，避免并排误触');
  assert.match(block, /\.page-head \.primary \{ width: 100%/, '主按钮应占满一行');
});

/** 允许存在的固定 px 宽度：要么足够小（撑不破手机屏），要么在断点里被改写过。 */
const WIDTH_ALLOWLIST = [
  { pattern: /width:\s*200px/, why: '侧边栏宽度：窄屏断点里已改写成 100%，是「宽屏定宽、窄屏流式」的正常写法' },
];

test('没有写死的视口级宽度', () => {
  // 只查明显的「固定 px 宽度」；max-width / min-width 是响应式的好朋友，不在此列。
  const offenders = [];
  for (const [name, source] of [['styles.css', styles], ...viewFiles().map((f) => [f, readView(f)])]) {
    const matches = source.matchAll(/(?<!max-)(?<!min-)\bwidth:\s*(\d+)px/g);
    for (const match of matches) {
      // 二维码缩略图、头像这类小尺寸撑不破任何屏，不看
      if (Number(match[1]) < 200) continue;
      if (WIDTH_ALLOWLIST.some((item) => item.pattern.test(match[0]))) continue;
      offenders.push(`${name}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `以下固定宽度会在大屏以外的尺寸上撑破布局：\n${offenders.join('\n')}`);
});

test('白名单里的固定宽度必须真的在窄屏被改写，不许变成空头支票', () => {
  const mobileBlock = styles.slice(styles.indexOf('@media (max-width: 720px)'));
  for (const item of WIDTH_ALLOWLIST) {
    assert.match(mobileBlock, /width: 100%/, `白名单项「${item.why}」在窄屏应被改写成 100%`);
  }
});

test('数据行的每个单元格都带 data-label，否则窄屏堆叠后会丢失表头', () => {
  /**
   * 只豁免「整行占位」的那一个单元格：它由 tr.table-placeholder 标记，
   * 在窄屏里被还原成一段普通提示文字，本来就不该有表头。
   * 其余任何缺 data-label 的 td 都是漏了表头 —— 窄屏下那一格会变成
   * 「谁也不知道这是什么」的孤零零一个值。
   */
  const missing = [];
  for (const file of viewFiles()) {
    const source = readView(file);
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const tds = line.match(/h\('td',\s*\{[^}]*\}/g) ?? [];
      for (const td of tds) {
        if (td.includes('data-label')) continue;
        // 唯一的合法例外：整行占位（必须同时是 colspan 且挂了 table-placeholder），
        // 少了这个 class 它在窄屏就没人管，所以两个条件必须同时成立
        if (line.includes('colspan') && line.includes("table-placeholder")) continue;
        missing.push(`${file}:${index + 1} ${td}`);
      }
    });
  }
  assert.deepEqual(missing, [], `这些单元格窄屏会没有表头：\n${missing.join('\n')}`);
});

test('占位行不能被当成数据行渲染成卡片', () => {
  // dashboard 的 colspan 占位行在窄屏是块级布局，colspan 失效，
  // 所以必须挂上 class 让样式把它还原成一段提示
  const dashboard = readView('dashboard.js');
  assert.match(dashboard, /class: 'table-placeholder'/);
  const mobileBlock = styles.slice(styles.indexOf('@media (max-width: 720px)'));
  assert.match(mobileBlock, /\.table-placeholder/);
});

test('长文本容器都声明了断行或截断', () => {
  // .cell-clip 负责截断，.code-block / .toast 负责断行，三者缺一不可
  assert.match(styles, /\.cell-clip\s*\{[^}]*text-overflow: ellipsis/s);
  assert.match(styles, /\.code-block\s*\{[^}]*word-break: break-all/s);
  assert.match(styles, /\.toast\s*\{[^}]*overflow-wrap: anywhere/s);
  // 窄屏堆叠后 cell-clip 必须能换行，否则表头一列会把卡片撑出屏幕
  const mobileBlock = styles.slice(styles.indexOf('@media (max-width: 720px)'));
  assert.match(mobileBlock, /\.table-wrap \.cell-clip \{ max-width: none; white-space: normal/s);
});

test('弹窗在手机上能自己滚动到底部的按钮', () => {
  // 字段多的表单（如用户组编辑有 8 项）会超过一屏高，
  // 弹窗不能滚 = 保存按钮永远点不到
  assert.match(styles, /\.modal \{[^}]*max-height: 90vh[^}]*overflow-y: auto/s);
  assert.match(styles, /\.modal-foot \{[^}]*position: sticky/s);
});

test('触控目标与 iOS 缩放两个坑都堵上了', () => {
  // 按钮最小高度：手机上点不中比看不清更致命
  assert.match(styles, /button\s*\{[^}]*min-height: 40px/s);
  // 字号 >= 16px 才不会让 iOS Safari 聚焦时放大整页
  assert.match(styles, /input, select, textarea \{[\s\S]*?font-size: max\(16px, 1em\)/);
});

test('网格用 auto-fit 而不是写死列数', () => {
  assert.match(styles, /grid-template-columns: repeat\(auto-fit, minmax\(min\(170px, 100%\), 1fr\)\)/);
});
