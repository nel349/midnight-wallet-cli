// Witness-dependency analysis for Compact contracts.
//
// Why: circuits that call a witness function need that witness's return
// value at runtime. Witnesses normally read from PRIVATE STATE that the
// dApp UI's wallet flow populates. In a CLI-only test the private state
// is empty, so any witness-dependent circuit fails with a type error
// like:
//   "type error: <witness> return value... but received [ undefined, ... ]"
//
// We surface this at scaffold time so the AI / deterministic generators
// skip those circuits up front (or at least flag them) instead of
// shipping a suite that crashes 30s into the run.
//
// Approach: regex-based static analysis on the Compact source. Not a
// real parser — we scan for circuit / function definitions, extract
// their bodies, and propagate a "calls a witness directly OR
// transitively" flag through the call graph. Works for the patterns
// the create-mn-app templates and ecosystem dApps actually use; will
// miss exotic indirection but won't false-positive on normal code.

export interface WitnessDependencyAnalysis {
  /** Circuit name → list of witness names it depends on (direct + transitive). */
  byCircuit: Map<string, string[]>;
}

/**
 * Build the witness-dependency map for every circuit in `source`. Returns
 * an empty map when no witnesses are declared (nothing to analyze).
 *
 * The function is parser-free — it strips comments, finds named function
 * bodies via brace matching, then propagates "uses a witness" through the
 * helper call graph until fixpoint.
 */
export function analyzeWitnessDependencies(source: string, witnessNames: readonly string[]): WitnessDependencyAnalysis {
  if (witnessNames.length === 0) {
    return { byCircuit: new Map() };
  }

  const stripped = stripComments(source);
  const blocks = extractNamedBlocks(stripped);
  if (blocks.size === 0) {
    return { byCircuit: new Map() };
  }

  const witnessSet = new Set(witnessNames);
  const directDeps = new Map<string, Set<string>>(); // helper → witnesses it calls directly
  const helperCalls = new Map<string, Set<string>>(); // helper → other helpers it calls

  for (const [name, info] of blocks) {
    directDeps.set(name, new Set());
    helperCalls.set(name, new Set());

    for (const calledName of findCallSites(info.body, info.argNames)) {
      if (witnessSet.has(calledName)) {
        directDeps.get(name)!.add(calledName);
      } else if (blocks.has(calledName)) {
        helperCalls.get(name)!.add(calledName);
      }
    }
  }

  // Propagate transitively: a helper that calls a helper that uses a
  // witness inherits the dependency. Iterate to fixpoint — at most N
  // iterations for N functions.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, callees] of helperCalls) {
      const here = directDeps.get(name)!;
      for (const callee of callees) {
        for (const w of directDeps.get(callee) ?? []) {
          if (!here.has(w)) {
            here.add(w);
            changed = true;
          }
        }
      }
    }
  }

  const byCircuit = new Map<string, string[]>();
  for (const [name, info] of blocks) {
    if (!info.isCircuit) continue;
    const deps = directDeps.get(name);
    if (deps && deps.size > 0) {
      byCircuit.set(name, [...deps].sort());
    }
  }

  return { byCircuit };
}

// ── Internals ──────────────────────────────────────────────────────

interface BlockInfo {
  /** Body content between matching braces, comments stripped. */
  body: string;
  /** Names declared in the parameter list — excluded from helper-call detection. */
  argNames: Set<string>;
  /** True if declared as `circuit`, false for `function`/helpers. */
  isCircuit: boolean;
}

const STRIP_LINE_COMMENTS = /\/\/[^\n]*/g;
const STRIP_BLOCK_COMMENTS = /\/\*[\s\S]*?\*\//g;

function stripComments(source: string): string {
  return source.replace(STRIP_BLOCK_COMMENTS, '').replace(STRIP_LINE_COMMENTS, '');
}

/**
 * Find every named function-like block in the source: `circuit X(...)`
 * and `function X(...)` (Compact's two definition forms). Returns the
 * body slice + arg names + a flag for circuits-vs-helpers.
 *
 * Brace matching is depth-counted so nested blocks (if/for inside a
 * circuit) don't fool us into closing early.
 */
function extractNamedBlocks(source: string): Map<string, BlockInfo> {
  const out = new Map<string, BlockInfo>();
  // Match either `(export )?circuit name(...)...` or `(export )?function name(...)...`
  // Tolerates multi-line signatures (s flag) and arbitrary whitespace.
  const headerRe = /\b(circuit|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gms;

  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(source)) !== null) {
    const kind = match[1];
    const name = match[2];
    const argList = match[3];

    // Find the opening brace after the signature.
    const headerEnd = match.index + match[0].length;
    const braceStart = source.indexOf('{', headerEnd);
    if (braceStart < 0) continue;

    // Walk forward counting brace depth until we find the matching '}'.
    let depth = 1;
    let i = braceStart + 1;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth !== 0) continue; // unbalanced — skip rather than misread

    const body = source.slice(braceStart + 1, i - 1);
    const argNames = parseArgNames(argList);
    out.set(name, { body, argNames, isCircuit: kind === 'circuit' });
  }

  return out;
}

/** Extract identifier names from `name1: Type1, name2: Type2` style arg lists. */
function parseArgNames(argList: string): Set<string> {
  const names = new Set<string>();
  for (const piece of argList.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    const namePart = colonIdx > -1 ? trimmed.slice(0, colonIdx).trim() : trimmed;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(namePart)) names.add(namePart);
  }
  return names;
}

/**
 * Find all `name(` call sites in the body, filtered to candidate
 * identifiers. We use this set as "things this block calls"; the caller
 * decides whether a hit is a witness or a helper.
 *
 * Skips: control-flow keywords (if, for, etc.), parameter names (a
 * caller-controlled value, not a global function), and keywords that
 * look like calls (assert, disclose) but aren't user-defined.
 */
function findCallSites(body: string, argNames: Set<string>): Set<string> {
  const out = new Set<string>();
  const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(body)) !== null) {
    const name = m[1];
    if (RESERVED.has(name) || argNames.has(name)) continue;
    out.add(name);
  }
  return out;
}

/**
 * Identifiers that look like calls but aren't user-defined functions.
 * Conservative list — false negatives (missing a real helper) are worse
 * than false positives, so anything ambiguous stays out.
 */
const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'return', 'new',
  'assert', 'disclose', 'transientHash', 'persistentHash',
  'ownPublicKey', 'publicKey',
  // Compact builtins / stdlib that can't be user-defined helpers
  'Map', 'Set', 'Vector', 'Tuple', 'Option', 'Bytes', 'Field', 'Uint', 'Boolean',
]);
