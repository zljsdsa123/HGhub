export const USAGE_AGREEMENT_VERSION = "2026-11-15-v1";
export const USAGE_AGREEMENT_KEY = "hghubx_usage_agreement";

export function hasAcceptedAgreement() {
  try {
    const record: unknown = JSON.parse(localStorage.getItem(USAGE_AGREEMENT_KEY) || "null");
    if (!record || typeof record !== "object") return false;
    const value = record as Record<string, unknown>;
    return value.version === USAGE_AGREEMENT_VERSION && value.accepted === true
      && typeof value.acceptedAt === "string" && Number.isFinite(Date.parse(value.acceptedAt));
  } catch { return false; }
}

/** Explicit local click-through record; contains no identity or device identifier. */
export function acceptUsageAgreement() {
  localStorage.setItem(USAGE_AGREEMENT_KEY, JSON.stringify({ version: USAGE_AGREEMENT_VERSION, accepted: true, acceptedAt: new Date().toISOString() }));
  if (!hasAcceptedAgreement()) throw new Error("Agreement storage verification failed");
}
