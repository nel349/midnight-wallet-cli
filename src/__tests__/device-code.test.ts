// A device's code: the one line a person carries from one machine to another
// to name a device, its arm, public key and read key (where the account's
// secret is sealed to it after a rotation). It reads back as the same device,
// and anything else is refused as a usage mistake. The code a new device
// prints to be added also carries its signature of its read key, which is
// left out where codes are kept and compared.

import { describe, expect, it } from 'vitest';
import { freshOwnerDevice } from '@kuiralabs/midnight-account-chain/owner';
import { UsageError } from '../lib/errors.ts';
import { verifyReadKeyAttestation } from '@kuiralabs/midnight-account';
import { deviceCodeOf, deviceKeyOf, identityCodeOf, joinCodeOf, parseDeviceCode } from '../lib/grant/device-code.ts';

describe('a device code', () => {
  it('reads back as the same device, on either arm', () => {
    for (const arm of ['v1', 'k1'] as const) {
      const device = freshOwnerDevice(arm);
      const readKey = new Uint8Array(32).fill(0x5a);
      const code = deviceCodeOf(device, readKey);
      expect(code).toMatch(new RegExp(`^mn-device:${arm}:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{64}$`));
      expect(parseDeviceCode(code)).toEqual({ arm, pk: device.pk, readKey });
    }
  });

  it("names the key the account enrolled: an mn k1 device's in envelope 0, as mn's own k1 devices sign", () => {
    for (const arm of ['v1', 'k1'] as const) {
      const device = freshOwnerDevice(arm);
      const key = deviceKeyOf(parseDeviceCode(deviceCodeOf(device, new Uint8Array(32))));
      expect(key).toEqual(device.arm === 'k1' ? { arm, pk: device.pk, envelope: device.envelope } : { arm, pk: device.pk });
    }
  });

  it("printed to be added, carries the device's signature of its read key, and is kept without it", () => {
    for (const arm of ['v1', 'k1'] as const) {
      const device = freshOwnerDevice(arm);
      const readKey = new Uint8Array(32).fill(0x5a);
      const code = joinCodeOf(device, readKey);
      const parsed = parseDeviceCode(code);
      expect(parsed.attestation).toBeDefined();
      expect(verifyReadKeyAttestation(parsed.attestation!)).toBe(true);
      expect(identityCodeOf(code)).toBe(deviceCodeOf(device, readKey));
      expect(identityCodeOf(joinCodeOf(device, readKey))).toBe(identityCodeOf(code));
    }
  });

  it('is refused when it is not one', () => {
    for (const code of ['', 'mn-device:v1:00', `mn-device:v1:${'a'.repeat(64)}:${'b'.repeat(64)}`, `mn-device:x9:${'0'.repeat(64)}:${'0'.repeat(64)}`, `device:v1:${'a'.repeat(64)}:${'b'.repeat(64)}`]) {
      expect(() => parseDeviceCode(code), code).toThrow(UsageError);
    }
  });
});
