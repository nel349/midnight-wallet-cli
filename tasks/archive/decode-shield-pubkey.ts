import { ShieldedAddress, MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';

const bech = process.argv[2];
const parsed: any = MidnightBech32m.parse(bech).decode(ShieldedAddress, NetworkId.NetworkId.Undeployed);
console.log('keys:', Object.keys(parsed));
console.log('proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(parsed)));
console.log('parsed:', parsed);
