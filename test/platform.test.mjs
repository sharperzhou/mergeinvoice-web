import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectInAppFromUserAgent,
  isMobileUserAgent
} from '../app/src/modules/platform.js';

// 运行环境识别：移动端 UA 判定、应用内置浏览器识别（打印路径据此分流）

const UA_WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const UA_WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0';
const UA_ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36';
const UA_IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
// iPadOS 13+ 默认上报桌面版 Safari UA，需靠触点数辅助识别（纯函数只看 UA，故应为 false）
const UA_IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

test('isMobileUserAgent：移动端 UA 为真，桌面端为假', () => {
  assert.equal(isMobileUserAgent(UA_ANDROID_CHROME), true);
  assert.equal(isMobileUserAgent(UA_IPHONE_SAFARI), true);
  assert.equal(isMobileUserAgent(UA_WINDOWS_CHROME), false);
  assert.equal(isMobileUserAgent(UA_WINDOWS_EDGE), false);
  assert.equal(isMobileUserAgent(UA_IPAD_DESKTOP), false);
  assert.equal(isMobileUserAgent(''), false);
  assert.equal(isMobileUserAgent(undefined), false);
});

test('detectInAppFromUserAgent：识别主流应用内置浏览器', () => {
  const wechat =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN';
  const wecom =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/7.0.1.6690(0x27000158) wxwork/4.1.20 MicroMessenger/7.0.1 Language/zh';
  const qq =
    'Mozilla/5.0 (Linux; U; Android 13; zh-cn; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 V1_AND_SQ_8.9.63_4592_YYB_D QQ/8.9.63.11155 NetType/WIFI';
  const dingtalk =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 AliApp(DingTalk/7.5.0) com.alibaba.android.rimet/2000';
  const feishu =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Lark/7.10.0 LarkLocale/zh_CN';
  const alipay =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AlipayClient/10.5.60.8000';
  const weibo =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Weibo (iPhone; iOS 17.4)';

  // 企业微信 UA 同时含 MicroMessenger，须优先判定为「企业微信」
  assert.equal(detectInAppFromUserAgent(wecom), '企业微信');
  assert.equal(detectInAppFromUserAgent(wechat), '微信');
  assert.equal(detectInAppFromUserAgent(qq), 'QQ');
  assert.equal(detectInAppFromUserAgent(dingtalk), '钉钉');
  assert.equal(detectInAppFromUserAgent(feishu), '飞书');
  assert.equal(detectInAppFromUserAgent(alipay), '支付宝');
  assert.equal(detectInAppFromUserAgent(weibo), '微博');
});

test('detectInAppFromUserAgent：系统浏览器返回 null', () => {
  assert.equal(detectInAppFromUserAgent(UA_WINDOWS_CHROME), null);
  assert.equal(detectInAppFromUserAgent(UA_WINDOWS_EDGE), null);
  assert.equal(detectInAppFromUserAgent(UA_ANDROID_CHROME), null);
  assert.equal(detectInAppFromUserAgent(UA_IPHONE_SAFARI), null);
  assert.equal(detectInAppFromUserAgent(''), null);
  assert.equal(detectInAppFromUserAgent(undefined), null);
});
