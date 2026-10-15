import { api } from '../api.js';
import { confirmDialog, h, modal, mount, replaceChildren, toast } from '../dom.js';

/**
 * 用户组。
 *
 * 从「账号」页里拆出来单独成页，是因为这一页现在管两件事：
 *   1. 组里的人能看到哪些页面（nav_list）；
 *   2. 组里的人能建多少东西（配额）。
 * 两件事都是「同一批人共享的一份配置」，所以留在组上；混在账号列表里改，
 * 等于让人逐个账号去猜自己属于哪个组、组里配的是什么。
 */

/** 配额项：接口字段 → 展示名。与后端 QUOTA_RESOURCES 一一对应。 */
export const QUOTA_ITEMS = [
  { key: 'shortLinks', field: 'quotaShortLinks', label: '短链' },
  { key: 'codes', field: 'quotaCodes', label: '活码' },
  { key: 'qrcodes', field: 'quotaQrcodes', label: '子码' },
  { key: 'channels', field: 'quotaChannels', label: '渠道码' },
  { key: 'assets', field: 'quotaAssets', label: '素材' },
];

/** 后台可见页面，与 main.js 的 ROUTES 对应。配错了等于给组多开/少开一页。 */
const NAV_OPTIONS = [
  ['dashboard', '概览'],
  ['short-links', '短链'],
  ['codes', '活码'],
  ['channels', '渠道码'],
  ['domains', '域名'],
  ['cardkeys', '卡密'],
  ['assets', '素材库'],
  ['api-keys', 'API Key'],
  ['settings', '设置'],
];

function quotaText(group) {
  const parts = QUOTA_ITEMS
    .filter((item) => group.quota?.[item.key] !== null && group.quota?.[item.key] !== undefined)
    .map((item) => `${item.label} ${group.quota[item.key]}`);
  return parts;
}

export async function renderGroups(root) {
  const list = h('div', {});

  async function reload() {
    replaceChildren(list, h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      render(await api.get('/api/groups'));
    } catch (error) {
      replaceChildren(list, h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(data) {
    const rows = data.items.map((item) => {
      const quotas = quotaText(item);
      return h('tr', {}, [
        h('td', { 'data-label': '名称' }, [item.name]),
        h('td', { 'data-label': '可见页面' }, [
          item.navList?.length ? `${item.navList.length} 个` : h('span', { class: 'tag muted' }, ['默认']),
        ]),
        h('td', { 'data-label': '创建配额' }, [
          quotas.length
            ? h('div', { class: 'chips' }, quotas.map((text) => h('span', { class: 'tag' }, [text])))
            : h('span', { class: 'tag muted' }, ['不限制']),
        ]),
        h('td', { 'data-label': '操作' }, [
          h('div', { class: 'actions' }, [
            h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog(`确定删除用户组「${item.name}」？组内账号会变成不分组。`)) return;
                await api.del(`/api/groups/${item.id}`);
                toast('已删除', 'success');
                reload();
              },
            }, ['删除']),
          ]),
        ]),
      ]);
    });

    replaceChildren(
      list,
      h('div', { class: 'card' }, [
        h('div', { class: 'label' }, ['配额怎么算']),
        h('div', { class: 'hint' }, [
          '配额是「每类资源能建多少个」的上限，留空表示不限制 —— 空和不限是一回事，不用填一个很大的数字。',
          '统计口径是「该成员名下现有多少」，所以删掉一条就腾出一个位置。',
          '超管不受配额约束（避免一个填错的数字把整个后台锁死）；改了配额立即生效，组内成员不用重新登录。',
        ]),
      ]),
      h('div', { class: 'card table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, ['名称', '可见页面', '创建配额', '操作'].map((l) => h('th', {}, [l])))]),
          h('tbody', {}, rows),
        ]),
      ]),
      data.items.length ? null : h('div', { class: 'card empty-state' }, ['还没有用户组']),
    );
  }

  /**
   * 组的编辑表单。
   *
   * 配额一律用文本框而不是数字框：空值要能表达「不限制」。
   * `<input type="number">` 在多数浏览器里留空是空串、又是同一个样式，
   * 和「填 0」长得太像，而 0 是「一个也不许建」——这两个语义差得太远。
   */
  function groupFields(group) {
    return [
      { name: 'name', label: '名称', value: group?.name ?? '', required: true },
      {
        name: 'navList',
        label: '可见页面',
        type: 'textarea',
        value: (group?.navList ?? []).join('\n'),
        hint: `一行一个，留空表示跟随默认。可选：${NAV_OPTIONS.map(([, label]) => label).join(' / ')}`,
      },
      ...QUOTA_ITEMS.map((item) => ({
        name: item.field,
        label: `${item.label}配额`,
        value: group?.quota?.[item.key] ?? '',
        placeholder: '留空 = 不限制',
        inputMode: 'numeric',
      })),
    ];
  }

  /** 表单值 → 接口 body。空串归一成 null（显式的不限额），未填的字段不传。 */
  function toPayload(values, { partial = false } = {}) {
    const payload = {};
    if (!partial || values.name !== '') payload.name = values.name;

    // 可见页面：把中文标签也认下来，省得用户去背路径
    const labels = new Map(NAV_OPTIONS);
    const paths = String(values.navList ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const hit = NAV_OPTIONS.find(([path, label]) => path === line || label === line);
        return hit ? hit[0] : line;
      });
    payload.navList = paths;

    for (const item of QUOTA_ITEMS) {
      const raw = String(values[item.field] ?? '').trim();
      if (raw === '') payload[item.field] = null;
      else payload[item.field] = Number(raw);
    }
    return payload;
  }

  function edit(item) {
    modal({
      title: `编辑「${item.name}」`,
      fields: groupFields(item),
      onSubmit: async (values) => {
        await api.patch(`/api/groups/${item.id}`, toPayload(values, { partial: true }));
        toast('已保存', 'success');
        reload();
      },
    });
  }

  function create() {
    modal({
      title: '新建用户组',
      fields: groupFields(null),
      submitText: '创建',
      onSubmit: async (values) => {
        await api.post('/api/groups', toPayload(values));
        toast('已创建', 'success');
        reload();
      },
    });
  }

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['用户组']),
        h('button', { class: 'primary', onClick: create }, ['新建用户组']),
      ]),
      list,
    ]),
  );

  await reload();
}
