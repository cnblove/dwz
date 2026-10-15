import { api } from '../api.js';
import { formatTime, h, mount, toast } from '../dom.js';

const VISITOR_PAGE_SIZE = 10;

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
          '去重口径：访客 IP 加盐单向哈希后按天去重，哈希只用于计数、无法还原 IP。',
          h('br', {}),
          '下方「最近访客记录」另行保留原始 IP，用于判断来源与复访。',
        ]),
      ]),
      visitorSection(),
    ]),
  );
}

/**
 * 最近访客记录。
 *
 * 放在概览页而不是单独开一页：私域运营每天看的就是「今天谁来了、从哪来」，
 * 多一次点击就少看一次。翻页只重画表格，不动上面已经渲染好的卡片。
 */
function visitorSection() {
  const tbody = h('tbody', {});
  const pager = h('div', { class: 'pager' }, []);
  const note = h('div', { class: 'hint' }, ['加载中…']);
  const state = { page: 1, canManage: false };

  const table = h('table', {}, [
    h('thead', {}, [
      h('tr', {}, [
        h('th', {}, ['IP 地址']),
        h('th', {}, ['归属地']),
        h('th', {}, ['设备']),
        h('th', {}, ['系统 / 平台']),
        h('th', {}, ['访问类型']),
        h('th', {}, ['页面']),
        h('th', {}, ['次数']),
        h('th', {}, ['访问时间']),
      ]),
    ]),
    tbody,
  ]);

  /**
     * 占位行（加载中 / 出错 / 空）。
     *
     * 单独给一个 class 而不是沿用 colspan：窄屏下表格会转成块级堆叠，
     * colspan 在块级布局里没有意义，这一行会被当成一列「空表头」的单元格。
     * 由样式把它整行还原成普通的一段提示文字。
     */
  function placeholder(text) {
    tbody.replaceChildren(
      h('tr', { class: 'table-placeholder' }, [h('td', { colspan: '8' }, [h('div', { class: 'empty-state' }, [text])])]),
    );
  }

  async function load(page = state.page) {
    state.page = page;
    placeholder('加载中…');
    try {
      const data = await api.get(`/api/stats/visitors?page=${page}&pageSize=${VISITOR_PAGE_SIZE}`);
      state.canManage = data.canManage;
      note.replaceChildren(
        `共 ${data.total} 条记录 · ${data.note}`,
        data.canManage
          ? h('button', { class: 'link', style: { marginLeft: '8px' }, onClick: clearAll }, ['清空'])
          : null,
      );
      renderRows(data.items);
      renderPager(data);
    } catch (error) {
      placeholder(error.message);
    }
  }

  function renderRows(items) {
    if (!items.length) {
      placeholder('还没有访客记录，短链被访问后这里会实时出现');
      return;
    }
    tbody.replaceChildren(
      ...items.map((item) =>
        h('tr', {}, [
          h('td', { 'data-label': 'IP 地址' }, [h('span', { class: 'copyable' }, [item.ip])]),
          h('td', { 'data-label': '归属地' }, [item.country || '未知']),
          h('td', { 'data-label': '设备' }, [item.os || '未知']),
          h('td', { 'data-label': '系统 / 平台' }, [item.platform || item.app || '其它']),
          h('td', { 'data-label': '访问类型' }, [h('span', { class: 'tag muted' }, [item.sourceLabel])]),
          h('td', { 'data-label': '页面' }, [
            h('div', { class: 'copyable cell-clip', title: item.title ?? '' }, [
              item.title || item.slug || `#${item.pageId}`,
            ]),
          ]),
          h('td', { 'data-label': '次数' }, [String(item.hits)]),
          h('td', { 'data-label': '访问时间', style: { color: 'var(--muted)', fontSize: '12px' } }, [
            formatTime(item.lastSeenAt),
          ]),
        ]),
      ),
    );
  }

  function renderPager(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    pager.replaceChildren(
      h('button', { class: 'link', disabled: state.page <= 1, onClick: () => load(state.page - 1) }, ['上一页']),
      h('span', {}, [`第 ${state.page} / ${totalPages} 页`]),
      h(
        'button',
        { class: 'link', disabled: state.page >= totalPages, onClick: () => load(state.page + 1) },
        ['下一页'],
      ),
    );
  }

  async function clearAll() {
    if (!window.confirm('清空全部访客明细？该操作不可恢复，聚合统计不受影响。')) return;
    try {
      const result = await api.del('/api/stats/visitors');
      toast(`已清空 ${result.deleted} 条记录`, 'success');
      load(1);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  const section = h('div', { class: 'card' }, [
    h('div', { style: { marginBottom: '12px' } }, [
      h('div', { class: 'label', style: { color: 'var(--muted)' } }, ['最近访客记录']),
      note,
    ]),
    h('div', { class: 'table-wrap' }, [table]),
    pager,
  ]);

  load(1);
  return section;
}
