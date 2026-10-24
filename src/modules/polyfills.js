/**
 * 运行时 API 兼容补丁：必须在加载 pdf.js 之前执行（preview.js 首行导入本文件）。
 *
 * pdf.js v5 内部使用 Promise.withResolvers（Chrome 119+ / Safari 17.4+ 起支持），
 * 旧版安卓 WebView、iOS 浏览器缺少该方法会直接抛出
 * "Promise.withResolvers is not a function"，导致预览失败。
 * 另外补齐少量旧版 WebView 缺失的 ES2022/ES2023 常用方法，避免预览阶段再次中断。
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
