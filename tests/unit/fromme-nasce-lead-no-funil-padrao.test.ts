/**
 * #2448 — a primeira mensagem que o operador digita NO CELULAR nasce o lead
 * no funil padrão, no MESMO evento em que a conversa nasce.
 *
 * ═══ O defeito ═══
 *
 * `garantirLeadDaConversa` só era alcançada pela pós-entrada (`pos-entrada.ts`),
 * roda exclusivamente no caminho RECEBIDO. O `fromMe` do WAHA passa por
 * `handleOutboundFromUserPhone` — grava conversa, pausa a IA, audita — e saía
 * sem funil: a conversa aparecia no CRM e ninguém era dona dela.
 *
 * ═══ O que este arquivo mede ═══
 *
 *   1. mensagem `fromMe` genuína + `crm_pipelines.is_default` → a RPC de
 *      nascimento é chamada UMA vez, com o funil padrão, a primeira etapa e a
 *      origem do operador, e a atividade `lead_created` sai com esse motivo;
 *   2. a conversa já tem lead aberto → NENHUMA chamada nova (nada duplicado);
 *   3. eco do envio do próprio CRM → não nasce nada (a conversa não nasceu aqui);
 *   4. organização sem funil padrão → não há card e o MOTIVO fica visível;
 *   5. o caminho recebido não mudou: `handleInbound` não ganhou chamada nenhuma
 *      e o nascimento de lá continua saindo pela pós-entrada.
 *
 * Prova pelo `dispatchWahaEvent` real (admin client mockado), como os irmãos
 * `waha-ingest-atendimento-manual.test.ts` e `eco-do-envio-nao-silencia-o-bot`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/waha/ingest.ts` alcança `lib/env.ts` (que valida na importação) via
// `pos-entrada`/`ai-response-worker`. Mesma isca dos irmãos.
const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));

import { logger } from "@/lib/logger";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

const ORG = "org-1";
const SESSION = { id: "sess-1", organization_id: ORG, is_warmup_complete: true, warmup_started_at: null };

interface Cena {
  /** A organização tem `crm_pipelines.is_default = true` com etapa? */
  funilPadrao: boolean;
  /** O contato JÁ tem lead aberto (conversa que já existia, card já nascido). */
  leadAberto: boolean;
  /**
   * O contato só tem lead FECHADO (ganho/perdido): o operador manda o rastreio
   * depois da venda. A trava de `garantirLeadDaConversa` olha só `status='open'`;
   * quem segura este caso é a guarda do celular.
   */
  leadFechado?: boolean;
  /** A mensagem já está gravada — eco/duplicata recusada antes de qualquer efeito. */
  jaRegistrada: boolean;
  /**
   * Envio NOSSO ainda em voo (linha `queued`, sem `external_id`) com o mesmo
   * texto: o dedup não casa, quem reconhece é `ehEcoDeEnvioNosso`. Sem este
   * caso, retirar o `if (!ehEco)` do nascimento passava com 7/7.
   */
  ecoEmVoo?: boolean;
  rpcs: Array<{ nome: string; args: Record<string, unknown> }>;
  inserts: Record<string, Array<Record<string, unknown>>>;
  conversationUpdates: Array<Record<string, unknown>>;
}

function novaCena(parcial: Partial<Cena> = {}): Cena {
  return {
    funilPadrao: true,
    leadAberto: false,
    jaRegistrada: false,
    rpcs: [],
    inserts: {},
    conversationUpdates: [],
    ...parcial,
  };
}

/**
 * Contato SEM cadastro nenhum: é o caso da issue (número que ainda não tem
 * conversa nem lead). `first_service_at` nulo também mantém o ramo de
 * "cliente conhecido" fora do caminho — o lead entra pelo funil de entrada.
 */
const CONTATO_NOVO = {
  is_blocked: false,
  is_personal: false,
  display_name: null,
  name: null,
  phone_number: "5511999999999",
  source: null,
  source_metadata: null,
  first_service_at: null,
};

interface Opcoes {
  /** RPC que ESTOURA em vez de responder — cobre o best-effort do nascimento. */
  rpcQueFalha?: string;
}

function makeAdmin(c: Cena, opcoes: Opcoes = {}) {
  const table = (name: string) => {
    let selectCols = "";
    const filtros: Record<string, unknown> = {};
    let mode: "select" | "insert" | "update" = "select";

    const resposta = (): { data: unknown; error: null } => {
      if (name === "messages" && mode === "select") {
        // dedup por external_id: `null` = mensagem genuína do celular.
        return { data: c.jaRegistrada ? { id: "eco" } : null, error: null };
      }
      if (name === "messages" && mode === "insert") return { data: { id: "msg-nova" }, error: null };
      if (name === "conversations" && selectCols.includes("bot_silenced_until")) {
        return { data: { bot_silenced_until: null }, error: null };
      }
      if (name === "contacts" && mode === "select") return { data: CONTATO_NOVO, error: null };
      if (name === "crm_pipelines") return { data: c.funilPadrao ? { id: "funil-padrao" } : null, error: null };
      if (name === "crm_stages") return { data: c.funilPadrao ? { id: "etapa-1" } : null, error: null };
      if (name === "crm_leads" && mode === "select") {
        // Com `status='open'` responde só o lead aberto; sem filtro de status,
        // qualquer lead do contato.
        const achou = filtros.status === "open" ? c.leadAberto : c.leadAberto || c.leadFechado;
        return { data: achou ? { id: "lead-do-contato" } : null, error: null };
      }
      return { data: null, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols?: string) => {
        selectCols = cols ?? "";
        return chain;
      },
      insert: (p?: Record<string, unknown>) => {
        mode = "insert";
        if (p) (c.inserts[name] ??= []).push(p);
        return chain;
      },
      update: (p: Record<string, unknown>) => {
        mode = "update";
        if (name === "conversations") c.conversationUpdates.push(p);
        return chain;
      },
      eq: (col: string, val: unknown) => {
        filtros[col] = val;
        return chain;
      },
      in: () => chain,
      limit: () => chain,
      // `ehEcoDeEnvioNosso` consulta com `.is(...).in(...).gte(...)`, e a
      // re-checagem pós-insert filtra por `neq`. Sem estes elos a cadeia
      // estoura com "is is not a function" e o caso cai por um motivo que
      // nada tem a ver com o que ele mede.
      is: () => chain,
      neq: () => chain,
      gte: () => chain,
      order: () => chain,
      maybeSingle: () => Promise.resolve(resposta()),
      then: (r: (v: unknown) => unknown) =>
        Promise.resolve(
          // A consulta de `ehEcoDeEnvioNosso` termina em `.limit(20)` e é
          // aguardada direto: é ela que lê o envio em voo.
          name === "messages" && selectCols === "id, body, type" && c.ecoEmVoo
            ? { data: [{ id: "nossa-em-voo", body: envelopeFromMe.payload.body, type: "text" }], error: null }
            : { data: null, error: null },
        ).then(r),
    };
    return chain;
  };

  return {
    from: (n: string) => table(n),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      c.rpcs.push({ nome: fn, args: args ?? {} });
      if (opcoes.rpcQueFalha === fn) throw new Error("banco fora");
      if (fn === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conv-1", error: null };
      // A RPC serializa por (organização, contato) e devolve NULL quando já
      // existe um card aberto — é a segunda camada de idempotência.
      if (fn === "fn_nascer_lead_da_conversa") return { data: c.leadAberto ? null : "lead-novo", error: null };
      return { data: null, error: null };
    },
  } as never;
}

const envelopeFromMe = {
  event: "message.any",
  payload: {
    id: "true_5511999999999@c.us_ABCD",
    fromMe: true,
    to: "5511999999999@c.us",
    body: "Oi! Já te respondo com os detalhes.",
    // Em `fromMe` o `pushName` é do OPERADOR — repassá-lo ao nascimento
    // batizaria o card com o nome da loja no lugar do cliente.
    pushName: "Loja da Silva",
    type: "text",
    timestamp: Math.floor(Date.now() / 1000),
  },
};

function nascimentos(c: Cena) {
  return c.rpcs.filter((r) => r.nome === "fn_nascer_lead_da_conversa");
}

async function enviar(c: Cena, opcoes: Opcoes = {}) {
  await dispatchWahaEvent(makeAdmin(c, opcoes), SESSION, envelopeFromMe, "req-1");
}

beforeEach(() => vi.clearAllMocks());

describe("#2448 · a conversa que começa pelo celular nasce no funil padrão", () => {
  it("fromMe genuíno com funil padrão → UMA chamada, no funil e na primeira etapa, com a origem do operador", async () => {
    const c = novaCena();
    await enviar(c);

    const chamadas = nascimentos(c);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.args).toMatchObject({
      p_org: ORG,
      p_contact: "contact-1",
      p_pipeline: "funil-padrao",
      p_stage: "etapa-1",
      p_source: "whatsapp_operador",
      // O título vem do CADASTRO (`rotuloDoContato`), nunca do `pushName` do
      // payload — que em `fromMe` é o da loja. Contato sem nome rotula pelo
      // número; sem número nenhum, cairia no "Novo contato pelo WhatsApp" do
      // `rotulo` da origem.
      p_title: rotuloDoContato(CONTATO_NOVO),
      p_tags: [],
    });
    expect(chamadas[0]!.args.p_title).not.toBe("Loja da Silva");

    // O card não aparece "sozinho": a atividade sai com o motivo certo, que é
    // o que a linha do tempo mostra para quem abre o card.
    const atividades = c.inserts["crm_lead_activities"] ?? [];
    expect(atividades).toHaveLength(1);
    expect(atividades[0]).toMatchObject({
      organization_id: ORG,
      lead_id: "lead-novo",
      type: "lead_created",
      reason: "primeira mensagem enviada pelo celular",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "waha.ingest: lead criado a partir do celular",
      expect.objectContaining({ lead_id: "lead-novo", pipeline_id: "funil-padrao" }),
    );
  });

  it("conversa que JÁ tinha lead aberto → nenhuma chamada nova: nada duplicado", async () => {
    const c = novaCena({ leadAberto: true });
    await enviar(c);

    expect(nascimentos(c)).toHaveLength(0);
    // O "não criado" também vira log — silêncio não distingue "já existia" de
    // "falhou ao nascer".
    expect(logger.info).toHaveBeenCalledWith(
      "waha.ingest: lead nao criado a partir do celular",
      expect.objectContaining({ motivo: "contato_ja_tem_lead" }),
    );
  });

  it("contato com lead GANHO/PERDIDO → o operador falando pelo celular não abre card novo", async () => {
    const c = novaCena({ leadFechado: true });
    await enviar(c);

    expect(c.inserts["messages"]).toHaveLength(1);
    expect(nascimentos(c)).toHaveLength(0);
    expect(c.inserts["crm_lead_activities"]).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      "waha.ingest: lead nao criado a partir do celular",
      expect.objectContaining({ motivo: "contato_ja_tem_lead" }),
    );
  });

  it("eco do envio do PRÓPRIO CRM → não nasce lead (esta conversa não começou pelo celular)", async () => {
    const c = novaCena({ jaRegistrada: true });
    await enviar(c);

    expect(nascimentos(c)).toHaveLength(0);
    expect(c.inserts["crm_lead_activities"]).toBeUndefined();
  });

  it("eco AINDA EM VOO (o dedup não casa) → a mensagem entra, mas não nasce lead", async () => {
    const c = novaCena({ ecoEmVoo: true });
    await enviar(c);

    expect(c.inserts["messages"]).toHaveLength(1);
    expect(nascimentos(c)).toHaveLength(0);
    expect(c.inserts["crm_lead_activities"]).toBeUndefined();
  });

  it("organização SEM funil padrão → não há card, e o motivo de configuração fica visível", async () => {
    const c = novaCena({ funilPadrao: false });
    await enviar(c);

    expect(nascimentos(c)).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "waha.ingest: lead nao criado a partir do celular",
      expect.objectContaining({ motivo: "sem_funil_de_entrada" }),
    );
  });

  it("falha de escrita não derruba a ingestão: a mensagem entra e o erro vira log", async () => {
    const c = novaCena();
    await enviar(c, { rpcQueFalha: "fn_nascer_lead_da_conversa" });

    // Uma exceção daqui subiria para o webhook e o WAHA reenviaria tudo —
    // trocaríamos um card que não nasceu por uma tempestade de reentrega.
    expect(logger.error).toHaveBeenCalledWith(
      "waha.ingest: nascimento do lead pelo celular falhou (a mensagem entra assim mesmo)",
      expect.objectContaining({ conversation_id: "conv-1" }),
    );
    // A mensagem foi gravada ANTES do nascimento: o histórico não some.
    expect(c.inserts["messages"]).toHaveLength(1);
    // E o evento não parou no meio: a auditoria do envio segue.
    const { audit } = await import("@/lib/audit");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "message.sent" }),
    );
  });
});

describe("#2448 · o caminho RECEBIDO não muda", () => {
  it("handleInbound não ganhou chamada nenhuma ao nascimento do lead", () => {
    const fonte = readFileSync(resolve(__dirname, "../../lib/waha/ingest.ts"), "utf-8");
    const inicio = fonte.indexOf("async function handleInbound");
    const fim = fonte.indexOf("async function revogarComando");
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    const corpoDoRecebido = fonte.slice(inicio, fim);
    expect(corpoDoRecebido).not.toContain("garantirLeadDaConversa");
    expect(corpoDoRecebido).not.toContain("nascerLeadDaConversaPeloCelular");
  });

  it("o nascimento do inbound continua saindo da pós-entrada, como antes", () => {
    const posEntrada = readFileSync(resolve(__dirname, "../../lib/channels/pos-entrada.ts"), "utf-8");
    expect(posEntrada).toContain("await garantirLeadDaConversa(admin, {");
    // A pós-entrada continua dizendo que a ordem é dela (opt-out → lead →
    // despacho): este PR não mexe nela, só acrescenta o caminho de saída.
    expect(posEntrada).toContain("abrirDemanda");
  });
});
