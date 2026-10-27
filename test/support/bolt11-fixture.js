// Test-only builder for checksum-valid Signet (Mutinynet) BOLT11 strings with a
// chosen payment hash. The signature is all zeros: these are parser fixtures,
// never payable invoices and never payment evidence.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk;
}
const expand = hrp => [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];
function checksum(hrp, data) {
  const mod = polymod([...expand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  return Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
}
function toWords(bytes) {
  const words = []; let value = 0; let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((value >>> bits) & 31); }
  }
  if (bits > 0) words.push((value << (5 - bits)) & 31);
  return words;
}
const intWords = (number, length) => Array.from({ length }, (_, i) => Math.floor(number / 32 ** (length - 1 - i)) % 32);
const tag = (type, words) => [type, ...intWords(words.length, 2), ...words];

export function makeSignetInvoice({ paymentHash, amountSats = 100, timestamp = Math.floor(Date.now() / 1000), expiry = 1800 }) {
  const hrp = `lntbs${amountSats * 10}n`;
  const data = [
    ...intWords(timestamp, 7),
    ...tag(1, toWords(Buffer.from(paymentHash, 'hex'))),
    ...tag(6, intWords(expiry, Math.max(1, Math.ceil(Math.log2(expiry + 1) / 5)))),
    ...new Array(104).fill(0)
  ];
  return `${hrp}1${[...data, ...checksum(hrp, data)].map(word => CHARSET[word]).join('')}`;
}
