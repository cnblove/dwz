import { api } from '../api.js';
import { confirmDialog, copyToClipboard, formatTime, h, modal, mount, replaceChildren, toast } from '../dom.js';

/**
 * 个人 API Key。
 *
 * 从「设置」页里拆出来单独成页，是因为这一页现在不只管凭证：
 * 它还要把「拿这串 key 能干什么」讲清楚，并把配套的 skill 一并交付。
 * 凭证页只给一串密钥，等于让用户自己去猜怎么用 —— 那正是这个页面要消灭的部分。
 */
export async function renderApiKeys(root, { shortOrigin, user } = {}) {
  const list = h('div', {});
  const skillBox = h('div', {});

  async function reload() {
    replaceChildren(list, h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      render(await api.get('/api/credentials'));
    } catch (error) {
      replaceChildren(list, h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(data) {
    const rows = data.items.map((item) =>
      h('tr', {}, [
        h('td', { class: 'copyable', 'data-label': 'apiKey' }, [item.apiKey]),
        h('td', { class: 'copyable cell-clip', 'data-label': '密钥', style: { color: 'var(--muted)' } }, [item.secretHint]),
        h('td', { 'data-label': '配额' }, [`${item.used} / ${item.quota}`]),
        h('td', { 'data-label': '状态' }, [
          item.status === 'active' ? h('span', { class: 'tag ok' }, ['启用']) : h('span', { class: 'tag warn' }, ['停用']),
        ]),
        h('td', { 'data-label': '到期' }, [item.expiresAt ? formatTime(item.expiresAt) : '不限']),
        h('td', { 'data-label': '操作' }, [
          h('div', { class: 'actions' }, [
            h('button', {
              class: 'link',
              onClick: async () => {
                await api.patch(`/api/credentials/${item.id}`, {
                  status: item.status === 'active' ? 'paused' : 'active',
                });
                toast('已更新', 'success');
                reload();
              },
            }, [item.status === 'active' ? '停用' : '启用']),
            h('button', { class: 'link', onClick: () => edit(item) }, ['配额']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog(`确定删除 ${item.apiKey}？用它的脚本会立刻失效。`)) return;
                await api.del(`/api/credentials/${item.id}`);
                toast('已删除', 'success');
                reload();
              },
            }, ['删除']),
          ]),
        ]),
      ]),
    );

    replaceChildren(list, 
      h('div', { class: 'card table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [h('tr', {}, ['apiKey', '密钥', '配额', '状态', '到期', '操作'].map((label) => h('th', {}, [label])))]),
          h('tbody', {}, rows),
        ]),
      ]),
      data.items.length ? null : h('div', { class: 'card empty-state' }, ['还没有创建 API Key']),
    );
  }

  function edit(item) {
    modal({
      title: '调整配额',
      fields: [
        { name: 'quota', label: '总配额', type: 'number', value: item.quota, required: true, hint: `已用 ${item.used} 次` },
        { name: 'ipAllowlist', label: 'IP 白名单', value: item.ipAllowlist ?? '', hint: '逗号分隔，留空表示不限制' },
      ],
      onSubmit: async (values) => {
        await api.patch(`/api/credentials/${item.id}`, {
          quota: Number(values.quota),
          ipAllowlist: values.ipAllowlist,
        });
        toast('已保存', 'success');
        reload();
      },
    });
  }

  async function create() {
    try {
      const result = await api.post('/api/credentials', {});
      const { apiKey, apiSecret } = result.item;
      const ok = await copyToClipboard(`DWZ_API_KEY=${apiKey}\nDWZ_API_SECRET=${apiSecret}`);
      toast(ok ? '已创建并复制到剪贴板（密钥只显示一次）' : '已创建，请手动复制密钥', 'success');
      showSecret(result.item);
      reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  /**
   * 密钥只返回一次，所以创建后必须立刻摆到用户面前 ——
   * 只靠一个 toast 提示「已复制到剪贴板」，在剪贴板权限被拒时就等于把密钥弄丢了。
   */
  function showSecret(item) {
    // 密钥只返回一次，所以创建后必须立刻把它摆到用户面前。
    // 只弹一句「已复制到剪贴板」在剪贴板权限被拒时就等于把密钥弄丢了，
    // 所以这里给一个可再次复制的输入框，并顺手替用户复制一次。
    const value = `DWZ_API_KEY=${item.apiKey}\nDWZ_API_SECRET=${item.apiSecret}`;
    modal({
      title: 'API Key 已创建',
      fields: [
        {
          name: 'secret',
          label: '密钥（只显示这一次）',
          type: 'textarea',
          value,
          hint: '关掉这个窗口后就再也拿不到了。用下面两行环境变量把它交给 skill 或脚本。',
        },
      ],
      submitText: '我已保存',
      onSubmit: async (values) => {
        await copyToClipboard(values.secret);
        toast('已复制到剪贴板', 'success');
      },
    });
  }

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['个人 API Key']),
        h('button', { class: 'primary', onClick: create }, ['创建 API Key']),
      ]),
      h('div', { class: 'card' }, [
        h('div', { class: 'label', style: { marginBottom: '8px' } }, ['这一页解决什么']),
        h('div', { class: 'hint' }, [
          '创建一串属于你自己的 API Key，之后可以用脚本、也可以用 AI 助手（skill）来建短链、活码、渠道码，',
          '并把访问数据捞回去做分析。密钥只在创建时显示一次，请立刻保存。',
        ]),
      ]),
      list,
      skillBox,
    ]),
  );

  renderSkill(skillBox, { shortOrigin, user });
  await reload();
}

/**
 * skill 交付区。
 *
 * 这里是这一页真正的重点：光给密钥不给人怎么用，等于没开放。
 * 所以把「skill 从哪来、怎么装、跑起来长什么样」直接写进页面，
 * 并把 origin 预填好 —— 用户只需要复制我们拼好的那两行。
 */
function renderSkill(container, { shortOrigin, user }) {
  const origin = shortOrigin || window.location.origin;

  const skillPath = 'skills/dwz-api';
  const install = [
    '# skill 目录就在本项目仓库里，随代码一起发布：',
    `#   ${skillPath}/SKILL.md            给 AI 看的说明书`,
    `#   ${skillPath}/scripts/dwz.mjs     零依赖命令行工具`,
    '',
    `export DWZ_ORIGIN=${origin}`,
    `export DWZ_API_KEY=<你的 apiKey>`,
    `export DWZ_API_SECRET=<你的 secret>`,
    `node ${skillPath}/scripts/dwz.mjs check`,
  ].join('\n');

  const actions = [
    { label: '查看接口目录（无需鉴权）', cmd: `curl -s ${origin}/open/v1` },
    { label: '建一条短链', cmd: `node dwz.mjs short-links create --title "活动" --url https://example.com/act` },
    { label: '看某个码的访问分析', cmd: `node dwz.mjs stats --slug <slug> --days 7` },
  ];

  replaceChildren(container,
    h('div', { class: 'card' }, [
      h('div', { class: 'label', style: { marginBottom: '8px' } }, ['配套的 AI skill：', 'dwz-api']),
      h('div', { class: 'hint' }, [
        '把 skill 目录交给你的 AI 助手（Claude Code / CodeBuddy 等），它就能自己建码、查数据、按你的要求做分析。',
        'skill 本体在仓库的 ',
        h('code', {}, [skillPath]),
        ' 下；它同时也是一个零依赖命令行工具，不接 AI 也能直接用。',
      ]),
      h('pre', { class: 'code-block', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: '10px' } }, [install]),
      h('div', { class: 'actions', style: { marginTop: '10px' } }, [
        h('button', {
          class: 'link',
          onClick: async () => {
            const ok = await copyToClipboard(
              `export DWZ_ORIGIN=${origin}\nexport DWZ_API_KEY=<你的 apiKey>\nexport DWZ_API_SECRET=<你的 secret>`,
            );
            toast(ok ? '已复制（把 <...> 换成真实密钥）' : '复制失败', ok ? 'success' : 'error');
          },
        }, ['复制环境变量']),
        h('button', {
          class: 'link',
          onClick: async () => {
            const ok = await copyToClipboard(install);
            toast(ok ? '已复制' : '复制失败', ok ? 'success' : 'error');
          },
        }, ['复制完整命令']),
      ]),
    ]),
    h('div', { class: 'card' }, [
      h('div', { class: 'label', style: { marginBottom: '8px' } }, ['常用调用']),
      ...actions.map((item) =>
        h('div', { style: { marginBottom: '8px' } }, [
          h('div', { class: 'hint' }, [item.label]),
          h('pre', { class: 'code-block', style: { margin: '4px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, [item.cmd]),
        ]),
      ),
      h('div', { class: 'hint', style: { marginTop: '10px' } }, [
        '签名规则：HMAC-SHA256(secret, "标题|限制|目标链接|apiKey|apiSecret")，结果取 hex。',
        '具体字段与示例以 ',
        h('code', {}, [`${origin}/open/v1`]),
        ' 返回的目录为准。',
      ]),
      user ? h('div', { class: 'hint', style: { marginTop: '6px' } }, [`当前账号：${user.username}`]) : null,
    ]),
  );

}
