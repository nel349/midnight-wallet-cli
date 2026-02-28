import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import localnetCommand from '../commands/localnet.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import {
  COMPOSE_YAML,
  COMPOSE_VERSION,
} from '../lib/localnet.ts';
import helpCommand, { COMMAND_SPECS } from '../commands/help.ts';
import { COMMAND_BRIEFS } from '../ui/art.ts';

let io: CapturedOutput;

beforeEach(() => {
  process.env.NO_COLOR = '';
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  io.restore();
});

describe('localnet command — argument validation', () => {
  it('throws when no subcommand provided', async () => {
    const args = parseArgs(['localnet']);
    await expect(localnetCommand(args)).rejects.toThrow('Usage:');
    await expect(localnetCommand(args)).rejects.toThrow('up|stop|down|status|logs|clean');
  });

  it('throws for invalid subcommand', async () => {
    const args = parseArgs(['localnet', 'restart']);
    await expect(localnetCommand(args)).rejects.toThrow('Usage:');
  });

  it('throws for another invalid subcommand', async () => {
    const args = parseArgs(['localnet', 'start']);
    await expect(localnetCommand(args)).rejects.toThrow('Usage:');
  });

  it('error message includes all valid subcommands', async () => {
    const args = parseArgs(['localnet', 'invalid']);
    try {
      await localnetCommand(args);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('up');
      expect(msg).toContain('stop');
      expect(msg).toContain('down');
      expect(msg).toContain('status');
      expect(msg).toContain('logs');
      expect(msg).toContain('clean');
    }
  });
});

describe('COMPOSE_YAML content', () => {
  it('contains the node service with correct image', () => {
    expect(COMPOSE_YAML).toContain('midnightntwrk/midnight-node:0.20.1');
  });

  it('contains the indexer service with correct image', () => {
    expect(COMPOSE_YAML).toContain('midnightntwrk/indexer-standalone:3.0.0');
  });

  it('contains the proof-server service with correct image', () => {
    expect(COMPOSE_YAML).toContain('nel349/proof-server:7.0.0');
  });

  it('exposes node port 9944', () => {
    expect(COMPOSE_YAML).toContain('"9944:9944"');
  });

  it('exposes indexer port 8088', () => {
    expect(COMPOSE_YAML).toContain("'8088:8088'");
  });

  it('exposes proof-server port 6300', () => {
    expect(COMPOSE_YAML).toContain('"6300:6300"');
  });

  it('includes healthcheck for node', () => {
    expect(COMPOSE_YAML).toContain('http://localhost:9944/health');
  });

  it('includes healthcheck for indexer', () => {
    expect(COMPOSE_YAML).toContain('cat /var/run/indexer-standalone/running');
  });

  it('has indexer depending on node', () => {
    expect(COMPOSE_YAML).toContain('depends_on');
    expect(COMPOSE_YAML).toContain('condition: service_started');
  });

  it('sets CFG_PRESET=dev for the node', () => {
    expect(COMPOSE_YAML).toContain('CFG_PRESET: "dev"');
  });

  it('starts with services: key (valid compose format)', () => {
    expect(COMPOSE_YAML.trimStart()).toMatch(/^services:/);
  });
});

describe('COMPOSE_VERSION', () => {
  it('is a semver-like string', () => {
    expect(COMPOSE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('ensureComposeFile', () => {
  // Use a temp directory to test file writing logic without touching real ~/.midnight
  const TEST_DIR = join(tmpdir(), `midnight-localnet-test-${process.pid}`);
  const TEST_COMPOSE_PATH = join(TEST_DIR, 'compose.yml');
  const TEST_VERSION_PATH = join(TEST_DIR, '.version');

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('compose YAML can be written and read back', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_COMPOSE_PATH, COMPOSE_YAML, 'utf-8');
    writeFileSync(TEST_VERSION_PATH, COMPOSE_VERSION, 'utf-8');

    const content = readFileSync(TEST_COMPOSE_PATH, 'utf-8');
    expect(content).toBe(COMPOSE_YAML);

    const version = readFileSync(TEST_VERSION_PATH, 'utf-8');
    expect(version).toBe(COMPOSE_VERSION);
  });

  it('version file can detect stale compose file', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_COMPOSE_PATH, COMPOSE_YAML, 'utf-8');
    writeFileSync(TEST_VERSION_PATH, '0.0.1', 'utf-8');

    const version = readFileSync(TEST_VERSION_PATH, 'utf-8').trim();
    expect(version).not.toBe(COMPOSE_VERSION);
  });
});

describe('help integration', () => {
  it('COMMAND_SPECS includes localnet', () => {
    const localnetSpec = COMMAND_SPECS.find(s => s.name === 'localnet');
    expect(localnetSpec).toBeDefined();
    expect(localnetSpec!.description).toContain('local');
    expect(localnetSpec!.usage).toContain('up|stop|down|status|logs|clean');
    expect(localnetSpec!.examples!.length).toBeGreaterThan(0);
  });

  it('shows usage for localnet via help command', async () => {
    const args = parseArgs(['help', 'localnet']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('localnet');
    expect(out).toContain('Usage:');
    expect(out).toContain('up');
    expect(out).toContain('stop');
    expect(out).toContain('down');
    expect(out).toContain('status');
    expect(out).toContain('logs');
    expect(out).toContain('clean');
    expect(out).toContain('Examples:');
  });

  it('COMMAND_BRIEFS includes localnet', () => {
    const localnetBrief = COMMAND_BRIEFS.find(([name]) => name === 'localnet');
    expect(localnetBrief).toBeDefined();
    expect(localnetBrief![1]).toContain('local network');
  });
});
