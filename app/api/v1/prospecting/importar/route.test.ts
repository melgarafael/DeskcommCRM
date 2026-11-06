// @vitest-environment node
//
// Multipart real (File/FormData) precisa do realm do Node: o jsdom (default do projeto)
// tem File/FormData próprios que o NextRequest não sabe ler — mesmo achado de
// `app/api/v1/products/import/route.test.ts`.
/**
 * Importar planilha de prospecção: só sessão de administrador, organização vinda da
 * autenticação (nunca do formulário), 422 com motivo para arquivo/campo ruim, audit sem o
 * nome do arquivo. O `requireRole` simulado decide pelo PAPEL que a rota pede — se a rota
 * deixasse de pedir `admin`, o caso do administrador falharia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  support: vi.fn(),
  requireRole: vi.fn(),
  validateBearerToken: vi.fn(),
  checkRateLimit: vi.fn(),
  importar: vi.fn(),
  previa: vi.fn(),
  pool: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.requireRole }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: deps.pool }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.checkRateLimit }));
vi.mock("@/lib/mcp/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp/auth")>("@/lib/mcp/auth");
  return { ...actual, validateBearerToken: deps.validateBearerToken };
});
vi.mock("@/lib/prospecting/store", () => ({
  importarPlanilha: deps.importar,
  previaDaPlanilha: deps.previa,
}));

import { POST } from "./route";
import { audit } from "@/lib/audit";
import { montarPrevia, type LeituraComMotivos } from "@/lib/prospecting/importacao-previa";

const ORG_DA_AUTH = "99999999-9999-4999-8999-999999999999";
const ORG_DO_FORMULARIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CAMPANHA = "22222222-2222-4222-8222-222222222222";
const NOME_DO_ARQUIVO = "lista-da-maria-silva.csv";

const CSV_DE_TRES = [
  "empresa;telefone;site",
  "Padaria Um;(11) 99999-0001;https://um.com.br",
  "Padaria Dois;;",
  "Padaria Tres;(11) 99999-0003;",
].join("\n");

function formulario(opcoes: {
  arquivo?: { nome: string; conteudo: string | Uint8Array } | null;
  extras?: Record<string, string>;
  omitir?: string[];
}) {
  const f = new FormData();
  const base: Record<string, string> = {
    request_id: REQUEST_ID,
    name: "Lista da feira",
    niche: "padarias",
    origem_da_lista: "clientes da feira X",
    avaliar_site: "true",
    gerar_previa: "false",
    ...opcoes.extras,
  };
  for (const [k, v] of Object.entries(base)) if (!opcoes.omitir?.includes(k)) f.set(k, v);
  const arq = opcoes.arquivo === undefined ? { nome: NOME_DO_ARQUIVO, conteudo: CSV_DE_TRES } : opcoes.arquivo;
  if (arq) f.set("file", new File([arq.conteudo as BlobPart], arq.nome));
  return f;
}

function post(form: FormData, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/v1/prospecting/importar", {
    method: "POST",
    headers,
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.checkRateLimit.mockResolvedValue({ allowed: true });
  deps.pool.mockReturnValue({});
  deps.requireRole.mockImplementation(async (papel: string) =>
    papel === "admin"
      ? { ok: true, org: { orgId: ORG_DA_AUTH }, user: { id: "user-1", idioma: "pt" } }
      : { ok: false, response: new Response(null, { status: 403 }) },
  );
  // A importação mockada responde como a de verdade: a resposta carrega a MESMA classificação
  // que a prévia faria (o serviço recalcula dentro do lock).
  deps.importar.mockImplementation(
    async (
      _pool: unknown,
      _org: string,
      _requestId: string,
      _campos: unknown,
      planilha: LeituraComMotivos,
    ) => {
      const previa = montarPrevia(planilha, {
        contatos: new Set<string>(),
        suprimidos: new Set<string>(),
      });
      return {
        campaign: { id: CAMPANHA },
        inseridos: previa.entram.length,
        ja_na_base: previa.fora.length,
        classesPuras: { "sem-site": 1 },
        repetida: false,
        fora: previa.fora,
        resumo: previa.resumo,
        total_linhas: previa.total_linhas,
      };
    },
  );
  // A prévia real barata: sem fontes, o que passa é o que a planilha já aceitou.
  deps.previa.mockImplementation(async (_db: unknown, _org: string, planilha: LeituraComMotivos) =>
    montarPrevia(planilha, { contatos: new Set<string>(), suprimidos: new Set<string>() }),
  );
});

describe("POST /api/v1/prospecting/importar", () => {
  it("suporte sem permissão de escrita: devolve o 403 dele e não toca em nada", async () => {
    deps.support.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const res = await POST(post(formulario({})));
    expect(res.status).toBe(403);
    expect(deps.requireRole).not.toHaveBeenCalled();
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("autenticação que falha devolve a resposta dela", async () => {
    deps.requireRole.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await POST(post(formulario({})));
    expect(res.status).toBe(401);
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("quem não é administrador leva 403", async () => {
    deps.requireRole.mockImplementationOnce(async () => ({
      ok: false,
      response: new Response(null, { status: 403 }),
    }));
    const res = await POST(post(formulario({})));
    expect(res.status).toBe(403);
    expect(deps.requireRole).toHaveBeenCalledWith("admin", expect.anything());
  });

  it("token (dsk_) leva 403 e nada é importado", async () => {
    deps.validateBearerToken.mockResolvedValue({
      organizationId: ORG_DA_AUTH,
      scopes: ["mcp:read", "mcp:write"],
      role: "admin",
      actor: { type: "api_token", id: "tok-1" },
      apiTokenId: "tok-1",
    });
    const res = await POST(post(formulario({}), { authorization: "Bearer dsk_abc" }));
    expect(res.status).toBe(403);
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("sem arquivo: 422", async () => {
    const res = await POST(post(formulario({ arquivo: null })));
    expect(res.status).toBe(422);
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it(".pdf: 422", async () => {
    const res = await POST(post(formulario({ arquivo: { nome: "lista.pdf", conteudo: "%PDF" } })));
    expect(res.status).toBe(422);
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("arquivo maior que 2 MB: 422 antes de ler o conteúdo", async () => {
    const grande = new Uint8Array(2 * 1024 * 1024 + 1);
    const res = await POST(post(formulario({ arquivo: { nome: "grande.csv", conteudo: grande } })));
    expect(res.status).toBe(422);
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("corpo declarado grande demais: 422 sem ler o formulário", async () => {
    const req = post(formulario({}), { "content-length": String(3 * 1024 * 1024) });
    const lerFormulario = vi.spyOn(req, "formData");
    const res = await POST(req);
    expect(res.status).toBe(422);
    expect(lerFormulario).not.toHaveBeenCalled();
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("campo obrigatório ausente ou inválido: 422", async () => {
    for (const form of [
      formulario({ omitir: ["origem_da_lista"] }),
      formulario({ extras: { name: "A" } }),
      formulario({ extras: { request_id: "nao-e-uuid" } }),
      formulario({ extras: { avaliar_site: "talvez" } }),
    ]) {
      const res = await POST(post(form));
      expect(res.status).toBe(422);
    }
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("campo a mais no formulário (organization_id) é 422: nada dele vira organização", async () => {
    const res = await POST(post(formulario({ extras: { organization_id: ORG_DO_FORMULARIO } })));
    expect(res.status).toBe(422);
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("CSV de 3 linhas, 1 sem telefone: 200, a organização é a da AUTENTICAÇÃO e a recusada traz a linha", async () => {
    const res = await POST(post(formulario({})));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = await res.json();
    expect(data).toMatchObject({
      campaign_id: CAMPANHA,
      inseridos: 2,
      // `skipped_count` da campanha conta TODA linha lida que não entrou — a recusada da
      // planilha inclusive, como na busca (lá, `items.length - inserted`).
      ja_na_base: 1,
      total_recusadas: 1,
      repetida: false,
    });
    expect(data.recusadas).toEqual([
      { linha: 3, telefone: null, codigo: "sem_telefone", motivo: "Sem telefone." },
    ]);

    expect(deps.importar).toHaveBeenCalledTimes(1);
    const [, org, requestId, campos, planilha] = deps.importar.mock.calls[0]!;
    expect(org).toBe(ORG_DA_AUTH);
    expect(requestId).toBe(REQUEST_ID);
    expect(campos).toMatchObject({
      name: "Lista da feira",
      niche: "padarias",
      origem_da_lista: "clientes da feira X",
      avaliar_site: true,
      gerar_previa: false,
      linhas: 3,
    });
    expect(campos).not.toHaveProperty("arquivo");
    // O quinto argumento é a PLANILHA lida (candidato + linha), não a lista solta: a importação
    // precisa da linha para classificar contato/LGPD e devolver o motivo.
    expect(planilha.candidatos.map((c: { prospect: { phone: string } }) => c.prospect.phone)).toEqual([
      "+5511999990001",
      "+5511999990003",
    ]);
    expect(planilha.candidatos.map((c: { linha: number }) => c.linha)).toEqual([2, 4]);
  });

  it("gerar_previa sem avaliar_site vira false", async () => {
    await POST(post(formulario({ extras: { avaliar_site: "false", gerar_previa: "true" } })));
    expect(deps.importar.mock.calls[0]![3]).toMatchObject({ avaliar_site: false, gerar_previa: false });
  });

  it("audita uma vez, com contagens e SEM o nome do arquivo", async () => {
    await POST(post(formulario({})));
    expect(audit).toHaveBeenCalledTimes(1);
    const chamada = vi.mocked(audit).mock.calls[0]![0];
    expect(chamada).toMatchObject({
      action: "prospecting.changed",
      organizationId: ORG_DA_AUTH,
      actorUserId: "user-1",
      resourceType: "prospecting",
      resourceId: CAMPANHA,
      metadata: {
        operation: "importar_planilha",
        linhas: 3,
        inseridos: 2,
        ja_na_base: 1,
        recusadas: 1,
        motivos: { sem_telefone: 1 },
        classes_puras: { "sem-site": 1 },
      },
    });
    const texto = JSON.stringify(chamada);
    expect(texto).not.toContain(NOME_DO_ARQUIVO);
    expect(texto).not.toContain("maria");
    expect(texto).not.toContain("Padaria");
  });

  it("envio repetido (repetida: true) não audita", async () => {
    deps.importar.mockResolvedValueOnce({
      campaign: { id: CAMPANHA },
      inseridos: 2,
      ja_na_base: 0,
      classesPuras: {},
      repetida: true,
      fora: [],
      resumo: {},
      total_linhas: 2,
    });
    const res = await POST(post(formulario({})));
    expect(res.status).toBe(200);
    expect((await res.json()).data.repetida).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  it("nenhuma linha válida: 422 com as recusadas em details", async () => {
    const res = await POST(
      post(
        formulario({
          arquivo: { nome: "vazia.csv", conteudo: "empresa;telefone\nSem Fone;\nOutra;123\n" },
        }),
      ),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details.total_recusadas).toBe(2);
    expect(body.error.details.recusadas[0]).toEqual({
      linha: 2,
      telefone: null,
      codigo: "sem_telefone",
      motivo: "Sem telefone.",
    });
    expect(body.error.details.resumo.sem_telefone).toBe(1);
    expect(body.error.details.resumo.telefone_invalido).toBe(1);
    expect(deps.importar).not.toHaveBeenCalled();
  });

  it("planilha sem coluna de telefone: 422 com as colunas encontradas", async () => {
    const res = await POST(
      post(formulario({ arquivo: { nome: "x.csv", conteudo: "empresa;cidade\nA Ltda;Rio\n" } })),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("empresa, cidade");
  });

  it("mais de 500 linhas: 422 e nada é gravado", async () => {
    const linhas = Array.from({ length: 501 }, (_, i) => `Empresa ${i};(11) 9${String(i).padStart(4, "0")}-0000`);
    const res = await POST(
      post(formulario({ arquivo: { nome: "grande.csv", conteudo: ["empresa;telefone", ...linhas].join("\n") } })),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("500");
    expect(deps.importar).not.toHaveBeenCalled();
  });
});

/**
 * A PRÉVIA — `previa=true` no mesmo formulário. Ela existe porque a planilha do operador não é
 * uma lista limpa: ele precisa ver, ANTES de criar campanha, quantas linhas entram e por que
 * cada uma das outras fica de fora. O contrato é este: conferir não escreve, não audita e não
 * cria campanha.
 */
describe("POST /api/v1/prospecting/importar — prévia", () => {
  it("previa=true confere e devolve as contagens SEM importar nem auditar", async () => {
    const res = await POST(post(formulario({ extras: { previa: "true" } })));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      previa: true,
      entram: 2,
      total_recusadas: 1,
      total_linhas: 3,
    });
    expect(data).not.toHaveProperty("campaign_id");
    expect(data.resumo.sem_telefone).toBe(1);
    expect(deps.importar).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("a prévia traz o motivo de cada linha: contato do CRM e supressão da LGPD", async () => {
    deps.previa.mockImplementationOnce(
      async (_db: unknown, _org: string, planilha: LeituraComMotivos) =>
        montarPrevia(planilha, {
          contatos: new Set(["+5511999990001"]),
          suprimidos: new Set(["+5511999990003"]),
        }),
    );
    const res = await POST(post(formulario({ extras: { previa: "true" } })));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.entram).toBe(0);
    expect(data.total_recusadas).toBe(3);
    expect(data.recusadas).toEqual([
      { linha: 2, telefone: "+5511999990001", codigo: "contato_do_crm", motivo: "Já é contato do CRM." },
      { linha: 3, telefone: null, codigo: "sem_telefone", motivo: "Sem telefone." },
      {
        linha: 4,
        telefone: "+5511999990003",
        codigo: "suprimido_lgpd",
        motivo: "Excluído a pedido do titular (LGPD).",
      },
    ]);
    expect(data.resumo).toMatchObject({ contato_do_crm: 1, suprimido_lgpd: 1 });
  });

  it("importação de verdade: se nada pode entrar, 422 com o motivo de cada linha", async () => {
    deps.previa.mockImplementationOnce(
      async (_db: unknown, _org: string, planilha: LeituraComMotivos) =>
        montarPrevia(planilha, {
          contatos: new Set<string>(),
          suprimidos: new Set(["+5511999990001", "+5511999990003"]),
        }),
    );
    const res = await POST(post(formulario({})));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details.recusadas[0].codigo).toBe("suprimido_lgpd");
    expect(deps.importar).not.toHaveBeenCalled();
  });
});
