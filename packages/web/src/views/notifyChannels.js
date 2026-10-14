import { api } from '../api.js';
import { confirmDialog, h, mount, toast } from '../dom.js';

/**
 * 通知渠道管理。
 *
 * 各渠道的配置字段差异较大，这里用「渠道类型 → 字段定义」的映射驱动表单，
 * 避免为五种渠道各写一套弹窗。
 */
const KIND_OPTIONS = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'wecom', label: '企业微信机器人' },
  { value: 'bark', label: 'Bark（iOS 推送）' },
  { value: 'serverchan', label: '方糖 Server 酱' },
  { value: 'email', label: '邮件' },
];

const CONFIG_FIELDS = {
  webhook: [
    { name: 'url', label: 'Webhook 地址', required: true, placeholder: 'https://…', hint: '必须是 https' },
    { name: 'method', label: '请求方法', placeholder: 'POST 或 GET' },
  ],
  wecom: [{ name: 'key', label: '机器人 key', required: true, hint: '企业微信群机器人 webhook 的 key 参数' }],
  bark: [
    { name: 'key', label: 'Bark key', required: true },
    { name: 'server', label: '服务器', placeholder: '默认 https://api.day.app' },
  ],
  serverchan: [{ name: 'key', label: 'SendKey', required: true, placeholder: 'SCT…' }],
  email: [
    { name: 'to', label: '收件人', required: true, placeholder: 'ops@example.com' },
    { name: 'from', label: '发件人', placeholder: '可选' },
    { name: 'subject', label: '主题前缀', placeholder: '可选' },
  ],
};

export async function renderNotifyChannels(root) {
  const list = h('div', {});

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      const data = await api.get('/api/notify-channels');
      render(data.items);
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(items) {
    const rows = items.map((item) =>
      h('tr', {}, [
        h('td', {}, [item.name]),
        h('td', {}, [h('span', { class: 'tag' }, [item.kindLabel])]),
        h('td', {}, [
          item.enabled ? h('span', { class: 'tag ok' }, ['启用']) : h('span', { class: 'tag warn' }, ['停用']),
        ]),
        h('td', { class: 'copyable', style: { color: 'var(--muted)', maxWidth: '280px', overflowWrap: 'anywhere' } }, [
          item.configured ? '已配置' : '未配置',
        ]),
        h('td', {}, [
          h('div', { class: 'actions' }, [
            h('button', {
              class: 'link',
              onClick: async () => {
                try {
                  const result = await api.post(`/api/notify-channels/${item.id}/test`);
                  toast(result.message ?? '已发送', 'success');
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            }, ['测试']),
            h('button', {
              class: 'link',
              onClick: async () => {
                await api.patch(`/api/notify-channels/${item.id}`, { enabled: !item.enabled });
                toast('已更新', 'success');
                reload();
              },
            }, [item.enabled ? '停用' : '启用']),
            h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
            h('button', {
              class: 'link',
              style: { color: 'var(--danger)' },
              onClick: async () => {
                if (!confirmDialog(`确定删除渠道「${item.name}」？`)) return;
                await api.del(`/api/notify-channels/${item.id}`);
                toast('已删除', 'success');
                reload();
              },
            }, ['删除']),
          ]),
        ]),
      ]),
    );

    list.replaceChildren(
      items.length
        ? h('div', { class: 'card table-wrap' }, [
            h('table', {}, [
              h('thead', {}, [h('tr', {}, ['名称', '类型', '状态', '配置', '操作'].map((l) => h('th', {}, [l])))]),
              h('tbody', {}, rows),
            ]),
          ])
        : h('div', { class: 'card empty-state' }, ['还没有配置通知渠道']),
      h('div', { class: 'hint', style: { marginTop: '10px' } }, [
        '域名巡检与卡密库存告警都会通过这里配置的渠道发送。',
      ]),
    );
  }

  function openForm(item) {
    const nameInput = h('input', { value: item?.name ?? '', placeholder: '例如 运维群' });
    const kindSelect = h('select', {}, KIND_OPTIONS.map((option) =>
      h('option', { value: option.value, selected: item?.kind === option.value }, [option.label]),
    ));
    kindSelect.disabled = Boolean(item);

    const configBox = h('div', {});
    const inputs = {};

    function renderConfigFields() {
      const kind = kindSelect.value;
      inputs.length = 0;
      const nodes = (CONFIG_FIELDS[kind] ?? []).map((field) => {
        const input = h('input', { placeholder: field.placeholder ?? '' });
        // 编辑时把脱敏值填回去供参考；用户不修改就不会提交该字段
        const existing = item?.configHint?.[field.name];
        if (existing) input.value = String(existing);
        inputs[field.name] = input;
        return h('div', { class: 'field' }, [
          h('label', {}, [field.label]),
          input,
          field.hint ? h('div', { class: 'hint' }, [field.hint]) : null,
        ]);
      });
      configBox.replaceChildren(...nodes);
    }

    kindSelect.addEventListener('change', renderConfigFields);
    renderConfigFields();

    const submit = h('button', { class: 'primary', type: 'submit' }, [item ? '保存' : '创建']);
    const form = h('form', { class: 'modal' }, [
      h('h2', {}, [item ? '编辑通知渠道' : '新增通知渠道']),
      h('div', { class: 'field' }, [h('label', {}, ['名称']), nameInput]),
      h('div', { class: 'field' }, [h('label', {}, ['类型']), kindSelect]),
      configBox,
      item ? h('div', { class: 'hint' }, ['留空表示保持原密钥不变。']) : null,
      h('div', { class: 'modal-foot' }, [
        h('button', { type: 'button', onClick: () => mask.remove() }, ['取消']),
        submit,
      ]),
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const config = {};
      for (const [key, input] of Object.entries(inputs)) {
        if (input.value && !(item && String(input.value).includes('****'))) config[key] = input.value;
      }
      submit.disabled = true;
      try {
        if (item) {
          const payload = { name: nameInput.value };
          if (Object.keys(config).length) payload.config = config;
          await api.patch(`/api/notify-channels/${item.id}`, payload);
        } else {
          await api.post('/api/notify-channels', { name: nameInput.value, kind: kindSelect.value, config });
        }
        toast('已保存', 'success');
        mask.remove();
        reload();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        submit.disabled = false;
      }
    });

    const mask = h('div', { class: 'modal-mask' }, [form]);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) mask.remove();
    });
    document.body.append(mask);
    nameInput.focus();
  }

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['通知渠道']),
        h('button', { class: 'primary', onClick: () => openForm(null) }, ['新增渠道']),
      ]),
      list,
    ]),
  );

  await reload();
}
