import { auth, isLoggedIn, setToken, system } from './api.js';
import { h, mount, toast } from './dom.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderShortLinks } from './views/shortLinks.js';
import { renderCodes } from './views/codes.js';
import { renderChannels } from './views/channels.js';
import { renderDomains } from './views/domains.js';
import { renderCardkeys } from './views/cardkeys.js';
import { renderNotifyChannels } from './views/notifyChannels.js';
import { renderInspection } from './views/inspection.js';
import { renderUsers } from './views/users.js';
import { renderSettings } from './views/settings.js';

/**
 * 前端配置。
 *
 * 短链前缀优先取构建期注入的 window.__DWZ_SHORT_ORIGIN__（同域部署可直接留空），
 * 否则登录后从 Worker 的 /api/config 拉取 env.SHORT_ORIGIN。
 * 后台与短链默认同域（同一个 Worker 提供），配了 SHORT_ORIGIN 就按配的来，
 * 自定义短链域名时界面显示/复制的短链才不会是死链。
 */
const CONFIG = {
  shortOrigin: window.__DWZ_SHORT_ORIGIN__ ?? '',
};

async function loadRemoteConfig() {
  const data = await system.config();
  if (data?.shortOrigin) CONFIG.shortOrigin = data.shortOrigin;
}

const ROUTES = [
  { path: 'dashboard', label: '概览', render: renderDashboard },
  { path: 'short-links', label: '短链', render: renderShortLinks },
  { path: 'codes', label: '活码', render: renderCodes },
  { path: 'channels', label: '渠道码', render: renderChannels },
  { path: 'domains', label: '域名', render: renderDomains },
  { path: 'cardkeys', label: '卡密', render: renderCardkeys },
  { path: 'notify-channels', label: '通知渠道', render: renderNotifyChannels, ownerOnly: true },
  { path: 'inspection', label: '巡检日志', render: renderInspection, ownerOnly: true },
  { path: 'users', label: '账号', render: renderUsers, ownerOnly: true },
  { path: 'settings', label: '设置', render: renderSettings },
];

const root = document.getElementById('app');

function currentPath() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return hash || 'dashboard';
}

async function boot() {
  if (!isLoggedIn()) {
    await renderLogin(root, { onSuccess: boot });
    return;
  }

  let user;
  try {
    user = (await auth.me()).user;
    await loadRemoteConfig();
  } catch {
    setToken('');
    await renderLogin(root, { onSuccess: boot });
    return;
  }

  renderShell(user);
}

function renderShell(user) {
  const content = h('main', { class: 'main' });

  const visibleRoutes = ROUTES.filter((route) => !route.ownerOnly || user.role === 'owner');
  const active = currentPath();
  const route = visibleRoutes.find((r) => r.path === active) ?? visibleRoutes[0];

  const nav = h(
    'nav',
    {},
    visibleRoutes.map((r) =>
      h('a', { href: `#/${r.path}`, class: r.path === route.path ? 'active' : '' }, [r.label]),
    ),
  );

  const logoutBtn = h('button', {
    class: 'link',
    onClick: async () => {
      await auth.logout().catch(() => {});
      setToken('');
      toast('已退出登录', 'success');
      await boot();
    },
  }, ['退出']);

  const sidebar = h('aside', { class: 'sidebar' }, [
    h('div', { class: 'brand' }, ['🔗 短链与活码']),
    nav,
    h('div', { class: 'account' }, [h('strong', {}, [user.username]), logoutBtn]),
  ]);

  const layout = h('div', { class: 'layout' }, [sidebar, content]);
  mount(root, layout);

  route
    .render(content, { user, shortOrigin: CONFIG.shortOrigin, currentUser: user, onLogout: boot })
    .catch((error) => {
      content.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    });
}

window.addEventListener('hashchange', () => {
  if (isLoggedIn()) boot();
});

window.addEventListener('dwz:unauthorized', () => {
  toast('登录已过期，请重新登录', 'error');
  boot();
});

boot();
