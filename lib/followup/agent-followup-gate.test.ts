import { describe, it, expect } from "vitest";

import { isPointerEnabledForAutomaticTrigger, type FollowupGateDb } from "./agent-followup-gate";

function fakeDb(byOrg: Record<string, string[]>): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupPointerIds(orgId) {
      return byOrg[orgId] ?? [];
    },
  };
}

describe("isPointerEnabledForAutomaticTrigger", () => {
  const ORG = "11111111-1111-1111-1111-111111111111";
  const POINTER_A = "22222222-2222-2222-2222-222222222222";
  const POINTER_B = "33333333-3333-3333-3333-333333333333";

  it("true quando o pointer está na lista de habilitados da org", async () => {
    const db = fakeDb({ [ORG]: [POINTER_A, POINTER_B] });
    await expect(isPointerEnabledForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(true);
  });

  it("false quando o pointer não está habilitado por nenhum agente publicado", async () => {
    const db = fakeDb({ [ORG]: [POINTER_B] });
    await expect(isPointerEnabledForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(false);
  });

  it("false quando a org não tem nenhum agente com followup habilitado", async () => {
    const db = fakeDb({});
    await expect(isPointerEnabledForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(false);
  });

  it("não vaza pointer habilitado de OUTRA org", async () => {
    const otherOrg = "44444444-4444-4444-4444-444444444444";
    const db = fakeDb({ [otherOrg]: [POINTER_A] });
    await expect(isPointerEnabledForAutomaticTrigger(db, ORG, POINTER_A)).resolves.toBe(false);
  });
});
