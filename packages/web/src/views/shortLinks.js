import { api } from '../api.js';
import { confirmDialog, copyToClipboard, formatTime, h, modal, mount, toast } from '../dom.js';

const ACCESS_LABELS = {
  any: '不限制',
  wechat: '仅微信',
  ios: '仅 iOS',
  android: '仅 Android',
  mobile: '仅手机浏览器',
  desktop: '仅电脑',
};

const ACCESS_OPTIONS = Object.entries(ACCESS_LABELS).map(([value, label]) => ({ value, label }));

export async function renderShortLinks(root, { shortOrigin }) {
  const state = { page: 1, pageSize: 20, keyword: '' };
  const list = h('div', {});

  const search = h('input', { placeholder: '搜索标题、短链或目标链接', style: { maxWidth: '260px' } });

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      const url = `/api/short-links?page=${state.page}&pageSize=${state.pageSize}&keyword=${encodeURIComponent(state.keyword)}`;
      render(await api.get(url));
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function shortUrl(slug) {
    const base = shortOrigin || window.location.origin;
    return `${base.replace(/\/+$/, '')}/${slug}`;
  }

  function render(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    const rows = data.items.map((item) =>
      h('tr', {}, [
        h('td', {}, [
          h('div', {}, [item.title]),
          h('div', { class: 'copyable', style: { color: 'var(--muted)' } }, [shortUrl(item.slug)]),
        ]),
        h('td', {}, [
          h('div', { class: 'copyable', style: { maxWidth: '260px', overflowWrap: 'anywhere' } }, [item.targetUrl]),
        ]),
        h('td', {}, [h('span', { class: 'tag muted' }, [ACCESS_LABELS[item.accessRule] ?? item.accessRule])]),
        h('td', {}, [
          item.status === 'active' ? h('span', { class: 'tag ok' }, ['启用']) : h('span', { class: 'tag warn' }, ['暂停']),
        ]),
        h('td', {}, [`${item.hitsToday} / ${item.hits}`]),
        h('td', { style: { color: 'var(--muted)', fontSize: '12px' } }, [formatTime(item.createdAt)]),
        h('td', {}, [
          h('div', { class: 'actions' }, [
            h('button', {
              class: 'link',
              onClick: async () => {
                const ok = await copyToClipboard(shortUrl(item.slug));
                toast(ok ? '短链已复制' : '复制失败', ok ? 'success' : 'error');
              },
            }, ['复制']),
            h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
            h('button', {
              class: 'link',
              onClick: async () => {
                await api.post(`/api/short-links/${item.id}/reset`);
                toast('统计已重置', 'success');
                reload();
              },
            }, ['重置统计']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog(`确定删除「${item.title}」？`)) return;
                await api.del(`/api/short-links/${item.id}`);
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
                h('tr', {}, ['标题 / 短链', '目标链接', '访问限制', '状态', '今日 / 累计', '创建时间', '操作'].map((label) => h('th', {}, [label]))),
              ]),
              h('tbody', {}, rows),
            ]),
          ])
        : h('div', { class: 'card empty-state' }, ['还没有短链，点右上角创建一条']),
      h('div', { class: 'pager' }, [
        h('span', {}, [`共 ${data.total} 条`]),
        h('button', { disabled: state.page <= 1, onClick: () => { state.page -= 1; reload(); } }, ['上一页']),
        h('span', {}, [`${state.page} / ${totalPages}`]),
        h('button', { disabled: state.page >= totalPages, onClick: () => { state.page += 1; reload(); } }, ['下一页']),
      ]),
    );
  }

  async function edit(item) {
    modal({
      title: '编辑短链',
      fields: [
        { name: 'title', label: '标题', value: item.title, required: true },
        { name: 'targetUrl', label: '目标链接', value: item.targetUrl, required: true },
        { name: 'accessRule', label: '访问限制', type: 'select', value: item.accessRule, options: ACCESS_OPTIONS },
        { name: 'urlIos', label: 'iOS 目标链接', value: item.urlIos ?? '', hint: '留空则使用通用目标链接' },
        { name: 'urlAndroid', label: 'Android 目标链接', value: item.urlAndroid ?? '', hint: '留空则使用通用目标链接' },
        { name: 'urlDesktop', label: '桌面端目标链接', value: item.urlDesktop ?? '', hint: '留空则使用通用目标链接' },
        {
          name: 'status',
          label: '状态',
          type: 'select',
          value: item.status,
          options: [{ value: 'active', label: '启用' }, { value: 'paused', label: '暂停' }],
        },
      ],
      onSubmit: async (values) => {
        await api.patch(`/api/short-links/${item.id}`, {
          ...values,
          urlIos: values.urlIos || null,
          urlAndroid: values.urlAndroid || null,
          urlDesktop: values.urlDesktop || null,
        });
        toast('已保存', 'success');
        reload();
      },
    });
  }

  async function create() {
    modal({
      title: '新建短链',
      fields: [
        { name: 'title', label: '标题', required: true, placeholder: '用于后台识别' },
        { name: 'targetUrl', label: '目标链接', required: true, placeholder: 'https://' },
        { name: 'accessRule', label: '访问限制', type: 'select', value: 'any', options: ACCESS_OPTIONS },
        { name: 'slug', label: '自定义短链', hint: '留空则随机生成；仅字母数字下划线连字符' },
        {
          name: 'length',
          label: '随机长度',
          type: 'select',
          value: '6',
          options: ['4', '5', '6', '7', '8'].map((v) => ({ value: v, label: `${v} 位` })),
          hint: '仅在未填自定义短链时生效',
        },
      ],
      submitText: '创建',
      onSubmit: async (values) => {
        await api.post('/api/short-links', {
          ...values,
          slug: values.slug || undefined,
          length: Number(values.length),
        });
        toast('创建成功', 'success');
        reload();
      },
    });
  }

  let debounce = null;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.keyword = search.value;
      state.page = 1;
      reload();
    }, 300);
  });

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['短链']),
        h('div', { class: 'actions' }, [search, h('button', { class: 'primary', onClick: create }, ['新建短链'])]),
      ]),
      list,
    ]),
  );

  await reload();
}
