/**
 * O PEDIDO DE PARAR DE RECEBER (E DE FALAR COM UMA PESSOA) DITO EM ÁUDIO (#2233).
 *
 * Um áudio sem legenda chega com `body` vazio, e é a transcrição que o worker
 * de mídia grava DEPOIS. Os dois caminhos que decidem sobre o pedido olhavam o
 * corpo da `message.received` — vazio —, e o que grava `is_blocked` roda na
 * ingestão, antes de existir texto nenhum. Resultado medido na issue: o
 * pedido falado não dispara regra nenhuma, e a próxima campanha alcança o
 * contato.
 *
 * Estes casos cobrem o critério de aceite da issue, ponta a ponta pelo worker
 * real (`deriveMessageMedia`, que é quem tem a transcrição na mão):
 *
 *  1. a REGRA reconhece o pedido na transcrição → aviso de parar de receber
 *     aberto, SEM `is_blocked`, mesmo com a tarefa do Jev DESLIGADA;
 *  2. a regra não reconhece → o Jev é perguntado (cascata da onda 3, só onde
 *     ela disse não) e o aviso dele abre;
 *  3. controle: "tem como parar a dor?" transcrito → nada, o caso clássico de
 *     `lib/opt-out/deteccao.ts`;
 *  4. áudio do ATENDENTE não é pedido nenhum;
 *  5. credencial ausente → ZERO linha em `llm_calls`;
 *  6. mensagem já anonimizada → a transcrição nem é gravada, e nada abre.
 *
 * E o não-regressão que a política pede: em NENHUM caso a transcrição vira
 * escrita em `contacts`, `conversations` ou `messages` — o único efeito é o
 * aviso na Central. A frase digitada continua bloqueando pela ingestão, que
 * este PR não toca (`tests/unit/pos-entrada-*.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { decidirNoPontoMock, reagirMock } = vi.hoisted(() => ({
  decidirNoPontoMock: vi.fn(),
  reagirMock: vi.fn(async () => undefined),
}));
/** A transcrição de cada caso, lida pelo dublê da derivação no momento da chamada. */
const H = vi.hoisted(() => ({ transcricao: "" }));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => criarAdmin() }));
vi.mock("@/lib/escalacao/handoff-tecnico", () => ({ reagirAConclusaoDeDerivacao: reagirMock }));
vi.mock("@/lib/messaging/media/derive", () => ({ deriveMediaText: vi.fn(async () => H.transcricao) }));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    origemDaChave: "credencial_da_organizacao",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
    baseUrl: null,
    apiKey: "chave-de-teste",
  })),
}));
// O pool só serve às leituras do turno (mensagens sem resposta, quem atende o
// número, a pessoa com o contato, as palavras de passagem): devolver linha
// nenhuma deixa o conjunto da rajada só com a transcrição, que a cola do Jev
// acrescenta por fora — é exatamente o que se quer medir aqui.
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: async () => ({ rows: [] }) }),
}));
vi.mock("@/lib/agent-engine/agent/human-handoff", async (orig) => ({
  ...(await orig()),
  isLeadInHandoff: vi.fn(async () => false),
}));
vi.mock("@/lib/ai/agents/quem-atende-a-sessao", async (orig) => ({
  ...(await orig()),
  haQuemAtendaASessao: vi.fn(async () => true),
  palavrasDeQuemPodeAtender: vi.fn(async () => []),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => ({
    permite: true,
    motivo: "autorizado",
    bloqueioPorAllowlist: false,
  })),
}));
vi.mock("@/lib/ai/decisao/ponto", async (orig) => ({
  ...(await orig()),
  decidirNoPonto: decidirNoPontoMock,
}));

import { logger } from "@/lib/logger";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";

import { deriveMessageMedia } from "@/workers/media-derive-worker";

type Linha = Record<string, unknown>;

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";
const CONT = "66666666-6666-4666-8666-666666666666";
const SESS = "77777777-7777-4777-8777-777777777777";

let mensagem: Linha = {};
let conversa: Linha = {};
let organizacao: Linha = {};
let contato: Linha = {};
let inserts: Array<{ tabela: string; linha: Linha }> = [];
let updates: Array<{ tabela: string; patch: Linha }> = [];

const de = (tabela: string): Linha[] => inserts.filter((i) => i.tabela === tabela).map((i) => i.linha);
const alteracoesDe = (tabela: string): Linha[] => updates.filter((u) => u.tabela === tabela).map((u) => u.patch);
const avisos = (): Linha[] => de("agent_inbox_items");

function baseDaTabela(tabela: string): Linha[] {
  if (tabela === "messages") return [mensagem];
  if (tabela === "conversations") return [conversa];
  if (tabela === "organizations") return [organizacao];
  if (tabela === "contacts") return [contato];
  return [];
}

/** Banco de brinquedo no formato do supabase-js: filtra, grava e conta. */
function criarAdmin(): unknown {
  const from = (tabela: string) => {
    const eqs: Array<[string, unknown]> = [];
    const operadores: Array<[string, string, unknown]> = [];
    let limite: number | null = null;

    const linhas = (): Linha[] => {
      let ls = baseDaTabela(tabela);
      for (const [coluna, valor] of eqs) ls = ls.filter((l) => l[coluna] === valor);
      for (const [coluna, operador, valor] of operadores) {
        ls = ls.filter((l) => (operador === "isdistinct" ? l[coluna] !== valor : l[coluna] === valor));
      }
      return limite === null ? ls : ls.slice(0, limite);
    };

    const terminais: Record<string, unknown> = {
      select: () => cadeia,
      eq: (coluna: string, valor: unknown) => {
        eqs.push([coluna, valor]);
        return cadeia;
      },
      is: (coluna: string, valor: unknown) => {
        eqs.push([coluna, valor]);
        return cadeia;
      },
      filter: (coluna: string, operador: string, valor: unknown) => {
        operadores.push([coluna, operador, valor]);
        return cadeia;
      },
      limit: (n: number) => {
        limite = n;
        return cadeia;
      },
      insert: (linha: Linha | Linha[]) => {
        for (const l of Array.isArray(linha) ? linha : [linha]) inserts.push({ tabela, linha: l });
        return Promise.resolve({ error: null });
      },
      update: (patch: Linha) => {
        updates.push({ tabela, patch });
        return cadeia;
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      single: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(ok, falha),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cadeia: any = new Proxy(terminais, {
      get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => cadeia),
    });
    return cadeia;
  };

  return {
    from,
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }),
      }),
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function eventRow() {
  return {
    id: "ev1",
    organization_id: ORG,
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

/** Jev ligado, com a tarefa escolhida em "Avisar a equipe" (`decidindo`).
 *
 * A OUTRA tarefa é `desligada` de propósito, e não folga: sem estado gravado
 * ela herda o `modo` da onda 1 (`observacao` → `observando`), que também
 * pergunta — e aqui o que se mede é a cascata sobre UM pedido.
 */
function jevAvisando(tarefas: Record<string, unknown>): Record<string, unknown> {
  return {
    jev: {
      ligado: true,
      aceite: { em: "2026-09-26T12:00:00.000Z", por: "88888888-8888-4888-8888-888888888888", alcance: "mensagem" },
      tarefas: { humano: { estado: "desligada" }, ...tarefas },
    },
  };
}

/** O Jev responde a TODA pergunta feita com esta probabilidade. */
function jevResponde(noul: number): void {
  decidirNoPontoMock.mockImplementation(async (_entrada: unknown, _deps?: unknown) => ({
    ok: true,
    respostas: { humano: { tipo: "noul", noul }, opt_out: { tipo: "noul", noul } },
    modelo: "jev-de-teste",
    latenciaMs: 4,
    uso: { tokensDeEntrada: 200, tokensDeSaida: 3 },
  }));
}

/** O que NUNCA pode conter a transcrição: log, gravados na Central e custos.
 *
 * De fora vai SÓ a gravação da própria transcrição em `messages` — é o que a
 * derivação existia para fazer, e o que a LGPD cobre no seu canto (#1991).
 */
function vazouATranscricao(transcricao: string): boolean {
  const tudo = JSON.stringify({
    inserts,
    updates: updates.filter((u) => u.tabela !== "messages"),
    logs: {
      info: (logger.info as ReturnType<typeof vi.fn>).mock.calls,
      warn: (logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      error: (logger.error as ReturnType<typeof vi.fn>).mock.calls,
    },
  });
  return tudo.includes(transcricao);
}

beforeEach(() => {
  vi.clearAllMocks();
  H.transcricao = "";
  inserts = [];
  updates = [];
  mensagem = {
    id: "msg1",
    organization_id: ORG,
    conversation_id: CONV,
    body: null,
    direction: "inbound",
    sent_via: "crm",
    type: "audio",
    media_mime: "audio/ogg",
    media_storage_path: "org1/conv1/msg1.ogg",
    media_derived_status: null,
    metadata: null,
    created_at: "2026-10-03T21:00:00.000Z",
  };
  conversa = {
    id: CONV,
    organization_id: ORG,
    contact_id: CONT,
    channel_session_id: SESS,
    is_group: false,
    active_ai_agent_id: null,
    status: "pending",
    assigned_to_user_id: null,
    bot_silenced_until: null,
    last_handoff_at: null,
  };
  organizacao = { id: ORG, locale: "pt-BR", settings: {} };
  contato = { id: CONT, organization_id: ORG, is_blocked: false };
});

describe("o pedido ditado em áudio (#2233)", () => {
  it("a regra reconhece o pedido na transcrição: abre o aviso, com a tarefa DESLIGADA, e não bloqueia", async () => {
    H.transcricao = "não quero mais receber mensagem nenhuma de vocês";

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    expect(
      decidirNoPontoMock,
      "a tarefa do Jev está desligada: quem decide aqui é a regra de hoje",
    ).not.toHaveBeenCalled();
    expect(avisos(), "um aviso por conversa e pedido, com o kind do #1747").toHaveLength(1);
    expect(avisos()[0]).toMatchObject({
      kind: "jev_parar_de_receber",
      severity: "warn",
      ref_kind: "conversation",
      ref_id: CONV,
      organization_id: ORG,
    });
    expect(String(avisos()[0]!.title)).toContain("parar de receber");
    expect(alteracoesDe("contacts"), "sobre o transcrito nada é bloqueado").toEqual([]);
    expect(de("contacts"), "sobre o transcrito nada é bloqueado").toEqual([]);
    expect(de("llm_calls"), "sem chamada não há custo nenhum").toEqual([]);
    expect(de("jev_observacoes")).toEqual([]);
    expect(vazouATranscricao(H.transcricao), "a transcrição não vaza em log nem na Central").toBe(false);
  });

  it("a regra não reconhece: o Jev é perguntado (só onde ela disse não) e o aviso dele abre", async () => {
    H.transcricao = "pode tirar meu número daí, por favor";
    organizacao.settings = jevAvisando({ opt_out: { estado: "decidindo" } });
    jevResponde(0.95);

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    expect(decidirNoPontoMock).toHaveBeenCalledTimes(1);
    const perguntas = (decidirNoPontoMock.mock.calls[0]![0] as { perguntas: Record<string, unknown> }).perguntas;
    expect(Object.keys(perguntas), "a cascata: o humano está desligado, o opt_out pergunta").toEqual(["opt_out"]);
    expect(de("jev_observacoes")).toHaveLength(1);
    expect(de("jev_observacoes")[0]).toMatchObject({ tarefa: "opt_out", rotulo_jev: "sim", rotulo_atual: "nao" });
    expect(de("llm_calls")).toHaveLength(1);
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]).toMatchObject({ kind: "jev_parar_de_receber" });
    expect(alteracoesDe("contacts"), "nem o Jev bloqueia ninguém").toEqual([]);
    expect(vazouATranscricao(H.transcricao)).toBe(false);
  });

  it("controle: 'tem como parar a dor?' transcrito → nada (o caso clássico do deteccao.ts)", async () => {
    H.transcricao = "tem como parar a dor depois da extração?";
    organizacao.settings = jevAvisando({ opt_out: { estado: "decidindo" } });
    jevResponde(0.02);

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    expect(decidirNoPontoMock, "a regra disse não, então o Jev foi perguntado").toHaveBeenCalledTimes(1);
    expect(de("jev_observacoes")[0]).toMatchObject({ rotulo_jev: "nao" });
    expect(avisos(), "abaixo do corte de 0,8 não há aviso nem bloqueio").toEqual([]);
    expect(alteracoesDe("contacts")).toEqual([]);
  });

  it("áudio do ATENDENTE não é pedido nenhum", async () => {
    H.transcricao = "não quero mais receber mensagem nenhuma de vocês";
    mensagem.sent_via = "external_device";
    organizacao.settings = jevAvisando({ opt_out: { estado: "decidindo" } });
    jevResponde(0.95);

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    expect(decidirNoPontoMock, "a fala nossa não é pedido do cliente").not.toHaveBeenCalled();
    expect(avisos()).toEqual([]);
    expect(alteracoesDe("contacts")).toEqual([]);
  });

  it("credencial ausente → zero linha em llm_calls e nenhum aviso", async () => {
    H.transcricao = "pode tirar meu número daí, por favor";
    organizacao.settings = jevAvisando({ opt_out: { estado: "decidindo" } });
    decidirNoPontoMock.mockResolvedValue({
      ok: false,
      motivo: "sem_credencial",
      exigeAcao: false,
      defeitoNosso: false,
      status: null,
      latenciaMs: 1,
    });

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("ok");
    expect(decidirNoPontoMock).toHaveBeenCalledTimes(1);
    expect(de("llm_calls"), "sem credencial não há chamada que cobrar").toEqual([]);
    expect(de("jev_observacoes")).toEqual([]);
    expect(avisos()).toEqual([]);
    expect(alteracoesDe("contacts")).toEqual([]);
  });

  it("mensagem já anonimizada: a transcrição nem é gravada e nada abre (a lição do #2191)", async () => {
    H.transcricao = "não quero mais receber mensagem nenhuma de vocês";
    mensagem.body = MENSAGEM_REDIGIDA;
    organizacao.settings = jevAvisando({ opt_out: { estado: "decidindo" } });
    jevResponde(0.95);

    const r = await deriveMessageMedia(eventRow());

    expect(r.status).toBe("skipped");
    expect(decidirNoPontoMock).not.toHaveBeenCalled();
    expect(avisos()).toEqual([]);
    expect(alteracoesDe("contacts")).toEqual([]);
  });
});
