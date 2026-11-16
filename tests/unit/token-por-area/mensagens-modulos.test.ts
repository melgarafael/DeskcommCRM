// @vitest-environment node
/**
 * TOKEN DE INTEGRAÇÃO POR ÁREA — MESSAGES E MODULOS (Spec 33, fatia R3, tarefa 4).
 *
 * No ramo do token, `resolveAuthDual` entrega `createAdminClient()`: a service role, que contorna a
 * RLS. O que protege a organização é o filtro `.eq("organization_id", authz.organizationId)` que cada
 * rota escreve à mão. O cliente falso (tests/unit/helpers/cliente-admin-falso.ts) registra cada
 * consulta e aponta a que foge da organização.
 *
 * Seis testes por caso (receita R3, passo 2), com o status de sucesso de cada caso:
 *   1. token de A alcança o recurso de A (`sucesso`: 200, ou 302 na mídia, que redireciona);
 *   2. token de B não alcança o recurso de A (404 num recurso único; 200 com a PRÓPRIA lista numa
 *      coleção, sem nada de A);
 *   3. token sem o escopo da operação é recusado (403);
 *   4. token abaixo do papel é recusado (403). Papel `viewer` não tem degrau abaixo: sem o teste;
 *   5. acima do teto do token → 429 com Retry-After, sem tocar o banco;
 *   6. sessão continua com o mesmo portão.
 *
 * Bloco de borda: cada porta dá `true` com o caminho certo e `false` com id fora da forma de UUID,
 * com sub-path e com cada irmão literal que não ganhou porta.
 *
 * `extension_installations` e `extension_artifacts` NÃO têm `organization_id` (conferido no
 * baseline.sql): entram em SEM_ORGANIZACAO, e os verificadores recebem essa lista.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { MODELOS_DE_PORTA, caminhoDoModelo } from "@/lib/auth/portas-de-token";
import { isPublicPath } from "@/lib/auth/public-paths";
import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  arquivosForaDaOrganizacao,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "../helpers/cliente-admin-falso";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn(), orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/messaging/media/voice-transcode", () => ({
  ConversorOcupado: class extends Error {},
  TETO_REPRODUCAO_BYTES: 1024,
  paraReproducaoAac: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USUARIO = "11111111-1111-4111-8111-111111111111";
// UUID v4 de verdade: o Zod da rota de hide recusa o que não tem a forma (422).
const MSG_A = "10000000-0000-4000-8000-0000000000a1";
const MSG_B = "20000000-0000-4000-8000-0000000000b1";
const UUID_DE_EXEMPLO = "00000000-0000-4000-8000-000000000000";
const SESSAO_NO_TOKEN = "cliente de sessão usado no ramo do token";
const TABELA_DA_FICHA = "m_editora_clinica_ficha";
const SEM_ORGANIZACAO = ["extension_installations", "extension_artifacts"] as const;
const OPCOES_DO_FALSO = { tabelasSemOrganizacao: SEM_ORGANIZACAO };

type Papel = "viewer" | "agent" | "manager" | "admin";
type Escopo = "mcp:read" | "mcp:write";
type Tabelas = Record<string, Record<string, unknown>[]>;
type Falso = ReturnType<typeof criarClienteAdminFalso>;

/** A: a rota usa `requireRole` (sessão) e `resolveAuthDual`. B: usa `loadAuthUser` + `orgAtivaDaApi`. */
type Receita = "A" | "B";

type Caso = {
  rota: string;
  metodo: "GET" | "POST" | "DELETE";
  caminho: string;
  executar: (req: NextRequest) => Promise<Response>;
  linhas: Tabelas;
  receita: Receita;
  /** Papel que a rota passa a `resolveAuthDual` (ver a rota). */
  papel: Papel;
  escopo: Escopo;
  /** Status de sucesso do token de A e da sessão. */
  sucesso: number;
  /** Marcas que aparecem (soDeA) ou não aparecem (soDeB) no corpo ou no Location da resposta. */
  soDeA: string[];
  soDeB: string[];
  /** Coleção: o token de B recebe 200 com a própria lista. Recurso único: 404. */
  colecao: boolean;
  /** Se o método audita (hide POST/DELETE). */
  audita: boolean;
};

// ───────────────────────────── cenário ─────────────────────────────

const MENSAGENS: Tabelas = {
  messages: [
    {
      id: MSG_A,
      organization_id: ORG_A,
      conversation_id: "conv-a",
      channel_session_id: "canal-a",
      contact_id: "contato-a",
      direction: "inbound",
      type: "text",
      body: "Mensagem-de-A",
      media_url: null,
      media_mime: "application/pdf",
      media_size_bytes: 10,
      media_storage_path: `${ORG_A}/whatsapp/anexo-a.pdf`,
      metadata: {},
      revoked_at: null,
      sent_at: "2026-11-01T12:00:00.000Z",
      created_at: "2026-11-01T12:00:00.000Z",
    },
    {
      id: MSG_B,
      organization_id: ORG_B,
      conversation_id: "conv-b",
      channel_session_id: "canal-b",
      contact_id: "contato-b",
      direction: "inbound",
      type: "text",
      body: "Mensagem-de-B",
      media_url: null,
      media_mime: "application/pdf",
      media_size_bytes: 10,
      media_storage_path: `${ORG_B}/whatsapp/anexo-b.pdf`,
      metadata: {},
      revoked_at: null,
      sent_at: "2026-11-01T12:00:00.000Z",
      created_at: "2026-11-01T12:00:00.000Z",
    },
  ],
  conversations: [
    { id: "conv-a", organization_id: ORG_A },
    { id: "conv-b", organization_id: ORG_B },
  ],
};

/** Um módulo instalado (`clinica`/`ficha`), com uma ficha de cada organização. */
const MANIFESTO_DA_FICHA = {
  profile: "data",
  data: {
    mode: "declarado",
    objetos: [
      {
        slug: "ficha",
        rotulo: { pt: "Ficha" },
        campos: [{ slug: "titulo", tipo: "texto" }],
        refs: [],
      },
    ],
  },
};

const MODULO_CLINICA: Tabelas = {
  extension_installations: [
    {
      id: "inst-clinica",
      catalog_id: "cat-clinica",
      artifact_id: "art-clinica",
      publisher: "editora",
      name: "clinica",
      version: "1.0.0",
      installed_by: USUARIO,
      installed_at: "2026-10-01T12:00:00.000Z",
    },
  ],
  extension_artifacts: [
    {
      id: "art-clinica",
      sha256: "a".repeat(64),
      byte_length: 100,
      manifest: MANIFESTO_DA_FICHA,
      document: "x",
      created_at: "2026-10-01T12:00:00.000Z",
    },
  ],
  [TABELA_DA_FICHA]: [
    { id: "ficha-a", organization_id: ORG_A, titulo: "Ficha-de-A", created_at: "2026-11-01T12:00:00.000Z" },
    { id: "ficha-b", organization_id: ORG_B, titulo: "Ficha-de-B", created_at: "2026-11-01T12:00:00.000Z" },
  ],
};

// ───────────────────────────── casos ─────────────────────────────

const CASOS: Caso[] = [
  {
    // Receita A — POST messages/[id]/hide (ocultar)
    rota: "app/api/v1/messages/[id]/hide/route.ts",
    metodo: "POST",
    caminho: `/api/v1/messages/${MSG_A}/hide`,
    executar: async (req) =>
      (await import("@/app/api/v1/messages/[id]/hide/route")).POST(req, {
        params: Promise.resolve({ id: MSG_A }),
      }),
    linhas: MENSAGENS,
    receita: "A",
    papel: "manager",
    escopo: "mcp:write",
    sucesso: 200,
    soDeA: [MSG_A],
    soDeB: [MSG_B],
    colecao: false,
    audita: true,
  },
  {
    // Receita A — DELETE messages/[id]/hide (restaurar)
    rota: "app/api/v1/messages/[id]/hide/route.ts",
    metodo: "DELETE",
    caminho: `/api/v1/messages/${MSG_A}/hide`,
    executar: async (req) =>
      (await import("@/app/api/v1/messages/[id]/hide/route")).DELETE(req, {
        params: Promise.resolve({ id: MSG_A }),
      }),
    linhas: MENSAGENS,
    receita: "A",
    papel: "manager",
    escopo: "mcp:write",
    sucesso: 200,
    soDeA: [MSG_A],
    soDeB: [MSG_B],
    colecao: false,
    audita: true,
  },
  {
    // Receita B — GET messages/[id]/media (302 para a URL assinada; a mídia não tem corpo)
    rota: "app/api/v1/messages/[id]/media/route.ts",
    metodo: "GET",
    caminho: `/api/v1/messages/${MSG_A}/media`,
    executar: async (req) =>
      (await import("@/app/api/v1/messages/[id]/media/route")).GET(req, {
        params: Promise.resolve({ id: MSG_A }),
      }),
    linhas: MENSAGENS,
    receita: "B",
    papel: "viewer",
    escopo: "mcp:read",
    sucesso: 302,
    soDeA: [ORG_A],
    soDeB: [ORG_B],
    colecao: false,
    audita: false,
  },
  {
    // Receita A — GET modulos/[modulo]/[objeto] (coleção)
    rota: "app/api/v1/modulos/[modulo]/[objeto]/route.ts",
    metodo: "GET",
    caminho: "/api/v1/modulos/clinica/ficha",
    executar: async (req) =>
      (await import("@/app/api/v1/modulos/[modulo]/[objeto]/route")).GET(req, {
        params: Promise.resolve({ modulo: "clinica", objeto: "ficha" }),
      }),
    linhas: MODULO_CLINICA,
    receita: "A",
    papel: "viewer",
    escopo: "mcp:read",
    sucesso: 200,
    soDeA: ["Ficha-de-A"],
    soDeB: ["Ficha-de-B"],
    colecao: true,
    audita: false,
  },
];

// ───────────────────────────── ajudantes ─────────────────────────────

const ORDEM: readonly Papel[] = ["viewer", "agent", "manager", "admin"];

function umDegrauAbaixo(papel: Papel): Papel | null {
  const i = ORDEM.indexOf(papel);
  return i > 0 ? (ORDEM[i - 1] ?? null) : null;
}

function emitirTokens(opcoes: { scopes: string[]; role: Papel }): void {
  vi.mocked(validateBearerToken).mockImplementation(async (cabecalho) => {
    const quem =
      cabecalho?.includes(TOKEN_B)
        ? { org: ORG_B, id: TOKEN_B }
        : cabecalho?.includes(TOKEN_A)
          ? { org: ORG_A, id: TOKEN_A }
          : null;
    if (!quem) throw new Error("Invalid token.");
    return {
      organizationId: quem.org,
      role: opcoes.role,
      actor: { type: "api_token", id: quem.id, role: opcoes.role },
      apiTokenId: quem.id,
      scopes: opcoes.scopes,
    } as never;
  });
}

function requisicao(c: Caso, headers: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost${c.caminho}`, { method: c.metodo, headers });
}

/** Corpo da resposta mais o Location (a mídia redireciona e não tem corpo). */
async function ler(res: Response): Promise<string> {
  let corpo = "";
  try {
    corpo = await res.text();
  } catch {
    corpo = "";
  }
  return `${corpo}${res.headers.get("location") ?? ""}`;
}

function comToken(qual: "A" | "B"): Record<string, string> {
  return { authorization: `Bearer ${qual === "A" ? TOKEN_A : TOKEN_B}` };
}

function falsoDe(org: string, linhas: Tabelas): Falso {
  return criarClienteAdminFalso({ orgDona: org, linhas, tabelasSemOrganizacao: SEM_ORGANIZACAO });
}

function nadaTocado(f: Falso): void {
  expect(f.cadeias).toEqual([]);
  expect(f.rpcs).toEqual([]);
}

/**
 * Cliente de SESSÃO para o caso de sessão. Ele autentica o usuário, e lança se alguma rota tocar as
 * tabelas do módulo por ele: o acesso a `extension_*` é do cliente de admin, nunca da sessão.
 */
function clienteDeSessao(f: Falso): unknown {
  const base = f.cliente as { from: (tabela: string) => unknown };
  return {
    auth: { getUser: async () => ({ data: { user: { id: USUARIO } }, error: null }) },
    from: (tabela: string) => {
      if (tabela.startsWith("extension_")) throw new Error(`cliente de sessão tocou ${tabela}`);
      return base.from(tabela);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(loadAuthUser).mockImplementation(async () => {
    throw new Error(SESSAO_NO_TOKEN);
  });
  vi.mocked(createAdminClient).mockImplementation(() => {
    throw new Error("cliente admin sem cenário");
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("sessão consultada no ramo do token");
  });
  vi.mocked(orgAtivaDaApi).mockImplementation(async () => {
    throw new Error("orgAtivaDaApi consultada no ramo do token");
  });
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(audit).mockResolvedValue(undefined);
  vi.mocked(validateBearerToken).mockReset();
});

function sessaoPortaoOk(c: Caso): void {
  const f = falsoDe(ORG_A, c.linhas);
  vi.mocked(createClient).mockResolvedValue(clienteDeSessao(f) as never);
  vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
  if (c.receita === "A") {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USUARIO, idioma: "pt-BR" },
      org: { orgId: ORG_A, name: "Org", role: c.papel },
    } as never);
  } else {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: USUARIO,
      idioma: "pt-BR",
      email: "usuario@exemplo.test",
    } as never);
    vi.mocked(orgAtivaDaApi).mockResolvedValue({
      ok: true,
      org: { orgId: ORG_A, name: "Org", role: c.papel },
    } as never);
  }
}

// ───────────────────────────── os seis testes por caso ─────────────────────────────

for (const c of CASOS) {
  const rotulo = `${c.metodo} ${c.caminho.split("?")[0]}`;
  const abaixo = umDegrauAbaixo(c.papel);

  describe(`token por área — ${rotulo}`, () => {
    it(`${rotulo}: token de A alcança o recurso de A`, async () => {
      const f = falsoDe(ORG_A, c.linhas);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: c.papel });

      const res = await c.executar(requisicao(c, comToken("A")));
      const texto = await ler(res);

      expect(res.status).toBe(c.sucesso);
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of c.soDeB) expect(texto).not.toContain(marca);

      expect(cadeiasForaDaOrganizacao(f.cadeias, ORG_A, OPCOES_DO_FALSO)).toEqual([]);
      expect(rpcsForaDaOrganizacao(f.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(f.uploads, ORG_A)).toEqual([]);
      expect(validateBearerToken).toHaveBeenCalled();
      if (c.audita) {
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            actorUserId: null,
            actorApiTokenId: TOKEN_A,
          }),
        );
      }
    });

    it(`${rotulo}: token de B não alcança o recurso de A`, async () => {
      const f = falsoDe(ORG_B, c.linhas);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: c.papel });

      const res = await c.executar(requisicao(c, comToken("B")));
      const texto = await ler(res);

      expect(res.status).toBe(c.colecao ? 200 : 404);
      for (const marca of c.soDeA) expect(texto).not.toContain(marca);
      expect(cadeiasDeEscrita(f.cadeias)).toEqual([]);
      expect(cadeiasForaDaOrganizacao(f.cadeias, ORG_B, OPCOES_DO_FALSO)).toEqual([]);
      expect(rpcsForaDaOrganizacao(f.rpcs, ORG_B)).toEqual([]);
      expect(arquivosForaDaOrganizacao(f.uploads, ORG_B)).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    });

    it(`${rotulo}: token sem o escopo da operação é recusado`, async () => {
      const f = falsoDe(ORG_A, c.linhas);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      const outro: Escopo = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      emitirTokens({ scopes: [outro], role: c.papel });

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(403);
      nadaTocado(f);
    });

    // Papel `viewer` não tem degrau abaixo: não há caso "abaixo do papel" para ele.
    if (abaixo) {
      it(`${rotulo}: token abaixo do papel é recusado`, async () => {
        const f = falsoDe(ORG_A, c.linhas);
        vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
        emitirTokens({ scopes: [c.escopo], role: abaixo });

        const res = await c.executar(requisicao(c, comToken("A")));

        expect(res.status).toBe(403);
        nadaTocado(f);
      });
    }

    it(`${rotulo}: acima do teto do token → 429`, async () => {
      const f = falsoDe(ORG_A, c.linhas);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: c.papel });
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      nadaTocado(f);
    });

    it(`${rotulo}: sessão continua com o mesmo portão`, async () => {
      sessaoPortaoOk(c);

      const res = await c.executar(requisicao(c, {}));
      const texto = await ler(res);

      expect(res.status).toBe(c.sucesso);
      if (c.receita === "A") {
        expect(requireRole).toHaveBeenCalledWith(c.papel, expect.anything());
      } else {
        expect(loadAuthUser).toHaveBeenCalled();
        expect(orgAtivaDaApi).toHaveBeenCalled();
      }
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of c.soDeB) expect(texto).not.toContain(marca);
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
    });
  });
}

function cadeiasDeEscrita(cadeias: { operacao: string }[]): { operacao: string }[] {
  return cadeias.filter((c) => c.operacao !== "select");
}

// ───────────────────────────── métodos que ficam de fora (sessão) ─────────────────────────────

describe("PATCH /api/v1/messages/[id] com token → recusado pela sessão (fica só de sessão)", () => {
  it("Bearer sem cookie: o requireRole recusa, e nada é validado, consultado nem lido", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    emitirTokens({ scopes: ["mcp:write"], role: "agent" });

    const { PATCH } = await import("@/app/api/v1/messages/[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/messages/${MSG_A}`, {
        method: "PATCH",
        headers: comToken("A"),
      }),
      { params: Promise.resolve({ id: MSG_A }) },
    );

    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── borda do proxy ─────────────────────────────

describe("PUBLIC_PATHS — as portas de messages e modulos (borda do proxy)", () => {
  const PORTAS = [
    `/api/v1/messages/${UUID_DE_EXEMPLO}/hide`,
    `/api/v1/messages/${UUID_DE_EXEMPLO}/media`,
    "/api/v1/modulos/clinica/ficha",
  ];

  it.each(PORTAS)("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  /**
   * A pasta `modulos/instalar` é literal e tem só `route.ts` (POST). Sub-path dela não existe como
   * rota: `/api/v1/modulos/instalar/ficha` cai na rota `[modulo]/[objeto]` com `modulo = "instalar"`,
   * e a porta vale por isso. Quem decide é a rota, por `resolveAuthDual`; a porta não dá passe.
   */
  it("libera /api/v1/modulos/instalar/ficha: sem subrota literal, a rota [modulo]/[objeto] o atende", () => {
    expect(isPublicPath("/api/v1/modulos/instalar/ficha")).toBe(true);
  });

  it.each([
    ...PORTAS.map((p) => `${p}/x`),
    // pai e irmãos literais: nenhum deles ganhou porta
    `/api/v1/messages/${UUID_DE_EXEMPLO}`,
    `/api/v1/messages/${UUID_DE_EXEMPLO}/retry`,
    `/api/v1/messages/${UUID_DE_EXEMPLO}/forward`,
    `/api/v1/messages/abc/hide`,
    `/api/v1/messages/abc/media`,
    "/api/v1/modulos",
    "/api/v1/modulos/instalar",
    "/api/v1/modulos/clinica",
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });

  it("as três portas estão nos modelos de leitura", () => {
    const caminhos = MODELOS_DE_PORTA.map(caminhoDoModelo);
    expect(caminhos).toContain("/api/v1/messages/[id]/hide");
    expect(caminhos).toContain("/api/v1/messages/[id]/media");
    expect(caminhos).toContain("/api/v1/modulos/[modulo]/[objeto]");
  });
});
