import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

/** 需要在浏览器里跑的代码 */
const CLIENT_FILES = [
  "src/app/**/*.{ts,tsx}",
  "src/components/**/*.{ts,tsx}",
  "src/hooks/**/*.{ts,tsx}",
  "src/stores/**/*.{ts,tsx}",
];

/** 服务端模块名:只允许 API Routes 与其内部互相引用 */
const SERVER_MODULES = ["@/server/*"];

/**
 * 分层规则(见 docs/前端工程规范.md):
 * 依赖方向必须单向 —— types → lib → features → components → app
 * 反向依赖一律报错,而不是靠自觉。
 *
 * @type {import("eslint").Linter.Config[]}
 */
const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "data/**", "scripts/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),

  // 1. 浏览器代码不得引入服务端模块(密钥/文件系统/上游数据源)
  {
    files: CLIENT_FILES,
    // api/ 是服务端;login/page 是 Server Component(要在渲染前读会话并跳转)
    ignores: ["src/app/api/**", "src/app/login/page.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: SERVER_MODULES, message: "服务端模块不得进入客户端包。" }] },
      ],
    },
  },

  // 2. ui/ 是纯展示组件:不认识业务、状态与数据源
  {
    files: ["src/components/ui/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/stores/*"], message: "ui/ 不得依赖状态层。" },
            { group: ["@/features/*"], message: "ui/ 不得依赖业务域。" },
            { group: ["@/hooks/*"], message: "ui/ 不得依赖应用级 hook。" },
            { group: SERVER_MODULES, message: "ui/ 不得依赖服务端模块。" },
          ],
        },
      ],
    },
  },

  // 3. 领域逻辑不得依赖视图层与状态层
  {
    files: ["src/lib/**/*.ts", "src/features/**/*.ts", "src/types/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/components/*"], message: "逻辑层不得依赖视图层。" },
            { group: ["@/stores/*"], message: "逻辑层不得依赖状态层。" },
          ],
        },
      ],
    },
  },
];

export default config;
