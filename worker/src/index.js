// Cloudflare Worker 入口：静态前端（dist/ 经 ASSETS 绑定透传）+ 邮箱 IMAP 中继 API。
// 职责刻意做薄：只做校验与 IMAP 字节中继，MIME 解析、ZIP 展开、关键词过滤全在前端
// ——既避开 Workers 免费版 10ms/请求的 CPU 限制，也让这些逻辑能被 node --test 覆盖。
// 安全：服务商主机白名单（validate.js）、可选 API_TOKEN 门禁、不落盘、不打印任何凭据。
import { connect } from 'cloudflare:sockets';
import { ImapError, ImapSession } from './imap.js';
import {
  ValidationError,
  parseLimit,
  parseUid,
  requireString,
  resolveDateRange,
  resolveProvider
} from './validate.js';

const IMAP_PORT = 993;
/** 单次 IMAP 会话整体超时（网络等待不计入 Workers CPU 配额，可安全放宽）。 */
const OPER_TIMEOUT_MS = 60000;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/mail/search' || pathname === '/api/mail/raw') {
      return handleApi(request, env, pathname);
    }
    // 其余路径交给静态资源（vite build 产物）
    return env.ASSETS.fetch(request);
  }
};

/** API 分发：OPTIONS 预检 → 方法/令牌校验 → JSON 解析 → 业务处理 → 统一错误映射。 */
async function handleApi(request, env, pathname) {
  if (request.method === 'OPTIONS') return preflightReply(env);
  if (request.method !== 'POST') return errorReply(405, '仅支持 POST', env);
  if (!checkToken(request, env)) return errorReply(401, '未授权：访问令牌缺失或错误', env);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorReply(400, '请求体必须是 JSON 对象', env);
  }
  if (!body || typeof body !== 'object') return errorReply(400, '请求体必须是 JSON 对象', env);

  try {
    if (pathname === '/api/mail/search') return await handleSearch(body, env);
    return await handleRaw(body, env);
  } catch (err) {
    if (err instanceof ValidationError) return errorReply(400, err.message, env);
    if (err instanceof ImapError) return imapErrorReply(err, env);
    // 其余多为网络层异常，统一 502 且不透传内部细节
    return errorReply(502, 'IMAP 服务连接失败，请稍后重试', env);
  }
}

/** 搜索：按时间范围取 UID → 分批 FETCH 邮件头与 BODYSTRUCTURE，仅保留含 PDF/ZIP 附件的邮件。 */
async function handleSearch(body, env) {
  const host = resolveProvider(body.provider);
  const email = requireString(body.email, '邮箱账号');
  const code = requireString(body.code, '授权码');
  const { since, before } = resolveDateRange(body.startDate, body.endDate);
  const limit = parseLimit(body.limit);

  const messages = await withImap(host, email, code, async (session) => {
    const uids = await session.search(since, before);
    if (uids.length === 0) return [];
    // 新的在前；服务端按 BODYSTRUCTURE 预筛附件，避免无附件邮件占满返回上限
    const newestFirst = uids.slice().sort((a, b) => b - a);
    return session.collectAttachmentMails(newestFirst, { limit });
  });
  return jsonReply(200, { messages }, env);
}

/** 取信：返回单封邮件原始 RFC822 字节（BODY.PEEK[] 不改变已读状态）。 */
async function handleRaw(body, env) {
  const host = resolveProvider(body.provider);
  const email = requireString(body.email, '邮箱账号');
  const code = requireString(body.code, '授权码');
  const uid = parseUid(body.uid);

  const bytes = await withImap(host, email, code, (session) => session.fetchFull(uid));
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'message/rfc822', ...corsHeaders(env) }
  });
}

/**
 * 建立一条 IMAP 会话并执行 fn：连接 → 问候 → 登录 → 选收件箱 → fn → LOGOUT。
 * 整体受超时约束；无论成败关闭 socket（超时后内层任务的失败已被 Promise.race 吞掉，不会泄漏未处理拒绝）。
 */
async function withImap(host, email, code, fn) {
  // secureTransport 属于第二个 options 参数（放进 address 会被静默忽略，降级成明文连接）
  const socket = connect({ hostname: host, port: IMAP_PORT }, { secureTransport: 'on' });
  try {
    return await withTimeout(
      (async () => {
        try {
          await socket.opened;
        } catch (err) {
          throw new ImapError('无法连接 IMAP 服务器', 'CONNECT', String(err && err.message));
        }
        const session = new ImapSession({ readable: socket.readable, writable: socket.writable });
        await session.readGreeting();
        await session.login(email, code);
        // 网易系要求登录后先发 ID 声明客户端身份，否则 SELECT 被拒「Unsafe Login」（容忍不识别的服务器）
        await session.id();
        await session.selectInbox();
        const out = await fn(session);
        try {
          await session.logout();
        } catch {
          /* 尽力而为：服务器可能已断开，结果不受影响 */
        }
        return out;
      })(),
      OPER_TIMEOUT_MS
    );
  } finally {
    try {
      socket.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 超时包装：超时抛 ImapError(TIMEOUT)，映射为 504。 */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ImapError('IMAP 操作超时', 'TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/** IMAP 协议错误 → HTTP 状态与中文提示（凭据相关只用固定文案，不回显服务器原文）。 */
function imapErrorReply(err, env) {
  switch (err.status) {
    case 'AUTH':
      return errorReply(401, '授权码错误或 IMAP 服务未开启', env);
    case 'TIMEOUT':
      return errorReply(504, 'IMAP 操作超时，请缩小时间范围后重试', env);
    case 'CONNECT':
    case 'CLOSED':
      return errorReply(502, '无法保持 IMAP 连接，请稍后重试', env);
    case 'NO':
    case 'BAD':
      // 服务器应答细节（不含凭据）便于诊断；登录被拒已在 login() 归为 AUTH
      return errorReply(502, `IMAP 服务应答异常${err.detail ? `：${err.detail}` : ''}`, env);
    default:
      return errorReply(502, 'IMAP 服务暂时不可用', env);
  }
}

/** 可选 API_TOKEN 门禁：设置后要求 Authorization: Bearer <token>。 */
function checkToken(request, env) {
  if (!env.API_TOKEN) return true;
  return request.headers.get('Authorization') === `Bearer ${env.API_TOKEN}`;
}

/** 设置 ALLOW_ORIGIN 后为跨域部署放行（前后端分域场景）。 */
function corsHeaders(env) {
  if (!env.ALLOW_ORIGIN) return {};
  return { 'access-control-allow-origin': env.ALLOW_ORIGIN };
}

function preflightReply(env) {
  if (!env.ALLOW_ORIGIN) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': env.ALLOW_ORIGIN,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400'
    }
  });
}

function jsonReply(status, obj, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(env) }
  });
}

function errorReply(status, message, env) {
  return jsonReply(status, { error: message }, env);
}
