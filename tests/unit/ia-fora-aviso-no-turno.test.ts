/**
 * A IA INTEIRA FORA NÃO FICA EM SILÊNCIO (#4610).
 *
 * ## O que aconteceu em produção
 *
 * Na 1.104.0 a credencial `openai-assinatura` renovou o acesso às 08:09 e, a
 * partir de 08:10, TODAS as chamadas da assinatura passaram a ser recusadas. A
 * reserva existia e também falhou. Durante seis horas os agentes não responderam
 * e a Central de avisos mostrou só um `job_dead` genérico ("Job descartado após
 * esgotar tentativas"): nada dizia que a assinatura recusava chamadas e que a
 * reserva também tinha caído — ou seja, que a IA da empresa inteira estava fora.
 *
 * A outra metade da issue (guardar o erro ORIGINAL quando a chamada cai na
 * reserva) entrou no PR #4616; este arquivo cobre o aviso, e reconfere o
 * caminho do erro preservado ponta a ponta, porque é o texto dele que vai no
 * corpo do aviso.
 *
 * ## O que este arquivo mede
 *
 *  1. queda para a reserva preserva `http_status` e a mensagem do primário no
 *     log, na linha de `llm_calls` e no aviso;
 *  2. assinatura E reserva falhando: UM aviso, mesmo com três chamadas
 *     seguidas (o dedup é o índice único da migration 9027, não um contador em
 *     memória);
 *  3. chamada que dá certo não emite aviso nenhum — nem abre query na Central;
 *  4. nenhum segredo (chave/token) aparece no log, no registro nem no aviso;
 *  5. uma chamada que volta a passar FECHA o aviso do episódio.
 *
 * ## Sem provedor real, nunca
 *
 * As fábricas de modelo são dublês (`createFakeRegistry` e uma fábrica que só
 * lança), e `fetch` é substituído por um que FALHA o teste se for chamado: se
 * alguém trocar o dublê por um provider de verdade, o teste vermelhece em vez de
 * tentar a rede.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Precisa existir ANTES de qualquer import: `lib/env.ts` lê o processo no
// carregamento do módulo, e é ele que entrega a chave de cifragem ao AES.
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import { PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import {
  KIND_ASSINATURA_DESCONECTADA,
  TITULO_DA_IA_FORA,
} from "@/lib/ai/credenciais/assinatura-desconectada";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";

import { FakeSupabase, type Linha } from "./helpers/fake-ai-credentials";

/** `fetch` que denuncia qualquer tentativa de falar com provedor de verdade. */
const fetchProibido = vi.fn(async () => {
  throw new Error("o teste não pode falar com provedor real (#4610)");
});

const estado = vi.hoisted(() => ({ cred: null as unknown, inbox: null as unknown }));

function clienteDoSeam() {
  return {
    from: (tabela: string) =>
      tabela === "agent_inbox_items"
        ? (estado.inbox as InboxFalso).from(tabela)
        : (estado.cred as FakeSupabase).from(tabela),
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => clienteDoSeam(),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => true),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_CHAMADA_OK = "55555555-5555-4555-8555-555555555555";
const ORG_RECUPERA = "66666666-6666-4666-8666-666666666666";
const CRED = "22222222-2222-4222-8222-222222222222";

/** Sentinelas com cara de chave: se o redator não passar por elas, o teste vê. */
const SEGREDO_DA_ASSINATURA = "sk-assinatura-vazada-9f8e7d6c5b4a";
const SEGREDO_DA_RESERVA = "sk-reserva-vazada-0a1b2c3d4e5f";

const MENSAGEM_DA_ASSINATURA = "assinatura recusou o turno: login expirado";
const MENSAGEM_DA_RESERVA = "Incorrect API key provided";

/**
 * O PostgREST da Central — em memória, com a semântica que o aplicador usa:
 * `select` filtrado, `insert` que cria linha, `update` que só casa linha ABERTA.
 * O `FakeSupabase` do repo guarda UMA linha (serve às credenciais); a Central
 * precisa de várias, e é a contagem de INSERT que prova "um aviso só".
 */
class InboxFalso {
  itens: Linha[] = [];
  operacoes: Array<{ tipo: string; dados?: Record<string, unknown>; filtros: Array<[string, unknown]> }> = [];
  private seq = 0;

  from(_tabela: string) {
    return new ConsultaInbox(this);
  }

  abrir(linha: Linha) {
    const item = { id: `item-${(this.seq += 1)}`, status: "open", created_at: new Date().toISOString(), ...linha };
    this.itens.push(item);
    return item;
  }

  novos(): InboxFalso {
    this.itens = [];
    this.operacoes = [];
    this.seq = 0;
    return this;
  }
}

class ConsultaInbox {
  private filtros: Array<[string, unknown]> = [];
  private dados?: Record<string, unknown>;
  private tipo = "select";

  constructor(private readonly db: InboxFalso) {}

  select(_cols?: string) {
    return this;
  }
  eq(col: string, valor: unknown) {
    this.filtros.push([col, valor]);
    return this;
  }
  limit(_n?: number) {
    return this;
  }
  order() {
    return this;
  }
  update(dados: Record<string, unknown>) {
    this.dados = dados;
    this.tipo = "update";
    return this;
  }
  insert(dados: Record<string, unknown>) {
    this.dados = dados;
    this.tipo = "insert";
    return this;
  }

  private async resolver() {
    await Promise.resolve();
    this.db.operacoes.push({ tipo: this.tipo, dados: this.dados, filtros: [...this.filtros] });
    if (this.tipo === "insert") {
      const linha = this.db.abrir(this.dados ?? {});
      return { data: { id: linha.id }, error: null };
    }
    const casam = this.db.itens.filter((item) => this.filtros.every(([col, valor]) => item[col] === valor));
    if (this.tipo === "update") {
      for (const item of casam) Object.assign(item, this.dados);
      return { data: casam[0] === undefined ? null : { id: casam[0].id }, error: null };
    }
    return { data: casam[0] ?? null, error: null };
  }

  single() {
    return this.resolver();
  }
  maybeSingle() {
    return this.resolver();
  }
  then<A, B>(
    onfulfilled?: ((v: { data: unknown; error: null }) => A | Promise<A>) | null,
    onrejected?: ((e: unknown) => B | Promise<B>) | null,
  ): Promise<A | B> {
    return this.resolver().then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

const tokens = {
  access_token: "at-1234567890",
  refresh_token: "rt-9876543210",
  client_id: "siwc-client-test",
  scopes: ["chatgpt.tokens.use.direct"],
  expires_at: null,
};

/** A credencial da assinatura, cifrada como em produção. */
function linhaDoLogin(organizacao: string = ORG): Linha {
  const c = encryptKey(JSON.stringify(tokens));
  return {
    id: CRED,
    organization_id: organizacao,
    provider: PROVEDOR_POR_ASSINATURA,
    is_active: true,
    validated_at: new Date().toISOString(),
    api_key_encrypted: bufToBytea(c.ciphertext),
    api_key_iv: bufToBytea(c.iv),
    api_key_tag: bufToBytea(c.tag),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  };
}

/** O pool do seam: configuração da org, INSERT de `llm_calls` contado, resto vazio. */
function poolDoSeam(provider: string) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider,
              default_model: provider === "anthropic" ? "claude-teste" : "gpt-5-teste",
              params: {},
              enabled_models: [],
            },
            teto: null,
            modo: null,
            efetivo_em: null,
            limiar_pct: null,
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

/** Uma fábrica que só falha: o provedor não responde, e nada sai para a rede. */
const registroQueFalha = (erro: () => unknown) => (_apiKey: string, _modelId: string) =>
  ({
    specificationVersion: "v3",
    provider: PROVEDOR_POR_ASSINATURA,
    modelId: "gpt-5",
    doGenerate: async () => {
      throw erro();
    },
    doStream: async () => {
      throw erro();
    },
  }) as never;

/** A fábrica de ENSAIO do próprio módulo: devolve `ok` com usage contado. */
const registroOk = createFakeRegistry(undefined, { text: "ok da reserva" }).anthropic;

const erroDaAssinatura = () =>
  Object.assign(new Error(`${MENSAGEM_DA_ASSINATURA} (Bearer ${SEGREDO_DA_ASSINATURA})`), { statusCode: 429 });
const erroDaReserva = () =>
  Object.assign(new Error(`${MENSAGEM_DA_RESERVA}: ${SEGREDO_DA_RESERVA}`), { statusCode: 401 });

/** Logger espião: guarda nível, mensagem e campos de cada linha. */
function logQueEscuta() {
  const linhas: Array<{ nivel: string; mensagem: string; campos: Record<string, unknown> }> = [];
  const anota =
    (nivel: string) =>
    (mensagem: string, campos?: Record<string, unknown>) =>
      linhas.push({ nivel, mensagem, campos: campos ?? {} });
  return { log: { info: anota("info"), warn: anota("warn"), error: anota("error") } as never, linhas };
}

const inbox = () => estado.inbox as InboxFalso;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchProibido);
  fetchProibido.mockClear();
  estado.cred = new FakeSupabase();
  estado.inbox = new InboxFalso();
  (estado.cred as FakeSupabase).linha = linhaDoLogin();
});

const cfgComReserva = { cacheTtl: "1h", openaiApiKey: SEGREDO_DA_RESERVA } as never;

function chamada(tenantId: string) {
  return {
    tenantId,
    purpose: "agent_turn",
    messages: [{ role: "user" as const, content: "oi" }],
  };
}

/** Roda a chamada engolindo o erro: o que interessa aqui é o rastro, não o throw. */
async function chamadaQueFalha(
  pool: never,
  registro: never,
  log: never,
  tenantId = ORG,
): Promise<unknown> {
  try {
    await runModelCall(pool, cfgComReserva, chamada(tenantId), { registry: registro, log });
    return null;
  } catch (e) {
    return e;
  }
}

describe("1. a queda preserva status e mensagem do primário (#4610)", () => {
  it("⭐ assinatura 429 + reserva 401: log, llm_calls e aviso contam os DOIS lados", async () => {
    const { pool, inserts } = poolDoSeam(PROVEDOR_POR_ASSINATURA);
    const registro = {
      [PROVEDOR_POR_ASSINATURA]: registroQueFalha(erroDaAssinatura),
      openai: registroQueFalha(erroDaReserva),
      anthropic: registroOk,
      fake: registroOk,
    } as never;
    const { log, linhas } = logQueEscuta();

    const lancou = await chamadaQueFalha(pool, registro, log);

    // O turno continua se comportando como antes: o erro que sobe é o da
    // reserva, que foi a última a falhar.
    expect(lancou).toBeInstanceOf(Error);
    expect((lancou as Error).message).toContain(MENSAGEM_DA_RESERVA);
    expect(fetchProibido, "o teste falou com um provedor de verdade").not.toHaveBeenCalled();

    // (a) A LINHA DE `llm_calls` — o que a tela de Execuções mostra.
    const linha = inserts.find((i) => i.sql.includes("'erro'"));
    expect(linha, "a falha não foi registrada").toBeDefined();
    const gravado = String(linha!.params[9]);
    expect(gravado, "o erro do primário foi apagado pelo da reserva").toContain(MENSAGEM_DA_ASSINATURA);
    expect(gravado, "o status do primário não chegou ao registro").toContain("429");
    expect(gravado, "o erro da reserva sumiu do registro").toContain(MENSAGEM_DA_RESERVA);
    expect(gravado).toMatch(/assinatura/i);
    expect(gravado).toMatch(/reserva/i);

    // O log da queda, com o lado do primário em campo próprio.
    const avisoDaQueda = linhas.find((l) => l.mensagem.includes("caiu na reserva"));
    expect(avisoDaQueda, "o aviso da queda sumiu").toBeDefined();
    expect(avisoDaQueda!.campos.http_status_da_assinatura).toBe(429);
    expect(String(avisoDaQueda!.campos.erro_da_assinatura)).toContain(MENSAGEM_DA_ASSINATURA);

    // (b) O AVISO NA CENTRAL carrega os dois lados, nomeados.
    const item = inbox().itens[0];
    expect(item, "a IA ficou fora e a Central não soube").toBeDefined();
    const corpo = String(item!.body);
    expect(item!.title, "o aviso não foi o do episódio 'IA fora'").toBe(TITULO_DA_IA_FORA);
    expect(corpo).toContain(MENSAGEM_DA_ASSINATURA);
    expect(corpo).toContain("429");
    expect(corpo).toContain(MENSAGEM_DA_RESERVA);
    expect(corpo).toContain("401");
    // Os provedores aparecem; sem isso a leitura aponta para a chave errada.
    expect(corpo).toContain(PROVEDOR_POR_ASSINATURA);
    expect(corpo).toContain("openai");
  });
});

describe("2. falha total: UM aviso, por mais chamadas que falhem", () => {
  it("⭐ três chamadas seguidas = um INSERT e dois UPDATE no mesmo item", async () => {
    const { pool } = poolDoSeam(PROVEDOR_POR_ASSINATURA);
    const registro = {
      [PROVEDOR_POR_ASSINATURA]: registroQueFalha(erroDaAssinatura),
      openai: registroQueFalha(erroDaReserva),
      anthropic: registroOk,
      fake: registroOk,
    } as never;

    for (let i = 0; i < 3; i += 1) {
      const { log } = logQueEscuta();
      await chamadaQueFalha(pool, registro, log);
    }

    const insercoes = inbox().operacoes.filter((o) => o.tipo === "insert");
    const atualizacoes = inbox().operacoes.filter((o) => o.tipo === "update");
    expect(insercoes, "107 turnos = 107 avisos, de novo").toHaveLength(1);
    expect(atualizacoes, "as chamadas seguintes não atualizaram o MESMO item").toHaveLength(2);
    expect(inbox().itens).toHaveLength(1);

    expect(insercoes[0]?.dados).toMatchObject({
      organization_id: ORG,
      kind: KIND_ASSINATURA_DESCONECTADA,
      // `critical`: o cliente já está sem resposta.
      severity: "critical",
      status: "open",
      title: TITULO_DA_IA_FORA,
    });
    // O botão do item é o da tela de Credenciais (política do kind): sem
    // `ref_kind`/`ref_id`, que apontariam para uma linha que não é o conserto.
    expect(insercoes[0]?.dados).not.toHaveProperty("ref_kind");
    expect(insercoes[0]?.dados).not.toHaveProperty("ref_id");
  });
});

describe("3. chamada que dá certo não emite aviso", () => {
  it("⭐ sucesso no provedor nativo: nenhuma operação na Central", async () => {
    (estado.cred as FakeSupabase).linha = null;
    const { pool } = poolDoSeam("anthropic");
    const registro = { anthropic: registroOk, openai: registroOk, fake: registroOk } as never;
    const { log } = logQueEscuta();

    const r = await runModelCall(
      pool,
      { cacheTtl: "1h", anthropicApiKey: SEGREDO_DA_RESERVA } as never,
      chamada(ORG_CHAMADA_OK),
      { registry: registro, log },
    );

    expect(r.provider).toBe("anthropic");
    expect(inbox().operacoes, "uma chamada boa abriu aviso de IA fora").toHaveLength(0);
    expect(inbox().itens).toHaveLength(0);
  });
});

describe("4. nenhum segredo no log, no registro nem no aviso", () => {
  it("⭐ as duas sentinelas de chave não aparecem em lugar nenhum", async () => {
    const { pool, inserts } = poolDoSeam(PROVEDOR_POR_ASSINATURA);
    const registro = {
      [PROVEDOR_POR_ASSINATURA]: registroQueFalha(erroDaAssinatura),
      openai: registroQueFalha(erroDaReserva),
      anthropic: registroOk,
      fake: registroOk,
    } as never;
    const { log, linhas } = logQueEscuta();

    await chamadaQueFalha(pool, registro, log);

    const tudoDoLog = JSON.stringify(linhas);
    expect(tudoDoLog, "segredo da assinatura no log").not.toContain(SEGREDO_DA_ASSINATURA);
    expect(tudoDoLog, "segredo da reserva no log").not.toContain(SEGREDO_DA_RESERVA);

    const linha = inserts.find((i) => i.sql.includes("'erro'"));
    const gravado = String(linha!.params[9]);
    expect(gravado, "segredo no registro da chamada").not.toContain(SEGREDO_DA_ASSINATURA);
    expect(gravado, "segredo no registro da chamada").not.toContain(SEGREDO_DA_RESERVA);

    const corpo = String(inbox().itens[0]?.body);
    expect(corpo, "segredo no aviso da Central").not.toContain(SEGREDO_DA_ASSINATURA);
    expect(corpo, "segredo no aviso da Central").not.toContain(SEGREDO_DA_RESERVA);
    // O redator MARCOU o lugar do segredo: sumir sem marca faria o operador
    // achar que a mensagem do provedor era só aquilo.
    expect(corpo).toContain("[CHAVE]");
  });
});

describe("5. a volta: uma chamada que passa fecha o aviso", () => {
  it("⭐ reserva responde depois da queda: item RESOLVIDO, sem segundo aviso", async () => {
    // A credencial da assinatura é DESTA organização: o resolvedor casa
    // `organization_id`, então uma linha de outra org não vale aqui.
    (estado.cred as FakeSupabase).linha = linhaDoLogin(ORG_RECUPERA);
    const { pool } = poolDoSeam(PROVEDOR_POR_ASSINATURA);
    const registroQueCai = {
      [PROVEDOR_POR_ASSINATURA]: registroQueFalha(erroDaAssinatura),
      openai: registroQueFalha(erroDaReserva),
      anthropic: registroOk,
      fake: registroOk,
    } as never;
    await chamadaQueFalha(pool, registroQueCai, logQueEscuta().log, ORG_RECUPERA);
    expect(inbox().itens[0]?.status).toBe("open");

    // A assinatura segue recusando e a reserva volta: a IA responde de novo.
    const registroQueVolta = {
      [PROVEDOR_POR_ASSINATURA]: registroQueFalha(erroDaAssinatura),
      openai: registroOk,
      anthropic: registroOk,
      fake: registroOk,
    } as never;
    const r = await runModelCall(pool, cfgComReserva, chamada(ORG_RECUPERA), {
      registry: registroQueVolta,
      log: logQueEscuta().log,
    });

    expect(r.provider).toBe("openai");
    expect(inbox().itens, "a volta abriu um segundo aviso").toHaveLength(1);
    expect(inbox().itens[0]?.status, "o aviso ficou aberto com a IA respondendo").toBe("resolved");
    expect(String(inbox().itens[0]?.body)).toContain("uma chamada de IA voltou a passar");
    expect(inbox().operacoes.filter((o) => o.tipo === "insert")).toHaveLength(1);
  });
});
