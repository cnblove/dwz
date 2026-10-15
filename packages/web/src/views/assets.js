import { api, getToken } from '../api.js';
import { confirmDialog, copyToClipboard, formatTime, h, modal, mount, toast } from '../dom.js';

/**
 * 素材库：图片上传到 R2，列表里复制链接给活码/客服码用。
 *
 * 上传走 multipart（FormData），所以不能用 api.post 的 JSON 通道，
 * 这里直接用 request 但手动传 FormData 作为 body。
 */
export async function renderAssets(root, { currentUser } = {}) {
  const state = { page: 1, pageSize: 24, keyword: '' };
  const list = h('div', {});

  async function reload() {
    list.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      const query = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
      if (state.keyword) query.set('keyword', state.keyword);
      render(await api.get(`/api/assets?${query}`));
    } catch (error) {
      list.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function render(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    const cards = data.items.map((item) =>
      h('div', { class: 'card', style: { padding: '12px', margin: '0' } }, [
        h('div', {
          style: {
            background: 'var(--brand-weak)',
            borderRadius: '8px',
            height: '140px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          },
        }, [
          item.kind === 'image'
            ? h('img', { src: item.url, alt: item.filename, loading: 'lazy', style: { maxWidth: '100%', maxHeight: '140px' } })
            : h('span', { class: 'tag muted' }, ['文档']),
        ]),
        h('div', { style: { marginTop: '10px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [item.filename]),
        h('div', { style: { color: 'var(--muted)', fontSize: '12px', marginTop: '2px' } }, [
          `${formatSize(item.size)} · ${formatTime(item.createdAt)}`,
        ]),
        h('div', { class: 'actions', style: { marginTop: '10px' } }, [
          h('button', {
            class: 'link',
            onClick: async () => {
              const ok = await copyToClipboard(absoluteUrl(item.url));
              toast(ok ? '链接已复制' : '复制失败', ok ? 'success' : 'error');
            },
          }, ['复制链接']),
          h('button', { class: 'link', onClick: () => preview(item) }, ['查看']),
          h('button', { class: 'link', onClick: () => edit(item) }, ['编辑']),
          h('button', {
            class: 'link',
            style: { color: 'var(--danger)' },
            onClick: async () => {
              if (!confirmDialog(`确定删除「${item.filename}」？引用它的地方会变成死图。`)) return;
              try {
                await api.del(`/api/assets/${item.id}`);
                toast('已删除', 'success');
                reload();
              } catch (error) {
                toast(error.message, 'error');
              }
            },
          }, ['删除']),
        ]),
      ]),
    );

    list.replaceChildren(
      data.items.length
        ? h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' } }, cards)
        : h('div', { class: 'card empty-state' }, ['还没有素材，先上传一张吧']),
      h('div', { class: 'pager' }, [
        h('span', {}, [`共 ${data.total} 条`]),
        h('button', { disabled: state.page <= 1, onClick: () => { state.page -= 1; reload(); } }, ['上一页']),
        h('span', {}, [`${state.page} / ${totalPages}`]),
        h('button', { disabled: state.page >= totalPages, onClick: () => { state.page += 1; reload(); } }, ['下一页']),
      ]),
    );
  }

  function preview(item) {
    const mask = h('div', { class: 'modal-mask' }, [
      h('div', { class: 'modal' }, [
        h('h2', {}, [item.filename]),
        h('img', { src: item.url, alt: item.filename, style: { maxWidth: '100%', borderRadius: '8px' } }),
        h('div', { class: 'field', style: { marginTop: '14px' } }, [
          h('label', {}, ['图片链接']),
          h('input', { value: absoluteUrl(item.url), readOnly: true, style: { width: '100%' } }),
        ]),
        h('div', { class: 'modal-foot' }, [
          h('button', {
            onClick: async () => {
              const ok = await copyToClipboard(absoluteUrl(item.url));
              toast(ok ? '链接已复制' : '复制失败', ok ? 'success' : 'error');
            },
          }, ['复制链接']),
          h('button', { onClick: () => mask.remove() }, ['关闭']),
        ]),
      ]),
    ]);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) mask.remove();
    });
    document.body.append(mask);
  }

  function edit(item) {
    modal({
      title: '编辑素材',
      fields: [
        { name: 'filename', label: '文件名', value: item.filename, required: true },
        { name: 'remark', label: '备注', value: item.remark ?? '' },
      ],
      onSubmit: async (values) => {
        await api.patch(`/api/assets/${item.id}`, { filename: values.filename, remark: values.remark });
        toast('已保存', 'success');
        reload();
      },
    });
  }

  /* ---------------- 上传 ---------------- */

  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
  const uploadBtn = h('button', { class: 'primary' }, ['上传图片']);
  const uploadStatus = h('div', { class: 'hint' }, ['支持 PNG / JPG / GIF / WebP，单张不超过 10MB']);

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length) return;

    uploadBtn.disabled = true;
    let done = 0;
    for (const file of files) {
      uploadStatus.textContent = `正在上传 ${file.name}（${done + 1}/${files.length}）…`;
      try {
        await uploadOne(file);
        done += 1;
      } catch (error) {
        toast(`${file.name}：${error.message}`, 'error');
      }
    }
    uploadBtn.disabled = false;
    uploadStatus.textContent = `支持 PNG / JPG / GIF / WebP，单张不超过 10MB${done ? ` · 本次成功 ${done} 张` : ''}`;
    if (done) {
      toast(`已上传 ${done} 张`, 'success');
      state.page = 1;
      reload();
    }
  });

  const searchInput = h('input', { placeholder: '搜索文件名 / 备注', style: { maxWidth: '220px' } });
  searchInput.value = state.keyword;
  const searchBtn = h('button', {}, ['搜索']);
  const doSearch = () => {
    state.keyword = searchInput.value.trim();
    state.page = 1;
    reload();
  };
  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doSearch();
  });

  mount(
    root,
    h('div', {}, [
      h('div', { class: 'page-head' }, [
        h('h1', {}, ['素材库']),
        h('div', { class: 'actions' }, [searchInput, searchBtn, uploadBtn]),
      ]),
      h('div', { class: 'hint', style: { marginBottom: '12px' } }, [
        '图片集中存放，上传后在活码「子码」里可以直接从素材库选取，也可以复制链接用在任何地方。',
      ]),
      uploadStatus,
      fileInput,
      list,
    ]),
  );

  await reload();
}

/** FormData 上传：不能走 api.post（它会 JSON.stringify）。 */
async function uploadOne(file) {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/assets', {
    method: 'POST',
    headers: { authorization: `Bearer ${getToken()}` },
    body: form,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.msg ?? `上传失败（${response.status}）`);
  return payload.item;
}

/** 后端存的是相对地址（/media/xxx），展示与复制时补成绝对地址。 */
export function absoluteUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * 落库用的图片地址：同域素材保持相对路径。
 *
 * 存绝对地址会把「后台域名」焊死在数据里：落地页跑在短链域名上时，
 * 图片得跨域回后台取，后台域名一换就是一张张破图。
 * 相对地址跟着落地页域名走，换域名不用改数据。
 * 外部图床（域名不同）没法相对，仍旧原样保留。
 */
export function storedImageUrl(url) {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url;
  }
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 素材选择弹窗：给活码「子码」等地方复用。
 * 回调 pick(item)，item 里的 url 是可直接落库的相对/绝对地址。
 */
export function openAssetPicker({ title = '选择素材', onPick }) {
  const state = { page: 1, pageSize: 24, keyword: '' };
  const grid = h('div', { class: 'empty-state' }, ['加载中…']);

  async function reload() {
    grid.replaceChildren(h('div', { class: 'empty-state' }, ['加载中…']));
    try {
      const query = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
      if (state.keyword) query.set('keyword', state.keyword);
      const data = await api.get(`/api/assets?${query}`);
      renderGrid(data);
    } catch (error) {
      grid.replaceChildren(h('div', { class: 'empty-state' }, [error.message]));
    }
  }

  function renderGrid(data) {
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    grid.replaceChildren(
      data.items.length
        ? h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' } },
            data.items.map((item) =>
              h('div', {
                style: { border: '1px solid var(--border)', borderRadius: '8px', padding: '6px', cursor: 'pointer' },
                onClick: () => { onPick(item); mask.remove(); },
              }, [
                h('img', { src: item.url, alt: item.filename, loading: 'lazy', style: { width: '100%', height: '100px', objectFit: 'contain', borderRadius: '6px' } }),
                h('div', { style: { fontSize: '12px', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [item.filename]),
              ]),
            ))
        : h('div', { class: 'empty-state' }, ['素材库还是空的，先到「素材库」页上传']),
      h('div', { class: 'pager' }, [
        h('span', {}, [`共 ${data.total} 条`]),
        h('button', { disabled: state.page <= 1, onClick: () => { state.page -= 1; reload(); } }, ['上一页']),
        h('span', {}, [`${state.page} / ${totalPages}`]),
        h('button', { disabled: state.page >= totalPages, onClick: () => { state.page += 1; reload(); } }, ['下一页']),
      ]),
    );
  }

  const searchInput = h('input', { placeholder: '搜索文件名', style: { maxWidth: '200px' } });
  const doSearch = () => {
    state.keyword = searchInput.value.trim();
    state.page = 1;
    reload();
  };
  searchInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') doSearch(); });

  const mask = h('div', { class: 'modal-mask' }, [
    h('div', { class: 'modal', style: { maxWidth: '720px' } }, [
      h('h2', {}, [title]),
      h('div', { class: 'actions', style: { marginBottom: '12px' } }, [searchInput, h('button', { onClick: doSearch }, ['搜索'])]),
      grid,
      h('div', { class: 'modal-foot' }, [h('button', { onClick: () => mask.remove() }, ['关闭'])]),
    ]),
  ]);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) mask.remove();
  });
  document.body.append(mask);
  reload();
}
