import { api } from '../api.js';
import { confirmDialog, copyToClipboard, formatTime, h, modal, mount, toast } from '../dom.js';

/** 卡密批次管理。明文只在生成时展示一次，因此单独用一个弹窗承载。 */
export async function renderCardkeys(root) {
  const state = { page: 1, pageSize: 20 };
  const list = h('div', {});

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      render(await api.get(`/api/cardkeys?page=${state.page}&pageSize=${state.pageSize}`));
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    const rows = data.items.map((item) =>
      h('tr', {}, [
        h('td', {}, [
          h('div', {}, [item.name]),
          h('div', { style: { color: 'var(--muted)', fontSize: '12px' } }, [item.content.slice(0, 40)]),
        ]),
        h('td', {}, [`${item.used} / ${item.total}`]),
        h('td', {}, [
          item.remaining <= item.lowStock && item.lowStock > 0
            ? h('span', { class: 'tag warn' }, [`剩 ${item.remaining}`])
            : String(item.remaining),
        ]),
        h('td', {}, [
          item.status === 'active' ? h('span', { class: 'tag ok' }, ['启用']) : h('span', { class: 'tag warn' }, ['暂停']),
        ]),
        h('td', { style: { color: 'var(--muted)', fontSize: '12px' } }, [
          item.expiredAt ? formatTime(item.expiredAt) : '不限',
        ]),
        h('td', {}, [
          h('div', { class: 'actions' }, [
            h('button', { class: 'link', onClick: () => openDetail(item) }, ['记录']),
            h('button', { class: 'link', onClick: () => append(item) }, ['补量']),
            h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog(`确定删除批次「${item.name}」？其下所有卡密与兑换记录都会一并删除。`)) return;
                await api.del(`/api/cardkeys/${item.id}`);
                toast('已删除', 'success');
                reload();
              },
            }, ['删除']),
          ]),
        ]),
      ]),
    );

    list.replaceChildren(
      data.items.length
        ? h('div', { class: 'card table-wrap' }, [
            h('table', {}, [
              h('thead', {}, [
                h('tr', {}, ['批次 / 内容', '已用 / 总数', '剩余', '状态', '到期', '操作'].map((l) => h('th', {}, [l]))),
              ]),
              h('tbody', {}, rows),
            ]),
          ])
        : h('div', { class: 'card empty-state' }, ['还没有卡密批次']),
      h('div', { class: 'pager' }, [
        h('span', {}, [`共 ${data.total} 条`]),
        h('button', { disabled: state.page <= 1, onClick: () => { state.page -= 1; reload(); } }, ['上一页']),
        h('span', {}, [`${state.page} / ${totalPages}`]),
        h('button', { disabled: state.page >= totalPages, onClick: () => { state.page += 1; reload(); } }, ['下一页']),
      ]),
    );
  }

  /** 明文卡密展示：只出现一次，提供一键复制全部。 */
  function showCodes(codes, message) {
    const textarea = h('textarea', { style: { minHeight: '160px' } });
    textarea.value = codes.join('\n');
    textarea.readOnly = true;

    const mask = h('div', { class: 'modal-mask' }, [
      h('div', { class: 'modal' }, [
        h('h2', {}, ['卡密已生成']),
        h('div', { class: 'notice-like hint', style: { color: 'var(--danger)' } }, [message]),
        h('div', { class: 'field' }, [textarea]),
        h('div', { class: 'modal-foot' }, [
          h('button', {
            onClick: async () => {
              const ok = await copyToClipboard(codes.join('\n'));
              toast(ok ? '已复制全部卡密' : '复制失败', ok ? 'success' : 'error');
            },
          }, ['复制全部']),
          h('button', { class: 'primary', onClick: () => mask.remove() }, ['我已保存']),
        ]),
      ]),
    ]);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) mask.remove();
    });
    document.body.append(mask);
  }

  async function create() {
    const channels = await api.get('/api/notify-channels').then((d) => d.items).catch(() => []);
    modal({
      title: '新建卡密批次',
      fields: [
        { name: 'name', label: '批次名称', required: true },
        { name: 'content', label: '卡密内容', type: 'textarea', required: true, hint: '兑换成功后返回给用户的内容' },
        { name: 'count', label: '生成数量', value: '10', required: true },
        { name: 'redirectUrl', label: '兑换后跳转', placeholder: '可选，https://' },
        { name: 'expiredAt', label: '到期时间', placeholder: '可选，如 2026-12-31 23:59:59' },
        { name: 'lowStock', label: '库存告警阈值', value: '0', hint: '0 表示不告警' },
        {
          name: 'notifyChannel',
          label: '告警渠道',
          type: 'select',
          value: '',
          options: [{ value: '', label: '不通知' }, ...channels.map((c) => ({ value: c.id, label: c.name }))],
        },
      ],
      submitText: '生成',
      onSubmit: async (values) => {
        const result = await api.post('/api/cardkeys', {
          ...values,
          count: Number(values.count),
          lowStock: Number(values.lowStock || 0),
          notifyChannel: values.notifyChannel || null,
          redirectUrl: values.redirectUrl || undefined,
          expiredAt: values.expiredAt || undefined,
        });
        reload();
        showCodes(result.codes, result.message);
      },
    });
  }

  function append(item) {
    modal({
      title: `为「${item.name}」补充卡密`,
      fields: [{ name: 'count', label: '生成数量', value: '10', required: true }],
      submitText: '生成',
      onSubmit: async (values) => {
        const result = await api.post(`/api/cardkeys/${item.id}/append`, { count: Number(values.count) });
        reload();
        showCodes(result.codes, result.message);
      },
    });
  }

  async function openDetail(item) {
    const detail = await api.get(`/api/cardkeys/${item.id}`);
    const rows = detail.redeems.length
      ? detail.redeems.map((row) =>
          h('tr', {}, [
            h('td', { class: 'copyable' }, [row.ipHint]),
            h('td', { style: { color: 'var(--muted)', fontSize: '12px', maxWidth: '220px', overflowWrap: 'anywhere' } }, [
              row.ua ?? '-',
            ]),
            h('td', {}, [row.day]),
            h('td', {}, [formatTime(row.createdAt)]),
          ]),
        )
      : null;

    const mask = h('div', { class: 'modal-mask' }, [
      h('div', { class: 'modal' }, [
        h('h2', {}, [`「${item.name}」兑换记录`]),
        h('div', { class: 'row', style: { marginBottom: '12px' } }, [
          h('div', {}, [`总数 ${detail.item.total}`]),
          h('div', {}, [`已用 ${detail.item.used}`]),
          h('div', {}, [`剩余 ${detail.item.remaining}`]),
        ]),
        rows
          ? h('div', { class: 'table-wrap' }, [
              h('table', {}, [
                h('thead', {}, [h('tr', {}, ['IP（哈希前缀）', 'UA', '日期', '时间'].map((l) => h('th', {}, [l])))]),
                h('tbody', {}, rows),
              ]),
            ])
          : h('div', { class: 'empty-state' }, ['还没有兑换记录']),
        h('div', { class: 'modal-foot' }, [h('button', { onClick: () => mask.remove() }, ['关闭'])]),
      ]),
    ]);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) mask.remove();
    });
    document.body.append(mask);
  }

  async function edit(item) {
    const channels = await api.get('/api/notify-channels').then((d) => d.items).catch(() => []);
    modal({
      title: '编辑批次',
      fields: [
        { name: 'name', label: '批次名称', value: item.name, required: true },
        { name: 'content', label: '卡密内容', type: 'textarea', value: item.content, required: true },
        {
          name: 'status',
          label: '状态',
          type: 'select',
          value: item.status,
          options: [{ value: 'active', label: '启用' }, { value: 'paused', label: '暂停' }],
        },
        { name: 'redirectUrl', label: '兑换后跳转', value: item.redirectUrl ?? '', placeholder: 'https://' },
        { name: 'lowStock', label: '库存告警阈值', value: String(item.lowStock) },
        {
          name: 'notifyChannel',
          label: '告警渠道',
          type: 'select',
          value: item.notifyChannel ?? '',
          options: [{ value: '', label: '不通知' }, ...channels.map((c) => ({ value: c.id, label: c.name }))],
        },
      ],
      onSubmit: async (values) => {
        await api.patch(`/api/cardkeys/${item.id}`, {
          ...values,
          lowStock: Number(values.lowStock || 0),
          notifyChannel: values.notifyChannel || null,
          redirectUrl: values.redirectUrl || null,
        });
        toast('已保存', 'success');
        reload();
      },
    });
  }

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['卡密']),
        h('button', { class: 'primary', onClick: create }, ['新建批次']),
      ]),
      list,
    ]),
  );

  await reload();
}
