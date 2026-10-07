/**
 * GET/PATCH /api/v1/ai/jev — o cartão do Jev e o interruptor dele.
 *
 * O PATCH é a porta que manda a mensagem do cliente para fora do país: aqui se
 * prova que ela só abre com papel de admin, chave validada e, na primeira vez,
 * o aceite explícito (LGPD, D6); que a organização é a da sessão; e que pedir o
 * estado que já vale não escreve nem audita.
 *
 * O dublê do banco devolve no máximo 1000 linhas por leitura sem `range`, como o
 * PostgREST (`max_rows`): a contagem da semana só passa de 1000 se a rota
 * paginar de verdade.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { haQuemAtendaAOrganizacao } from "@/lib/ai/agents/quem-atende-a-sessao";
import { TAREFA_DO_FOLLOWUP } from "@/lib/ai/decisao/tarefas";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { DEFAULT_SENTIMENT_THRESHOLD } from "@/lib/ai/prompts/sentiment";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET, PATCH } from "./route";

import type * as Credenciais from "@/lib/agent-engine/edge/llm/credentials";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));
// O portão de quem atende fala `pg`, não o supabase-js: o dublê responde por ele.
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({ query: vi.fn() })) }));
vi.mock("@/lib/ai/agents/quem-atende-a-sessao", () => ({ haQuemAtendaAOrganizacao: vi.fn() }));
// "A empresa tem a IA de sempre?" do roteador (decisão B, doc 89). Padrão: tem.
const { temIaDeSempre } = vi.hoisted(() => ({ temIaDeSempre: vi.fn(async () => true) }));
vi.mock("@/lib/agent-engine/edge/llm/credentials", async (original) => ({
  ...(await original<typeof Credenciais>()),
  temIaDeSempre,
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const ACEITE_ANTIGO = { em: "2026-09-01T12:00:00.000Z", por: USUARIO };

type Linha = Record<string, unknown>;

interface Consulta {
  cliente: "admin" | "sessao";
  tabela: string;
  /** O texto do `select(…)` — é por ali que a rota pede `metadata->…` (alias incluído). */
  colunas: string | null;
  eq: Array<[string, unknown]>;
  /** `.not(col, "is", valor)` — só `jev_observacoes` os aplica (as outras leituras não dependem deles aqui). */
  nao: Array<[string, unknown]>;
  /** `.neq(col, valor)` — idem; como no SQL, o nulo não passa. */
  neq: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  range: [number, number] | null;
  patch: Linha | null;
  /** `select(…, { head: true })`: só a contagem, sem linhas. */
  head: boolean;
}

interface Estado {
  settings: Linha;
  credenciais: Linha[];
  llmCalls: Linha[];
  mensagens: Linha[];
  observacoes: Linha[];
  /** `org_guardrail_layers`. */
  camadas: Linha[];
  /** `ai_routers`. */
  roteadores: Linha[];
  /** `followup_flow_pointers`, com a versão ativa embutida (`versao: { graph }`). */
  fluxos: Linha[];
  /** `followup_flow_versions` com inscrição que ainda anda — o que o `!inner` devolve (`graph`). */
  versoesEmCurso: Linha[];
  consultas: Consulta[];
}

let estado: Estado;
let papel: Role;

/** O teto do PostgREST sem `range` (`supabase/config.toml`, `max_rows`). */
const MAX_ROWS = 1000;

function cliente(tipo: Consulta["cliente"]) {
  return {
    from(tabela: string) {
      const c: Consulta = { cliente: tipo, tabela, colunas: null, eq: [], nao: [], neq: [], gte: [], range: null, patch: null, head: false };
      estado.consultas.push(c);
      const linhasDaTabela = (): Linha[] => {
        const base =
          tabela === "ai_provider_credentials"
            ? estado.credenciais
            : tabela === "llm_calls"
              ? estado.llmCalls
              : tabela === "jev_observacoes"
                ? estado.observacoes.filter(
                    (l) =>
                      c.nao.every(([col, v]) => l[col] !== v) &&
                      c.neq.every(([col, v]) => l[col] !== null && l[col] !== undefined && l[col] !== v),
                  )
                : tabela === "org_guardrail_layers"
                  ? estado.camadas
                  : tabela === "ai_routers"
                    ? estado.roteadores
                    : tabela === "followup_flow_pointers"
                      ? estado.fluxos
                      : tabela === "followup_flow_versions"
                        ? estado.versoesEmCurso
                        : estado.mensagens;
        const filtradas = base.filter((l) => c.eq.every(([col, v]) => !(col in l) || l[col] === v));
        return c.range ? filtradas.slice(c.range[0], c.range[1] + 1) : filtradas.slice(0, MAX_ROWS);
      };
      const chain = {
        select: (colunas?: string, opcoes?: { head?: boolean }) => {
          c.head = opcoes?.head === true;
          c.colunas = colunas ?? null;
          return chain;
        },
        not: (col: string, _op: string, v: unknown) => {
          c.nao.push([col, v]);
          return chain;
        },
        or: () => chain,
        gte: (col: string, v: unknown) => {
          c.gte.push([col, v]);
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        eq: (col: string, v: unknown) => {
          c.eq.push([col, v]);
          return chain;
        },
        neq: (col: string, v: unknown) => {
          c.neq.push([col, v]);
          return chain;
        },
        range: (de: number, ate: number) => {
          c.range = [de, ate];
          return chain;
        },
        update: (patch: Linha) => {
          c.patch = patch;
          return chain;
        },
        maybeSingle: async () => {
          expect(tabela).toBe("organizations");
          if (c.patch) estado.settings = c.patch.settings as Linha;
          return { data: { settings: estado.settings }, error: null };
        },
        // `jev_observacoes` é lida por contagem (`head`): o PostgREST devolve
        // `count`, sem linhas; sem `head`, as linhas e a contagem.
        then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve(
            tabela === "jev_observacoes"
              ? { data: c.head ? null : linhasDaTabela(), count: linhasDaTabela().length, error: null }
              : { data: linhasDaTabela(), error: null },
          ).then(ok, erro),
      };
      return chain;
    },
  };
}

function credencial(over: Linha = {}): Linha {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    organization_id: ORG,
    label: "Jev da loja",
    provider: "typesafe",
    is_active: true,
    validated_at: "2026-09-20T12:00:00.000Z",
    validation_error: null,
    created_at: "2026-09-20T12:00:00.000Z",
    ...over,
  };
}

function chamada(over: Linha = {}): Linha {
  return {
    purpose: "sentiment_classify",
    provider: "typesafe",
    status: "ok",
    origem_da_escolha: "jev",
    error_code: null,
    cost_cents: 0.00042,
    latency_ms: 300,
    created_at: "2026-09-22T12:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  papel = "admin";
  estado = {
    settings: { branding: { app_name: "Loja" }, llm: { provider: "anthropic" } },
    credenciais: [],
    llmCalls: [],
    mensagens: [],
    observacoes: [],
    camadas: [],
    roteadores: [],
    fluxos: [],
    versoesEmCurso: [],
    consultas: [],
  };
  vi.mocked(requireRole).mockImplementation(async (min) =>
    roleAtLeast(papel, min)
      ? ({
          ok: true,
          user: { id: USUARIO, idioma: "pt-BR" },
          org: { orgId: ORG, role: papel },
        } as unknown as Awaited<ReturnType<typeof requireRole>>)
      : { ok: false, response: fail("forbidden_role", "sem permissão", 403) },
  );
  vi.mocked(createClient).mockResolvedValue(
    cliente("sessao") as unknown as Awaited<ReturnType<typeof createClient>>,
  );
  vi.mocked(createAdminClient).mockReturnValue(
    cliente("admin") as unknown as ReturnType<typeof createAdminClient>,
  );
  vi.mocked(resolverModeloDoPonto).mockResolvedValue({
    model: {} as never,
    modelId: "anthropic/claude-haiku-4-5",
    origem: "padrao",
  });
  vi.mocked(haQuemAtendaAOrganizacao).mockResolvedValue(true);
});

async function ler() {
  const res = await GET();
  return { status: res.status, corpo: await res.json() };
}

async function mudar(corpo: unknown) {
  const res = await PATCH(
    new NextRequest("http://localhost/api/v1/ai/jev", {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
  );
  return { status: res.status, corpo: await res.json() };
}

const escritas = () => estado.consultas.filter((c) => c.patch !== null);

describe("GET /api/v1/ai/jev", () => {
  it("instalação sem nada: sem chave, desligado, e as tarefas que o Jev sabe fazer", async () => {
    const { status, corpo } = await ler();
    expect(status).toBe(200);
    const d = corpo.data;
    expect(d.provedor.rotulo).toBe("Jev (TypeSafe AI)");
    expect(d.chave).toEqual({
      existe: false,
      validada: false,
      credencial_id: null,
      rotulo: null,
      erro_de_validacao: null,
    });
    expect(d.config).toEqual({ ligado: false, modo: "observacao", modo_roteador: "comparacao", aceite: null });
    expect(d.tarefas.map((t: { id: string }) => t.id)).toEqual([
      "sentiment_classify",
      "jailbreak_detect",
      "intent_router",
      "followup_classify",
      "afirmacao_de_fato",
    ]);
    expect(d.tem_ia_de_sempre).toBe(true);
    expect(d.numeros).toEqual({
      dias: 7,
      decisoes: 0,
      custo_cents: 0,
      custo_incompleto: false,
      latencia_media_ms: null,
      reservas: 0,
      irritados: 0,
      observacao: { dias: 30, comparadas: 0, concordaram: 0 },
    });
    expect(d.ultima_falha).toBeNull();
    expect(d.pode_editar).toBe(true);
  });

  it("toda leitura é da organização da sessão", async () => {
    await ler();
    expect(estado.consultas.length).toBeGreaterThanOrEqual(4);
    for (const c of estado.consultas) {
      const coluna = c.tabela === "organizations" ? "id" : "organization_id";
      expect(c.eq, c.tabela).toContainEqual([coluna, ORG]);
    }
  });

  it("a IA de sempre é a mesma pergunta do worker, e a ausência dela aparece", async () => {
    vi.mocked(resolverModeloDoPonto).mockResolvedValue(null);
    const { corpo } = await ler();
    expect(corpo.data.tem_ia_de_sempre).toBe(false);
    // A mesma pergunta do worker, com a queda para o padrão da organização:
    // sem ela, a empresa que atende pela OpenAI via "falta a IA principal".
    expect(resolverModeloDoPonto).toHaveBeenCalledWith("sentiment_classify", ORG, expect.any(String), {
      naFaltaUsarOPadraoDaOrganizacao: true,
    });
  });

  it("a chave mostrada é a que o Jev usa: a validada, não a mais nova sem teste", async () => {
    estado.credenciais = [
      credencial(),
      credencial({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        label: "colada agora",
        validated_at: null,
        created_at: "2026-09-23T12:00:00.000Z",
      }),
    ];
    const { corpo } = await ler();
    expect(corpo.data.chave).toMatchObject({
      existe: true,
      validada: true,
      credencial_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      rotulo: "Jev da loja",
    });
  });

  it("sem nenhuma validada, mostra a recusada com o motivo", async () => {
    estado.credenciais = [credencial({ validated_at: null, validation_error: "auth_failed_401" })];
    const { corpo } = await ler();
    expect(corpo.data.chave).toMatchObject({
      existe: true,
      validada: false,
      erro_de_validacao: "auth_failed_401",
    });
  });

  it("os números da semana: medidas, custo fracionário, tempo médio, reservas e a última falha", async () => {
    estado.llmCalls = [
      chamada({ cost_cents: 0.00042, latency_ms: 300 }),
      chamada({ cost_cents: 0.00084, latency_ms: 500 }),
      // versão sem preço na tabela: fora da soma, nunca zero inventado
      chamada({ cost_cents: null, latency_ms: 400 }),
      chamada({ provider: "anthropic", origem_da_escolha: "reserva_do_jev", cost_cents: 3 }),
      chamada({ provider: "anthropic", origem_da_escolha: "reserva_do_jev", status: "erro" }),
      chamada({
        status: "erro",
        error_code: "jev_credencial_invalida",
        cost_cents: 0,
        latency_ms: 90,
        created_at: "2026-09-22T13:00:00.000Z",
      }),
      // Mais ANTIGA e por último na lista: o dublê não ordena, então a última
      // falha tem de sair pela data, não pela posição.
      chamada({
        status: "erro",
        error_code: "jev_sem_credito",
        cost_cents: 0,
        latency_ms: 80,
        created_at: "2026-09-21T09:00:00.000Z",
      }),
    ];
    const { corpo } = await ler();
    const n = corpo.data.numeros;
    expect(n.decisoes).toBe(3);
    expect(n.custo_cents).toBeCloseTo(0.00126, 10);
    // A linha sem preço fica fora da soma e a soma se declara incompleta.
    expect(n.custo_incompleto).toBe(true);
    expect(n.latencia_media_ms).toBe(400);
    expect(n.reservas).toBe(1);
    expect(corpo.data.ultima_falha).toEqual({
      motivo: "jev_credencial_invalida",
      em: "2026-09-22T13:00:00.000Z",
      tarefa: "Medir o clima da conversa",
    });
  });

  /**
   * O roteador decidindo: quando o Jev não responde, a IA de sempre escolhe o
   * agente, e a linha de erro do Jev leva `reserva_do_jev`. Sem ela o cartão
   * dizia zero coberturas com o Jev estourando o teto em parte das mensagens.
   */
  it("a cobertura do roteador decidindo conta em 'Vezes que a IA de sempre cobriu o Jev'", async () => {
    estado.llmCalls = [
      chamada({
        purpose: "intent_router",
        status: "erro",
        error_code: "jev_provedor_indisponivel",
        origem_da_escolha: "reserva_do_jev",
        cost_cents: 0,
      }),
      // Controle: a falha observando (a IA decidiu de qualquer jeito) não é cobertura.
      chamada({ purpose: "intent_router", status: "erro", error_code: "jev_credencial_invalida", origem_da_escolha: "jev_observacao" }),
    ];
    const { corpo } = await ler();
    expect(corpo.data.numeros.reservas).toBe(1);
    expect(corpo.data.numeros.decisoes, "a falha não é uma resposta do Jev").toBe(0);
  });

  /**
   * Sem chave ou com o disjuntor aberto, nada sai para a rede — mas decidindo a
   * IA de sempre cobre do mesmo jeito, e isso conta. Só não é a "Última falha":
   * a linha mais nova tomaria o lugar da que abriu o disjuntor, que diz o que fazer.
   */
  it("a cobertura sem rede conta como reserva, e não esconde a falha que abriu o disjuntor", async () => {
    const semRede = (error_code: string, created_at: string) =>
      chamada({ purpose: "intent_router", status: "erro", error_code, origem_da_escolha: "reserva_do_jev", cost_cents: 0, latency_ms: null, created_at });
    estado.llmCalls = [
      chamada({
        purpose: "intent_router",
        status: "erro",
        error_code: "jev_limite_de_taxa",
        origem_da_escolha: "reserva_do_jev",
        cost_cents: 0,
        created_at: "2026-09-22T13:00:00.000Z",
      }),
      semRede("jev_disjuntor_aberto", "2026-09-22T13:01:00.000Z"),
      semRede("jev_sem_credencial", "2026-09-22T13:02:00.000Z"),
    ];
    const { corpo } = await ler();
    expect(corpo.data.numeros.reservas).toBe(3);
    expect(corpo.data.ultima_falha).toMatchObject({ motivo: "jev_limite_de_taxa", em: "2026-09-22T13:00:00.000Z" });
  });

  it("nenhuma medição com preço: o custo é desconhecido, não um zero ao lado de N decisões", async () => {
    estado.llmCalls = [chamada({ cost_cents: null }), chamada({ cost_cents: null })];
    const { corpo } = await ler();
    expect(corpo.data.numeros).toMatchObject({ decisoes: 2, custo_cents: null, custo_incompleto: true });
  });

  it("as janelas: 7 dias para os números, 30 para a concordância", async () => {
    // O dublê não filtra por data: sem esta conferência, apagar o filtro deixaria
    // o cartão dizendo "nos últimos 7 dias" com o histórico inteiro.
    await ler();
    const desde = (tabela: string) => {
      const c = estado.consultas.find((x) => x.tabela === tabela);
      const par = c?.gte.find(([col]) => col === "created_at");
      return par ? Date.parse(String(par[1])) : NaN;
    };
    const dia = 24 * 60 * 60 * 1000;
    expect(Math.abs(desde("llm_calls") - (Date.now() - 7 * dia))).toBeLessThan(5_000);
    expect(Math.abs(desde("messages") - (Date.now() - 30 * dia))).toBeLessThan(5_000);
    // A segunda leitura de mensagens é a dos clientes irritados: janela da semana.
    const percebidas = estado.consultas.filter((x) => x.tabela === "messages")[1];
    const par = percebidas?.gte.find(([col]) => col === "created_at");
    expect(Math.abs(Date.parse(String(par?.[1])) - (Date.now() - 7 * dia))).toBeLessThan(5_000);
  });

  it("clientes irritados: conversas com a nota DO JEV abaixo do mesmo limiar da passagem para humano", async () => {
    const T = DEFAULT_SENTIMENT_THRESHOLD;
    estado.mensagens = [
      { conversa: "c1", nota_do_jev: T - 0.2 },
      { conversa: "c1", nota_do_jev: T - 0.1 }, // o mesmo cliente de novo: conta uma vez
      { conversa: "c2", nota_do_jev: T - 0.01 }, // colado no corte, abaixo
      { conversa: "c3", nota_do_jev: T }, // no corte não é "abaixo"
      { conversa: "c4", nota_do_jev: T + 0.01 },
      { conversa: "c5", nota_do_jev: null },
    ];
    const { corpo } = await ler();
    expect(corpo.data.numeros.irritados).toBe(2);
  });

  it("falha que o Jev já superou (mediu depois dela) não aparece como última falha", async () => {
    estado.llmCalls = [
      chamada({ created_at: "2026-09-22T12:00:00.000Z" }),
      chamada({ status: "erro", error_code: "jev_limite_de_taxa", created_at: "2026-09-22T11:00:00.000Z" }),
    ];
    const { corpo } = await ler();
    expect(corpo.data.numeros.decisoes).toBe(1);
    expect(corpo.data.ultima_falha).toBeNull();
  });

  it("a medida de uma tarefa não supera a falha de OUTRA: o clima medindo não apaga a pergunta recusada da manipulação", async () => {
    estado.llmCalls = [
      chamada({
        purpose: "jailbreak_detect",
        status: "erro",
        error_code: "jev_contrato_invalido",
        created_at: "2026-09-22T11:00:00.000Z",
      }),
      chamada({ created_at: "2026-09-22T12:00:00.000Z" }),
    ];
    const { corpo } = await ler();
    // Diz QUAL tarefa parou: o disjuntor da pergunta recusada é por tarefa.
    expect(corpo.data.ultima_falha).toEqual({
      motivo: "jev_contrato_invalido",
      em: "2026-09-22T11:00:00.000Z",
      tarefa: "Perceber tentativa de manipulação",
    });
  });

  it("pagina: mais de 1000 execuções na semana contam todas", async () => {
    estado.llmCalls = Array.from({ length: 2500 }, () => chamada());
    const { corpo } = await ler();
    expect(corpo.data.numeros.decisoes).toBe(2500);
    const paginas = estado.consultas.filter((c) => c.tabela === "llm_calls");
    expect(paginas.map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("concordância: as duas notas do MESMO lado do limiar de passagem para humano", async () => {
    const T = DEFAULT_SENTIMENT_THRESHOLD;
    estado.mensagens = [
      { nota: T - 0.2, nota_do_jev: T - 0.1 }, // os dois chamariam uma pessoa
      { nota: T + 0.5, nota_do_jev: T - 0.2 }, // só o Jev chamaria
      { nota: T - 0.01, nota_do_jev: T + 0.01 }, // um de cada lado do corte
      { nota: T, nota_do_jev: T + 0.3 }, // no corte não é "abaixo": nenhum chamaria
      // Colado nos dois lados do corte: qualquer limiar diferente do real (um
      // 0,5 "neutro" digitado na rota) muda a contagem.
      { nota: T + 0.02, nota_do_jev: T - 0.02 },
      { nota: 0.5, nota_do_jev: null }, // sem par, não entra
    ];
    const { corpo } = await ler();
    expect(corpo.data.numeros.observacao).toEqual({ dias: 30, comparadas: 5, concordaram: 2 });
    const consulta = estado.consultas.find((c) => c.tabela === "messages");
    expect(consulta?.eq).toContainEqual(["metadata->>sentiment_engine", "llm"]);
  });

  /**
   * Issue #2219, ponta 2: o corte da concordância é o limiar GRAVADO na própria
   * mensagem (o `config.sentiment_threshold` do agente da conversa, #2216), não
   * o `DEFAULT_SENTIMENT_THRESHOLD`. O par discriminante é nota 0,2 × 0,05 com
   * limiar 0,1: a IA ficou ACIMA do corte do agente e o Jev ABAIXO —
   * discordaram. Contado contra 0,3 os dois estariam abaixo e concordariam,
   * que é exatamente o defeito.
   *
   * A mensagem antiga, gravada antes do #2219, não tem a chave: cai no padrão —
   * e uma chave corrompida nunca corta no escuro, também no padrão.
   */
  it("concordância: cada mensagem é cortada pelo limiar GRAVADO nela, com o padrão para as antigas", async () => {
    estado.mensagens = [
      { nota: 0.2, nota_do_jev: 0.05, limiar: 0.1 }, // agente em 0,1: discordaram
      { nota: 0.05, nota_do_jev: 0.02, limiar: 0.1 }, // agente em 0,1: os dois abaixo, concordam
      { nota: 0.2, nota_do_jev: 0.05 }, // mensagem antiga: sem chave, padrão 0,3, concordam
      { nota: 0.8, nota_do_jev: 0.7, limiar: "0.1" }, // chave corrompida: padrão, concordam
    ];
    const { corpo } = await ler();
    expect(corpo.data.numeros.observacao).toEqual({ dias: 30, comparadas: 4, concordaram: 3 });
    // A rota tem de PEDIR a chave ao banco: sem o alias no `select`, a leitura
    // volta `undefined` e a conta cai no padrão para toda mensagem, nova ou não.
    const consulta = estado.consultas.find((c) => c.tabela === "messages");
    expect(consulta?.colunas).toContain("limiar:metadata->sentiment_threshold");
  });

  /**
   * A mesma ponta em `irritadosPercebidos`: um agente em 0,1 não deveria ter o
   * cliente com nota 0,2 contado como irritado (contra 0,3 seria). Conversa
   * única por mensagem, como a conta pede.
   */
  it("clientes irritados: o corte de cada mensagem também vem do limiar gravado", async () => {
    estado.mensagens = [
      { conversa: "c1", nota_do_jev: 0.2, limiar: 0.1 }, // acima de 0,1: NÃO conta (contra 0,3 contaria)
      { conversa: "c2", nota_do_jev: 0.05, limiar: 0.1 }, // abaixo de 0,1: conta
      { conversa: "c3", nota_do_jev: 0.2 }, // mensagem antiga: padrão 0,3, abaixo: conta
      { conversa: "c4", nota_do_jev: 0.8, limiar: 0.1 }, // acima de 0,1: não conta
    ];
    const { corpo } = await ler();
    expect(corpo.data.numeros.irritados).toBe(2);
    const consultas = estado.consultas.filter((x) => x.tabela === "messages");
    expect(consultas[1]?.colunas).toContain("limiar:metadata->sentiment_threshold");
  });
});

describe("PATCH /api/v1/ai/jev", () => {
  it("exige admin: gerente lê o cartão, mas não liga", async () => {
    papel = "manager";
    estado.credenciais = [credencial()];
    expect((await ler()).status).toBe(200);
    const { status } = await mudar({ ligado: true, aceite_lgpd: true });
    expect(status).toBe(403);
    expect(escritas()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("ligar sem chave validada é recusado com código próprio", async () => {
    estado.credenciais = [credencial({ validated_at: null })];
    const { status, corpo } = await mudar({ ligado: true, aceite_lgpd: true });
    expect(status).toBe(422);
    expect(corpo.error.code).toBe("jev_exige_chave_validada");
    expect(escritas()).toEqual([]);
  });

  it("a chave validada de OUTRA organização não liga o Jev desta", async () => {
    // A leitura é pelo cliente admin, que passa por cima da RLS: o filtro de
    // organização é a única cerca, e sem este caso apagá-lo passava verde.
    estado.credenciais = [credencial({ organization_id: OUTRA_ORG })];
    const { status, corpo } = await mudar({ ligado: true, aceite_lgpd: true });
    expect(status).toBe(422);
    expect(corpo.error.code).toBe("jev_exige_chave_validada");
    expect(escritas()).toEqual([]);
  });

  it("ligar pela primeira vez sem o aceite é recusado com código próprio", async () => {
    estado.credenciais = [credencial()];
    const { status, corpo } = await mudar({ ligado: true });
    expect(status).toBe(422);
    expect(corpo.error.code).toBe("jev_exige_aceite");
    expect(corpo.error.message).toMatch(/Estados Unidos/);
    expect(escritas()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("admin em espanhol recebe as duas recusas em espanhol", async () => {
    const emEspanhol = {
      ok: true,
      user: { id: USUARIO, idioma: "es" },
      org: { orgId: ORG, role: "admin" },
    } as unknown as Awaited<ReturnType<typeof requireRole>>;

    vi.mocked(requireRole).mockResolvedValueOnce(emEspanhol);
    const semChave = await mudar({ ligado: true, aceite_lgpd: true });
    expect(semChave.corpo.error.message).toMatch(/^Para activar Jev/);

    estado.credenciais = [credencial()];
    vi.mocked(requireRole).mockResolvedValueOnce(emEspanhol);
    const semAceite = await mudar({ ligado: true });
    expect(semAceite.corpo.error.message).toMatch(/^Activar Jev envía/);
  });

  it("liga com chave e aceite: grava quem aceitou, pelo cliente admin, sem apagar o resto, e audita", async () => {
    estado.credenciais = [credencial()];
    const { status, corpo } = await mudar({ ligado: true, aceite_lgpd: true });

    expect(status).toBe(200);
    expect(corpo.data.alterado).toBe(true);
    expect(corpo.data.config.ligado).toBe(true);
    expect(corpo.data.config.aceite.por).toBe(USUARIO);

    const [escrita] = escritas();
    expect(escrita?.cliente).toBe("admin");
    expect(escrita?.eq).toContainEqual(["id", ORG]);
    expect(estado.settings.branding).toEqual({ app_name: "Loja" });
    expect(estado.settings.llm).toEqual({ provider: "anthropic" });
    expect(estado.settings.jev).toMatchObject({ ligado: true, aceite: { por: USUARIO } });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.jev.ligado",
        organizationId: ORG,
        actorUserId: USUARIO,
        resourceId: ORG,
        metadata: expect.objectContaining({ aceite_registrado: true }),
      }),
    );
  });

  it("idempotente: pedir de novo o estado que já vale não escreve nem audita", async () => {
    estado.credenciais = [credencial()];
    await mudar({ ligado: true, aceite_lgpd: true });
    const aceiteGravado = (estado.settings.jev as Linha).aceite;
    vi.mocked(audit).mockClear();
    const antes = escritas().length;

    const { status, corpo } = await mudar({ ligado: true, aceite_lgpd: true });

    expect(status).toBe(200);
    expect(corpo.data.alterado).toBe(false);
    expect(escritas().length).toBe(antes);
    expect(audit).not.toHaveBeenCalled();
    // O aceite da primeira vez não é regravado com data nova.
    expect((estado.settings.jev as Linha).aceite).toEqual(aceiteGravado);
  });

  it("religar depois de desligar não pede o aceite de novo", async () => {
    estado.credenciais = [credencial()];
    estado.settings = { jev: { ligado: false, modo: "observacao", aceite: ACEITE_ANTIGO } };
    const { status, corpo } = await mudar({ ligado: true });
    expect(status).toBe(200);
    expect(corpo.data.config.aceite).toEqual(ACEITE_ANTIGO);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ aceite_registrado: false }) }),
    );
  });

  it("organization_id no corpo é recusado, e nada é escrito em organização nenhuma", async () => {
    estado.credenciais = [credencial()];
    const { status } = await mudar({ ligado: true, aceite_lgpd: true, organization_id: OUTRA_ORG });
    expect(status).toBe(422);
    expect(escritas()).toEqual([]);
  });

  it("desligar e trocar o modo auditam cada um com a sua ação", async () => {
    estado.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE_ANTIGO } };

    await mudar({ modo: "decide" });
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "ai.jev.modo_alterado",
        metadata: expect.objectContaining({ modo: "decide", modo_anterior: "observacao" }),
      }),
    );

    await mudar({ ligado: false });
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "ai.jev.desligado" }));
    expect((estado.settings.jev as Linha).ligado).toBe(false);
    // Desligar não apaga o aceite: ele registra o que foi consentido, e quando.
    expect((estado.settings.jev as Linha).aceite).toEqual(ACEITE_ANTIGO);
  });

  it("corpo sem nada a mudar é recusado", async () => {
    expect((await mudar({})).status).toBe(422);
    expect((await mudar({ aceite_lgpd: true })).status).toBe(422);
  });
});

describe("o Jev por tarefa na rota", () => {
  it("GET: cada tarefa com o estado que vale agora — o clima, pelo `modo`, sem nada gravado", async () => {
    expect((await ler()).corpo.data.por_tarefa).toEqual([
      expect.objectContaining({ id: "clima", ponto: "sentiment_classify", estado: "desligada", novo: false }),
      expect.objectContaining({ id: "manipulacao", ponto: "jailbreak_detect", estado: "desligada", novo: false }),
      expect.objectContaining({ id: "roteador", ponto: "intent_router", estado: "desligada", novo: false }),
      // As em cascata não têm ponto: acompanham uma regra sem IA.
      expect.objectContaining({ id: "humano", ponto: null, estado: "desligada", novo: false }),
      expect.objectContaining({ id: "opt_out", ponto: null, estado: "desligada", novo: false }),
      expect.objectContaining({ id: "followup", ponto: "followup_classify", estado: "desligada", novo: false }),
      // A conferência de campo (#2234) tem alcance "conversa": nasce desligada até o aceite dela.
      expect.objectContaining({ id: "campo_do_negocio", ponto: null, estado: "desligada", novo: false }),
      // O sinal de urgência da mensagem represada (#2232): também em cascata, também sem ponto.
      expect.objectContaining({ id: "sinal_de_urgencia", ponto: null, estado: "desligada", novo: false }),
      // A conferência de fato (#2231) cabe no aceite de cada mensagem, mas com o Jev desligado nada roda.
      expect.objectContaining({ id: "afirmacao_de_fato", ponto: "afirmacao_de_fato", estado: "desligada", novo: false }),
    ]);

    estado.settings = { jev: { ligado: true, modo: "decide", aceite: ACEITE_ANTIGO } };
    const [clima] = (await ler()).corpo.data.por_tarefa;
    expect(clima).toMatchObject({ id: "clima", estado: "decidindo", novo: false, rotulo: "Medir o clima da conversa" });
  });

  it("GET: com o Jev desligado, `ao_ligar` diz como cada tarefa volta — o clima desligado não volta pelo `modo`", async () => {
    estado.settings = { jev: { ligado: false, modo: "decide", aceite: ACEITE_ANTIGO } };
    expect((await ler()).corpo.data.por_tarefa[0]).toMatchObject({ estado: "desligada", ao_ligar: "decidindo" });

    estado.settings = {
      jev: { ligado: false, modo: "decide", aceite: ACEITE_ANTIGO, tarefas: { clima: { estado: "desligada" } } },
    };
    expect((await ler()).corpo.data.por_tarefa[0]).toMatchObject({ estado: "desligada", ao_ligar: "desligada" });
  });

  it("GET: `tarefas` continua na forma da onda 1 (a página aberta durante a atualização a lê)", async () => {
    expect((await ler()).corpo.data.tarefas).toEqual([
      expect.objectContaining({ id: "sentiment_classify", rotulo: "Medir o clima da conversa" }),
      expect.objectContaining({ id: "jailbreak_detect", rotulo: "Perceber tentativa de manipulação" }),
      expect.objectContaining({ id: "intent_router", rotulo: "Escolher qual agente atende" }),
      expect.objectContaining({ id: "followup_classify", rotulo: "Ler a resposta ao follow-up" }),
      expect.objectContaining({ id: "afirmacao_de_fato", rotulo: "Conferir afirmações de fato na resposta" }),
    ]);
  });

  it("GET: a manipulação, nova, começa observando sozinha com o Jev ligado no aceite de cada mensagem (R7)", async () => {
    estado.settings = { jev: { ligado: true, modo: "decide", aceite: ACEITE_ANTIGO } };
    const manipulacao = (await ler()).corpo.data.por_tarefa.find((t: { id: string }) => t.id === "manipulacao");
    // O clima decidindo não faz a tarefa nova decidir.
    expect(manipulacao).toMatchObject({ estado: "observando", novo: true });
  });

  /**
   * A concordância das tarefas novas vem de `jev_observacoes`, contada no banco.
   * "Sem par" (`concordou` nulo: a IA de sempre não decidiu) fica fora do
   * denominador, e a linha de outra organização fora de tudo.
   */
  /**
   * O clima conta as 500 mensagens mais recentes; as outras tarefas, os 30 dias
   * inteiros no banco. Lado a lado, "X de 500" lia-se como "mediu menos".
   */
  it("GET: a concordância do clima declara o teto da amostra quando bate nele — e só então", async () => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    estado.mensagens = Array.from({ length: 500 }, () => ({ nota: 0.9, nota_do_jev: 0.8 }));
    const cheia = (await ler()).corpo.data.por_tarefa.find((t: { id: string }) => t.id === "clima");
    expect(cheia.observacao).toMatchObject({ comparadas: 500, teto_da_amostra: 500 });
    estado.mensagens = Array.from({ length: 499 }, () => ({ nota: 0.9, nota_do_jev: 0.8 }));
    const abaixo = (await ler()).corpo.data.por_tarefa.find((t: { id: string }) => t.id === "clima");
    expect(abaixo.observacao).not.toHaveProperty("teto_da_amostra");
  });

  it("GET: a concordância da manipulação sai de jev_observacoes, sem par fora da conta", async () => {
    const obs = (concordou: boolean | null, organization_id = ORG, rotulos: Linha = {}): Linha => ({
      organization_id,
      tarefa: "manipulacao",
      concordou,
      rotulo_jev: "none",
      rotulo_atual: concordou === null ? null : "none",
      ...rotulos,
    });
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    estado.observacoes = [
      obs(true),
      obs(true),
      // Só o Jev deu o forte: é o que decidir muda na manipulação.
      obs(false, ORG, { rotulo_jev: "high", rotulo_atual: "low" }),
      // Sem par: não conta em nada.
      obs(null, ORG, { rotulo_jev: "high" }),
      obs(true, OUTRA_ORG),
    ];

    const d = (await ler()).corpo.data;
    const manipulacao = d.por_tarefa.find((t: { id: string }) => t.id === "manipulacao");
    expect(manipulacao.observacao).toEqual({ dias: 30, comparadas: 3, concordaram: 2, so_o_jev_alto: 1 });
    // O roteador não tem essa conta: decidir nele troca a escolha, não soma alerta.
    const roteador = d.por_tarefa.find((t: { id: string }) => t.id === "roteador");
    expect(roteador.observacao).not.toHaveProperty("so_o_jev_alto");
    // A do clima continua sendo a das notas, também em `numeros` (a forma da onda 1).
    const clima = d.por_tarefa.find((t: { id: string }) => t.id === "clima");
    expect(clima.observacao).toEqual(d.numeros.observacao);
    const lidas = estado.consultas.filter((c) => c.tabela === "jev_observacoes");
    expect(lidas.every((c) => c.cliente === "sessao" && c.eq.some(([col, v]) => col === "organization_id" && v === ORG))).toBe(true);
    expect(lidas.every((c) => c.gte.some(([col]) => col === "created_at"))).toBe(true);
  });

  it("GET: a manipulação com a camada anti-manipulação desligada pela organização diz que não roda", async () => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    const semCamada = async () =>
      (await ler()).corpo.data.por_tarefa.map((t: { id: string; sem_camada: boolean }) => [t.id, t.sem_camada]);
    // Sem escolha da organização, vale o padrão do worker: a camada roda.
    expect(await semCamada()).toEqual([
      ["clima", false],
      ["manipulacao", false],
      ["roteador", false],
      ["humano", false],
      ["opt_out", false],
      ["followup", false],
      ["campo_do_negocio", false],
      ["sinal_de_urgencia", false],
      ["afirmacao_de_fato", false],
    ]);
    estado.camadas = [
      { organization_id: ORG, layer: "jailbreak", enabled: false },
      { organization_id: OUTRA_ORG, layer: "jailbreak", enabled: true },
    ];
    expect(await semCamada()).toEqual([
      ["clima", false],
      ["manipulacao", true],
      ["roteador", false],
      ["humano", false],
      ["opt_out", false],
      ["followup", false],
      ["campo_do_negocio", false],
      ["sinal_de_urgencia", false],
      ["afirmacao_de_fato", false],
    ]);
  });

  it("GET: o roteador, numa empresa sem roteador de intenção ativo, diz que não roda", async () => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    const semRoteador = async () =>
      (await ler()).corpo.data.por_tarefa.map((t: { id: string; sem_roteador: boolean }) => [t.id, t.sem_roteador]);
    expect(await semRoteador()).toEqual([
      ["clima", false],
      ["manipulacao", false],
      ["roteador", true],
      ["humano", false],
      ["opt_out", false],
      ["followup", false],
      ["campo_do_negocio", false],
      ["sinal_de_urgencia", false],
      ["afirmacao_de_fato", false],
    ]);
    // O ativo de OUTRA empresa não conta — o filtro é o da sessão.
    const intencoes = (n: number) => [{ count: n }];
    estado.roteadores = [{ organization_id: OUTRA_ORG, is_active: true, id: "r-outra", intencoes: intencoes(2) }];
    expect(await semRoteador()).toEqual([
      ["clima", false],
      ["manipulacao", false],
      ["roteador", true],
      ["humano", false],
      ["opt_out", false],
      ["followup", false],
      ["campo_do_negocio", false],
      ["sinal_de_urgencia", false],
      ["afirmacao_de_fato", false],
    ]);
    // Ativo, mas sem intenção nenhuma (o estado logo depois de criar um) ou com
    // mais do que cabe numa pergunta: o Jev nunca é perguntado, e "Só observa"
    // prometeria uma comparação que nunca vem.
    estado.roteadores.push({ organization_id: ORG, is_active: true, id: "r-vazio", intencoes: intencoes(0) });
    expect((await semRoteador())[2]).toEqual(["roteador", true]);
    estado.roteadores.push({ organization_id: ORG, is_active: true, id: "r-cheio", intencoes: intencoes(255) });
    expect((await semRoteador())[2]).toEqual(["roteador", true]);
    estado.roteadores.push({ organization_id: ORG, is_active: true, id: "r-nossa", intencoes: intencoes(2) });
    expect(await semRoteador()).toEqual([
      ["clima", false],
      ["manipulacao", false],
      ["roteador", false],
      ["humano", false],
      ["opt_out", false],
      ["followup", false],
      ["campo_do_negocio", false],
      ["sinal_de_urgencia", false],
      ["afirmacao_de_fato", false],
    ]);
    // E o cartão segue dizendo que a tarefa observa: é o que ela faz quando há roteador.
    const roteador = (await ler()).corpo.data.por_tarefa.find((t: { id: string }) => t.id === "roteador");
    expect(roteador).toMatchObject({ estado: "observando", novo: true });
  });

  /**
   * A do follow-up só roda onde algum follow-up PUBLICADO tem o passo
   * "Classificar (IA)": sem ele ninguém lê resposta, e "Só observa" com "ainda
   * não há mensagens medidas" seria para sempre.
   */
  it("GET: a do follow-up, sem follow-up publicado com o passo \"Classificar (IA)\", diz que não roda", async () => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    const grafo = (...tipos: string[]) => ({
      versao: {
        graph: { nodes: tipos.map((type, i) => ({ id: `n${i}`, type, config: { classes: ["quer", "não quer"] } })) },
      },
    });
    const semFluxo = async () =>
      (await ler()).corpo.data.por_tarefa.find((t: { id: string }) => t.id === "followup").sem_fluxo;

    expect(await semFluxo()).toBe(true);
    // O de OUTRA empresa não conta; o nosso sem o passo, ou sem versão ativa, também não.
    estado.fluxos = [
      { organization_id: OUTRA_ORG, status: "active", ...grafo("trigger", "ai_classify") },
      { organization_id: ORG, status: "active", ...grafo("trigger", "action", "end") },
      { organization_id: ORG, status: "active", versao: null },
    ];
    expect(await semFluxo()).toBe(true);
    estado.fluxos.push({ organization_id: ORG, status: "active", ...grafo("trigger", "action", "ai_classify") });
    expect(await semFluxo()).toBe(false);
    // Só a do follow-up tem esse motivo.
    const outras = (await ler()).corpo.data.por_tarefa.filter((t: { id: string }) => t.id !== "followup");
    expect(outras.every((t: { sem_fluxo: boolean }) => t.sem_fluxo === false)).toBe(true);
    // A leitura é a da sessão, da organização dela, e só do publicado.
    const lidas = estado.consultas.filter((c) => c.tabela === "followup_flow_pointers");
    expect(lidas.length, "a leitura dos follow-ups (controle positivo)").toBeGreaterThan(0);
    expect(
      lidas.every(
        (c) =>
          c.cliente === "sessao" &&
          c.eq.some(([col, v]) => col === "organization_id" && v === ORG) &&
          c.eq.some(([col, v]) => col === "status" && v === "active"),
      ),
    ).toBe(true);
  });

  /**
   * Desativar um follow-up não encerra as inscrições dele, e publicar outra
   * versão não as muda de versão: o motor segue levando-as ao passo, e cada
   * resposta vai ao Jev. "Não roda" ali seria a frase tranquilizadora falsa
   * numa tela de transferência para fora do país.
   */
  it("GET: a do follow-up RODA enquanto houver inscrição andando numa versão com o passo, mesmo sem follow-up publicado", async () => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    const versao = (...tipos: string[]) => ({
      graph: { nodes: tipos.map((type, i) => ({ id: `n${i}`, type, config: { classes: ["quer", "não quer"] } })) },
    });
    const semFluxo = async () =>
      (await ler()).corpo.data.por_tarefa.find((t: { id: string }) => t.id === "followup").sem_fluxo;

    // O follow-up foi desativado (nenhum publicado); a inscrição segue na versão com o passo.
    estado.versoesEmCurso = [{ organization_id: ORG, ...versao("trigger", "action", "end") }];
    expect(await semFluxo()).toBe(true);
    estado.versoesEmCurso.push({ organization_id: ORG, ...versao("trigger", "action", "ai_classify") });
    expect(await semFluxo()).toBe(false);

    // A leitura é a da sessão, da organização dela, só das inscrições que ainda andam.
    const lidas = estado.consultas.filter((c) => c.tabela === "followup_flow_versions");
    expect(lidas.length, "a leitura das versões em curso (controle positivo)").toBeGreaterThan(0);
    expect(
      lidas.every(
        (c) =>
          c.cliente === "sessao" &&
          c.eq.some(([col, v]) => col === "organization_id" && v === ORG) &&
          c.nao.some(([col, v]) => col === "inscricoes.status" && v === "(completed,cancelled,dead)"),
      ),
    ).toBe(true);
  });

  it("GET: a concordância do follow-up sai de jev_observacoes, sem a conta do alerta forte", async () => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    estado.observacoes = [
      { organization_id: ORG, tarefa: "followup", concordou: true, rotulo_jev: "quer", rotulo_atual: "quer" },
      { organization_id: ORG, tarefa: "followup", concordou: false, rotulo_jev: "quer", rotulo_atual: "não quer" },
      // Sem par (a IA de sempre não classificou): fora da conta.
      { organization_id: ORG, tarefa: "followup", concordou: null, rotulo_jev: "quer", rotulo_atual: null },
      { organization_id: OUTRA_ORG, tarefa: "followup", concordou: true, rotulo_jev: "quer", rotulo_atual: "quer" },
    ];
    const followup = (await ler()).corpo.data.por_tarefa.find((t: { id: string }) => t.id === "followup");
    expect(followup.observacao).toEqual({ dias: 30, comparadas: 2, concordaram: 1 });
    expect(followup).toMatchObject({ estado: "observando", novo: true, percebidos: null });
  });

  /**
   * As tarefas em cascata não concordam com nada — o Jev só é perguntado onde a
   * regra de hoje disse não —, e o cartão mostra os pedidos que ele PERCEBEU:
   * a resposta dele passou do corte. Com as conversas mais recentes, sem
   * repetir conversa, e o endereço pronto (o navegador não monta endereço).
   */
  it("GET: nas tarefas em cascata, os pedidos percebidos e as conversas deles — nunca uma concordância", async () => {
    const obs = (tarefa: string, rotulo_jev: string, conversa: string, organization_id = ORG): Linha => ({
      organization_id,
      tarefa,
      rotulo_jev,
      rotulo_atual: "nao",
      concordou: rotulo_jev === "nao",
      conversation_id: conversa,
      created_at: "2026-09-25T12:00:00.000Z",
    });
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    estado.observacoes = [
      // As mais recentes primeiro, como o `order` do banco devolve.
      obs("humano", "sim", "c-1"),
      obs("humano", "sim", "c-1"),
      obs("humano", "sim", "c-2"),
      obs("humano", "sim", "c-3"),
      obs("humano", "sim", "c-4"),
      obs("humano", "sim", "c-5"),
      obs("humano", "sim", "c-6"),
      // Abaixo do corte: não é pedido percebido.
      obs("humano", "nao", "c-7"),
      obs("opt_out", "sim", "c-8"),
      obs("humano", "sim", "c-9", OUTRA_ORG),
    ];

    const d = (await ler()).corpo.data;
    const humano = d.por_tarefa.find((t: { id: string }) => t.id === "humano");
    expect(humano).toMatchObject({ estado: "observando", novo: true, observacao: null });
    expect(humano.percebidos.dias).toBe(30);
    expect(humano.percebidos.mensagens).toBe(7);
    expect(humano.percebidos.conversas.map((c: { href: string }) => c.href)).toEqual([
      "/app/inbox/c-1",
      "/app/inbox/c-2",
      "/app/inbox/c-3",
      "/app/inbox/c-4",
      "/app/inbox/c-5",
    ]);
    const optOut = d.por_tarefa.find((t: { id: string }) => t.id === "opt_out");
    expect(optOut.percebidos).toMatchObject({ mensagens: 1, conversas: [{ href: "/app/inbox/c-8" }] });
    // As outras tarefas não têm pedidos percebidos.
    expect(d.por_tarefa.find((t: { id: string }) => t.id === "manipulacao").percebidos).toBeNull();
    const lidas = estado.consultas.filter((c) => c.tabela === "jev_observacoes" && !c.head);
    expect(lidas.length, "a leitura dos pedidos percebidos (controle positivo)").toBe(3);
    expect(
      lidas.every(
        (c) =>
          c.cliente === "sessao" &&
          c.eq.some(([col, v]) => col === "organization_id" && v === ORG) &&
          c.eq.some(([col, v]) => col === "rotulo_jev" && v === "sim") &&
          c.gte.some(([col]) => col === "created_at"),
      ),
    ).toBe(true);
  });

  /**
   * As tarefas de pedido só são perguntadas onde o atendimento automático
   * rodaria (o worker: `haQuemAtendaASessao(..., { ignorarPausados: true })` e
   * o modo externo fora). Numa empresa em que ele não roda em número nenhum,
   * "Só observa" com "nenhuma mensagem" seria para sempre: a rota diz por quê,
   * com a MESMA pergunta, sem fixar o número, e só para as de pedido.
   */
  it.each([
    ["ninguém no ar sem pausa", {}, false, "ninguem_no_ar"],
    ["o atendimento com um sistema de fora", { ai_dispatch_mode: "external" }, true, "externo"],
    ["há quem atenda (controle)", {}, true, null],
    ["o modo nativo dito por extenso, e há quem atenda (controle)", { ai_dispatch_mode: "native" }, true, null],
  ] as const)("GET: nas tarefas de pedido, o motivo de não rodar — %s", async (_caso, settings, haQuem, motivo) => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO }, ...settings };
    vi.mocked(haQuemAtendaAOrganizacao).mockResolvedValue(haQuem);
    const d = (await ler()).corpo.data;
    const motivos = Object.fromEntries(d.por_tarefa.map((t: { id: string; sem_atendente: unknown }) => [t.id, t.sem_atendente]));
    expect(motivos).toEqual({
      clima: null,
      manipulacao: null,
      roteador: null,
      humano: motivo,
      opt_out: motivo,
      followup: null,
      campo_do_negocio: null,
      sinal_de_urgencia: motivo,
      afirmacao_de_fato: null,
    });
    // A organização é a da sessão, e a pergunta é a do portão do worker.
    expect(vi.mocked(haQuemAtendaAOrganizacao).mock.calls.map(([, org]) => org)).toEqual([ORG]);
  });

  it("GET: sem saber se há quem atenda (o banco fora), o cartão não afirma 'Não roda'", async () => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    vi.mocked(getRequestPool).mockImplementationOnce(() => {
      throw new Error("SUPABASE_DB_URL ausente");
    });
    const { status, corpo } = await ler();
    expect(status).toBe(200);
    expect(corpo.data.por_tarefa.find((t: { id: string }) => t.id === "humano").sem_atendente).toBeNull();
  });

  it("GET: a falha da chamada dos pedidos aparece com o nome dela, e não crua", async () => {
    estado.settings = { jev: { ligado: true, aceite: ACEITE_ANTIGO } };
    estado.llmCalls = [chamada({ purpose: "jev_pedidos", status: "erro", error_code: "jev_sem_credito" })];
    expect((await ler()).corpo.data.ultima_falha).toMatchObject({
      motivo: "jev_sem_credito",
      tarefa: "Perceber pedidos do cliente",
    });
  });

  /**
   * O `decidindo` da tarefa em cascata é o "Avisar a equipe" da tela: o aviso
   * na Central existe (`lib/ai/decisao/pedidos.ts`), e a rota aceita o pedido
   * como o de qualquer tarefa — gravado, auditado, e sem mexer no clima.
   */
  it("PATCH: a tarefa em cascata aceita decidindo (Avisar a equipe), grava só ela e audita", async () => {
    estado.credenciais = [credencial()];
    estado.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE_ANTIGO } };
    for (const tarefa of ["humano", "opt_out"]) {
      const aceito = await mudar({ tarefa, estado: "decidindo" });
      expect(aceito.status, tarefa).toBe(200);
      expect(aceito.corpo.data.alterado, tarefa).toBe(true);
    }
    expect(estado.settings.jev).toMatchObject({
      modo: "observacao",
      tarefas: { humano: { estado: "decidindo" }, opt_out: { estado: "decidindo" } },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.jev.tarefa_alterada",
        metadata: expect.objectContaining({ tarefa: "opt_out", estado: "decidindo" }),
      }),
    );
    // E volta a só observar pelo mesmo caminho.
    expect((await mudar({ tarefa: "humano", estado: "observando" })).status).toBe(200);
    expect((estado.settings.jev as { tarefas: Linha }).tarefas).toMatchObject({ humano: { estado: "observando" } });
  });

  /**
   * A do follow-up só observa nesta versão: a saída dela move o cliente no
   * fluxo. `decidindo` é recusado com código próprio e a frase de leigo do
   * cartão — sem escrever nem auditar —, e observar e pausar seguem valendo.
   */
  it("PATCH: decidindo na do follow-up é recusado (422, jev_tarefa_so_observa), sem escrever nem auditar", async () => {
    estado.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE_ANTIGO } };
    const recusado = await mudar({ tarefa: "followup", estado: "decidindo" });
    expect(recusado.status).toBe(422);
    expect(recusado.corpo.error.code).toBe("jev_tarefa_so_observa");
    expect(recusado.corpo.error.message).toBe(TAREFA_DO_FOLLOWUP.soObserva);
    expect(escritas()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();

    // Pausar e voltar a observar seguem valendo.
    expect((await mudar({ tarefa: "followup", estado: "desligada" })).status).toBe(200);
    expect((estado.settings.jev as { tarefas: Linha }).tarefas).toMatchObject({ followup: { estado: "desligada" } });
    expect((await mudar({ tarefa: "followup", estado: "observando" })).status).toBe(200);
    // E as outras seguem aceitando decidir (controle).
    expect((await mudar({ tarefa: "roteador", estado: "decidindo" })).status).toBe(200);
  });

  it("PATCH: a recusa de decidir no follow-up sai no idioma de quem pede", async () => {
    estado.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE_ANTIGO } };
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: true,
      user: { id: USUARIO, idioma: "es" },
      org: { orgId: ORG, role: "admin" },
    } as unknown as Awaited<ReturnType<typeof requireRole>>);
    const recusado = await mudar({ tarefa: "followup", estado: "decidindo" });
    expect(recusado.status).toBe(422);
    expect(recusado.corpo.error.message).toMatch(/^En esta versión, Jev solo observa esta tarea/);
  });

  it("PATCH de uma tarefa: grava só ela, espelha o clima no `modo` e audita com a tarefa", async () => {
    estado.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE_ANTIGO } };
    const { status, corpo } = await mudar({ tarefa: "clima", estado: "decidindo" });

    expect(status).toBe(200);
    expect(corpo.data.alterado).toBe(true);
    expect(estado.settings.jev).toMatchObject({
      ligado: true,
      modo: "decide",
      aceite: ACEITE_ANTIGO,
      tarefas: { clima: { estado: "decidindo", alterado_por: USUARIO } },
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.jev.tarefa_alterada",
        organizationId: ORG,
        metadata: expect.objectContaining({
          tarefa: "clima",
          estado: "decidindo",
          estado_anterior: "observando",
          modo: "decide",
          modo_anterior: "observacao",
        }),
      }),
    );
  });

  it("PATCH de uma tarefa já naquele estado não escreve nem audita", async () => {
    estado.settings = { jev: { ligado: true, modo: "decide", aceite: ACEITE_ANTIGO } };
    const { status, corpo } = await mudar({ tarefa: "clima", estado: "decidindo" });
    expect(status).toBe(200);
    expect(corpo.data.alterado).toBe(false);
    expect(escritas()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("trocar o `modo` depois de gravar por tarefa leva a tarefa junto", async () => {
    estado.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE_ANTIGO } };
    await mudar({ tarefa: "clima", estado: "decidindo" });
    await mudar({ modo: "observacao" });
    expect(estado.settings.jev).toMatchObject({ modo: "observacao", tarefas: { clima: { estado: "observando" } } });
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "ai.jev.modo_alterado",
        metadata: expect.objectContaining({ tarefa: "clima", estado_anterior: "decidindo" }),
      }),
    );
  });

  it.each([
    ["tarefa sem estado", { tarefa: "clima" }],
    ["estado sem tarefa", { estado: "decidindo" }],
    ["tarefa e `modo` juntos", { tarefa: "clima", estado: "decidindo", modo: "decide" }],
    ["tarefa que não existe", { tarefa: "futura", estado: "observando" }],
    ["estado que não existe", { tarefa: "clima", estado: "turbo" }],
  ])("%s é recusado, sem escrever", async (_caso, corpo) => {
    estado.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE_ANTIGO } };
    expect((await mudar(corpo)).status).toBe(422);
    expect(escritas()).toEqual([]);
  });

  it("gerente não muda tarefa", async () => {
    papel = "manager";
    estado.settings = { jev: { ligado: true, modo: "observacao", aceite: ACEITE_ANTIGO } };
    expect((await mudar({ tarefa: "clima", estado: "decidindo" })).status).toBe(403);
    expect(escritas()).toEqual([]);
  });

  it("o aceite novo grava o alcance que o texto da tela descreve: cada mensagem, sozinha", async () => {
    estado.credenciais = [credencial()];
    await mudar({ ligado: true, aceite_lgpd: true });
    expect((estado.settings.jev as Linha).aceite).toMatchObject({ por: USUARIO, alcance: "mensagem" });
  });
});


describe("modo Jev com reserva sob demanda", () => {
  it("instalação existente continua comparando até o admin escolher, e a mudança é auditada", async () => {
    estado.settings.jev = { ligado: true, aceite: ACEITE_ANTIGO,
      tarefas: { roteador: { estado: "decidindo" } } };
    expect((await ler()).corpo.data.config.modo_roteador).toBe("comparacao");
    const mudou = await mudar({ modo_roteador: "sob_demanda" });
    expect(mudou.status).toBe(200);
    expect(mudou.corpo.data.config.modo_roteador).toBe("sob_demanda");
    expect((await ler()).corpo.data.config.modo_roteador).toBe("sob_demanda");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ modo_roteador: "sob_demanda", modo_roteador_anterior: "comparacao" }),
    }));
    expect((await mudar({ modo_roteador: "sob_demanda" })).corpo.data.alterado).toBe(false);
    expect((await mudar({ modo_roteador: "comparacao" })).corpo.data.config.modo_roteador).toBe("comparacao");
  });

  it("sem a IA de sempre (decisão B), o sob demanda é recusado com o porquê, e o GET diz que ela falta", async () => {
    temIaDeSempre.mockResolvedValue(false);
    try {
      estado.settings.jev = { ligado: true, aceite: ACEITE_ANTIGO, tarefas: { roteador: { estado: "decidindo" } } };
      const antes = structuredClone(estado.settings);
      const recusado = await mudar({ modo_roteador: "sob_demanda" });
      expect(recusado.status).toBe(422);
      expect(recusado.corpo.error.code).toBe("jev_sem_ia_de_sempre");
      expect(recusado.corpo.error.message).toContain("Sem a sua IA de sempre");
      expect(estado.settings).toEqual(antes);
      expect(audit).not.toHaveBeenCalled();
      expect((await ler()).corpo.data.roteador_tem_ia_de_sempre).toBe(false);
      // Voltar a comparar nunca depende dela.
      estado.settings.jev = { ...(estado.settings.jev as Linha), modo_roteador: "sob_demanda" };
      expect((await mudar({ modo_roteador: "comparacao" })).status).toBe(200);
    } finally {
      temIaDeSempre.mockResolvedValue(true);
    }
  });

  it("com a IA de sempre, o GET diz que ela existe", async () => {
    expect((await ler()).corpo.data.roteador_tem_ia_de_sempre).toBe(true);
  });

  it("só admin muda o modo, e valor desconhecido não é aceito", async () => {
    papel = "manager";
    expect((await mudar({ modo_roteador: "sob_demanda" })).status).toBe(403);
    papel = "admin";
    expect((await mudar({ modo_roteador: "mais_rapido" })).status).toBe(422);
    expect(audit).not.toHaveBeenCalled();
  });
});
