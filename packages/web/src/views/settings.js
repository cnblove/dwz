import { auth, setToken } from '../api.js';
import { h, mount, toast } from '../dom.js';

export async function renderSettings(root, { user, onLogout }) {
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
      h('div', { class: 'card' }, [
        h('div', { class: 'label', style: { color: 'var(--muted)', marginBottom: '10px' } }, ['开放 API']),
        h('div', { class: 'hint' }, [
          'API Key 与配套的 AI skill 已经挪到独立页面 —— ',
          h('a', { href: '#/api-keys' }, ['前往「API Key」']),
          '，那里能创建凭证、看配额，并直接复制 skill 的用法。',
        ]),
      ]),
    ]),
  );
}
