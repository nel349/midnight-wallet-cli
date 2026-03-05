// Public API for midnight-wallet-connector

export { createWalletClient } from './client.ts';
export type { WalletClient, WalletClientOptions } from './client.ts';

export type {
  ConnectedAPI,
  WalletConnectedAPI,
  HintUsage,
  Configuration,
  ConnectionStatus,
  DesiredOutput,
  DesiredInput,
  TokenType,
  ExecutionStatus,
  TxStatus,
  HistoryEntry,
  SignDataOptions,
  Signature,
  KeyMaterialProvider,
  ProvingProvider,
  WalletProvingProvider,
  APIError,
  ErrorCode,
} from './types.ts';

export { ErrorCodes } from './types.ts';
