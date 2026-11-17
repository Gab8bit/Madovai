// Independent RFC 8291 / RFC 8188 (aes128gcm) decryptor used to cross-check the PHP encryptor.
// stdin: JSON {body, uaPrivate, uaPublic, auth} (all base64url); stdout: base64url plaintext.
const crypto = require('node:crypto');
const b64u = (s) => Buffer.from(s, 'base64url');

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const { body, uaPrivate, uaPublic, auth } = JSON.parse(input);
  const msg = b64u(body);
  const salt = msg.subarray(0, 16);
  const rs = msg.readUInt32BE(16);
  const idlen = msg[20];
  const asPublic = msg.subarray(21, 21 + idlen);
  const cipher = msg.subarray(21 + idlen);
  if (rs < 18) throw new Error('bad record size');
  if (cipher.length > rs) throw new Error('multi-record bodies not handled here');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(b64u(uaPrivate));
  const secret = ecdh.computeSecret(asPublic);

  const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b64u(uaPublic), asPublic]);
  const ikm = hkdf(secret, b64u(auth), keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  // strip padding: last record ends with 0x02 delimiter, preceded by optional zero padding
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (plain[end - 1] !== 0x02) throw new Error('missing padding delimiter');
  process.stdout.write(plain.subarray(0, end - 1).toString('base64url'));
});
