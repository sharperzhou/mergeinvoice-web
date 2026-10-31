import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadableStream, WritableStream } from 'node:stream/web';
import { formatImapDate, ImapError, ImapSession, structureLooksLikeAttachment } from '../worker/src/imap.js';

// 内存假 IMAP 服务器 + 最小客户端会话验证：
// 命令序列、SINCE/BEFORE 日期、SEARCH 折行、FETCH 字面量跨 chunk、GBK 头回退、错误状态映射。

const enc = new TextEncoder();

/**
 * 创建假 IMAP 服务器：读端（服务器→客户端）按需推送响应，
 * 写端（客户端→服务器）按 CRLF 切行交给 onCommand，返回字符串或字节即为响应。
 * chunkSize > 0 时响应按该字节数切块，用于压测跨 chunk 行/字面量读取。
 */
function createFakeImap({ greeting = '* OK IMAP4rev1 ready\r\n', onCommand, chunkSize = 0 } = {}) {
  const dec = new TextDecoder();
  const received = [];
  let controller = null;
  let buf = '';

  function pushBytes(bytes) {
    if (!controller) return;
    if (chunkSize > 0) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
    } else {
      controller.enqueue(bytes);
    }
  }

  const readable = new ReadableStream({
    start(c) {
      controller = c;
    }
  });
  const writable = new WritableStream({
    write(chunk) {
      buf += dec.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        received.push(line);
        const sp = line.indexOf(' ');
        const res = onCommand ? onCommand(line.slice(0, sp), line.slice(sp + 1)) : null;
        if (res) pushBytes(typeof res === 'string' ? enc.encode(res) : res);
      }
    }
  });
  pushBytes(enc.encode(greeting));
  return { streams: { readable, writable }, received, closeStream: () => controller.close() };
}

/** 拼接多个字符串/字节片段为单个 Uint8Array。 */
function concat(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 构造一条 `* n FETCH (UID … {len}` + 字面量 + `)` 响应（不含标记行）。 */
function buildFetch(uid, literal) {
  const lit = typeof literal === 'string' ? enc.encode(literal) : literal;
  return concat(`* 1 FETCH (UID ${uid} BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${lit.length}}\r\n`, lit, ')\r\n');
}

test('formatImapDate：dd-Mmm-yyyy（UTC）', () => {
  assert.equal(formatImapDate(new Date(Date.UTC(2026, 0, 5))), '05-Jan-2026');
  assert.equal(formatImapDate(new Date(Date.UTC(2026, 9, 31))), '31-Oct-2026');
});

test('完整会话：LOGIN→ID→SELECT→SEARCH→FETCH 头→FETCH 正文→LOGOUT', async () => {
  const headerA = 'Subject: 滴滴出行电子发票\r\nFrom: no-reply@didi.com\r\nDate: Fri, 30 Oct 2026 08:00:00 +0800\r\n';
  const headerB = 'Subject: 华住酒店发票\r\nFrom: invoice@huazhu.com\r\nDate: Sat, 31 Oct 2026 09:00:00 +0800\r\n';
  const messageA = 'From: no-reply@didi.com\r\nSubject: 滴滴出行电子发票\r\n\r\n正文与 PDF 附件（原始字节）\r\n';

  const { streams, received } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('LOGIN')) return `${tag} OK LOGIN completed\r\n`;
      if (cmd.startsWith('ID')) return `* ID ("name" "Coremail" "version" "001")\r\n${tag} OK ID completed\r\n`;
      if (cmd.startsWith('SELECT')) return `* 2 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`;
      if (cmd.startsWith('UID SEARCH')) return `* SEARCH 10 11\r\n${tag} OK SEARCH completed\r\n`;
      if (cmd.startsWith('UID FETCH') && cmd.includes('HEADER.FIELDS')) {
        return concat(buildFetch(10, headerA), buildFetch(11, headerB), `${tag} OK FETCH completed\r\n`);
      }
      if (cmd.startsWith('UID FETCH')) {
        return concat(`* 1 FETCH (UID 10 BODY[] {${enc.encode(messageA).length}}\r\n`, messageA, `)\r\n${tag} OK FETCH completed\r\n`);
      }
      if (cmd.startsWith('LOGOUT')) return `* BYE\r\n${tag} OK LOGOUT completed\r\n`;
      return `${tag} BAD unknown command\r\n`;
    }
  });

  const session = new ImapSession(streams);
  await session.readGreeting();
  await session.login('user@163.com', 'authcode123');
  await session.id();
  await session.selectInbox();
  const uids = await session.search(new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 10, 1)));
  const headers = await session.fetchHeaders(uids);
  const message = await session.fetchFull(10);
  await session.logout();

  assert.deepEqual(uids, [10, 11]);
  assert.equal(headers.length, 2);
  assert.equal(headers[0].uid, 10);
  assert.equal(headers[0].headers, headerA);
  assert.equal(headers[1].uid, 11);
  assert.equal(headers[1].headers, headerB);
  assert.deepEqual(message, enc.encode(messageA));

  // 命令序列与搜索日期格式（BEFORE 为开区间，由调用方传结束日 + 1 天）
  assert.equal(received[0], 'A001 LOGIN "user@163.com" "authcode123"');
  assert.equal(received[1], 'A002 ID ("name" "MergeInvoice-Web" "version" "1.0.0" "vendor" "MergeInvoice")');
  assert.equal(received[2], 'A003 SELECT INBOX');
  assert.equal(received[3], 'A004 UID SEARCH SINCE 01-Oct-2026 BEFORE 01-Nov-2026');
  assert.equal(received[4], 'A005 UID FETCH 10,11 (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])');
  assert.equal(received[5], 'A006 UID FETCH 10 (UID BODY.PEEK[])');
  assert.equal(received[6], 'A007 LOGOUT');
});

test('网易 163 风控复现：未发 ID 的 SELECT 被拒 Unsafe Login，补发 ID 后放行', async () => {
  // 模拟 Coremail 规则（官方帮助中心确认）：登录成功后必须先收到 ID 才允许 SELECT
  let idSeen = false;
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('LOGIN')) return `${tag} OK LOGIN completed\r\n`;
      if (cmd.startsWith('ID')) {
        idSeen = true;
        return `* ID ("name" "Coremail")\r\n${tag} OK ID completed\r\n`;
      }
      if (cmd.startsWith('SELECT')) {
        if (!idSeen) return `${tag} NO SELECT Unsafe Login. Please contact kefu@188.com for help\r\n`;
        return `* 1 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`;
      }
      return `${tag} OK\r\n`;
    }
  });

  const session = new ImapSession(streams);
  await session.readGreeting();
  await session.login('user@163.com', 'authcode123');
  // 未发 ID 直接 SELECT：被拒且带 Unsafe Login 详情
  await assert.rejects(
    () => session.selectInbox(),
    (err) => err instanceof ImapError && err.status === 'NO' && err.detail.includes('Unsafe Login')
  );
  // 补发 ID 后重试 SELECT：放行（index.js 的正序即 login → id → select）
  assert.equal(await session.id(), true);
  await session.selectInbox();
});

test('SELECT 被拒 Unsafe Login 时给出中文指引（带原始详情）', async () => {
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('SELECT')) return `${tag} NO SELECT Unsafe Login. Please contact kefu@188.com for help\r\n`;
      return `${tag} OK\r\n`;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  await assert.rejects(
    () => session.selectInbox(),
    (err) =>
      err instanceof ImapError &&
      err.status === 'NO' &&
      err.message.includes('登录环境不安全') &&
      err.detail.includes('Unsafe Login')
  );
});

test('ID 不被服务器识别（BAD）时容忍返回 false，不抛错', async () => {
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => (cmd.startsWith('ID') ? `${tag} BAD Unknown command\r\n` : `${tag} OK\r\n`)
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  assert.equal(await session.id(), false);
});

test('fetchHeaders：解析 BODYSTRUCTURE（字面量前），引号串内的括号不破坏配对', async () => {
  const header = 'Subject: 发票\r\nFrom: a@b.c\r\n';
  // 文件名含不配对括号（"a(1.pdf"），括号扫描须跳过引号串内容
  const structure = '("APPLICATION" "PDF" ("NAME" "a(1.pdf") NIL "BASE64" 100 NIL NIL NIL)';
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('UID FETCH')) {
        return concat(
          `* 1 FETCH (UID 10 BODYSTRUCTURE ${structure} BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${enc.encode(header).length}}\r\n`,
          header,
          `)\r\n${tag} OK\r\n`
        );
      }
      return `${tag} OK\r\n`;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  const [entry] = await session.fetchHeaders([10]);
  assert.equal(entry.uid, 10);
  assert.equal(entry.headers, header);
  assert.equal(entry.structure, structure);
  // 附件名参数同步提取（供前端关键词匹配；引号内不配对括号已还原）
  assert.deepEqual(entry.names, ['a(1.pdf']);
});

test('fetchHeaders：BODYSTRUCTURE 在字面量之后同样能解析，且不影响邮件头', async () => {
  const header = 'Subject: 华住发票\r\nFrom: invoice@huazhu.com\r\n';
  const structure = '("TEXT" "PLAIN" NIL NIL "7BIT" "UTF-8" 10 1)';
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('UID FETCH')) {
        return concat(
          `* 1 FETCH (UID 11 BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${enc.encode(header).length}}\r\n`,
          header,
          ` BODYSTRUCTURE ${structure})\r\n${tag} OK\r\n`
        );
      }
      return `${tag} OK\r\n`;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  const [entry] = await session.fetchHeaders([11]);
  assert.equal(entry.headers, header);
  assert.equal(entry.structure, structure);
});

test('fetchHeaders：无 BODYSTRUCTURE 时 structure 为 null（老服务器容错）', async () => {
  const header = 'Subject: 测试\r\nFrom: a@b.c\r\n';
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('UID FETCH')) return concat(buildFetch(12, header), `${tag} OK\r\n`);
      return `${tag} OK\r\n`;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  const [entry] = await session.fetchHeaders([12]);
  assert.equal(entry.headers, header);
  assert.equal(entry.structure, null);
});

test('structureLooksLikeAttachment：与前端同规则（宁可多取）', () => {
  assert.equal(structureLooksLikeAttachment('("APPLICATION" "PDF" ("NAME" "a.pdf"))'), true);
  assert.equal(structureLooksLikeAttachment('("APPLICATION" "X-ZIP-COMPRESSED" NIL NIL NIL)'), true);
  assert.equal(structureLooksLikeAttachment('("TEXT" "PLAIN" NIL NIL "7BIT" "UTF-8" 10 1)'), false);
  assert.equal(structureLooksLikeAttachment(null), true);
});

/** 造一条带 BODYSTRUCTURE 的 FETCH 响应（含邮件头字面量），供分批扫描测试。 */
function buildFetchWithStructure(uid, structure, header, seq) {
  return concat(
    `* ${seq} FETCH (UID ${uid} BODYSTRUCTURE ${structure} BODY[HEADER.FIELDS (SUBJECT FROM DATE)] {${enc.encode(header).length}}\r\n`,
    header,
    `)\r\n`
  );
}

test('collectAttachmentMails：分批预筛附件，凑满 limit 即停', async () => {
  const header = 'Subject: x\r\nFrom: a@b.c\r\n';
  const noAtt = '("TEXT" "PLAIN" NIL NIL "7BIT" "UTF-8" 10 1)';
  const att = '("APPLICATION" "PDF" ("NAME" "a.pdf") NIL "BASE64" 100 NIL NIL NIL)';
  let fetchCount = 0;
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (!cmd.startsWith('UID FETCH')) return `${tag} OK\r\n`;
      fetchCount += 1;
      const ids = cmd.slice('UID FETCH '.length, cmd.indexOf(' (')).split(',').map(Number);
      // 约定：UID >= 100 视为有附件
      const parts = ids.map((uid, i) => buildFetchWithStructure(uid, uid >= 100 ? att : noAtt, header, i + 1));
      return concat(...parts, `${tag} OK\r\n`);
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  const out = await session.collectAttachmentMails([120, 110, 105, 90, 80], { limit: 2, batchSize: 4 });
  assert.deepEqual(out.map((m) => m.uid), [120, 110]);
  // 首批已凑满，不再发起第二次 FETCH
  assert.equal(fetchCount, 1);
});

test('collectAttachmentMails：首批无附件时继续扫下一批，最多扫 maxScan 封', async () => {
  const header = 'Subject: x\r\nFrom: a@b.c\r\n';
  const noAtt = '("TEXT" "PLAIN" NIL NIL "7BIT" "UTF-8" 10 1)';
  const att = '("APPLICATION" "ZIP" ("NAME" "b.zip") NIL "BASE64" 100 NIL NIL NIL)';
  let fetchCount = 0;
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (!cmd.startsWith('UID FETCH')) return `${tag} OK\r\n`;
      fetchCount += 1;
      const ids = cmd.slice('UID FETCH '.length, cmd.indexOf(' (')).split(',').map(Number);
      // 约定：只有 UID 1 有附件
      const parts = ids.map((uid, i) => buildFetchWithStructure(uid, uid === 1 ? att : noAtt, header, i + 1));
      return concat(...parts, `${tag} OK\r\n`);
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  const out = await session.collectAttachmentMails([5, 4, 3, 2, 1], { limit: 1, batchSize: 2 });
  assert.deepEqual(out.map((m) => m.uid), [1]);
  assert.equal(fetchCount, 3);
});

test('响应按 1 字节切块：跨 chunk 的 CRLF 与字面量仍可读', async () => {
  const header = 'Subject: 12306 报销凭证\r\nFrom: service@12306.cn\r\n';
  const message = 'From: service@12306.cn\r\n\r\nbinary \x00\x01\x02 payload\r\n';
  const { streams } = createFakeImap({
    chunkSize: 1,
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('LOGIN')) return `${tag} OK\r\n`;
      if (cmd.startsWith('SELECT')) return `${tag} OK\r\n`;
      if (cmd.startsWith('UID FETCH') && cmd.includes('HEADER.FIELDS')) return concat(buildFetch(7, header), `${tag} OK\r\n`);
      if (cmd.startsWith('UID FETCH')) {
        return concat(`* 1 FETCH (UID 7 BODY[] {${enc.encode(message).length}}\r\n`, message, `)\r\n${tag} OK\r\n`);
      }
      if (cmd.startsWith('LOGOUT')) return `${tag} OK\r\n`;
      return `${tag} BAD\r\n`;
    }
  });

  const session = new ImapSession(streams);
  await session.readGreeting();
  await session.login('a@b.c', 'x');
  await session.selectInbox();
  const [entry] = await session.fetchHeaders([7]);
  const full = await session.fetchFull(7);
  await session.logout();

  assert.equal(entry.headers, header);
  assert.deepEqual(full, enc.encode(message));
});

test('SEARCH 折行：后续行以空格开头仍并入 UID 列表', async () => {
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('UID SEARCH')) return `* SEARCH 10 11\r\n 12 13\r\n${tag} OK\r\n`;
      return `${tag} OK\r\n`;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  const uids = await session.search(new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 10, 1)));
  assert.deepEqual(uids, [10, 11, 12, 13]);
});

test('LOGIN 被拒（NO）映射为 AUTH 状态', async () => {
  const { streams } = createFakeImap({
    onCommand: (tag) => `${tag} NO Login failed: incorrect credentials\r\n`
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  await assert.rejects(
    () => session.login('u@163.com', 'bad'),
    (err) => err instanceof ImapError && err.status === 'AUTH' && err.message.includes('授权码')
  );
});

test('连接问候为 BYE 时抛 BAD', async () => {
  const { streams } = createFakeImap({ greeting: '* BYE Server is not accepting connections\r\n' });
  const session = new ImapSession(streams);
  await assert.rejects(() => session.readGreeting(), (err) => err instanceof ImapError && err.status === 'BAD');
});

test('服务器无应答即关闭：读行抛 CLOSED', async () => {
  const { streams, closeStream } = createFakeImap({
    onCommand: () => {
      closeStream(); // 收到命令后直接断开，不回任何响应
      return null;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  await assert.rejects(() => session.login('u', 'p'), (err) => err instanceof ImapError && err.status === 'CLOSED');
});

test('fetchFull 无字面量返回时映射 EMPTY 状态', async () => {
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('UID FETCH')) return `* 1 FETCH (UID 9 BODY[])\r\n${tag} OK\r\n`;
      return `${tag} OK\r\n`;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  await assert.rejects(() => session.fetchFull(9), (err) => err instanceof ImapError && err.status === 'EMPTY');
});

test('邮件头非法 UTF-8 字节回退按 GBK 解码', async () => {
  // GBK「中文」= D6 D0 CE C4（严格 UTF-8 解码必失败），夹在 ASCII 头中
  const gbkHeader = concat('Subject: ', new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), '\r\nFrom: a@b.c\r\n');
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('UID FETCH') && cmd.includes('HEADER.FIELDS')) return concat(buildFetch(3, gbkHeader), `${tag} OK\r\n`);
      return `${tag} OK\r\n`;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  const [entry] = await session.fetchHeaders([3]);
  assert.equal(entry.headers, 'Subject: 中文\r\nFrom: a@b.c\r\n');
});

test('FETCH 响应括号结构异常（超出保护上限）抛 BAD', async () => {
  // 字面量后的续行始终不闭合括号：凑满保护上限（100 次迭代）后必须抛错而非死等
  const openers = '(x\r\n'.repeat(150);
  const { streams } = createFakeImap({
    onCommand: (tag, cmd) => {
      if (cmd.startsWith('UID FETCH')) {
        return `* 1 FETCH (UID 5 BODY[] {4}\r\nABCD\r\n${openers}${tag} OK\r\n`;
      }
      return `${tag} OK\r\n`;
    }
  });
  const session = new ImapSession(streams);
  await session.readGreeting();
  await assert.rejects(() => session.fetchFull(5), (err) => err instanceof ImapError && err.status === 'BAD');
});
