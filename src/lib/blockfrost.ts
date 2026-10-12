// Blockfrost serves the indexer and node RPC of the networks Midnight no
// longer hosts itself (preprod since 2026-10-09). Every request needs the
// user's own project id, passed as a `project_id` query parameter, and a
// project id belongs to one network: its prefix says which.
//
// This module knows the endpoints, which network a project id is for, how to
// keep it out of anything mn prints, and what a refused connection means.
// It opens no connection itself.

import { UsageError } from './errors.ts';

/** The networks whose indexer and node Blockfrost serves, with the prefix of their project ids. */
const BLOCKFROST_NETWORKS = {
  preprod: { host: 'midnight-preprod.blockfrost.io', prefix: 'nightpreprod' },
} as const;

export type BlockfrostNetwork = keyof typeof BLOCKFROST_NETWORKS;

const PROJECT_ID_PARAM = 'project_id';
export const BLOCKFROST_SITE = 'https://blockfrost.io';
export const SET_PROJECT_ID_COMMAND = 'midnight config set blockfrost-project-id <project id>';

/** Hosts Midnight shut down, with the day it did: connecting can only fail. */
const SHUT_DOWN_HOSTS: Readonly<Record<string, string>> = {
  'indexer.preprod.midnight.network': '2026-10-09',
};

export function usesBlockfrost(network: string): network is BlockfrostNetwork {
  return Object.hasOwn(BLOCKFROST_NETWORKS, network);
}

export function blockfrostNetworks(): BlockfrostNetwork[] {
  return Object.keys(BLOCKFROST_NETWORKS) as BlockfrostNetwork[];
}

/** The network a project id is for, by its prefix; undefined when it is for none mn reaches through Blockfrost. */
export function networkOfProjectId(projectId: string): BlockfrostNetwork | undefined {
  return blockfrostNetworks().find((network) => projectId.startsWith(BLOCKFROST_NETWORKS[network].prefix));
}

/**
 * A project id as given, checked: it must be one word and belong to a network
 * mn reaches through Blockfrost. Returns it with its network.
 */
export function checkProjectId(given: string): { projectId: string; network: BlockfrostNetwork } {
  const projectId = given.trim();
  const network = /^[A-Za-z0-9]+$/.test(projectId) ? networkOfProjectId(projectId) : undefined;
  if (network === undefined) {
    const expected = blockfrostNetworks().map((name) => `"${BLOCKFROST_NETWORKS[name].prefix}" (${name})`).join(', ');
    throw new UsageError(
      `That is not a Blockfrost project id mn can use: it should start with ${expected}. `
      + `Project ids are per network; create a project for the Midnight network you need at ${BLOCKFROST_SITE}.`,
    );
  }
  return { projectId, network };
}

/**
 * The network's Blockfrost endpoints, carrying the project id when there is
 * one. Without one they are still the right hosts: a command that connects
 * is stopped by `assertEndpointUsable`, one that doesn't is not bothered.
 */
export function blockfrostEndpoints(network: BlockfrostNetwork, projectId: string | undefined): { indexer: string; indexerWS: string; node: string } {
  const { host } = BLOCKFROST_NETWORKS[network];
  const query = projectId === undefined ? '' : `?${PROJECT_ID_PARAM}=${projectId}`;
  return {
    indexer: `https://${host}/api/v0${query}`,
    indexerWS: `wss://${host}/api/v0/ws${query}`,
    node: `wss://rpc.${host}${query}`,
  };
}

function parsed(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** The Blockfrost network a URL is an endpoint of, if any. */
function blockfrostNetworkOfUrl(url: URL): BlockfrostNetwork | undefined {
  return blockfrostNetworks().find((network) => {
    const { host } = BLOCKFROST_NETWORKS[network];
    return url.hostname === host || url.hostname === `rpc.${host}`;
  });
}

export function isBlockfrostUrl(url: string): boolean {
  const hostname = parsed(url)?.hostname;
  return hostname !== undefined && (hostname === 'blockfrost.io' || hostname.endsWith('.blockfrost.io'));
}

/** The network needs a Blockfrost project id and none is set. */
export class BlockfrostProjectIdRequiredError extends Error {
  readonly code = 'BLOCKFROST_PROJECT_ID_REQUIRED';

  constructor(network: string) {
    super(
      `${network}'s indexer and node are served by Blockfrost, which needs your own project id on every request, and none is set.\n`
      + `Create a project for Midnight ${network} at ${BLOCKFROST_SITE} and set its id once:\n`
      + `  ${SET_PROJECT_ID_COMMAND}`,
    );
    this.name = 'BlockfrostProjectIdRequiredError';
    Object.setPrototypeOf(this, BlockfrostProjectIdRequiredError.prototype);
  }
}

/** Blockfrost refused the project id it was given. */
export class BlockfrostProjectIdRejectedError extends Error {
  readonly code = 'BLOCKFROST_PROJECT_ID_REJECTED';

  constructor(network: string) {
    super(
      `Blockfrost refused the project id set for ${network} (HTTP 403).\n`
      + `Check it at ${BLOCKFROST_SITE}: it must be the id of a Midnight ${network} project. Then set it again:\n`
      + `  ${SET_PROJECT_ID_COMMAND}`,
    );
    this.name = 'BlockfrostProjectIdRejectedError';
    Object.setPrototypeOf(this, BlockfrostProjectIdRejectedError.prototype);
  }
}

/** Blockfrost is holding the project back: its plan's limit or its rate limit. */
export class BlockfrostLimitError extends Error {
  readonly code = 'BLOCKFROST_LIMIT_REACHED';

  constructor(status: number) {
    super(
      `Blockfrost answered HTTP ${status}, which its API uses for `
      + (status === 402 ? "a project that has used up its plan's daily requests" : 'too many requests in a short time')
      + `.\nWait and run the command again, or see the project's usage and plan at ${BLOCKFROST_SITE}.`,
    );
    this.name = 'BlockfrostLimitError';
    Object.setPrototypeOf(this, BlockfrostLimitError.prototype);
  }
}

/** The endpoint was shut down by whoever ran it. */
export class EndpointShutDownError extends Error {
  readonly code = 'ENDPOINT_SHUT_DOWN';

  constructor(url: string) {
    const hostname = parsed(url)?.hostname ?? redactProjectId(url);
    const since = SHUT_DOWN_HOSTS[hostname];
    super(
      `${hostname} was shut down${since === undefined ? '' : ` on ${since}`}: it no longer serves the network.\n`
      + 'It is set as an endpoint, by a flag or with "midnight config set". Remove it (midnight config unset indexer-ws, or node) '
      + `to use the network's current endpoints; preprod's are Blockfrost's and need a project id:\n`
      + `  ${SET_PROJECT_ID_COMMAND}`,
    );
    this.name = 'EndpointShutDownError';
    Object.setPrototypeOf(this, EndpointShutDownError.prototype);
  }
}

/** Whether an error is one of this module's: an endpoint that can't serve the request as it is configured. */
export function isEndpointError(err: unknown): boolean {
  return err instanceof BlockfrostProjectIdRequiredError || err instanceof BlockfrostProjectIdRejectedError
    || err instanceof BlockfrostLimitError || err instanceof EndpointShutDownError;
}

/**
 * Throws before a connection that can only fail: to a host that was shut
 * down, or to Blockfrost without a project id.
 */
export function assertEndpointUsable(url: string): void {
  const target = parsed(url);
  if (target === undefined) return;
  if (Object.hasOwn(SHUT_DOWN_HOSTS, target.hostname)) throw new EndpointShutDownError(url);
  const network = blockfrostNetworkOfUrl(target);
  if (network !== undefined && !target.searchParams.get(PROJECT_ID_PARAM)) throw new BlockfrostProjectIdRequiredError(network);
}

/**
 * What an HTTP status means when an endpoint answers a request or a WebSocket
 * upgrade with it, as an error that says what to do. Undefined for a status
 * that has no such meaning here.
 */
export function endpointRefusal(url: string, status: number): Error | undefined {
  if (status === 410) return new EndpointShutDownError(url);
  const target = parsed(url);
  if (target === undefined || !isBlockfrostUrl(url)) return undefined;
  const network = blockfrostNetworkOfUrl(target) ?? 'this network';
  if (status === 403) {
    return target.searchParams.get(PROJECT_ID_PARAM) ? new BlockfrostProjectIdRejectedError(network) : new BlockfrostProjectIdRequiredError(network);
  }
  if (status === 402 || status === 429) return new BlockfrostLimitError(status);
  return undefined;
}

/** The same, for the error the `ws` package raises when an upgrade is answered with a status. */
export function endpointRefusalFromWsError(url: string, error: unknown): Error | undefined {
  const status = /Unexpected server response: (\d{3})/.exec(error instanceof Error ? error.message : String(error))?.[1];
  return status === undefined ? undefined : endpointRefusal(url, Number(status));
}

// The value is whatever URL-safe characters follow the parameter's name, so the text after a URL is left as it was.
const PROJECT_ID_IN_URL = new RegExp(`([?&]${PROJECT_ID_PARAM}=)[A-Za-z0-9_.~%-]+`, 'g');
const BARE_PROJECT_ID = new RegExp(`\\b(${Object.values(BLOCKFROST_NETWORKS).map(({ prefix }) => prefix).join('|')})[A-Za-z0-9]{12,}\\b`, 'g');

/** The marker a hidden project id is replaced with. */
export const REDACTED = '***';

/** The text with every project id in it hidden: in a URL's query, or standing alone. */
export function redactProjectId(text: string): string {
  return text.replace(PROJECT_ID_IN_URL, `$1${REDACTED}`).replace(BARE_PROJECT_ID, `$1${REDACTED}`);
}

/** Whether the text holds something `redactProjectId` would hide. Cheap, for output paths. */
export function mayHoldProjectId(text: string): boolean {
  return text.includes(`${PROJECT_ID_PARAM}=`) || Object.values(BLOCKFROST_NETWORKS).some(({ prefix }) => text.includes(prefix));
}

/** A project id as mn shows it: its network's prefix and its last four characters. */
export function maskProjectId(projectId: string): string {
  const network = networkOfProjectId(projectId);
  const prefix = network === undefined ? '' : BLOCKFROST_NETWORKS[network].prefix;
  return `${prefix}…${projectId.slice(-4)}`;
}
