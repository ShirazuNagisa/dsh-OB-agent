import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 上游实现包只发布在 DSH 自己的解析链上；单测用同形替身覆盖装配路径。
      '@deepseek-ai/dsh-tool-subagent-control': fileURLToPath(
        new URL('./tests/stubs/tool-subagent-control.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
  },
})
