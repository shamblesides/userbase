import aesGcm from './aes-gcm.js'
import diffieHellman from './diffie-hellman.js'
import ecdsa from './ecdsa.js'
import ecdh from './ecdh.js'
import sha256 from './sha-256.js'
import hmac from './hmac.js'
import hkdf from './hkdf.js'
import scrypt from './scrypt.js'

const SEED_BYTE_SIZE = 32 // 256 / 8
const generateSeed = () => globalThis.crypto.getRandomValues(new Uint8Array(SEED_BYTE_SIZE))

export default {
  generateSeed,
  aesGcm,
  diffieHellman,
  ecdsa,
  ecdh,
  sha256,
  hmac,
  hkdf,
  scrypt
}
