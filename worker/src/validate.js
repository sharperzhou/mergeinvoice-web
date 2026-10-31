// API 入参校验与 IMAP 服务商白名单：index.js 的薄层前置校验。
// 独立成模块是为了让纯校验逻辑可被 node --test 直接覆盖（index.js 依赖 cloudflare:sockets 无法在 Node 加载）。
// 所有日期按 UTC 零点解析；时间跨度与 limit 上限在此统一执行，前端约束只是体验层。

/** 服务商 → IMAP 主机白名单（硬编码，禁止任意主机，防 SSRF/跳板滥用）。 */
export const PROVIDERS = Object.freeze({
  '163': 'imap.163.com',
  '126': 'imap.126.com',
  yeah: 'imap.yeah.net',
  qq: 'imap.qq.com'
});

/** 查询时间跨度上限（天）；SEARCH 用 SINCE…BEFORE，BEFORE 为开区间。 */
export const MAX_RANGE_DAYS = 90;
/** 搜索返回条数默认值与上限（取 UID 最大的最近 N 封）。 */
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;

/** 入参校验失败：index.js 捕获后映射为 400 与中文提示。 */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 校验服务商并返回 IMAP 主机名。 */
export function resolveProvider(provider) {
  if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    throw new ValidationError('不支持的服务商（仅支持 163/126/yeah/QQ）');
  }
  return PROVIDERS[provider];
}

/** 非空字符串字段（邮箱账号、授权码），去除首尾空白后返回。 */
export function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field}不能为空`);
  }
  return value.trim();
}

/** 解析 YYYY-MM-DD 为 UTC Date（严格校验真实存在该日期）。 */
export function parseDate(text, field) {
  const m = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : null;
  if (!m) throw new ValidationError(`${field}须为 YYYY-MM-DD 格式`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ValidationError(`${field}不是有效日期`);
  }
  return date;
}

/**
 * 校验起止日期并换算为 IMAP 检索区间：
 * since = 起始日（含当日），before = 结束日 + 1 天（BEFORE 为开区间，实现「结束日含当日」）。
 */
export function resolveDateRange(startDate, endDate) {
  const since = parseDate(startDate, '开始日期');
  const end = parseDate(endDate, '结束日期');
  if (end.getTime() < since.getTime()) throw new ValidationError('结束日期不能早于开始日期');
  const days = (end.getTime() - since.getTime()) / 86400000;
  if (days > MAX_RANGE_DAYS) throw new ValidationError(`查询时间范围不能超过 ${MAX_RANGE_DAYS} 天`);
  return { since, before: new Date(end.getTime() + 86400000) };
}

/** 解析邮件 UID：正整数。 */
export function parseUid(uid) {
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < 1) {
    throw new ValidationError('uid 须为正整数');
  }
  return uid;
}

/** 解析 limit：缺省取默认值，提供时须为 1..MAX_LIMIT 的整数。 */
export function parseLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit 须为 1..${MAX_LIMIT} 的整数`);
  }
  return limit;
}
