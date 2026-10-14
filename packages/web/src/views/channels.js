import { api } from '../api.js';
import { confirmDialog, copyToClipboard, formatTime, h, modal, mount, toast } from '../dom.js';

export async function renderChannels(root, { shortOrigin }) {
  const state = { page: 1, pageSize: 20 };
  const list = h('div', {});

  function shortUrl(slug) {
    return `${(shortOrigin || window.location.origin).replace(/\/+$/, '')}/${slug}`;
  }

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      render(await api.get(`/api/channels?page=${state.page}&pageSize=${state.pageSize}`));
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    const rows = data.items.map((item) =>
      h('tr', {}, [
        h('td', { 'data-label': '标题 / 短链' }, [
          h('div', {}, [item.title]),
          h('div', { class: 'copyable', style: { color: 'var(--muted)' } }, [shortUrl(item.slug)]),
        ]),
        h('td', { 'data-label': '目标链接' }, [
          h('div', { class: 'copyable cell-clip' }, [item.targetUrl]),
        ]),
        h('td', { 'data-label': '访问限制' }, [h('span', { class: 'tag muted' }, [item.accessRule === 'wechat' ? '仅微信' : '不限制'])]),
        h('td', { 'data-label': '今日 / 累计' }, [`${item.hitsToday} / ${item.hits}`]),
        h('td', { 'data-label': '创建时间', style: { color: 'var(--muted)', fontSize: '12px' } }, [formatTime(item.createdAt)]),
        h('td', { 'data-label': '操作' }, [
          h('div', { class: 'actions' }, [
            h('button', {
              class: 'link',
              onClick: async () => {
                const ok = await copyToClipboard(shortUrl(item.slug));
                toast(ok ? '链接已复制' : '复制失败', ok ? 'success' : 'error');
              },
            }, ['复制']),
            h('button', { class: 'link', onClick: () => openDetail(item) }, ['数据']),
            h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog(`确定删除「${item.title}」？`)) return;
                await api.del(`/api/channels/${item.id}`);
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
                h('tr', {}, ['标题 / 链接', '目标链接', '限制', '今日 / 累计', '创建时间', '操作'].map((l) => h('th', {}, [l]))),
              ]),
              h('tbody', {}, rows),
            ]),
          ])
        : h('div', { class: 'card empty-state' }, ['还没有渠道码']),
      h('div', { class: 'pager' }, [
        h('span', {}, [`共 ${data.total} 条`]),
        h('button', { disabled: state.page <= 1, onClick: () => { state.page -= 1; reload(); } }, ['上一页']),
        h('span', {}, [`${state.page} / ${totalPages}`]),
        h('button', { disabled: state.page >= totalPages, onClick: () => { state.page += 1; reload(); } }, ['下一页']),
      ]),
    );
  }

  async function openDetail(item) {
    const detail = await api.get(`/api/channels/${item.id}`);

    const breakdown = detail.breakdown.length
      ? h('div', { class: 'table-wrap' }, [
          h('table', {}, [
            h('thead', {}, [h('tr', {}, ['来源 App', '操作系统', '来源数', '访问量'].map((l) => h('th', {}, [l])))]),
            h(
              'tbody',
              {},
              detail.breakdown.map((row) =>
                h('tr', {}, [row.app, row.os, String(row.sources), String(row.hits)].map((v) => h('td', {}, [v]))),
              ),
            ),
          ]),
        ])
      : h('div', { class: 'empty-state' }, ['还没有访问数据']);

    const ipInput = h('input', { placeholder: '例如 203.0.113.9' });
    const blockBtn = h('button', { class: 'primary' }, ['加入黑名单']);
    blockBtn.addEventListener('click', async () => {
      if (!ipInput.value) return toast('请填写 IP', 'error');
      blockBtn.disabled = true;
      try {
        await api.post(`/api/channels/${item.id}/blocks`, { ip: ipInput.value });
        toast('已加入黑名单', 'success');
        mask.remove();
        openDetail(item);
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        blockBtn.disabled = false;
      }
    });

    const blocks = detail.blocks.length
      ? h(
          'div',
          {},
          detail.blocks.map((row) =>
            h('div', { class: 'row', style: { alignItems: 'center', padding: '6px 0' } }, [
              h('span', { class: 'copyable' }, [`${row.ipHash.slice(0, 12)}…`]),
              h('span', { style: { color: 'var(--muted)', fontSize: '12px' } }, [formatTime(row.createdAt)]),
              h('button', {
                class: 'link',
                style: { color: 'var(--danger)', flex: '0 0 auto' },
                onClick: async () => {
                  await api.del(`/api/blocks/${row.id}`);
                  toast('已移出黑名单', 'success');
                  mask.remove();
                  openDetail(item);
                },
              }, ['移除']),
            ]),
          ),
        )
      : null;

    const mask = h('div', { class: 'modal-mask' }, [
      h('div', { class: 'modal' }, [
        h('h2', {}, [`「${item.title}」的来源数据`]),
        breakdown,
        h('div', { style: { borderTop: '1px solid var(--border)', marginTop: '16px', paddingTop: '16px' } }, [
          h('div', { class: 'field' }, [h('label', {}, ['封禁访客 IP']), ipInput]),
          blockBtn,
          h('div', { class: 'hint', style: { marginTop: '8px' } }, ['IP 以哈希形式保存，列表只展示前 12 位。']),
          blocks,
        ]),
        h('div', { class: 'modal-foot' }, [h('button', { onClick: () => mask.remove() }, ['关闭'])]),
      ]),
    ]);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) mask.remove();
    });
    document.body.append(mask);
  }

  async function edit(item) {
    modal({
      title: '编辑渠道码',
      fields: [
        { name: 'title', label: '标题', value: item.title, required: true },
        { name: 'targetUrl', label: '目标链接', value: item.targetUrl, required: true },
        {
          name: 'accessRule',
          label: '访问限制',
          type: 'select',
          value: item.accessRule,
          options: [{ value: 'any', label: '不限制' }, { value: 'wechat', label: '仅微信' }],
        },
        {
          name: 'status',
          label: '状态',
          type: 'select',
          value: item.status,
          options: [{ value: 'active', label: '启用' }, { value: 'paused', label: '暂停' }],
        },
      ],
      onSubmit: async (values) => {
        await api.patch(`/api/channels/${item.id}`, values);
        toast('已保存', 'success');
        reload();
      },
    });
  }

  async function create() {
    modal({
      title: '新建渠道码',
      fields: [
        { name: 'title', label: '标题', required: true },
        { name: 'targetUrl', label: '目标链接', required: true, placeholder: 'https://' },
        {
          name: 'accessRule',
          label: '访问限制',
          type: 'select',
          value: 'any',
          options: [{ value: 'any', label: '不限制' }, { value: 'wechat', label: '仅微信' }],
        },
        { name: 'slug', label: '自定义短链', hint: '留空则随机生成' },
      ],
      submitText: '创建',
      onSubmit: async (values) => {
        await api.post('/api/channels', { ...values, slug: values.slug || undefined });
        toast('创建成功', 'success');
        reload();
      },
    });
  }

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['渠道码']),
        h('button', { class: 'primary', onClick: create }, ['新建渠道码']),
      ]),
      list,
    ]),
  );

  await reload();
}
