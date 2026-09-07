import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { googleRpc } from "@/lib/agenda/google/sync-store";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/agenda/google/sync-store", () => ({ googleRpc: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { PATCH } from "@/app/api/v1/agenda/google/calendarios/route";
import { POST as resolve } from "@/app/api/v1/agenda/agendamentos/[id]/google/resolver/route";
import { POST as retry } from "@/app/api/v1/agenda/agendamentos/[id]/google/retry/route";
const org = "aaaaaaaa-0000-4000-8000-000000000001",
  user = "aaaaaaaa-0000-4000-8000-000000000002",
  id = "aaaaaaaa-0000-4000-8000-000000000003";
const payload = {
  expected_domain_revision: "7",
  expected_google_local_revision: "9007199254740993",
  etag: '"v1"',
  choice: "google",
};
const request = (body: unknown, method = "POST") =>
  new Request("http://local/agenda", { method, body: JSON.stringify(body) });
const context = { params: Promise.resolve({ id }) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: user },
    org: { orgId: org },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(createClient).mockResolvedValue({} as never);
  vi.mocked(googleRpc).mockResolvedValue(null);
});
describe("bordas humanas de seleção e conflito", () => {
  it("seleção usa org confiável e conserva bigint em texto", async () => {
    expect(
      (
        await PATCH(
          request(
            {
              revisions: [{ connection_id: id, revision: "9007199254740993" }],
              sources: [id],
              destination: id,
            },
            "PATCH",
          ),
        )
      ).status,
    ).toBe(200);
    expect(googleRpc).toHaveBeenCalledWith(expect.anything(), "fn_google_selection", {
      p_org: org,
      p_revisions: [{ connection_id: id, revision: "9007199254740993" }],
      p_sources: [id],
      p_destination: id,
    });
  });
  it("org/ator injetados no body são recusados, nunca viram contexto", async () => {
    expect(
      (await resolve(request({ ...payload, organization_id: "other", actor_id: "other" }), context))
        .status,
    ).toBe(422);
    expect(googleRpc).not.toHaveBeenCalled();
  });
  it.each(["readonly", "expired"])("suporte %s é barrado antes de cliente/RPC", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(
      fail("forbidden", "Acompanhamento sem permissão de escrita.", 403),
    );
    expect((await PATCH(request({}))).status).toBe(403);
    expect((await resolve(request(payload), context)).status).toBe(403);
    expect((await retry(request(payload), context)).status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
    expect(googleRpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("revisão obsoleta pede nova comparação, sem audit de mutação", async () => {
    vi.mocked(googleRpc).mockRejectedValue(
      Object.assign(new Error("google_stale"), { code: "40001" }),
    );
    expect((await resolve(request(payload), context)).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
  it("dono diferente recebe403 decidido pela RPC, nunca fallback service", async () => {
    vi.mocked(googleRpc).mockRejectedValue(
      Object.assign(new Error("google_resolution_forbidden"), { code: "42501" }),
    );
    expect((await resolve(request(payload), context)).status).toBe(403);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
  it("retry usa mesma guarda e ignora escolha enviada no endpoint", async () => {
    expect((await retry(request(payload), context)).status).toBe(200);
    expect(googleRpc).toHaveBeenCalledWith(
      expect.anything(),
      "fn_google_resolve",
      expect.objectContaining({
        p_org: org,
        p_id: id,
        p_choice: "retry",
        p_local_revision: "9007199254740993",
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: user, organizationId: org }),
    );
  });
});

it("retry recusa suporte antes de consumir o body ou delegar a resolução", async () => {
  const req = request(payload);
  const read = vi.spyOn(req, "json");
  vi.mocked(requireSupportWrite).mockResolvedValue(
    fail("forbidden", "Acompanhamento sem escrita.", 403),
  );
  expect((await retry(req, context)).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  expect(requireRole).not.toHaveBeenCalled();
  expect(createClient).not.toHaveBeenCalled();
  expect(googleRpc).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});
