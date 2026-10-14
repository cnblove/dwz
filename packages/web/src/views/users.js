import { api } from '../api.js';
import { confirmDialog, formatTime, h, modal, mount, toast } from '../dom.js';

export async function renderUsers(root, { currentUser }) {
  const list = h('div', {});

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      render(await api.get('/api/users?page=1&pageSize=100'));
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(data) {
    const rows = data.items.map((item) =>
      h('tr', {}, [
        h('td', { 'data-label': '账号' }, [item.username]),
        h('td', { 'data-label': '邮箱' }, [item.email ?? '-']),
        h('td', { 'data-label': '角色' }, [h('span', { class: 'tag' }, [item.role === 'owner' ? '超管' : '成员'])]),
        h('td', { 'data-label': '用户组' }, [item.groupName ?? '-']),
        h('td', { 'data-label': '状态' }, [
          item.status === 'active' ? h('span', { class: 'tag ok' }, ['正常']) : h('span', { class: 'tag warn' }, ['停用']),
        ]),
        h('td', { 'data-label': '到期' }, [item.expiresAt ? formatTime(item.expiresAt) : '不限']),
        h('td', { 'data-label': '操作' }, [
          h('div', { class: 'actions' }, [
            h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
            item.id === currentUser.id
              ? h('span', { style: { color: 'var(--muted)', fontSize: '12px' } }, ['当前账号'])
              : h('button', {
                  class: 'link',
                  style: { color: 'var(--danger)' },
                  onClick: async () => {
                    if (!confirmDialog(`确定删除账号「${item.username}」？`)) return;
                    try {
                      await api.del(`/api/users/${item.id}`);
                      toast('已删除', 'success');
                      reload();
                    } catch (error) {
                      toast(error.message, 'error');
                    }
                  },
                }, ['删除']),
          ]),
        ]),
      ]),
    );

    list.replaceChildren(
      h('div', { class: 'card table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, ['账号', '邮箱', '角色', '用户组', '状态', '到期', '操作'].map((l) => h('th', {}, [l])))]),
          h('tbody', {}, rows),
        ]),
      ]),
    );
  }

  async function edit(item) {
    const groups = await api.get('/api/groups').catch(() => ({ items: [] }));

    modal({
      title: `编辑「${item.username}」`,
      fields: [
        { name: 'email', label: '邮箱', value: item.email ?? '' },
        {
          name: 'role',
          label: '角色',
          type: 'select',
          value: item.role,
          options: [{ value: 'member', label: '成员' }, { value: 'owner', label: '超级管理员' }],
          hint: '不能修改自己的角色',
        },
        {
          name: 'groupId',
          label: '用户组',
          type: 'select',
          value: item.groupId ?? '',
          options: [{ value: '', label: '不分组' }, ...groups.items.map((g) => ({ value: g.id, label: g.name }))],
        },
        {
          name: 'status',
          label: '状态',
          type: 'select',
          value: item.status,
          options: [{ value: 'active', label: '正常' }, { value: 'disabled', label: '停用' }],
        },
        { name: 'remark', label: '备注', value: item.remark ?? '' },
        { name: 'password', label: '重置密码', type: 'password', hint: '留空则不修改' },
      ],
      onSubmit: async (values) => {
        const payload = {
          email: values.email,
          role: values.role,
          status: values.status,
          remark: values.remark,
          groupId: values.groupId || null,
        };
        if (values.password) payload.password = values.password;
        await api.patch(`/api/users/${item.id}`, payload);
        toast('已保存', 'success');
        reload();
      },
    });
  }

  async function create() {
    const groups = await api.get('/api/groups').catch(() => ({ items: [] }));

    modal({
      title: '新建账号',
      fields: [
        { name: 'username', label: '账号', required: true, hint: '字母、数字、下划线，3~32 位' },
        { name: 'password', label: '密码', type: 'password', required: true, hint: '至少 8 位' },
        { name: 'email', label: '邮箱' },
        {
          name: 'role',
          label: '角色',
          type: 'select',
          value: 'member',
          options: [{ value: 'member', label: '成员' }, { value: 'owner', label: '超级管理员' }],
        },
        {
          name: 'groupId',
          label: '用户组',
          type: 'select',
          value: '',
          options: [{ value: '', label: '不分组' }, ...groups.items.map((g) => ({ value: g.id, label: g.name }))],
        },
      ],
      submitText: '创建',
      onSubmit: async (values) => {
        await api.post('/api/users', { ...values, groupId: values.groupId || null });
        toast('已创建', 'success');
        reload();
      },
    });
  }

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['账号管理']),
        h('button', { class: 'primary', onClick: create }, ['新建账号']),
      ]),
      list,
    ]),
  );

  await reload();
}
