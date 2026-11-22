/**
 * O fim do turno com falha de envio: transitória re-tenta, permanente encerra.
 * (O turno completo, com banco e modelo fake, é provado em
 * `tests/invariants/falha-permanente-de-envio-no-turno.test.ts`.)
 */
import { describe, expect, it, vi } from "vitest";

import type { ChannelSendResult } from "../channel-adapter";
import {
  avisarEquipeDaFalhaPermanenteDeEnvio,
  desfechoDosEnvios,
  TITULO_DO_AVISO_DE_FALHA_PERMANENTE,
} from "./falha-permanente-de-envio";

const enviada: ChannelSendResult = { kind: "sent", idempotencyKey: "k1", messageId: "m1" };
const permanente: ChannelSendResult = { kind: "failed", idempotencyKey: "k2", messageId: "m2", permanente: true };
const transitoria: ChannelSendResult = { kind: "failed", idempotencyKey: "k3", messageId: "m3", permanente: false };
const semNatureza: ChannelSendResult = { kind: "failed", idempotencyKey: "k4", messageId: "m4" };

describe("desfechoDosEnvios", () => {
  it("sem falha: segue", () => {
    expect(desfechoDosEnvios([])).toBe("segue");
    expect(desfechoDosEnvios([enviada])).toBe("segue");
  });

  it("⭐ só recusa definitiva: encerra sem retry", () => {
    expect(desfechoDosEnvios([permanente])).toBe("falha_permanente");
    expect(desfechoDosEnvios([enviada, permanente])).toBe("falha_permanente");
  });

  it("falha transitória — ou sem natureza (adapter que não classifica) — re-tenta, e ganha da permanente", () => {
    expect(desfechoDosEnvios([transitoria])).toBe("retentar");
    expect(desfechoDosEnvios([semNatureza])).toBe("retentar");
    expect(desfechoDosEnvios([permanente, transitoria])).toBe("retentar");
  });
});

describe("avisarEquipeDaFalhaPermanenteDeEnvio", () => {
  it("um aviso aberto por conversa na Central, levando à conversa", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "item" }] }));
    await avisarEquipeDaFalhaPermanenteDeEnvio({ query } as never, { organizationId: "org", conversationId: "conv" });
    const [sql, valores] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/where not exists/);
    expect(valores.slice(0, 7)).toEqual([
      "org",
      "other",
      "warn",
      TITULO_DO_AVISO_DE_FALHA_PERMANENTE,
      expect.any(String),
      "conversation",
      "conv",
    ]);
  });

  it("nunca lança — falhar no aviso não pode virar retry do turno", async () => {
    const query = vi.fn(async () => {
      throw new Error("banco fora");
    });
    const log = { warn: vi.fn() };
    await expect(
      avisarEquipeDaFalhaPermanenteDeEnvio({ query } as never, { organizationId: "org", conversationId: "conv", log: log as never }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
