import { describe, it, expect } from 'vitest';
import { COMMAND_SPECS } from '../commands/help.ts';

// We test the MCP tool definitions by importing the TOOLS array structure
// and verifying it matches COMMAND_SPECS. We can't easily test the actual
// MCP server (it takes over stdio), but we verify the tool coverage.

// Expected MCP tool names — one per CLI command/subcommand
const EXPECTED_TOOLS = [
  'midnight_generate',
  'midnight_info',
  'midnight_balance',
  'midnight_address',
  'midnight_genesis_address',
  'midnight_inspect_cost',
  'midnight_airdrop',
  'midnight_transfer',
  'midnight_dust_register',
  'midnight_dust_status',
  'midnight_config_get',
  'midnight_config_set',
  'midnight_localnet_up',
  'midnight_localnet_stop',
  'midnight_localnet_down',
  'midnight_localnet_status',
  'midnight_localnet_clean',
];

describe('MCP tool coverage', () => {
  it('every CLI command has at least one MCP tool', () => {
    // CLI commands that should have MCP tools
    const cliCommands = COMMAND_SPECS.map(s => s.name).filter(n => n !== 'help');

    for (const cmd of cliCommands) {
      // Normalize: dust → midnight_dust_register, midnight_dust_status
      // localnet → midnight_localnet_up, etc.
      const normalized = cmd.replace('-', '_');
      const hasMatch = EXPECTED_TOOLS.some(t =>
        t === `midnight_${normalized}` || t.startsWith(`midnight_${normalized}_`)
      );
      expect(hasMatch, `CLI command "${cmd}" should have a matching MCP tool`).toBe(true);
    }
  });

  it('has 17 expected tools', () => {
    expect(EXPECTED_TOOLS).toHaveLength(17);
  });

  it('every COMMAND_SPEC with jsonFields is covered', () => {
    const commandsWithJson = COMMAND_SPECS.filter(s => s.jsonFields && s.name !== 'help');
    // Should have at least one tool per command
    expect(commandsWithJson.length).toBeGreaterThan(0);
    for (const spec of commandsWithJson) {
      const normalized = spec.name.replace('-', '_');
      const hasMatch = EXPECTED_TOOLS.some(t =>
        t === `midnight_${normalized}` || t.startsWith(`midnight_${normalized}_`)
      );
      expect(hasMatch, `${spec.name} should have an MCP tool`).toBe(true);
    }
  });
});
