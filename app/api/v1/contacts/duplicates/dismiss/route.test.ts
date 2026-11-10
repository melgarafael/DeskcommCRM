/**
 * POST /api/v1/contacts/duplicates/dismiss — "Não são a mesma empresa" (Spec 31, PR A).
 *
 * O helper de gravação (`dispensarParDeContatos`) é mockado aqui: quem prova a trava,
 * o filtro de organização e a idempotência de verdade é `tests/invariants/`, com
 * Postgres. Esta suíte prova a PORTA: quem pode, o que valida, o que audita e de
 * qual organização a gravação parte.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { dispensarParDeContatos } from "@/lib/contacts/dispensar-par";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/contacts/dispensar-par", () => ({ dispensarParDeContatos: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_SESSAO = "22222222-2222-4222-8222-222222222222";
const ORG_OUTRA = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/contacts/duplicates/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

async function chamar(corpo: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(pedido(corpo));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_SESSAO, name: "Org" } as never,
  });
  vi.mocked(dispensarParDeContatos).mockResolvedValue({ ok: true, criada: true, candidatos: [A, B] });
});

describe("POST /contacts/duplicates/dismiss: quem pode e o que é validado", () => {
  it("sem papel de gestor → 403, e a dispensa nem é tentada", async () => {
    // Sabotagem: trocar `requireRole("manager")` por nada deixa este caso vermelho.
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: Response.json(
        { error: { code: "forbidden_role", message: "Juntar contatos exige papel de gerente ou acima." } },
        { status: 403 },
      ),
    } as never);

    const res = await chamar({ contact_ids: [A, B] });

    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(res.status).toBe(403);
    expect(dispensarParDeContatos).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("os dois ids iguais → 422, e nada é gravado", async () => {
    const res = await chamar({ contact_ids: [A, A] });

    expect(res.status).toBe(422);
    expect(dispensarParDeContatos).not.toHaveBeenCalled();
  });

  it("par de telefone ou e-mail (o helper diz par_forte) → 422 not_dismissable, sem audit", async () => {
    vi.mocked(dispensarParDeContatos).mockResolvedValue({ ok: false, motivo: "par_forte" });

    const res = await chamar({ contact_ids: [A, B] });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(422);
    expect(json.error.code).toBe("not_dismissable");
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("POST /contacts/duplicates/dismiss: o que acontece depois da gravação", () => {
  it("fichas que não são desta organização (o helper diz nao_encontrado) → 404, sem audit", async () => {
    // Sabotagem: tirar o filtro de organização no helper deixa o caso de OUTRA organização
    // achando as fichas — isso é provado no invariante, não aqui.
    vi.mocked(dispensarParDeContatos).mockResolvedValue({ ok: false, motivo: "nao_encontrado" });

    const res = await chamar({ contact_ids: [A, B] });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("not_found");
    expect(audit).not.toHaveBeenCalled();
  });

  it("dispensa criada → 201 e UMA entrada de audit, só com os ids", async () => {
    const res = await chamar({ contact_ids: [A, B] });
    const json = (await res.json()) as { data: { candidates: string[]; criada: boolean } };

    expect(res.status).toBe(201);
    expect(json.data).toEqual({ candidates: [A, B], criada: true });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "contact.duplicate_dismissed",
      organizationId: ORG_SESSAO,
      actorUserId: USER_ID,
      metadata: { candidates: [A, B] },
    });
  });

  it("dispensa que já existia (criada:false) → 200 e NENHUM audit", async () => {
    // Sabotagem: auditar sempre (e não só quando criada) deixa este caso vermelho.
    vi.mocked(dispensarParDeContatos).mockResolvedValue({ ok: true, criada: false, candidatos: [A, B] });

    const res = await chamar({ contact_ids: [B, A] });

    expect(res.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a gravação parte da organização da SESSÃO, mesmo que o corpo traga outra", async () => {
    // Sabotagem: ler `organization_id` do corpo deixa este caso vermelho.
    const res = await chamar({ contact_ids: [A, B], organization_id: ORG_OUTRA });

    expect(res.status).toBe(201);
    expect(dispensarParDeContatos).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG_SESSAO, userId: USER_ID }),
    );
    const args = vi.mocked(dispensarParDeContatos).mock.calls[0]![1];
    expect(args.organizationId).not.toBe(ORG_OUTRA);
  });
});
