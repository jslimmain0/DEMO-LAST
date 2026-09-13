import { defineConfig } from 'vitest/config'

// 순수 lib 단위 테스트 전용(DOM 불필요) — src/**/*.test.ts 만. 브라우저 e2e 는 Playwright(스크래치)로 별도.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
