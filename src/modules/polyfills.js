/**
 * 运行时 API 兼容补丁：必须在加载 pdf.js 之前执行（preview.js 首行导入本文件，
 * pdf-worker.js 也在加载 Worker 主体前导入）。
 *
 * pdf.js v5 依赖若干较新的语言内置 API，旧版安卓 WebView、iOS 浏览器缺失时会直接抛错
 * （如 "Promise.withResolvers is not a function"、"URL.parse is not a function"、
 * "r.toHex is not a function"），导致预览失败。这里按报错逐一补齐，
 * 主线程与 Worker 线程共用同一份补丁。
 */

// Promise.withResolvers：返回 { promise, resolve, reject }
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// 在原型上定义不可枚举方法（与原生实现的可枚举性一致）
function defineMethod(target, name, value) {
  Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

// Object.hasOwn（Chrome 93+）
if (typeof Object.hasOwn !== 'function') {
  Object.hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
}

// Array.prototype.at / String.prototype.at（Chrome 92+）
if (typeof Array.prototype.at !== 'function') {
  defineMethod(Array.prototype, 'at', function at(index) {
    const i = Math.trunc(index) || 0;
    return this[i < 0 ? this.length + i : i];
  });
}
if (typeof String.prototype.at !== 'function') {
  defineMethod(String.prototype, 'at', function at(index) {
    const i = Math.trunc(index) || 0;
    return this[i < 0 ? this.length + i : i];
  });
}

// Array.prototype.findLast / findLastIndex（Chrome 97+）
if (typeof Array.prototype.findLast !== 'function') {
  defineMethod(Array.prototype, 'findLast', function findLast(predicate, thisArg) {
    for (let i = this.length - 1; i >= 0; i--) {
      if (predicate.call(thisArg, this[i], i, this)) return this[i];
    }
    return undefined;
  });
}
if (typeof Array.prototype.findLastIndex !== 'function') {
  defineMethod(Array.prototype, 'findLastIndex', function findLastIndex(predicate, thisArg) {
    for (let i = this.length - 1; i >= 0; i--) {
      if (predicate.call(thisArg, this[i], i, this)) return i;
    }
    return -1;
  });
}

// URL.parse（Chrome 126+ / Safari 18+）：解析失败返回 null 而不是抛错
if (typeof URL.parse !== 'function') {
  URL.parse = function parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}

// Promise.try（Chrome 128+ / Safari 18.4+）：同步异常自动转为 rejected promise
if (typeof Promise.try !== 'function') {
  Promise.try = function promiseTry(fn, ...args) {
    return new Promise((resolve) => resolve(fn(...args)));
  };
}

// Set.prototype 集合运算（Chrome 122+ / Safari 17+），参数允许为任意 set-like
// （只需提供 size / has / keys）
if (typeof Set.prototype.intersection !== 'function') {
  const keysOf = (other) => (typeof other.keys === 'function' ? other.keys() : other);

  defineMethod(Set.prototype, 'intersection', function intersection(other) {
    const result = new Set();
    for (const value of this) if (other.has(value)) result.add(value);
    return result;
  });
  defineMethod(Set.prototype, 'union', function union(other) {
    const result = new Set(this);
    for (const value of keysOf(other)) result.add(value);
    return result;
  });
  defineMethod(Set.prototype, 'difference', function difference(other) {
    const result = new Set();
    for (const value of this) if (!other.has(value)) result.add(value);
    return result;
  });
  defineMethod(Set.prototype, 'symmetricDifference', function symmetricDifference(other) {
    const result = new Set();
    for (const value of this) if (!other.has(value)) result.add(value);
    for (const value of keysOf(other)) if (!this.has(value)) result.add(value);
    return result;
  });
  defineMethod(Set.prototype, 'isSubsetOf', function isSubsetOf(other) {
    if (this.size > other.size) return false;
    for (const value of this) if (!other.has(value)) return false;
    return true;
  });
  defineMethod(Set.prototype, 'isSupersetOf', function isSupersetOf(other) {
    for (const value of keysOf(other)) if (!this.has(value)) return false;
    return true;
  });
  defineMethod(Set.prototype, 'isDisjointFrom', function isDisjointFrom(other) {
    for (const value of this) if (other.has(value)) return false;
    return true;
  });
}

// Math.sumPrecise（Chrome 137+ / Safari 18.4+）：补偿求和，避免大数相消丢精度
if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = function sumPrecise(values) {
    let sum = 0;
    let compensation = 0;
    for (const value of values) {
      const next = sum + value;
      // Neumaier 补偿：把舍入误差累计到 compensation
      compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
      sum = next;
    }
    return sum + compensation;
  };
}

// Uint8Array.prototype.toHex / Uint8Array.fromHex（Chrome 133+ / Safari 18.4+）
if (typeof Uint8Array.prototype.toHex !== 'function') {
  defineMethod(Uint8Array.prototype, 'toHex', function toHex() {
    let hex = '';
    for (let i = 0; i < this.length; i++) hex += this[i].toString(16).padStart(2, '0');
    return hex;
  });
}
if (typeof Uint8Array.fromHex !== 'function') {
  Uint8Array.fromHex = function fromHex(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
      throw new SyntaxError('Invalid hex string');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  };
}

// Uint8Array.prototype.toBase64 / Uint8Array.fromBase64（Chrome 133+ / Safari 18.4+）
// options: { alphabet: 'base64' | 'base64url', omitPadding: boolean }
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  defineMethod(Uint8Array.prototype, 'toBase64', function toBase64(options) {
    const alphabet = (options && options.alphabet) || 'base64';
    const omitPadding = Boolean(options && options.omitPadding);
    const chars = alphabet === 'base64url' ? BASE64URL : BASE64;
    let result = '';
    for (let i = 0; i < this.length; i += 3) {
      const b0 = this[i];
      const b1 = i + 1 < this.length ? this[i + 1] : undefined;
      const b2 = i + 2 < this.length ? this[i + 2] : undefined;
      result += chars[b0 >> 2];
      result += chars[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
      result += b1 === undefined ? (omitPadding ? '' : '=') : chars[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
      result += b2 === undefined ? (omitPadding ? '' : '=') : chars[b2 & 63];
    }
    return result;
  });

  Uint8Array.fromBase64 = function fromBase64(text, options) {
    const alphabet = (options && options.alphabet) || 'base64';
    const normalized =
      alphabet === 'base64url' ? String(text).replace(/-/g, '+').replace(/_/g, '/') : String(text);
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
}

// ArrayBuffer.prototype.transferToFixedLength / transfer（Chrome 114+）
// 旧浏览器无法真正分离（detach）原缓冲区：返回一份指定长度的副本，并清零原数据，
// 语义上原缓冲区随后不应再被使用（与 transfer 一致）。
if (typeof ArrayBuffer.prototype.transferToFixedLength !== 'function') {
  const transferCopy = function transferToFixedLength(newLength) {
    const length = newLength === undefined ? this.byteLength : newLength;
    const target = new ArrayBuffer(length);
    new Uint8Array(target).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
    try {
      new Uint8Array(this).fill(0);
    } catch {
      /* 原缓冲区不可写时忽略 */
    }
    return target;
  };
  defineMethod(ArrayBuffer.prototype, 'transferToFixedLength', transferCopy);
  if (typeof ArrayBuffer.prototype.transfer !== 'function') {
    defineMethod(ArrayBuffer.prototype, 'transfer', transferCopy);
  }
}

// structuredClone 兜底（Chrome 98+）：递归复制常见可结构化数据；
// Blob / ImageBitmap 等宿主对象无法手工复制，按引用返回（仅作降级，避免直接崩溃）
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = function structuredCloneFallback(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return new RegExp(value.source, value.flags);
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) return typeof value.slice === 'function' ? value.slice() : value;
    if (value instanceof Map) {
      const map = new Map();
      seen.set(value, map);
      for (const [key, item] of value) map.set(structuredCloneFallback(key, seen), structuredCloneFallback(item, seen));
      return map;
    }
    if (value instanceof Set) {
      const set = new Set();
      seen.set(value, set);
      for (const item of value) set.add(structuredCloneFallback(item, seen));
      return set;
    }
    if (Array.isArray(value)) {
      const array = [];
      seen.set(value, array);
      for (const item of value) array.push(structuredCloneFallback(item, seen));
      return array;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const object = {};
      seen.set(value, object);
      for (const key of Object.keys(value)) object[key] = structuredCloneFallback(value[key], seen);
      return object;
    }
    return value;
  };
}
