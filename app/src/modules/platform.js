// 运行环境识别（移动端 / 应用内置浏览器）：打印与分享路径据此分流。
// UA 判定抽成纯函数，便于 node --test 覆盖；面向浏览器的包装函数只负责读取 navigator。

/** 纯函数：按 UA 判断移动端（不含 iPadOS 桌面 UA 需借助触点数的情形）。 */
export function isMobileUserAgent(ua) {
  return /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(String(ua || ''));
}

/** 是否移动端浏览器：UA 为主；iPadOS 13+ 上报桌面版 Macintosh UA，用触点数辅助识别。 */
export function isMobileBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (isMobileUserAgent(ua)) return true;
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

/**
 * 纯函数：识别「调用打印会被静默拦截」的应用内置浏览器，返回应用名；系统浏览器返回 null。
 * 这些 WebView 通常不实现打印（或实现为空操作），只能引导用户改用外部浏览器。
 */
export function detectInAppFromUserAgent(ua) {
  const text = String(ua || '');
  // 企业微信 UA 同时含 MicroMessenger 与 wxwork，须先判断
  const known = [
    [/wxwork/i, '企业微信'],
    [/MicroMessenger/i, '微信'],
    [/\bQQ\//i, 'QQ'],
    [/DingTalk/i, '钉钉'],
    [/Lark|Feishu/i, '飞书'],
    [/AlipayClient/i, '支付宝'],
    [/Weibo/i, '微博']
  ];
  for (const item of known) {
    if (item[0].test(text)) return item[1];
  }
  return null;
}

/** 是否处于不支持打印的应用内置浏览器（微信/QQ/钉钉等）。 */
export function detectInAppBrowser() {
  if (typeof navigator === 'undefined') return null;
  return detectInAppFromUserAgent(navigator.userAgent || '');
}
