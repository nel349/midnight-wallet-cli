// A device's code: its arm, public key and read key in one line a person can
// carry between machines, `mn-device:<arm>:<x>:<y>:<read key>`, each 32 bytes
// of hex. The read key is where the account's secret is sealed to the device
// after a rotation. It is public: it names the device, it does not let anyone
// act as it or read for it. The form is the account library's, which every
// owner app speaks.
//
// The code a new device prints to be added carries one more field, its
// signature of its read key, so the device adding it can tell the account's
// other devices of it. A signature is drawn fresh each time, so codes are
// compared, listed and kept without it.

import { type Arm, type DeviceKey, type ReadKeyAttestation, deviceCodeOf as libraryDeviceCodeOf, joinCodeOf as libraryJoinCodeOf, parseDeviceCode as libraryParseDeviceCode } from '@kuiralabs/midnight-account';
import type { LocalOwnerDevice, OwnerDevice } from '@kuiralabs/midnight-account-chain/owner';
import { UsageError } from '../errors.ts';

/** A device named by its arm and public key, with its read key, and its signature of it when the code carries one. */
export interface DeviceIdentity {
  arm: Arm;
  pk: { x: bigint; y: bigint };
  readKey: Uint8Array;
  attestation?: ReadKeyAttestation;
}

export function deviceCodeOf(device: Pick<OwnerDevice, 'arm' | 'pk'>, readKey: Uint8Array): string {
  return libraryDeviceCodeOf(device, readKey);
}

/** The code a device prints to be added: its code and its signature of its read key. */
export function joinCodeOf(device: Pick<LocalOwnerDevice, 'attestReadKey'>, readKey: Uint8Array): string {
  return libraryJoinCodeOf(device.attestReadKey(readKey));
}

export function parseDeviceCode(code: string): DeviceIdentity {
  const parsed = libraryParseDeviceCode(code);
  if (parsed === undefined) throw new UsageError(`Not a device code: "${code}". A device code reads mn-device:<v1|k1>:<x>:<y>:<read key>, as \`midnight grant device new\` or \`device list\` prints it.`);
  return { arm: parsed.key.arm, pk: parsed.key.pk, readKey: parsed.readKey, ...(parsed.attestation === undefined ? {} : { attestation: parsed.attestation }) };
}

/** The code as kept and compared: without its signature. */
export function identityCodeOf(code: string): string {
  const device = parseDeviceCode(code);
  return deviceCodeOf(device, device.readKey);
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
