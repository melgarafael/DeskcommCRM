/**
 * POST /api/v1/messages — A PORTA POR TELEFONE (#4513).
 *
 * ─── O que a issue mediu ────────────────────────────────────────────────────
 *
 * O conector do DeskVoice manda telefone (`{ to, text, callId }`); esta rota
 * exigia `conversation_id` (uuid) e recusava o telefone em 422 antes de
 * qualquer coisa. Duas pontas certas que não se encontravam.
 *
 * ─── O que se mede aqui, e por que com o resolvedor de VERDADE ──────────────
 *
 * `openSharedContactConversation` e `encontrarContatoPorTelefone` NÃO são
 * mockados. Dublar o resolvedor mediria só que a rota chama uma função; o que
 * esta suíte precisa provar é o que a rota decide — qual conversa entra no
 * `sendMessageHandler` — e que a busca de contato é da ORGANIZAÇÃO. O banco em
 * memória aplica os filtros do PostgREST de verdade (`eq`/`in`/`is`/`limit`),
 * então uma busca sem `organization_id` acha a ficha da outra organização:
 * é exatamente assim que a sabotagem do escopo fica vermelha.
 *
 * O que NÃO se mede aqui: que o `fn_service_begin` reaproveite a conversa
 * existente em vez de inserir outra (índice único do banco) e que o envio de
 * verdade saia pelo canal. Isso é do `pnpm test:db` e do handler, que aqui é
 * dublê de propósito — o assunto é a PORTA.
 *
 * ─── Os quatro casos ────────────────────────────────────────────────────────
 *
 *   só `conversation_id`   → caminho de sempre, sem tocar em contato
 *   só `phone_number`      → resolve contato + conversa pelo helper único
 *   os dois juntos         → 422 `ambiguous_target`, sem efeito nenhum
 *   nenhum dos dois        → 422 `validation_error`, sem efeito nenhum
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));
vi.mock("./_handler", () => ({ sendMessageHandler: vi.fn() }));

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { resolveAuthDual } from "@/lib/api/auth-dual";
import { PROVIDERS_DE_TELEFONE } from "@/lib/channels/capabilities";
import { createAdminClient } from "@/lib/supabase/admin";

import { sendMessageHandler } from "./_handler";
import { POST } from "./route";

type Linha = Record<string, unknown>;

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const SESSAO = "22222222-2222-4222-8222-222222222222";
const CHAVE = "aaaaaaa1-1111-4111-8111-111111111111";

/**
 * O MESMO número nas duas organizações — o caso que a issue manda cobrir.
 *
 * A ficha de FORA vem primeiro e tem o id que vence o desempate de
 * `escolherContatoCanonico` (menor id), de propósito: se a busca perder o
 * filtro de organização, é ELA que a rota vai usar, e o teste diz isso em vez
 * de passar por sorte de ordenação.
 */
const TELEFONE = "+553284793302";
const CONTATO_DE_FORA = "0bbbbbbb-2222-4222-8222-222222222222";
const CONTATO_DA_CASA = "aaaaaaaa-1111-4111-8111-111111111111";

/** O que o handler recebeu no lugar da conversa: o dublê devolve este id. */
const conversaDe = (contato: unknown) => `conversa-de-${String(contato)}`;

const mockedAuth = vi.mocked(resolveAuthDual);
const mockedAdmin = vi.mocked(createAdminClient);
const mockedTeto = vi.mocked(checkRateLimit);
const mockedSend = vi.mocked(sendMessageHandler);

// ─── Banco da IDEMPOTÊNCIA (o da sessão/token da rota) ────────────────────────
// As cadeias exatas de `lib/api/idempotency.ts`: o helper roda de VERDADE, e o
// número que decide o caso é a CONTAGEM de envios, não a igualdade das
// respostas (um caminho que devolvesse o recibo e mandasse de novo passaria na
// igualdade e duplicaria a mensagem no WhatsApp do cliente).
function bancoDaIdempotencia() {
  const tabelas: { idempotency_keys: Linha[] } = { idempotency_keys: [] };

  const from = (nome: string) => {
    const linhas = (tabelas as Record<string, Linha[]>)[nome] ?? [];
    const eq: Array<[string, unknown]> = [];
    const isNull: Array<[string, unknown]> = [];
    let gt: [string, unknown] | null = null;
    let patch: Linha | null = null;
    let inserindo: Linha | null = null;

    const casa = (l: Linha) =>
      eq.every(([c, v]) => l[c] === v) &&
      isNull.every(([c, v]) => l[c] === v) &&
      (gt ? String(l[gt[0]]) > String(gt[1]) : true);
    const aplicar = () => {
      if (patch) {
        for (const l of linhas.filter(casa)) Object.assign(l, patch);
        patch = null;
      }
      if (inserindo) {
        linhas.push(inserindo);
        inserindo = null;
      }
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (c: string, v: unknown) => (eq.push([c, v]), b);
    b.is = (c: string, v: unknown) => (isNull.push([c, v]), b);
    b.gt = (c: string, v: unknown) => ((gt = [c, v]), b);
    b.insert = (l: Linha) => ((inserindo = l), b);
    b.update = (p: Linha) => ((patch = p), b);
    b.maybeSingle = async () => {
      aplicar();
      return { data: linhas.find(casa) ?? null, error: null };
    };
    b.single = async () => {
      aplicar();
      const l = linhas.find(casa);
      return { data: l ?? null, error: l ? null : { message: "no rows" } };
    };
    b.then = (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) => {
      aplicar();
      return Promise.resolve({ data: null, error: null }).then(comOk, comErro);
    };
    return b;
  };

  return { tabelas, supabase: { from } };
}

// ─── Banco do RESOLVEDOR (o admin, que a rota usa só na porta por telefone) ──
type Filtro = { tabela: string; coluna: string; valor: unknown };

function bancoDoResolvedor(linhas: {
  contacts?: Linha[];
  contact_phones?: Linha[];
  channel_sessions?: Linha[];
} = {}) {
  const tabelas: Record<string, Linha[]> = {
    contacts: linhas.contacts ?? [
      // A de FORA primeiro: ver o comentário de `TELEFONE`.
      {
        id: CONTATO_DE_FORA,
        organization_id: OUTRA_ORG,
        phone_number: TELEFONE,
        is_merged_into: null,
        is_personal: false,
      },
      {
        id: CONTATO_DA_CASA,
        organization_id: ORG,
        phone_number: TELEFONE,
        is_merged_into: null,
        is_personal: false,
      },
    ],
    contact_phones: linhas.contact_phones ?? [],
    channel_sessions: linhas.channel_sessions ?? [
      {
        id: SESSAO,
        organization_id: ORG,
        provider: PROVIDERS_DE_TELEFONE[0],
        status: "WORKING",
        metadata: null,
        archived_at: null,
        created_at: "2026-06-01T00:00:00Z",
      },
    ],
    organizations: [],
  };

  const filtros: Filtro[] = [];
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];

  const from = (tabela: string) => {
    let atual = [...(tabelas[tabela] ?? [])];
    let teto: number | null = null;
    const b: Record<string, unknown> = {};
    const corte = () => (teto === null ? atual : atual.slice(0, teto));
    b.select = () => b;
    b.eq = (coluna: string, valor: unknown) => {
      filtros.push({ tabela, coluna, valor });
      atual = atual.filter((l) => l[coluna] === valor);
      return b;
    };
    b.in = (coluna: string, valores: unknown[]) => {
      filtros.push({ tabela, coluna, valor: valores });
      atual = atual.filter((l) => valores.includes(l[coluna]));
      return b;
    };
    b.is = (coluna: string, valor: unknown) => {
      filtros.push({ tabela, coluna, valor });
      atual = atual.filter((l) => (l[coluna] ?? null) === valor);
      return b;
    };
    b.order = (coluna: string) => {
      atual = [...atual].sort((a, z) =>
        String(a[coluna] ?? "").localeCompare(String(z[coluna] ?? "")),
      );
      return b;
    };
    b.limit = (n: number) => {
      teto = n;
      return b;
    };
    b.maybeSingle = async () => ({ data: corte()[0] ?? null, error: null });
    b.then = (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) =>
      Promise.resolve({ data: corte(), error: null }).then(comOk, comErro);
    return b;
  };

  /**
   * `fn_service_begin` devolve a fronteira do atendimento. A conversa carrega o
   * CONTATO de quem ela é: é por isso que a asserção de organização alheia
   * consegue dizer "abriu a conversa da ficha errada" sem olhar tabela nenhuma.
   */
  const rpc = async (nome: string, args: Record<string, unknown> = {}) => {
    rpcs.push({ nome, args });
    return {
      data: {
        organization_id: args.p_org,
        contact_id: args.p_contact,
        conversation_id: conversaDe(args.p_contact),
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        status: "open",
        demanda_fechada_em: null,
      },
      error: null,
    };
  };

  return { db: { from, rpc }, filtros, rpcs };
}

let idempotencia = bancoDaIdempotencia();
let resolvedor = bancoDoResolvedor();

function autenticado() {
  idempotencia = bancoDaIdempotencia();
  resolvedor = bancoDoResolvedor();
  mockedAdmin.mockImplementation(() => resolvedor.db as never);
  mockedAuth.mockResolvedValue({
    ok: true,
    organizationId: ORG,
    actor: { type: "api_token", id: "tok-1" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: idempotencia.supabase as any,
    via: "token",
    scopes: ["mcp:read", "mcp:write"],
    apiTokenId: "tok-1",
  });
}

function pedido(
  corpo: Record<string, unknown>,
  opcoes: { chave?: string } = {},
): NextRequest {
  return new NextRequest("http://localhost/api/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opcoes.chave ? { "Idempotency-Key": opcoes.chave } : {}),
    },
    body: JSON.stringify(corpo),
  });
}

/** O corpo que o conector do DeskVoice manda, já traduzido para a porta nova. */
const POR_TELEFONE = { phone_number: TELEFONE, type: "text", body: "Ligação perdida de +55 32 98479-3302" };
const POR_CONVERSA = { conversation_id: CONVERSA, type: "text", body: "Oi!" };

beforeEach(() => {
  vi.clearAllMocks();
  mockedTeto.mockResolvedValue({ allowed: true } as never);
  mockedSend.mockResolvedValue({ id: "m1", status: "sent", conversation_id: CONVERSA } as never);
});

describe("POST /api/v1/messages — só `conversation_id`: o contrato antigo, byte a byte", () => {
  it("envia para a conversa do corpo e NÃO passa pelo resolvedor de telefone", async () => {
    autenticado();

    const res = await POST(pedido(POR_CONVERSA));

    expect(res.status).toBe(201);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    // O corpo que o handler recebe é o de SEMPRE: mesmas chaves, mesmos
    // defaults, sem `phone_number` nenhum. É esta igualdade que garante que
    // quem já integra não muda de comportamento.
    expect(mockedSend.mock.calls[0]![2]).toEqual({
      conversation_id: CONVERSA,
      type: "text",
      body: "Oi!",
    });
    // Nenhuma conversa foi aberta, nenhum contato foi consultado: o caminho
    // antigo não ganhou efeito colateral.
    expect(resolvedor.rpcs).toHaveLength(0);
    expect(resolvedor.filtros.filter((f) => f.tabela === "contacts")).toHaveLength(0);
  });
});

describe("POST /api/v1/messages — só `phone_number`: a porta nova (#4513)", () => {
  it("resolve contato + conversa pelo helper único e entrega a conversa ao handler", async () => {
    autenticado();

    const res = await POST(pedido(POR_TELEFONE));

    expect(res.status).toBe(201);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    // A conversa entregue ao handler é a da ficha DESTA organização, aberta
    // pelo `fn_service_begin` — não uma conversa inventada pela rota.
    expect(mockedSend.mock.calls[0]![2]).toEqual({
      conversation_id: conversaDe(CONTATO_DA_CASA),
      type: "text",
      body: POR_TELEFONE.body,
    });
    // Uma abertura, não duas: o helper é o ponto único, e ele roda uma vez.
    expect(resolvedor.rpcs.filter((r) => r.nome === "fn_service_begin")).toHaveLength(1);
    expect(resolvedor.rpcs[0]!.args.p_contact).toBe(CONTATO_DA_CASA);
    // `phone_number` é da PORTA: o handler não o vê.
    expect(mockedSend.mock.calls[0]![2]).not.toHaveProperty("phone_number");
  });

  it("é a MESMA busca da organização: o telefone existe nas duas e a de fora não é alcançada", async () => {
    autenticado();

    const res = await POST(pedido(POR_TELEFONE));

    expect(res.status).toBe(201);
    // A sabotagem que este teste pega: tirar o `eq("organization_id", …)` da
    // busca de contato faz a ficha de FORA voltar (ela vem primeiro e ganha o
    // desempate), e a conversa aberta passa a ser a dela.
    expect(resolvedor.rpcs[0]!.args.p_contact).toBe(CONTATO_DA_CASA);
    expect(resolvedor.rpcs[0]!.args.p_contact).not.toBe(CONTATO_DE_FORA);
    // E o escopo é um filtro de verdade na consulta, não sorte de ordenação.
    expect(resolvedor.filtros).toContainEqual({
      tabela: "contacts",
      coluna: "organization_id",
      valor: ORG,
    });
  });
});

describe("POST /api/v1/messages — os dois identificadores juntos são AMBIGUIDADE", () => {
  it("recusa com 422 `ambiguous_target` sem enviar, sem abrir conversa e sem recibo", async () => {
    autenticado();

    const res = await POST(pedido({ ...POR_TELEFONE, conversation_id: CONVERSA }, { chave: CHAVE }));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("ambiguous_target");
    expect(mockedSend).not.toHaveBeenCalled();
    // Nada de efeito: nem conversa, nem contato, nem recibo de idempotência.
    // Escolher "o id vence" aqui seria enviar para um destino que o chamador
    // não pediu — e ninguém descobriria até o cliente responder.
    expect(resolvedor.rpcs).toHaveLength(0);
    expect(idempotencia.tabelas.idempotency_keys).toHaveLength(0);
  });
});

describe("POST /api/v1/messages — nenhum dos dois", () => {
  it("recusa com 422 `validation_error` nomeado, e não 500", async () => {
    autenticado();

    const res = await POST(pedido({ type: "text", body: "Oi!" }));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(corpo.error.code).toBe("validation_error");
    expect(corpo.error.details).toBeDefined();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(resolvedor.rpcs).toHaveLength(0);
  });

  it("telefone vazio não vale como identificador", async () => {
    autenticado();

    const res = await POST(pedido({ phone_number: "   ", body: "Oi!" }));

    expect(res.status).toBe(422);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(resolvedor.rpcs).toHaveLength(0);
  });
});

describe("POST /api/v1/messages — Idempotency-Key na porta por telefone (#1613 preservado)", () => {
  it("mesma chave e mesmo corpo: UM envio, UMA conversa aberta, a MESMA resposta", async () => {
    autenticado();

    const primeira = await POST(pedido(POR_TELEFONE, { chave: CHAVE }));
    const segunda = await POST(pedido(POR_TELEFONE, { chave: CHAVE }));

    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    // A chave cobre o PAR abrir-conversa + enviar: um replay não pode abrir
    // uma segunda conversa nem criar um segundo contato.
    expect(resolvedor.rpcs.filter((r) => r.nome === "fn_service_begin")).toHaveLength(1);
    expect(await segunda.json()).toEqual(await primeira.json());
  });

  it("mesma chave e corpo DIFERENTE: 409 idempotency_conflict e nada é reenviado", async () => {
    autenticado();

    await POST(pedido(POR_TELEFONE, { chave: CHAVE }));
    const segunda = await POST(
      pedido({ ...POR_TELEFONE, body: "Outro aviso, mesmo callId." }, { chave: CHAVE }),
    );

    expect(segunda.status).toBe(409);
    const corpo = (await segunda.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("idempotency_conflict");
    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(resolvedor.rpcs.filter((r) => r.nome === "fn_service_begin")).toHaveLength(1);
  });

  it("o hash sai do corpo que CHEGOU: a mesma chave por telefone e por conversa é conflito", async () => {
    autenticado();

    await POST(pedido(POR_TELEFONE, { chave: CHAVE }));
    // Mesma mensagem, mesmo texto — mas pedida pelo outro identificador. Se o
    // hash saísse do `conversation_id` RESOLVIDO, este corpo casaria com o
    // anterior e o recibo do telefone seria devolvido a um pedido por id (ou
    // pior: o envio aconteceria de novo). São dois jeitos de pedir, não um.
    const segunda = await POST(
      pedido({ conversation_id: CONVERSA, type: "text", body: POR_TELEFONE.body }, { chave: CHAVE }),
    );

    expect(segunda.status).toBe(409);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });
});
