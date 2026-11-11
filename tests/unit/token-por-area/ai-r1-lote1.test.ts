// @vitest-environment node
/**
 * Token de integração nas 7 rotas do lote 1 da fatia R1 (Spec 33):
 *
 *   GET  ai/guardrail-layers           config:read   manager (sessão)  admin (token)
 *   GET  ai/style-adjustments          config:read   manager           admin
 *   GET  ai/routing-results            config:read   manager           admin
 *   POST ai/skills/[name]/install      config:write  manager           admin
 *   POST ai/skills/[name]/restore      config:write  manager           admin
 *   PUT  ai/skills/[name]              config:write  manager           admin
 *   POST ai/skills/import              config:write  manager           admin
 *
 * Cada método tem a bateria da receita R:
 *  - token de A alcança o recurso de A (2xx), sem consulta fora de A, e a
 *    escrita sai com ator de token (`actorUserId` nulo, `actorApiTokenId` preenchido);
 *  - token de B não alcança o recurso de A (404, ou só o que é de B);
 *  - token sem o escopo é recusado (403);
 *  - token abaixo do papel (manager < admin do `tokenRole`) é recusado (403);
 *  - acima do teto do token → 429 com Retry-After, sem tocar no banco;
 *  - sessão (sem Authorization) continua pelo `requireRole` com o papel da tabela.
 *
 * O ramo do token usa o cliente admin falso, que acusa cadeia sem
 * `organization_id`. As duas tabelas de skill aceitam `organization_id` NULL
 * (catálogo de plataforma): a leitura do catálogo com `is null` (ou `org OR null`)
 * é intencional e fica fora da acusação; escrita sem filtro nunca.
 * As libs de skill rodam de verdade (`installPlatformSkill`, `importSkillPackage`,
 * `copiarArquivosDoPacote`); só o pool de Postgres e as duas funções SQL cruas
 * (`insertSkillVersion`, `setSkillPointer`) são dublês, para que o teste afirme
 * COM QUAL organização elas foram chamadas.
 */
import { zipSync, strToU8 } from "fflate";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { insertSkillVersion, setSkillPointer } from "@/lib/agent-engine/agent/skills";
import { chavePersistidaDoAjuste } from "@/lib/agent-engine/guardrails/ajustes-de-estilo-da-org";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { audit } from "@/lib/audit";
import { isPublicPath } from "@/lib/auth/public-paths";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import type { Role } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
  type CadeiaRegistrada,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaGuardrail from "@/app/api/v1/ai/guardrail-layers/route";
import * as rotaEstilo from "@/app/api/v1/ai/style-adjustments/route";
import * as rotaRoteamento from "@/app/api/v1/ai/routing-results/route";
import * as rotaInstall from "@/app/api/v1/ai/skills/[name]/install/route";
import * as rotaRestore from "@/app/api/v1/ai/skills/[name]/restore/route";
import * as rotaSkill from "@/app/api/v1/ai/skills/[name]/route";
import * as rotaImport from "@/app/api/v1/ai/skills/import/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/skills/db", () => ({ getSkillsPool: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-engine/agent/skills")>()),
  insertSkillVersion: vi.fn(),
  setSkillPointer: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";

const NOME_SKILL_A = "minha-skill";
const NOME_SKILL_B = "sua-skill";
const NOME_SKILL_GLOBAL = "objecao-preco";
const ID_VER_SKILL_A = "e1000000-0000-4000-8000-000000000001";
const ID_VER_SKILL_B = "e1000000-0000-4000-8000-000000000002";
const ID_VER_SKILL_GLOBAL = "e1000000-0000-4000-8000-000000000003";
const ID_VERSAO_NOVA = "e1000000-0000-4000-8000-0000000000ff";
const ID_ROTEADOR_A = "c2000000-0000-4000-8000-00000000000a";
const ID_ROTEADOR_B = "c2000000-0000-4000-8000-00000000000b";

/** Marcas que só existem nas linhas de A: se aparecem na resposta de B, há vazamento. */
const MARCA_A = "MARCA-DA-ORG-A-3f1c";
const MARCA_B = "MARCA-DA-ORG-B-9d2e";

const LAYER = "promessa_semantica";
const LAYER_DE_ESTILO = chavePersistidaDoAjuste("sem_travessao_longo");

function versaoDeSkill(id: string, org: string | null, name: string) {
  return {
    id,
    organization_id: org,
    name,
    description: `Skill ${name}`,
    body: "corpo",
    matcher: { any_keywords: ["x"] },
    manifest: [],
    forked_from_version_id: null,
    created_at: "2026-08-01T10:00:00Z",
  };
}

function decisao(id: string, org: string, router: string, marca: string) {
  return {
    id,
    organization_id: org,
    router_id: router,
    conversation_id: null,
    message_id: null,
    job_id: null,
    modo: "jev_sob_demanda",
    context_message_count: 8,
    origem: "jev",
    motivo_reserva: null,
    intent_jev: marca,
    intent_tradicional: null,
    intent_final: marca,
    agent_id_final: null,
    confianca_final: 0.9,
    modelo_jev: "jev-1",
    custo_jev_cents: 0.01,
    custo_tradicional_cents: 0,
    custo_incompleto: false,
    tempo_total_ms: 120,
    revisao: null,
    revisado_em: null,
    agent_id_esperado: null,
    created_at: new Date().toISOString(),
  };
}

const LINHAS = {
  org_guardrail_layers: [
    { organization_id: ORG_A, layer: LAYER, enabled: true },
    { organization_id: ORG_B, layer: LAYER, enabled: false },
    { organization_id: ORG_A, layer: LAYER_DE_ESTILO, enabled: true },
    { organization_id: ORG_B, layer: LAYER_DE_ESTILO, enabled: false },
  ],
  jev_router_decisions: [
    decisao("d1000000-0000-4000-8000-00000000000a", ORG_A, ID_ROTEADOR_A, MARCA_A),
    decisao("d1000000-0000-4000-8000-00000000000b", ORG_B, ID_ROTEADOR_B, MARCA_B),
  ],
  jev_observacoes: [],
  llm_calls: [],
  ai_router_members: [],
  ai_routers: [
    { id: ID_ROTEADOR_A, organization_id: ORG_A, name: `Roteador ${MARCA_A}` },
    { id: ID_ROTEADOR_B, organization_id: ORG_B, name: `Roteador ${MARCA_B}` },
  ],
  skill_pointers: [
    { organization_id: ORG_A, name: NOME_SKILL_A, version_id: ID_VER_SKILL_A, updated_at: "2026-08-01T10:00:00Z" },
    { organization_id: ORG_B, name: NOME_SKILL_B, version_id: ID_VER_SKILL_B, updated_at: "2026-08-01T10:00:00Z" },
    { organization_id: null, name: NOME_SKILL_GLOBAL, version_id: ID_VER_SKILL_GLOBAL, updated_at: "2026-08-01T10:00:00Z" },
  ],
  skill_versions: [
    versaoDeSkill(ID_VER_SKILL_A, ORG_A, NOME_SKILL_A),
    versaoDeSkill(ID_VER_SKILL_B, ORG_B, NOME_SKILL_B),
    versaoDeSkill(ID_VER_SKILL_GLOBAL, null, NOME_SKILL_GLOBAL),
  ],
};

/** `skill_versions` e `skill_pointers` aceitam `organization_id` NULL (catálogo de plataforma). */
function novoFalso() {
  return criarClienteAdminFalso({
    orgDona: ORG_A,
    linhas: LINHAS,
    tabelasSemOrganizacao: ["skill_versions", "skill_pointers"],
  });
}

let falso: ReturnType<typeof novoFalso>;
let pool: { query: ReturnType<typeof vi.fn> };

const TABELAS_DO_CATALOGO = ["skill_pointers", "skill_versions"];

/**
 * Leitura do catálogo de plataforma que a rota faz de propósito: `organization_id
 * IS NULL` ou `organization_id = org OR organization_id IS NULL`. Nunca escrita.
 */
function leituraDoCatalogo(c: CadeiaRegistrada, org: string): boolean {
  if (c.operacao !== "select" || !TABELAS_DO_CATALOGO.includes(c.tabela)) return false;
  const soGlobal = c.filtros.some(([coluna, valor]) => coluna === "organization_id" && valor === null);
  const orgOuGlobal = c.filtros.some(
    ([coluna, valor]) =>
      coluna === "or" &&
      typeof valor === "string" &&
      valor.includes(`organization_id.eq.${org}`) &&
      valor.includes("organization_id.is.null"),
  );
  return soGlobal || orgOuGlobal;
}

/** Cadeias que escaparam da organização, sem contar a leitura legítima do catálogo. */
function vazamentosDe(cadeias: CadeiaRegistrada[], org: string): CadeiaRegistrada[] {
  return cadeiasForaDaOrganizacao(cadeias, org).filter((c) => !leituraDoCatalogo(c, org));
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

function paramsDeName(name: string) {
  return { params: Promise.resolve({ name }) };
}

function pacoteZip(arquivos: Record<string, string>): Uint8Array {
  const entradas: Record<string, Uint8Array> = {};
  for (const [caminho, conteudo] of Object.entries(arquivos)) entradas[caminho] = strToU8(conteudo);
  return zipSync(entradas);
}

const SKILL_MD = `---
name: frete-gratis
description: Explica a política de frete grátis ao cliente.
matcher:
  any_keywords: [frete, entrega]
---
Quando o cliente perguntar sobre frete, confirme o CEP.`;

function reqImport(token?: string): NextRequest {
  const form = new FormData();
  const zip = pacoteZip({ "SKILL.md": SKILL_MD, "references/tabela.md": "tabela de frete" });
  form.set("file", new File([zip as BlobPart], "skill.zip", { type: "application/zip" }));
  return new NextRequest("http://localhost/api/v1/ai/skills/import", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

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
  chamar: (token?: string) => Promise<Response>;
  /** O que o token de A tem de ver/fazer, além do status e da ausência de vazamento. */
  verificaA: (res: Response) => Promise<void>;
  /** O que o token de B tem de ver/fazer diante do recurso de A. */
  verificaB: (res: Response) => Promise<void>;
  /** Auditoria da escrita (ação). */
  acao?: string;
};

async function camadaDoCorpo(res: Response, layer: string): Promise<{ escolha: boolean | null; efetivo: boolean }> {
  const corpo = (await res.json()) as { data: { camadas: Array<{ layer: string; escolha: boolean | null; efetivo: boolean }> } };
  const achada = corpo.data.camadas.find((c) => c.layer === layer);
  if (!achada) throw new Error(`camada ${layer} ausente da resposta`);
  return achada;
}

const CASOS: Caso[] = [
  {
    nome: "GET /ai/guardrail-layers",
    papel: "manager",
    resource: "ai_guardrail_layers",
    escopo: "config:read",
    escreve: false,
    statusDeSucesso: 200,
    chamar: (token) => rotaGuardrail.GET(reqDe("GET", "/api/v1/ai/guardrail-layers", token)),
    verificaA: async (res) => {
      const corpo = (await res.clone().json()) as { data: { podeEditar: boolean } };
      expect(corpo.data.podeEditar).toBe(true);
      expect((await camadaDoCorpo(res, LAYER)).escolha).toBe(true);
    },
    verificaB: async (res) => {
      // B escolheu `false`: se a consulta tivesse vindo sem o filtro de B, apareceria `true` (A).
      expect(res.status).toBe(200);
      expect((await camadaDoCorpo(res, LAYER)).escolha).toBe(false);
    },
  },
  {
    nome: "GET /ai/style-adjustments",
    papel: "manager",
    resource: "ai_style_adjustments",
    escopo: "config:read",
    escreve: false,
    statusDeSucesso: 200,
    chamar: (token) => rotaEstilo.GET(reqDe("GET", "/api/v1/ai/style-adjustments", token)),
    verificaA: async (res) => {
      const corpo = (await res.json()) as { data: { podeEditar: boolean; ajustes: Array<{ ajuste: string; enabled: boolean }> } };
      expect(corpo.data.podeEditar).toBe(true);
      expect(corpo.data.ajustes).toEqual([{ ajuste: "sem_travessao_longo", enabled: true }]);
    },
    verificaB: async (res) => {
      expect(res.status).toBe(200);
      const corpo = (await res.json()) as { data: { ajustes: Array<{ ajuste: string; enabled: boolean }> } };
      expect(corpo.data.ajustes).toEqual([{ ajuste: "sem_travessao_longo", enabled: false }]);
    },
  },
  {
    nome: "GET /ai/routing-results",
    papel: "manager",
    resource: "jev_router_decisions",
    escopo: "config:read",
    escreve: false,
    statusDeSucesso: 200,
    chamar: (token) => rotaRoteamento.GET(reqDe("GET", "/api/v1/ai/routing-results", token)),
    verificaA: async (res) => {
      const texto = await res.text();
      expect(texto).toContain(MARCA_A);
      expect(texto).not.toContain(MARCA_B);
      expect(texto).toContain('"pode_revisar":true');
    },
    verificaB: async (res) => {
      expect(res.status).toBe(200);
      const texto = await res.text();
      expect(texto).toContain(MARCA_B);
      expect(texto).not.toContain(MARCA_A);
    },
  },
  {
    nome: "POST /ai/skills/[name]/install",
    papel: "manager",
    resource: "ai_skills",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 201,
    acao: "ai.skill_installed",
    chamar: (token) =>
      rotaInstall.POST(
        reqDe("POST", `/api/v1/ai/skills/${NOME_SKILL_GLOBAL}/install`, token),
        paramsDeName(NOME_SKILL_GLOBAL),
      ),
    verificaA: async () => {
      expect(insertSkillVersion).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: ORG_A, name: NOME_SKILL_GLOBAL, forkedFromVersionId: ID_VER_SKILL_GLOBAL }),
      );
      expect(setSkillPointer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: ORG_A, name: NOME_SKILL_GLOBAL, versionId: ID_VERSAO_NOVA }),
      );
    },
    // Instalar é do catálogo de plataforma para a PRÓPRIA organização: com o token de B,
    // a cópia nasce em B e nunca em A.
    verificaB: async (res) => {
      expect(res.status).toBe(201);
      expect(insertSkillVersion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: ORG_B }));
      expect(insertSkillVersion).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: ORG_A }));
      expect(setSkillPointer).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: ORG_A }));
    },
  },
  {
    nome: "POST /ai/skills/[name]/restore",
    papel: "manager",
    resource: "ai_skills",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 200,
    acao: "ai.skill_restored",
    chamar: (token) =>
      rotaRestore.POST(
        reqDe("POST", `/api/v1/ai/skills/${NOME_SKILL_A}/restore`, token, { version_id: ID_VER_SKILL_A }),
        paramsDeName(NOME_SKILL_A),
      ),
    verificaA: async () => {
      expect(setSkillPointer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: ORG_A, name: NOME_SKILL_A, versionId: ID_VER_SKILL_A }),
      );
    },
    verificaB: async (res) => {
      expect(res.status).toBe(404);
      expect(setSkillPointer).not.toHaveBeenCalled();
    },
  },
  {
    nome: "PUT /ai/skills/[name]",
    papel: "manager",
    resource: "ai_skills",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 200,
    acao: "ai.skill_saved",
    chamar: (token) =>
      rotaSkill.PUT(
        reqDe("PUT", `/api/v1/ai/skills/${NOME_SKILL_A}`, token, {
          description: "Como apresentar o catálogo.",
          body: "# Catálogo\n- mostre as motos",
          matcher: { any_keywords: ["moto"] },
        }),
        paramsDeName(NOME_SKILL_A),
      ),
    verificaA: async (res) => {
      const corpo = (await res.json()) as { data: { name: string; version_id: string } };
      expect(corpo.data).toEqual({ name: NOME_SKILL_A, version_id: ID_VERSAO_NOVA });
      expect(insertSkillVersion).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: ORG_A, name: NOME_SKILL_A }),
      );
      expect(setSkillPointer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: ORG_A, name: NOME_SKILL_A, versionId: ID_VERSAO_NOVA }),
      );
    },
    verificaB: async (res) => {
      // A skill `minha-skill` só está instalada em A: para B o ponteiro não existe.
      expect(res.status).toBe(404);
      expect(insertSkillVersion).not.toHaveBeenCalled();
      expect(setSkillPointer).not.toHaveBeenCalled();
    },
  },
  {
    nome: "POST /ai/skills/import",
    papel: "manager",
    resource: "ai_skills",
    escopo: "config:write",
    escreve: true,
    statusDeSucesso: 201,
    acao: "ai.skill_imported",
    chamar: (token) => rotaImport.POST(reqImport(token)),
    verificaA: async () => {
      expect(insertSkillVersion).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: ORG_A, name: "frete-gratis" }),
      );
      expect(setSkillPointer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: ORG_A }));
      expect(falso.uploads.length).toBeGreaterThan(0);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
    },
    // O pacote é da organização do token: com o token de B, o storage e o ponteiro são de B.
    verificaB: async (res) => {
      expect(res.status).toBe(201);
      expect(insertSkillVersion).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: ORG_B }));
      expect(insertSkillVersion).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: ORG_A }));
      expect(falso.uploads.length).toBeGreaterThan(0);
      expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
      expect(falso.uploads.some((u) => u.caminho.split("/").includes(ORG_A))).toBe(false);
    },
  },
];

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  falso = novoFalso();
  pool = {
    query: vi.fn(async () => ({
      rowCount: 1,
      rows: [
        {
          id: ID_VER_SKILL_GLOBAL,
          name: NOME_SKILL_GLOBAL,
          description: "Skill global de plataforma",
          body: "corpo global",
          matcher: { any_keywords: ["g"] },
          manifest: [],
        },
      ],
    })),
  };
  vi.mocked(getSkillsPool).mockReturnValue(pool as never);
  vi.mocked(insertSkillVersion).mockResolvedValue({ id: ID_VERSAO_NOVA } as never);
  vi.mocked(setSkillPointer).mockResolvedValue(undefined as never);
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
    expect(vazamentosDe(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    await caso.verificaA(res);
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
    expect(vazamentosDe(falso.cadeias, ORG_B)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_B)).toEqual([]);
    expect(cadeiasDeEscrita(falso.cadeias).filter((c) => c.tabela === "skill_pointers")).toEqual([]);
    await caso.verificaB(res);
    if (caso.escreve && res.status >= 400) expect(audit).not.toHaveBeenCalled();
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
    expect(insertSkillVersion).not.toHaveBeenCalled();
    expect(setSkillPointer).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel (manager < admin do tokenRole) é recusado (403), sem consulta", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
    expect(insertSkillVersion).not.toHaveBeenCalled();
    expect(setSkillPointer).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem tocar no banco", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
    expect(insertSkillVersion).not.toHaveBeenCalled();
    expect(setSkillPointer).not.toHaveBeenCalled();
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
// Sessão que PASSA o portão: o caminho antigo segue como era
// ---------------------------------------------------------------------------

function sessaoOk(role: Role): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u-sessao", idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org A", role },
  } as never);
}

describe("sessão que passa o portão nos três GET", () => {
  it("guardrail-layers: cliente de sessão, organização da sessão, podeEditar pelo papel", async () => {
    sessaoOk("manager");
    vi.mocked(createClient).mockResolvedValue(falso.cliente as never);
    const res = await rotaGuardrail.GET(reqDe("GET", "/api/v1/ai/guardrail-layers"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { podeEditar: boolean } };
    expect(corpo.data.podeEditar).toBe(false);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(validateBearerToken).not.toHaveBeenCalled();

    sessaoOk("admin");
    vi.mocked(createClient).mockResolvedValue(falso.cliente as never);
    const admin = await rotaGuardrail.GET(reqDe("GET", "/api/v1/ai/guardrail-layers"));
    expect(((await admin.json()) as { data: { podeEditar: boolean } }).data.podeEditar).toBe(true);
  });

  it("style-adjustments: cliente de sessão, organização da sessão, podeEditar pelo papel", async () => {
    sessaoOk("manager");
    vi.mocked(createClient).mockResolvedValue(falso.cliente as never);
    const res = await rotaEstilo.GET(reqDe("GET", "/api/v1/ai/style-adjustments"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { podeEditar: boolean } };
    expect(corpo.data.podeEditar).toBe(false);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(validateBearerToken).not.toHaveBeenCalled();
  });

  it("routing-results: organização da sessão, pode_revisar pelo papel", async () => {
    sessaoOk("manager");
    const res = await rotaRoteamento.GET(reqDe("GET", "/api/v1/ai/routing-results"));
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(texto).toContain(MARCA_A);
    expect(texto).not.toContain(MARCA_B);
    expect(texto).toContain('"pode_revisar":false');
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// O que a matriz não mede
// ---------------------------------------------------------------------------

describe("o que a matriz não mede", () => {
  it("o token não escolhe a organização: query e corpo com a organização de A não valem para o token de B", async () => {
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await rotaRoteamento.GET(
      reqDe("GET", `/api/v1/ai/routing-results?organization_id=${ORG_A}&router_id=${ID_ROTEADOR_A}`, TOKEN_B),
    );
    // `organization_id` na query é ignorado; o filtro de `router_id` de A, sob a organização B, não acha nada.
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(texto).not.toContain(MARCA_A);
    expect(vazamentosDe(falso.cadeias, ORG_B)).toEqual([]);
  });

  it("install de skill que não existe no catálogo de plataforma → 404, sem instalar", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaInstall.POST(
      reqDe("POST", "/api/v1/ai/skills/nao-existe/install", TOKEN_A),
      paramsDeName("nao-existe"),
    );
    expect(res.status).toBe(404);
    expect(insertSkillVersion).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("install: nome fora da classe do proxy (maiúscula, ponto) → 422, sem tocar o banco", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaInstall.POST(
      reqDe("POST", "/api/v1/ai/skills/Nome.Ruim/install", TOKEN_A),
      paramsDeName("Nome.Ruim"),
    );
    expect(res.status).toBe(422);
    expect(falso.cadeias).toEqual([]);
  });

  it("restore: versão de outra organização com o token de A → 404, ponteiro de A intacto", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaRestore.POST(
      reqDe("POST", `/api/v1/ai/skills/${NOME_SKILL_A}/restore`, TOKEN_A, { version_id: ID_VER_SKILL_B }),
      paramsDeName(NOME_SKILL_A),
    );
    expect(res.status).toBe(404);
    expect(setSkillPointer).not.toHaveBeenCalled();
    expect(vazamentosDe(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("restore: o corpo não aceita organization_id (schema estrito) → 422", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaRestore.POST(
      reqDe("POST", `/api/v1/ai/skills/${NOME_SKILL_A}/restore`, TOKEN_A, {
        version_id: ID_VER_SKILL_A,
        organization_id: ORG_B,
      }),
      paramsDeName(NOME_SKILL_A),
    );
    expect(res.status).toBe(422);
    expect(setSkillPointer).not.toHaveBeenCalled();
  });

  it("PUT de skill de pacote com token: os arquivos são copiados dentro do prefixo da organização do token", async () => {
    const pacote = [{ path: "references/tabela.md", size: 3, sha256: "a", kind: "reference" }];
    const versaoComPacote = { ...versaoDeSkill(ID_VER_SKILL_A, ORG_A, NOME_SKILL_A), manifest: pacote };
    falso = criarClienteAdminFalso({
      orgDona: ORG_A,
      linhas: { ...LINHAS, skill_versions: [versaoComPacote, ...LINHAS.skill_versions.slice(1)] },
      tabelasSemOrganizacao: ["skill_versions", "skill_pointers"],
    });
    vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkill.PUT(
      reqDe("PUT", `/api/v1/ai/skills/${NOME_SKILL_A}`, TOKEN_A, {
        description: "d",
        body: "# t\n- x",
        matcher: { any_keywords: ["x"] },
      }),
      paramsDeName(NOME_SKILL_A),
    );
    expect(res.status).toBe(200);
    expect(falso.uploads.filter((u) => u.operacao === "download").map((u) => u.caminho)).toEqual([
      `${ORG_A}/${NOME_SKILL_A}/${ID_VER_SKILL_A}/references/tabela.md`,
    ]);
    expect(falso.uploads.filter((u) => u.operacao === "upload").map((u) => u.caminho)).toEqual([
      `${ORG_A}/${NOME_SKILL_A}/${ID_VERSAO_NOVA}/references/tabela.md`,
    ]);
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
    expect(vazamentosDe(falso.cadeias, ORG_A)).toEqual([]);
  });

  it("PUT com token respeita requireSupportWrite (suporte bloqueia antes de qualquer coisa)", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 423 }) as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaSkill.PUT(
      reqDe("PUT", `/api/v1/ai/skills/${NOME_SKILL_A}`, TOKEN_A, {
        description: "d",
        body: "# t\n- x",
        matcher: { any_keywords: ["x"] },
      }),
      paramsDeName(NOME_SKILL_A),
    );
    expect(res.status).toBe(423);
    expect(falso.cadeias).toEqual([]);
    expect(insertSkillVersion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bloco de borda: PUBLIC_PATHS
// ---------------------------------------------------------------------------

describe("PUBLIC_PATHS: borda do proxy para as portas do lote 1", () => {
  const UUID = "11111111-1111-4111-8111-111111111111";

  it.each([
    "/api/v1/ai/guardrail-layers",
    "/api/v1/ai/style-adjustments",
    "/api/v1/ai/routing-results",
    `/api/v1/ai/routing-results/${UUID}`,
    "/api/v1/ai/skills/import",
    `/api/v1/ai/skills/${NOME_SKILL_A}`,
    `/api/v1/ai/skills/${NOME_SKILL_A}/install`,
    `/api/v1/ai/skills/${NOME_SKILL_A}/restore`,
  ])("libera %s para Bearer", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });

  it.each([
    "/api/v1/ai/guardrail-layers/x",
    "/api/v1/ai/style-adjustments/x",
    "/api/v1/ai/routing-results/x",
    "/api/v1/ai/routing-results/x/y",
    "/api/v1/ai/skills/import/x",
    `/api/v1/ai/skills/${NOME_SKILL_A}/install/x`,
    `/api/v1/ai/skills/${NOME_SKILL_A}/restore/x`,
    "/api/v1/ai/skills/nome.ruim/install",
    "/api/v1/ai/skills/nome.ruim/restore",
    `/api/v1/ai/skills/${NOME_SKILL_A}/import`,
    `/api/v1/ai/skills/${NOME_SKILL_A}/instalar`,
  ])("não libera %s", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});
