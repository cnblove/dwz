import { api } from '../api.js';
import { formatTime, h, mount, toast } from '../dom.js';

/** 巡检日志：域名可达性与卡密库存两类记录。 */
export async function renderInspection(root) {
  const state = { page: 1, pageSize: 30, kind: '' };
  const list = h('div', {});

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      const query = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
      if (state.kind) query.set('kind', state.kind);
      render(await api.get(`/api/inspection?${query}`));
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    const rows = data.items.map((item) =>
      h('tr', {}, [
        h('td', {}, [h('span', { class: 'tag muted' }, [item.kind === 'domain' ? '域名' : '卡密'])]),
        h('td', { class: 'copyable' }, [item.target]),
        h('td', {}, [item.ok ? h('span', { class: 'tag ok' }, ['正常']) : h('span', { class: 'tag warn' }, ['异常'])]),
        h('td', {}, [item.status ? String(item.status) : '-']),
        h('td', {}, [item.latencyMs ? `${item.latencyMs}ms` : '-']),
        h('td', { style: { color: 'var(--muted)', maxWidth: '280px', overflowWrap: 'anywhere' } }, [item.detail ?? '-']),
        h('td', { style: { color: 'var(--muted)', fontSize: '12px' } }, [formatTime(item.createdAt)]),
      ]),
    );

    list.replaceChildren(
      data.items.length
        ? h('div', { class: 'card table-wrap' }, [
            h('table', {}, [
              h('thead', {}, [
                h('tr', {}, ['类型', '目标', '结果', 'HTTP', '耗时', '详情', '时间'].map((l) => h('th', {}, [l]))),
              ]),
              h('tbody', {}, rows),
            ]),
          ])
        : h('div', { class: 'card empty-state' }, ['还没有巡检记录']),
      h('div', { class: 'pager' }, [
        h('span', {}, [`共 ${data.total} 条`]),
        h('button', { disabled: state.page <= 1, onClick: () => { state.page -= 1; reload(); } }, ['上一页']),
        h('span', {}, [`${state.page} / ${totalPages}`]),
        h('button', { disabled: state.page >= totalPages, onClick: () => { state.page += 1; reload(); } }, ['下一页']),
      ]),
    );
  }

  const filter = h('select', { style: { maxWidth: '140px' } }, [
    h('option', { value: '', selected: true }, ['全部类型']),
    h('option', { value: 'domain' }, ['域名巡检']),
    h('option', { value: 'cardkey' }, ['卡密库存']),
  ]);
  filter.addEventListener('change', () => {
    state.kind = filter.value;
    state.page = 1;
    reload();
  });

  const runBtn = h('button', {}, ['立即巡检']);
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    try {
      const result = await api.post('/api/inspection/run');
      const domains = result.result.domains ?? {};
      toast(
        domains.skipped ? '域名巡检未开启，已跳过' : `巡检完成：${domains.checked ?? 0} 个域名，失败 ${domains.failed ?? 0} 个`,
        'success',
      );
      state.page = 1;
      reload();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      runBtn.disabled = false;
    }
  });

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['巡检日志']),
        h('div', { class: 'actions' }, [filter, runBtn]),
      ]),
      h('div', { class: 'hint', style: { marginBottom: '12px' } }, [
        'Cloudflare Cron 每 30 分钟触发一次巡检；域名开关在「域名」页配置，库存阈值在卡密批次里配置。',
      ]),
      list,
    ]),
  );

  await reload();
}
