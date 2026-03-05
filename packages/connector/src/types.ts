// ConnectedAPI-compatible type definitions
// Structurally compatible with @midnight-ntwrk/dapp-connector-api@4.0.1
// Own definitions because the official package is on GitHub Package Registry, not public npm

// ── Token & Balance ──

/** Hex-encoded string identifying a token type (e.g. 64 zero chars for NIGHT) */
export type TokenType = string;

// ── Transaction Types ──

export interface DesiredOutput {
  kind: 'shielded' | 'unshielded';
  type: TokenType;
  value: bigint;
  recipient: string;
}

export interface DesiredInput {
  kind: 'shielded' | 'unshielded';
  type: TokenType;
  value: bigint;
}

// ── Transaction Status ──

export type ExecutionStatus = Record<number, 'Success' | 'Failure'>;

export type TxStatus =
  | { status: 'finalized'; executionStatus: ExecutionStatus }
  | { status: 'confirmed'; executionStatus: ExecutionStatus }
  | { status: 'pending' }
  | { status: 'discarded' };

export interface HistoryEntry {
  txHash: string;
  txStatus: TxStatus;
}

// ── Signing ──

export interface SignDataOptions {
  encoding: 'hex' | 'base64' | 'text';
  keyType: 'unshielded';
}

export interface Signature {
  data: string;
  signature: string;
  verifyingKey: string;
}

// ── Key Material & Proving ──

export interface KeyMaterialProvider {
  getZKIR(circuitKeyLocation: string): Promise<Uint8Array>;
  getProverKey(circuitKeyLocation: string): Promise<Uint8Array>;
  getVerifierKey(circuitKeyLocation: string): Promise<Uint8Array>;
}

export interface ProvingProvider {
  check(serializedPreimage: Uint8Array, keyLocation: string): Promise<(bigint | undefined)[]>;
  prove(
    serializedPreimage: Uint8Array,
    keyLocation: string,
    overwriteBindingInput?: bigint,
  ): Promise<Uint8Array>;
}

// ── Configuration & Status ──

export interface Configuration {
  indexerUri: string;
  indexerWsUri: string;
  proverServerUri?: string | undefined;
  substrateNodeUri: string;
  networkId: string;
}

export type ConnectionStatus =
  | { status: 'connected'; networkId: string }
  | { status: 'disconnected' };

// ── Error Types ──

export const ErrorCodes = {
  InternalError: 'InternalError',
  Rejected: 'Rejected',
  InvalidRequest: 'InvalidRequest',
  PermissionRejected: 'PermissionRejected',
  Disconnected: 'Disconnected',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface APIError extends Error {
  type: 'DAppConnectorAPIError';
  code: ErrorCode;
  reason: string;
}

// ── Connected API ──

export interface WalletConnectedAPI {
  getShieldedBalances(): Promise<Record<TokenType, bigint>>;
  getUnshieldedBalances(): Promise<Record<TokenType, bigint>>;
  getDustBalance(): Promise<{ cap: bigint; balance: bigint }>;

  getShieldedAddresses(): Promise<{
    shieldedAddress: string;
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  }>;
  getUnshieldedAddress(): Promise<{ unshieldedAddress: string }>;
  getDustAddress(): Promise<{ dustAddress: string }>;

  getTxHistory(pageNumber: number, pageSize: number): Promise<HistoryEntry[]>;

  balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean }): Promise<{ tx: string }>;
  balanceSealedTransaction(tx: string, options?: { payFees?: boolean }): Promise<{ tx: string }>;

  makeTransfer(desiredOutputs: DesiredOutput[], options?: { payFees?: boolean }): Promise<{ tx: string }>;
  makeIntent(
    desiredInputs: DesiredInput[],
    desiredOutputs: DesiredOutput[],
    options: { intentId: number | 'random'; payFees: boolean },
  ): Promise<{ tx: string }>;

  signData(data: string, options: SignDataOptions): Promise<Signature>;
  submitTransaction(tx: string): Promise<void>;

  getProvingProvider(keyMaterialProvider: KeyMaterialProvider): Promise<ProvingProvider>;

  getConfiguration(): Promise<Configuration>;
  getConnectionStatus(): Promise<ConnectionStatus>;
}

export interface HintUsage {
  hintUsage(methodNames: Array<keyof WalletConnectedAPI>): Promise<void>;
}

export type ConnectedAPI = WalletConnectedAPI & HintUsage;
