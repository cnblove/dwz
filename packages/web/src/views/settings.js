import { auth, setToken } from '../api.js';
import { copyToClipboard, h, mount, toast } from '../dom.js';

/**
 * 仓库地址。
 *
 * 前端要硬编码一次仓库位置：设置页要给出 skill 的开源地址与一键安装脚本，
 * 而那里没有接口能问到「本仓库在哪」。集中成常量，改一处即可。
 */
export const REPO = {
  github: 'https://github.com/cnblove/dwz',
  cnb: 'https://cnb.cool/cnblove/dwz',
};

/** 一键安装脚本的直连地址（raw，直接能 curl | sh）。 */
const INSTALL_SH = `${REPO.github.replace('github.com', 'raw.githubusercontent.com')}/main/skills/install.sh`;

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
      renderSkillInstall(),
    ]),
  );
}

/**
 * skill 一键安装区。
 *
 * 放在设置页最底部，是因为它回答的是「我要把 dwz 接到自己的 AI 助手上」——
 * 这属于环境配置，不属于日常运营。API Key 页负责「给你钥匙和说明书」，
 * 这里负责「把它装到本机」。
 *
 * 脚本本身在仓库的 skills/install.sh，开源可读：它只做「拉取 skill → 软链到
 * 助手目录」两件事，不覆盖已有 skill，也不改别的文件。把源码地址一并给出，
 * 是为了让用户不必盲信一句 curl | sh。
 */
function renderSkillInstall() {
  const curlCmd = `curl -fsSL ${INSTALL_SH} | sh`;

  const copy = async (text, label) => {
    const ok = await copyToClipboard(text);
    toast(ok ? `${label} 已复制` : '复制失败，请手动选择', ok ? 'success' : 'error');
  };

  return h('div', { class: 'card' }, [
    h('div', { class: 'label', style: { marginBottom: '8px' } }, ['一键安装 AI skill']),
    h('div', { class: 'hint' }, [
      '把 ',
      h('code', {}, ['dwz-api']),
      ' skill 装到本机的 AI 助手（Claude Code / CodeBuddy 等），装完助手就能自己建短链、活码、渠道码，并拉访问数据做分析。',
    ]),
    h('pre', { class: 'code-block', style: { marginTop: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, [curlCmd]),
    h('div', { class: 'actions', style: { marginTop: '10px' } }, [
      h('button', { class: 'link', onClick: () => copy(curlCmd, '安装命令') }, ['复制安装命令']),
      h('button', {
        class: 'link',
        onClick: () => copy(`${REPO.github}#配套的-skill`, '文档地址'),
      }, ['复制文档地址']),
    ]),
    h('div', { class: 'hint', style: { marginTop: '12px' } }, [
      '开源地址：',
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
