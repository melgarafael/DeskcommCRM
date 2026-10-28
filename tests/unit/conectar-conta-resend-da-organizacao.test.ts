/**
 * `conectarContaResendDaOrganizacao` (#3287, fatia da conta própria).
 *
 * O que este arquivo prova:
 *
 *   1. a chave é CIFRADA antes de gravar — o payload gravado NUNCA contém a
 *      chave em claro, e decifra de volta (critério D);
 *   2. domínio NÃO verificado na conta → recusa com o MOTIVO próprio
 *      (`dominio_nao_verificado` + o domínio), e NADA é gravado (critério E);
 *   3. a trilha de auditoria nunca leva a chave nem o endereço (critério D);
 *   4. as portas (papel, MFA) e a catraca "nada gravado = erro" seguem iguais à
 *      action da marca.
 *
 * A SDK `resend` é mockada (a verificação de domínio fala com o dupe), e a
 * chave que circula é FIXTURE — chave real de Resend nenhuma entra aqui.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

const { listMock, upsertMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  upsertMock: vi.fn(),
}));

vi.mock("resend", () => ({
  // `function` (não arrow) para ser CONSTRUÍVEL: a verificação faz `new Resend(...)`.
  Resend: vi.fn(function () {
    return { domains: { list: listMock }, emails: { send: vi.fn() } };
  }),
}));

import { conectarContaResendDaOrganizacao, desconectarContaResendDaOrganizacao } from "@/app/actions/settings/conectarContaResendDaOrganizacao";
import { decryptKey, byteaToBuffer } from "@/lib/crypto/aes_gcm";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn(), mfaEmDivida: vi.fn() }));
vi.mock("@/lib/auth/pode-administrar-empresa", () => ({ podeAdministrarEmpresa: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: vi.fn(() => false) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ "x-request-id": "req-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/http/ip-do-cliente", () => ({ ipDoCliente: vi.fn(() => "10.0.0.1") }));

const CHAVE_ORG = "re_org_key_1234567890";
const INPUT = { api_key: CHAVE_ORG, from_email: "contato@lojadaana.com" };

/** Admin client dupe: o `upsert(...).select()` devolve o que o teste mandar. */
function adminClient(upsertResultado: { data: unknown; error: unknown }) {
  const cadeia = { upsert: upsertMock };
  upsertMock.mockReturnValue({ select: async () => upsertResultado });
  return { from: () => cadeia } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({
    data: { data: [{ name: "lojadaana.com", status: "verified" }] },
    error: null,
  });
  // Porta ABERTA por padrão: um teste de porta fecha só o que importa.
  vi.mocked(loadAuthUser).mockResolvedValue({ id: "user-1", support: null } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: "org-1", role: "admin" } as never);
  vi.mocked(podeAdministrarEmpresa).mockReturnValue(true as never);
  vi.mocked(mfaEmDivida).mockResolvedValue(false as never);
});

describe("conectarContaResendDaOrganizacao", () => {
  it("grava a chave CIFRADA — nunca em claro — e decifra de volta (critério D)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminClient({ data: [{ organization_id: "org-1" }], error: null }));

    const r = await conectarContaResendDaOrganizacao(INPUT);
    expect(r).toEqual({ ok: true });

    const payload = upsertMock.mock.calls[0]![0];
    // A chave em claro NUNCA entra na gravação.
    expect(JSON.stringify(payload)).not.toContain(CHAVE_ORG);
    // O ciphertext, cifrado, decifra de volta para a chave da organização.
    const decifrada = decryptKey({
      ciphertext: byteaToBuffer(payload.api_key_ciphertext),
      iv: byteaToBuffer(payload.api_key_iv),
      tag: byteaToBuffer(payload.api_key_tag),
    });
    expect(decifrada).toBe(CHAVE_ORG);
    // O `last4` é o que a tela usa para identificar — sem a chave.
    expect(payload.api_key_last4).toBe("7890");
    expect(payload.from_email).toBe("contato@lojadaana.com");
    expect(payload.organization_id).toBe("org-1");
  });

  it("a trilha de auditoria NÃO leva a chave nem o endereço (critério D)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminClient({ data: [{ organization_id: "org-1" }], error: null }));
    await conectarContaResendDaOrganizacao(INPUT);
    const meta = vi.mocked(audit).mock.calls[0]![0].metadata;
    expect(JSON.stringify(meta)).not.toContain(CHAVE_ORG);
    expect(JSON.stringify(meta)).not.toContain("lojadaana.com");
    expect(meta).toMatchObject({ dominio_verificado: true });
  });

  it("domínio NÃO verificado → recusa com motivo próprio e NADA é gravado (critério E)", async () => {
    listMock.mockResolvedValue({
      data: { data: [{ name: "lojadaana.com", status: "pending" }] },
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue(adminClient({ data: [], error: null }));

    const r = await conectarContaResendDaOrganizacao(INPUT);
    expect(r).toEqual({ ok: false, error: "dominio_nao_verificado", details: "lojadaana.com" });
    // Nada foi gravado: nem upsert, nem auditoria.
    expect(upsertMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("chave recusada pela Resend → `chave_recusada`, sem gravar", async () => {
    listMock.mockResolvedValue({ data: null, error: { name: "validation_error", message: "bad" } });
    vi.mocked(createAdminClient).mockReturnValue(adminClient({ data: [], error: null }));
    const r = await conectarContaResendDaOrganizacao(INPUT);
    expect(r).toEqual({ ok: false, error: "chave_recusada" });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("endereço torto é recusa de validação, antes de qualquer chamada", async () => {
    const r = await conectarContaResendDaOrganizacao({ api_key: CHAVE_ORG, from_email: "nao-e-endereco" });
    expect(r.ok).toBe(false);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("gravação que não casou linha é `nao_gravou` — a tela não pode dizer conectada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminClient({ data: [], error: null }));
    const r = await conectarContaResendDaOrganizacao(INPUT);
    expect(r).toEqual({ ok: false, error: "nao_gravou" });
  });

  it("erro bruto de gravação não volta ao navegador com conteúdo da credencial", async () => {
    vi.mocked(createAdminClient).mockReturnValue(adminClient({ data: null, error: { message: `invalid bytea ${CHAVE_ORG}` } }));
    const r = await conectarContaResendDaOrganizacao(INPUT);
    expect(r).toEqual({ ok: false, error: "db_error" });
    expect(JSON.stringify(r)).not.toContain(CHAVE_ORG);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem papel de admin é `forbidden_role`, e nada é gravado", async () => {
    vi.mocked(podeAdministrarEmpresa).mockReturnValue(false as never);
    const r = await conectarContaResendDaOrganizacao(INPUT);
    expect(r).toEqual({ ok: false, error: "forbidden_role" });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("MFA em dívida é `mfa_required`", async () => {
    vi.mocked(mfaEmDivida).mockResolvedValue(true as never);
    const r = await conectarContaResendDaOrganizacao(INPUT);
    expect(r).toEqual({ ok: false, error: "mfa_required" });
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("desconectarContaResendDaOrganizacao", () => {
  it("apaga a linha da organização e audita", async () => {
    const deleteMock = vi.fn(async () => ({ error: null }));
    vi.mocked(createAdminClient).mockReturnValue({ from: () => ({ delete: () => ({ eq: deleteMock }) }) } as never);
    const r = await desconectarContaResendDaOrganizacao();
    expect(r).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith("organization_id", "org-1");
    expect(audit).toHaveBeenCalled();
  });

  it("erro bruto de exclusão não volta ao navegador", async () => {
    const deleteMock = vi.fn(async () => ({ error: { message: `database detail ${CHAVE_ORG}` } }));
    vi.mocked(createAdminClient).mockReturnValue({ from: () => ({ delete: () => ({ eq: deleteMock }) }) } as never);
    const r = await desconectarContaResendDaOrganizacao();
    expect(r).toEqual({ ok: false, error: "db_error" });
    expect(JSON.stringify(r)).not.toContain(CHAVE_ORG);
    expect(deleteMock).toHaveBeenCalledWith("organization_id", "org-1");
    expect(audit).not.toHaveBeenCalled();
  });
});
