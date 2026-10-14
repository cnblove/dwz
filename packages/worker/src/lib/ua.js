/**
 * 从 User-Agent 推导设备与来源 App。
 * 判定顺序按特异性从高到低，避免 QQ 浏览器被 QQ 抢先命中。
 */
const APP_RULES = [
  [/MicroMessenger/i, '微信'],
  [/WeCom|wxwork/i, '企业微信'],
  [/QQBrowser/i, 'QQ浏览器'],
  [/QQ\//i, 'QQ'],
  [/Weibo/i, '微博'],
  [/BiliApp|哔哩哔哩/i, '哔哩哔哩'],
  [/AlipayClient/i, '支付宝'],
  [/baiduboxapp/i, '百度'],
  [/DingTalk/i, '钉钉'],
  [/MiuiBrowser/i, '小米浏览器'],
  [/HuaweiBrowser/i, '华为浏览器'],
  [/Douyin|aweme/i, '抖音'],
  [/Kuaishou|Kwai/i, '快手'],
  [/XiaoHongShu|xhs/i, '小红书'],
  [/UCBrowser/i, 'UC浏览器'],
];

const OS_RULES = [
  [/iPad/i, 'iPad'],
  [/iPhone/i, 'iOS'],
  [/Android/i, 'Android'],
  [/Windows/i, 'Windows'],
  [/Macintosh|Mac OS X/i, 'Mac'],
  [/X11|Linux/i, 'Linux'],
];

export function detectOs(ua = '') {
  for (const [pattern, label] of OS_RULES) {
    if (pattern.test(ua)) return label;
  }
  return '未知设备';
}

export function detectApp(ua = '') {
  for (const [pattern, label] of APP_RULES) {
    if (pattern.test(ua)) return label;
  }
  return '其它';
}

export function isMobileUa(ua = '') {
  return /iPhone|iPad|Android|Mobile|MicroMessenger/i.test(ua);
}

/**
 * 访问限制判定。
 * 返回 true 表示允许继续跳转，false 表示应当拒绝并给出提示。
 */
export function allowsAccess(rule, ua = '') {
  switch (rule) {
    case 'wechat':
      return /MicroMessenger/i.test(ua);
    case 'ios':
      return /iPhone|iPad/i.test(ua);
    case 'android':
      return /Android/i.test(ua);
    case 'mobile':
      // 仅手机浏览器：排除微信/企业微信内置浏览器与桌面系统
      return isMobileUa(ua) && !/Windows|Macintosh|X11|MicroMessenger|WeCom|wxwork/i.test(ua);
    case 'desktop':
      return !isMobileUa(ua);
    case 'any':
    default:
      return true;
  }
}

/** 拒绝访问时面向访客的中文提示。 */
export const ACCESS_DENIED_TEXT = {
  wechat: '仅限微信内访问',
  ios: '仅限 iOS 设备访问',
  android: '仅限 Android 设备访问',
  mobile: '请使用手机浏览器打开',
  desktop: '仅限电脑访问',
};

/** 按设备类型挑选分流目标，缺省回退到通用目标。 */
export function pickTargetUrl({ rule, url, urlIos, urlAndroid, urlDesktop }, ua = '') {
  if (/iPhone|iPad/i.test(ua) && urlIos) return urlIos;
  if (/Android/i.test(ua) && urlAndroid) return urlAndroid;
  if (!isMobileUa(ua) && urlDesktop) return urlDesktop;
  return url;
}
