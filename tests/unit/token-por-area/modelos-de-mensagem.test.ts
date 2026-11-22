// @vitest-environment node
/**
 * Token de integração nas rotas de modelos de mensagem (Spec 33, fatia R1, Task 10).
 *
 * Convertidos, por método: GET /message-templates; DELETE /message-templates/[id];
 * GET /message-templates/[id]/midias/[indice]; GET e POST /message-template-groups;
 * PATCH e DELETE /message-template-groups/[id]; PUT /message-template-groups/[id]/ordem.
 * (POST /message-templates, PATCH /message-templates/[id], POST /message-templates/[id]/midias
 * e PUT /message-templates/[id]/ordem passaram a aceitar token na R1 lote 2: ver
 * `config-r1-lote2.test.ts`.)
 *
 * O token enxerga e altera só o compartilhado da organização (`owner_user_id` nulo):
 * o token não tem pessoa, e as respostas pessoais são de cada atendente.
 *
 * O banco é `criarClienteAdminFalso`: guarda linhas das duas organizações e acusa
 * cadeia sem `organization_id`. O ramo de token usa o cliente admin; o cliente de
 * sessão e o `requireRole` lançam se o ramo de token os tocar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  linhasDaTabela,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
  orgAtivaDaApi: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(),
  mfaEmDividaEstrita: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USER_DONO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TPL_A = "11111111-1111-4111-8111-111111111111";
const TPL_A_PESSOAL = "12121212-1212-4121-8121-121212121212";
const TPL_B = "22222222-2222-4222-8222-222222222222";
const GRP_A = "33333333-3333-4333-8333-333333333333";
const GRP_A2 = "34343434-3434-4343-8343-343434343434";
const GRP_B = "44444444-4444-4444-8444-444444444444";
const FOTO_A = "55555555-5555-4555-8555-555555555555";
const CAMINHO_FOTO_A = `${ORG_A}/templates/${TPL_A}/${FOTO_A}.jpg`;
const FOTO_PESSOAL = "66666666-6666-4666-8666-666666666666";
const CAMINHO_FOTO_PESSOAL = `${ORG_A}/templates/${TPL_A_PESSOAL}/${FOTO_PESSOAL}.jpg`;
const ESCOPOS_TODOS = ["config:read", "config:write"];
const MENSAGEM_DE_SESSAO = "cliente de sessão usado no ramo do token";
// Nenhuma tabela desta área é sem `organization_id` (conferido no baseline:
// `message_templates` e `message_template_groups` têm a coluna).
const SEM_ORGANIZACAO = [] as const;

const MOMENTO = "2026-08-01T10:00:00Z";

function linhasDoBanco(): Record<string, Record<string, unknown>[]> {
  return {
    message_templates: [
      {
        id: TPL_A,
        organization_id: ORG_A,
        owner_user_id: null,
        title: "Saudação A",
        body: "Oi",
        shortcut: null,
        midias: [{ storage_path: CAMINHO_FOTO_A, media_mime: "image/jpeg", media_size_bytes: 3 }],
        mostrar_na_barra: true,
        grupo_id: null,
        ordem: 1,
        created_by_user_id: USER_DONO,
        created_at: MOMENTO,
        updated_at: MOMENTO,
      },
      {
        id: TPL_A_PESSOAL,
        organization_id: ORG_A,
        owner_user_id: USER_DONO,
        title: "Pessoal",
        body: "Só meu",
        shortcut: null,
        midias: [],
        mostrar_na_barra: true,
        grupo_id: null,
        ordem: 2,
        created_by_user_id: USER_DONO,
        created_at: MOMENTO,
        updated_at: MOMENTO,
      },
      {
        id: TPL_B,
        organization_id: ORG_B,
        owner_user_id: null,
        title: "Saudação B",
        body: "Olá",
        shortcut: null,
        midias: [],
        mostrar_na_barra: true,
        grupo_id: null,
        ordem: 1,
        created_by_user_id: null,
        created_at: MOMENTO,
        updated_at: MOMENTO,
      },
    ],
    message_template_groups: [
      { id: GRP_A, organization_id: ORG_A, name: "Atendimento", ordem: 1, created_at: MOMENTO, updated_at: MOMENTO },
      { id: GRP_A2, organization_id: ORG_A, name: "Follow-up", ordem: 2, created_at: MOMENTO, updated_at: MOMENTO },
      { id: GRP_B, organization_id: ORG_B, name: "Atendimento B", ordem: 1, created_at: MOMENTO, updated_at: MOMENTO },
    ],
  };
}

/** A pessoal de A com uma imagem: sem ela, o 404 do GET midias seria só "sem imagem". */
function linhasComMidiaPessoal(): Record<string, Record<string, unknown>[]> {
  const linhas = linhasDoBanco();
  const pessoal = linhas.message_templates?.find((linha) => linha.id === TPL_A_PESSOAL);
  if (!pessoal) throw new Error("template pessoal de A ausente no teste");
  pessoal.midias = [{ storage_path: CAMINHO_FOTO_PESSOAL, media_mime: "image/jpeg", media_size_bytes: 3 }];
  return linhas;
}

// ---------------------------------------------------------------------------
// Token, sessão e bancos
// ---------------------------------------------------------------------------

type DadosDoToken = { organizationId: string; role: Role; scopes: string[] };
let tokens: Record<string, DadosDoToken>;

function resetarTokens(): void {
  tokens = {
    [TOKEN_A]: { organizationId: ORG_A, role: "admin", scopes: ESCOPOS_TODOS },
    [TOKEN_B]: { organizationId: ORG_B, role: "admin", scopes: ESCOPOS_TODOS },
  };
}

function dadoDe(chave: string): DadosDoToken {
  const dados = tokens[chave];
  if (!dados) throw new Error(`token ${chave} não configurado no teste`);
  return dados;
}

vi.mocked(validateBearerToken).mockImplementation(async (cabecalho) => {
  const chave = (cabecalho ?? "").replace(/^Bearer\s+/i, "");
  const dados = dadoDe(chave);
  return {
    organizationId: dados.organizationId,
    role: dados.role,
    actor: { type: "api_token", id: `api-${chave}`, role: dados.role },
    apiTokenId: `api-${chave}`,
    scopes: dados.scopes,
  } as never;
});

function sessaoDe(papel: Role): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_DONO, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org", role: papel },
  } as never);
}

type Falso = ReturnType<typeof criarClienteAdminFalso>;

/** Ramo de token: o cliente de sessão e o `requireRole` lançam se forem tocados. */
function bancoDoToken(linhas: Record<string, Record<string, unknown>[]>): Falso {
  const falso = criarClienteAdminFalso({ orgDona: ORG_A, linhas, tabelasSemOrganizacao: SEM_ORGANIZACAO });
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
  vi.mocked(createClient).mockImplementation(() => {
    throw new Error(MENSAGEM_DE_SESSAO);
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole usado no ramo do token");
  });
  return falso;
}

function bancoDaSessao(linhas: Record<string, Record<string, unknown>[]>): void {
  const falso = criarClienteAdminFalso({ orgDona: ORG_A, linhas, tabelasSemOrganizacao: SEM_ORGANIZACAO });
  vi.mocked(createClient).mockResolvedValue(falso.cliente as never);
  vi.mocked(createAdminClient).mockReturnValue(falso.cliente as never);
}

// ---------------------------------------------------------------------------
// Pedido e leitura de respostas
// ---------------------------------------------------------------------------

type Metodo = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function pedido(metodo: Metodo, caminho: string, corpo: unknown, cabecalhos: Record<string, string>): NextRequest {
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {
    method: metodo,
    headers: { ...cabecalhos },
  };
  if (corpo !== undefined) {
    init.headers = { ...cabecalhos, "content-type": "application/json" };
    init.body = JSON.stringify(corpo);
  }
  return new NextRequest(`http://localhost${caminho}`, init);
}

async function idsDe(r: Response): Promise<string[]> {
  const corpo = (await r.json()) as { data: { id: string }[] };
  return corpo.data.map((linha) => linha.id);
}

function linhaDe(falso: Falso, tabela: string, id: string): Record<string, unknown> | undefined {
  return falso.linhas[tabela]?.find((linha) => linha.id === id);
}

type Alvo = {
  caminho: string;
  params?: Record<string, string>;
  corpo?: unknown;
  cabecalhos: Record<string, string>;
};

type Caso = {
  metodo: Metodo;
  modulo: () => Promise<object>;
  caminho: string;
  params?: Record<string, string>;
  corpo?: unknown;
  /** Token de B: o caminho que B pede (por padrão, o mesmo de A). */
  caminhoB?: string;
  paramsB?: Record<string, string>;
  corpoB?: unknown;
  linhas: () => Record<string, Record<string, unknown>[]>;
  papel: Role;
  escopoCerto: string;
  escopoErrado: string;
  statusA: number;
  statusB: number;
  verificaA: (r: Response, falso: Falso) => void | Promise<void>;
  verificaB: (r: Response, falso: Falso) => void | Promise<void>;
};

async function chamar(caso: Caso, alvo: Alvo): Promise<Response> {
  const modulo = (await caso.modulo()) as unknown as Record<Metodo, Handler>;
  const handler = modulo[caso.metodo];
  return handler(pedido(caso.metodo, alvo.caminho, alvo.corpo, alvo.cabecalhos), {
    params: Promise.resolve(alvo.params ?? {}),
  });
}

function suiteDoCaso(caso: Caso): void {
  const titulo = `${caso.metodo} ${caso.caminho}`;
  const alvoA: Alvo = {
    caminho: caso.caminho,
    params: caso.params,
    corpo: caso.corpo,
    cabecalhos: { authorization: `Bearer ${TOKEN_A}` },
  };
  const alvoB: Alvo = {
    caminho: caso.caminhoB ?? caso.caminho,
    params: caso.paramsB ?? caso.params,
    corpo: caso.corpoB ?? caso.corpo,
    cabecalhos: { authorization: `Bearer ${TOKEN_B}` },
  };

  describe(titulo, () => {
    it(`${titulo}: token de A alcança o recurso de A`, async () => {
      const falso = bancoDoToken(caso.linhas());
      const r = await chamar(caso, alvoA);
      expect(r.status).toBe(caso.statusA);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
      await caso.verificaA(r, falso);
    });

    it(`${titulo}: token de B não alcança o recurso de A`, async () => {
      const falso = bancoDoToken(caso.linhas());
      const r = await chamar(caso, alvoB);
      expect(r.status).toBe(caso.statusB);
      expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B, { tabelasSemOrganizacao: SEM_ORGANIZACAO })).toEqual([]);
      expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
      await caso.verificaB(r, falso);
    });

    it(`${titulo}: token sem o escopo é recusado`, async () => {
      const falso = bancoDoToken(caso.linhas());
      dadoDe(TOKEN_A).scopes = [caso.escopoErrado];
      const r = await chamar(caso, alvoA);
      expect(r.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
      expect(vi.mocked(audit)).not.toHaveBeenCalled();
    });

    it(`${titulo}: token abaixo do papel é recusado`, async () => {
      const falso = bancoDoToken(caso.linhas());
      dadoDe(TOKEN_A).role = "manager";
      const r = await chamar(caso, alvoA);
      expect(r.status).toBe(403);
      expect(falso.cadeias).toEqual([]);
    });

    it(`${titulo}: acima do teto do token → 429`, async () => {
      const falso = bancoDoToken(caso.linhas());
      vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, remaining: 0 } as never);
      const r = await chamar(caso, alvoA);
      expect(r.status).toBe(429);
      expect(r.headers.get("Retry-After")).not.toBeNull();
      expect(falso.cadeias).toEqual([]);
    });

    it(`${titulo}: sessão continua com o mesmo portão`, async () => {
      sessaoDe(caso.papel);
      bancoDaSessao(caso.linhas());
      const r = await chamar(caso, { caminho: caso.caminho, params: caso.params, corpo: caso.corpo, cabecalhos: {} });
      expect(vi.mocked(requireRole)).toHaveBeenCalledWith(
        caso.papel,
        expect.objectContaining({ resource: "message_templates" }),
      );
      expect(vi.mocked(validateBearerToken)).not.toHaveBeenCalled();
      expect(r.status).toBe(caso.statusA);
    });
  });
}

// ---------------------------------------------------------------------------
// Casos, um por método convertido
// ---------------------------------------------------------------------------

suiteDoCaso({
  metodo: "GET",
  modulo: () => import("@/app/api/v1/message-templates/route"),
  caminho: "/api/v1/message-templates",
  linhas: linhasDoBanco,
  papel: "agent",
  escopoCerto: "config:read",
  escopoErrado: "config:write",
  statusA: 200,
  statusB: 200,
  // Só o compartilhado: a pessoal (owner = USER_DONO) não aparece para o token.
  verificaA: async (r) => {
    expect(await idsDe(r)).toEqual([TPL_A]);
  },
  verificaB: async (r) => {
    expect(await idsDe(r)).toEqual([TPL_B]);
  },
});

suiteDoCaso({
  metodo: "DELETE",
  modulo: () => import("@/app/api/v1/message-templates/[id]/route"),
  caminho: `/api/v1/message-templates/${TPL_A}`,
  params: { id: TPL_A },
  linhas: linhasDoBanco,
  papel: "agent",
  escopoCerto: "config:write",
  escopoErrado: "config:read",
  statusA: 204,
  statusB: 404,
  verificaA: (_r, falso) => {
    expect(linhaDe(falso, "message_templates", TPL_A)).toBeUndefined();
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "template.deleted",
        actorUserId: null,
        actorApiTokenId: "api-tok-a",
        organizationId: ORG_A,
      }),
    );
  },
  verificaB: (_r, falso) => {
    expect(linhaDe(falso, "message_templates", TPL_A)).toBeDefined();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  },
});

suiteDoCaso({
  metodo: "GET",
  modulo: () => import("@/app/api/v1/message-templates/[id]/midias/[indice]/route"),
  caminho: `/api/v1/message-templates/${TPL_A}/midias/0`,
  params: { id: TPL_A, indice: "0" },
  linhas: linhasDoBanco,
  papel: "agent",
  escopoCerto: "config:read",
  escopoErrado: "config:write",
  statusA: 200,
  statusB: 404,
  verificaA: async (r, falso) => {
    expect(r.headers.get("Content-Type")).toBe("image/jpeg");
    expect((await r.arrayBuffer()).byteLength).toBe(3);
    expect(falso.uploads).toEqual([
      expect.objectContaining({ bucket: "whatsapp-media", caminho: CAMINHO_FOTO_A, operacao: "download" }),
    ]);
  },
  // Sem a linha visível para B, o objeto nem é aberto no bucket.
  verificaB: (_r, falso) => {
    expect(falso.uploads).toEqual([]);
  },
});

suiteDoCaso({
  metodo: "GET",
  modulo: () => import("@/app/api/v1/message-template-groups/route"),
  caminho: "/api/v1/message-template-groups",
  linhas: linhasDoBanco,
  papel: "agent",
  escopoCerto: "config:read",
  escopoErrado: "config:write",
  statusA: 200,
  statusB: 200,
  verificaA: async (r) => {
    expect(await idsDe(r)).toEqual([GRP_A, GRP_A2]);
  },
  verificaB: async (r) => {
    expect(await idsDe(r)).toEqual([GRP_B]);
  },
});

suiteDoCaso({
  metodo: "POST",
  modulo: () => import("@/app/api/v1/message-template-groups/route"),
  caminho: "/api/v1/message-template-groups",
  corpo: { name: "Negociação" },
  linhas: linhasDoBanco,
  papel: "manager",
  escopoCerto: "config:write",
  escopoErrado: "config:read",
  statusA: 201,
  statusB: 201,
  // Criação sem id no caminho: a linha nasce na organização do token, e a de A fica como estava.
  verificaA: async (r, falso) => {
    const corpo = (await r.json()) as { data: { organization_id: string } };
    expect(corpo.data.organization_id).toBe(ORG_A);
    expect(linhasDaTabela(falso, "message_template_groups").some((l) => l.name === "Negociação" && l.organization_id === ORG_A)).toBe(
      true,
    );
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "template_group.created",
        actorUserId: null,
        actorApiTokenId: "api-tok-a",
        organizationId: ORG_A,
      }),
    );
  },
  verificaB: async (r, falso) => {
    const corpo = (await r.json()) as { data: { organization_id: string } };
    expect(corpo.data.organization_id).toBe(ORG_B);
    expect(linhasDaTabela(falso, "message_template_groups").filter((l) => l.organization_id === ORG_A)).toHaveLength(2);
  },
});

suiteDoCaso({
  metodo: "PATCH",
  modulo: () => import("@/app/api/v1/message-template-groups/[id]/route"),
  caminho: `/api/v1/message-template-groups/${GRP_A}`,
  params: { id: GRP_A },
  corpo: { name: "Novo nome" },
  linhas: linhasDoBanco,
  papel: "manager",
  escopoCerto: "config:write",
  escopoErrado: "config:read",
  statusA: 200,
  statusB: 404,
  verificaA: async (r) => {
    const corpo = (await r.json()) as { data: { name: string } };
    expect(corpo.data.name).toBe("Novo nome");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template_group.updated", actorUserId: null, actorApiTokenId: "api-tok-a" }),
    );
  },
  verificaB: (_r, falso) => {
    expect(linhaDe(falso, "message_template_groups", GRP_A)?.name).toBe("Atendimento");
  },
});

suiteDoCaso({
  metodo: "DELETE",
  modulo: () => import("@/app/api/v1/message-template-groups/[id]/route"),
  caminho: `/api/v1/message-template-groups/${GRP_A}`,
  params: { id: GRP_A },
  linhas: linhasDoBanco,
  papel: "manager",
  escopoCerto: "config:write",
  escopoErrado: "config:read",
  statusA: 204,
  statusB: 404,
  verificaA: (_r, falso) => {
    expect(linhaDe(falso, "message_template_groups", GRP_A)).toBeUndefined();
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template_group.deleted", actorUserId: null, actorApiTokenId: "api-tok-a" }),
    );
  },
  verificaB: (_r, falso) => {
    expect(linhaDe(falso, "message_template_groups", GRP_A)).toBeDefined();
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  },
});

suiteDoCaso({
  metodo: "PUT",
  modulo: () => import("@/app/api/v1/message-template-groups/[id]/ordem/route"),
  caminho: `/api/v1/message-template-groups/${GRP_A2}/ordem`,
  params: { id: GRP_A2 },
  corpo: { depois_de: GRP_A },
  // B pede a própria linha e aponta para um vizinho de A: o vizinho não é da organização.
  caminhoB: `/api/v1/message-template-groups/${GRP_B}/ordem`,
  paramsB: { id: GRP_B },
  corpoB: { depois_de: GRP_A },
  linhas: linhasDoBanco,
  papel: "manager",
  escopoCerto: "config:write",
  escopoErrado: "config:read",
  statusA: 200,
  statusB: 422,
  verificaA: async (r) => {
    const corpo = (await r.json()) as { data: { id: string } };
    expect(corpo.data.id).toBe(GRP_A2);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template_group.reordered", actorUserId: null, actorApiTokenId: "api-tok-a" }),
    );
  },
  verificaB: (_r, falso) => {
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  },
});

// ---------------------------------------------------------------------------
// Borda do token: modelo pessoal de A, id de A pedido por B, teto da organização
// ---------------------------------------------------------------------------

describe("token de A não alcança o modelo pessoal (owner_user_id não nulo)", () => {
  it(`DELETE /message-templates/${TPL_A_PESSOAL}: 404, linha e imagem intactas`, async () => {
    const falso = bancoDoToken(linhasComMidiaPessoal());
    const { DELETE } = await import("@/app/api/v1/message-templates/[id]/route");
    const r = await DELETE(
      pedido("DELETE", `/api/v1/message-templates/${TPL_A_PESSOAL}`, undefined, {
        authorization: `Bearer ${TOKEN_A}`,
      }),
      { params: Promise.resolve({ id: TPL_A_PESSOAL }) },
    );
    expect(r.status).toBe(404);
    expect(linhaDe(falso, "message_templates", TPL_A_PESSOAL)).toBeDefined();
    expect(falso.uploads).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it(`GET /message-templates/${TPL_A_PESSOAL}/midias/0: 404 e o objeto não é aberto no bucket`, async () => {
    const falso = bancoDoToken(linhasComMidiaPessoal());
    const { GET } = await import("@/app/api/v1/message-templates/[id]/midias/[indice]/route");
    const r = await GET(
      pedido("GET", `/api/v1/message-templates/${TPL_A_PESSOAL}/midias/0`, undefined, {
        authorization: `Bearer ${TOKEN_A}`,
      }),
      { params: Promise.resolve({ id: TPL_A_PESSOAL, indice: "0" }) },
    );
    expect(r.status).toBe(404);
    expect(falso.uploads).toEqual([]);
  });
});

describe("PUT /message-template-groups/[id]/ordem: token de B com o id de A na URL", () => {
  it(`PUT /message-template-groups/${GRP_A2}/ordem: 404 e nenhuma escrita`, async () => {
    const falso = bancoDoToken(linhasDoBanco());
    const { PUT } = await import("@/app/api/v1/message-template-groups/[id]/ordem/route");
    // `depois_de` é um grupo de B: o 404 só pode vir do `id` da URL, que não é de B.
    const r = await PUT(
      pedido("PUT", `/api/v1/message-template-groups/${GRP_A2}/ordem`, { depois_de: GRP_B }, {
        authorization: `Bearer ${TOKEN_B}`,
      }),
      { params: Promise.resolve({ id: GRP_A2 }) },
    );
    expect(r.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhaDe(falso, "message_template_groups", GRP_A2)).toMatchObject({ name: "Follow-up", ordem: 2 });
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe("teto por organização (segundo contador do token)", () => {
  it(`DELETE /message-templates/${TPL_A}: teto da organização estourado → 429, nada escrito`, async () => {
    const falso = bancoDoToken(linhasDoBanco());
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true, remaining: 10 } as never)
      .mockResolvedValueOnce({ allowed: false, remaining: 0 } as never);
    const { DELETE } = await import("@/app/api/v1/message-templates/[id]/route");
    const r = await DELETE(
      pedido("DELETE", `/api/v1/message-templates/${TPL_A}`, undefined, { authorization: `Bearer ${TOKEN_A}` }),
      { params: Promise.resolve({ id: TPL_A }) },
    );
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).not.toBeNull();
    expect(vi.mocked(checkRateLimit).mock.calls[1]?.[0]).toBe(`message_templates.item:org:${ORG_A}`);
    expect(falso.cadeias).toEqual([]);
    expect(linhaDe(falso, "message_templates", TPL_A)).toBeDefined();
    expect(falso.uploads).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bloco de borda das portas
// ---------------------------------------------------------------------------

describe("isPublicPath: portas das rotas de modelos", () => {
  it("message-templates: [id] só com forma de UUID; sub-path fica de fora", () => {
    expect(isPublicPath("/api/v1/message-templates")).toBe(true);
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}`)).toBe(true);
    expect(isPublicPath("/api/v1/message-templates/abc")).toBe(false);
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}/x`)).toBe(false);
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}/midias`)).toBe(true);
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}/ordem`)).toBe(true);
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}/midias/x`)).toBe(false);
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}/ordem/x`)).toBe(false);
  });

  it("midias/[indice]: índice numérico entra; o resto não", () => {
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}/midias/0`)).toBe(true);
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}/midias/abc`)).toBe(false);
    expect(isPublicPath(`/api/v1/message-templates/${TPL_A}/midias/0/x`)).toBe(false);
  });

  it("message-template-groups: [id] com UUID; ordem entra; sub-path fica de fora", () => {
    expect(isPublicPath("/api/v1/message-template-groups")).toBe(true);
    expect(isPublicPath(`/api/v1/message-template-groups/${GRP_A}`)).toBe(true);
    expect(isPublicPath("/api/v1/message-template-groups/abc")).toBe(false);
    expect(isPublicPath(`/api/v1/message-template-groups/${GRP_A}/ordem`)).toBe(true);
    expect(isPublicPath(`/api/v1/message-template-groups/${GRP_A}/ordem/x`)).toBe(false);
    expect(isPublicPath(`/api/v1/message-template-groups/${GRP_A}/x`)).toBe(false);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  resetarTokens();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, remaining: 10 } as never);
});
