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

import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { DEFAULT_SENTIMENT_THRESHOLD } from "@/lib/ai/prompts/sentiment";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const ACEITE_ANTIGO = { em: "2026-09-01T12:00:00.000Z", por: USUARIO };

type Linha = Record<string, unknown>;

interface Consulta {
  cliente: "admin" | "sessao";
  tabela: string;
  eq: Array<[string, unknown]>;
  /** `.not(col, "is", valor)` — só `jev_observacoes` os aplica (as outras leituras não dependem deles aqui). */
  nao: Array<[string, unknown]>;
  /** `.neq(col, valor)` — idem; como no SQL, o nulo não passa. */
  neq: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  range: [number, number] | null;
  patch: Linha | null;
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
  consultas: Consulta[];
}

let estado: Estado;
let papel: Role;

/** O teto do PostgREST sem `range` (`supabase/config.toml`, `max_rows`). */
const MAX_ROWS = 1000;

function cliente(tipo: Consulta["cliente"]) {
  return {
    from(tabela: string) {
      const c: Consulta = { cliente: tipo, tabela, eq: [], nao: [], neq: [], gte: [], range: null, patch: null };
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
                    : estado.mensagens;
        const filtradas = base.filter((l) => c.eq.every(([col, v]) => !(col in l) || l[col] === v));
        return c.range ? filtradas.slice(c.range[0], c.range[1] + 1) : filtradas.slice(0, MAX_ROWS);
      };
      const chain = {
        select: () => chain,
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
        // `jev_observacoes` é lida por contagem (`head`): o PostgREST devolve `count`, sem linhas.
        then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve(
            tabela === "jev_observacoes"
              ? { data: null, count: linhasDaTabela().length, error: null }
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
    expect(d.config).toEqual({ ligado: false, modo: "observacao", aceite: null });
    expect(d.tarefas.map((t: { id: string }) => t.id)).toEqual(["sentiment_classify", "jailbreak_detect", "intent_router"]);
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
    ]);
    estado.camadas = [
      { organization_id: ORG, layer: "jailbreak", enabled: false },
      { organization_id: OUTRA_ORG, layer: "jailbreak", enabled: true },
    ];
    expect(await semCamada()).toEqual([
      ["clima", false],
      ["manipulacao", true],
      ["roteador", false],
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
    ]);
    // O ativo de OUTRA empresa não conta — o filtro é o da sessão.
    const intencoes = (n: number) => [{ count: n }];
    estado.roteadores = [{ organization_id: OUTRA_ORG, is_active: true, id: "r-outra", intencoes: intencoes(2) }];
    expect(await semRoteador()).toEqual([
      ["clima", false],
      ["manipulacao", false],
      ["roteador", true],
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
    ]);
    // E o cartão segue dizendo que a tarefa observa: é o que ela faz quando há roteador.
    const roteador = (await ler()).corpo.data.por_tarefa.find((t: { id: string }) => t.id === "roteador");
    expect(roteador).toMatchObject({ estado: "observando", novo: true });
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
