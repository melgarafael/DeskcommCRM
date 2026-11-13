/**
 * A ROTA DO GATEWAY DA ORGANIZAÇÃO — issue #4058, fatia 1.
 *
 * O que se prova aqui, e não no teste do resolvedor:
 *
 *  - o GET devolve o ESTADO (provedor, modo, last4) e o corpo serializado NÃO
 *    contém a chave — nem a da organização, nem a da instalação herdada;
 *  - papel sem permissão recebe a recusa NOMEADA que o `requireRole` devolve
 *    (`forbidden_role`), não um 500;
 *  - a guarda de acompanhamento (`requireSupportWrite`) roda ANTES do RBAC:
 *    quem só acompanha a organização não troca a conta que recebe o dinheiro;
 *  - erro do provedor sai como 422 nomeado (`invalid_provider_key`) e nada é
 *    gravado — nunca 500 mudo;
 *  - o PUT valida a chave no provedor com a chave DA ORGANIZAÇÃO.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  admin: vi.fn(),
  audit: vi.fn(),
  provedorDaInstalacao: vi.fn(),
  chaveDoProvedor: vi.fn(),
  segredoDoWebhook: vi.fn(),
  adaptador: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/cobranca/configuracao", () => ({
  provedorDaInstalacao: deps.provedorDaInstalacao,
  chaveDoProvedor: deps.chaveDoProvedor,
  segredoDoWebhook: deps.segredoDoWebhook,
}));
vi.mock("@/lib/cobranca/provedores", () => ({ adaptador: deps.adaptador }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: (plaintext: string) => ({
    ciphertext: Buffer.from(plaintext, "utf8"),
    iv: Buffer.from("iv", "utf8"),
    tag: Buffer.from("tag", "utf8"),
    last4: plaintext.slice(-4),
  }),
  decryptKey: ({ ciphertext }: { ciphertext: Buffer }) => ciphertext.toString("utf8"),
  byteaToBuffer: (value: string) => Buffer.from(String(value), "utf8"),
  bufToBytea: (buf: Buffer) => buf.toString("utf8"),
}));

import { DELETE, GET, PUT } from "./route";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CHAVE_DA_INSTALACAO = "$aact_hmlg_instalacao000000";
const CHAVE_NOVA = "$aact_prod_organizacao0000000";

type Linha = Record<string, unknown>;

/** Tabela em memória com as cadeias que a rota percorre. */
function banco(linhas: Linha[] = []) {
  const estado = { linhas: [...linhas], upserts: [] as Linha[], apagou: false };
  const client = {
    from: () => ({
      select: () => ({
        eq: (coluna: string, valor: unknown) => ({
          maybeSingle: async () => ({
            data: estado.linhas.find((l) => l[coluna] === valor) ?? null,
            error: null,
          }),
        }),
      }),
      upsert: async (payload: Linha) => {
        estado.upserts.push(payload);
        const idx = estado.linhas.findIndex((l) => l.organization_id === payload.organization_id);
        if (idx >= 0) estado.linhas[idx] = { ...estado.linhas[idx], ...payload };
        else estado.linhas.push(payload);
        return { error: null };
      },
      update: (payload: Linha) => ({
        eq: (coluna: string, valor: unknown) => {
          const alvo = estado.linhas.filter((l) => l[coluna] === valor);
          for (const l of alvo) Object.assign(l, payload);
          return {
            select: async () => ({ data: alvo.map((l) => ({ organization_id: l.organization_id })), error: null }),
          };
        },
      }),
      delete: () => {
        estado.apagou = true;
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  return { client, estado };
}

function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

function pedido(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/pagamentos/gateway", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.audit.mockResolvedValue(undefined);
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  });
  deps.provedorDaInstalacao.mockResolvedValue("asaas");
  deps.chaveDoProvedor.mockResolvedValue(CHAVE_DA_INSTALACAO);
  deps.segredoDoWebhook.mockResolvedValue("segredo-da-instalacao-1234");
});

describe("GET /api/v1/pagamentos/gateway", () => {
  it("org sem configuração: devolve a herança e o corpo NÃO traz a chave da instalação", async () => {
    const { client } = banco([]);
    deps.admin.mockReturnValue(client);

    const res = await GET();
    const corpo = await json(res);

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({ origem: "instalacao", provider: "asaas", apiKeyLast4: null });
    const serializado = JSON.stringify(corpo);
    expect(serializado).not.toContain(CHAVE_DA_INSTALACAO);
    expect(serializado).not.toContain("segredo-da-instalacao-1234");
    // O role pedido é o de LEITURA da tela, não o de escrita.
    expect(deps.role).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "organization_payment_gateways" }));
  });

  it("papel insuficiente: a recusa nomeada do requireRole é repassada (não vira 500)", async () => {
    deps.role.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role", message: "Permissão insuficiente." } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    });

    const res = await GET();
    const corpo = await json(res);

    expect(res.status).toBe(403);
    expect((corpo.error as { code: string }).code).toBe("forbidden_role");
    expect(deps.admin).not.toHaveBeenCalled();
  });
});

describe("PUT /api/v1/pagamentos/gateway", () => {
  it("grava com a chave DA ORGANIZAÇÃO e devolve estado sem segredo", async () => {
    const { client, estado } = banco([]);
    deps.admin.mockReturnValue(client);
    const testarChave = vi.fn().mockResolvedValue({ ok: true, modo: "producao" });
    deps.adaptador.mockReturnValue({ testarChave });

    const res = await PUT(
      pedido({ provider: "asaas", api_key: CHAVE_NOVA, webhook_secret: "whsec_da_org_9999" }),
    );
    const corpo = await json(res);

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({ origem: "organizacao", provider: "asaas", modo: "producao" });
    const serializado = JSON.stringify(corpo);
    expect(serializado).not.toContain(CHAVE_NOVA);
    expect(serializado).not.toContain("whsec_da_org_9999");

    expect(estado.upserts[0]).toMatchObject({ organization_id: ORG, provider: "asaas", mode: "producao" });
  });

  it("chave recusada pelo provedor = 422 nomeado, nada gravado", async () => {
    const { client, estado } = banco([]);
    deps.admin.mockReturnValue(client);
    deps.adaptador.mockReturnValue({ testarChave: vi.fn().mockResolvedValue({ ok: false, motivo: "chave_invalida" }) });

    const res = await PUT(pedido({ provider: "asaas", api_key: CHAVE_NOVA }));
    const corpo = await json(res);

    expect(res.status).toBe(422);
    expect((corpo.error as { code: string }).code).toBe("invalid_provider_key");
    expect(estado.upserts).toHaveLength(0);
  });

  it("provedor fora = 502 nomeado (não 500 mudo)", async () => {
    const { client } = banco([]);
    deps.admin.mockReturnValue(client);
    deps.adaptador.mockReturnValue({ testarChave: vi.fn().mockResolvedValue({ ok: false, motivo: "provedor_fora" }) });

    const res = await PUT(pedido({ provider: "asaas", api_key: CHAVE_NOVA }));
    const corpo = await json(res);

    expect(res.status).toBe(502);
    expect((corpo.error as { code: string }).code).toBe("provider_unavailable");
  });

  it("primeira configuração sem chave = 422 `credential_required`", async () => {
    const { client } = banco([]);
    deps.admin.mockReturnValue(client);

    const res = await PUT(pedido({ provider: "asaas" }));
    const corpo = await json(res);

    expect(res.status).toBe(422);
    expect((corpo.error as { code: string }).code).toBe("credential_required");
    expect(deps.adaptador).not.toHaveBeenCalled();
  });

  it("body inválido = 422 `validation_failed`", async () => {
    deps.admin.mockReturnValue(banco([]).client);

    const res = await PUT(pedido({ provider: "pagseguro", api_key: CHAVE_NOVA }));
    const corpo = await json(res);

    expect(res.status).toBe(422);
    expect((corpo.error as { code: string }).code).toBe("validation_failed");
  });

  it("acompanhamento somente leitura é recusado ANTES do RBAC e da escrita", async () => {
    const recusa = new Response(JSON.stringify({ error: { code: "forbidden", message: "O acompanhamento terminou." } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    deps.support.mockResolvedValue(recusa);

    const res = await PUT(pedido({ provider: "asaas", api_key: CHAVE_NOVA }));

    expect(res.status).toBe(403);
    expect(deps.role).not.toHaveBeenCalled();
    expect(deps.admin).not.toHaveBeenCalled();
  });

  it("papel sem permissão de escrita: `forbidden_role`, sem tocar no provedor", async () => {
    deps.role.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role", message: "Permissão insuficiente." } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    });

    const res = await PUT(pedido({ provider: "asaas", api_key: CHAVE_NOVA }));

    expect(res.status).toBe(403);
    expect(deps.adaptador).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/pagamentos/gateway", () => {
  it("desliga sem apagar a credencial e volta a herdar", async () => {
    const { client, estado } = banco([
      {
        organization_id: ORG,
        provider: "asaas",
        mode: "producao",
        api_key_encrypted: CHAVE_NOVA,
        api_key_iv: "iv",
        api_key_tag: "tag",
        api_key_last4: "0000",
        webhook_secret_encrypted: null,
        webhook_secret_iv: null,
        webhook_secret_tag: null,
        webhook_secret_last4: null,
        is_active: true,
      },
    ]);
    deps.admin.mockReturnValue(client);

    const res = await DELETE();
    const corpo = await json(res);

    expect(res.status).toBe(200);
    expect(estado.apagou).toBe(false);
    expect(estado.linhas[0]).toMatchObject({ is_active: false, api_key_encrypted: CHAVE_NOVA });
    expect(corpo.data).toMatchObject({ origem: "instalacao", isActive: false, configurada: true });
  });
});
