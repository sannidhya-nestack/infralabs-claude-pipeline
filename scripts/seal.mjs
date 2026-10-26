// Seals a file to a public key made in another run, and opens it there
// (agent.yml and process-invoice.yml on branch agent). Node's standard library
// only: gzip, then an ephemeral X25519 key, HKDF-SHA256 over the shared secret
// salted with both public keys, and AES-256-GCM with a random 12-byte IV. A
// sealed file is the ephemeral public key, the IV, the tag and the ciphertext.
// Every run makes its own key pair, so no key outlives the VM that holds it.
//
//   node scripts/seal.mjs keygen <dir>                 writes <dir>/key.pem (0600), prints the public key
//   node scripts/seal.mjs seal <public key> <in> <out>
//   node scripts/seal.mjs open <key.pem> <in> <out>    refuses a bad tag, or more than 256 MB unpacked
//   node scripts/seal.mjs test
//
// Errors print their message only, never file contents.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAX_BYTES = 256 * 1024 * 1024;
const INFO = Buffer.from("infralabs-agent-seal-v1");
/** Ephemeral public key, IV, tag. */
const HEAD = 32 + 12 + 16;

/** The raw 32-byte public key of a key object, public or private (its JWK carries x either way). */
const rawOf = (key) => Buffer.from(key.export({ format: "jwk" }).x, "base64url");
const keyOf = (raw) =>
  crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });

function aesKey(privateKey, publicKey, salt) {
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  return Buffer.from(crypto.hkdfSync("sha256", shared, salt, INFO, 32));
}

/** A new key pair: the private half to <dir>/key.pem, the raw public half returned in base64. */
export function keygen(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  fs.writeFileSync(path.join(dir, "key.pem"), privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
    flag: "wx",
  });
  return rawOf(publicKey).toString("base64");
}

export function seal(publicB64, plain, max = MAX_BYTES) {
  const raw = Buffer.from(publicB64, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== publicB64) throw new Error("not a raw X25519 public key in base64");
  if (plain.length > max) throw new Error(`input over ${max} bytes`);
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const ephemeralRaw = rawOf(ephemeral.publicKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey(ephemeral.privateKey, keyOf(raw), Buffer.concat([ephemeralRaw, raw])), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final()]);
  return Buffer.concat([ephemeralRaw, iv, cipher.getAuthTag(), body]);
}

export function open(privatePem, sealed, max = MAX_BYTES) {
  if (sealed.length < HEAD) throw new Error("not a sealed file");
  const privateKey = crypto.createPrivateKey(privatePem);
  const ephemeralRaw = sealed.subarray(0, 32);
  const key = aesKey(privateKey, keyOf(ephemeralRaw), Buffer.concat([ephemeralRaw, rawOf(privateKey)]));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(32, 44));
  decipher.setAuthTag(sealed.subarray(44, HEAD));
  // final() throws on a bad tag, before anything is unpacked.
  const packed = Buffer.concat([decipher.update(sealed.subarray(HEAD)), decipher.final()]);
  return zlib.gunzipSync(packed, { maxOutputLength: max });
}

/** A sealed file is never much bigger than what it holds: anything past that is refused unread. */
function readSealed(file) {
  if (fs.statSync(file).size > MAX_BYTES + 1024 * 1024) throw new Error("sealed file too big");
  return fs.readFileSync(file);
}

const write = (file, data) => fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-test-"));
  try {
    fs.mkdirSync(path.join(dir, "a"));
    fs.mkdirSync(path.join(dir, "b"));
    const pub = keygen(path.join(dir, "a"));
    assert.match(pub, /^[A-Za-z0-9+/]{43}=$/);
    const pem = fs.readFileSync(path.join(dir, "a", "key.pem"));
    keygen(path.join(dir, "b"));
    const other = fs.readFileSync(path.join(dir, "b", "key.pem"));
    assert.throws(() => keygen(path.join(dir, "a")), /EEXIST/);

    const plain = Buffer.concat([crypto.randomBytes(50_000), Buffer.alloc(50_000, "x")]);
    const sealed = seal(pub, plain);
    assert.deepEqual(open(pem, sealed), plain);
    assert.deepEqual(open(pem, seal(pub, Buffer.alloc(0))), Buffer.alloc(0));
    // A flipped byte anywhere: the ephemeral key, the IV, the tag, the ciphertext.
    for (const at of [0, 31, 32, 43, 44, 59, HEAD, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[at] ^= 1;
      assert.throws(() => open(pem, bad), `flipped byte ${at}`);
    }
    assert.throws(() => open(other, sealed), "wrong key");
    assert.throws(() => open(pem, sealed.subarray(0, HEAD - 1)), /not a sealed file/);
    // Oversized: more than the cap unpacked (zlib's maxOutputLength), and more than the cap sealed.
    assert.throws(() => open(pem, seal(pub, Buffer.alloc(4096)), 4095), /larger than|maxOutputLength|Cannot create a Buffer/i);
    assert.deepEqual(open(pem, seal(pub, Buffer.alloc(4096)), 4096), Buffer.alloc(4096));
    assert.throws(() => seal(pub, Buffer.alloc(4097), 4096), /over 4096 bytes/);
    // The host gzips the agent's bundle first (process-invoice.yml, "Agent dispatch"): one over
    // the cap as a plain tar seals and opens under it gzipped, and unpacks whole.
    const bundle = Buffer.alloc(8192, "pages/00001.txt ");
    assert.throws(() => seal(pub, bundle, 4096), /over 4096 bytes/);
    assert.deepEqual(zlib.gunzipSync(open(pem, seal(pub, zlib.gzipSync(bundle), 4096), 4096)), bundle);
    // Not a key: wrong length, not canonical base64.
    assert.throws(() => seal(pub.slice(0, 40), plain), /not a raw X25519/);
    assert.throws(() => seal(`${pub.slice(0, 42)}B=`, plain), /not a raw X25519/);
    // The CLI writes 0600 files and never overwrites one.
    write(path.join(dir, "out"), sealed);
    assert.throws(() => write(path.join(dir, "out"), sealed), /EEXIST/);
    console.log("seal.mjs test: ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "keygen" && args.length === 1) console.log(keygen(args[0]));
  else if (command === "seal" && args.length === 3) write(args[2], seal(args[0], fs.readFileSync(args[1])));
  else if (command === "open" && args.length === 3) write(args[2], open(fs.readFileSync(args[0]), readSealed(args[1])));
  else if (command === "test" && args.length === 0) selftest();
  else {
    console.error("usage: seal.mjs keygen <dir> | seal <public key> <in> <out> | open <key.pem> <in> <out> | test");
    process.exit(2);
  }
} catch (err) {
  console.error(`seal.mjs ${command}: ${err instanceof Error ? err.message : "failed"}`);
  process.exit(1);
}
