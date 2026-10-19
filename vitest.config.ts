import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 上游实现包只发布在 DSH 自己的解析链上；单测用同形替身覆盖装配路径。
      // 子路径别名必须排在包名之前：别名按前缀匹配，先命中的那条会拼出
      // `<替身文件>.ts/list-agents` 这种解析不了的路径，让 `agents_list` 条目静默降级。
      '@deepseek-ai/dsh-tool-subagent-control/list-agents': fileURLToPath(
        new URL('./tests/stubs/list-agents.ts', import.meta.url),
      ),
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
