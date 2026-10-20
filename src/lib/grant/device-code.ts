// A device's code: its arm and public key in one line a person can carry
// between machines, `mn-device:<arm>:<x>:<y>`, each coordinate 32 bytes of
// hex. It is public: it names the device, it does not let anyone act as it.

import type { Arm } from '@kuiralabs/midnight-account';
import type { OwnerDevice } from '@kuiralabs/midnight-account-chain/owner';
import { UsageError } from '../errors.ts';

const PREFIX = 'mn-device';
const DEVICE_CODE = /^mn-device:(v1|k1):([0-9a-f]{64}):([0-9a-f]{64})$/;

/** A device named by its arm and public key. */
export interface DeviceIdentity {
  arm: Arm;
  pk: { x: bigint; y: bigint };
}

const hex32 = (value: bigint): string => value.toString(16).padStart(64, '0');

export function deviceCodeOf(device: Pick<OwnerDevice, 'arm' | 'pk'>): string {
  return `${PREFIX}:${device.arm}:${hex32(device.pk.x)}:${hex32(device.pk.y)}`;
}

export function parseDeviceCode(code: string): DeviceIdentity {
  const match = DEVICE_CODE.exec(code.trim());
  if (match === null) throw new UsageError(`Not a device code: "${code}". A device code reads mn-device:<v1|k1>:<x>:<y>, as \`midnight grant device new\` or \`device list\` prints it.`);
  const [, arm, x, y] = match as unknown as [string, Arm, string, string];
  return { arm, pk: { x: BigInt(`0x${x}`), y: BigInt(`0x${y}`) } };
}

/** True when `a` and `b` name the same device. */
export function sameDevice(a: DeviceIdentity, b: DeviceIdentity): boolean {
  return a.arm === b.arm && a.pk.x === b.pk.x && a.pk.y === b.pk.y;
}
