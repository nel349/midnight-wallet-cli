// A device's code: its arm, public key and read key in one line a person can
// carry between machines, `mn-device:<arm>:<x>:<y>:<read key>`, each 32 bytes
// of hex. The read key is where the account's secret is sealed to the device
// after a rotation. It is public: it names the device, it does not let anyone
// act as it or read for it.

import type { Arm, DeviceKey } from '@kuiralabs/midnight-account';
import type { OwnerDevice } from '@kuiralabs/midnight-account-chain/owner';
import { UsageError } from '../errors.ts';

const PREFIX = 'mn-device';
const DEVICE_CODE = /^mn-device:(v1|k1):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64})$/;

/** A device named by its arm and public key, with its read key. */
export interface DeviceIdentity {
  arm: Arm;
  pk: { x: bigint; y: bigint };
  readKey: Uint8Array;
}

const hex32 = (value: bigint): string => value.toString(16).padStart(64, '0');

export function deviceCodeOf(device: Pick<OwnerDevice, 'arm' | 'pk'>, readKey: Uint8Array): string {
  return `${PREFIX}:${device.arm}:${hex32(device.pk.x)}:${hex32(device.pk.y)}:${Buffer.from(readKey).toString('hex')}`;
}

export function parseDeviceCode(code: string): DeviceIdentity {
  const match = DEVICE_CODE.exec(code.trim());
  if (match === null) throw new UsageError(`Not a device code: "${code}". A device code reads mn-device:<v1|k1>:<x>:<y>:<read key>, as \`midnight grant device new\` or \`device list\` prints it.`);
  const [, arm, x, y, readKey] = match as unknown as [string, Arm, string, string, string];
  return { arm, pk: { x: BigInt(`0x${x}`), y: BigInt(`0x${y}`) }, readKey: new Uint8Array(Buffer.from(readKey, 'hex')) };
}

/**
 * The key the account enrolled for the device. mn holds its devices' keys
 * itself, and a k1 key held that way signs in envelope 0, so a code names no
 * envelope.
 */
export function deviceKeyOf(device: DeviceIdentity): DeviceKey {
  return device.arm === 'k1' ? { arm: 'k1', pk: device.pk, envelope: 0 } : { arm: 'v1', pk: device.pk };
}

/** True when `a` and `b` name the same device. */
export function sameDevice(a: DeviceIdentity, b: DeviceIdentity): boolean {
  return a.arm === b.arm && a.pk.x === b.pk.x && a.pk.y === b.pk.y;
}
