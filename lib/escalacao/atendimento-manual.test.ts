import { describe, expect, it, vi } from "vitest";

import {
  MOTIVO_ATENDIMENTO_MANUAL,
  MOTIVO_COMANDO_OFF,
  SILENCIO_DURAVEL,
  pausarIaDuravelmente,
  pausarIaPorAtendimentoManual,
} from "./atendimento-manual";
import { decidirElegibilidade, normalizarInstante } from "@/lib/ai/elegibilidade/gate";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

/**
 * ⚠️ RELÓGIO INJETADO, DE PROPÓSITO.
 *
 * Esta casa já pagou o erro de "dois relógios no teste": o instante capturado no
 * processo é futuro para o `now()` do banco, e a comparação falha de vez em
 * quando sozinha. Todo caso daqui passa `agora` explicitamente.
 */
const T0 = new Date("2026-09-03T14:00:00.000Z");

/**
 * Dublê do supabase-js que registra os UPDATEs em `conversations` e devolve a
 * linha de volta quando o UPDATE pede `.select("id")` — contrato novo de
 * `pausarIaDuravelmente`. `linhaDeVolta: false` simula o defeito do 0-linhas
 * (UPDATE que responde `error: null` mas não afeta nada).
 */
function adminStub(
  silencedUntil: string | null,
  falhas: { leitura?: string; escrita?: string } = {},
  linhaDeVolta = true,
) {
  const updates: Array<Record<string, unknown>> = [];
  const chain = {
    select: () => chain,
    update: (patch: Record<string, unknown>) => {
      updates.push(patch);
      return chain;
    },
    eq: () => chain,
    maybeSingle: () => {
      // O SELECT inicial não encadeia `.select("id")`; distinguimos pelo patch:
      // se houve update pendente, esta resposta é a do UPDATE.
      if (updates.length > 0) {
        return Promise.resolve({
          data:
            falhas.escrita || !linhaDeVolta
              ? null
              : { id: "22222222-2222-4222-8222-222222222222" },
          error: falhas.escrita ? { message: falhas.escrita } : null,
        });
      }
      return Promise.resolve({
        data: falhas.leitura ? null : { bot_silenced_until: silencedUntil },
        error: falhas.leitura ? { message: falhas.leitura } : null,
      });
    },
  };
  return { admin: { from: vi.fn(() => chain) } as never, updates };
}

/**
 * "A IA está calada nesta conversa, no instante `quando`?" — perguntado ao
 * MOTOR, `decidirElegibilidade`, e não a uma comparação de datas reescrita aqui.
 * É o que o `inbound-turn`, o drain e o handoff consultam de verdade.
 */
function iaCaladaEm(ate: unknown, quando: Date): boolean {
  const d = decidirElegibilidade({
    modo: "open",
    forceHuman: false,
    botSilencedUntil: normalizarInstante(ate as string | null),
    assigneeKind: null,
    aiAuthorizedAt: null,
    preGoLiveAtivo: false,
    numeroDeTesteAutorizado: false,
    agora: quando,
    ttlMs: 21 * 24 * 60 * 60 * 1000,
  });
  return !d.permite && d.motivo === "conversa_silenciada";
}

describe("pausarIaDuravelmente — o silêncio DURA até #on (decisão do dono)", () => {
  it("grava 'infinity' + rastro, e a IA segue calada MUITO depois", async () => {
    const { admin, updates } = adminStub(null);
    const pausou = await pausarIaDuravelmente(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    expect(pausou).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.bot_silenced_until).toBe(SILENCIO_DURAVEL);
    expect(updates[0]!.last_handoff_at).toBe(T0.toISOString());
    expect(String(updates[0]!.last_handoff_reason)).toMatch(/Atendimento manual/);

    // Um ano depois continua calada: não expira sozinha.
    const daquiUmAno = new Date(T0.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(iaCaladaEm(updates[0]!.bot_silenced_until, daquiUmAno)).toBe(true);
  });

  it("motivo do comando #off é distinguível do atendimento manual", async () => {
    const { admin, updates } = adminStub(null);
    await pausarIaDuravelmente(admin, {
      organizationId: ORG,
      conversationId: CONV,
      motivo: MOTIVO_COMANDO_OFF,
      agora: T0,
    });
    expect(updates[0]!.last_handoff_reason).toBe(MOTIVO_COMANDO_OFF);
  });

  it("o atalho pausarIaPorAtendimentoManual usa o motivo do atendimento manual", async () => {
    const { admin, updates } = adminStub(null);
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(updates[0]!.last_handoff_reason).toBe(MOTIVO_ATENDIMENTO_MANUAL);
  });
});

describe("pausarIaDuravelmente — nunca ENCURTA um silêncio já durável", () => {
  it("'infinity' em vigor (handoff formal ou pausa anterior) → não reescreve", async () => {
    const { admin, updates } = adminStub("infinity");
    const pausou = await pausarIaDuravelmente(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(pausou).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("silêncio já VENCIDO é reafirmado como durável", async () => {
    const jaPassou = new Date(T0.getTime() - 60_000).toISOString();
    const { admin, updates } = adminStub(jaPassou);
    const pausou = await pausarIaDuravelmente(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(pausou).toBe(true);
    expect(updates[0]!.bot_silenced_until).toBe(SILENCIO_DURAVEL);
  });
});

/**
 * O DEFEITO QUE ESTE ARQUIVO CONSERTA (bug do silêncio que não gruda sob
 * concorrência): o UPDATE respondia `error: null` afetando ZERO linhas, e a
 * versão antiga devolvia `true` e logava "IA pausada" sem ter gravado.
 */
describe("pausarIaDuravelmente — 0 linhas é FALHA, não sucesso", () => {
  it("UPDATE que afeta 0 linhas → devolve false (não mente 'pausei')", async () => {
    const { admin } = adminStub(null, {}, false);
    const pausou = await pausarIaDuravelmente(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(pausou).toBe(false);
  });
});

describe("pausarIaDuravelmente — o que NÃO grava, e o que não derruba", () => {
  it("NÃO toca ai_authorized_at / force_human / status / assignee_kind", async () => {
    const { admin, updates } = adminStub(null);
    await pausarIaDuravelmente(admin, { organizationId: ORG, conversationId: CONV, agora: T0 });
    const patch = updates[0] ?? {};
    expect(patch).not.toHaveProperty("ai_authorized_at");
    expect(patch).not.toHaveProperty("force_human");
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("assignee_kind");
  });

  it("conversa inexistente → não faz nada", async () => {
    const chain = {
      select: () => chain,
      update: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    const admin = { from: vi.fn(() => chain) } as never;
    const pausou = await pausarIaDuravelmente(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(pausou).toBe(false);
  });

  it("falha de LEITURA não lança — best-effort, a ingestão não pode cair", async () => {
    const { admin, updates } = adminStub(null, { leitura: "boom" });
    await expect(
      pausarIaDuravelmente(admin, { organizationId: ORG, conversationId: CONV, agora: T0 }),
    ).resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("falha de ESCRITA não lança — best-effort, a ingestão não pode cair", async () => {
    const { admin } = adminStub(null, { escrita: "boom" });
    await expect(
      pausarIaDuravelmente(admin, { organizationId: ORG, conversationId: CONV, agora: T0 }),
    ).resolves.toBe(false);
  });
});
