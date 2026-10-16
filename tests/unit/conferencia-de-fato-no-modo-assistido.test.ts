/**
 * #2923 — A CONFERÊNCIA DE FATO NO MODO ASSISTIDO.
 *
 * O sintoma medido pelo relator: 533 rascunhos gerados e ZERO linhas de
 * `afirmacao_de_fato` em `jev_observacoes`. A causa: o conferidor era criado e
 * repassado num só lugar (o envio do turno automático), e os dois caminhos do
 * modo assistido — a PRÉVIA e a RESPOSTA APROVADA — não o recebiam.
 *
 * O que estas provas fixam:
 *
 *  1. Na PRÉVIA, o veredito ATRAVESSA até o `evaluateBeforeSend` (a camada 6.3
 *     deixa de ser decorativa no trace) e a observação VAI para
 *     `jev_observacoes` com o par em ABERTO (`rotulo_atual` nulo) e o ponteiro
 *     do rascunho (`job_id`) — o dado que faltava para o cartão calibrar.
 *  2. Em "só observa" — o único estado desta versão, ver `soObserva` em
 *     `lib/ai/decisao/tarefas.ts` — isso GRAVA e NÃO IMPEDE, como a issue pede
 *     ("em só observa, grava a observação e não impede"): a resposta continua na
 *     tela de quem revisa.
 *  3. Quando a conferência tem estado para decidir, o `contradiz` VETA: na prévia
 *     do rascunho é IMPEDIMENTO visível na tela (como os outros vetos da prévia);
 *     no sandbox ("Testar") é AVISO, como o embargo de pacing (`gatesDoSandbox`).
 *  4. Na RESPOSTA APROVADA não se confere de novo — o texto já foi revisado por
 *     uma pessoa. Só se FECHA o par que a prévia deixou: o `rotulo_atual` de quem
 *     saiu de verdade, para a concordância do cartão do Jev contar o modo
 *     assistido.
 *
 * O estado "para decidir" é montado com um conferidor de DUBLÊ porque o
 * `estadoEfetivoDaTarefa` desta versão não deixa a tarefa chegar a `decidindo`
 * (`soObserva`): o que estas provas exercitam é a FIAÇÃO, que é o que a issue
 * conserta — o gate está armado, e o dia em que o "decidir" for ligado ele já
 * encontra o veredito no contexto.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SupabaseClient } from "@supabase/supabase-js";

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  applyPreviewPolicy,
  newPreviewResult,
  scenarioContext,
  type TurnPreview,
} from "@/lib/agent-engine/agent/preview";
import type { ConferenciaDeFato } from "@/lib/agent-engine/guardrails/factual-claim";
import type { GateContext } from "@/lib/agent-engine/guardrails/before-send";
import type { EvidenciaComercial } from "@/lib/agent-engine/guardrails/promise/evidencias-comerciais";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import {
  criarConferidorDeAfirmacoes,
  registrarEnvioDaRespostaAprovada,
} from "@/lib/ai/decisao/afirmacao-de-fato";
import { TAREFA_DA_AFIRMACAO_DE_FATO } from "@/lib/ai/decisao/tarefas";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACEITANTE = "22222222-2222-4222-8222-222222222222";
/** O id do RASCUNHO: na prévia do modo assistido é ele que viaja como `runId`. */
const RASCUNHO = "44444444-4444-4444-8444-444444444444";
const ACEITE = { em: "2026-09-01T12:00:00.000Z", por: ACEITANTE };
/** Meio-dia em São Paulo, dentro da janela — o pacing não interfere no teste. */
const DIA = new Date("2026-10-04T15:00:00Z");

/** A pousada fictícia: check-in 14h e SEM piscina. */
const EVIDENCIAS: readonly EvidenciaComercial[] = [
  {
    origem: "conhecimento",
    referencia: "faq:checkin",
    titulo: "Check-in e estrutura",
    conteudo: "Check-in a partir das 14:00. A pousada não possui piscina.",
  },
];

/** "O check-in é a partir das 12h." contra a base que diz 14:00: contradiz. */
const CONTRADIZ = { claim_0: 0.9, supported_0: 0.1, contradicts_0: 0.95 };
const CANDIDATA = "O check-in é a partir das 12h.";

/** Liga a tarefa como ela nasce: `observando` (o `soObserva` a mantém aí). */
const LIGADO = { jev: { ligado: true, aceite: ACEITE } };
/** O interruptor mestre desligado. */
const DESLIGADO = { jev: { ligado: false } };

interface FalsoBanco {
  inseridas: Record<string, unknown[]>;
  atualizadas: Array<{
    tabela: string;
    valores: Record<string, unknown>;
    filtros: Array<[string, unknown]>;
  }>;
  settings: unknown;
}

/** O admin falso: só o que estes caminhos tocam — settings, insert e update. */
function adminFalso(f: FalsoBanco): SupabaseClient {
  const de = (tabela: string) => {
    const filtros: Array<[string, unknown]> = [];
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.order = () => c;
    c.limit = () => c;
    c.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return c;
    };
    c.is = async (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return { data: null, error: null };
    };
    c.maybeSingle = async () => ({
      data:
        tabela === "organizations" ? (f.settings === null ? null : { settings: f.settings }) : null,
      error: null,
    });
    c.insert = (linhas: unknown) => {
      const lista = Array.isArray(linhas) ? linhas : [linhas];
      f.inseridas[tabela] = [...(f.inseridas[tabela] ?? []), ...lista];
      return Promise.resolve({ data: null, error: null });
    };
    c.update = (valores: Record<string, unknown>) => {
      f.atualizadas.push({ tabela, valores, filtros });
      return c;
    };
    return c;
  };
  return { from: (tabela: string) => de(tabela) } as unknown as SupabaseClient;
}

function banco(settings: unknown): FalsoBanco {
  return { inseridas: {}, atualizadas: [], settings };
}

/** O dublê do Jev: devolve `noul` por pergunta e guarda os estados enviados. */
function fetchCom(respostas: Record<string, number>) {
  const chamadas: Array<{ state: unknown; questions: string[] }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const corpo = JSON.parse(String(init?.body)) as {
      state: Record<string, unknown>;
      questions: Record<string, unknown>;
    };
    chamadas.push({ state: corpo.state, questions: Object.keys(corpo.questions) });
    const answers = Object.fromEntries(
      Object.keys(corpo.questions).map((id) => [id, { type: "noul", noul: respostas[id] ?? 0.5 }]),
    );
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers,
        usage: { input_tokens: 1800, output_tokens: 0 },
      }),
      { status: 200 },
    );
  });
  return { fetchImpl, chamadas };
}

const DEPS = { buscarChave: async () => "chave-de-teste" };

/** O conferidor da PRÉVIA: mesma fábrica do turno, com o ponteiro do rascunho. */
function conferidorDaPrevia(settings: unknown, respostas: Record<string, number>) {
  const f = banco(settings);
  const fetch = fetchCom(respostas);
  const conferir = criarConferidorDeAfirmacoes(
    adminFalso(f),
    {
      organizationId: ORG,
      conversationId: null,
      contactId: null,
      agentId: null,
      lerEvidencias: () => EVIDENCIAS,
      runId: RASCUNHO,
      // A PRÉVIA: o rascunho ainda NÃO saiu — o par nasce aberto de propósito.
      rotuloAtual: null,
    },
    { ...DEPS, fetchImpl: fetch.fetchImpl },
  );
  return { f, fetch, conferir };
}

/** Um conferidor de dublê com o veredito na mão — o estado que a org não alcança. */
function conferidorCom(
  conferencia: Partial<ConferenciaDeFato>,
): (c: string) => Promise<ConferenciaDeFato> {
  return async () => ({
    estado: "decidindo",
    veredito: "contradiz",
    frase: CANDIDATA,
    quantidadeDeFrases: 1,
    pediu: true,
    ...conferencia,
  });
}

const definicao = (executar: (args: unknown) => unknown) =>
  tool({
    inputSchema: z.object({ body: z.string().optional() }).passthrough(),
    execute: async (args) => executar(args),
  });

type FerramentasDaPrevia = ReturnType<typeof applyPreviewPolicy>;

async function chamar(
  tools: FerramentasDaPrevia,
  nome: string,
  args: unknown = {},
): Promise<unknown> {
  return tools[nome]!.execute!(args, { toolCallId: "t", messages: [], context: undefined });
}

function contextoDoTurno(over: Partial<GateContext> = {}): GateContext {
  return {
    now: DIA,
    body: "",
    optedOut: false,
    provider: DEFAULT_CHANNEL_PROVIDER,
    messagingWindow: { lastInboundAt: DIA },
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: true, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    internalVocabularyEnforced: true,
    ...over,
  };
}

/** A prévia com a conferência ligada — como `inbound-turn.ts` a monta agora. */
async function previaComConferidor(
  kind: TurnPreview["kind"],
  conferir: (c: string) => Promise<ConferenciaDeFato>,
): Promise<{ p: TurnPreview; tools: FerramentasDaPrevia; retorno: unknown }> {
  const p = previaDoRascunho(kind);
  const tools = applyPreviewPolicy(
    { send_message: definicao(vi.fn()) },
    p,
    contextoDoTurno(),
    () => [],
    undefined,
    undefined,
    undefined,
    conferir,
  );
  const retorno = await chamar(tools, "send_message", { body: CANDIDATA });
  return { p, tools, retorno };
}

function previaDoRascunho(kind: TurnPreview["kind"]): TurnPreview {
  return {
    kind,
    organizationId: ORG,
    runId: RASCUNHO,
    contactId: kind === "assisted" ? "contato-real" : null,
    channelId: null,
    agent: {} as TurnPreview["agent"],
    context: scenarioContext([]),
    result: newPreviewResult(),
  };
}

function linhaDaAfirmacao(f: FalsoBanco): Record<string, unknown> | undefined {
  return (f.inseridas.jev_observacoes ?? [])[0] as Record<string, unknown> | undefined;
}

function rastro(f: TurnPreview, gate: string) {
  return f.result.candidates[0]?.trace.find((t) => t.gate === gate);
}

describe("PRÉVIA do modo assistido #2923", () => {
  it("grava a observação com o par em ABERTO e o ponteiro do rascunho", async () => {
    const { f, fetch, conferir } = conferidorDaPrevia(LIGADO, CONTRADIZ);
    const { p } = await previaComConferidor("assisted", conferir);

    // A linha que faltava nas 533 gerações medidas pelo relator.
    const linha = linhaDaAfirmacao(f);
    expect(linha?.tarefa).toBe(TAREFA_DA_AFIRMACAO_DE_FATO.id);
    expect(linha?.estado).toBe("observando");
    expect(linha?.rotulo_jev).toBe("vetado_contradicao");
    // O ponteiro do RUN que mediu — o rascunho, e não o job (não há job na prévia).
    expect(linha?.job_id).toBe(RASCUNHO);
    // O par nasce ABERTO: quem fecha é a resposta aprovada, quando o texto sair.
    expect(linha?.rotulo_atual).toBeNull();
    // Nada de texto: a observação é rótulo e ponteiro (0421).
    expect(JSON.stringify(linha)).not.toContain("12h");
    // A pergunta saiu de verdade (uma só) e virou linha de custo.
    expect(fetch.chamadas).toHaveLength(1);
    expect(f.inseridas.llm_calls).toHaveLength(1);
    // A evidência do turno foi a que o agente consultou — e SÓ a estrutura dela.
    expect(fetch.chamadas[0]!.questions).toEqual(["claim_0", "supported_0", "contradicts_0"]);
    expect(JSON.stringify(fetch.chamadas[0]!.state)).toContain("14:00");
    expect(JSON.stringify(fetch.chamadas[0]!.state)).not.toContain(ORG);

    // E "em só observa grava e NÃO IMPEDE": a resposta segue na tela.
    expect(p.result.impediments).toEqual([]);
    expect(p.result.candidates.map((c) => c.body)).toEqual([CANDIDATA]);
  });

  it("o veredito ATRAVESSA até o evaluateBeforeSend (o trace o denuncia)", async () => {
    // Sem a fiação o contexto da prévia chega sem `factualClaim` e a camada 6.3
    // passa como `pass` — indistinguível de "não avaliada". Com ela, o motivo da
    // não-conferência aparece no trace, que é o mesmo sinal que a produção usa.
    const { p } = await previaComConferidor(
      "assisted",
      conferidorCom({ estado: "nao_conferida", veredito: "nao_conferido", motivo: "sem_evidencia" }),
    );
    expect(rastro(p, "factual_claim")).toEqual({
      gate: "factual_claim",
      verdict: "skipped",
      code: "nao_conferido",
    });
  });

  it("decidindo: um contradiz vira IMPEDIMENTO visível, como os outros vetos", async () => {
    const { p, retorno } = await previaComConferidor("assisted", conferidorCom({}));

    expect(p.result.impediments.map((i) => i.code)).toEqual(["factual_claim_contradicted"]);
    // O veto vence o candidato: na tela isso é o rascunho não sair — VISÍVEL, e
    // não o silêncio de antes (a camada nem era avaliada). Sem candidato não há
    // trace; o que a tela mostra é o próprio impedimento.
    expect(p.result.candidates).toEqual([]);
    expect(p.result.impediments[0]!.message).toMatch(/não envie esta afirmação/i);
    // O erro de ensino volta AO MODELO com a frase (é ele que reescreve).
    expect(retorno).toMatchObject({ ok: false, error: { code: "factual_claim_contradicted" } });
    expect(String((retorno as { error: { message: string } }).error.message)).toContain(CANDIDATA);
  });

  it("desligada: nada muda — zero requisição, zero linha, nenhum impedimento", async () => {
    const { f, fetch, conferir } = conferidorDaPrevia(DESLIGADO, CONTRADIZ);
    const { p } = await previaComConferidor("assisted", conferir);

    expect(fetch.chamadas).toEqual([]);
    expect(linhaDaAfirmacao(f)).toBeUndefined();
    expect(f.inseridas.llm_calls).toBeUndefined();
    expect(p.result.impediments).toEqual([]);
    expect(p.result.candidates.map((c) => c.body)).toEqual([CANDIDATA]);
    // O gate EXISTE e sabe que não conferiu (não é "pass" silencioso).
    expect(rastro(p, "factual_claim")).toEqual({
      gate: "factual_claim",
      verdict: "skipped",
      code: "nao_conferido",
    });
  });
});

describe("SANDBOX (Testar) #2923", () => {
  it("decidindo: o mesmo contradiz vira AVISO, e a resposta fica na tela", async () => {
    const { p } = await previaComConferidor("sandbox", conferidorCom({}));

    expect(p.result.impediments).toEqual([]);
    expect(p.result.candidates.map((c) => c.body)).toEqual([CANDIDATA]);
    expect(p.result.warnings.map((w) => w.code)).toEqual(["factual_claim_contradicted"]);
    const aviso = p.result.warnings[0]!.message;
    expect(aviso).toMatch(/não sairia agora/);
    expect(aviso).toMatch(/nenhuma mensagem foi enviada/i);
    // Nunca um "pass" silencioso: o trace diz que a camada foi REBAIXADA.
    expect(rastro(p, "factual_claim")).toEqual({
      gate: "factual_claim",
      verdict: "skipped",
      code: "sandbox_send_embargo",
    });
  });

  it("desligada: o Testar não ganha aviso nenhum", async () => {
    const { conferir } = conferidorDaPrevia(DESLIGADO, CONTRADIZ);
    const { p } = await previaComConferidor("sandbox", conferir);
    expect(p.result.warnings).toEqual([]);
    expect(p.result.candidates).toHaveLength(1);
  });
});

describe("RESPOSTA APROVADA #2923", () => {
  it("fecha SÓ o par do rascunho que saiu — e nunca confere de novo", async () => {
    const f = banco(LIGADO);
    await registrarEnvioDaRespostaAprovada(adminFalso(f), {
      organizationId: ORG,
      runId: RASCUNHO,
    });

    const escrita = f.atualizadas.find((a) => a.tabela === "jev_observacoes");
    expect(escrita?.valores).toEqual({ rotulo_atual: "enviado" });
    // O filtro inteiro: a empresa, a tarefa, o rascunho E o "ainda sem par" —
    // a aprovação de um rascunho não pode fechar a linha de outro, nem reescrever
    // uma que já saiu (retry do job).
    expect(escrita?.filtros).toEqual([
      ["organization_id", ORG],
      ["tarefa", TAREFA_DA_AFIRMACAO_DE_FATO.id],
      ["job_id", RASCUNHO],
      ["rotulo_atual", null],
    ]);
    // Nada de inserir observação nova: quem grava é a conferência da PRÉVIA.
    expect(f.inseridas.jev_observacoes).toBeUndefined();
  });

  it("o handler da resposta aprovada registra e NÃO veta (fonte)", () => {
    const fonte = readFileSync(
      join(process.cwd(), "lib/agent-engine/agent/approved-reply.ts"),
      "utf8",
    );
    // A fiação existe: o registro sai pelo client de admin, como em inbound-turn.
    expect(fonte).toContain("registrarEnvioDaRespostaAprovada(createAdminClient()");
    // E NÃO confere de novo: nenhum conferidor entra no `runBeforeSend` daqui —
    // o texto já foi revisado por uma pessoa, e vetá-lo devolveria ao modelo um
    // texto que não é dele.
    expect(fonte).not.toContain("conferirAfirmacoes");
  });
});

describe("TURNO AUTOMÁTICO segue igual #2923", () => {
  it("sem `rotuloAtual`, a linha nasce com o par FECHADO e sem ponteiro", async () => {
    const f = banco(LIGADO);
    const fetch = fetchCom(CONTRADIZ);
    const conferir = criarConferidorDeAfirmacoes(
      adminFalso(f),
      {
        organizationId: ORG,
        conversationId: null,
        contactId: null,
        agentId: null,
        lerEvidencias: () => EVIDENCIAS,
      },
      { ...DEPS, fetchImpl: fetch.fetchImpl },
    );
    const r = await conferir(CANDIDATA);

    expect(r.veredito).toBe("contradiz");
    const linha = linhaDaAfirmacao(f);
    expect(linha?.rotulo_atual).toBe("enviado");
    expect(linha?.job_id).toBeNull();
  });
});
