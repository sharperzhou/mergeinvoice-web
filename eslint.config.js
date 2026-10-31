import js from '@eslint/js';
import globals from 'globals';

// 禁止业务代码使用 ES2021+ 的内置方法调用（语法级限制由 languageOptions.ecmaVersion 承担）
const restrictedMethod = (name, esNote) => ({
  selector: `CallExpression > MemberExpression[property.name='${name}']`,
  message: `「.${name}」属 ${esNote}，超出本项目 ES2020 语法/API 基线，业务代码请改用兼容写法。`
});

// app/src/**（前端）与 worker/**（后端）共用的 ES2020 API 限制规则（单一定义，避免两处漂移）
const es2020Rules = {
  // ES2021+ 对象静态方法
  'no-restricted-properties': [
    'error',
    { object: 'Object', property: 'hasOwn', message: '「Object.hasOwn」属 ES2022，请用 Object.prototype.hasOwnProperty.call。' },
    { object: 'Promise', property: 'withResolvers', message: '「Promise.withResolvers」属 ES2024，超出 ES2020 基线。' },
    { object: 'Promise', property: 'try', message: '「Promise.try」属 ES2025，超出 ES2020 基线。' },
    { object: 'URL', property: 'parse', message: '「URL.parse」属 ES2025，请用 new URL() + try/catch。' },
    { object: 'Math', property: 'sumPrecise', message: '「Math.sumPrecise」属 ES2025，超出 ES2020 基线。' },
    { object: 'Uint8Array', property: 'fromHex', message: '「Uint8Array.fromHex」属 ES2025，超出 ES2020 基线。' },
    { object: 'Uint8Array', property: 'fromBase64', message: '「Uint8Array.fromBase64」属 ES2025，超出 ES2020 基线。' },
    { object: 'ArrayBuffer.prototype', property: 'transfer', message: '「ArrayBuffer.prototype.transfer」属 ES2024，超出 ES2020 基线。' },
    { object: 'ArrayBuffer.prototype', property: 'transferToFixedLength', message: '「ArrayBuffer.prototype.transferToFixedLength」属 ES2024，超出 ES2020 基线。' }
  ],
  // ES2021+ 全局
  'no-restricted-globals': [
    'error',
    { name: 'structuredClone', message: '「structuredClone」属 ES2021，请用 JSON 或手工深拷贝。' }
  ],
  // ES2021+ 实例方法（无法用 no-restricted-properties 覆盖字面量/匿名对象调用）
  'no-restricted-syntax': [
    'error',
    restrictedMethod('at', 'ES2022 Array/String.at'),
    restrictedMethod('findLast', 'ES2023 Array.findLast'),
    restrictedMethod('findLastIndex', 'ES2023 Array.findLastIndex'),
    restrictedMethod('replaceAll', 'ES2021 String.replaceAll'),
    restrictedMethod('toSorted', 'ES2023 Array.toSorted'),
    restrictedMethod('toReversed', 'ES2023 Array.toReversed'),
    restrictedMethod('toSpliced', 'ES2023 Array.toSpliced'),
    restrictedMethod('toHex', 'ES2025 Uint8Array.toHex'),
    restrictedMethod('toBase64', 'ES2025 Uint8Array.toBase64'),
    restrictedMethod('intersection', 'ES2025 Set.intersection'),
    restrictedMethod('union', 'ES2025 Set.union'),
    restrictedMethod('difference', 'ES2025 Set.difference'),
    restrictedMethod('symmetricDifference', 'ES2025 Set.symmetricDifference'),
    restrictedMethod('isSubsetOf', 'ES2025 Set.isSubsetOf'),
    restrictedMethod('isSupersetOf', 'ES2025 Set.isSupersetOf'),
    restrictedMethod('isDisjointFrom', 'ES2025 Set.isDisjointFrom'),
    restrictedMethod('groupBy', 'ES2024 Object/Map.groupBy'),
    restrictedMethod('fromAsync', 'ES2024 Array.fromAsync')
  ]
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'worker/.wrangler/**']
  },
  js.configs.recommended,
  // 业务源码：ES2020 基线，禁用 ES2021+ API
  {
    files: ['app/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser
      }
    },
    rules: es2020Rules
  },
  // Cloudflare Worker 后端：与业务代码同基线（ES2020 + 禁 ES2021+ API），保持全仓单一标准
  {
    files: ['worker/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.worker
      }
    },
    rules: es2020Rules
  },
  // Pages Functions（同为 Workers 运行时）：与 worker/** 同一基线
  {
    files: ['functions/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.worker
      }
    },
    rules: es2020Rules
  },
  // pdf.js 兼容层：允许使用 ES2021+ API（其职责就是补齐这些 API）
  {
    files: ['app/src/modules/pdfjs-compat.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser
      }
    },
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off'
    }
  },
  // 测试、脚本与 Node 环境（node --test / npm 脚本）：不受浏览器 ES 基线约束
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs', '*.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    }
  }
];
