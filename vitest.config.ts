import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests must never spawn the native dust-sync sidecar (it would make real
    // network calls / behave differently by machine). Force the WASM path; the
    // native bridge is covered directly by dust-sync-native.test.ts.
    // Likewise, local stack detection must not depend on what docker runs on
    // the machine; it's covered with captured docker output in local-stacks.test.ts.
    env: { MN_DISABLE_NATIVE_DUST: '1', MN_NO_LOCAL_DETECT: '1' },
    // Nested checkouts under .claude/ run their own tests; count only this
    // checkout's.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
