import { auth, setToken } from '../api.js';
import { h, mount, toast } from '../dom.js';

/**
 * 仓库地址。
 *
 * 前端要硬编码一次仓库位置：设置页要给出开源地址，API Key 页要拼一键安装
 * 命令，而那里没有接口能问到「本仓库在哪」。集中成常量，改一处即可。
 */
export const REPO = {
  github: 'https://github.com/cnblove/dwz',
  cnb: 'https://cnb.cool/cnblove/dwz',
};

/** 一键安装脚本的直连地址（raw，直接能 curl | sh）。命令由 API Key 页复制。 */
export const INSTALL_SH = `${REPO.github.replace('github.com', 'raw.githubusercontent.com')}/main/skills/install.sh`;

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
          'API Key、配额与配套的 AI skill（含一键安装）都在 ',
          h('a', { href: '#/api-keys' }, ['「API Key」']),
          ' 页 —— 创建凭证、看用量、复制 skill 用法，一次办完。',
        ]),
      ]),
      renderRepoLinks(),
    ]),
  );
}

/**
 * 开源地址。
 *
 * 设置页负责回答「这东西的源码在哪」，所以只留仓库入口；怎么装、怎么用
 * 属于「拿到 key 之后的事」，归 API Key 页。两页各答一个问题，不重复。
 */
function renderRepoLinks() {
  return h('div', { class: 'card' }, [
    h('div', { class: 'label', style: { marginBottom: '8px' } }, ['开源地址']),
    h('div', { class: 'hint' }, [
      h('a', { href: REPO.github, target: '_blank', rel: 'noopener noreferrer' }, [REPO.github]),
      h('br', {}),
      '国内镜像：',
      h('a', { href: REPO.cnb, target: '_blank', rel: 'noopener noreferrer' }, [REPO.cnb]),
    ]),
    h('div', { class: 'hint', style: { marginTop: '6px' } }, [
      '安装脚本源码在仓库 ',
      h('code', {}, ['skills/install.sh']),
      '（',
      h('a', { href: `${REPO.github}/blob/main/skills/install.sh`, target: '_blank', rel: 'noopener noreferrer' }, ['查看源码']),
      '）。它只做两件事：拉取 skill、软链到助手目录；不动你已有的文件。',
    ]),
  ]);
}
