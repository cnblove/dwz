/**
 * 极简 DOM 构造工具。
 * 不用模板字符串拼 HTML，从根本上避免内容里的引号/标签破坏结构。
 */

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') el.innerHTML = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function mount(root, node) {
  root.replaceChildren(node);
}

/** 让表格里的每个单元格都走同一套转义逻辑。 */
export function text(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

let toastTimer = null;

export function toast(message, kind = '') {
  document.querySelector('.toast')?.remove();
  const node = h('div', { class: `toast ${kind}` }, [message]);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3000);
}

export function confirmDialog(message) {
  return window.confirm(message);
}

/** 复制到剪贴板，失败时回退到 execCommand（微信/旧内核仍需要）。 */
export async function copyToClipboard(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 继续走兜底
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function formatTime(seconds) {
  if (!seconds) return '-';
  const date = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function modal({ title, fields, submitText = '保存', onSubmit }) {
  const mask = h('div', { class: 'modal-mask' });
  const form = h('form', { class: 'modal' });
  form.append(h('h2', {}, [title]));

  const inputs = {};
  for (const field of fields) {
    const id = `f_${field.name}`;
    let input;
    if (field.type === 'select') {
      input = h('select', { id, name: field.name });
      for (const option of field.options) {
        input.append(
          h('option', { value: option.value, selected: String(option.value) === String(field.value) }, [option.label]),
        );
      }
    } else if (field.type === 'textarea') {
      input = h('textarea', { id, name: field.name });
      input.value = field.value ?? '';
    } else {
      input = h('input', { id, name: field.name, type: field.type ?? 'text' });
      input.value = field.value ?? '';
    }
    if (field.required) input.required = true;
    if (field.placeholder) input.placeholder = field.placeholder;
    inputs[field.name] = input;
    form.append(
      h('div', { class: 'field' }, [
        h('label', { for: id }, [field.label]),
        input,
        field.hint ? h('div', { class: 'hint' }, [field.hint]) : null,
      ]),
    );
  }

  const submit = h('button', { class: 'primary', type: 'submit' }, [submitText]);
  form.append(
    h('div', { class: 'modal-foot' }, [
      h('button', { type: 'button', onClick: () => mask.remove() }, ['取消']),
      submit,
    ]),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = {};
    for (const [name, input] of Object.entries(inputs)) values[name] = input.value;

    submit.disabled = true;
    try {
      await onSubmit(values);
      mask.remove();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  mask.addEventListener('click', (event) => {
    if (event.target === mask) mask.remove();
  });
  mask.append(form);
  document.body.append(mask);
  inputs[fields[0]?.name]?.focus();
  return mask;
}
