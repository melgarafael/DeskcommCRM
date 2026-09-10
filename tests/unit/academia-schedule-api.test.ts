import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/modules/require-academia", () => ({ requireAcademia: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
import { requireAcademia } from "@/lib/modules/require-academia";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { GET, POST, PATCH } from "@/app/api/v1/academia/schedule/route";
const id = "a2350000-0000-4000-8000-000000000001";
const org = "a2350000-0000-4000-8000-000000000002";
const values = { modality_id: id, audience_id: id, teacher_id: id, space_id: id, weekday: 1, start_time: "08:30", duration_minutes: 45, notes: "", active: true };
const row = { id, organization_id: org, ...values, start_time: "08:30:00", revision: 1 };
const maybeSingle = vi.fn();
const chain = { insert: vi.fn(), update: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), gt: vi.fn(), maybeSingle };
const from = vi.fn(() => chain);
beforeEach(() => {
  vi.resetAllMocks(); from.mockReturnValue(chain);
  for (const method of [chain.insert, chain.update, chain.select, chain.eq, chain.order, chain.limit, chain.gt]) method.mockReturnValue(chain);
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireAcademia).mockResolvedValue({ ok: true, org: { orgId: org }, user: { id: "user" } } as never);
});
function req(method: string, data: unknown) { return new Request("http://localhost/api/v1/academia/schedule", { method, headers: { "Content-Type": "application/json", "Idempotency-Key": id }, body: JSON.stringify(data) }); }
it("criação usa organização da sessão, normaliza horário e audita uma vez", async () => {
  maybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: row, error: null });
  const response = await POST(req("POST", { values }));
  expect(response.status).toBe(201);
  expect((await response.json()).data.start_time).toBe("08:30");
  expect(chain.insert).toHaveBeenCalledWith({ id, organization_id: org, ...values });
  expect(audit).toHaveBeenCalledTimes(1);
  expect(requireAcademia).toHaveBeenCalledWith(expect.any(String), "manager");
});
it("retry preserva identidade e não audita novamente", async () => {
  maybeSingle.mockResolvedValue({ data: row, error: null });
  expect((await POST(req("POST", { values }))).status).toBe(200);
  expect(chain.insert).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
});
it("retry concorrente de criação também devolve o registro", async () => {
  maybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: null, error: { code: "23505" } }).mockResolvedValueOnce({ data: row, error: null });
  expect((await POST(req("POST", { values }))).status).toBe(200);
  expect(audit).not.toHaveBeenCalled();
});
it("chave usada com outro conteúdo retorna conflito", async () => {
  maybeSingle.mockResolvedValue({ data: { ...row, duration_minutes: 60 }, error: null });
  expect((await POST(req("POST", { values }))).status).toBe(409); expect(audit).not.toHaveBeenCalled();
});
it("PATCH exige revisão corrente e tenant da sessão", async () => {
  maybeSingle.mockResolvedValue({ data: null, error: null });
  expect((await PATCH(req("PATCH", { id, revision: 1, values }))).status).toBe(409);
  expect(chain.eq).toHaveBeenCalledWith("organization_id", org); expect(chain.eq).toHaveBeenCalledWith("revision", 1);
});
it("payload com tenant é recusado", async () => {
  expect((await POST(req("POST", { values: { ...values, organization_id: org } }))).status).toBe(422);
  expect(from).not.toHaveBeenCalled();
});
it("vínculo inválido vira erro utilizável", async () => {
  maybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: null, error: { code: "23514" } });
  expect((await POST(req("POST", { values }))).status).toBe(422); expect(audit).not.toHaveBeenCalled();
});
it("suporte sem escrita não chega ao banco", async () => {
  vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
  expect((await POST(req("POST", { values }))).status).toBe(403);
  expect(requireAcademia).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
});
it("módulo desativado bloqueia leitura direta", async () => {
  vi.mocked(requireAcademia).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
  expect((await GET(new Request("http://localhost/api/v1/academia/schedule"))).status).toBe(403);
  expect(from).not.toHaveBeenCalled();
});
it("GET pagina e só consulta a organização autorizada", async () => {
  chain.limit.mockResolvedValue({ data: Array.from({ length: 51 }, () => row), error: null });
  const response = await GET(new Request("http://localhost/api/v1/academia/schedule"));
  const body = await response.json();
  expect(body.data).toHaveLength(50); expect(body.meta).toEqual({ has_more: true, cursor: id });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(chain.eq).toHaveBeenCalledWith("organization_id", org);
});
