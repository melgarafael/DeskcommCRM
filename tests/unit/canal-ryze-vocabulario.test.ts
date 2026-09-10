import { describe, expect, it } from "vitest";

import {
  CHANNEL_CAPABILITIES,
  CHANNEL_PROVIDER_RYZE,
  capabilitiesOf,
} from "@/lib/channels/capabilities";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { PASCAL, SEPARADO } from "@/scripts/lint-channels.pattern";

const RYZE = CHANNEL_PROVIDER_RYZE;

describe("vocabulario do canal ryze", () => {
  it("descreve as capabilities do canal ryze de forma conservadora e alinhada ao contrato", () => {
    expect(capabilitiesOf(RYZE)).toEqual({
      freeformOutsideWindow: true,
      requiresTemplates: false,
      canManageTemplates: false,
      banRisk: true,
      minIntervalMs: null,
      voiceNote: "opus-only",
      groups: "full",
      costPerMessage: false,
    });
  });

  it("resolve o session ref correto para o provider ryze", () => {
    const sessionRef = resolveSessionRef({
      provider: "ryze",
      ryze_instance_name: "instancia_teste_123",
    });
    expect(sessionRef).toBe("instancia_teste_123");
  });

  it("inclui ryze_instance_name no select canonico CHANNEL_SESSION_REF_COLUMNS", () => {
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("ryze_instance_name");
  });

  it("o lint de canais reconhece ryze e Ryze em grafias separadas e PascalCase", () => {
    expect(SEPARADO.test("ryze_instance_name")).toBe(true);
    expect(SEPARADO.test("RYZE_API_BASE_URL")).toBe(true);
    expect(PASCAL.test("RyzeClient")).toBe(true);
    expect(PASCAL.test("RyzeChannelAdapter")).toBe(true);
  });
});
