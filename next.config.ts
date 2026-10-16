import type { NextConfig } from "next";

/**
 * StellarLit —— Next.js 配置
 *
 * 架构约束(详见 docs/架构设计.md):
 * 后端只作为「AI 能力接入层」,不承载业务逻辑;
 * 所有出网的密钥只在 API Routes / 服务端模块里出现,绝不进入浏览器包。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["zustand"],
  },
};

export default nextConfig;
