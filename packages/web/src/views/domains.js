import { api } from '../api.js';
import { confirmDialog, h, modal, mount, toast } from '../dom.js';

const KIND_LABELS = { entry: '入口域名', landing: '落地域名', short: '短链域名', backup: '备用域名' };

export async function renderDomains(root) {
  const list = h('div', {});

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      const [domains, check] = await Promise.all([
        api.get('/api/domains'),
        api.get('/api/domain-check').catch(() => ({ item: null })),
      ]);
      render(domains.items, check.item);
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(items, check) {
    const rows = items.map((item) =>
      h('tr', {}, [
        h('td', { class: 'copyable', 'data-label': '域名' }, [item.host]),
        h('td', { 'data-label': '类型' }, [h('span', { class: 'tag' }, [KIND_LABELS[item.kind] ?? item.kind])]),
        h('td', { 'data-label': '备注', style: { color: 'var(--muted)' } }, [item.remark ?? '-']),
        h('td', { 'data-label': '操作' }, [
          h('div', { class: 'actions' }, [
            h('button', {
              class: 'link',
              onClick: async () => {
                toast('正在探测…');
                try {
                  const result = await api.post('/api/domains/probe', { host: item.host });
                  toast(
                    result.reachable ? `可达，HTTP ${result.status}，${result.latencyMs}ms` : `不可达：${result.error ?? '连接失败'}`,
                    result.reachable ? 'success' : 'error',
                  );
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            }, ['探测']),
            h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog(`确定删除域名 ${item.host}？`)) return;
                await api.del(`/api/domains/${item.id}`);
                toast('已删除', 'success');
                reload();
              },
            }, ['删除']),
          ]),
        ]),
      ]),
    );

    const checkCard = h('div', { class: 'card' }, [
      h('div', { class: 'label', style: { color: 'var(--muted)', marginBottom: '10px' } }, ['域名可用性巡检']),
      h('div', { class: 'row', style: { alignItems: 'center' } }, [
        h('span', {}, [`当前状态：${check?.enabled ? '已开启' : '已关闭'}`]),
        h('span', { style: { color: 'var(--muted)', fontSize: '12px' } }, [
          check?.backupHost ? `备用域名：${check.backupHost}` : '未配置备用域名',
        ]),
        h('button', {
          class: 'link',
          flex: '0 0 auto',
          onClick: async () => {
            await api.patch('/api/domain-check', { enabled: !check?.enabled });
            toast('已更新', 'success');
            reload();
          },
        }, [check?.enabled ? '关闭巡检' : '开启巡检']),
      ]),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, [
        '巡检通过 Cloudflare Cron 触发，域名不可达时按配置的通知渠道告警。',
      ]),
    ]);

    list.replaceChildren(
      h('div', { class: 'card table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, ['域名', '类型', '备注', '操作'].map((l) => h('th', {}, [l])))]),
          h('tbody', {}, rows),
        ]),
      ]),
      items.length ? null : h('div', { class: 'card empty-state' }, ['还没有配置域名']),
      checkCard,
    );
  }

  async function edit(item) {
    modal({
      title: '编辑域名',
      fields: [
        { name: 'host', label: '域名', value: item.host, required: true },
        {
          name: 'kind',
          label: '类型',
          type: 'select',
          value: item.kind,
          options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
        },
        { name: 'remark', label: '备注', value: item.remark ?? '' },
      ],
      onSubmit: async (values) => {
        await api.patch(`/api/domains/${item.id}`, values);
        toast('已保存', 'success');
        reload();
      },
    });
  }

  async function create() {
    modal({
      title: '新增域名',
      fields: [
        { name: 'host', label: '域名', required: true, placeholder: 'go.example.com', hint: '只填域名，不要带协议和路径' },
        {
          name: 'kind',
          label: '类型',
          type: 'select',
          value: 'entry',
          options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
        },
        { name: 'remark', label: '备注' },
      ],
      submitText: '添加',
      onSubmit: async (values) => {
        await api.post('/api/domains', values);
        toast('已添加', 'success');
        reload();
      },
    });
  }

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['域名']),
        h('button', { class: 'primary', onClick: create }, ['新增域名']),
      ]),
      list,
    ]),
  );

  await reload();
}
