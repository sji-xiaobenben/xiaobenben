// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

/**
 * events 哈希链：org 内 org_seq 全序，hash = SHA-256(orgId|seq|prevHash|payloadHash)。
 * 账不可改只能增——append-only 哲学的凭证层兑现。
 */
export async function eventHash(input: {
  orgId: string;
  seq: number;
  prevHash: string;
  payloadHash: string;
}): Promise<string> {
  const data = new TextEncoder().encode(
    `${input.orgId}|${input.seq}|${input.prevHash}|${input.payloadHash}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function payloadHash(payload: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
