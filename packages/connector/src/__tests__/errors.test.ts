import { describe, it, expect } from 'vitest';
import { reconstructError, RPC_CODE_TO_ERROR } from '../errors.ts';

describe('reconstructError', () => {
  // ── Path 1: Embedded DAppConnectorAPIError data (most precise) ──

  it('uses embedded error code when data.type is DAppConnectorAPIError', () => {
    const err = reconstructError({
      code: -32000,
      message: 'User rejected',
      data: { type: 'DAppConnectorAPIError', code: 'Rejected' },
    });
    expect(err.type).toBe('DAppConnectorAPIError');
    expect(err.code).toBe('Rejected');
    expect(err.reason).toBe('User rejected');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('User rejected');
  });

  it('prefers embedded code over RPC code mapping', () => {
    // Server sends Disconnected in data but uses -32603 (InternalError) as RPC code
    const err = reconstructError({
      code: -32603,
      message: 'Wallet not synced',
      data: { type: 'DAppConnectorAPIError', code: 'Disconnected' },
    });
    expect(err.code).toBe('Disconnected');
  });

  // ── Path 2: Fallback to RPC code mapping (no data or wrong data.type) ──

  it('maps -32000 to Rejected without data', () => {
    const err = reconstructError({ code: -32000, message: 'rejected' });
    expect(err.code).toBe('Rejected');
    expect(err.type).toBe('DAppConnectorAPIError');
  });

  it('maps -32001 to PermissionRejected without data', () => {
    const err = reconstructError({ code: -32001, message: 'permission denied' });
    expect(err.code).toBe('PermissionRejected');
  });

  it('maps -32002 to Disconnected without data', () => {
    const err = reconstructError({ code: -32002, message: 'disconnected' });
    expect(err.code).toBe('Disconnected');
  });

  it('maps -32602 to InvalidRequest without data', () => {
    const err = reconstructError({ code: -32602, message: 'invalid params' });
    expect(err.code).toBe('InvalidRequest');
  });

  it('maps -32603 to InternalError without data', () => {
    const err = reconstructError({ code: -32603, message: 'internal error' });
    expect(err.code).toBe('InternalError');
  });

  // ── Path 3: Unknown RPC code fallback ──

  it('falls back to InternalError for unknown RPC codes', () => {
    const err = reconstructError({ code: -32700, message: 'Parse error' });
    expect(err.code).toBe('InternalError');
    expect(err.message).toBe('Parse error');
  });

  it('falls back to InternalError for non-standard codes', () => {
    const err = reconstructError({ code: -1, message: 'unknown' });
    expect(err.code).toBe('InternalError');
  });

  // ── Verify all 5 RPC codes are mapped ──

  it('RPC_CODE_TO_ERROR covers all 5 error codes', () => {
    expect(Object.keys(RPC_CODE_TO_ERROR)).toHaveLength(5);
    expect(RPC_CODE_TO_ERROR[-32000]).toBe('Rejected');
    expect(RPC_CODE_TO_ERROR[-32001]).toBe('PermissionRejected');
    expect(RPC_CODE_TO_ERROR[-32002]).toBe('Disconnected');
    expect(RPC_CODE_TO_ERROR[-32602]).toBe('InvalidRequest');
    expect(RPC_CODE_TO_ERROR[-32603]).toBe('InternalError');
  });
});
