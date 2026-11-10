import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CRON QUE DEVOLVE AO RODÍZIO A CONVERSA ENTREGUE E NÃO RESPONDIDA — a rota,
 * com dublê, no molde de `cron-handoff-devolucao.test.ts`.
 *
 * Nasceu da revisão do #2988: o mantenedor mediu duas sabotagens VERDES neste
 * cron — tirar o corte `houveRespostaHumanaDepoisDaEntrega(...)` e o worker
 * passar `eligibles` no lugar de `elegiveis` ao `decideRouting`. Nenhum teste
 * olhava para a rota; a regra pura estava provada e o I/O, não.
 *
 * O que este arquivo prende, na ordem em que custou:
 *
 *   1. A ORDEM das escritas: a marca de exclusão vai ANTES do release. O pedido
 *      de rodízio nasce DENTRO da transação do release
 *      (`trg_routing_assignment_changed` → `fn_request_channel_routing`), então
 *      marcar depois deixava o `routing-worker` reentregar a conversa à MESMA
 *      pessoa. A trilha das chamadas é asserção literal — inverter a ordem fica
 *      vermelho, que é o defeito que o cabeçalho da rota afirmava ao contrário.
 *   2. Resposta humana DEPOIS da entrega cancela a devolução. Com o controle
 *      positivo da mensagem ANTERIOR à entrega, para o caso não passar por
 *      "nunca devolve nada".
 *   3. Release em corrida (0 linhas) não deixa marca nem pede rodízio: a marca
 *      escrita no passo 1 é DESFEITA, e o metadata volta a ser o lido. A trilha
 *      mostra as duas escritas — o teste diz o que a rota faz, não o que
 *      gostaríamos que fizesse.
 *   4. Varredura vazia não audita (a doutrina do `cron-audita-so-quando-ha-efeito`).
 *   5. A trava das 3 horas (promessa da #2985): entrega velha nem consulta
 *      mensagens.
 *   6. A cerca do WORKER: `decideRouting` recebe os elegíveis JÁ filtrados pela
 *      marca de 24 h. Passar a lista crua deixa vermelho.
 */

const SEGREDO = "segredo-do-cron";
const ORG = "22222222-2222-4222-8222-222222222222";
const PESSOA_A = "11111111-1111-4111-8111-111111111111";
const PESSOA_B = "99999999-9999-4999-8999-999999999999";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const CANAL = "77777777-7777-4777-8777-777777777777";
const EVENTO = "88888888-8888-4888-8888-888888888888";

const min = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

// --- dublês -----------------------------------------------------------------

const auditar = vi.fn();
const erroDeLog = vi.fn();
const decidir = vi.fn();
const elegiveis = vi.fn();

type Linha = Record<string, unknown>;
interface Filtro {
  metodo: "not" | "is" | "in" | "eq" | "lte" | "or";
  args: unknown[];
}

/**
 * A TRILHA: toda escrita e toda RPC, na ordem em que a rota as fez. É o que
 * prova a decisão de ORDEM do item 3 da revisão — `toHaveBeenCalledTimes` no
 * fim não distingue "marcou antes" de "marcou depois".
 */
let trilha: Array<{ tipo: "update" | "rpc"; nome: string; valores?: Linha }>;
let banco: Record<string, Linha[]>;
/** Quantas consultas cada tabela recebeu (a trava das 3 h economiza a de mensagens). */
let consultas: Record<string, number>;
let rpcs: Array<{ fn: string; args: Linha }>;
/** O que cada RPC devolve; sobrescrito caso a caso (a corrida, o erro de banco). */
let respostas: Record<string, () => { data: unknown; error: { message: string } | null }>;
/** Erro de UPDATE por tabela, para o caminho "marca_nao_gravada". */
let erroDeUpdate: Record<string, string>;

const SQL_NULL = Symbol("SQL NULL");
/**
 * Nulo para efeito de `is.null`/`not.is.null`.
 *
 * Numa COLUNA comum (`next_attempt_at`), o `null` do JS É o NULL do SQL. Num
 * CAMINHO jsonb (`a->b`), não: `->` preserva o `null` do JSON (que não é SQL
 * NULL) e é justamente por isso que `->` e `->>` divergem. A distinção é por
 * coluna, como no molde.
 */
const ehNulo = (coluna: string, v: unknown): boolean =>
  v === SQL_NULL || (!coluna.includes("->") && v === null);

/**
 * As semânticas do PostgREST para `coluna->a->b` e `coluna->a->>b`, como no
 * molde: `->` preserva o `null` do JSON (que não é SQL NULL), `->>` extrai texto
 * e o converte.
 */
function navegarJsonb(coluna: string, linha: Linha): unknown {
  const partes = coluna.split(/(->>|->)/);
  let atual: unknown = linha[partes[0] ?? ""];
  if (atual === undefined) return SQL_NULL;
  for (let i = 1; i < partes.length; i += 2) {
    const seta = partes[i];
    const chave = partes[i + 1] ?? "";
    if (atual === null || typeof atual !== "object") return SQL_NULL;
    const proximo = (atual as Linha)[chave];
    if (proximo === undefined) return SQL_NULL;
    if (seta === "->>") {
      if (i + 2 < partes.length) throw new Error(`caminho jsonb inválido: ${coluna}`);
      return proximo === null ? SQL_NULL : typeof proximo === "string" ? proximo : JSON.stringify(proximo);
    }
    atual = proximo;
  }
  return atual;
}

function passa(f: Filtro, linha: Linha): boolean {
  const [coluna, a, b] = f.args as [string, unknown, unknown];
  switch (f.metodo) {
    case "not":
      // Filtro não modelado ESTOURA, nunca passa batido: um `every` permissivo
      // transforma "não medi" em "está certo".
      if (a !== "is" || b !== null) throw new Error(`not(${String(a)}) não modelado`);
      return !ehNulo(coluna, navegarJsonb(coluna, linha));
    case "is":
      if (a !== null) throw new Error(`is(${String(a)}) não modelado`);
      return ehNulo(coluna, navegarJsonb(coluna, linha));
    case "eq":
      return navegarJsonb(coluna, linha) === a;
    case "in":
      return (a as unknown[]).includes(navegarJsonb(coluna, linha));
    case "lte":
      return String(navegarJsonb(coluna, linha)) <= String(b);
    case "or": {
      // O `or` do worker (`next_attempt_at.is.null,...lte.<iso>`): aqui o único
      // argumento é a EXPRESSÃO, não uma coluna. Modelado no mínimo, e o que não
      // casar o padrão estoura em vez de passar.
      const [expressao] = f.args as [string];
      return expressao.split(",").some((clausula) => {
        const m = /^([a-z_]+)\.(is\.null|lte\.(.+)|eq\.(.+))$/.exec(clausula);
        if (!m) throw new Error(`or não modelado: ${clausula}`);
        const valor = String(navegarJsonb(m[1]!, linha));
        if (m[2] === "is.null") return ehNulo(m[1]!, navegarJsonb(m[1]!, linha));
        if (m[3] !== undefined) return valor <= m[3];
        return valor === m[4];
      });
    }
  }
}

function resolver(
  tabela: string,
  operacao: "select" | "update",
  valores: Linha | null,
  filtros: readonly Filtro[],
  ordem: ReadonlyArray<{ coluna: string; ascending: boolean }>,
  limite: number | null,
): { data: unknown; error: { message: string } | null } {
  const linhas = banco[tabela] ?? [];
  if (operacao === "update") {
    trilha.push({ tipo: "update", nome: tabela, valores: valores ?? {} });
    const erro = erroDeUpdate[tabela];
    if (erro) return { data: null, error: { message: erro } };
    const alvo = linhas.filter((l) => filtros.every((f) => passa(f, l)));
    for (const linha of alvo) Object.assign(linha, valores ?? {});
    return { data: alvo.map((l) => ({ ...l })), error: null };
  }
  let out = linhas.filter((l) => filtros.every((f) => passa(f, l)));
  if (ordem.length > 0) {
    out = [...out].sort((x, y) => {
      for (const o of ordem) {
        const vx = String(navegarJsonb(o.coluna, x));
        const vy = String(navegarJsonb(o.coluna, y));
        if (vx !== vy) return (vx < vy ? -1 : 1) * (o.ascending ? 1 : -1);
      }
      return 0;
    });
  }
  if (limite !== null) out = out.slice(0, limite);
  return { data: out, error: null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cadeia(tabela: string, operacao: "select" | "update", valores: Linha | null): any {
  const filtros: Filtro[] = [];
  const ordem: Array<{ coluna: string; ascending: boolean }> = [];
  let limite: number | null = null;
  const resultado = () => resolver(tabela, operacao, valores, filtros, ordem, limite);
  const registrar =
    (metodo: Filtro["metodo"]) =>
    (...args: unknown[]) => {
      filtros.push({ metodo, args });
      return chain;
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain,
    update: (v: Linha) => cadeia(tabela, "update", v),
    not: registrar("not"),
    is: registrar("is"),
    in: registrar("in"),
    eq: registrar("eq"),
    lte: registrar("lte"),
    or: registrar("or"),
    order: (coluna: string, opts?: { ascending?: boolean }) => {
      ordem.push({ coluna, ascending: opts?.ascending !== false });
      return chain;
    },
    limit: (n: number) => {
      limite = n;
      return chain;
    },
    maybeSingle: () => {
      const { data, error } = resultado();
      return Promise.resolve({
        data: Array.isArray(data) ? (data[0] ?? null) : data,
        error,
      });
    },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resultado()).then(res, rej),
  };
  return chain;
}

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-do-cron", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => erroDeLog(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/routing/decide", () => ({
  decideRouting: (...a: unknown[]) => decidir(...a),
  // O worker resolve o roteamento POR NÚMERO antes de decidir (#2331). Aqui a
  // regra do número é ausente, então o efetivo é o da organização — o mesmo
  // desfecho do `resolverRoteamentoPorNumero` real, sem arrastar o módulo.
  resolverRoteamentoPorNumero: (config: { mode: string }, regra?: { distribution_mode?: string; default_assignee_user_id?: string | null } | null) => ({
    mode: regra?.distribution_mode ?? config.mode,
    defaultAssigneeUserId: regra?.default_assignee_user_id ?? null,
  }),
}));
vi.mock("@/lib/routing/eligibles", () => ({
  InvalidRoutingChannel: class InvalidRoutingChannel extends Error {},
  loadEligibleAttendants: (...a: unknown[]) => elegiveis(...a),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      consultas[tabela] = (consultas[tabela] ?? 0) + 1;
      return cadeia(tabela, "select", null);
    },
    rpc: (fn: string, args: Linha) => {
      trilha.push({ tipo: "rpc", nome: fn });
      rpcs.push({ fn, args });
      return Promise.resolve(respostas[fn] ? respostas[fn]() : { data: null, error: null });
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/rodizio-devolucao/route";
import { CHAVE_DA_DEVOLUCAO_AO_RODIZIO } from "@/lib/escalacao/devolucao-ao-rodizio";
import { runRoutingWorker } from "@/lib/routing/worker";

function chamar(segredo = SEGREDO): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/rodizio-devolucao", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );
}

const corpoDe = async (res: Response) =>
  ((await res.json()) as { data: Record<string, number> }).data;

function conversa(sobrescreve: Linha = {}): Linha {
  return {
    id: CONVERSA,
    organization_id: ORG,
    status: "claimed",
    assigned_to_user_id: PESSOA_A,
    metadata: {},
    is_group: false,
    ...sobrescreve,
  };
}

function eventoDaEntrega(minutosAtras: number): Linha {
  return { conversation_id: CONVERSA, reason: "routing", created_at: min(minutosAtras) };
}

function mensagem(minutosAtras: number): Linha {
  return {
    organization_id: ORG,
    conversation_id: CONVERSA,
    direction: "outbound",
    sent_via: "user",
    created_at: min(minutosAtras),
  };
}

beforeEach(() => {
  auditar.mockReset();
  erroDeLog.mockReset();
  decidir.mockReset();
  elegiveis.mockReset();
  trilha = [];
  consultas = {};
  rpcs = [];
  erroDeUpdate = {};
  respostas = {
    fn_conversation_assign: () => ({ data: [{ id: CONVERSA, assigned_to_user_id: null }], error: null }),
    fn_request_channel_routing: () => ({ data: null, error: null }),
    fn_channel_routing_claim: () => ({ data: "assigned", error: null }),
  };
  banco = {
    organizations: [{ id: ORG, settings: { routing: { unanswered_return_minutes: 60 } } }],
    conversations: [conversa()],
    conversation_assignment_events: [eventoDaEntrega(90)],
    messages: [],
    event_log: [],
    contacts: [],
    crm_leads: [],
  };
});

describe("GET /api/v1/cron/rodizio-devolucao", () => {
  it("sem o segredo: 403, e o banco nem é aberto", async () => {
    const res = await chamar("");
    expect(res.status).toBe(403);
    expect(consultas).toEqual({});
    expect(trilha).toEqual([]);
  });

  /**
   * O CASO FELIZ E A ORDEM, juntos: é a trilha que prende o item 3 da revisão.
   * Marcar depois do release deixa esta lista na ordem errada — e é exatamente a
   * janela em que o `routing-worker` reentrega a conversa à mesma pessoa.
   */
  it("devolve sem resposta humana: marca, solta o dono e pede o rodízio — NESTA ordem —, e audita", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(await corpoDe(res)).toEqual({ organizacoes: 1, examinadas: 1, devolvidas: 1, falhas: 0 });

    expect(trilha.map((e) => `${e.tipo}:${e.nome}`)).toEqual([
      "update:conversations",
      "rpc:fn_conversation_assign",
      "rpc:fn_request_channel_routing",
    ]);

    // A marca, como ela tem de ficar: a pessoa fora por 24 h e a devolução contada.
    const marca = banco.conversations?.[0]?.metadata as Record<string, unknown> | undefined;
    expect(marca?.[CHAVE_DA_DEVOLUCAO_AO_RODIZIO]).toMatchObject({ devolucoes: 1 });
    const exclusoes = (marca?.[CHAVE_DA_DEVOLUCAO_AO_RODIZIO] as { exclusoes: unknown[] }).exclusoes;
    expect(exclusoes).toEqual([{ user_id: PESSOA_A, ate: expect.any(String) }]);

    // O release é a régua de sempre: a mesma função do botão "Liberar", com o
    // dono LIDO como esperado (a corrida fica do lado de quem assumiu).
    const release = rpcs.find((r) => r.fn === "fn_conversation_assign");
    expect(release?.args).toMatchObject({
      p_organization_id: ORG,
      p_conversation_id: CONVERSA,
      p_to_user_id: null,
      p_reason: "release",
      p_expected_assignee: PESSOA_A,
      p_enforce_expected: true,
    });

    // Uma linha por conversa, com o que aconteceu e com quem.
    expect(auditar).toHaveBeenCalledTimes(2);
    const devolucao = auditar.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === "conversation.returned_to_routing_queue",
    );
    expect(devolucao?.[0]).toMatchObject({
      resourceType: "conversation",
      resourceId: CONVERSA,
      bypassedRls: true,
      metadata: { user_id: PESSOA_A, apos_minutos: 60, devolucoes: 1 },
    });
    const rodada = auditar.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === "conversation.routing_return_run",
    );
    expect(rodada?.[0]).toMatchObject({ metadata: { devolvidas: 1, falhas: 0 } });
  });

  /**
   * A SABOTAGEM Nº 2 DO MANTENEDOR, virada cerca: tirar o corte
   * `houveRespostaHumanaDepoisDaEntrega(...)` e este caso fica vermelho — o cron
   * tira a conversa de quem está atendendo.
   *
   * O controle positivo vem junto de propósito: sem ele, um cron que nunca
   * devolvesse nada passaria nos dois casos.
   */
  it("resposta humana DEPOIS da entrega cancela a devolução (e a de ANTES não)", async () => {
    banco.messages = [mensagem(30)]; // 90 min de entrega, resposta 30 min atrás
    const res = await chamar();
    expect(await corpoDe(res)).toEqual({ organizacoes: 1, examinadas: 1, devolvidas: 0, falhas: 0 });
    expect(consultas.messages).toBe(1);
    expect(trilha).toEqual([]);
    expect(auditar).not.toHaveBeenCalled();

    // Controle positivo: a MESMA conversa, com a fala humana anterior à entrega.
    trilha = [];
    banco.messages = [mensagem(120)];
    expect(await corpoDe(await chamar())).toMatchObject({ devolvidas: 1, falhas: 0 });
    expect(trilha.map((e) => `${e.tipo}:${e.nome}`)).toEqual([
      "update:conversations",
      "rpc:fn_conversation_assign",
      "rpc:fn_request_channel_routing",
    ]);
  });

  /**
   * A CORRIDA, com o que ela custa: a marca já foi escrita quando o release
   * volta 0 linhas, e é DESFEITA. O estado final tem de ser o de antes — nada de
   * exclusão para uma devolução que não aconteceu, nada de pedido de rodízio.
   */
  it("release em corrida (0 linhas) não deixa marca nem pede rodízio", async () => {
    respostas.fn_conversation_assign = () => ({ data: [], error: null });
    const res = await chamar();
    expect(await corpoDe(res)).toEqual({ organizacoes: 1, examinadas: 1, devolvidas: 0, falhas: 0 });

    // Marca, release que perde, marca desfeita: a trilha diz o que a rota faz.
    expect(trilha.map((e) => `${e.tipo}:${e.nome}`)).toEqual([
      "update:conversations",
      "rpc:fn_conversation_assign",
      "update:conversations",
    ]);
    expect(trilha[0]?.valores?.metadata).toMatchObject({
      [CHAVE_DA_DEVOLUCAO_AO_RODIZIO]: { devolucoes: 1 },
    });
    expect(trilha[2]?.valores?.metadata).toEqual({});

    expect(rpcs.some((r) => r.fn === "fn_request_channel_routing")).toBe(false);
    expect(banco.conversations?.[0]?.metadata).toEqual({});
    expect(auditar).not.toHaveBeenCalled();
    expect(erroDeLog).not.toHaveBeenCalled();
  });

  it("release com erro de banco conta falha, audita a rodada e desfaz a marca", async () => {
    respostas.fn_conversation_assign = () => ({ data: null, error: { message: "deadlock detected" } });
    const res = await chamar();
    expect(await corpoDe(res)).toMatchObject({ devolvidas: 0, falhas: 1 });
    expect(banco.conversations?.[0]?.metadata).toEqual({});
    expect(rpcs.some((r) => r.fn === "fn_request_channel_routing")).toBe(false);
    expect(auditar).toHaveBeenCalledTimes(1);
    expect(auditar.mock.calls[0]?.[0]).toMatchObject({
      action: "conversation.routing_return_run",
      metadata: { falhas: 1 },
    });
    expect(erroDeLog.mock.calls[0]?.[1]).toMatchObject({ erro: "release_failed", detalhe: "deadlock detected" });
  });

  it("varredura vazia não audita (varredura vazia não é mutação)", async () => {
    banco.conversations = [];
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(await corpoDe(res)).toEqual({ organizacoes: 1, examinadas: 0, devolvidas: 0, falhas: 0 });
    expect(auditar).not.toHaveBeenCalled();
    expect(trilha).toEqual([]);
  });

  it("organização sem o prazo: nem lê as conversas", async () => {
    banco.organizations = [{ id: ORG, settings: { routing: {} } }];
    const res = await chamar();
    expect(await corpoDe(res)).toMatchObject({ organizacoes: 0 });
    expect(consultas.conversations).toBeUndefined();
    expect(trilha).toEqual([]);
  });

  /**
   * A TRAVA DAS 3 HORAS, no nível da rota: a entrega velha nem chega a custar a
   * consulta de mensagens. É a promessa da #2985 — ligar o prazo não devolve o
   * estoque antigo de uma vez.
   */
  it("entrega mais velha que 3 h não é devolvida — e nem consulta mensagens", async () => {
    banco.conversation_assignment_events = [eventoDaEntrega(200)];
    banco.messages = []; // sem resposta humana: seria devolvida se não fosse a trava
    const res = await chamar();
    expect(await corpoDe(res)).toEqual({ organizacoes: 1, examinadas: 1, devolvidas: 0, falhas: 0 });
    expect(consultas.messages).toBeUndefined();
    expect(trilha).toEqual([]);
    expect(auditar).not.toHaveBeenCalled();
  });

  it("a marca de 'marca não gravada' não solta o dono: falha, e o release nem é chamado", async () => {
    erroDeUpdate.conversations = "permission denied for table conversations";
    const res = await chamar();
    expect(await corpoDe(res)).toMatchObject({ devolvidas: 0, falhas: 1 });
    expect(rpcs.some((r) => r.fn === "fn_conversation_assign")).toBe(false);
    expect(erroDeLog.mock.calls[0]?.[1]).toMatchObject({ erro: "marca_nao_gravada" });
  });
});

/**
 * A SABOTAGEM Nº 1 DO MANTENEDOR, virada cerca: o worker tem de passar ao
 * `decideRouting` os elegíveis JÁ filtrados pela marca de 24 h. Trocando
 * `elegiveis` por `eligibles` na chamada, este caso fica vermelho.
 */
describe("o worker respeita a exclusão de 24 h ao decidir o rodízio", () => {
  const AGORA = Date.now();
  const candidato = (userId: string) => ({ userId, currentLoad: 0, lastAssignedAt: null, scheduleSnapshot: {} });

  beforeEach(() => {
    banco.organizations = [{ id: ORG, settings: { routing: { mode: "round_robin" } } }];
    banco.contacts = [{ id: CONTATO, organization_id: ORG, is_personal: false }];
    banco.event_log = [
      {
        id: EVENTO,
        organization_id: ORG,
        event_type: "conversation.routing_requested",
        status: "pending",
        payload: { organization_id: ORG, conversation_id: CONVERSA },
        metadata: {},
        consumed_by: [],
        attempts: 0,
        next_attempt_at: null,
        created_at: min(1),
        updated_at: min(1),
      },
    ];
    elegiveis.mockResolvedValue([candidato(PESSOA_A), candidato(PESSOA_B)]);
    decidir.mockReturnValue({ kind: "assign", userId: PESSOA_B });
  });

  const excluidaAte24h = (userId: string) => ({
    [CHAVE_DA_DEVOLUCAO_AO_RODIZIO]: {
      devolucoes: 1,
      exclusoes: [{ user_id: userId, ate: new Date(AGORA + 60 * 60_000).toISOString() }],
      ultima_devolucao_em: min(5),
    },
  });

  it("decideRouting recebe a lista FILTRADA — e a conversa não volta para quem a devolveu", async () => {
    banco.conversations = [
      conversa({
        assigned_to_user_id: null,
        status: "open",
        contact_id: CONTATO,
        channel_session_id: CANAL,
        metadata: excluidaAte24h(PESSOA_A),
      }),
    ];
    // Precondição da cerca: o worker de fato processou o evento — sem isto, "não
    // filtrou" e "nem chegou ao decideRouting" ficariam indistinguíveis.
    const resumo = await runRoutingWorker({ now: new Date(AGORA) });
    expect(resumo.errors).toEqual([]);
    expect(resumo.batch_size).toBe(1);

    const entrada = decidir.mock.calls[0]?.[0] as { eligibles: Array<{ userId: string }> };
    expect(entrada.eligibles.map((c) => c.userId)).toEqual([PESSOA_B]);
    const claim = rpcs.find((r) => r.fn === "fn_channel_routing_claim");
    expect(claim?.args.p_user).toBe(PESSOA_B);
  });

  it("controle positivo: sem a marca, os dois elegíveis chegam ao decideRouting", async () => {
    banco.conversations = [
      conversa({
        assigned_to_user_id: null,
        status: "open",
        contact_id: CONTATO,
        channel_session_id: CANAL,
        metadata: {},
      }),
    ];
    await runRoutingWorker({ now: new Date(AGORA) });

    const entrada = decidir.mock.calls[0]?.[0] as { eligibles: Array<{ userId: string }> };
    expect(entrada.eligibles.map((c) => c.userId)).toEqual([PESSOA_A, PESSOA_B]);
  });

  it("exclusão VENCIDA não filtra ninguém: o rodízio volta a considerar a pessoa", async () => {
    banco.conversations = [
      conversa({
        assigned_to_user_id: null,
        status: "open",
        contact_id: CONTATO,
        channel_session_id: CANAL,
        metadata: {
          [CHAVE_DA_DEVOLUCAO_AO_RODIZIO]: {
            devolucoes: 1,
            exclusoes: [{ user_id: PESSOA_A, ate: new Date(AGORA - 60_000).toISOString() }],
          },
        },
      }),
    ];
    await runRoutingWorker({ now: new Date(AGORA) });

    const entrada = decidir.mock.calls[0]?.[0] as { eligibles: Array<{ userId: string }> };
    expect(entrada.eligibles.map((c) => c.userId)).toEqual([PESSOA_A, PESSOA_B]);
  });
});
