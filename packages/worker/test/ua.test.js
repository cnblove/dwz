import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsAccess, detectApp, detectOs, isMobileUa, pickTargetUrl } from '../src/lib/ua.js';

const UAS = {
  wechatIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger/8.0.49',
  wechatAndroid: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit MicroMessenger/8.0.49',
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile Safari/537.36',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  douyin: 'Mozilla/5.0 (Linux; Android 13) aweme/28.0',
};

test('操作系统识别', () => {
  assert.equal(detectOs(UAS.wechatIos), 'iOS');
  assert.equal(detectOs(UAS.androidChrome), 'Android');
  assert.equal(detectOs(UAS.windowsChrome), 'Windows');
  assert.equal(detectOs(UAS.macSafari), 'Mac');
  assert.equal(detectOs(UAS.linuxFirefox), 'Linux');
  assert.equal(detectOs('curl/8.0'), '未知设备');
});

test('来源 App 识别，QQ 浏览器不会被误判为 QQ', () => {
  assert.equal(detectApp(UAS.wechatIos), '微信');
  assert.equal(detectApp(UAS.douyin), '抖音');
  assert.equal(detectApp('Mozilla/5.0 QQBrowser/12.0'), 'QQ浏览器');
  assert.equal(detectApp('Mozilla/5.0 QQ/8.9.0'), 'QQ');
});

test('访问限制：仅微信', () => {
  assert.equal(allowsAccess('wechat', UAS.wechatIos), true);
  assert.equal(allowsAccess('wechat', UAS.wechatAndroid), true);
  assert.equal(allowsAccess('wechat', UAS.iosSafari), false);
  assert.equal(allowsAccess('wechat', UAS.windowsChrome), false);
});

test('访问限制：仅手机浏览器排除微信与桌面', () => {
  assert.equal(allowsAccess('mobile', UAS.androidChrome), true);
  assert.equal(allowsAccess('mobile', UAS.iosSafari), true);
  assert.equal(allowsAccess('mobile', UAS.wechatIos), false);
  assert.equal(allowsAccess('mobile', UAS.windowsChrome), false);
});

test('访问限制：仅电脑', () => {
  assert.equal(allowsAccess('desktop', UAS.windowsChrome), true);
  assert.equal(allowsAccess('desktop', UAS.macSafari), true);
  assert.equal(allowsAccess('desktop', UAS.iosSafari), false);
});

test('访问限制：any 一律放行，未知规则保守拒绝', () => {
  assert.equal(allowsAccess('any', UAS.windowsChrome), true);
  assert.equal(allowsAccess('nonsense', UAS.windowsChrome), true);
});

test('isMobileUa', () => {
  assert.equal(isMobileUa(UAS.iosSafari), true);
  assert.equal(isMobileUa(UAS.windowsChrome), false);
});

test('按设备挑分流目标，缺省回退通用链接', () => {
  const link = { url: 'https://any.test', urlIos: 'https://ios.test', urlAndroid: 'https://android.test', urlDesktop: null };
  assert.equal(pickTargetUrl(link, UAS.iosSafari), 'https://ios.test');
  assert.equal(pickTargetUrl(link, UAS.androidChrome), 'https://android.test');
  assert.equal(pickTargetUrl(link, UAS.windowsChrome), 'https://any.test');
  assert.equal(pickTargetUrl({ url: 'https://any.test' }, UAS.iosSafari), 'https://any.test');
});
