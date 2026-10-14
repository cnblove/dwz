import { auth, setToken } from '../api.js';
import { h, mount, toast } from '../dom.js';

export async function renderLogin(root, { onSuccess }) {
  const state = await auth.bootstrap().catch(() => ({ initialized: true }));

  const username = h('input', { type: 'text', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const email = h('input', { type: 'email', placeholder: '选填' });
  const submit = h('button', { class: 'primary', type: 'submit', style: { width: '100%' } }, [
    state.initialized ? '登录' : '创建管理员',
  ]);

  const fields = [
    h('div', { class: 'field' }, [h('label', {}, ['账号']), username]),
    h('div', { class: 'field' }, [h('label', {}, ['密码']), password]),
  ];
  if (!state.initialized) {
    fields.push(
      h('div', { class: 'field' }, [h('label', {}, ['邮箱']), email]),
      h('div', { class: 'hint', style: { marginBottom: '14px' } }, [
        '首次部署，创建的第一个账号将成为超级管理员。',
      ]),
    );
  }

  const form = h('form', { class: 'login-box' }, [
    h('h1', {}, ['短链与活码']),
    h('div', { class: 'sub' }, [state.initialized ? '登录以管理你的短链与活码' : '初始化你的部署']),
    ...fields,
    submit,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const result = state.initialized
        ? await auth.login(username.value, password.value)
        : await auth.register({ username: username.value, password: password.value, email: email.value });
      setToken(result.token);
      toast(state.initialized ? '登录成功' : '管理员已创建', 'success');
      await onSuccess();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  mount(root, h('div', { class: 'login-wrap' }, [form]));
}
