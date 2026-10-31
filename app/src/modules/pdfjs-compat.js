/**
 * pdf.js 4.2 运行时 API 兼容层（仅服务 pdf.js，勿为业务代码在此追加补丁）。
 *
 * 必须在加载 pdf.js 之前执行（preview.js 首行导入本文件，pdf-worker.js 也在
 * 加载 Worker 主体前导入）。主线程与 Worker 线程共用同一份。
 *
 * 背景：pdf.js 4.2 内部仍会用到少量较新的内置 API（Promise.withResolvers、
 * structuredClone、Array/String.prototype.at），旧版安卓 WebView、iOS 浏览器
 * 缺失时会直接抛错导致预览失败。build.target 只能转译语法、无法补运行时 API，
 * 因此这些补丁不可删除。
 *
 * 项目自身代码的语法/API 基线为 ES2020（见 eslint.config.js 与 vite.config.js），
 * 业务代码不得依赖本文件补齐的 API；若确需支持的浏览器缺少某 API，应改写业务
 * 代码为 ES2020 兼容写法，而不是往这里加补丁。
 *
 * 注：pdf.js 4.2 还会用到 replaceAll / trimEnd / flat / Promise.finally，但它们
 * 在项目既有浏览器下限（Chrome 85+）内已原生支持，故无需补丁。
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
