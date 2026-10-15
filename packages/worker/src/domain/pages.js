import { isWithinOnlineHours } from '../lib/time.js';

/**
 * 访客侧页面。
 *
 * 全部由 Worker 直接输出 HTML：
 * 微信内置浏览器对首屏 JS 渲染很敏感，服务端出页可以避免白屏与二次跳转。
 */

const BASE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
    background: #f7f8fa;
    color: #1f2329;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e8eaed; }
    .card { background: #22252b !important; }
  }
  .card {
    background: #fff;
    width: 100%;
    max-width: 480px;
    margin: 24px 16px;
    padding: 24px 20px 32px;
    border-radius: 14px;
    box-shadow: 0 2px 16px rgba(0, 0, 0, 0.06);
    text-align: center;
  }
  /* 安全验证条：绿色底 + 认证盾形勾，跟页面整体留白对齐 */
  .verify {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-size: 15px;
    color: #07c160;
    background: #e8fef2;
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 16px;
  }
  .verify .icon {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCIgd2lkdGg9IjI2IiBoZWlnaHQ9IjI2Ij4KICA8cGF0aCBmaWxsPSIjMDdjMTYwIiBkPSJNMjAgMWw1LjQgMy45IDYuNi0xIDIuMSA2LjQgNiAzLTIuMyA2LjQgMi4zIDYuNC02IDMtMi4xIDYuNC02LjYtMUwyMCAzOWwtNS40LTMuOS02LjYgMS0yLjEtNi40LTYtM0wyLjIgMjAgLjEgMTMuNmw2LTNMOC4yIDQuMmw2LjYgMXoiLz4KICA8cGF0aCBmaWxsPSIjZmZmIiBkPSJNMTEuOCAxMy42bDcuNiA3LjIgNi4zLTYuMSAyLjUgMi40LTguOCA4LjUtMTAuMS05LjZ6Ii8+Cjwvc3ZnPgo=') no-repeat center / contain;
  }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; }
  .tip { font-size: 15px; color: #8a8f99; margin: 16px 0 12px; }
  /* 二维码不能写死 240px：原图往往更大，写死等于让浏览器缩小，
     在微信里看着就是糊的。这里按卡片宽度自适应，并放开高度。
     240px 只作为兜底上限，保证极端小屏也不会溢出。 */
  .qrwrap {
    display: block;
    padding: 8px;
    background: #fff;
    border-radius: 12px;
    /* 减去卡片左右各 20px 内边距，二维码铺满内容区 */
    max-width: 420px;
    margin: 0 auto;
  }
  .qrcode {
    width: 100%;
    height: auto;
    max-width: 240px;
    margin: 0 auto;
    display: block;
    border-radius: 8px;
    /* 放大二维码本体时不连带把卡片撑变形 */
    object-fit: contain;
  }
  .contact { font-size: 15px; margin: 16px 0 8px; color: #1f2329; }
  .contact b { font-weight: 600; }
  .copy {
    display: inline-block;
    margin-left: 8px;
    padding: 4px 12px;
    font-size: 13px;
    color: #3370ff;
    border: 1px solid #3370ff;
    border-radius: 999px;
    background: transparent;
    cursor: pointer;
  }
  .online { font-size: 13px; margin-top: 12px; padding: 8px; border-radius: 8px; }
  .online.yes { color: #0f7b3e; background: #e8f7ee; }
  .online.no { color: #a8071a; background: #ffecec; }
  .remark { font-size: 14px; color: #646a73; margin: 12px 0; line-height: 1.6; word-break: break-word; }
  .fallback { margin-top: 20px; font-size: 13px; color: #646a73; }
  .fallback img { width: 180px; height: 180px; display: block; margin: 10px auto 0; border-radius: 8px; }
  .btn {
    display: inline-block;
    margin-top: 20px;
    padding: 10px 26px;
    font-size: 15px;
    color: #3370ff;
    border: 1px solid #3370ff;
    border-radius: 999px;
    background: transparent;
    cursor: pointer;
  }
  .empty { text-align: center; padding: 60px 24px; color: #646a73; font-size: 15px; }
  .empty .icon { font-size: 44px; margin-bottom: 16px; }
`;

/** 安全提示：平台自有活码，落到访客眼里是「已通过安全验证」，而不是提醒他防骗。 */
const SAFETY_TIP = '二维码已通过安全验证';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // 落地页内容随时可能被后台改动，不缓存以免展示过期二维码
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}

function page({ title, body, status = 200 }) {
  return htmlResponse(
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>${body}</body>
</html>`,
    status,
  );
}

/* ---------------- 通用提示页 ---------------- */

export function renderMessagePage({ title, message, fallbackUrl }, env, status = 200) {
  const fallback = fallbackUrl
    ? `<div class="fallback">客服二维码<div><img src="${escapeHtml(fallbackUrl)}" alt="客服二维码"></div></div>`
    : '';
  return page({
    title,
    status,
    body: `<div class="empty"><div class="icon">⚠️</div><div>${escapeHtml(message)}</div>${fallback}</div>`,
  });
}

/** 访问受限：给出原因，并把原目标以二维码形式放出，方便截图后到正确环境打开。 */
export function renderDeniedPage({ title, message, targetUrl }, env) {
  const qrTarget = targetUrl ? escapeHtml(targetUrl) : '';
  const qrBlock = targetUrl
    ? `<div class="tip">请截图后到微信中扫码打开</div>
       <canvas id="qr" class="qrcode" width="240" height="240"></canvas>`
    : '';
  return page({
    title: '温馨提示',
    body: `<div class="card">
      <h1>${escapeHtml(message || '当前环境无法访问')}</h1>
      ${qrBlock}
      <button class="btn" id="copyBtn" data-url="${qrTarget}">复制本页链接</button>
    </div>
    <script>
      document.getElementById('copyBtn').addEventListener('click', function () {
        var url = this.dataset.url || location.href;
        var ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); this.textContent = '已复制'; } catch (e) { this.textContent = '复制失败，请手动复制'; }
        document.body.removeChild(ta);
      });
      ${targetUrl ? `window.__qrTarget = ${JSON.stringify(targetUrl)};` : ''}
    </script>`,
  });
}

/* ---------------- 活码落地页 ---------------- */

export function renderCodePage(code, qrcode, { sticky } = {}) {
  const isGroup = code.kind === 'group';
  const parts = [];

  if (code.show_safety) {
    parts.push(`<div class="verify"><span class="icon"></span><span>${escapeHtml(SAFETY_TIP)}</span></div>`);
  }

  const tip = isGroup ? '请长按下方二维码进群' : '请长按识别二维码添加微信';
  parts.push(`<div class="tip">${escapeHtml(tip)}</div>`);

  parts.push(`<div class="qrwrap">
    <img class="qrcode" id="qrcode" src="${escapeHtml(qrcode.image_url)}" alt="二维码"
         data-zmid="${qrcode.id}" data-sticky="${sticky ? '1' : '0'}">
  </div>`);

  if (!isGroup && qrcode.contact) {
    parts.push(`<div class="contact">微信号：<b>${escapeHtml(qrcode.contact)}</b>
      <button class="copy" data-contact="${escapeHtml(qrcode.contact)}">复制</button></div>`);
  }

  if (!isGroup && code.show_online) {
    const online = isWithinOnlineHours(safeParse(code.online_hours));
    parts.push(
      `<div class="online ${online ? 'yes' : 'no'}">${
        online ? '当前在线，可扫码添加' : '当前不在线，回复可能较慢'
      }</div>`,
    );
  }

  if (code.remark) {
    parts.push(`<div class="remark">${escapeHtml(code.remark)}</div>`);
  }

  parts.push(`<script>
    (function () {
      var img = document.getElementById('qrcode');
      var copyBtn = document.querySelector('.copy');

      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var value = this.dataset.contact;
          var ta = document.createElement('textarea');
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); this.textContent = '已复制'; } catch (e) {}
          document.body.removeChild(ta);
        });
      }

      // 长按认定为：按下超过 500ms 且期间没有明显位移
      var startAt = 0, moved = false;
      img.addEventListener('touchstart', function () { moved = false; startAt = Date.now(); }, { passive: true });
      img.addEventListener('touchmove', function () { moved = true; }, { passive: true });
      img.addEventListener('touchend', function () {
        if (!moved && Date.now() - startAt > 500) {
          fetch('/report/longpress?zm_id=' + encodeURIComponent(img.dataset.zmid), { keepalive: true }).catch(function () {});
        }
      });
    })();
  <\/script>`);

  return page({
    title: code.title || '扫码添加',
    body: `<div class="card">${parts.join('\n')}</div>`,
  });
}

function safeParse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/* ---------------- 卡密兑换页 ---------------- */

/**
 * 兑换页样式：与落地页同一套视觉，另外只需要一个结果弹窗和一个大输入框。
 * 单独一段而不是并进 BASE_STYLE —— 兑换页与活码落地页不在同一张页面上，
 * 多出来的几十字节换「改兑换页不会动到活码页」是值的。
 */
const REDEEM_STYLE = `
  .redeem-form { margin-top: 8px; text-align: left; }
  .redeem-form input {
    width: 100%;
    height: 46px;
    padding: 0 14px;
    font-size: 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 1px;
    color: #1f2329;
    background: #f7f8fa;
    border: 1px solid #dfe1e6;
    border-radius: 10px;
    text-transform: uppercase;
  }
  .redeem-form input:focus { outline: none; border-color: #3370ff; background: #fff; }
  .redeem-form .btn { width: 100%; margin-top: 14px; }
  .redeem-form .btn[disabled] { opacity: .6; }
  .redeem-msg { font-size: 14px; margin-top: 12px; min-height: 20px; word-break: break-word; }
  .redeem-msg.error { color: #a8071a; }
  .redeem-msg.ok { color: #0f7b3e; }
  /* 兑换成功的内容：等宽显示，长内容可横向滚动而不是把卡片撑破 */
  .redeem-content {
    margin-top: 16px;
    padding: 14px;
    text-align: left;
    background: #f7f8fa;
    border: 1px dashed #dfe1e6;
    border-radius: 10px;
    font-size: 15px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .redeem-content .label { font-size: 12px; color: #8a8f99; margin-bottom: 6px; white-space: normal; }
  .redeem-content .value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  @media (prefers-color-scheme: dark) {
    .redeem-form input, .redeem-content { background: #16181d; border-color: #2c3038; color: #e8eaed; }
  }
`;

/**
 * 兑换页。服务端直出表单，提交后由极小的内联 JS 调一次 /api/cardkeys/redeem，
 * 不引任何框架 —— 这个页面大多是在微信里被打开的，首屏不能等 JS。
 *
 * 结果直接铺在页面上而不是弹窗：微信里 alert 会被拦，且用户需要复制的
 * 内容（卡密对应的权益）留在页面上更顺手，不必再去记它。
 */
export function renderRedeemPage({ title } = {}) {
  const heading = title || '卡密兑换';
  return htmlResponse(
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(heading)}</title>
<style>${BASE_STYLE}${REDEEM_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <div class="tip">输入卡密即可兑换</div>
    <form class="redeem-form" id="redeemForm" autocomplete="off" novalidate>
      <input id="code" name="code" type="text" inputmode="text" autocapitalize="characters"
             autocorrect="off" spellcheck="false" maxlength="80" placeholder="DWZ-XXXX-XXXX-XXXX">
      <button class="btn" id="submit" type="submit">立即兑换</button>
    </form>
    <div class="redeem-msg" id="msg" role="status" aria-live="polite"></div>
    <div id="result"></div>
  </div>
  <script>
    (function () {
      var form = document.getElementById('redeemForm');
      var input = document.getElementById('code');
      var submit = document.getElementById('submit');
      var msg = document.getElementById('msg');
      var result = document.getElementById('result');

      function say(text, kind) {
        msg.textContent = text || '';
        msg.className = 'redeem-msg' + (kind ? ' ' + kind : '');
      }

      function escapeText(value) {
        var div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
      }

      function showContent(block) {
        var content = '<div class="redeem-content">'
          + '<div class="label">兑换内容</div>'
          + '<div class="value" id="redeemValue">' + escapeText(block.content) + '</div></div>'
          + '<button class="btn" id="copyBtn" type="button">复制兑换内容</button>';
        result.innerHTML = content;
        document.getElementById('copyBtn').addEventListener('click', function () {
          var value = document.getElementById('redeemValue').textContent;
          var ta = document.createElement('textarea');
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); this.textContent = '已复制'; } catch (e) { this.textContent = '复制失败，请长按选择'; }
          document.body.removeChild(ta);
        });
      }

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var code = input.value.trim();
        if (!code) { say('请输入卡密', 'error'); input.focus(); return; }

        submit.disabled = true;
        say('兑换中…');
        result.innerHTML = '';

        fetch('/api/cardkeys/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: code }),
        })
          .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
          .then(function (out) {
            var block = out.body && out.body.data ? out.body.data : out.body;
            if (!out.ok) throw new Error((out.body && out.body.msg) || '兑换失败，请稍后重试');
            say('兑换成功', 'ok');
            input.value = '';
            showContent(block || {});
            // 配了跳转地址就自动跳；没配就留在页面上让用户复制内容
            if (block && block.redirectUrl) {
              var target = block.redirectUrl;
              say('兑换成功，正在跳转…', 'ok');
              setTimeout(function () { window.location.href = target; }, 600);
            }
          })
          .catch(function (error) { say(error.message || '兑换失败，请稍后重试', 'error'); })
          .then(function () { submit.disabled = false; });
      });
    })();
  <\/script>
</body>
</html>`,
  );
}

/** 兑换页取标题用：库结构缺失时不至于整页 500。 */
export async function redeemPageTitle(env, key) {
  if (!key) return '';
  try {
    const row = await env.DB.prepare('SELECT name FROM cardkey_batches WHERE id = ?').bind(key).first();
    return row?.name ?? '';
  } catch {
    return '';
  }
}
