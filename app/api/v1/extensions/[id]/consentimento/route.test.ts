import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";

/**
 * O consentimento por área de um módulo `connected` (spec 33, F3, tarefa 5).
 *
 * O que este arquivo prova, com o serviço REAL e só a autorização, o banco e a auditoria substituídos:
 * - quem administra a organização grava, e a organização que chega à função é a da SESSÃO, nunca a do
 *   corpo (que, por ser estrito, nem aceita o campo);
 * - manager e agent são recusados pela autorização ANTES de qualquer efeito (a rota pede `admin`);
 * - os códigos do banco viram a frase e o status do mapa (`area_not_declared`, `area_requires_admin`,
 *   `revision_conflict`, `not_activated`), inclusive os que chegam como `PT409`;
 * - o aviso de suporte e a organização trocada em outra aba recusam sem gravar;
 * - a auditoria leva só a lista fechada de áreas e a revisão.
 */

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  suporte: null as unknown,
  rpc: vi.fn(),
  audit: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => mocks.suporte }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => null,
  mfaEmDividaEstrita: async () => false,
  sessionAal: async () => "aal2",
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit, auditForOrganizations: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: mocks.warn, error: mocks.error, info: vi.fn() },
}));

const ADMIN = randomUUID();
const ORG = randomUUID();
const OUTRA_ORG = randomUUID();
const INSTALACAO = randomUUID();

const contexto = { params: Promise.resolve({ id: INSTALACAO }) };

function sessaoDeAdmin(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    user: { id: ADMIN, support: null, idioma: "pt-BR", ...overrides },
    org: { orgId: ORG, role: "admin" },
  };
}

function pedido(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/v1/extensions/${INSTALACAO}/consentimento`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "X-Expected-Organization-Id": ORG,
      ...headers,
    },
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });
}

function salvou(areas: string[], revision = 4) {
  return {
    data: {
      organization_extension: { installation_id: INSTALACAO, revision, consented_areas: areas },
    },
    error: null,
  };
}

type Resposta = {
  data?: { installation_id: string; revision: number; consented_areas: string[] };
  error?: { code: string; message: string };
};

async function enviar(corpo: unknown, headers: Record<string, string> = {}) {
  const { PUT } = await import("./route");
  const res = await PUT(pedido(corpo, headers), contexto);
  return { res, corpo: (await res.json()) as Resposta };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.suporte = null;
  mocks.requireRole.mockResolvedValue(sessaoDeAdmin());
  mocks.rpc.mockResolvedValue(salvou(["area.contatos.leitura"]));
});

describe("PUT /api/v1/extensions/[id]/consentimento", () => {
  it("o admin consente: a função recebe a organização da sessão, o ator e a revisão esperada", async () => {
    const { res, corpo } = await enviar({
      expected_revision: 3,
      areas: ["area.contatos.leitura"],
    });
    expect(res.status).toBe(200);
    expect(corpo.data).toEqual({
      installation_id: INSTALACAO,
      revision: 4,
      consented_areas: ["area.contatos.leitura"],
    });
    expect(mocks.requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_extensions_set_consent", {
      p_actor: ADMIN,
      p_organization: ORG,
      p_installation: INSTALACAO,
      p_expected_revision: 3,
      p_areas: ["area.contatos.leitura"],
    });
  });

  it("retirar tudo é válido: lista vazia vai à função", async () => {
    mocks.rpc.mockResolvedValue(salvou([]));
    const { res } = await enviar({ expected_revision: 4, areas: [] });
    expect(res.status).toBe(200);
    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_areas: [] });
  });

  it("a auditoria leva só as áreas e a revisão, na organização da sessão", async () => {
    await enviar({ expected_revision: 3, areas: ["area.contatos.leitura"] });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith({
      action: "extension.consent_changed",
      actorUserId: ADMIN,
      organizationId: ORG,
      resourceType: "extension_installation",
      resourceId: INSTALACAO,
      metadata: { areas: ["area.contatos.leitura"], revision: 4 },
    });
  });

  it("manager e agent: a autorização recusa e nada é gravado nem auditado", async () => {
    mocks.requireRole.mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Seu papel não permite esta ação.", 403),
    });
    const { res, corpo } = await enviar({ expected_revision: 3, areas: ["area.contatos.leitura"] });
    expect(res.status).toBe(403);
    expect(corpo.error?.code).toBe("forbidden_role");
    expect(mocks.requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("área que o pacote não declarou: 409 com a frase do mapa (o banco responde PT409)", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "extension_area_not_declared" },
    });
    const { res, corpo } = await enviar({ expected_revision: 3, areas: ["area.analise.leitura"] });
    expect(res.status).toBe(409);
    expect(corpo.error?.code).toBe("extension_area_not_declared");
    expect(corpo.error?.message).toContain("não declarou");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("configuração por quem não é admin da organização: 409 area_requires_admin", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "extension_area_requires_admin" },
    });
    const { res, corpo } = await enviar({
      expected_revision: 3,
      areas: ["area.configuracao.leitura"],
    });
    expect(res.status).toBe(409);
    expect(corpo.error?.code).toBe("extension_area_requires_admin");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("conflito de revisão: 409 extension_revision_conflict e nada auditado", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "extension_revision_conflict" },
    });
    const { res, corpo } = await enviar({ expected_revision: 1, areas: ["area.contatos.leitura"] });
    expect(res.status).toBe(409);
    expect(corpo.error?.code).toBe("extension_revision_conflict");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("módulo ainda não ativado nesta organização: 409 extension_not_activated", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "extension_not_activated" },
    });
    const { res, corpo } = await enviar({ expected_revision: 0, areas: ["area.contatos.leitura"] });
    expect(res.status).toBe(409);
    expect(corpo.error?.code).toBe("extension_not_activated");
  });

  it("erro de banco desconhecido: 503 genérico, sem vazar a mensagem", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "relation secreta nao existe" },
    });
    const { res, corpo } = await enviar({ expected_revision: 1, areas: ["area.contatos.leitura"] });
    expect(res.status).toBe(503);
    expect(JSON.stringify(corpo)).not.toContain("secreta");
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("o corpo não escolhe a organização nem aceita campo extra: 422 sem efeito", async () => {
    const { res } = await enviar({
      expected_revision: 3,
      areas: ["area.contatos.leitura"],
      organization_id: OUTRA_ORG,
    });
    expect(res.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("permissão fora do vocabulário de área é recusada antes do banco", async () => {
    for (const areas of [
      ["area.financeiro.escrita"],
      ["navigation.tasks"],
      ["area.contatos.leitura", 7],
      "area.contatos.leitura",
    ]) {
      const { res } = await enviar({ expected_revision: 3, areas });
      expect(res.status).toBe(422);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("revisão ausente ou negativa: 422", async () => {
    expect((await enviar({ areas: [] })).res.status).toBe(422);
    expect((await enviar({ expected_revision: -1, areas: [] })).res.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("organização trocada em outra aba: 409 extension_context_changed, sem gravar", async () => {
    const { res, corpo } = await enviar(
      { expected_revision: 3, areas: ["area.contatos.leitura"] },
      { "X-Expected-Organization-Id": OUTRA_ORG },
    );
    expect(res.status).toBe(409);
    expect(corpo.error?.code).toBe("extension_context_changed");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("sem o cabeçalho da organização: 400", async () => {
    const { PUT } = await import("./route");
    const semCabecalho = new Request(`http://localhost/api/v1/extensions/${INSTALACAO}/consentimento`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 3, areas: [] }),
    });
    const res = await PUT(semCabecalho, contexto);
    expect(res.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("acompanhamento de suporte: a guarda de escrita recusa antes de tudo", async () => {
    mocks.suporte = fail("support_read_only", "Acompanhamento só leitura.", 403);
    const { res } = await enviar({ expected_revision: 3, areas: ["area.contatos.leitura"] });
    expect(res.status).toBe(403);
    expect(mocks.requireRole).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("sessão de suporte com escrita liberada ainda não consente", async () => {
    mocks.requireRole.mockResolvedValue(sessaoDeAdmin({ support: { id: randomUUID() } }));
    const { res } = await enviar({ expected_revision: 3, areas: ["area.contatos.leitura"] });
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("identificador de instalação inválido: 404", async () => {
    const { PUT } = await import("./route");
    const res = await PUT(pedido({ expected_revision: 3, areas: [] }), {
      params: Promise.resolve({ id: "nao-e-uuid" }),
    });
    expect(res.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
