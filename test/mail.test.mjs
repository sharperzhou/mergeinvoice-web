import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAIL_PROVIDERS,
  MailError,
  decodeMessages,
  fetchRaw,
  filterByKeywords,
  formatMailDate,
  parseKeywords,
  searchMail,
  sortMessagesNewestFirst,
  structureHasAttachment
} from '../app/src/modules/mail.js';

// 邮箱 API 客户端：关键词过滤 / 头解码 / 错误归类（fetch 打桩验证请求形态）

test('服务商预设与 Worker 白名单一致', () => {
  assert.deepEqual(
    MAIL_PROVIDERS.map((provider) => provider.id),
    ['163', '126', 'yeah', 'qq']
  );
});

test('parseKeywords：中英文分隔符、小写化、引号短语、空输入', () => {
  assert.deepEqual(parseKeywords('滴滴,华住 12306，铁路'), ['滴滴', '华住', '12306', '铁路']);
  assert.deepEqual(parseKeywords('Didi, HUAZHU'), ['didi', 'huazhu']);
  // 引号内视为短语（可含空格），整体匹配
  assert.deepEqual(parseKeywords('滴滴 "电子 发票"'), ['滴滴', '电子 发票']);
  assert.deepEqual(parseKeywords('""'), []);
  assert.deepEqual(parseKeywords(''), []);
  assert.deepEqual(parseKeywords(null), []);
  assert.deepEqual(parseKeywords('  ,,  '), []);
});

test('filterByKeywords：主题/发件人/附件名命中；留空不过滤且保序', () => {
  const messages = [
    { uid: 1, subject: '滴滴出行电子发票', from: 'no-reply@didi.com', date: '', names: ['电子发票.pdf'] },
    { uid: 2, subject: '华住酒店发票', from: 'invoice@huazhu.com', date: '', names: ['发票.zip'] },
    { uid: 3, subject: '行程通知', from: 'service@12306.cn', date: '', names: ['行程单.pdf'] }
  ];
  assert.deepEqual(filterByKeywords(messages, '').map((m) => m.uid), [1, 2, 3]);
  assert.deepEqual(filterByKeywords(messages, '滴滴').map((m) => m.uid), [1]);
  // 发件人域名命中（大小写不敏感）
  assert.deepEqual(filterByKeywords(messages, 'HUAZHU').map((m) => m.uid), [2]);
  // 多关键词任一命中
  assert.deepEqual(filterByKeywords(messages, '12306,铁路').map((m) => m.uid), [3]);
  // 仅附件文件名命中（主题/发件人都没有「行程单」）
  assert.deepEqual(filterByKeywords(messages, '行程单').map((m) => m.uid), [3]);
  assert.deepEqual(filterByKeywords(messages, '不存在的词'), []);
});

test('decodeMessages：RFC2047 中文主题解码', () => {
  const raw = [{ uid: 9, headers: 'Subject: =?UTF-8?B?5rWL6K+V?=\r\nFrom: a@b.c\r\n\r\n' }];
  const [message] = decodeMessages(raw);
  assert.equal(message.uid, 9);
  assert.equal(message.subject, '测试');
  assert.equal(message.from, 'a@b.c');
});

test('decodeMessages：无主题回退占位文案', () => {
  const [message] = decodeMessages([{ uid: 1, headers: 'From: a@b.c\r\n\r\n' }]);
  assert.equal(message.subject, '（无主题）');
});

test('decodeMessages：透传 structure 与解码附件名（RFC2231 / RFC2047）', () => {
  const [withStruct] = decodeMessages([
    {
      uid: 1,
      headers: 'From: a@b.c\r\n\r\n',
      structure: '("APPLICATION" "PDF")',
      names: ["utf-8''%E7%94%B5%E5%AD%90%E5%8F%91%E7%A5%A8.pdf", '=?UTF-8?B?5Y+R56Wo?=.zip']
    }
  ]);
  assert.equal(withStruct.structure, '("APPLICATION" "PDF")');
  assert.deepEqual(withStruct.names, ['电子发票.pdf', '发票.zip']);
  const [withoutStruct] = decodeMessages([{ uid: 2, headers: 'From: a@b.c\r\n\r\n' }]);
  assert.equal(withoutStruct.structure, null);
  assert.deepEqual(withoutStruct.names, []);
});

test('sortMessagesNewestFirst：按 Date 倒序，坏日期沉底并按 UID 倒序兜底', () => {
  const input = [
    { uid: 1, date: 'Fri, 30 Oct 2026 08:00:00 +0800' },
    { uid: 3, date: 'Sat, 31 Oct 2026 09:00:00 +0800' },
    { uid: 2, date: 'not-a-date' },
    { uid: 4, date: 'Thu, 29 Oct 2026 07:00:00 +0800' }
  ];
  const sorted = sortMessagesNewestFirst(input);
  assert.deepEqual(sorted.map((m) => m.uid), [3, 1, 4, 2]);
  // 不改变原数组
  assert.deepEqual(input.map((m) => m.uid), [1, 3, 2, 4]);
  // 同日期按 UID 倒序兜底
  const sameDate = [
    { uid: 5, date: 'Sat, 31 Oct 2026 09:00:00 +0800' },
    { uid: 9, date: 'Sat, 31 Oct 2026 09:00:00 +0800' }
  ];
  assert.deepEqual(sortMessagesNewestFirst(sameDate).map((m) => m.uid), [9, 5]);
});

test('structureHasAttachment：媒体类型 / 文件名后缀 / 缺失容错', () => {
  // 媒体类型直接声明 PDF / ZIP（大小写不敏感）
  assert.equal(structureHasAttachment('("APPLICATION" "PDF" ("NAME" "a.pdf"))'), true);
  assert.equal(structureHasAttachment('("text" "plain") ("application" "zip")'), true);
  // 常见「打包附件」形态：x-zip-compressed / octet-stream 一律按可能含附件处理
  assert.equal(structureHasAttachment('("APPLICATION" "X-ZIP-COMPRESSED" ("NAME" "a.zip"))'), true);
  assert.equal(structureHasAttachment('("APPLICATION" "OCTET-STREAM" NIL NIL NIL)'), true);
  // 文件名被 RFC2047 编码（不含 .pdf 明文）也要保留
  assert.equal(structureHasAttachment('("APPLICATION" "OCTET-STREAM" ("NAME" "=?UTF-8?B?5Y+R56Wo?="))'), true);
  // 名称参数以 .pdf/.zip 结尾（含 RFC2231 百分号编码）
  assert.equal(structureHasAttachment('("APPLICATION" "OCTET-STREAM" ("NAME" "发票.pdf"))'), true);
  assert.equal(structureHasAttachment('("TEXT" "PLAIN" ("NAME" "utf-8\'\'%E5%8F%91%E7%A5%A8.zip"))'), true);
  // 结构含字面量占位（解析不完整）按可能有附件处理
  assert.equal(structureHasAttachment('("APPLICATION" "OCTET-STREAM" ("NAME" {12}\n)'), true);
  // 纯文本邮件：无附件
  assert.equal(structureHasAttachment('("TEXT" "PLAIN" NIL NIL "7BIT" "UTF-8" 100 10)'), false);
  assert.equal(structureHasAttachment('("MULTIPART" "ALTERNATIVE" ("TEXT" "PLAIN") ("TEXT" "HTML"))'), false);
  // 结构缺失（老后端）宁可多列
  assert.equal(structureHasAttachment(null), true);
  assert.equal(structureHasAttachment(''), true);
});

test('formatMailDate：可解析则格式化，空值/坏值原样返回', () => {
  const text = formatMailDate('Fri, 30 Oct 2026 08:00:00 +0800');
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const d = new Date(Date.parse('Fri, 30 Oct 2026 08:00:00 +0800'));
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(
    text,
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
  assert.equal(formatMailDate(''), '');
  assert.equal(formatMailDate('not-a-date'), 'not-a-date');
});

test('searchMail：POST 到 /mail/search，401 授权码错误归类 auth', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ error: '授权码错误或 IMAP 服务未开启' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    await assert.rejects(
      () =>
        searchMail({
          provider: '163',
          email: 'a@163.com',
          code: 'bad-code',
          startDate: '2026-10-01',
          endDate: '2026-10-31'
        }),
      (err) => err instanceof MailError && err.code === 'auth' && err.message.includes('授权码')
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/mail/search');
    assert.equal(calls[0].options.method, 'POST');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.provider, '163');
    assert.equal(body.startDate, '2026-10-01');
  } finally {
    globalThis.fetch = original;
  }
});

test('searchMail：404 归类为未部署后端（no-backend）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('Not Found', { status: 404 });
  try {
    await assert.rejects(
      () =>
        searchMail({
          provider: 'qq',
          email: 'a@qq.com',
          code: 'x',
          startDate: '2026-10-01',
          endDate: '2026-10-31'
        }),
      (err) => err instanceof MailError && err.code === 'no-backend' && err.message.includes('404')
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('searchMail：带令牌时附加 Authorization 头，成功返回 messages', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ messages: [{ uid: 1, headers: 'Subject: x\r\n' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const messages = await searchMail({
      provider: 'yeah',
      email: 'a@yeah.net',
      code: 'x',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      apiBase: 'https://demo.example.com/api/',
      token: 'secret'
    });
    assert.equal(messages.length, 1);
    assert.equal(calls[0].url, 'https://demo.example.com/api/mail/search'); // 尾斜杠被规整
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchRaw：POST /mail/raw 并返回响应字节', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'message/rfc822' }
    });
  };
  try {
    const bytes = await fetchRaw({ provider: 'qq', email: 'a@qq.com', code: 'c', uid: 5 });
    assert.deepEqual(bytes, new Uint8Array([1, 2, 3, 4]));
    assert.equal(calls[0].url, '/api/mail/raw');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      provider: 'qq',
      email: 'a@qq.com',
      code: 'c',
      uid: 5
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('网络异常归类为 network', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  try {
    await assert.rejects(
      () =>
        fetchRaw({ provider: '126', email: 'a@126.com', code: 'c', uid: 1 }),
      (err) => err instanceof MailError && err.code === 'network'
    );
  } finally {
    globalThis.fetch = original;
  }
});
