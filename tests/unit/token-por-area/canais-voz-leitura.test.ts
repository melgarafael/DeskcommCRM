// @vitest-environment node
/**
 * TOKEN DE INTEGRAÇÃO POR ÁREA — CHANNEL-SESSIONS (leitura) e VOICE (leitura)
 * (Spec 33, fatia R3, tarefa 3, e follow-up).
 *
 * No ramo do token, `resolveAuthDual` entrega `createAdminClient()`: a service
 * role, que contorna a RLS. O que protege a organização é o filtro
 * `.eq("organization_id", authz.organizationId)` que cada rota escreve à mão.
 *
 * Nenhuma destas rotas escreve (só GET) ⇒ sem audit.
 *
 * Seis testes por caso (receita R3, passo 2):
 *   1. token de A alcança o recurso de A (2xx, nada fora de ORG_A);
 *   2. token de B não alcança o recurso de A (404 num recurso único, 200 com
 *      lista/estado vazio numa coleção ou estado; nada de A);
 *   3. token sem o escopo é recusado (403);
 *   4. token abaixo do papel é recusado (403). Papel `viewer` não tem degrau
 *      abaixo: nesse caso o teste é omitido;
 *   5. acima do teto do token → 429 com Retry-After, sem tocar o banco;
 *   6. sessão continua com o mesmo portão.
 *
 * Bloco de borda: cada porta nova dá `true` com UUID e `false` com `abc`, com
 * sub-path `/x` e com cada irmão literal do mesmo nível que não ganhou porta.
 *
 * Linhas: `channel_sessions` (ORG_A e ORG_B) — coluna `organization_id` existe
 * (baseline). `voice_calls` e `importacoes_de_historico` também têm
 * `organization_id`. `organizations` NÃO entra em SEM_ORGANIZACAO: o falso a
 * trata pela coluna `id`.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { MODELOS_DE_PORTA, caminhoDoModelo } from "@/lib/auth/portas-de-token";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
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
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
  orgAtivaDaApi: vi.fn(),
}));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: vi.fn() };
});
// A lista de grupos fala com o transporte (WAHA), que não existe neste teste. O
// dublê responde por organização: ORG_A tem um grupo, as outras não têm nenhum.
// O filtro de organização de verdade mora em `criarDepsDeGrupos`, fora deste
// arquivo; aqui se prova que a rota passa para a leitura a organização do token.
vi.mock("@/lib/grupos/servico", async () => {
  const actual = await vi.importActual<typeof import("@/lib/grupos/servico")>("@/lib/grupos/servico");
  return {
    ...actual,
    listarGruposDoNumero: vi.fn(async (_deps: unknown, e: { organizationId: string }) =>
      e.organizationId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        ? [{ group_chat_id: "111-222@g.us", subject: "Grupo-de-A" }]
        : [],
    ),
  };
});

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const USUARIO = "11111111-1111-4111-8111-111111111111";
const CANAL_A = "c1000000-0000-4000-8000-0000000000a1";
const CANAL_B = "c2000000-0000-4000-8000-0000000000b1";
const UUID_DE_EXEMPLO = "00000000-0000-4000-8000-000000000000";
const SESSAO_NO_TOKEN = "cliente de sessão usado no ramo do token";

/** Subrotas de `channel-sessions/[id]` que ganharam porta de token na leitura. */
const SUBROTAS_COM_PORTA = ["acervo", "ai-access", "disabled", "groups", "historico"] as const;

type Papel = "viewer" | "agent" | "manager" | "admin";
type Escopo = "mcp:read" | "mcp:write";
type Tabelas = Record<string, Record<string, unknown>[]>;
type Falso = ReturnType<typeof criarClienteAdminFalso>;
type Linha = Record<string, unknown>;

type Receita = "A" | "B";

// Receita A: sessão por requireRole. Receita B: sessão por loadAuthUser +
// orgAtivaDaApi + createClient.
type Caso = {
  rota: string;
  metodo: "GET";
  caminho: string;
  executar: (req: NextRequest) => Promise<Response>;
  linhas: Tabelas;
  receita: Receita;
  /** Papel que a rota passa a `resolveAuthDual` (ver a rota). */
  papel: Papel;
  escopo: Escopo;
  recurso: string;
  soDeA: string[];
  soDeB: string[];
  /** coleção → 200 vazio; recurso único → 404 */
  colecao: boolean;
};

// ───────────────────────────── cenário ─────────────────────────────

const CANAIS: Tabelas = {
  channel_sessions: [
    {
      id: CANAL_A,
      organization_id: ORG_A,
      provider: "waha",
      display_name: "Canal-de-A",
      metadata: {
        disabled: true,
        guardar_historico: true,
        ai_gate: "allowlist",
        ai_gate_mode: "pre_go_live",
        ai_test_phone_numbers: ["+5511999990001"],
      },
    },
    {
      id: CANAL_B,
      organization_id: ORG_B,
      provider: "waha",
      display_name: "Canal-de-B",
      metadata: {
        disabled: false,
        guardar_historico: false,
        ai_gate: "allowlist",
        ai_gate_mode: "pre_go_live",
        ai_test_phone_numbers: ["+5511999990002"],
      },
    },
  ],
  organizations: [
    { id: ORG_A, name: "Org A" },
    { id: ORG_B, name: "Org B" },
  ],
};

const IMPORTACOES: Tabelas = {
  importacoes_de_historico: [
    {
      id: "imp-de-a",
      organization_id: ORG_A,
      channel_session_id: CANAL_A,
      origem: "manual",
      status: "previa",
      created_at: "2026-10-01T12:00:00.000Z",
    },
    {
      id: "imp-de-b",
      organization_id: ORG_B,
      channel_session_id: CANAL_B,
      origem: "manual",
      status: "previa",
      created_at: "2026-10-01T12:00:00.000Z",
    },
  ],
};

const CHAMADAS: Tabelas = {
  voice_calls: [
    {
      id: "ch-a",
      organization_id: ORG_A,
      channel_session_id: CANAL_A,
      contact_id: null,
      wacalls_call_id: "call-a",
      direction: "outbound",
      peer_phone: "+5511000000001",
      status: "ended",
      end_reason: null,
      started_at: "2026-10-01T12:00:00.000Z",
      created_by: USUARIO,
    },
    {
      id: "ch-b",
      organization_id: ORG_B,
      channel_session_id: CANAL_B,
      contact_id: null,
      wacalls_call_id: "call-b",
      direction: "outbound",
      peer_phone: "+5511000000002",
      status: "ended",
      end_reason: null,
      started_at: "2026-10-01T12:00:00.000Z",
      created_by: USUARIO,
    },
  ],
};

function donoDa(tabela: string, linha: Linha): unknown {
  return tabela === "organizations" ? linha.id : linha.organization_id;
}

function semLinhasDe(org: string, linhas: Tabelas): Tabelas {
  return Object.fromEntries(
    Object.entries(linhas).map(([tabela, lista]) => [
      tabela,
      lista.filter((l) => donoDa(tabela, l) !== org),
    ]),
  );
}

// ───────────────────────────── casos ─────────────────────────────

const CASOS: Caso[] = [
  {
    // Receita B (sessão: loadAuthUser + orgAtivaDaApi + createClient)
    rota: "app/api/v1/channel-sessions/[id]/route.ts",
    metodo: "GET",
    caminho: `/api/v1/channel-sessions/${CANAL_A}`,
    executar: async (req) =>
      (await import("@/app/api/v1/channel-sessions/[id]/route")).GET(req, {
        params: Promise.resolve({ id: CANAL_A }),
      }),
    linhas: CANAIS,
    receita: "B",
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "channel_sessions",
    soDeA: ["Canal-de-A"],
    soDeB: ["Canal-de-B"],
    colecao: false,
  },
  {
    // Receita B
    rota: "app/api/v1/channel-sessions/route.ts",
    metodo: "GET",
    caminho: "/api/v1/channel-sessions",
    executar: async (req) =>
      (await import("@/app/api/v1/channel-sessions/route")).GET(req),
    linhas: CANAIS,
    receita: "B",
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "channel_sessions",
    soDeA: ["Canal-de-A"],
    soDeB: ["Canal-de-B"],
    colecao: true,
  },
  {
    // Receita A (sessão: requireRole)
    rota: "app/api/v1/voice/calls/history/route.ts",
    metodo: "GET",
    caminho: "/api/v1/voice/calls/history",
    executar: async (req) =>
      (await import("@/app/api/v1/voice/calls/history/route")).GET(req),
    linhas: CHAMADAS,
    receita: "A",
    papel: "agent",
    escopo: "mcp:read",
    recurso: "voice_calls",
    soDeA: ["call-a"],
    soDeB: ["call-b"],
    colecao: true,
  },
  {
    // Receita A
    rota: "app/api/v1/voice/opt-in/route.ts",
    metodo: "GET",
    caminho: "/api/v1/voice/opt-in",
    executar: async (req) =>
      (await import("@/app/api/v1/voice/opt-in/route")).GET(req),
    linhas: {},
    receita: "A",
    papel: "manager",
    escopo: "mcp:read",
    recurso: "org_voice_calls",
    soDeA: [],
    soDeB: [],
    colecao: true,
  },
  {
    // Receita B
    rota: "app/api/v1/voice/sessions/status/route.ts",
    metodo: "GET",
    caminho: "/api/v1/voice/sessions/status",
    executar: async (req) =>
      (await import("@/app/api/v1/voice/sessions/status/route")).GET(req),
    linhas: CANAIS,
    receita: "B",
    papel: "viewer",
    escopo: "mcp:read",
    recurso: "channel_sessions",
    soDeA: [],
    soDeB: [],
    colecao: true,
  },
  {
    // Receita A
    rota: "app/api/v1/channel-sessions/[id]/acervo/route.ts",
    metodo: "GET",
    caminho: `/api/v1/channel-sessions/${CANAL_A}/acervo`,
    executar: async (req) =>
      (await import("@/app/api/v1/channel-sessions/[id]/acervo/route")).GET(req, {
        params: Promise.resolve({ id: CANAL_A }),
      }),
    linhas: CANAIS,
    receita: "A",
    papel: "admin",
    escopo: "mcp:read",
    recurso: "channel_sessions",
    soDeA: [],
    soDeB: [],
    colecao: false,
  },
  {
    // Receita A
    rota: "app/api/v1/channel-sessions/[id]/ai-access/route.ts",
    metodo: "GET",
    caminho: `/api/v1/channel-sessions/${CANAL_A}/ai-access`,
    executar: async (req) =>
      (await import("@/app/api/v1/channel-sessions/[id]/ai-access/route")).GET(req, {
        params: Promise.resolve({ id: CANAL_A }),
      }),
    linhas: CANAIS,
    receita: "A",
    papel: "admin",
    escopo: "mcp:read",
    recurso: "channel_sessions",
    soDeA: ["+5511999990001"],
    soDeB: ["+5511999990002"],
    colecao: false,
  },
  {
    // Receita A
    rota: "app/api/v1/channel-sessions/[id]/disabled/route.ts",
    metodo: "GET",
    caminho: `/api/v1/channel-sessions/${CANAL_A}/disabled`,
    executar: async (req) =>
      (await import("@/app/api/v1/channel-sessions/[id]/disabled/route")).GET(req, {
        params: Promise.resolve({ id: CANAL_A }),
      }),
    linhas: CANAIS,
    receita: "A",
    papel: "admin",
    escopo: "mcp:read",
    recurso: "channel_sessions",
    soDeA: [],
    soDeB: [],
    colecao: false,
  },
  {
    // Receita A (o dublê de `listarGruposDoNumero` responde por organização)
    rota: "app/api/v1/channel-sessions/[id]/groups/route.ts",
    metodo: "GET",
    caminho: `/api/v1/channel-sessions/${CANAL_A}/groups`,
    executar: async (req) =>
      (await import("@/app/api/v1/channel-sessions/[id]/groups/route")).GET(req, {
        params: Promise.resolve({ id: CANAL_A }),
      }),
    linhas: CANAIS,
    receita: "A",
    papel: "manager",
    escopo: "mcp:read",
    recurso: "channel_session_groups",
    soDeA: ["Grupo-de-A"],
    soDeB: [],
    colecao: true,
  },
  {
    // Receita A
    rota: "app/api/v1/channel-sessions/[id]/historico/route.ts",
    metodo: "GET",
    caminho: `/api/v1/channel-sessions/${CANAL_A}/historico`,
    executar: async (req) =>
      (await import("@/app/api/v1/channel-sessions/[id]/historico/route")).GET(req, {
        params: Promise.resolve({ id: CANAL_A }),
      }),
    linhas: { ...CANAIS, ...IMPORTACOES },
    receita: "A",
    papel: "admin",
    escopo: "mcp:read",
    recurso: "importacoes_de_historico",
    soDeA: ["imp-de-a"],
    soDeB: ["imp-de-b"],
    colecao: false,
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
    if (!quem) throw new McpAuthError(-32001, 401, "Invalid token.");
    return {
      organizationId: quem.org,
      role: opcoes.role,
      actor: { type: "api_token", id: quem.id, role: opcoes.role },
      apiTokenId: quem.id,
      scopes: opcoes.scopes,
    };
  });
}

function requisicao(c: Caso, headers: Record<string, string>): NextRequest {
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = { method: c.metodo, headers };
  return new NextRequest(`http://localhost${c.caminho}`, init);
}

function ler(res: Response): Promise<{ texto: string; data: unknown }> {
  const texto = res.text();
  const json = texto.then((t) => (t ? JSON.parse(t) : {}));
  return Promise.all([texto, json]).then(([texto, data]) => ({
    texto,
    data: data.data ?? null,
  }));
}

function comToken(qual: "A" | "B"): Record<string, string> {
  return { authorization: `Bearer ${qual === "A" ? TOKEN_A : TOKEN_B}` };
}

function nadaTocado(f: Falso): void {
  expect(f.cadeias).toEqual([]);
  expect(f.rpcs).toEqual([]);
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
  vi.mocked(validateBearerToken).mockReset();
});

function sessaoPortaoOk(c: Caso): void {
  const f = falsoDe(ORG_A, c.linhas, c);
  // A sessão usa `createClient` (receita B e algumas da A) ou `createAdminClient`
  // (receita A nas rotas de admin): o mesmo dublê de ORG_A serve aos dois.
  vi.mocked(createClient).mockResolvedValue(f.cliente as never);
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
  const papelDoToken = c.papel;
  const abaixo = umDegrauAbaixo(papelDoToken);

  describe(`token por área — ${rotulo}`, () => {
    it(`${rotulo}: token de A alcança o recurso de A`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("A")));
      const { texto, data } = await ler(res);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      for (const marca of c.soDeA) expect(texto).toContain(marca);
      for (const marca of c.soDeB) expect(texto).not.toContain(marca);

      expect(cadeiasForaDaOrganizacao(f.cadeias, ORG_A)).toEqual([]);
      expect(rpcsForaDaOrganizacao(f.rpcs, ORG_A)).toEqual([]);
      expect(arquivosForaDaOrganizacao(f.uploads, ORG_A)).toEqual([]);
      expect(validateBearerToken).toHaveBeenCalled();
    });

    it(`${rotulo}: token de B não alcança o recurso de A`, async () => {
      const f = falsoDe(ORG_B, semLinhasDe(ORG_A, c.linhas), c);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("B")));
      const { texto } = await ler(res);

      if (c.colecao) {
        // coleção: 200 com lista/estado vazio
        expect(res.status).toBe(200);
      } else {
        // recurso único: 404
        expect(res.status).toBe(404);
      }
      for (const marca of c.soDeA) expect(texto).not.toContain(marca);
      // Lista vazia ou 404 vêm de LEITURAS DA PRÓPRIA organização de B: a rota
      // consulta com `organization_id` = B (o dublê não tem linha de A). A prova
      // é que toda consulta é de B, que nada é escrito e que nenhuma chamada
      // de função leva outra organização.
      expect(cadeiasForaDaOrganizacao(f.cadeias, ORG_B)).toEqual([]);
      expect(f.cadeias.filter((c) => c.operacao !== "select")).toEqual([]);
      expect(rpcsForaDaOrganizacao(f.rpcs, ORG_B)).toEqual([]);
      expect(f.uploads).toEqual([]);
    });

    it(`${rotulo}: token sem o escopo da operação é recusado`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      const outro: Escopo = c.escopo === "mcp:read" ? "mcp:write" : "mcp:read";
      emitirTokens({ scopes: [outro], role: papelDoToken });

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(403);
      nadaTocado(f);
    });

    // Papel `viewer` não tem degrau abaixo: não há caso "abaixo do papel" para ele.
    if (abaixo) {
      it(`${rotulo}: token abaixo do papel é recusado`, async () => {
        const f = falsoDe(ORG_A, c.linhas, c);
        vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
        emitirTokens({ scopes: [c.escopo], role: abaixo });

        const res = await c.executar(requisicao(c, comToken("A")));

        expect(res.status).toBe(403);
        nadaTocado(f);
      });
    }

    it(`${rotulo}: acima do teto do token → 429`, async () => {
      const f = falsoDe(ORG_A, c.linhas, c);
      vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
      emitirTokens({ scopes: [c.escopo], role: papelDoToken });
      vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

      const res = await c.executar(requisicao(c, comToken("A")));

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      nadaTocado(f);
    });

    it(`${rotulo}: sessão continua com o mesmo portão`, async () => {
      sessaoPortaoOk(c);

      const res = await c.executar(requisicao(c, {}));
      const { texto } = await ler(res);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
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

// ───────────────────────────── métodos que ficam de fora (sessão) ─────────────────────────────

describe("DELETE /api/v1/channel-sessions/[id] com token → 401 (fica só de sessão)", () => {
  it("Bearer sem cookie: o requireRole recusa e nada é consultado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
    emitirTokens({ scopes: ["mcp:write"], role: "admin" });

    const { DELETE } = await import("@/app/api/v1/channel-sessions/[id]/route");
    const res = await DELETE(
      new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL_A}`, {
        method: "DELETE",
        headers: comToken("A"),
      }),
      { params: Promise.resolve({ id: CANAL_A }) },
    );

    expect(res.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── GET de [id] com token só lê ─────────────────────────────

describe("GET /api/v1/channel-sessions/[id] com token só lê a linha", () => {
  it("token de A devolve a sessão e não grava nada em channel_sessions", async () => {
    const f = criarClienteAdminFalso({
      orgDona: ORG_A,
      linhas: CANAIS,
      tabelasSemOrganizacao: SEM_ORGANIZACAO,
    });
    vi.mocked(createAdminClient).mockReturnValue(f.cliente as never);
    emitirTokens({ scopes: ["mcp:read"], role: "viewer" });

    const { GET } = await import("@/app/api/v1/channel-sessions/[id]/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL_A}`, {
        headers: comToken("A"),
      }),
      { params: Promise.resolve({ id: CANAL_A }) },
    );

    expect(res.status).toBe(200);
    expect(f.cadeias.filter((c) => c.operacao === "update")).toEqual([]);
    expect(f.cadeias.filter((c) => c.operacao === "insert")).toEqual([]);
    expect(f.linhas.channel_sessions).toEqual(CANAIS.channel_sessions);
  });
});

// ───────────────────────────── borda do proxy ─────────────────────────────

describe("PUBLIC_PATHS — as portas de channel-sessions e voice (borda do proxy)", () => {
  const PORTAS = [
    "/api/v1/channel-sessions",
    `/api/v1/channel-sessions/${UUID_DE_EXEMPLO}`,
    ...SUBROTAS_COM_PORTA.map((s) => `/api/v1/channel-sessions/${UUID_DE_EXEMPLO}/${s}`),
    "/api/v1/voice/calls/history",
    "/api/v1/voice/opt-in",
    "/api/v1/voice/sessions/status",
  ];

  it.each(PORTAS)("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    ...PORTAS.map((p) => `${p}/x`),
    "/api/v1/channel-sessions/abc",
    ...SUBROTAS_COM_PORTA.map((s) => `/api/v1/channel-sessions/abc/${s}`),
    "/api/v1/channel-sessions/disabled",
    "/api/v1/channel-sessions/pairing-code",
    "/api/v1/channel-sessions/qr",
    "/api/v1/voice/calls",
    "/api/v1/voice/events",
    "/api/v1/voice/opt-in/x",
    "/api/v1/voice/sessions/pair",
    "/api/v1/voice",
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });

  it("todas as portas estão nos modelos de leitura", () => {
    const caminhos = MODELOS_DE_PORTA.map(caminhoDoModelo);
    // O modelo é o caminho com `[id]` no lugar do UUID.
    for (const caminho of PORTAS) expect(caminhos).toContain(caminho.replace(UUID_DE_EXEMPLO, "[id]"));
  });
});

// ───────────────────────────── dublês de caso ─────────────────────────────

function falsoDe(org: string, linhas: Tabelas, _c: Caso): Falso {
  return criarClienteAdminFalso({
    orgDona: org,
    linhas,
    tabelasSemOrganizacao: SEM_ORGANIZACAO,
  });
}

/** Tabelas sem a coluna `organization_id` (conferidas no baseline.sql): nenhuma. */
const SEM_ORGANIZACAO = [] as const;
