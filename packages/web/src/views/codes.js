import { api } from '../api.js';
import { confirmDialog, copyToClipboard, formatTime, h, modal, mount, toast } from '../dom.js';

const KIND_LABELS = { group: '群活码', service: '客服码' };

export async function renderCodes(root, { shortOrigin }) {
  const state = { page: 1, pageSize: 20, kind: '' };
  const list = h('div', {});

  function shortUrl(slug) {
    return `${(shortOrigin || window.location.origin).replace(/\/+$/, '')}/${slug}`;
  }

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      const query = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
      if (state.kind) query.set('kind', state.kind);
      render(await api.get(`/api/codes?${query}`));
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    const rows = data.items.map((item) =>
      h('tr', {}, [
        h('td', {}, [
          h('div', {}, [item.title]),
          h('div', { class: 'copyable', style: { color: 'var(--muted)' } }, [shortUrl(item.slug)]),
        ]),
        h('td', {}, [h('span', { class: 'tag' }, [KIND_LABELS[item.kind] ?? item.kind])]),
        h('td', {}, [`${item.qrcodeActive} / ${item.qrcodeCount}`]),
        h('td', {}, [`${item.hitsToday} / ${item.hits}`]),
        h('td', {}, [
          item.status === 'active' ? h('span', { class: 'tag ok' }, ['启用']) : h('span', { class: 'tag warn' }, ['暂停']),
          item.sticky ? h('span', { class: 'tag muted', style: { marginLeft: '6px' } }, ['去重']) : null,
        ]),
        h('td', { style: { color: 'var(--muted)', fontSize: '12px' } }, [formatTime(item.createdAt)]),
        h('td', {}, [
          h('div', { class: 'actions' }, [
            h('button', {
              class: 'link',
              onClick: async () => {
                const ok = await copyToClipboard(shortUrl(item.slug));
                toast(ok ? '链接已复制' : '复制失败', ok ? 'success' : 'error');
              },
            }, ['复制']),
            h('button', { class: 'link', onClick: () => openQrcodes(item) }, ['子码']),
            h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog(`确定删除「${item.title}」及其全部子码？`)) return;
                await api.del(`/api/codes/${item.id}`);
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
                h('tr', {}, ['标题 / 链接', '类型', '可用子码', '今日 / 累计', '状态', '创建时间', '操作'].map((l) => h('th', {}, [l]))),
              ]),
              h('tbody', {}, rows),
            ]),
          ])
        : h('div', { class: 'card empty-state' }, ['还没有活码']),
      h('div', { class: 'pager' }, [
        h('span', {}, [`共 ${data.total} 条`]),
        h('button', { disabled: state.page <= 1, onClick: () => { state.page -= 1; reload(); } }, ['上一页']),
        h('span', {}, [`${state.page} / ${totalPages}`]),
        h('button', { disabled: state.page >= totalPages, onClick: () => { state.page += 1; reload(); } }, ['下一页']),
      ]),
    );
  }

  async function openQrcodes(item) {
    const detail = await api.get(`/api/codes/${item.id}`);

    const rows = detail.qrcodes.map((qr) =>
      h('div', { class: 'card', style: { padding: '12px' } }, [
        h('div', { class: 'row', style: { alignItems: 'center' } }, [
          h('img', { src: qr.imageUrl, style: { width: '64px', height: '64px', borderRadius: '6px', flex: '0 0 64px' } }),
          h('div', {}, [
            h('div', {}, [`阈值 ${qr.hits} / ${qr.threshold}`]),
            h('div', { style: { color: 'var(--muted)', fontSize: '12px' } }, [
              `长按 ${qr.longPress} 次${qr.contact ? ` · ${qr.contact}` : ''}`,
            ]),
          ]),
          h('div', { class: 'actions' }, [
            h('button', {
              class: 'link',
              onClick: async () => {
                await api.patch(`/api/qrcodes/${qr.id}`, { status: qr.status === 'active' ? 'disabled' : 'active' });
                toast('已更新', 'success');
                openQrcodes(item);
                reload();
              },
            }, [qr.status === 'active' ? '停用' : '启用']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog('确定删除该子码？')) return;
                await api.del(`/api/qrcodes/${qr.id}`);
                toast('已删除', 'success');
                openQrcodes(item);
                reload();
              },
            }, ['删除']),
          ]),
        ]),
      ]),
    );

    const imageUrl = h('input', { placeholder: 'https://example.com/qr.png', required: true });
    const threshold = h('input', { type: 'number', value: String(item.kind === 'group' ? 200 : 0), min: '0' });
    const contact = h('input', { placeholder: item.kind === 'group' ? '群主微信号' : '客服微信号' });
    const addBtn = h('button', { class: 'primary' }, ['添加子码']);

    const addForm = h('div', { style: { marginTop: '16px' } }, [
      h('div', { class: 'field' }, [h('label', {}, ['二维码图片地址']), imageUrl]),
      h('div', { class: 'row' }, [
        h('div', { class: 'field' }, [h('label', {}, ['展示阈值']), threshold]),
        h('div', { class: 'field' }, [h('label', {}, [item.kind === 'group' ? '群主微信号' : '客服微信号']), contact]),
      ]),
      addBtn,
    ]);

    addBtn.addEventListener('click', async () => {
      if (!imageUrl.value) return toast('请填写二维码地址', 'error');
      addBtn.disabled = true;
      try {
        await api.post(`/api/codes/${item.id}`, {
          imageUrl: imageUrl.value,
          threshold: Number(threshold.value),
          contact: contact.value,
        });
        toast('已添加', 'success');
        openQrcodes(item);
        reload();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        addBtn.disabled = false;
      }
    });

    const mask = h('div', { class: 'modal-mask' }, [
      h('div', { class: 'modal' }, [
        h('h2', {}, [`「${item.title}」的子码`]),
        ...(rows.length ? rows : [h('div', { class: 'empty-state' }, ['还没有上传子码'])]),
        h('div', { style: { borderTop: '1px solid var(--border)', marginTop: '16px' } }),
        addForm,
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
      title: '编辑活码',
      fields: [
        { name: 'title', label: '标题', value: item.title, required: true },
        {
          name: 'status',
          label: '状态',
          type: 'select',
          value: item.status,
          options: [{ value: 'active', label: '启用' }, { value: 'paused', label: '暂停' }],
        },
        {
          name: 'pickMode',
          label: '选取模式',
          type: 'select',
          value: item.pickMode,
          options: [
            { value: 'threshold', label: '阈值模式（按顺序消耗）' },
            { value: 'random', label: '随机模式' },
          ],
        },
        {
          name: 'sticky',
          label: '访客去重',
          type: 'select',
          value: item.sticky ? '1' : '0',
          hint: '同一访客固定展示同一张子码',
          options: [{ value: '0', label: '关闭' }, { value: '1', label: '开启' }],
        },
        {
          name: 'showSafety',
          label: '顶部安全提示',
          type: 'select',
          value: item.showSafety ? '1' : '0',
          options: [{ value: '1', label: '显示' }, { value: '0', label: '隐藏' }],
        },
        {
          name: 'showOnline',
          label: '在线状态',
          type: 'select',
          value: item.showOnline ? '1' : '0',
          hint: '仅客服码有意义',
          options: [{ value: '0', label: '隐藏' }, { value: '1', label: '显示' }],
        },
        { name: 'remark', label: '备注文案', type: 'textarea', value: item.remark ?? '' },
        { name: 'fallbackUrl', label: '兜底客服码', value: item.fallbackUrl ?? '', hint: '子码全部触顶后展示的二维码地址' },
        {
          name: 'fallbackOn',
          label: '启用兜底',
          type: 'select',
          value: item.fallbackOn ? '1' : '0',
          options: [{ value: '0', label: '关闭' }, { value: '1', label: '开启' }],
        },
      ],
      onSubmit: async (values) => {
        await api.patch(`/api/codes/${item.id}`, {
          title: values.title,
          status: values.status,
          pickMode: values.pickMode,
          sticky: values.sticky === '1',
          showSafety: values.showSafety === '1',
          showOnline: values.showOnline === '1',
          remark: values.remark,
          fallbackUrl: values.fallbackUrl || null,
          fallbackOn: values.fallbackOn === '1',
        });
        toast('已保存', 'success');
        reload();
      },
    });
  }

  async function create() {
    modal({
      title: '新建活码',
      fields: [
        {
          name: 'kind',
          label: '类型',
          type: 'select',
          value: 'group',
          options: [
            { value: 'group', label: '群活码（阈值轮换多个群二维码）' },
            { value: 'service', label: '客服码（展示客服微信）' },
          ],
        },
        { name: 'title', label: '标题', required: true },
        {
          name: 'pickMode',
          label: '选取模式',
          type: 'select',
          value: 'threshold',
          options: [
            { value: 'threshold', label: '阈值模式' },
            { value: 'random', label: '随机模式' },
          ],
        },
        { name: 'slug', label: '自定义短链', hint: '留空则随机生成' },
      ],
      submitText: '创建',
      onSubmit: async (values) => {
        await api.post('/api/codes', { ...values, slug: values.slug || undefined });
        toast('创建成功，记得上传子码', 'success');
        reload();
      },
    });
  }

  const kindFilter = h('select', { style: { maxWidth: '160px' } }, [
    h('option', { value: '' }, ['全部类型']),
    h('option', { value: 'group' }, ['群活码']),
    h('option', { value: 'service' }, ['客服码']),
  ]);
  kindFilter.addEventListener('change', () => {
    state.kind = kindFilter.value;
    state.page = 1;
    reload();
  });

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['活码与客服码']),
        h('div', { class: 'actions' }, [kindFilter, h('button', { class: 'primary', onClick: create }, ['新建活码'])]),
      ]),
      list,
    ]),
  );

  await reload();
}
