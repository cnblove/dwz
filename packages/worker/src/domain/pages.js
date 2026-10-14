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
  .notice {
    font-size: 13px;
    color: #b26a00;
    background: #fff7e6;
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 16px;
  }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; }
  .tip { font-size: 14px; color: #646a73; margin: 16px 0 12px; }
  .qrcode { width: 240px; height: 240px; margin: 0 auto; display: block; border-radius: 8px; }
  .qrwrap { display: inline-block; padding: 8px; background: #fff; border-radius: 12px; }
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

const SAFETY_TIP = '为保障你的账号安全，请确认二维码来源可靠后再扫码';

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

export function renderExpiredPage(message) {
  return renderMessagePage({ title: '链接已过期', message: message || '链接已过期' }, {}, 410);
}

/* ---------------- 活码落地页 ---------------- */

export function renderCodePage(code, qrcode, { sticky } = {}) {
  const isGroup = code.kind === 'group';
  const parts = [];

  if (code.show_safety) {
    parts.push(`<div class="notice">${escapeHtml(SAFETY_TIP)}</div>`);
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
