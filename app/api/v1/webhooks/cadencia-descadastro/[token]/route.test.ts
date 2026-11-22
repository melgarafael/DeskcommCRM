import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signCadenciaLink } from "@/lib/cadencias/token";
import { GET, HEAD, POST } from "./route";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), falha: vi.fn(), limitado: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/auth/rate-limit", () => ({ tokenFailureLimited: mocks.limitado, registrarFalhaDeToken: mocks.falha }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

const destinatario = { destinatario_id: "00000000-0000-4000-8000-000000000001" };
const ORG = "00000000-0000-4000-8000-000000000002";
const abertura = {
  enrollment_id: "00000000-0000-4000-8000-000000000005",
  organization_id: ORG,
  cadence_id: "00000000-0000-4000-8000-000000000003",
  lead_id: "00000000-0000-4000-8000-000000000004",
  passo_id: "email-1",
};
const gravado = (suprimido_agora: boolean, inscricoes_paradas: number) => ({ data: { organization_id: ORG, suprimido_agora, inscricoes_paradas }, error: null });
const req = {} as NextRequest;
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  vi.stubEnv("INTERNAL_SECRET", "segredo-sintetico-da-prova-cadencias");
  mocks.rpc.mockReset().mockResolvedValue(gravado(true, 1));
  mocks.falha.mockReset();
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.limitado.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("descadastro: só o POST muda estado", () => {
  it("GET mostra o botão de confirmar, sem chamar a RPC e sem dado da inscrição", async () => {
    const token = signCadenciaLink(destinatario, "descadastro");
    const r = await GET(req, ctx(token));
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(html).toMatch(/<form method="post">/);
    expect(html).toContain("Confirmar descadastro");
    expect(html).not.toContain(token);
    expect(html).not.toContain(destinatario.destinatario_id);
  });
  it("HEAD é explícito, vazio e não chama a RPC", async () => {
    const r = await HEAD();
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("POST sem cookie descadastra pelo destinatário do token, e só por ele", async () => {
    const r = await POST(req, ctx(signCadenciaLink(destinatario, "descadastro")));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("não vai mais receber");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_cadencia_descadastrar", { p_destinatario_id: destinatario.destinatario_id });
  });
  it("POST com token do pixel, ou com o corpo trocado sob a assinatura, é recusado e conta falha", async () => {
    const assinatura = signCadenciaLink(destinatario, "descadastro").split(".")[1];
    const outra = Buffer.from(JSON.stringify({ destinatario_id: "00000000-0000-4000-8000-000000000009", finalidade: "descadastro" })).toString("base64url");
    for (const token of [signCadenciaLink(abertura, "abertura"), `${outra}.${assinatura}`]) {
      expect((await POST(req, ctx(token))).status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.falha).toHaveBeenCalledTimes(2);
  });
  it("GET com token inválido não oferece o botão", async () => {
    const r = await GET(req, ctx("nao.vale"));
    expect(await r.text()).not.toContain("<form");
    expect(mocks.falha).toHaveBeenCalledTimes(1);
  });
  it("falha de escrita não afirma que saiu: 503 para o provedor tentar de novo", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "sintetico" } });
    const r = await POST(req, ctx(signCadenciaLink(destinatario, "descadastro")));
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("não vai mais receber");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("destinatário que não existe mais (a RPC devolve null) não afirma que saiu", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const r = await POST(req, ctx(signCadenciaLink(destinatario, "descadastro")));
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("não vai mais receber");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("descadastro: auditoria", () => {
  it("o POST que para inscrições grava uma linha lgpd.consent_changed, na empresa do destinatário, sem dado pessoal", async () => {
    mocks.rpc.mockResolvedValue(gravado(true, 2));
    await POST(req, ctx(signCadenciaLink(destinatario, "descadastro")));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const linha = mocks.audit.mock.calls[0]?.[0];
    expect(linha).toEqual({
      action: "lgpd.consent_changed",
      organizationId: ORG,
      resourceType: "email_cadence_recipient",
      resourceId: destinatario.destinatario_id,
      bypassedRls: true,
      metadata: { canal: "email_cadencia", consentimento: "revogado", origem: "link_descadastro", inscricoes_paradas: 2 },
    });
    expect(linha).not.toHaveProperty("ip");
    expect(linha).not.toHaveProperty("userAgent");
  });
  it("supressão nova sem inscrição a parar (negócio já apagado) também audita", async () => {
    mocks.rpc.mockResolvedValue(gravado(true, 0));
    const r = await POST(req, ctx(signCadenciaLink(destinatario, "descadastro")));
    expect(r.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
  it("o POST repetido (nada mudou) responde igual e não grava segunda linha", async () => {
    mocks.rpc.mockResolvedValue(gravado(false, 0));
    const r = await POST(req, ctx(signCadenciaLink(destinatario, "descadastro")));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("não vai mais receber");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
