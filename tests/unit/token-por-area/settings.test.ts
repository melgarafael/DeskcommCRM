// @vitest-environment node
/**
 * Token de integração nas rotas de `settings` (Spec 33, fatia R1).
 *
 * As 9 rotas com método convertido (19 métodos) têm, por método, seis testes:
 *  - token de A alcança o recurso de A (2xx, nada de B lido ou escrito, audit com o token);
 *  - token de B não alcança o recurso de A (404/409 nas rotas com id, ou o próprio
 *    recurso de B nas de organização; a linha de A fica igual);
 *  - token sem o escopo exigido → 403, sem tocar no banco;
 *  - token abaixo do papel (tokenRole admin) → 403;
 *  - acima do teto do token → 429 com Retry-After, sem tocar no banco;
 *  - sessão continua com o mesmo portão (`requireRole` com o papel da tabela).
 *
 * Dois métodos ficam SÓ DE SESSÃO (PAREI, com motivo no código): o PATCH de
 * `routing/channels` e o POST de `proposal-templates/importar`. Para eles, o caso
 * é 401 e o cliente do banco nunca é aberto. O GET de `routing/channels` aceita
 * token desde o lote 3 (bateria em `config-r1-lote3.test.ts`).
 *
 * O banco é `criarClienteAdminFalso`: guarda linhas das duas organizações e acusa
 * cadeia sem `organization_id` (ou RPC/arquivo de outra organização). O ramo de
 * token usa o cliente admin; o cliente de sessão e o `requireRole` lançam se o
 * ramo de token os tocar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { CONFIGURACAO_PADRAO } from "@/lib/campanhas/configuracao";
import { isPublicPath } from "@/lib/auth/public-paths";
import type { Role } from "@/lib/auth/types";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  arquivosForaDaOrganizacao,
  cadeiasDeEscrita,
  cadeiasForaDaOrganizacao,
  criarClienteAdminFalso,
  rpcsForaDaOrganizacao,
} from "@/tests/unit/helpers/cliente-admin-falso";

import * as rotaAgenda from "@/app/api/v1/settings/agenda-apresentacao/route";
import * as rotaCampanhas from "@/app/api/v1/settings/campanhas/route";
import * as rotaSlug from "@/app/api/v1/settings/proposal-templates/[slug]/route";
import * as rotaModelos from "@/app/api/v1/settings/proposal-templates/route";
import * as rotaImportar from "@/app/api/v1/settings/proposal-templates/importar/route";
import * as rotaPropostas from "@/app/api/v1/settings/proposals/route";
import * as rotaProspeccao from "@/app/api/v1/settings/prospeccao/route";
import * as rotaRoutingCanais from "@/app/api/v1/settings/routing/channels/route";
import * as rotaRouting from "@/app/api/v1/settings/routing/route";
import * as rotaSons from "@/app/api/v1/settings/sons/route";
import * as rotaPlanos from "@/app/api/v1/settings/task-plans/route";

vi.mock("@/lib/auth/require-role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/require-role")>()),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(),
  mfaEmDividaEstrita: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instalacao/modulos")>()),
  moduloLigado: vi.fn(),
}));
vi.mock("@/lib/propostas/porta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/propostas/porta")>()),
  sePropostasDesligadas: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures — declaradas antes do uso
// ---------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_A = "tok-a";
const TOKEN_B = "tok-b";
const TODOS_OS_ESCOPOS = ["config:read", "config:write"];
const MENSAGEM_DO_CLIENTE_DE_SESSAO = "cliente de sessão usado no ramo do token";
const PESSOA_DA_SESSAO = "c0000000-0000-4000-8000-000000000001";

/**
 * Recurso de ORGANIZAÇÃO: o alvo é a própria organização do token (a linha
 * `organizations` pelo id, ou o `settings` dela). Por isso o "token de B" tenta
 * alcançar a organização de A e a prova não é um 404: é a linha de A intacta e
 * uma resposta sem nenhuma marca de A.
 */
const ROTAS_DE_ORGANIZACAO = new Set([
  "agenda_presentation",
  "campaign_settings",
  "organizations",
  "prospecting_settings",
  "settings_routing",
  "settings_sons",
  "task_plans",
]);
const MARCAS_DE_A = [ORG_A, "Agenda A", "Ana A", "venda-a"];

const CONFIG_A = {
  atribuicao_horas: 48,
  intervalo_segundos: 30,
  janela_inicio_hora: 8,
  janela_fim_hora: 18,
  teto_diario: 100,
  teto_horario: 20,
};
const ROUTING_A = { mode: "manual", max_retries: 7, backoff_seconds: 60 };
const PROPOSTAS_A = { enabled: true, default_valid_days: 15, default_conditions: null };
const PLANO = {
  id: "proposta-enviada",
  nome: "Proposta enviada",
  descricao: null,
  passos: [{ ordem: 1, titulo: "Ligar em 2 dias", vence_em_dias: 2, prioridade: "medium", atribuir_a: "dono_do_lead" }],
};
const SECOES = [{ id: "summary", title: "Resumo", titleEs: null, body: "Texto.", bodyEs: null, required: true, conditional: false }];

/** Organização A com configuração em todas as chaves que as rotas leem; B sem nada. */
const ORG_A_ROW = {
  id: ORG_A,
  nome: "Org A",
  settings: {
    campanhas: CONFIG_A,
    routing: ROUTING_A,
    visibility_mode: "own_and_unassigned",
    prospeccao: { vendedor_nome: "Ana A" },
    task_plans: [PLANO],
    sons_de_aviso: { venda: `${ORG_A}/venda-a.mp3` },
    proposals: PROPOSTAS_A,
    agenda_presentation: { title: "Agenda A" },
  },
};
const ORG_B_ROW = { id: ORG_B, nome: "Org B", settings: null };

/** Modelo personalizado de A (slug `empresa_minha`) e um modelo de B com outro slug. */
const MODELO_A = {
  id: "pt-a",
  organization_id: ORG_A,
  slug: "empresa_minha",
  base_slug: null,
  base_version: null,
  nome: "Minha proposta",
  descricao: null,
  version: 1,
  sections: SECOES,
  section_order: ["summary"],
  is_active: true,
};
const MODELO_B = { ...MODELO_A, id: "pt-b", organization_id: ORG_B, slug: "empresa_outra", nome: "Outra de B" };

/** Linhas das DUAS organizações: o dublê precisa ver as duas para acusar vazamento. */
const LINHAS = {
  organizations: [ORG_A_ROW, ORG_B_ROW],
  proposal_templates: [MODELO_A, MODELO_B],
};

const WAV = new Uint8Array([
  ...Array.from("RIFF", (c) => c.charCodeAt(0)),
  0,
  0,
  0,
  0,
  ...Array.from("WAVE", (c) => c.charCodeAt(0)),
  ...new Array<number>(32).fill(0),
]);

let falso: ReturnType<typeof novoFalso>;

function novoFalso() {
  return criarClienteAdminFalso({ orgDona: ORG_A, linhas: LINHAS });
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function tokenDe(org: string, token: string, role: Role, scopes: string[] = TODOS_OS_ESCOPOS): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role,
    actor: { type: "api_token", id: token, role },
    apiTokenId: token,
    scopes,
  } as never);
}

function reqJson(metodo: string, caminho: string, corpo: unknown, token?: string): NextRequest {
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {
    method: metodo,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(corpo),
  };
  return new NextRequest(`http://localhost${caminho}`, init);
}

function reqVazio(metodo: string, caminho: string, token?: string): NextRequest {
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {
    method: metodo,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  return new NextRequest(`http://localhost${caminho}`, init);
}

function reqSom(token?: string): NextRequest {
  const form = new FormData();
  form.set("tipo", "venda");
  form.set("arquivo", new File([new Uint8Array(WAV)], "som.wav", { type: "audio/wav" }));
  const init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {
    method: "POST",
    body: form,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  return new NextRequest("http://localhost/api/v1/settings/sons", init);
}

async function corpoDe(res: Response): Promise<{ data: unknown }> {
  return (await res.json()) as { data: unknown };
}

/** `settings` da organização na linha viva do dublê (o que a rota gravou aparece aqui). */
function settingsDe(org: string): Record<string, unknown> {
  const linha = (falso.linhas.organizations ?? []).find((l) => l.id === org);
  return (linha?.settings ?? {}) as Record<string, unknown>;
}

function modeloDe(id: string): Record<string, unknown> | undefined {
  return (falso.linhas.proposal_templates ?? []).find((l) => l.id === id);
}

/** As linhas de uma organização, por tabela (organizations pelo id, o resto pela coluna). */
function linhasDaOrganizacao(
  tabelas: Record<string, Record<string, unknown>[]>,
  org: string,
): Record<string, Record<string, unknown>[]> {
  return Object.fromEntries(
    Object.entries(tabelas).map(([tabela, linhas]) => [
      tabela,
      linhas.filter((l) => (tabela === "organizations" ? l.id : l.organization_id) === org),
    ]),
  );
}

type Caso = {
  nome: string;
  papel: Role;
  resource: string;
  escopo: "config:read" | "config:write";
  auditada: boolean;
  chamar: (token: string | undefined) => Promise<Response>;
  confirmaA: (res: Response) => Promise<void>;
  confirmaB: (res: Response) => Promise<void>;
};

/**
 * Os seis testes de cada método. Organização: `organizations` é ela mesma pelo
 * `id` (o dublê trata `eq("id", org)` nessa tabela como filtro de organização).
 */
function seisTestes(caso: Caso): void {
  const escopoFora = caso.escopo === "config:read" ? "config:write" : "config:read";

  it("token de A alcança o recurso de A", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await caso.chamar(TOKEN_A);
    await caso.confirmaA(res);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_A)).toEqual([]);
    expect(rpcsForaDaOrganizacao(falso.rpcs, ORG_A)).toEqual([]);
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_A)).toEqual([]);
    expect(requireRole).not.toHaveBeenCalled();
    if (caso.auditada) {
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null, actorApiTokenId: TOKEN_A }));
    } else {
      expect(audit).not.toHaveBeenCalled();
    }
  });

  it("token de B não alcança o recurso de A", async () => {
    const linhasDeAAntes = linhasDaOrganizacao(LINHAS, ORG_A);
    tokenDe(ORG_B, TOKEN_B, "admin");
    const res = await caso.chamar(TOKEN_B);
    if (ROTAS_DE_ORGANIZACAO.has(caso.resource)) {
      // Organização: nenhuma marca de A pode sair na resposta de B (a linha de A é conferida abaixo).
      const corpo = await res.clone().text();
      for (const marca of MARCAS_DE_A) expect(corpo, `marca de A "${marca}" na resposta de B`).not.toContain(marca);
    }
    await caso.confirmaB(res);
    expect(cadeiasForaDaOrganizacao(falso.cadeias, ORG_B)).toEqual([]);
    expect(arquivosForaDaOrganizacao(falso.uploads, ORG_B)).toEqual([]);
    // A linha de A não muda (o dublê copia as linhas ao montar: `linhasDeAAntes` é o fixture original).
    expect(linhasDaOrganizacao(falso.linhas, ORG_A)).toEqual(linhasDeAAntes);
  });

  it("token sem o escopo exigido é recusado (403), sem tocar no banco", async () => {
    tokenDe(ORG_A, TOKEN_A, "admin", [escopoFora]);
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token abaixo do papel (tokenRole admin) é recusado (403), sem tocar no banco", async () => {
    tokenDe(ORG_A, TOKEN_A, "manager");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(403);
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("acima do teto do token → 429 com Retry-After, sem tocar no banco", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, count: 31, limit: 30 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await caso.chamar(TOKEN_A);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(falso.cadeias).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sessão continua com o mesmo portão (requireRole com o papel da tabela)", async () => {
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
}

// ---------------------------------------------------------------------------
// Ambiente: o ramo de token usa o dublê; a sessão e o requireRole lançam se tocados.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  falso = novoFalso();
  vi.mocked(createAdminClient).mockImplementation(() => falso.cliente as never);
  vi.mocked(createClient).mockImplementation(async () => {
    throw new Error(MENSAGEM_DO_CLIENTE_DE_SESSAO);
  });
  vi.mocked(requireRole).mockImplementation(async () => {
    throw new Error("requireRole chamado no ramo do token");
  });
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 30 } as never);
  vi.mocked(sePropostasDesligadas).mockResolvedValue(null as never);
  vi.mocked(moduloLigado).mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Os 19 métodos convertidos
// ---------------------------------------------------------------------------

const CASOS: Caso[] = [
  {
    nome: "PATCH /api/v1/settings/agenda-apresentacao",
    papel: "manager",
    resource: "agenda_presentation",
    escopo: "config:write",
    auditada: true,
    chamar: (t) => rotaAgenda.PATCH(reqJson("PATCH", "/api/v1/settings/agenda-apresentacao", { title: "Agenda de A" }, t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(settingsDe(ORG_A).agenda_presentation).toEqual({ title: "Agenda de A" });
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect(settingsDe(ORG_B).agenda_presentation).toEqual({ title: "Agenda de A" });
    },
  },
  {
    nome: "GET /api/v1/settings/campanhas",
    papel: "manager",
    resource: "campaign_settings",
    escopo: "config:read",
    auditada: false,
    chamar: (t) => rotaCampanhas.GET(reqVazio("GET", "/api/v1/settings/campanhas", t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as Record<string, unknown>).configuracao).toEqual(CONFIG_A);
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as Record<string, unknown>).configuracao).toEqual(CONFIGURACAO_PADRAO);
    },
  },
  {
    nome: "PATCH /api/v1/settings/campanhas",
    papel: "manager",
    resource: "campaign_settings",
    escopo: "config:write",
    auditada: true,
    chamar: (t) => rotaCampanhas.PATCH(reqJson("PATCH", "/api/v1/settings/campanhas", { atribuicao_horas: 72 }, t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_A).campanhas as Record<string, unknown>).atribuicao_horas).toBe(72);
      // Merge: as outras chaves de `settings` continuam como estavam.
      expect(settingsDe(ORG_A).routing).toEqual(ROUTING_A);
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_B).campanhas as Record<string, unknown>).atribuicao_horas).toBe(72);
    },
  },
  {
    nome: "GET /api/v1/settings/proposal-templates/[slug]",
    papel: "viewer",
    resource: "proposal_templates",
    escopo: "config:read",
    auditada: false,
    chamar: (t) =>
      rotaSlug.GET(reqVazio("GET", "/api/v1/settings/proposal-templates/empresa_minha", t), {
        params: Promise.resolve({ slug: "empresa_minha" }),
      }),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as Record<string, unknown>).nome).toBe("Minha proposta");
    },
    // B não tem cópia de `empresa_minha` e a plataforma não tem esse slug: 404.
    confirmaB: async (res) => {
      expect(res.status).toBe(404);
    },
  },
  {
    nome: "PATCH /api/v1/settings/proposal-templates/[slug]",
    papel: "manager",
    resource: "proposal_templates",
    escopo: "config:write",
    auditada: true,
    chamar: (t) =>
      rotaSlug.PATCH(
        reqJson(
          "PATCH",
          "/api/v1/settings/proposal-templates/empresa_minha",
          { nome: "Minha proposta editada", descricao: null, sections: SECOES, section_order: ["summary"] },
          t,
        ),
        { params: Promise.resolve({ slug: "empresa_minha" }) },
      ),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(modeloDe("pt-a")?.nome).toBe("Minha proposta editada");
    },
    // B não tem cópia de `empresa_minha`: a rota recusa com 409 (personalize antes), sem gravar.
    confirmaB: async (res) => {
      expect(res.status).toBe(409);
      expect(modeloDe("pt-b")?.nome).toBe("Outra de B");
    },
  },
  {
    nome: "DELETE /api/v1/settings/proposal-templates/[slug]",
    papel: "manager",
    resource: "proposal_templates",
    escopo: "config:write",
    auditada: true,
    chamar: (t) =>
      rotaSlug.DELETE(reqVazio("DELETE", "/api/v1/settings/proposal-templates/empresa_minha", t), {
        params: Promise.resolve({ slug: "empresa_minha" }),
      }),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(modeloDe("pt-a")?.is_active).toBe(false);
    },
    // B não tem cópia de `empresa_minha`: 404 "Não há cópia da empresa", e A continua ativo.
    confirmaB: async (res) => {
      expect(res.status).toBe(404);
      expect(modeloDe("pt-a")?.is_active).toBe(true);
    },
  },
  {
    nome: "GET /api/v1/settings/proposal-templates",
    papel: "viewer",
    resource: "proposal_templates",
    escopo: "config:read",
    auditada: false,
    chamar: (t) => rotaModelos.GET(reqVazio("GET", "/api/v1/settings/proposal-templates", t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      const slugs = ((await corpoDe(res)).data as Array<{ slug: string }>).map((m) => m.slug);
      expect(slugs).toContain("empresa_minha");
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      const slugs = ((await corpoDe(res)).data as Array<{ slug: string }>).map((m) => m.slug);
      expect(slugs).toContain("empresa_outra");
      expect(slugs).not.toContain("empresa_minha");
    },
  },
  {
    nome: "POST /api/v1/settings/proposal-templates",
    papel: "manager",
    resource: "proposal_templates",
    escopo: "config:write",
    auditada: true,
    chamar: (t) =>
      rotaModelos.POST(reqJson("POST", "/api/v1/settings/proposal-templates", { acao: "novo", nome: "Locação Teste" }, t)),
    // POST de coleção: a linha criada é da organização do token; A não é lida nem alterada.
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      const slug = ((await corpoDe(res)).data as { slug: string }).slug;
      const criada = (falso.linhas.proposal_templates ?? []).find((l) => l.slug === slug);
      expect(criada?.organization_id).toBe(ORG_A);
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      const slug = ((await corpoDe(res)).data as { slug: string }).slug;
      const criada = (falso.linhas.proposal_templates ?? []).find((l) => l.slug === slug);
      expect(criada?.organization_id).toBe(ORG_B);
    },
  },
  {
    nome: "GET /api/v1/settings/proposals",
    papel: "viewer",
    resource: "organizations",
    escopo: "config:read",
    auditada: false,
    chamar: (t) => rotaPropostas.GET(reqVazio("GET", "/api/v1/settings/proposals", t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as Record<string, unknown>).enabled).toBe(true);
    },
    // B nunca gravou `proposals`: vê o padrão (desligado), não a configuração de A.
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as Record<string, unknown>).enabled).toBe(false);
    },
  },
  {
    nome: "PATCH /api/v1/settings/proposals",
    papel: "manager",
    resource: "organizations",
    escopo: "config:write",
    auditada: true,
    chamar: (t) =>
      rotaPropostas.PATCH(
        reqJson("PATCH", "/api/v1/settings/proposals", { enabled: true, default_valid_days: 20, default_conditions: null }, t),
      ),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_A).proposals as Record<string, unknown>).default_valid_days).toBe(20);
      expect(settingsDe(ORG_A).campanhas).toEqual(CONFIG_A);
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_B).proposals as Record<string, unknown>).default_valid_days).toBe(20);
    },
  },
  {
    nome: "GET /api/v1/settings/prospeccao",
    papel: "manager",
    resource: "prospecting_settings",
    escopo: "config:read",
    auditada: false,
    chamar: (t) => rotaProspeccao.GET(reqVazio("GET", "/api/v1/settings/prospeccao", t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as { personalizacao: Record<string, unknown> }).personalizacao.vendedor_nome).toBe(
        "Ana A",
      );
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as { personalizacao: Record<string, unknown> }).personalizacao.vendedor_nome).not.toBe(
        "Ana A",
      );
    },
  },
  {
    nome: "PATCH /api/v1/settings/prospeccao",
    papel: "manager",
    resource: "prospecting_settings",
    escopo: "config:write",
    auditada: true,
    chamar: (t) => rotaProspeccao.PATCH(reqJson("PATCH", "/api/v1/settings/prospeccao", { vendedor_nome: "Bia" }, t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(settingsDe(ORG_A).prospeccao).toEqual({ vendedor_nome: "Bia" });
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_B).prospeccao as Record<string, unknown>).vendedor_nome).toBe("Bia");
    },
  },
  {
    nome: "GET /api/v1/settings/routing",
    papel: "manager",
    resource: "settings_routing",
    escopo: "config:read",
    auditada: false,
    chamar: (t) => rotaRouting.GET(reqVazio("GET", "/api/v1/settings/routing", t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as Record<string, unknown>).max_retries).toBe(7);
    },
    // B sem configuração: o padrão da rota (5), não o 7 de A.
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as Record<string, unknown>).max_retries).toBe(5);
    },
  },
  {
    nome: "PATCH /api/v1/settings/routing",
    papel: "manager",
    resource: "settings_routing",
    escopo: "config:write",
    auditada: true,
    chamar: (t) => rotaRouting.PATCH(reqJson("PATCH", "/api/v1/settings/routing", { max_retries: 9 }, t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_A).routing as Record<string, unknown>).max_retries).toBe(9);
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_B).routing as Record<string, unknown>).max_retries).toBe(9);
    },
  },
  {
    nome: "GET /api/v1/settings/sons",
    papel: "viewer",
    resource: "settings_sons",
    escopo: "config:read",
    auditada: false,
    chamar: (t) => rotaSons.GET(reqVazio("GET", "/api/v1/settings/sons", t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      const urls = (await corpoDe(res)).data as Record<string, string | null>;
      expect(urls.venda).toContain(`${ORG_A}/venda-a.mp3`);
      expect(urls.pessoa).toBeNull();
    },
    // B não tem som: nenhuma URL assinada, e nenhum caminho de A é assinado.
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect((await corpoDe(res)).data).toEqual({ venda: null, pessoa: null });
      expect(falso.uploads).toEqual([]);
    },
  },
  {
    nome: "POST /api/v1/settings/sons",
    papel: "manager",
    resource: "settings_sons",
    escopo: "config:write",
    auditada: true,
    chamar: (t) => rotaSons.POST(reqSom(t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(201);
      const venda = (settingsDe(ORG_A).sons_de_aviso as Record<string, string>).venda ?? "";
      expect(venda.startsWith(`${ORG_A}/venda-`)).toBe(true);
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(201);
      const venda = (settingsDe(ORG_B).sons_de_aviso as Record<string, string>).venda ?? "";
      expect(venda.startsWith(`${ORG_B}/venda-`)).toBe(true);
      expect((settingsDe(ORG_A).sons_de_aviso as Record<string, string>).venda).toBe(`${ORG_A}/venda-a.mp3`);
    },
  },
  {
    nome: "DELETE /api/v1/settings/sons",
    papel: "manager",
    resource: "settings_sons",
    escopo: "config:write",
    auditada: true,
    chamar: (t) => rotaSons.DELETE(reqVazio("DELETE", "/api/v1/settings/sons?tipo=venda", t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_A).sons_de_aviso as Record<string, unknown>).venda).toBeUndefined();
    },
    // B não tem som para tirar: a rota responde 200 sem remover nada (nem o de A).
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_B).sons_de_aviso as Record<string, unknown> | undefined)?.venda).toBeUndefined();
      expect(falso.uploads).toEqual([]);
    },
  },
  {
    nome: "GET /api/v1/settings/task-plans",
    papel: "viewer",
    resource: "task_plans",
    escopo: "config:read",
    auditada: false,
    chamar: (t) => rotaPlanos.GET(reqVazio("GET", "/api/v1/settings/task-plans", t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      const planos = ((await corpoDe(res)).data as { planos: Array<{ id: string }> }).planos;
      expect(planos.map((p) => p.id)).toEqual(["proposta-enviada"]);
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect(((await corpoDe(res)).data as { planos: unknown[] }).planos).toEqual([]);
    },
  },
  {
    nome: "PATCH /api/v1/settings/task-plans",
    papel: "manager",
    resource: "task_plans",
    escopo: "config:write",
    auditada: true,
    chamar: (t) => rotaPlanos.PATCH(reqJson("PATCH", "/api/v1/settings/task-plans", { planos: [PLANO] }, t)),
    confirmaA: async (res) => {
      expect(res.status).toBe(200);
      expect(settingsDe(ORG_A).campanhas).toEqual(CONFIG_A);
      expect((settingsDe(ORG_A).task_plans as Array<{ id: string }>).map((p) => p.id)).toEqual(["proposta-enviada"]);
    },
    confirmaB: async (res) => {
      expect(res.status).toBe(200);
      expect((settingsDe(ORG_B).task_plans as Array<{ id: string }>).map((p) => p.id)).toEqual(["proposta-enviada"]);
    },
  },
];

for (const caso of CASOS) {
  describe(caso.nome, () => {
    seisTestes(caso);
  });
}

// ---------------------------------------------------------------------------
// Fica só de sessão (PAREI): sem porta, sem conversão, 401 e sem cliente do banco.
// ---------------------------------------------------------------------------

describe("fica só de sessão (PAREI, sem porta)", () => {
  // Sem cookie, o `requireRole` de sessão recusa com 401: o mock imita isso e a
  // rota não pode abrir cliente do banco nem ler o Bearer.
  function sessaoAusente(): void {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    } as never);
  }

  it("POST /api/v1/settings/proposal-templates/importar: token recebe 401 e o banco não é aberto", async () => {
    // `importar` usa `getSkillsPool` (pg Pool cru) e o LLM pago sem teto por token: fica de fora.
    sessaoAusente();
    const res = await rotaImportar.POST(reqVazio("POST", "/api/v1/settings/proposal-templates/importar", TOKEN_A));
    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "proposal_templates" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("PATCH /api/v1/settings/routing/channels: token recebe 401; fn_set_channel_routing exige auth.uid()", async () => {
    sessaoAusente();
    const res = await rotaRoutingCanais.PATCH(
      reqJson("PATCH", "/api/v1/settings/routing/channels", { channel_session_id: TOKEN_A, user_ids: [], reset: false }, TOKEN_A),
    );
    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "settings_routing", allowPlatformAdmin: true }),
    );
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sessão com 2xx nas rotas que não tinham teste de sessão com resposta de sucesso.
// ---------------------------------------------------------------------------

/** Sessão de A: `requireRole` resolvido; o cliente de sessão é o dublê de A (a RLS não é modelada). */
function sessaoDeA(papel: Role): void {
  vi.mocked(createClient).mockResolvedValue(falso.cliente as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: PESSOA_DA_SESSAO, idioma: "pt-BR" },
    org: { orgId: ORG_A, name: "Org A", role: papel },
  } as never);
}

describe("sessão com 2xx nas rotas sem teste antigo de sucesso", () => {
  it("PATCH agenda-apresentacao: 200, grava em A e audita com o usuário (sem token)", async () => {
    sessaoDeA("manager");
    const res = await rotaAgenda.PATCH(reqJson("PATCH", "/api/v1/settings/agenda-apresentacao", { title: "Agenda de A" }));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "agenda_presentation" }));
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(settingsDe(ORG_A).agenda_presentation).toEqual({ title: "Agenda de A" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: PESSOA_DA_SESSAO, actorApiTokenId: null, organizationId: ORG_A }),
    );
  });

  it("GET campanhas: 200 com a configuração de A, sem auditoria", async () => {
    sessaoDeA("manager");
    const res = await rotaCampanhas.GET(reqVazio("GET", "/api/v1/settings/campanhas"));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "campaign_settings" }));
    expect(((await corpoDe(res)).data as Record<string, unknown>).configuracao).toEqual(CONFIG_A);
    expect(audit).not.toHaveBeenCalled();
  });

  it("PATCH campanhas: 200, grava em A, preserva `routing`, audita com o usuário", async () => {
    sessaoDeA("manager");
    const res = await rotaCampanhas.PATCH(reqJson("PATCH", "/api/v1/settings/campanhas", { atribuicao_horas: 72 }));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "campaign_settings" }));
    expect((settingsDe(ORG_A).campanhas as Record<string, unknown>).atribuicao_horas).toBe(72);
    expect(settingsDe(ORG_A).routing).toEqual(ROUTING_A);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: PESSOA_DA_SESSAO, actorApiTokenId: null, organizationId: ORG_A }),
    );
  });

  it("GET prospeccao: 200 com a personalização de A, sem auditoria", async () => {
    sessaoDeA("manager");
    const res = await rotaProspeccao.GET(reqVazio("GET", "/api/v1/settings/prospeccao"));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "prospecting_settings" }));
    expect(((await corpoDe(res)).data as { personalizacao: Record<string, unknown> }).personalizacao.vendedor_nome).toBe("Ana A");
    expect(audit).not.toHaveBeenCalled();
  });

  it("PATCH prospeccao: 200, grava em A, audita com o usuário", async () => {
    sessaoDeA("manager");
    const res = await rotaProspeccao.PATCH(reqJson("PATCH", "/api/v1/settings/prospeccao", { vendedor_nome: "Bia" }));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "prospecting_settings" }));
    expect(settingsDe(ORG_A).prospeccao).toEqual({ vendedor_nome: "Bia" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: PESSOA_DA_SESSAO, actorApiTokenId: null, organizationId: ORG_A }),
    );
  });

  it("GET routing: 200 com o `max_retries` de A, sem auditoria", async () => {
    sessaoDeA("manager");
    const res = await rotaRouting.GET(reqVazio("GET", "/api/v1/settings/routing"));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "settings_routing" }));
    expect(((await corpoDe(res)).data as Record<string, unknown>).max_retries).toBe(7);
    expect(audit).not.toHaveBeenCalled();
  });

  it("PATCH routing: 200, grava em A, audita com o usuário", async () => {
    sessaoDeA("manager");
    const res = await rotaRouting.PATCH(reqJson("PATCH", "/api/v1/settings/routing", { max_retries: 9 }));
    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "settings_routing" }));
    expect((settingsDe(ORG_A).routing as Record<string, unknown>).max_retries).toBe(9);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: PESSOA_DA_SESSAO, actorApiTokenId: null, organizationId: ORG_A }),
    );
  });
});

// ---------------------------------------------------------------------------
// Teto POR ORGANIZAÇÃO: a primeira chamada do `checkRateLimit` (o token) passa; a
// segunda (a organização) recusa. Nada pode ser gravado.
// ---------------------------------------------------------------------------

describe("teto por organização recusa a escrita com 429", () => {
  it("PATCH campanhas: token dentro do seu teto, organização acima → 429, nada escrito", async () => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true, count: 1, limit: 30 } as never)
      .mockResolvedValueOnce({ allowed: false, count: 501, limit: 500 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaCampanhas.PATCH(reqJson("PATCH", "/api/v1/settings/campanhas", { atribuicao_horas: 72 }, TOKEN_A));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(vi.mocked(checkRateLimit).mock.calls[1]?.[0]).toBe(`settings.campanhas:org:${ORG_A}`);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(settingsDe(ORG_A).campanhas).toEqual(CONFIG_A);
    expect(audit).not.toHaveBeenCalled();
  });

  it("POST proposal-templates: a mesma recusa do teto da organização não cria modelo", async () => {
    vi.mocked(checkRateLimit)
      .mockResolvedValueOnce({ allowed: true, count: 1, limit: 30 } as never)
      .mockResolvedValueOnce({ allowed: false, count: 501, limit: 500 } as never);
    tokenDe(ORG_A, TOKEN_A, "admin");
    const res = await rotaModelos.POST(
      reqJson("POST", "/api/v1/settings/proposal-templates", { acao: "novo", nome: "Locação Teste" }, TOKEN_A),
    );
    expect(res.status).toBe(429);
    expect(cadeiasDeEscrita(falso.cadeias)).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bloco de borda das portas: cada entrada dá `true` no caminho certo e `false`
// no que não é ele (sub-path, irmão literal que não ganhou porta).
// ---------------------------------------------------------------------------

describe("portas de settings: bloco de borda", () => {
  const UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const SEM_ID = ["agenda-apresentacao", "campanhas", "proposals", "prospeccao", "routing", "sons", "task-plans"];

  it("caminhos sem segmento dinâmico: a porta vale no caminho exato e não em sub-path", () => {
    for (const nome of SEM_ID) {
      const caminho = `/api/v1/settings/${nome}`;
      expect(isPublicPath(caminho), caminho).toBe(true);
      expect(isPublicPath(`${caminho}/x/y`), `${caminho}/x/y`).toBe(false);
    }
    // `proposal-templates` tem `[slug]` como filho: o sub-path de um segmento é `[slug]`, não sub-path.
    expect(isPublicPath("/api/v1/settings/proposal-templates")).toBe(true);
    expect(isPublicPath("/api/v1/settings/proposal-templates/x/y")).toBe(false);
  });

  it("[slug] aceita só o formato do slug: hífen e ponto ficam de fora, e UUID também", () => {
    expect(isPublicPath("/api/v1/settings/proposal-templates/empresa_minha")).toBe(true);
    expect(isPublicPath("/api/v1/settings/proposal-templates/empresa-minha")).toBe(false);
    expect(isPublicPath("/api/v1/settings/proposal-templates/empresa.minha")).toBe(false);
    expect(isPublicPath(`/api/v1/settings/proposal-templates/${UUID}`)).toBe(false);
  });

  it("irmãos que não ganharam porta seguem fora (art15, api-tokens, assinatura); routing/channels entrou no lote 3", () => {
    expect(isPublicPath("/api/v1/settings/routing/channels")).toBe(true);
    expect(isPublicPath("/api/v1/settings/routing/channels/x")).toBe(false);
    expect(isPublicPath("/api/v1/settings/art15")).toBe(false);
    expect(isPublicPath("/api/v1/settings/api-tokens")).toBe(false);
    expect(isPublicPath("/api/v1/settings/assinatura")).toBe(false);
  });

  it("`importar` cai na classe do [slug] (irmão literal): a porta o deixa passar e a rota responde 401 pelo requireRole de sessão", () => {
    // Comportamento real, afirmado de propósito: `importar` não ganha porta própria.
    expect(isPublicPath("/api/v1/settings/proposal-templates/importar")).toBe(true);
  });
});
