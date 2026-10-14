import { api, auth, setToken } from '../api.js';
import { h, mount, toast, copyToClipboard, formatTime } from '../dom.js';

export async function renderSettings(root, { user, onLogout }) {
  const credentials = h('div', { class: 'card' }, [h('div', { class: 'empty-state' }, ['加载中…'])]);

  async function loadCredentials() {
    const data = await api.get('/api/credentials');
    credentials.replaceChildren(
      h('div', { class: 'label', style: { color: 'var(--muted)', marginBottom: '10px' } }, ['开放 API 凭证']),
      data.items.length
        ? h('div', { class: 'table-wrap' }, [
            h('table', {}, [
              h('thead', {}, [
                h('tr', {}, ['apiKey', '密钥', '配额', '状态', '到期', '操作'].map((l) => h('th', {}, [l]))),
              ]),
              h(
                'tbody',
                {},
                data.items.map((item) =>
                  h('tr', {}, [
                    h('td', { class: 'copyable' }, [item.apiKey]),
                    h('td', { class: 'copyable', style: { color: 'var(--muted)' } }, [item.secretHint]),
                    h('td', {}, [`${item.used} / ${item.quota}`]),
                    h('td', {}, [
                      item.status === 'active' ? h('span', { class: 'tag ok' }, ['启用']) : h('span', { class: 'tag warn' }, ['停用']),
                    ]),
                    h('td', {}, [item.expiresAt ? formatTime(item.expiresAt) : '不限']),
                    h('td', {}, [
                      h('div', { class: 'actions' }, [
                        h('button', {
                          class: 'link',
                          onClick: async () => {
                            await api.patch(`/api/credentials/${item.id}`, {
                              status: item.status === 'active' ? 'paused' : 'active',
                            });
                            toast('已更新', 'success');
                            loadCredentials();
                          },
                        }, [item.status === 'active' ? '停用' : '启用']),
                        h('button', {
                          class: 'link',
                          style: { color: 'var(--danger)' },
                          onClick: async () => {
                            await api.del(`/api/credentials/${item.id}`);
                            toast('已删除', 'success');
                            loadCredentials();
                          },
                        }, ['删除']),
                      ]),
                    ]),
                  ]),
                ),
              ),
            ]),
          ])
        : h('div', { class: 'empty-state' }, ['还没有创建凭证']),
      h('button', { class: 'primary', style: { marginTop: '14px' }, onClick: createCredential }, ['创建凭证']),
      h('div', { class: 'hint', style: { marginTop: '10px' } }, [
        '签名算法：HMAC-SHA256(secret, "标题|限制|目标链接|apiKey|apiSecret")，结果以 hex 传参。',
      ]),
    );
  }

  async function createCredential() {
    const result = await api.post('/api/credentials', {});
    await copyToClipboard(`apiKey: ${result.item.apiKey}\napiSecret: ${result.item.apiSecret}`);
    toast('凭证已创建，并已复制到剪贴板（密钥只显示一次）', 'success');
    loadCredentials();
  }

  const currentPassword = h('input', { type: 'password', placeholder: '当前密码' });
  const newPassword = h('input', { type: 'password', placeholder: '新密码（至少 8 位）' });
  const changeBtn = h('button', { class: 'primary' }, ['修改密码']);
  changeBtn.addEventListener('click', async () => {
    changeBtn.disabled = true;
    try {
      await auth.changePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value });
      toast('密码已更新，请重新登录', 'success');
      setToken('');
      await onLogout();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      changeBtn.disabled = false;
    }
  });

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [h('h1', {}, ['设置'])]),
      h('div', { class: 'card' }, [
        h('div', { class: 'label', style: { color: 'var(--muted)', marginBottom: '10px' } }, ['账号']),
        h('div', { class: 'row' }, [
          h('div', {}, [`账号：${user.username}`]),
          h('div', {}, [`角色：${user.role === 'owner' ? '超级管理员' : '成员'}`]),
        ]),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'label', style: { color: 'var(--muted)', marginBottom: '10px' } }, ['修改密码']),
        h('div', { class: 'row' }, [currentPassword, newPassword]),
        h('div', { style: { marginTop: '12px' } }, [changeBtn]),
        h('div', { class: 'hint', style: { marginTop: '8px' } }, ['修改后所有已登录会话都会失效。']),
      ]),
      credentials,
    ]),
  );

  await loadCredentials();
}
