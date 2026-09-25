import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CRON DE DEVOLUÇÃO NÃO TEM REGRA PRÓPRIA: ele lê quem venceu e chama a
 * MESMA função do botão da tela. E, como todo cron daqui, só deixa rastro de
 * rodada quando fez alguma coisa.
 *
 * O que se prova, nas duas direções:
 *   - conversa vencida, sessão com agente → `devolverAtendimentoAoAgente` é
 *     chamada com a origem automática e o prazo, e a rodada audita;
 *   - nada vencido → zero chamadas, zero linhas de auditoria;
 *   - sem o segredo → 403 e nenhum acesso ao banco;
 *   - conflito de atribuição: a corrida benigna é ignorada, o erro de banco
 *     que veste o mesmo código de erro NÃO é (ver o par de casos no fim);
 *   - o predicado que escolhe as organizações casa as linhas certas (o último
 *     bloco — era o único elo da cadeia sem prova).
 */

const SEGREDO = "segredo-do-cron";
const ORG = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
const VENCIDA = "44444444-4444-4444-8444-444444444444";
const RECENTE = "55555555-5555-4555-8555-555555555555";

const min = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const devolver = vi.fn();
const auditar = vi.fn();
const erroDeLog = vi.fn();
let acessosAoBanco = 0;

interface Banco {
  organizations: Array<{ id: string; settings: unknown }>;
  conversations: Array<Record<string, unknown>>;
  ai_agents: Array<Record<string, unknown>>;
  ai_routers: Array<Record<string, unknown>>;
}
let banco: Banco;

/** Um filtro que o código de produção pediu ao PostgREST, como ele o pediu. */
interface Filtro {
  metodo: "not" | "is" | "in" | "eq";
  args: unknown[];
}
let filtrosPorTabela: Record<string, Filtro[]>;

/** SQL NULL — distinto do `null` do JSON, e é justamente aí que `->` e `->>` divergem. */
const SQL_NULL = Symbol("SQL NULL");
const ehSqlNull = (v: unknown): boolean => v === SQL_NULL;

/**
 * As semânticas do PostgREST para `coluna->a->b` e `coluna->a->>b`:
 *   - `->` navega em jsonb e PRESERVA o `null` do JSON (que não é SQL NULL);
 *   - `->>` extrai texto e converte o `null` do JSON em SQL NULL;
 *   - chave ausente, ou navegar dentro de algo que não é objeto, dá SQL NULL.
 */
function navegarJsonb(coluna: string, linha: Record<string, unknown>): unknown {
  const partes = coluna.split(/(->>|->)/);
  let atual: unknown = linha[partes[0] ?? ""];
  if (atual === undefined) return SQL_NULL;
  for (let i = 1; i < partes.length; i += 2) {
    const seta = partes[i];
    const chave = partes[i + 1] ?? "";
    if (atual === null || typeof atual !== "object") return SQL_NULL;
    const proximo = (atual as Record<string, unknown>)[chave];
    if (proximo === undefined) return SQL_NULL;
    if (seta === "->>") {
      // `->>` extrai TEXTO e ENCERRA o caminho. Encadear depois dele
      // (`a->>b->c`) é erro de tipo no Postgres — `operator does not exist:
      // text -> unknown` —, então o PostgREST devolveria erro e a rodada
      // viraria 500, não "algumas linhas a menos". Estourar aqui em vez de
      // seguir avaliando impede este avaliador de inventar uma resposta
      // plausível para uma consulta que nem roda.
      if (i + 2 < partes.length) throw new Error(`caminho jsonb inválido: ${coluna}`);
      return proximo === null
        ? SQL_NULL
        : typeof proximo === "string"
          ? proximo
          : JSON.stringify(proximo);
    }
    atual = proximo;
  }
  return atual;
}

function passa(f: Filtro, linha: Record<string, unknown>): boolean {
  const [coluna, a, b] = f.args as [string, unknown, unknown];
  switch (f.metodo) {
    case "not":
      // Um filtro que este avaliador não modela precisa ESTOURAR, nunca passar
      // batido: um `every` que devolve true para o desconhecido transforma
      // "não medi" em "está certo", e a prova abaixo viraria decoração.
      if (a !== "is" || b !== null) throw new Error(`not(${String(a)}) não modelado`);
      return !ehSqlNull(navegarJsonb(coluna, linha));
    case "is":
      if (a !== null) throw new Error(`is(${String(a)}) não modelado`);
      return ehSqlNull(navegarJsonb(coluna, linha));
    case "eq":
      return navegarJsonb(coluna, linha) === a;
    case "in":
      return (a as unknown[]).includes(navegarJsonb(coluna, linha));
  }
}

function aplicar(
  filtros: readonly Filtro[],
  linhas: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return linhas.filter((linha) => filtros.every((f) => passa(f, linha)));
}

// `vi.mock` é içado acima das constantes: o segredo vai literal aqui e em `SEGREDO`.
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-do-cron", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => erroDeLog(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/escalacao/retomada", () => ({
  devolverAtendimentoAoAgente: (...a: unknown[]) => devolver(...a),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: keyof Banco) => {
      acessosAoBanco++;
      const filtros: Filtro[] = [];
      filtrosPorTabela[tabela] = filtros;
      const registrar =
        (metodo: Filtro["metodo"]) =>
        (...args: unknown[]) => {
          filtros.push({ metodo, args });
          return chain;
        };
      // Em `organizations` o dublê APLICA o que o route.ts pediu — é o predicado
      // sob prova. Nas demais tabelas o filtro fino continua sendo no-op de
      // propósito: lá quem escolhe é a regra pura (`selecionarVencidas`), e é ela
      // que os casos de cima vigiam.
      const resolver = () =>
        Promise.resolve({
          data:
            tabela === "organizations"
              ? aplicar(filtros, banco.organizations)
              : tabela === "conversations"
                ? // Aplica os filtros modelados (org, status, is_group); o `.or`
                  // segue no-op — quem corta a faixa é `selecionarVencidas`.
                  aplicar(filtros, banco.conversations)
                : banco[tabela],
          error: null,
        });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        not: registrar("not"),
        in: registrar("in"),
        is: registrar("is"),
        eq: registrar("eq"),
        or: () => chain,
        limit: () => resolver(),
        then: (res: (v: unknown) => unknown) => resolver().then(res),
      };
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/handoff-devolucao/route";
import { lerPrazoDeDevolucaoMinutos } from "@/lib/escalacao/devolucao-automatica";

function chamar(segredo = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/handoff-devolucao", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );
}

function conversa(id: string, minutosParada: number): Record<string, unknown> {
  return {
    id,
    organization_id: ORG,
    channel_session_id: SESSAO,
    status: "pending",
    assignee_kind: "user",
    assigned_to_user_id: null,
    assigned_at: null,
    bot_silenced_until: "infinity",
    last_handoff_at: min(minutosParada),
    last_outbound_at: null,
    status_changed_at: min(minutosParada),
    is_group: false,
  };
}

beforeEach(() => {
  devolver.mockReset();
  auditar.mockReset();
  erroDeLog.mockReset();
  acessosAoBanco = 0;
  filtrosPorTabela = {};
  devolver.mockResolvedValue({ ok: true, conversationId: VENCIDA, jaEstavaComOAgente: false });
  banco = {
    organizations: [{ id: ORG, settings: { routing: { handoff_return_after_minutes: 60 } } }],
    conversations: [conversa(VENCIDA, 61), conversa(RECENTE, 20)],
    ai_agents: [
      {
        organization_id: ORG,
        published_version_id: "v",
        ai_agent_versions: { channel_session_id: SESSAO, status: "published" },
      },
    ],
    ai_routers: [],
  };
});

describe("GET /api/v1/cron/handoff-devolucao", () => {
  it("sem o segredo: 403, e o banco nem é aberto", async () => {
    const res = await chamar("");
    expect(res.status).toBe(403);
    expect(acessosAoBanco).toBe(0);
    expect(devolver).not.toHaveBeenCalled();
  });

  it("devolve SÓ a vencida, pela função compartilhada, com a origem automática — e audita a rodada", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, number> };
    expect(corpo.data).toEqual({ organizacoes: 1, examinadas: 2, devolvidas: 1, falhas: 0 });

    expect(devolver).toHaveBeenCalledTimes(1);
    const [deps, input] = devolver.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(deps.organizationId).toBe(ORG);
    expect(deps.actor).toEqual({ type: "webhook_source", id: "cron:handoff-devolucao" });
    expect(input).toEqual({ conversationId: VENCIDA, origem: { automatica: { minutos: 60 } } });

    expect(auditar).toHaveBeenCalledTimes(1);
    expect(auditar.mock.calls[0]?.[0]).toMatchObject({
      action: "conversation.handoff_auto_return_run",
      metadata: { devolvidas: 1 },
    });
  });

  it("I4: grupo de WhatsApp com humano, vencido, NÃO é devolvido ao automático", async () => {
    const GRUPO_VENCIDO = "cccccccc-0000-4000-8000-0000000000a1";
    banco.conversations = [{ ...conversa(GRUPO_VENCIDO, 600), is_group: true }];
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(filtrosPorTabela.conversations).toContainEqual({ metodo: "eq", args: ["is_group", false] });
    expect(devolver).not.toHaveBeenCalled();
    const corpo = (await res.json()) as { data: Record<string, number> };
    expect(corpo.data.examinadas).toBe(0);
  });

  it("nada vencido: nenhuma devolução e nenhuma linha de auditoria", async () => {
    banco.conversations = [conversa(RECENTE, 20)];
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(devolver).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("organização sem o prazo: nem lê as conversas (IA-06 de sempre)", async () => {
    banco.organizations = [{ id: ORG, settings: { routing: {} } }];
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, number> }).data.organizacoes).toBe(0);
    expect(devolver).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("sessão sem agente publicado nem roteador: a vencida fica com a pessoa", async () => {
    banco.ai_agents = [];
    await chamar();
    expect(devolver).not.toHaveBeenCalled();
  });

  /**
   * O PAR ABAIXO É UM SÓ ASSUNTO: `assignment_conflict` sai de quatro pontos de
   * `devolverAtendimentoAoAgente` e só um deles é corrida. Classificar pelo
   * `erro` sozinho junta os quatro — e o pior deles (o erro ao limpar
   * `force_human`, que deixa a conversa fora da fila humana com a IA já dona e
   * muda) saía com `falhas: 0`, sem auditoria e sem uma linha de log.
   *
   * O discriminador é o `detalhe`, e quem o produz é `retomada.ts`; que a
   * corrida volte SEM ele e os erros de banco COM ele está preso em
   * `tests/unit/escalacao-retomada.test.ts`. Estes dois casos provam o outro
   * lado do contrato: que o cron o LÊ.
   */
  it("corrida pura (conflito sem detalhe) não é falha: a pessoa assumiu e ganhou", async () => {
    devolver.mockResolvedValue({ ok: false, erro: "assignment_conflict" });
    const corpo = (await (await chamar()).json()) as { data: Record<string, number> };
    expect(corpo.data).toMatchObject({ devolvidas: 0, falhas: 0 });
    expect(auditar).not.toHaveBeenCalled();
    expect(erroDeLog).not.toHaveBeenCalled();
  });

  it("conflito COM detalhe é defeito de banco, não corrida: conta como falha, loga e audita", async () => {
    devolver.mockResolvedValue({
      ok: false,
      erro: "assignment_conflict",
      detalhe: "deadlock detected",
    });
    const corpo = (await (await chamar()).json()) as { data: Record<string, number> };
    expect(corpo.data).toMatchObject({ devolvidas: 0, falhas: 1 });
    // A rodada com efeito (ainda que só de falha) tem de deixar rastro: sem esta
    // linha o defeito é indistinguível de uma varredura vazia.
    expect(auditar).toHaveBeenCalledTimes(1);
    expect(auditar.mock.calls[0]?.[0]).toMatchObject({
      action: "conversation.handoff_auto_return_run",
      metadata: { falhas: 1 },
    });
    expect(erroDeLog).toHaveBeenCalledTimes(1);
    expect(erroDeLog.mock.calls[0]?.[1]).toMatchObject({
      conversation_id: VENCIDA,
      erro: "assignment_conflict",
      detalhe: "deadlock detected",
    });
  });
});

/**
 * O ELO QUE NENHUM CASO ACIMA EXERCIA.
 *
 * `prazosPorOrganizacao` reduz as organizações NO BANCO com
 * `.not("settings->routing->handoff_return_after_minutes", "is", null)` e depois
 * confere o valor de novo em memória (`lerPrazoDeDevolucaoMinutos`). O predicado
 * é, portanto, só um redutor — e a única coisa que ele não pode fazer é cortar
 * uma linha que o leitor aceitaria: aí a organização some da varredura, o prazo
 * que alguém ligou na tela nunca dispara, e ninguém fica sabendo, porque a
 * rodada responde 200 com `organizacoes: 0` e não audita (varredura vazia não é
 * mutação). Falha em silêncio, que é a pior.
 *
 * A régua sai do `route.ts`: o dublê CAPTURA o predicado que o código de
 * produção aplicou e este bloco o avalia contra formas conhecidas de `settings`.
 * Nada aqui repete a string do filtro — se ela mudar, é a avaliação que muda.
 */
describe("o predicado que escolhe as organizações", () => {
  let filtroDasOrganizacoes: Filtro[];

  beforeEach(async () => {
    await chamar();
    filtroDasOrganizacoes = filtrosPorTabela.organizations ?? [];
  });

  const sobrevive = (settings: unknown): boolean =>
    aplicar(filtroDasOrganizacoes, [{ id: ORG, settings }]).length === 1;

  const ACEITAS_PELO_LEITOR: Array<{ nome: string; settings: unknown }> = [
    { nome: "prazo no piso da faixa", settings: { routing: { handoff_return_after_minutes: 5 } } },
    { nome: "prazo no meio da faixa", settings: { routing: { handoff_return_after_minutes: 60 } } },
    { nome: "prazo no teto da faixa", settings: { routing: { handoff_return_after_minutes: 1440 } } },
    {
      nome: "prazo ao lado de outras chaves de routing",
      settings: { routing: { handoff_return_after_minutes: 30, modo: "round_robin" }, branding: {} },
    },
  ];

  it("controle positivo: o predicado existe e de fato CORTA linha", () => {
    // Sem isto a prova seguinte seria vazia — um dublê que não aplicasse filtro
    // nenhum a passaria inteira, e é exatamente essa a cegueira que este bloco
    // veio consertar.
    expect(filtroDasOrganizacoes.length).toBeGreaterThan(0);
    expect(sobrevive({ routing: {} })).toBe(false);
    expect(sobrevive({})).toBe(false);
    expect(sobrevive(null)).toBe(false);
  });

  it.each(ACEITAS_PELO_LEITOR)(
    "não corta a linha boa: $nome",
    ({ settings }: { settings: unknown }) => {
      // A premissa do caso: o leitor em memória aceitaria esta organização.
      expect(lerPrazoDeDevolucaoMinutos(settings)).not.toBeNull();
      // Logo o predicado do banco tem de entregá-la. Inverter `not`/`is`, errar
      // o caminho jsonb ou encadear `->>` no meio derruba esta linha.
      expect(sobrevive(settings)).toBe(true);
    },
  );

  it("o prazo gravado como null explícito chega ao leitor (é `->`, não `->>`)", () => {
    const settings = { routing: { handoff_return_after_minutes: null } };
    // Com `->` o `null` do JSON não é SQL NULL, então a linha passa pelo banco e
    // é o leitor quem a descarta. Com `->>` ela sairia já no PostgREST. As duas
    // rotas dão o MESMO desfecho de produto (esta org não tem prazo dos dois
    // jeitos) — esta asserção existe para que trocar o operador seja decisão
    // registrada, não deriva silenciosa.
    expect(sobrevive(settings)).toBe(true);
    expect(lerPrazoDeDevolucaoMinutos(settings)).toBeNull();
  });

  it("a divisão de trabalho é essa: o banco corta a ausência, a memória corta a faixa", () => {
    // Fora da faixa o predicado NÃO corta (o valor existe) — quem corta é
    // `lerPrazoDeDevolucaoMinutos`. Registrar isso impede que alguém "conserte"
    // o filtro tentando checar faixa em jsonb, que é onde ele passaria a cortar
    // linha boa por engano.
    const curto = { routing: { handoff_return_after_minutes: 2 } };
    expect(sobrevive(curto)).toBe(true);
    expect(lerPrazoDeDevolucaoMinutos(curto)).toBeNull();
  });
});
