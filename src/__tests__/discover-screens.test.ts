import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverScreens } from '../lib/test/discover-screens.ts';

const tmpBase = join(tmpdir(), 'mn-discover-screens-' + Date.now());

function file(path: string, content: string): void {
  const full = join(tmpBase, path);
  mkdirSync(join(tmpBase, path.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  try { rmSync(tmpBase, { recursive: true }); } catch {}
});

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true }); } catch {}
});

describe('discoverScreens', () => {
  it('finds PascalCase .tsx files with default exports under src/components', () => {
    file('src/components/LoanRequestForm.tsx', 'export default function LoanRequestForm() { return null; }');
    file('src/components/MyLoans.tsx', 'export const MyLoans = () => null; export { MyLoans as default };');

    const screens = discoverScreens(tmpBase);
    expect(screens.map((s) => s.name)).toEqual(['loan-request-form', 'my-loans']);
    expect(screens[0].component).toBe('LoanRequestForm');
    expect(screens[0].relativePath).toBe('src/components/LoanRequestForm.tsx');
  });

  it('also walks src/pages and src/screens', () => {
    file('src/pages/Dashboard.tsx', 'export default function Dashboard() { return null; }');
    file('src/screens/Settings.tsx', 'export default function Settings() { return null; }');

    const screens = discoverScreens(tmpBase);
    expect(screens.map((s) => s.name).sort()).toEqual(['dashboard', 'settings']);
  });

  it('returns names alphabetically sorted', () => {
    file('src/components/Zeta.tsx', 'export default function Zeta() { return null; }');
    file('src/components/Alpha.tsx', 'export default function Alpha() { return null; }');
    file('src/components/Mu.tsx', 'export default function Mu() { return null; }');

    const names = discoverScreens(tmpBase).map((s) => s.name);
    expect(names).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('filters out non-PascalCase filenames', () => {
    file('src/components/utils.tsx', 'export default function noop() {}');
    file('src/components/use-thing.tsx', 'export default function useThing() {}');
    file('src/components/Real.tsx', 'export default function Real() { return null; }');

    expect(discoverScreens(tmpBase).map((s) => s.name)).toEqual(['real']);
  });

  it('filters out test files', () => {
    file('src/components/Foo.tsx', 'export default function Foo() { return null; }');
    file('src/components/Foo.test.tsx', 'import { Foo } from "./Foo"; describe("Foo", () => {});');
    file('src/components/Foo.spec.tsx', 'import { Foo } from "./Foo"; describe("Foo", () => {});');

    const names = discoverScreens(tmpBase).map((s) => s.name);
    expect(names).toEqual(['foo']);
  });

  it('filters out files without any exported component-like identifier', () => {
    file('src/components/types.tsx', 'export type Foo = { bar: string };');           // type-only
    file('src/components/Hooks.tsx', 'export const useThing = () => null;');           // lowercase id
    file('src/components/Real.tsx', 'export const Real = () => null;');                // valid

    expect(discoverScreens(tmpBase).map((s) => s.name)).toEqual(['real']);
  });

  it('recurses into non-layout subdirectories', () => {
    file('src/components/auth/Login.tsx', 'export default function Login() { return null; }');
    file('src/components/dashboard/Overview.tsx', 'export default function Overview() { return null; }');

    expect(discoverScreens(tmpBase).map((s) => s.name)).toEqual(['login', 'overview']);
  });

  it('skips known layout/utility subdirectories', () => {
    file('src/components/layout/Header.tsx', 'export default function Header() { return null; }');
    file('src/components/Layout/Footer.tsx', 'export default function Footer() { return null; }'); // case-insensitive
    file('src/components/icons/Star.tsx', 'export default function Star() { return null; }');
    file('src/components/Page.tsx', 'export default function Page() { return null; }');

    expect(discoverScreens(tmpBase).map((s) => s.name)).toEqual(['page']);
  });

  it('returns empty when no scan dir exists', () => {
    mkdirSync(tmpBase, { recursive: true });
    expect(discoverScreens(tmpBase)).toEqual([]);
  });

  it('deduplicates by slug — first match wins', () => {
    file('src/components/Foo.tsx', 'export default function Foo() { return null; }');
    file('src/pages/Foo.tsx', 'export default function Foo() { return null; }');

    const screens = discoverScreens(tmpBase);
    expect(screens.length).toBe(1);
    // Either path is acceptable as long as we don't return both.
    expect(screens[0].name).toBe('foo');
  });

  it('handles all-caps prefixes in PascalCase (kebab conversion)', () => {
    file('src/components/ZKLoanRequest.tsx', 'export default function ZKLoanRequest() { return null; }');
    file('src/components/APIClient.tsx', 'export default function APIClient() { return null; }');

    const names = discoverScreens(tmpBase).map((s) => s.name);
    expect(names).toContain('zk-loan-request');
    expect(names).toContain('api-client');
  });
});
