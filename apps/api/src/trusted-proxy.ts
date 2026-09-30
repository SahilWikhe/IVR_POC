import { isIP } from 'node:net';

/** The reviewed ALB topology has one trusted hop; earlier client headers stay untrusted. */
export function trustedProxy(cidrs: readonly string[]): (address: string, hop: number) => boolean {
  const numeric = (address: string) =>
    address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
  const ranges = cidrs.map((cidr) => {
    const [address, prefix] = cidr.split('/');
    if (
      !address ||
      isIP(address) !== 4 ||
      !prefix ||
      !/^\d+$/.test(prefix) ||
      Number(prefix) < 24 ||
      Number(prefix) > 32
    )
      throw new Error('Invalid trusted proxy range.');
    const mask = (0xffffffff << (32 - Number(prefix))) >>> 0;
    return { mask, network: numeric(address) & mask };
  });
  return (address, hop) => {
    if (hop !== 0) return false;
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (isIP(normalized) !== 4) return false;
    const value = numeric(normalized);
    return ranges.some((range) => (value & range.mask) === range.network);
  };
}
