// APIError reconstruction from JSON-RPC error responses
// Reverses the server's API_ERROR_TO_RPC_CODE mapping

import type { APIError, ErrorCode } from './types.ts';

// ── RPC code → DApp Connector error code ──

const RPC_CODE_TO_ERROR: Record<number, ErrorCode> = {
  [-32000]: 'Rejected',
  [-32001]: 'PermissionRejected',
  [-32002]: 'Disconnected',
  [-32602]: 'InvalidRequest',
  [-32603]: 'InternalError',
};

// ── JSON-RPC error shape from the wire ──

export interface JsonRpcError {
  code: number;
  message: string;
  data?: {
    type: string;
    code: string;
  };
}

// ── Reconstruct typed APIError from JSON-RPC error ──

export function reconstructError(rpcError: JsonRpcError): APIError {
  // Prefer the embedded error code from data (most precise)
  let errorCode: ErrorCode;
  if (rpcError.data?.type === 'DAppConnectorAPIError' && rpcError.data.code) {
    errorCode = rpcError.data.code as ErrorCode;
  } else {
    errorCode = RPC_CODE_TO_ERROR[rpcError.code] ?? 'InternalError';
  }

  const error = new Error(rpcError.message) as APIError;
  error.type = 'DAppConnectorAPIError';
  error.code = errorCode;
  error.reason = rpcError.message;
  return error;
}
