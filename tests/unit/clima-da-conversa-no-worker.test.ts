/**
 * O CLIMA DA CONVERSA PELO WORKER DE VERDADE — `processSentiment`, não o medidor.
 *
 * `lib/ai/decisao/clima.test.ts` prova o medidor isolado. Aqui roda o worker
 * inteiro, com o resolvedor de modelo REAL (`resolverModeloDoPonto`) e o log
 * REAL (`logInvocation`) gravando num banco de brinquedo — as linhas de
 * `llm_calls` que a tela de Execuções lê são afirmadas como ficaram, não como o
 * worker pediu que ficassem.
 *
 * ## A chave colada pela tela (D12)
 *
 * O worker desistia logo na entrada com `isAiGatewayConfigured()`, que só olha
 * três variáveis do `.env`. A instalação cuja chave foi colada em IA ›
 * Credenciais (o `install.sh` deixa a chave opcional: "dá para cadastrar depois
 * pela tela") nunca media o clima — e, sem clima, ninguém era chamado quando o
 * cliente se irritava. O resolvedor que vem logo depois já sabia achar essa
 * chave; o portão na frente dele é que não deixava chegar lá.
 *
 * Em todos os casos o `.env` está VAZIO de chave de IA: um verde aqui só pode
 * ter vindo da credencial da organização.
 */
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "",
  AI_GATEWAY_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));
// A chave "cifrada" do banco de brinquedo é o próprio texto: o que se prova
// aqui é QUAL credencial foi lida, não a criptografia.
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => v,
  decryptKey: (c: { ciphertext: unknown }) => String(c.ciphertext),
}));

import { generateObject } from "ai";

import { registrarFalha } from "@/lib/ai/decisao/disjuntor";
import { AVISO_DO_JEV, O_QUE_FAZER_DO_JEV } from "@/lib/ai/decisao/textos";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { processSentiment } from "@/workers/ai-sentiment-worker";

type Linha = Record<string, unknown>;
/** As tabelas que os casos afirmam são nomeadas; o resto nasce vazio sob demanda. */
interface Banco {
  [tabela: string]: Linha[] | undefined;
  messages: Linha[];
  llm_calls: Linha[];
  agent_inbox_items: Linha[];
}

/**
 * Uma organização por caso: o disjuntor do Jev é por organização e vive no
 * processo, e três falhas de casos anteriores o deixariam aberto para os seguintes.
 */
let ORG = "";
const MSG = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const CRED_ANTHROPIC = "44444444-4444-4444-8444-444444444444";
const CRED_OPENAI = "55555555-5555-4555-8555-555555555555";

// ── Banco de brinquedo: filtra, ordena, grava e conta ────────────────────────
//
// Mais caro que devolver objeto fixo, e é o que deixa o teste medir a CONSULTA:
// um dublê que devolvesse sempre a mesma credencial aprovaria o worker que não
// filtra por organização nem por provedor.

interface Consulta {
  select(colunas?: string, opcoes?: { count?: string; head?: boolean }): Consulta;
  insert(linha: Linha | Linha[]): Consulta;
  update(mudanca: Linha): Consulta;
  eq(coluna: string, valor: unknown): Consulta;
  is(coluna: string, valor: unknown): Consulta;
  in(coluna: string, valores: unknown[]): Consulta;
  not(coluna: string, operador: string, valor: unknown): Consulta;
  gte(coluna: string, valor: unknown): Consulta;
  order(coluna: string, opcoes?: { ascending?: boolean }): Consulta;
  limit(n: number): Consulta;
  maybeSingle(): Promise<{ data: Linha | null; error: null }>;
  single(): Promise<{ data: Linha | null; error: null }>;
  then<T>(ok: (v: unknown) => T, falha?: (e: unknown) => T): Promise<T>;
}

/** Os `default` do schema que os casos leem de volta (`agent_inbox_items.status`). */
const PADROES_DO_SCHEMA: Record<string, Linha> = { agent_inbox_items: { status: "open" } };

function fazerAdmin(banco: Banco, rpcs: Linha[]) {
  const from = (tabela: string): Consulta => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let modo: "select" | "insert" | "update" = "select";
    let soContar = false;
    let mudanca: Linha = {};
    let novas: Linha[] = [];
    let ordem: { coluna: string; asc: boolean } | null = null;
    let limite: number | null = null;

    const tabelaViva = (): Linha[] => (banco[tabela] ??= []);
    const filtradas = (): Linha[] => {
      let ls = tabelaViva().filter((l) => filtros.every((f) => f(l)));
      if (ordem) {
        const { coluna, asc } = ordem;
        ls = [...ls].sort((a, b) => ((a[coluna] as never) < (b[coluna] as never) ? -1 : 1) * (asc ? 1 : -1));
      }
      return limite === null ? ls : ls.slice(0, limite);
    };
    const executar = () => {
      if (modo === "insert") {
        tabelaViva().push(...novas);
        return { data: null, error: null };
      }
      if (modo === "update") {
        for (const l of filtradas()) Object.assign(l, mudanca);
        return { data: null, error: null };
      }
      const ls = filtradas();
      return soContar ? { data: null, count: ls.length, error: null } : { data: ls, error: null };
    };

    const c: Consulta = {
      select: (_colunas, opcoes) => {
        if (opcoes?.head === true) soContar = true;
        return c;
      },
      insert: (linha) => {
        modo = "insert";
        novas = (Array.isArray(linha) ? linha : [linha]).map((l) => ({ ...PADROES_DO_SCHEMA[tabela], ...l }));
        return c;
      },
      update: (m) => {
        modo = "update";
        mudanca = m;
        return c;
      },
      eq: (col, val) => (filtros.push((l) => l[col] === val), c),
      is: (col, val) => (filtros.push((l) => (l[col] ?? null) === val), c),
      in: (col, vals) => (filtros.push((l) => vals.includes(l[col])), c),
      not: (col, _op, val) => (filtros.push((l) => (l[col] ?? null) !== val), c),
      gte: (col, val) => (filtros.push((l) => (l[col] as never) >= (val as never)), c),
      order: (col, opcoes) => ((ordem = { coluna: col, asc: opcoes?.ascending !== false }), c),
      limit: (n) => ((limite = n), c),
      maybeSingle: () => Promise.resolve({ data: filtradas()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtradas()[0] ?? null, error: null }),
      then: (ok, falha) => Promise.resolve(executar()).then(ok, falha),
    };
    return c;
  };

  return {
    from,
    rpc: (nome: string, args: Linha) => {
      rpcs.push({ nome, ...args });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

interface Cenario {
  /** `organizations.settings` — o provedor escolhido (e, mais tarde, o Jev). */
  settings?: Linha;
  credenciais?: Linha[];
  bindings?: Linha[];
}

function montarBanco(c: Cenario): Banco {
  return {
    organizations: [{ id: ORG, settings: c.settings ?? {}, locale: "pt-BR" }],
    ai_provider_credentials: c.credenciais ?? [],
    ai_purpose_bindings: c.bindings ?? [],
    messages: [
      {
        id: MSG,
        organization_id: ORG,
        conversation_id: CONV,
        body: "já é a terceira vez que eu peço isso",
        direction: "inbound",
        metadata: {},
      },
    ],
    conversations: [{ id: CONV, organization_id: ORG, channel_session_id: null, active_ai_agent_id: null }],
    ai_agents: [],
    ai_agent_versions: [],
    llm_calls: [],
    agent_inbox_items: [],
  };
}

function credencial(id: string, provider: string, chave: string): Linha {
  return {
    id,
    organization_id: ORG,
    provider,
    is_active: true,
    validated_at: "2026-09-01T00:00:00.000Z",
    created_at: "2026-09-01T00:00:00.000Z",
    api_key_encrypted: chave,
    api_key_iv: "iv",
    api_key_tag: "tag",
  };
}

const evento = (): EventRow =>
  ({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    organization_id: ORG,
    entity_id: MSG,
    payload: { message_id: MSG, conversation_id: CONV },
  }) as unknown as EventRow;

/** O log é fire-and-forget (`queueMicrotask`): espera a linha cair no banco. */
async function drenar(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** `banco` entra por fora quando o caso roda o worker duas vezes no mesmo mundo. */
async function rodar(c: Cenario, banco: Banco = montarBanco(c)) {
  const rpcs: Linha[] = [];
  vi.mocked(createAdminClient).mockReturnValue(
    fazerAdmin(banco, rpcs) as unknown as ReturnType<typeof createAdminClient>,
  );
  const resultado = await processSentiment(evento());
  await drenar();
  return { resultado, banco, rpcs };
}

beforeEach(() => {
  ORG = randomUUID();
  vi.clearAllMocks();
  vi.mocked(generateObject).mockResolvedValue({
    object: { sentiment_score: 0.2, reasoning_short: "cliente repetindo o pedido" },
    usage: { inputTokens: 40, outputTokens: 12 },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
});

describe("D12 — o clima roda com a chave colada pela tela", () => {
  it("chave da Anthropic cadastrada em Credenciais, .env vazio: o clima é medido", async () => {
    const { resultado, banco } = await rodar({
      settings: { llm: { provider: "anthropic" } },
      credenciais: [credencial(CRED_ANTHROPIC, "anthropic", "sk-ant-da-tela")],
    });

    expect(resultado, `o worker desistiu: ${resultado.reason ?? "-"}`).toMatchObject({
      skipped: false,
      sentiment_score: 0.2,
    });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(banco.llm_calls).toHaveLength(1);
    expect(banco.llm_calls[0]).toMatchObject({
      purpose: "sentiment_classify",
      provider: "anthropic",
      model: "anthropic/claude-haiku-4-5",
      status: "ok",
    });
    expect(banco.messages[0]!.metadata).toMatchObject({ sentiment_score: 0.2 });
  });

  it("OpenAI cadastrada em Credenciais e escolhida no painel para o clima: o clima é medido", async () => {
    const { resultado, banco } = await rodar({
      settings: { llm: { provider: "openai" } },
      credenciais: [credencial(CRED_OPENAI, "openai", "sk-openai-da-tela")],
      bindings: [
        {
          organization_id: ORG,
          purpose: "sentiment_classify",
          provider: "openai",
          credential_id: CRED_OPENAI,
          model_id: "gpt-5.4-nano",
          base_url: null,
          is_enabled: true,
        },
      ],
    });

    expect(resultado.skipped, `o worker desistiu: ${resultado.reason ?? "-"}`).toBe(false);
    expect(banco.llm_calls[0]).toMatchObject({ provider: "openai", model: "gpt-5.4-nano", status: "ok" });
  });

  // O id padrão do clima é da Anthropic. A empresa que atende pela OpenAI,
  // sem modelo escolhido para o clima, ficava com ele mudo — e o painel dizia
  // "Usando o padrão da organização". Agora vale o padrão dela, o par inteiro.
  it("OpenAI cadastrada em Credenciais, SEM modelo escolhido para o clima: mede com o padrão da organização", async () => {
    const { resultado, banco } = await rodar({
      settings: { llm: { provider: "openai", default_model: "gpt-5.6-terra" } },
      credenciais: [credencial(CRED_OPENAI, "openai", "sk-openai-da-tela")],
    });

    expect(resultado.skipped, `o worker desistiu: ${resultado.reason ?? "-"}`).toBe(false);
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(banco.llm_calls[0]).toMatchObject({
      provider: "openai",
      model: "openai/gpt-5.6-terra",
      status: "ok",
    });
  });

  it("OpenAI só no .env, sem modelo escolhido para o clima: mede com o padrão da organização", async () => {
    envMock.OPENAI_API_KEY = "sk-openai-da-instalacao";
    try {
      const { resultado, banco } = await rodar({
        settings: { llm: { provider: "openai", default_model: "gpt-5.6-terra" } },
      });
      expect(resultado.skipped, `o worker desistiu: ${resultado.reason ?? "-"}`).toBe(false);
      expect(banco.llm_calls[0]).toMatchObject({ provider: "openai", model: "openai/gpt-5.6-terra" });
    } finally {
      envMock.OPENAI_API_KEY = "";
    }
  });

  it("sem chave em lugar nenhum, pula sem chamar ninguém e sem linha (controle)", async () => {
    // Sem este caso, um worker que medisse com modelo inventado passaria nos
    // dois de cima. E é ele que prova que o `.env` deste arquivo está vazio.
    const { resultado, banco } = await rodar({ settings: { llm: { provider: "anthropic" } } });

    expect(resultado).toEqual({ skipped: true, reason: "ai_gateway_key_missing" });
    expect(generateObject).not.toHaveBeenCalled();
    expect(banco.llm_calls).toHaveLength(0);
  });
});

// ── O Jev no worker ──────────────────────────────────────────────────────────
//
// O fornecedor é um dublê de `fetch` GLOBAL, e não uma dependência injetada:
// o worker chama `medirClima` sem deps, então é o caminho de produção inteiro
// (interruptor em `settings`, chave decifrada do banco, allowlist de egress,
// disjuntor) que decide se a pergunta sai.

const CRED_JEV = "66666666-6666-4666-8666-666666666666";
const CHAVE_DO_JEV = "apikey_dubledeteste0000_0000";
const ACEITE = { em: "2026-09-23T12:00:00.000Z", por: "77777777-7777-4777-8777-777777777777" };

/** Uma chamada que o dublê do fornecedor recebeu. */
interface ChamadaAoJev {
  url: string;
  autorizacao: string | null;
  corpo: { model: string; state: unknown };
}

let chamadasAoJev: ChamadaAoJev[] = [];

/**
 * Resposta no formato real da API (medido em 23/09/2026). `modelo` é a versão
 * que o fornecedor DIZ ter respondido — pode não ser a que pedimos.
 */
function respostaDoJev(nivel: number, modelo = "jev-1.13.0"): Response {
  return new Response(
    JSON.stringify({
      model: modelo,
      answers: {
        clima: {
          type: "score",
          score: nivel,
          confidence: 0.91,
          legend: { "0": "cliente irritado, revoltado ou ameaçando sair" },
          probabilities: { "0": 0.91 },
        },
      },
      usage: { input_tokens: 388, output_tokens: 18 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fornecedor(responder: (init: RequestInit) => Promise<Response>): void {
  vi.stubGlobal("fetch", async (entrada: string | URL, init: RequestInit = {}) => {
    const url = String(entrada);
    // Qualquer outro destino é egress que este teste não previu.
    if (!url.startsWith("https://api.typesafe.ai/")) throw new Error(`egress inesperado: ${url}`);
    chamadasAoJev.push({
      url,
      autorizacao: new Headers(init.headers).get("authorization"),
      corpo: JSON.parse(String(init.body)) as ChamadaAoJev["corpo"],
    });
    return responder(init);
  });
}

function jevLigado(modo: "observacao" | "decide", comIaDeSempre = true): Cenario {
  return {
    settings: { llm: { provider: "anthropic" }, jev: { ligado: true, modo, aceite: ACEITE } },
    credenciais: [
      credencial(CRED_JEV, "typesafe", CHAVE_DO_JEV),
      ...(comIaDeSempre ? [credencial(CRED_ANTHROPIC, "anthropic", "sk-ant-da-tela")] : []),
    ],
  };
}

const linhasDoJev = (b: Banco) => b.llm_calls.filter((l) => l.provider === "typesafe");
const linhasDaIaDeSempre = (b: Banco) => b.llm_calls.filter((l) => l.provider !== "typesafe");
const alertas = (rpcs: Linha[]) => rpcs.filter((r) => r["p_event_type"] === "ai.sentiment_alert");

describe("o Jev no worker de clima", () => {
  beforeEach(() => {
    chamadasAoJev = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("modo decide: a nota do Jev vale, a IA de sempre NÃO roda, e a linha dele diz a verdade", async () => {
    fornecedor(async () => respostaDoJev(0));
    const { resultado, banco, rpcs } = await rodar(jevLigado("decide"));

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0 });
    expect(generateObject, "a IA de sempre rodou com o Jev decidindo").not.toHaveBeenCalled();

    // O que saiu para o fornecedor: a chave da organização e a versão fixada.
    expect(chamadasAoJev).toHaveLength(1);
    expect(chamadasAoJev[0]!.autorizacao).toBe(`Bearer ${CHAVE_DO_JEV}`);
    expect(chamadasAoJev[0]!.corpo.model).toBe("jev-1.13.0");
    expect(chamadasAoJev[0]!.corpo.state).toBe("já é a terceira vez que eu peço isso");

    expect(banco.llm_calls).toHaveLength(1);
    const linha = banco.llm_calls[0]!;
    expect(linha).toMatchObject({
      purpose: "sentiment_classify",
      provider: "typesafe",
      model: "typesafe/jev-1.13.0",
      status: "ok",
      origem_da_escolha: "jev",
      input_tokens: 388,
      output_tokens: 18,
    });
    // 388 tokens x US$ 0,042/Mtok = 0,0016296 centavo — fração, nunca o 1 do ceil.
    expect(linha.cost_cents as number).toBeCloseTo(0.0016296, 9);
    expect(typeof linha.latency_ms).toBe("number");

    expect(banco.messages[0]!.metadata).toMatchObject({
      sentiment_score: 0,
      sentiment_engine: "jev",
      sentiment_jev_score: 0,
      sentiment_jev_model: "jev-1.13.0",
    });
    // A passagem para humano sabe que foi o Jev (D11).
    expect(alertas(rpcs)).toHaveLength(1);
    expect(alertas(rpcs)[0]!["p_payload"]).toMatchObject({ sentiment_score: 0, sentiment_engine: "jev" });
  });

  it("modo observação: os dois medem, a IA de sempre decide, as duas notas ficam guardadas", async () => {
    // O Jev acha o cliente ótimo (1,0); a IA de sempre acha irritado (0,2). Quem
    // decide é a de sempre — e é por isso que o alerta sai.
    fornecedor(async () => respostaDoJev(4));
    const { resultado, banco, rpcs } = await rodar(jevLigado("observacao"));

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0.2 });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(banco.messages[0]!.metadata).toMatchObject({
      sentiment_score: 0.2,
      sentiment_engine: "llm",
      sentiment_jev_score: 1,
      sentiment_jev_model: "jev-1.13.0",
    });
    expect(linhasDoJev(banco)).toHaveLength(1);
    // Execuções diz o que aconteceu NESTA mensagem: o Jev observou, não decidiu.
    expect(linhasDoJev(banco)[0]).toMatchObject({ status: "ok", origem_da_escolha: "jev_observacao" });
    expect(linhasDaIaDeSempre(banco)).toHaveLength(1);
    expect(linhasDaIaDeSempre(banco)[0]).toMatchObject({ status: "ok", origem_da_escolha: null });
    expect(alertas(rpcs)[0]!["p_payload"]).toMatchObject({ sentiment_engine: "llm" });
  });

  it("o Jev cai na rede: a IA de sempre mede no lugar dele, sem linha de erro e sem aviso", async () => {
    fornecedor(async () => {
      throw new TypeError("fetch failed");
    });
    const { resultado, banco } = await rodar(jevLigado("decide"));

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0.2 });
    expect(chamadasAoJev).toHaveLength(1);
    expect(linhasDoJev(banco), "falha que a reserva cobriu não é erro para quem opera").toHaveLength(0);
    expect(linhasDaIaDeSempre(banco)[0]).toMatchObject({ status: "ok", origem_da_escolha: "reserva_do_jev" });
    expect(banco.messages[0]!.metadata).toMatchObject({ sentiment_engine: "llm" });
    expect(banco.messages[0]!.metadata).not.toHaveProperty("sentiment_jev_score");
    expect(banco.agent_inbox_items, "queda de rede passa sozinha — não pede ação").toHaveLength(0);
  });

  it("chave recusada: a reserva mede e UM aviso abre na Central, por mais mensagens que cheguem", async () => {
    fornecedor(async () => new Response(JSON.stringify({ detail: { error_type: "authentication_error" } }), { status: 401 }));
    const cenario = jevLigado("decide");
    const primeira = await rodar(cenario);
    const segunda = await rodar(cenario, primeira.banco);

    expect(segunda.resultado).toEqual({ skipped: false, sentiment_score: 0.2 });
    expect(chamadasAoJev).toHaveLength(2);
    const avisos = segunda.banco.agent_inbox_items;
    expect(avisos, "dedupe pelo título aberto").toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      organization_id: ORG,
      kind: "other",
      severity: "warn",
      title: AVISO_DO_JEV.titulo,
    });
    expect(avisos[0]!.body).toContain(O_QUE_FAZER_DO_JEV.jev_credencial_invalida);
    expect(avisos[0]!.body).toContain(AVISO_DO_JEV.comReserva);
    expect(linhasDoJev(segunda.banco)).toHaveLength(0);
    expect(linhasDaIaDeSempre(segunda.banco).map((l) => l.origem_da_escolha)).toEqual([
      "reserva_do_jev",
      "reserva_do_jev",
    ]);
  });

  it("sem IA de linguagem, o Jev decide mesmo no modo observação", async () => {
    fornecedor(async () => respostaDoJev(2));
    const { resultado, banco } = await rodar(jevLigado("observacao", false));

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0.5 });
    expect(generateObject).not.toHaveBeenCalled();
    expect(banco.llm_calls).toHaveLength(1);
    expect(banco.llm_calls[0]).toMatchObject({ provider: "typesafe", status: "ok" });
    expect(banco.messages[0]!.metadata).toMatchObject({ sentiment_engine: "jev", sentiment_score: 0.5 });
  });

  it("a versão gravada é a que o fornecedor devolveu, não a que o sistema fixou", async () => {
    // Com o dublê devolvendo a MESMA versão que pedimos, gravar a fixada e gravar
    // a devolvida dariam a mesma linha — e o teste não distinguiria as duas.
    fornecedor(async () => respostaDoJev(0, "jev-1.14.0"));
    const { banco } = await rodar(jevLigado("decide"));

    expect(chamadasAoJev[0]!.corpo.model, "o pedido continua com a versão fixada").toBe("jev-1.13.0");
    expect(banco.llm_calls).toHaveLength(1);
    // Versão sem preço na tabela: custo desconhecido (`null`), nunca o preço de outra.
    expect(banco.llm_calls[0]).toMatchObject({ model: "typesafe/jev-1.14.0", cost_cents: null });
    expect(banco.messages[0]!.metadata).toMatchObject({ sentiment_jev_model: "jev-1.14.0" });
  });

  it("observação com a IA de sempre caindo: a nota do Jev vale, em vez de ninguém ser chamado", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("Overloaded"));
    fornecedor(async () => respostaDoJev(0));
    const { resultado, banco, rpcs } = await rodar(jevLigado("observacao"));

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0 });
    expect(generateObject).toHaveBeenCalledTimes(1);
    // Em observação, mas foi a nota dele que decidiu: a linha diz "jev", não "jev_observacao".
    expect(linhasDoJev(banco)[0]).toMatchObject({ status: "ok", origem_da_escolha: "jev" });
    expect(linhasDaIaDeSempre(banco)[0], "a falha da IA de sempre segue visível em Execuções").toMatchObject({
      status: "erro",
      // Sem consequência na tela: o Jev já tinha medido.
      origem_da_escolha: "jev_cobriu",
    });
    expect(banco.messages[0]!.metadata).toMatchObject({ sentiment_score: 0, sentiment_engine: "jev" });
    expect(alertas(rpcs)[0]!["p_payload"]).toMatchObject({ sentiment_score: 0, sentiment_engine: "jev" });
  });

  it("sem IA de linguagem e o disjuntor aberto: nada sai, e o motivo é o do Jev, não 'falta chave'", async () => {
    fornecedor(async () => respostaDoJev(0));
    registrarFalha(ORG, "limite_de_taxa", Date.now());
    const { resultado, banco } = await rodar(jevLigado("decide", false));

    expect(resultado).toEqual({ skipped: true, reason: "jev_disjuntor_aberto" });
    expect(chamadasAoJev).toHaveLength(0);
    expect(banco.llm_calls).toHaveLength(0);
  });

  it("sem IA de linguagem e o Jev recusando: linha de erro com código próprio e aviso crítico", async () => {
    // O único caso em que ninguém mediu — e é o único que vira erro em Execuções.
    fornecedor(async () => new Response("{}", { status: 402 }));
    const { resultado, banco } = await rodar(jevLigado("decide", false));

    expect(resultado).toEqual({ skipped: true, reason: "jev_falhou_sem_reserva" });
    expect(banco.llm_calls).toHaveLength(1);
    expect(banco.llm_calls[0]).toMatchObject({
      provider: "typesafe",
      model: "typesafe/jev-1.13.0",
      status: "erro",
      error_code: "jev_sem_credito",
      origem_da_escolha: "jev",
      cost_cents: 0,
    });
    expect(banco.agent_inbox_items).toHaveLength(1);
    expect(banco.agent_inbox_items[0]).toMatchObject({ severity: "critical" });
    expect(banco.agent_inbox_items[0]!.body).toContain(AVISO_DO_JEV.semReserva);
  });

  it("Jev desligado: nenhuma chamada ao fornecedor e nenhuma linha dele, mesmo com a chave cadastrada", async () => {
    fornecedor(async () => respostaDoJev(0));
    const cenario = jevLigado("decide");
    cenario.settings = { llm: { provider: "anthropic" }, jev: { ligado: false, modo: "decide", aceite: ACEITE } };
    const { resultado, banco } = await rodar(cenario);

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0.2 });
    expect(chamadasAoJev).toHaveLength(0);
    expect(linhasDoJev(banco)).toHaveLength(0);
    // O caminho de antes do Jev, byte a byte: sem origem, sem motor novo na linha.
    expect(linhasDaIaDeSempre(banco)[0]).toMatchObject({ status: "ok", origem_da_escolha: null });
  });

  it("disjuntor aberto: a pergunta não sai e a IA de sempre mede como reserva", async () => {
    fornecedor(async () => respostaDoJev(0));
    registrarFalha(ORG, "limite_de_taxa", Date.now());
    const { resultado, banco } = await rodar(jevLigado("decide"));

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0.2 });
    expect(chamadasAoJev).toHaveLength(0);
    expect(linhasDoJev(banco)).toHaveLength(0);
    expect(linhasDaIaDeSempre(banco)[0]).toMatchObject({ origem_da_escolha: "reserva_do_jev" });
  });

  it("fornecedor lento: o teto corta em ~1,5 s e a reserva assume", async () => {
    // O dreno roda os handlers em série: cada segundo aqui atrasa a fila inteira.
    fornecedor(
      (init) =>
        new Promise<Response>((_ok, falha) => {
          init.signal?.addEventListener("abort", () => falha(new DOMException("abortado", "AbortError")));
        }),
    );
    const inicio = performance.now();
    const { resultado, banco } = await rodar(jevLigado("decide"));
    const duracao = performance.now() - inicio;

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0.2 });
    expect(duracao, "o worker esperou o fornecedor além do teto").toBeLessThan(2_000);
    expect(duracao, "cortou antes do teto — então não foi o teto que cortou").toBeGreaterThanOrEqual(1_400);
    expect(linhasDaIaDeSempre(banco)[0]).toMatchObject({ origem_da_escolha: "reserva_do_jev" });
  });
});

// ── O aviso da Central diz o desfecho de verdade, e se fecha sozinho ─────────

describe("o aviso do Jev na Central", () => {
  beforeEach(() => {
    chamadasAoJev = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const recusa402 = async () => new Response("{}", { status: 402 });

  it("a reserva existe mas TAMBÉM cai: o aviso é crítico e não afirma que ela mede", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("Overloaded"));
    fornecedor(recusa402);
    const { resultado, banco } = await rodar(jevLigado("decide"));

    expect(resultado).toEqual({ skipped: true, reason: "classify_failed" });
    expect(banco.agent_inbox_items).toHaveLength(1);
    expect(banco.agent_inbox_items[0]).toMatchObject({ severity: "critical" });
    expect(banco.agent_inbox_items[0]!.body).toContain(AVISO_DO_JEV.semReserva);
    expect(banco.agent_inbox_items[0]!.body).not.toContain(AVISO_DO_JEV.comReserva);
    // A linha de erro da IA de sempre não diz "mediu no lugar dele".
    expect(linhasDaIaDeSempre(banco)[0]).toMatchObject({ status: "erro", origem_da_escolha: null });
  });

  it("o aviso aberto acompanha o desfecho: coberto vira crítico quando a reserva some", async () => {
    fornecedor(async () => new Response(JSON.stringify({ detail: { error_type: "authentication_error" } }), { status: 401 }));
    const cenario = jevLigado("decide");
    const primeira = await rodar(cenario);
    expect(primeira.banco.agent_inbox_items[0]).toMatchObject({ severity: "warn" });

    // A reserva cai também; o aviso aberto é o MESMO, atualizado — não um segundo.
    vi.mocked(generateObject).mockRejectedValue(new Error("Overloaded"));
    fornecedor(recusa402);
    const segunda = await rodar(cenario, primeira.banco);
    expect(segunda.banco.agent_inbox_items).toHaveLength(1);
    expect(segunda.banco.agent_inbox_items[0]).toMatchObject({ severity: "critical", status: "open" });
    expect(segunda.banco.agent_inbox_items[0]!.body).toContain(O_QUE_FAZER_DO_JEV.jev_sem_credito);
    expect(segunda.banco.agent_inbox_items[0]!.body).toContain(AVISO_DO_JEV.semReserva);
  });

  it("o Jev volta a medir: o aviso aberto se fecha sozinho", async () => {
    fornecedor(recusa402);
    const cenario = jevLigado("decide");
    const primeira = await rodar(cenario);
    expect(primeira.banco.agent_inbox_items[0]).toMatchObject({ status: "open" });

    fornecedor(async () => respostaDoJev(4));
    const segunda = await rodar(cenario, primeira.banco);
    expect(segunda.resultado).toEqual({ skipped: false, sentiment_score: 1 });
    expect(segunda.banco.agent_inbox_items).toHaveLength(1);
    expect(segunda.banco.agent_inbox_items[0]).toMatchObject({ status: "resolved" });
    // A convenção do repo (`lib/event-log/aviso-do-laco.ts`, baseline): resolver
    // carimba o quando. Sem ele a Central mostra um aviso fechado sem data.
    expect(segunda.banco.agent_inbox_items[0]!.resolved_at).toEqual(expect.any(String));
  });

  // ── A queda que "passa sozinha" e não passa ─────────────────────────────────
  //
  // Sem IA de linguagem, fora do ar / lento / ilegível não exigem ação, mas
  // deixam o clima sem medição do mesmo jeito. As falhas anteriores entram pelo
  // disjuntor com relógio no passado: é o estado que ele teria depois de uns
  // 10 minutos de fornecedor caído, e fechado agora para a próxima tentativa.
  const foraDoAr = async () => new Response("{}", { status: 503 });
  function falhasAnteriores(n: number): void {
    const haDezMinutos = Date.now() - 10 * 60_000;
    for (let i = 0; i < n; i++) registrarFalha(ORG, "provedor_indisponivel", haDezMinutos);
  }

  it("sem IA de linguagem, a 4ª falha seguida que passa sozinha ainda não avisa (controle)", async () => {
    fornecedor(foraDoAr);
    falhasAnteriores(3);
    const { resultado, banco } = await rodar(jevLigado("decide", false));

    expect(chamadasAoJev, "a 4ª tentativa saiu").toHaveLength(1);
    expect(resultado).toEqual({ skipped: true, reason: "jev_falhou_sem_reserva" });
    expect(banco.agent_inbox_items).toHaveLength(0);
  });

  it("sem IA de linguagem, a 5ª falha seguida abre UM aviso crítico — e ele fecha quando o Jev volta", async () => {
    fornecedor(foraDoAr);
    falhasAnteriores(4);
    const cenario = jevLigado("decide", false);
    const primeira = await rodar(cenario);

    expect(chamadasAoJev).toHaveLength(1);
    expect(primeira.banco.agent_inbox_items).toHaveLength(1);
    const aviso = primeira.banco.agent_inbox_items[0]!;
    expect(aviso).toMatchObject({ title: AVISO_DO_JEV.titulo, severity: "critical", status: "open" });
    expect(aviso.body).toContain(O_QUE_FAZER_DO_JEV.jev_provedor_indisponivel);
    expect(aviso.body).toContain(AVISO_DO_JEV.semReserva);
    expect(aviso.body).toContain(AVISO_DO_JEV.quedaSustentada);
    expect(aviso.body).toContain(AVISO_DO_JEV.rearme);

    // Passados os 5 minutos do disjuntor, o Jev responde: o mesmo aviso se fecha.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      fornecedor(async () => respostaDoJev(4));
      const segunda = await rodar(cenario, primeira.banco);
      expect(segunda.resultado).toEqual({ skipped: false, sentiment_score: 1 });
      expect(segunda.banco.agent_inbox_items).toHaveLength(1);
      expect(segunda.banco.agent_inbox_items[0]).toMatchObject({ status: "resolved" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("com IA de linguagem, a queda do Jev não avisa: a reserva mede no lugar dele", async () => {
    fornecedor(foraDoAr);
    falhasAnteriores(4);
    const { resultado, banco } = await rodar(jevLigado("decide"));

    expect(resultado).toEqual({ skipped: false, sentiment_score: 0.2 });
    expect(banco.agent_inbox_items).toHaveLength(0);
  });

  it("o aviso aberto em outro idioma é o mesmo aviso — trocar o idioma não abre um segundo", async () => {
    fornecedor(recusa402);
    const cenario = jevLigado("decide");
    const banco = montarBanco(cenario);
    banco.agent_inbox_items.push({
      organization_id: ORG,
      kind: "other",
      severity: "warn",
      status: "open",
      title: traduzir(AVISO_DO_JEV.titulo, "es"),
      body: "texto antigo",
    });
    const { banco: depois } = await rodar(cenario, banco);
    expect(depois.agent_inbox_items).toHaveLength(1);
    expect(depois.agent_inbox_items[0]!.title).toBe(AVISO_DO_JEV.titulo);
  });
});
