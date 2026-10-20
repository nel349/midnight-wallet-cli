// A device's code: the one line a person carries from one machine to another
// to name a device, its arm and public key. It reads back as the same device,
// and anything else is refused as a usage mistake.

import { describe, expect, it } from 'vitest';
import { freshOwnerDevice } from '@kuiralabs/midnight-account-chain/owner';
import { UsageError } from '../lib/errors.ts';
import { deviceCodeOf, parseDeviceCode } from '../lib/grant/device-code.ts';

describe('a device code', () => {
  it('reads back as the same device, on either arm', () => {
    for (const arm of ['v1', 'k1'] as const) {
      const device = freshOwnerDevice(arm);
      const code = deviceCodeOf(device);
      expect(code).toMatch(new RegExp(`^mn-device:${arm}:[0-9a-f]{64}:[0-9a-f]{64}$`));
      expect(parseDeviceCode(code)).toEqual({ arm, pk: device.pk });
    }
  });

  it('is refused when it is not one', () => {
    for (const code of ['', 'mn-device:v1:00', `mn-device:x9:${'0'.repeat(64)}:${'0'.repeat(64)}`, `device:v1:${'a'.repeat(64)}:${'b'.repeat(64)}`]) {
      expect(() => parseDeviceCode(code), code).toThrow(UsageError);
    }
  });
});
