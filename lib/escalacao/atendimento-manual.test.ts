import { describe, expect, it, vi } from "vitest";

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PRAZO_DO_SILENCIO_MS,
  pausarIaPorAtendimentoManual,
  pausarIaPorAtendimentoManualDetalhado,
  type FalhaDaPausa,
} from "./atendimento-manual";
import { decidirElegibilidade, normalizarInstante } from "@/lib/ai/elegibilidade/gate";
import { logger } from "@/lib/logger";

/**
 * Caminhos de ingestão descobertos em disco, sem dizer o nome de nenhum canal:
 * a cerca `lint:channels` proíbe nome de provider fora de `lib/channels/`, e um
 * teste não é exceção. Varre `lib/<x>/ingest.ts` e `lib/<x>/<y>/ingest.ts`.
 */
function arquivosDeIngestao(): string[] {
  const raiz = join(process.cwd(), "lib");
  const achados: string[] = [];
  const considerar = (rel: string) => {
    if (existsSync(join(raiz, rel))) achados.push(join("lib", rel));
  };
  for (const direto of readdirSync(raiz, { withFileTypes: true })) {
    if (!direto.isDirectory()) continue;
    considerar(join(direto.name, "ingest.ts"));
    for (const filho of readdirSync(join(raiz, direto.name), { withFileTypes: true })) {
      if (filho.isDirectory()) considerar(join(direto.name, filho.name, "ingest.ts"));
    }
  }
  return achados;
}

const ler = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

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
  linhasAfetadas = 1,
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
    // O UPDATE termina com `select("id")`: a resposta traz as LINHAS afetadas.
    // `linhasAfetadas: 0` simula o `error: null` que não tocou em nada — o caso
    // que fazia a função mentir.
    then: (r: (v: unknown) => unknown) =>
      Promise.resolve({
        data: falhas.escrita
          ? null
          : Array.from({ length: linhasAfetadas }, (_, i) => ({ id: `linha-${i}` })),
        error: falhas.escrita ? { message: falhas.escrita } : null,
      }).then(r),
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
    orgStatus: "active",
    canalDesativado: false,
    modo: "open",
    forceHuman: false,
    contatoInterno: false,
    // #3534: contato comum; a régua da equipe não participa deste isolamento.
    contatoDaEquipe: false,
    aiOptOut: false,
    botSilencedUntil: normalizarInstante(ate.toISOString()),
    assigneeKind: null,
    iaComDono: false,
    aiAuthorizedAt: null,
    preGoLiveAtivo: false,
    numeroDeTesteAutorizado: false,
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
 * lacuna que aqueles casos guardam foi medida em produção: um
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

/**
 * A pausa tem que ser OBSERVÁVEL (#534). O supabase-js devolve `error: null`
 * quando o UPDATE não casa com linha nenhuma (RLS, corrida com um DELETE). Sem
 * conferir as linhas afetadas, a função dizia "pausei" sem ter gravado.
 * A metade "não gravou": zero linhas → warn com rows 0 e `false`. A metade
 * "gravou", logo ao lado, garante que o caminho feliz segue devolvendo `true`.
 */
describe("pausarIaPorAtendimentoManual — a pausa precisa ser OBSERVÁVEL (#534)", () => {
  it("update sem linha afetada NÃO é pausa: warn com rows 0 e devolve false", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { admin, updates } = adminStub(null, {}, 0);
      const pausou = await pausarIaPorAtendimentoManual(admin, {
        organizationId: ORG,
        conversationId: CONV,
        agora: T0,
      });

      expect(pausou).toBe(false);
      // A tentativa de UPDATE aconteceu: a mentira nunca foi "não tentou", era
      // "não conferiu o que voltou". São DUAS desde o #534: zero linhas com a
      // conversa ainda presente é CORRIDA, e corrida ganha uma repetição.
      expect(updates).toHaveLength(2);
      expect(updates[1]).toEqual(updates[0]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("nenhuma linha afetada"),
        expect.objectContaining({ rows: 0 }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("uma linha afetada é pausa de verdade: grava e devolve true", async () => {
    const { admin, updates } = adminStub(null, {}, 1);
    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    expect(pausou).toBe(true);
    expect(updates).toHaveLength(1);
  });
});

/**
 * Dublê que separa as duas tabelas: `organizations` devolve o `settings` (ou
 * falha), `conversations` devolve a conversa sem silêncio e registra o UPDATE.
 */
function adminComAjuste(org: { settings?: unknown; erro?: string; lanca?: boolean }) {
  const updates: Array<Record<string, unknown>> = [];
  const conversa = {
    select: () => conversa,
    update: (patch: Record<string, unknown>) => {
      updates.push(patch);
      return conversa;
    },
    eq: () => conversa,
    maybeSingle: () => Promise.resolve({ data: { bot_silenced_until: null }, error: null }),
    // O UPDATE termina com `select("id")`: uma linha afetada é a pausa gravada.
    then: (r: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ id: CONV }], error: null }).then(r),
  };
  const organizacao = {
    select: () => organizacao,
    eq: () => organizacao,
    maybeSingle: () => {
      if (org.lanca) throw new Error("rede caiu");
      return Promise.resolve(
        org.erro
          ? { data: null, error: { message: org.erro } }
          : { data: { settings: org.settings ?? {} }, error: null },
      );
    },
  };
  const admin = {
    from: vi.fn((tabela: string) => (tabela === "organizations" ? organizacao : conversa)),
  } as never;
  return { admin, updates };
}

describe("pausarIaPorAtendimentoManual — o prazo é o da EMPRESA (#2005)", () => {
  it("empresa com 15 min grava agora + 15 min, e a IA volta depois disso", async () => {
    const { admin, updates } = adminComAjuste({
      settings: { routing: { manual_reply_silence_minutes: 15 } },
    });
    await pausarIaPorAtendimentoManual(admin, { organizationId: ORG, conversationId: CONV, agora: T0 });
    const ate = silenciadaAte(updates[0]!);
    expect(ate.getTime()).toBe(T0.getTime() + 15 * 60 * 1000);
    expect(iaCaladaEm(ate, new Date(T0.getTime() + 14 * 60 * 1000))).toBe(true);
    expect(iaCaladaEm(ate, new Date(T0.getTime() + 16 * 60 * 1000))).toBe(false);
  });

  it("empresa sem ajuste fica com o padrão de 60 min", async () => {
    const { admin, updates } = adminComAjuste({ settings: { routing: { mode: "manual" } } });
    await pausarIaPorAtendimentoManual(admin, { organizationId: ORG, conversationId: CONV, agora: T0 });
    expect(silenciadaAte(updates[0]!).getTime()).toBe(T0.getTime() + PRAZO_DO_SILENCIO_MS);
  });

  it("leitura do ajuste com ERRO não impede a pausa — vale o padrão", async () => {
    const { admin, updates } = adminComAjuste({ erro: "permission denied" });
    await expect(
      pausarIaPorAtendimentoManual(admin, { organizationId: ORG, conversationId: CONV, agora: T0 }),
    ).resolves.toBe(true);
    expect(silenciadaAte(updates[0]!).getTime()).toBe(T0.getTime() + PRAZO_DO_SILENCIO_MS);
  });

  it("leitura do ajuste que LANÇA não impede a pausa — vale o padrão", async () => {
    const { admin, updates } = adminComAjuste({ lanca: true });
    await expect(
      pausarIaPorAtendimentoManual(admin, { organizationId: ORG, conversationId: CONV, agora: T0 }),
    ).resolves.toBe(true);
    expect(silenciadaAte(updates[0]!).getTime()).toBe(T0.getTime() + PRAZO_DO_SILENCIO_MS);
  });

  it("pausa durável (#off) nem consulta o ajuste: grava 'infinity'", async () => {
    const { admin, updates } = adminComAjuste({
      settings: { routing: { manual_reply_silence_minutes: 15 } },
    });
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
      duravel: true,
    });
    expect(updates[0]!.bot_silenced_until).toBe("infinity");
    expect((admin as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalledWith(
      "organizations",
    );
  });
});

/**
 * #534 — a pausa precisa ser GARANTIDA, não só observada.
 *
 * Zero linhas tem DOIS motivos e eles pedem tratamentos opostos: corrida (a
 * linha existe, a escrita ainda não é visível — repetir UMA vez resolve) e
 * conversa inexistente/organização errada (repetir nunca resolve). O dublê
 * abaixo responde as duas perguntas que separam os casos — quantas linhas CADA
 * escrita afetou (`linhasPorEscrita`, consumido em ordem) e se a conversa existe
 * em cada leitura (`existencia`, idem) —, e é o mínimo para provar a distinção
 * sem banco.
 */
function adminComCorrida(opts: { linhasPorEscrita: number[]; existencia?: boolean[] }) {
  const updates: Array<Record<string, unknown>> = [];
  /** Só as leituras de `conversations` — a de `organizations` é outra pergunta. */
  const leituras: number[] = [];
  let escrita = 0;
  const chain = {
    select: () => chain,
    update: (patch: Record<string, unknown>) => {
      updates.push(patch);
      return chain;
    },
    eq: () => chain,
    maybeSingle: () => {
      leituras.push(1);
      const existe = opts.existencia?.[leituras.length - 1] ?? true;
      return Promise.resolve({
        data: existe ? { bot_silenced_until: null } : null,
        error: null,
      });
    },
    // O UPDATE termina com `select("id")`: a resposta traz as LINHAS afetadas.
    then: (r: (v: unknown) => unknown) => {
      const linhas = opts.linhasPorEscrita[escrita++] ?? 0;
      return Promise.resolve({
        data: Array.from({ length: linhas }, (_, i) => ({ id: `linha-${i}` })),
        error: null,
      }).then(r);
    },
  };
  // `prazoDoSilencioDaEmpresaMs` também faz um `maybeSingle` — em `organizations`.
  const organizacao = {
    select: () => organizacao,
    eq: () => organizacao,
    maybeSingle: () => Promise.resolve({ data: { settings: {} }, error: null }),
  };
  const admin = {
    from: vi.fn((tabela: string) => (tabela === "organizations" ? organizacao : chain)),
  } as never;
  return { admin, updates, leituras };
}

describe("pausarIaPorAtendimentoManualDetalhado — 0 linhas: corrida × conversa inexistente (#534)", () => {
  it("(a) 0 linhas e sucesso na repetição: pausa GRAVADA com UMA nova escrita", async () => {
    const { admin, updates, leituras } = adminComCorrida({ linhasPorEscrita: [0, 1] });

    const resultado = await pausarIaPorAtendimentoManualDetalhado(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    expect(resultado).toEqual({ pausada: true, gravada: true });
    // Duas escritas no total: a que não casou e a repetição. Nada além disso.
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual(updates[0]);
    // Leitura inicial + releitura que separou corrida de inexistente.
    expect(leituras).toHaveLength(2);
  });

  it("(b) 0 linhas DUAS vezes com a conversa existente: falha com o motivo da CORRIDA", async () => {
    const { admin, updates } = adminComCorrida({ linhasPorEscrita: [0, 0] });

    const resultado = await pausarIaPorAtendimentoManualDetalhado(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    expect(resultado).toEqual({ pausada: false, motivo: "corrida_persistente" });
    // Repetiu UMA vez e parou: nada de laço.
    expect(updates).toHaveLength(2);
  });

  it("(c) conversa inexistente: motivo próprio, SEM repetir a escrita", async () => {
    const { admin, updates, leituras } = adminComCorrida({
      linhasPorEscrita: [],
      existencia: [false, false],
    });

    const resultado = await pausarIaPorAtendimentoManualDetalhado(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    expect(resultado).toEqual({ pausada: false, motivo: "conversa_inexistente" });
    // Nenhuma escrita: repetir nunca resolveria organização errada.
    expect(updates).toHaveLength(0);
    // A releitura que decidiu aconteceu.
    expect(leituras).toHaveLength(2);
  });

  it("(f) leitura não achou e a RELEITURA achou: é corrida de leitura, grava UMA vez", async () => {
    const { admin, updates } = adminComCorrida({
      linhasPorEscrita: [1],
      existencia: [false, true],
    });

    const resultado = await pausarIaPorAtendimentoManualDetalhado(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
    });

    expect(resultado).toEqual({ pausada: true, gravada: true });
    expect(updates).toHaveLength(1);
  });

  it("(d) o chamador que recebe falha NÃO segue como se a IA estivesse pausada", async () => {
    const avisos: FalhaDaPausa[] = [];
    const { admin } = adminComCorrida({ linhasPorEscrita: [0, 0] });

    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      canal: "teste",
      agora: T0,
      avisar: (falha) => {
        avisos.push(falha);
      },
    });

    expect(pausou).toBe(false);
    // O aviso é a porta que impede o `false` anônimo de virar "segue o baile".
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      organizationId: ORG,
      conversationId: CONV,
      canal: "teste",
      motivo: "corrida_persistente",
    });
  });

  it("(d2) conversa inexistente também avisa, com o motivo PRÓPRIO", async () => {
    const avisos: FalhaDaPausa[] = [];
    const { admin } = adminComCorrida({ linhasPorEscrita: [], existencia: [false, false] });

    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
      avisar: (falha) => {
        avisos.push(falha);
      },
    });

    expect(pausou).toBe(false);
    expect(avisos.map((a) => a.motivo)).toEqual(["conversa_inexistente"]);
  });

  it("(d3) no caminho feliz NÃO há aviso — aviso é sinal de falha, não ruído", async () => {
    const avisos: FalhaDaPausa[] = [];
    const { admin } = adminComCorrida({ linhasPorEscrita: [1] });

    const pausou = await pausarIaPorAtendimentoManual(admin, {
      organizationId: ORG,
      conversationId: CONV,
      agora: T0,
      avisar: (falha) => {
        avisos.push(falha);
      },
    });

    expect(pausou).toBe(true);
    expect(avisos).toHaveLength(0);
  });

  /**
   * O conserto só vale se os chamadores REAIS passarem pela porta que não engole
   * a falha. Este caso lê os pontos de chamada da ingestão: nenhum pode voltar
   * ao atalho booleano, e todos têm de ter o aviso durável no `audit`.
   */
  it("(d4) TODA chamada da ingestão passa um aviso — nenhuma engole o false", () => {
    // Descoberta em tempo de execução, de propósito: nomear o caminho de um canal
    // aqui escreveria o nome do provider fora de lib/channels/ e a cerca
    // `lint:channels` (doutrina restricao-de-canal, invariante 1) reprova — com razão.
    // Varrendo o diretório, a prova também passa a cobrir canal novo sem editar o teste.
    const comPausa = arquivosDeIngestao().filter((rel) =>
      /pausarIa(PorAtendimentoManual|Duravelmente)\(/.test(ler(rel)),
    );
    expect(comPausa.length, "nenhum ponto de chamada encontrado na ingestão").toBeGreaterThanOrEqual(3);
    for (const rel of comPausa) {
      const texto = ler(rel);
      const chamadas = texto.match(/pausarIa(PorAtendimentoManual|Duravelmente)\(/g) ?? [];
      const avisos = texto.match(/avisar:/g) ?? [];
      expect(chamadas.length, `${rel} não chama a pausa?`).toBeGreaterThan(0);
      // Uma chamada sem `avisar` é uma falha da pausa que ninguém vê.
      expect(avisos.length, `${rel}: chamada de pausa sem aviso`).toBe(chamadas.length);
      // O aviso é durável: audit, não log.
      expect(texto, rel).toContain("ai.pausa_nao_gravada");
    }
  });
});

