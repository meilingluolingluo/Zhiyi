import { defineConfig } from 'vitest/config';

/** 测试配置：串行执行、放宽超时，保证流式与超时用例稳定。 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
