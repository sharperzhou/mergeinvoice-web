/**
 * 运行时 API 兼容补丁：必须在加载 pdf.js 之前执行（preview.js 首行导入本文件，
 * pdf-worker.js 也在加载 Worker 主体前导入）。
 *
 * pdf.js v5 依赖若干较新的语言内置 API，旧版安卓 WebView、iOS 浏览器缺失时会直接抛错
 * （如 "Promise.withResolvers is not a function"、"URL.parse is not a function"），
 * 导致预览失败。这里按报错逐一补齐，主线程与 Worker 线程共用同一份补丁。
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
