import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests must never spawn the native dust-sync sidecar (it would make real
    // network calls / behave differently by machine). Force the WASM path; the
    // native bridge is covered directly by dust-sync-native.test.ts.
    env: { MN_DISABLE_NATIVE_DUST: '1' },
  },
});
