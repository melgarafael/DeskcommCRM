import { describe, expect, it, vi } from "vitest";

import { PRAZO_DO_SILENCIO_MS, pausarIaPorAtendimentoManual } from "./atendimento-manual";
import { decidirElegibilidade, normalizarInstante } from "@/lib/ai/elegibilidade/gate";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";

/**
 * ⚠️ RELÓGIO INJETADO, DE PROPÓSITO.
 *
 * Esta casa já pagou o erro de "dois relógios no teste": o instante capturado no
 * processo é futuro para o `now()` do banco, e a comparação falha de vez em
 * quando sozinha. Todo caso daqui passa `agora` explicitamente e faz contas
 * contra ESSE instante — nenhuma asserção depende de `Date.now()`.
 */
const T0 = new Date("2026-09-03T14:00:00.000Z");

/**
 * Dublê do supabase-js que registra os UPDATEs em `conversations`.
 * `silencedUntil` alimenta o SELECT inicial.
 */
function adminStub(
  silencedUntil: string | null,
  falhas: { leitura?: string; escrita?: string } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  const chain = {
    select: () => chain,
    update: (patch: Record<string, unknown>) => {
      updates.push(patch);
      return chain;
    },
    eq: () => chain,
    maybeSingle: () =>
      Promise.resolve(
        falhas.leitura
          ? { data: null, error: { message: falhas.leitura } }
          : { data: { bot_silenced_until: silencedUntil }, error: null },
      ),
    then: (r: (v: unknown) => unknown) =>
      Promise.resolve({ error: falhas.escrita ? { message: falhas.escrita } : null }).then(r),
  };
  return { admin: { from: vi.fn(() => chain) } as never, updates };
}

/** O instante que a chamada gravou em `bot_silenced_until`. */
function silenciadaAte(patch: Record<string, unknown>): Date {
  return new Date(String(patch.bot_silenced_until));
}

/**
 * "A IA está calada nesta conversa, no instante `quando`?" — perguntado ao
 * MOTOR, `decidirElegibilidade`, e não a uma comparação de datas reescrita aqui.
 * É o que o `inbound-turn`, o drain e o handoff consultam de verdade: uma cópia
 * da regra no teste ficaria verde no dia em que a produção mudasse.
 *
 * `modo: "open"` isola a variável — com o gate aberto, o ÚNICO motivo de
 * bloqueio possível é o silêncio que este módulo grava.
 */
function iaCaladaEm(ate: Date, quando: Date): boolean {
  const d = decidirElegibilidade({
    modo: "open",
    forceHuman: false,
    botSilencedUntil: normalizarInstante(ate.toISOString()),
    assigneeKind: null,
    aiAuthorizedAt: null,
    agora: quando,
    ttlMs: 21 * 24 * 60 * 60 * 1000,
  });
  return !d.permite && d.motivo === "conversa_silenciada";
}

describe("pausarIaPorAtendimentoManual — as duas pontas do prazo", () => {
  it("PONTA A: logo depois da fala humana, a conversa ESTÁ silenciada", async () => {
    const { admin, updates } = adminStub(null);
    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    expect(pausou).toBe(true);
    expect(updates).toHaveLength(1);
    // Um segundo depois da fala humana o motor ainda vê a conversa calada.
    const umSegundoDepois = new Date(T0.getTime() + 1000);
    expect(iaCaladaEm(silenciadaAte(updates[0]!), umSegundoDepois)).toBe(true);
  });

  it("PONTA B: passado o prazo, o silêncio ACABA e a IA volta sozinha", async () => {
    const { admin, updates } = adminStub(null);
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    const umSegundoAntesDeVencer = new Date(T0.getTime() + PRAZO_DO_SILENCIO_MS - 1000);
    const umSegundoDepoisDeVencer = new Date(T0.getTime() + PRAZO_DO_SILENCIO_MS + 1000);
    expect(iaCaladaEm(silenciadaAte(updates[0]!), umSegundoAntesDeVencer)).toBe(true);
    expect(iaCaladaEm(silenciadaAte(updates[0]!), umSegundoDepoisDeVencer)).toBe(false);
  });

  it("o prazo gravado é EXATAMENTE agora + PRAZO_DO_SILENCIO_MS — nunca 'infinity'", async () => {
    const { admin, updates } = adminStub(null);
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    expect(updates[0]!.bot_silenced_until).not.toBe("infinity");
    expect(silenciadaAte(updates[0]!).getTime()).toBe(T0.getTime() + PRAZO_DO_SILENCIO_MS);
  });
});

describe("pausarIaPorAtendimentoManual — cada fala humana RENOVA o prazo", () => {
  it("segunda mensagem 30 min depois empurra o vencimento para 30 min + o prazo", async () => {
    // Silêncio em vigor: gravado em T0, vence em T0 + PRAZO.
    const primeiroVencimento = new Date(T0.getTime() + PRAZO_DO_SILENCIO_MS);
    const trintaMinDepois = new Date(T0.getTime() + 30 * 60 * 1000);

    const { admin, updates } = adminStub(primeiroVencimento.toISOString());
    const renovou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: trintaMinDepois,
    });

    expect(renovou).toBe(true);
    expect(updates).toHaveLength(1);
    expect(silenciadaAte(updates[0]!).getTime()).toBe(
      trintaMinDepois.getTime() + PRAZO_DO_SILENCIO_MS,
    );
    // O que a renovação COMPRA: no instante em que o silêncio antigo venceria, a
    // conversa continua calada — a IA não volta no meio do atendimento humano.
    expect(iaCaladaEm(silenciadaAte(updates[0]!), primeiroVencimento)).toBe(true);
  });

  it("o rastro de handoff acompanha a renovação (last_handoff_at = a ÚLTIMA fala)", async () => {
    const trintaMinDepois = new Date(T0.getTime() + 30 * 60 * 1000);
    const { admin, updates } = adminStub(new Date(T0.getTime() + PRAZO_DO_SILENCIO_MS).toISOString());
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: trintaMinDepois,
    });

    expect(updates[0]!.last_handoff_at).toBe(trintaMinDepois.toISOString());
    expect(String(updates[0]!.last_handoff_reason)).toMatch(/Atendimento manual/);
  });
});

/**
 * Portado de `tests/unit/silenciar-bot-retomada-humana.test.ts`, que morreu junto
 * com `silenciarBotPorRetomadaHumana` quando os dois caminhos viraram um só. A
 * lacuna que aqueles casos guardam foi medida em produção (tenant YADEA): um
 * humano respondeu direto pelo WhatsApp, o bot não foi silenciado, e na mensagem
 * seguinte do lead voltou a rodar sozinho, alucinando sobre algo que só o humano
 * tinha tratado (PIX). A rede continua armada, agora em cima do helper novo.
 */
describe("pausarIaPorAtendimentoManual — nunca ENCURTA um silêncio maior", () => {
  it("'infinity' (handoff formal, alguém clicou em assumir) NUNCA é encurtado", async () => {
    const { admin, updates } = adminStub("infinity");
    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(pausou).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("janela mais longa já em vigor (ex.: 6h) não regride para o prazo padrão", async () => {
    const daquiA6h = new Date(T0.getTime() + 6 * 60 * 60 * 1000).toISOString();
    const { admin, updates } = adminStub(daquiA6h);
    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(pausou).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("silêncio já VENCIDO é estendido de novo (é o caso do dia seguinte)", async () => {
    const jaPassou = new Date(T0.getTime() - 60_000).toISOString();
    const { admin, updates } = adminStub(jaPassou);
    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(pausou).toBe(true);
    expect(silenciadaAte(updates[0]!).getTime()).toBe(T0.getTime() + PRAZO_DO_SILENCIO_MS);
  });
});

describe("pausarIaPorAtendimentoManual — o que NÃO grava, e o que não derruba", () => {
  it("NÃO toca ai_authorized_at / force_human / status / assignee_kind", async () => {
    const { admin, updates } = adminStub(null);
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    const patch = updates[0] ?? {};
    expect(patch).not.toHaveProperty("ai_authorized_at");
    expect(patch).not.toHaveProperty("ai_authorized_reason");
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
    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });
    expect(pausou).toBe(false);
  });

  it("falha de LEITURA não lança — best-effort, a ingestão não pode cair", async () => {
    const { admin, updates } = adminStub(null, { leitura: "boom" });
    await expect(
      pausarIaPorAtendimentoManual(admin, { organizationId: ORG, conversationId: CONV, agora: T0 }),
    ).resolves.toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("falha de ESCRITA não lança — best-effort, a ingestão não pode cair", async () => {
    const { admin } = adminStub(null, { escrita: "boom" });
    await expect(
      pausarIaPorAtendimentoManual(admin, { organizationId: ORG, conversationId: CONV, agora: T0 }),
    ).resolves.toBe(false);
  });
});
