import { api } from '../api.js';
import { h, mount } from '../dom.js';

export async function renderDashboard(root) {
  const [overview, detail] = await Promise.all([
    api.get('/api/stats'),
    api.get('/api/stats/detail?source=short_link&days=7').catch(() => ({ daily: [], hourly: [] })),
  ]);

  const cards = [
    { label: '短链', value: overview.links.total, today: overview.links.hitsToday, total: overview.links.hits },
    { label: '活码 / 客服码', value: overview.codes.total, today: overview.codes.hitsToday, total: overview.codes.hits },
    { label: '渠道码', value: overview.channels.total, today: overview.channels.hitsToday, total: overview.channels.hits },
    { label: '域名', value: overview.domains.total, today: null, total: null },
  ];

  const grid = h(
    'div',
    { class: 'grid' },
    cards.map((card) =>
      h('div', { class: 'stat' }, [
        h('div', { class: 'label' }, [card.label]),
        h('div', { class: 'value' }, [String(card.value)]),
        card.today !== null
          ? h('div', { class: 'sub' }, [`今日 ${card.today} 次 / 累计 ${card.total} 次`])
          : null,
      ]),
    ),
  );

  // 趋势图用纯 CSS 柱状图，不为一张图引入图表库
  const daily = detail.daily ?? [];
  const max = Math.max(1, ...daily.map((d) => d.hits));
  const chart = h(
    'div',
    { class: 'bar-chart' },
    daily.map((d) =>
      h('div', {
        class: 'bar',
        style: { height: `${Math.max(2, (d.hits / max) * 100)}%` },
        title: `${d.day}：${d.hits} 次`,
      }),
    ),
  );

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['概览']),
        h('span', { class: 'tag muted' }, [`统计日 ${overview.day}`]),
      ]),
      grid,
      h('div', { class: 'card' }, [
        h('div', { class: 'label', style: { color: 'var(--muted)', marginBottom: '8px' } }, [
          '短链访问量 · 近 7 天',
        ]),
        daily.length ? chart : h('div', { class: 'empty-state' }, ['暂无数据']),
        daily.length
          ? h('div', { class: 'row', style: { marginTop: '10px', fontSize: '12px', color: 'var(--muted)' } }, [
              h('span', {}, [daily[0].day]),
              h('span', { style: { textAlign: 'right' } }, [daily[daily.length - 1].day]),
            ])
          : null,
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'label', style: { color: 'var(--muted)', marginBottom: '12px' } }, [
          `独立访客 · ${detail.day ?? overview.day}`,
        ]),
        h('div', { class: 'grid' }, [
          h('div', { class: 'stat' }, [
            h('div', { class: 'label' }, ['今日访客']),
            h('div', { class: 'value' }, [String(detail.visitors?.visitorsToday ?? 0)]),
          ]),
          h('div', { class: 'stat' }, [
            h('div', { class: 'label' }, ['累计访客']),
            h('div', { class: 'value' }, [String(detail.visitors?.visitorsTotal ?? 0)]),
          ]),
        ]),
        h('div', { class: 'hint', style: { marginTop: '12px' } }, [
          '访客按 IP 单向哈希后按天去重统计，不保存原始 IP。',
        ]),
      ]),
    ]),
  );
}
