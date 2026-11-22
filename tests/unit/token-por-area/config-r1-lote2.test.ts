// @vitest-environment node
/**
 * Token de integração nas rotas do lote 2 da fatia R1 (Spec 33):
 *
 *   GET    attendants/sectors                 config:read   viewer (sessão)   admin (token)
 *   POST   message-templates                  config:write  agent             admin
 *   PATCH  message-templates/[id]             config:write  agent             admin
 *   POST   message-templates/[id]/midias      config:write  agent             admin
 *   PUT    message-templates/[id]/ordem       config:write  agent             admin
 *
 * Ficam só de sessão (bloco próprio de 401 ao token): criar, renomear e apagar
 * setor (`attendants/sectors` POST, `attendants/sectors/[id]` PATCH/DELETE) e
 * trocar as filas de uma pessoa (`attendants/sector/[user_id]` PUT). A escrita
 * da área de equipe pelo token espera o ok do mantenedor.
 *
 * Fica de FORA (PAREI, relatado): `automation-rules` POST. A ação da regra carrega
 * ids de outras tabelas (funil, etapa, canal, agente, pessoa, fluxo, aninhados em
 * `ai_decide`) dentro de jsonb, sem FK e sem conferência de organização; o token
 * passaria a gravar regra apontando para id de outra organização.
 *
 * Cada método tem a bateria da receita R:
 *  - token de A alcança o recurso de A (2xx), sem consulta fora de A, e a escrita
 *    sai com ator de token (`actorUserId` nulo, `actorApiTokenId` preenchido);
 *  - token de B não alcança o recurso de A;
 *  - token sem o escopo é recusado (403);
 *  - token abaixo do papel (manager < admin do `tokenRole`) é recusado (403);
 *  - acima do teto do token → 429 com Retry-After, sem tocar no banco;
 *  - sessão (sem Authorization) continua pelo `requireRole` com o papel da tabela.
 *
 * Nos modelos de mensagem o token só enxerga e altera o COMPARTILHADO
 * (`owner_user_id` nulo): há um bloco próprio provando que a resposta pessoal
 * (owner preenchido) não é alcançada, nem pela lista nem pelo vizinho da ordem.
 *
 * O banco do ramo do token é `criarClienteAdminFalso`, que guarda as linhas das
 * duas organizações e ACUSA consulta sem `organization_id`. O cliente de sessão e
 * o `requireRole` lançam se o ramo do token os tocar.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import type { Role } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ordemDaRenumeracao } from "@/lib/templates/ordem";
import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaSetorDoAtendente from "@/app/api/v1/attendants/sector/[user_id]/route";
import * as rotaSetor from "@/app/api/v1/attendants/sectors/[id]/route";
import * as rotaSetores from "@/app/api/v1/attendants/sectors/route";
import * as rotaModelos from "@/app/api/v1/message-templates/route";
import * as rotaModelo from "@/app/api/v1/message-templates/[id]/route";
import * as rotaMidias from "@/app/api/v1/message-templates/[id]/midias/route";
import * as rotaOrdem from "@/app/api/v1/message-templates/[id]/ordem/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn() }));
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
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const MARCA_A = "MARCA-DA-ORG-A-3f1c";
const MARCA_B = "MARCA-DA-ORG-B-9d2e";
const MOMENTO = "2026-08-01T10:00:00Z";

const GERENTE = "c0000000-0000-4000-8000-000000000001";
const USER_DONO = "c0000000-0000-4000-8000-000000000002";
const ANA_A = "d0000000-0000-4000-8000-00000000000a";
const ANA_B = "d0000000-0000-4000-8000-00000000000b";

const SETOR_A = "e1000000-0000-4000-8000-00000000000a";
const SETOR_A2 = "e1000000-0000-4000-8000-0000000000a2";
const SETOR_B = "e1000000-0000-4000-8000-00000000000b";

const TPL_PESSOAL = "f1000000-0000-4000-8000-000000000000";
const TPL_A = "f1000000-0000-4000-8000-00000000000a";
const TPL_A2 = "f1000000-0000-4000-8000-0000000000a2";
const TPL_A3 = "f1000000-0000-4000-8000-0000000000a3";
const TPL_B = "f1000000-0000-4000-8000-00000000000b";
const GRP_A = "a2000000-0000-4000-8000-00000000000a";
const GRP_B = "a2000000-0000-4000-8000-00000000000b";
const FOTO_A = "a3000000-0000-4000-8000-00000000000a";
const FOTO_PESSOAL = "a3000000-0000-4000-8000-000000000000";

const MIDIA_A = {
  storage_path: `${ORG_A}/templates/${TPL_A}/${FOTO_A}.jpg`,
  media_mime: "image/jpeg",
  media_size_bytes: 3,
};
const MIDIA_PESSOAL = {
  storage_path: `${ORG_A}/templates/${TPL_PESSOAL}/${FOTO_PESSOAL}.jpg`,
  media_mime: "image/jpeg",
  media_size_bytes: 3,
};

type Linha = Record<string, unknown>;

function setor(id: string, org: string, name: string): Linha {
  return {
    id,
    organization_id: org,
    name,
    description: null,
    color: null,
    schedule: {},
    created_at: MOMENTO,
    updated_at: MOMENTO,
  };
}

function modelo(id: string, org: string, extra: Linha): Linha {
  return {
    id,
    organization_id: org,
    owner_user_id: null,
    title: "Modelo",
    body: "Oi",
    shortcut: null,
    midias: [],
    mostrar_na_barra: true,
    grupo_id: null,
    created_by_user_id: USER_DONO,
    ordem: 1000,
    created_at: MOMENTO,
    updated_at: MOMENTO,
    ...extra,
  };
}

/**
 * A ordem de inserção é a da lista que a tela veria (o dublê não ordena). A
 * resposta PESSOAL vem primeiro, com a menor `ordem`: se alguma consulta do token
 * a incluísse, a posição calculada sairia diferente da esperada.
 */
function linhasDoBanco(): Record<string, Linha[]> {
  return {
    user_organizations: [
      { organization_id: ORG_A, user_id: ANA_A, role: "agent", revoked_at: null },
      { organization_id: ORG_B, user_id: ANA_B, role: "agent", revoked_at: null },
    ],
    attendant_sectors: [
      setor(SETOR_A, ORG_A, `Fila ${MARCA_A}`),
      setor(SETOR_A2, ORG_A, "Fila A2"),
      setor(SETOR_B, ORG_B, `Fila ${MARCA_B}`),
    ],
    attendant_sector_members: [
      { organization_id: ORG_A, user_id: ANA_A, sector_id: SETOR_A },
      { organization_id: ORG_B, user_id: ANA_B, sector_id: SETOR_B },
    ],
    message_template_groups: [
      { id: GRP_A, organization_id: ORG_A, name: "Grupo A", ordem: 1000, created_at: MOMENTO, updated_at: MOMENTO },
      { id: GRP_B, organization_id: ORG_B, name: "Grupo B", ordem: 1000, created_at: MOMENTO, updated_at: MOMENTO },
    ],
    message_templates: [
      modelo(TPL_PESSOAL, ORG_A, {
        owner_user_id: USER_DONO,
        title: "Pessoal",
        body: "Só meu",
        midias: [MIDIA_PESSOAL],
        ordem: 500,
      }),
      modelo(TPL_A, ORG_A, { title: `Saudação ${MARCA_A}`, midias: [MIDIA_A], ordem: 1000 }),
      modelo(TPL_A2, ORG_A, { title: "Segunda A", ordem: 2000 }),
      modelo(TPL_A3, ORG_A, { title: "Terceira A", ordem: 3000 }),
      modelo(TPL_B, ORG_B, { title: `Saudação ${MARCA_B}`, ordem: 1000 }),
    ],
  };
}

type Falso = ReturnType<typeof criarClienteAdminFalso>;
let falso: Falso;

function novoFalso(linhas: Record<string, Linha[]> = linhasDoBanco()): Falso {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas });
}

function linhaDe(f: Falso, tabela: string, id: string): Linha | undefined {
  return f.linhas[tabela]?.find((l) => l.id === id);
}

function tokenDe(org: string, token: string, role: Role, scopes: string[] = TODOS_OS_ESCOPOS): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function reqDe(metodo: string, caminho: string, token?: string, corpo?: unknown): NextRequest {
  return new NextRequest(`http://localhost${caminho}`, {
    method: metodo,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(corpo !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];

function reqMidia(caminho: string, token?: string): NextRequest {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(JPEG)], "foto.jpg", { type: "image/jpeg" }));
  return new NextRequest(`http://localhost${caminho}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

const comId = (id: string) => ({ params: Promise.resolve({ id }) });
const comUserId = (user_id: string) => ({ params: Promise.resolve({ user_id }) });

// ---------------------------------------------------------------------------
// A matriz: um caso por método
// ---------------------------------------------------------------------------

type Caso = {
  nome: string;
  /** Papel que a SESSÃO exige hoje (e que o ramo de sessão continua chamando). */
  papel: Role;
  /** `resource` que `requireRole` recebe na sessão. */
  resource: string;
  escopo: "config:read" | "config:write";
  escreve: boolean;
  statusDeSucesso: number;
  acao?: string;
  /** `token` indefinido = sessão. O token de B pede o MESMO caminho de A: o recurso é de A. */
  chamar: (token?: string) => Promise<Response>;
  verificaA: (res: Response, f: Falso) => Promise<void>;
  verificaB: (res: Response, f: Falso) => Promise<void>;
};

async function corpoDe(res: Response): Promise<{ data: Linha }> {
  return (await res.clone().json()) as { data: Linha };
}

const CASOS: Caso[] = [
  {
    nome: "GET /attendants/sectors",
    papel: "viewer",
    resource: "attendant_sectors",
    escopo: "config:read",
    escreve: false,
    statusDeSucesso: 200,
    chamar: (token) => rotaSetores.GET(reqDe("GET", "/api/v1/attendants/sectors", token)),
    verificaA: async (res) => {
      const texto = await res.text();
      expect(texto).toContain(MARCA_A);
      expect(texto).not.toContain(MARCA_B);
    },
    verificaB: async (res) => {
      expect(res.status).toBe(200);
      const texto = await res.text();
      expect(texto).toContain(MARCA_B);
      expect(texto).not.toContain(MARCA_A);
    },
  },
  {
    nome: "POST /message-templates",
    papel: "agent",
    resource: "message_templates",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 201,
    acao: "template.created",
    chamar: (token) =>
      rotaModelos.POST(
        reqDe("POST", "/api/v1/message-templates", token, { title: "Nova saudação", body: "Olá", shared: true }),
      ),
    verificaA: async (res) => {
      const { data } = await corpoDe(res);
      expect(data).toMatchObject({
        organization_id: ORG_A,
        owner_user_id: null,
        created_by_user_id: null,
        title: "Nova saudação",
      });
      // Nasce um passo acima da primeira COMPARTILHADA (1000): a pessoal (500) não conta.
      expect(data.ordem).toBe(0);
    },
    verificaB: async (res, f) => {
      expect(res.status).toBe(201);
      const { data } = await corpoDe(res);
      expect(data.organization_id).toBe(ORG_B);
      const novas = (f.linhas.message_templates ?? []).filter((l) => l.title === "Nova saudação");
      expect(novas.map((l) => l.organization_id)).toEqual([ORG_B]);
    },
  },
  {
    nome: "PATCH /message-templates/[id]",
    papel: "agent",
    resource: "message_templates",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 200,
    acao: "template.updated",
    chamar: (token) =>
      rotaModelo.PATCH(reqDe("PATCH", `/api/v1/message-templates/${TPL_A}`, token, { title: "Título novo" }), comId(TPL_A)),
    verificaA: async (res, f) => {
      expect((await corpoDe(res)).data.title).toBe("Título novo");
      expect(linhaDe(f, "message_templates", TPL_A)?.title).toBe("Título novo");
    },
    verificaB: async (res, f) => {
      expect(res.status).toBe(404);
      expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
      expect(linhaDe(f, "message_templates", TPL_A)?.title).toBe(`Saudação ${MARCA_A}`);
    },
  },
  {
    nome: "POST /message-templates/[id]/midias",
    papel: "agent",
    resource: "message_templates",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 200,
    acao: "template.media_added",
    chamar: (token) => rotaMidias.POST(reqMidia(`/api/v1/message-templates/${TPL_A}/midias`, token), comId(TPL_A)),
    verificaA: async (res, f) => {
      const { data } = await corpoDe(res);
      expect((data.midias as unknown[]).length).toBe(2);
      expect(f.uploads.length).toBe(1);
      expect(f.uploads[0]!.caminho.startsWith(`${ORG_A}/templates/${TPL_A}/`)).toBe(true);
      expect(arquivosForaDaOrganizacao(f.uploads, ORG_A)).toEqual([]);
    },
    verificaB: async (res, f) => {
      expect(res.status).toBe(404);
      expect(f.uploads).toEqual([]);
      expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
    },
  },
  {
    nome: "PUT /message-templates/[id]/ordem",
    papel: "agent",
    resource: "message_templates",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 200,
    acao: "template.reordered",
    chamar: (token) =>
      rotaOrdem.PUT(reqDe("PUT", `/api/v1/message-templates/${TPL_A3}/ordem`, token, { depois_de: null }), comId(TPL_A3)),
    verificaA: async (res, f) => {
      // Primeira posição entre as COMPARTILHADAS: 1000 - 1000 = 0 (com a pessoal na conta seria -500).
      expect((await corpoDe(res)).data.ordem).toBe(0);
      expect(linhaDe(f, "message_templates", TPL_A3)?.ordem).toBe(0);
      expect(linhaDe(f, "message_templates", TPL_PESSOAL)?.ordem).toBe(500);
    },
    verificaB: async (res, f) => {
      expect(res.status).toBe(404);
      expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
      expect(linhaDe(f, "message_templates", TPL_A3)?.ordem).toBe(3000);
    },
  },
];

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  falso = novoFalso();
  vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(moduloLigado).mockResolvedValue(true);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 30 } as never);
});

// ---------------------------------------------------------------------------
// A bateria de 6 testes, por método
// ---------------------------------------------------------------------------

describe.each(CASOS)("$nome", (caso) => {
  it("token de A alcança o recurso de A, sem consulta fora de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(caso.statusDeSucesso);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    await caso.verificaA(res, falso);
    if (caso.escreve) {
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: caso.acao,
          organizationId: ORG_A,
          actorUserId: null,
          actorApiTokenId: TOKEN_A,
        }),
      );
    } else {
      expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    }
  });

  it("token de B não alcança o recurso de A", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await caso.chamar(TOKEN_B);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
    await caso.verificaB(res, falso);
    if (caso.escreve && res.status >= 400) expect(audit).not.toHaveBeenCalled();
    if (caso.escreve && res.status < 400) {
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_B, actorUserId: null }));
      expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG_A }));
    }
  });

  it("token sem o escopo exigido é recusado (403), sem consulta", async () => {
    tokenDe(
      ORG_A,
      TOKEN_A,
      "admin",
      TODOS_OS_ESCOPOS.filter((e) => e !== caso.escopo),
    );
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
    expect(falso.uploads).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel (manager < admin do tokenRole) é recusado (403), sem consulta", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
    expect(falso.uploads).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem tocar no banco", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
    expect(falso.uploads).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sessão (sem Authorization) continua pelo requireRole com o papel da tabela", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await caso.chamar(undefined);
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(caso.papel, expect.objectContaining({ resource: caso.resource }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(falso.cadeias).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Setores e filas: só de sessão
// ---------------------------------------------------------------------------

describe("setores e filas ficam só de sessão: o token recebe 401, sem consulta e sem audit", () => {
  it.each([
    ["PUT /attendants/sector/[user_id]", "attendant_sector_members", () =>
      rotaSetorDoAtendente.PUT(
        reqDe("PUT", `/api/v1/attendants/sector/${ANA_A}`, TOKEN_A, { sector_ids: [SETOR_A2] }),
        comUserId(ANA_A),
      )],
    ["PATCH /attendants/sectors/[id]", "attendant_sectors", () =>
      rotaSetor.PATCH(reqDe("PATCH", `/api/v1/attendants/sectors/${SETOR_A}`, TOKEN_A, { name: "Renomeada" }), comId(SETOR_A))],
    ["DELETE /attendants/sectors/[id]", "attendant_sectors", () =>
      rotaSetor.DELETE(reqDe("DELETE", `/api/v1/attendants/sectors/${SETOR_A2}`, TOKEN_A), comId(SETOR_A2))],
    ["POST /attendants/sectors", "attendant_sectors", () =>
      rotaSetores.POST(reqDe("POST", "/api/v1/attendants/sectors", TOKEN_A, { name: "Nova fila" }))],
  ] as const)("%s: sem cookie, o requireRole responde 401 ao token", async (_rotulo, resource, chamar) => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await chamar();
    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource }));
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Modelos de mensagem: o token só alcança o COMPARTILHADO
// ---------------------------------------------------------------------------

describe("modelos de mensagem: token não alcança a resposta pessoal (owner_user_id preenchido)", () => {
  it("PATCH na pessoal → 404, linha intacta", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaModelo.PATCH(
      reqDe("PATCH", `/api/v1/message-templates/${TPL_PESSOAL}`, TOKEN_A, { title: "Tomei" }),
      comId(TPL_PESSOAL),
    );
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhaDe(falso, "message_templates", TPL_PESSOAL)?.title).toBe("Pessoal");
    expect(audit).not.toHaveBeenCalled();
  });

  it("POST de mídia na pessoal → 404, nada sobe para o bucket", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaMidias.POST(
      reqMidia(`/api/v1/message-templates/${TPL_PESSOAL}/midias`, TOKEN_A),
      comId(TPL_PESSOAL),
    );
    expect(res.status).toBe(404);
    expect(falso.uploads).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect((linhaDe(falso, "message_templates", TPL_PESSOAL)?.midias as unknown[]).length).toBe(1);
  });

  it("PUT de ordem na pessoal → 404, nenhuma escrita", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaOrdem.PUT(
      reqDe("PUT", `/api/v1/message-templates/${TPL_PESSOAL}/ordem`, TOKEN_A, { depois_de: null }),
      comId(TPL_PESSOAL),
    );
    expect(res.status).toBe(404);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(linhaDe(falso, "message_templates", TPL_PESSOAL)?.ordem).toBe(500);
  });

  it("PUT de ordem com a pessoal como vizinha → 422, nenhuma escrita", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaOrdem.PUT(
      reqDe("PUT", `/api/v1/message-templates/${TPL_A}/ordem`, TOKEN_A, { depois_de: TPL_PESSOAL }),
      comId(TPL_A),
    );
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });

  it("PUT de ordem com a vizinha de outra organização → 422, nenhuma escrita", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaOrdem.PUT(
      reqDe("PUT", `/api/v1/message-templates/${TPL_A}/ordem`, TOKEN_A, { depois_de: TPL_B }),
      comId(TPL_A),
    );
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });
});

describe("PUT /message-templates/[id]/ordem com token: renumeração só entre as compartilhadas", () => {
  it("empate entre as compartilhadas renumera só elas; a pessoal (mesma ordem) fica como está", async () => {
    const linhas = linhasDoBanco();
    linhas.message_templates = [
      modelo(TPL_PESSOAL, ORG_A, { owner_user_id: USER_DONO, ordem: 1000 }),
      modelo(TPL_A, ORG_A, { ordem: 1000 }),
      modelo(TPL_A2, ORG_A, { ordem: 1000 }),
      modelo(TPL_A3, ORG_A, { ordem: 1000 }),
      modelo(TPL_B, ORG_B, { ordem: 1000 }),
    ];
    falso = novoFalso(linhas);
    vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
    tokenDe(ORG_A, TOKEN_A, "admin");

    // A solta DEPOIS de A2: as vizinhas A2 e A3 empatam, então não há posição entre elas.
    const res = await rotaOrdem.PUT(
      reqDe("PUT", `/api/v1/message-templates/${TPL_A}/ordem`, TOKEN_A, { depois_de: TPL_A2 }),
      comId(TPL_A),
    );
    expect(res.status).toBe(200);
    expect(linhaDe(falso, "message_templates", TPL_A2)?.ordem).toBe(ordemDaRenumeracao(0));
    expect(linhaDe(falso, "message_templates", TPL_A)?.ordem).toBe(ordemDaRenumeracao(1));
    expect(linhaDe(falso, "message_templates", TPL_A3)?.ordem).toBe(ordemDaRenumeracao(2));
    expect(((await res.json()) as { data: Linha }).data.ordem).toBe(ordemDaRenumeracao(1));
    // A pessoal e a de B não foram tocadas.
    expect(linhaDe(falso, "message_templates", TPL_PESSOAL)?.ordem).toBe(1000);
    expect(linhaDe(falso, "message_templates", TPL_B)?.ordem).toBe(1000);

    const escritas = cadeiasDeEscrita(falso.cadeias);
    expect(escritas.length).toBe(3);
    for (const c of escritas) {
      expect(c.filtros).toContainEqual(["organization_id", ORG_A]);
      expect(c.filtros).toContainEqual(["owner_user_id", null]);
      expect(c.filtros).not.toContainEqual(["id", TPL_PESSOAL]);
    }
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });
});

/**
 * A leitura do token já filtra `owner_user_id` nulo, e os blocos acima provam a
 * recusa da pessoal por ela. A ESCRITA repete o filtro: se a resposta virar
 * pessoal entre a leitura e o update, o update não a alcança. Sem estes casos,
 * tirar o filtro da escrita passava verde (sabotado em 20/11, triagem do #4395).
 */
describe("modelos de mensagem: a escrita do token também filtra owner_user_id nulo", () => {
  const casos: Array<[string, () => Promise<Response>]> = [
    ["PATCH /message-templates/[id]", () =>
      rotaModelo.PATCH(reqDe("PATCH", `/api/v1/message-templates/${TPL_A}`, TOKEN_A, { title: "Outro" }), comId(TPL_A))],
    ["POST /message-templates/[id]/midias", () =>
      rotaMidias.POST(reqMidia(`/api/v1/message-templates/${TPL_A}/midias`, TOKEN_A), comId(TPL_A))],
    ["PUT /message-templates/[id]/ordem", () =>
      rotaOrdem.PUT(reqDe("PUT", `/api/v1/message-templates/${TPL_A3}/ordem`, TOKEN_A, { depois_de: null }), comId(TPL_A3))],
  ];
  it.each(casos)("%s", async (_nome, chamar) => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await chamar();
    expect(res.status).toBe(200);
    const escritas = cadeiasDeEscrita(falso.cadeias).filter((c) => c.tabela === "message_templates");
    expect(escritas.length).toBeGreaterThan(0);
    for (const c of escritas) expect(c.filtros).toContainEqual(["owner_user_id", null]);
  });
});

describe("POST /message-templates com token", () => {
  it("shared: false é recusado (422): token não tem pessoa para ser dono", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaModelos.POST(
      reqDe("POST", "/api/v1/message-templates", TOKEN_A, { title: "Pessoal", body: "x", shared: false }),
    );
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("shared omitido também é recusado (o padrão do schema é false), sem inserir", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaModelos.POST(reqDe("POST", "/api/v1/message-templates", TOKEN_A, { title: "Sem dono", body: "x" }));
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });

  it("grupo de outra organização → 422, sem inserir", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaModelos.POST(
      reqDe("POST", "/api/v1/message-templates", TOKEN_A, { title: "Com grupo", body: "x", shared: true, grupo_id: GRP_B }),
    );
    expect(res.status).toBe(422);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });

  it("grupo da própria organização vale (201)", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaModelos.POST(
      reqDe("POST", "/api/v1/message-templates", TOKEN_A, { title: "Com grupo", body: "x", shared: true, grupo_id: GRP_A }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: Linha }).data.grupo_id).toBe(GRP_A);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("organization_id no corpo não escolhe a organização: o token de A cria em A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaModelos.POST(
      reqDe("POST", "/api/v1/message-templates", TOKEN_A, {
        title: "Forjada",
        body: "x",
        shared: true,
        organization_id: ORG_B,
        owner_user_id: USER_DONO,
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Linha };
    expect(data.organization_id).toBe(ORG_A);
    expect(data.owner_user_id).toBeNull();
  });

  it("respeita requireSupportWrite (suporte bloqueia antes de qualquer coisa)", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 423 }) as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaModelos.POST(
      reqDe("POST", "/api/v1/message-templates", TOKEN_A, { title: "x", body: "x", shared: true }),
    );
    expect(res.status).toBe(423);
    expect(falso.cadeias).toEqual([]);
  });
});

describe("attendants com token: o módulo decide antes do token", () => {
  it("módulo de setores desligado → 404 também para o token, sem tocar nas tabelas", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSetores.GET(reqDe("GET", "/api/v1/attendants/sectors", TOKEN_A));
    expect(res.status).toBe(404);
    expect(falso.cadeias).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sessão que PASSA o portão: o caminho antigo segue como era
// ---------------------------------------------------------------------------

function sessaoOk(role: Role, userId: string): void {
  vi.mocked(requireRole).mockReset();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: userId, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org A", role },
  } as never);
  vi.mocked(createClient).mockReset();
  vi.mocked(createClient).mockResolvedValue(falso.cliente as never);
}

describe("sessão que passa o portão", () => {
  it("POST /message-templates: agent cria a PESSOAL (owner = a pessoa), pelo cliente de sessão", async () => {
    sessaoOk("agent", USER_DONO);
    const res = await rotaModelos.POST(
      reqDe("POST", "/api/v1/message-templates", undefined, { title: "Minha", body: "x", shared: false }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Linha };
    expect(data).toMatchObject({ organization_id: ORG_A, owner_user_id: USER_DONO, created_by_user_id: USER_DONO });
    expect(createClient).toHaveBeenCalled();
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.created", actorUserId: USER_DONO, actorApiTokenId: null }),
    );
  });

  it("POST /message-templates: agent não cria compartilhado (403), como sempre", async () => {
    sessaoOk("agent", USER_DONO);
    const res = await rotaModelos.POST(
      reqDe("POST", "/api/v1/message-templates", undefined, { title: "Geral", body: "x", shared: true }),
    );
    expect(res.status).toBe(403);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
  });

  it("POST /message-templates: manager cria compartilhado", async () => {
    sessaoOk("manager", GERENTE);
    const res = await rotaModelos.POST(
      reqDe("POST", "/api/v1/message-templates", undefined, { title: "Geral", body: "x", shared: true }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Linha };
    expect(data).toMatchObject({ owner_user_id: null, created_by_user_id: GERENTE });
  });

  it("POST /message-templates/[id]/midias: agent não mexe no compartilhado (403), antes de subir o arquivo", async () => {
    sessaoOk("agent", USER_DONO);
    const res = await rotaMidias.POST(reqMidia(`/api/v1/message-templates/${TPL_A}/midias`), comId(TPL_A));
    expect(res.status).toBe(403);
    expect(falso.uploads).toEqual([]);
  });

  it("PUT /message-templates/[id]/ordem: manager reordena a lista visível pelo cliente de sessão", async () => {
    sessaoOk("manager", GERENTE);
    const res = await rotaOrdem.PUT(
      reqDe("PUT", `/api/v1/message-templates/${TPL_A3}/ordem`, undefined, { depois_de: TPL_A }),
      comId(TPL_A3),
    );
    expect(res.status).toBe(200);
    expect(createClient).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.reordered", actorUserId: GERENTE, actorApiTokenId: null }),
    );
  });

  it("PATCH /message-templates/[id]: o ator do audit é a pessoa da sessão", async () => {
    sessaoOk("manager", GERENTE);
    const res = await rotaModelo.PATCH(
      reqDe("PATCH", `/api/v1/message-templates/${TPL_A}`, undefined, { title: "Pela tela" }),
      comId(TPL_A),
    );
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.updated", actorUserId: GERENTE, actorApiTokenId: null }),
    );
  });

  it("PUT /attendants/sector/[user_id]: o ator do audit é a pessoa da sessão", async () => {
    sessaoOk("manager", GERENTE);
    const res = await rotaSetorDoAtendente.PUT(
      reqDe("PUT", `/api/v1/attendants/sector/${ANA_A}`, undefined, { sector_ids: [SETOR_A2] }),
      comUserId(ANA_A),
    );
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "attendant.sector_assigned", actorUserId: GERENTE }),
    );
  });

  it("GET /attendants/sectors: viewer lê pelo cliente de sessão", async () => {
    sessaoOk("viewer", GERENTE);
    const res = await rotaSetores.GET(reqDe("GET", "/api/v1/attendants/sectors"));
    expect(res.status).toBe(200);
    expect(createClient).toHaveBeenCalled();
    const texto = await res.text();
    expect(texto).toContain(MARCA_A);
    expect(texto).not.toContain(MARCA_B);
  });
});

// ---------------------------------------------------------------------------
// Bloco de borda: PUBLIC_PATHS
// ---------------------------------------------------------------------------

describe("PUBLIC_PATHS: borda do proxy para as portas do lote 2", () => {
  const UUID = "11111111-1111-4111-8111-111111111111";

  it.each([
    "/api/v1/attendants/sectors",
    "/api/v1/message-templates",
    `/api/v1/message-templates/${UUID}`,
    `/api/v1/message-templates/${UUID}/midias`,
    `/api/v1/message-templates/${UUID}/ordem`,
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    // Só escrevem, e a escrita da área de equipe pelo token espera o ok do mantenedor.
    `/api/v1/attendants/sector/${UUID}`,
    `/api/v1/attendants/sectors/${UUID}`,
    "/api/v1/attendants/sector",
    "/api/v1/attendants/sector/abc",
    `/api/v1/attendants/sector/${UUID}/x`,
    "/api/v1/attendants/sectors/abc",
    `/api/v1/attendants/sectors/${UUID}/x`,
    "/api/v1/attendants/sectors/x",
    "/api/v1/attendants/presence",
    "/api/v1/message-templates/abc/midias",
    "/api/v1/message-templates/abc/ordem",
    `/api/v1/message-templates/${UUID}/midias/x`,
    `/api/v1/message-templates/${UUID}/ordem/x`,
    `/api/v1/message-templates/${UUID}/outra`,
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
