import { useSyncExternalStore } from "react";

export const TV_PIN_KEY = "hghubx_tv_pin_v1";

type StoredPin = {
  version: 1;
  enabled: boolean;
  salt: string;
  hash: string;
};

export type TvPinSnapshot = {
  enabled: boolean;
  locked: boolean;
};

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Synchronous ASCII SHA-256 so cold-boot PIN checks work on legacy WebViews without crypto.subtle. */
function sha256Hex(ascii: string): string {
  const len = ascii.length;
  const bitLen = len * 8;
  const blocks = (((len + 8) >> 6) + 1) << 4;
  const words = new Uint32Array(blocks);
  for (let i = 0; i < len; i++) words[i >> 2] |= (ascii.charCodeAt(i) & 0xff) << (24 - (i & 3) * 8);
  words[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
  words[blocks - 1] = bitLen >>> 0;

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < blocks; offset += 16) {
    for (let i = 0; i < 16; i++) w[i] = words[offset + i];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(n => n.toString(16).padStart(8, "0")).join("");
}

function randomSalt(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function digestPin(salt: string, pin: string): string {
  return sha256Hex(`${salt}:hghubx-tv-pin-v1:${pin}`);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isValidTvPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

function readStoredPin(): StoredPin {
  try {
    const raw = localStorage.getItem(TV_PIN_KEY);
    if (!raw) return { version: 1, enabled: false, salt: "", hash: "" };
    const parsed = JSON.parse(raw) as Partial<StoredPin>;
    if (
      parsed.enabled === true &&
      typeof parsed.salt === "string" && parsed.salt.length >= 16 &&
      typeof parsed.hash === "string" && /^[0-9a-f]{64}$/.test(parsed.hash)
    ) {
      return { version: 1, enabled: true, salt: parsed.salt, hash: parsed.hash };
    }
    return { version: 1, enabled: false, salt: "", hash: "" };
  } catch {
    return { version: 1, enabled: false, salt: "", hash: "" };
  }
}

function writeStoredPin(next: StoredPin): void {
  const serialized = JSON.stringify(next);
  try {
    localStorage.setItem(TV_PIN_KEY, serialized);
    if (localStorage.getItem(TV_PIN_KEY) !== serialized) {
      throw new Error("readback mismatch");
    }
  } catch {
    throw new Error("启动密码保存失败，请检查存储空间后重试");
  }
}

let stored = readStoredPin();
let sessionUnlocked = !stored.enabled;
let snapshot: TvPinSnapshot = { enabled: stored.enabled, locked: stored.enabled && !sessionUnlocked };
const listeners = new Set<() => void>();

function emit() {
  const nextLocked = stored.enabled && !sessionUnlocked;
  if (snapshot.enabled === stored.enabled && snapshot.locked === nextLocked) return;
  snapshot = { enabled: stored.enabled, locked: nextLocked };
  listeners.forEach(listener => listener());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key !== null && event.key !== TV_PIN_KEY) return;
    stored = readStoredPin();
    if (!stored.enabled) sessionUnlocked = true;
    emit();
  });
}

export function verifyTvPin(pin: string): boolean {
  if (!stored.enabled || !isValidTvPin(pin)) return false;
  return constantTimeEqual(digestPin(stored.salt, pin), stored.hash);
}

export function unlockTvSession(pin: string): boolean {
  if (!verifyTvPin(pin)) return false;
  sessionUnlocked = true;
  emit();
  return true;
}

export function lockTvSession(): void {
  if (!stored.enabled) return;
  sessionUnlocked = false;
  emit();
}

export function enableTvPin(pin: string): void {
  if (!isValidTvPin(pin)) throw new Error("请输入 4 位数字 PIN 码");
  const salt = randomSalt();
  const next: StoredPin = { version: 1, enabled: true, salt, hash: digestPin(salt, pin) };
  writeStoredPin(next);
  stored = next;
  sessionUnlocked = true;
  emit();
}

export function disableTvPin(): void {
  const next: StoredPin = { version: 1, enabled: false, salt: "", hash: "" };
  writeStoredPin(next);
  stored = next;
  sessionUnlocked = true;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useTvPin = (): TvPinSnapshot => useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
