import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({ audit: vi.fn(), supportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.supportWrite }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/env", () => ({ env: {
  ADVOMAX_API_URL: "https://advomax.example",
  ADVOMAX_CRM_INTEGRATION_KEY: "server-only-key",
} }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const CONTACT = "44444444-4444-4444-8444-444444444444";

const authz = {
  ok: true as const,
  user: { id: USER, email: "ana@example.com" },
  org: { orgId: ORG, name: "Escritório", role: "agent" },
};

type MockQuery = {
  patch: unknown;
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
};

function query(result: unknown): MockQuery {
  const q = {} as MockQuery;
  q.patch = null;
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.update = vi.fn((patch: unknown) => { q.patch = patch; return q; });
  q.insert = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => ({ data: result, error: null }));
  q.single = vi.fn(async () => ({ data: result, error: null }));
  q.then = (resolve) => Promise.resolve({ data: result, error: null }).then(resolve);
  return q;
}

function request(method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/messages/${MESSAGE}/document-intake`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

const ctx = { params: Promise.resolve({ id: MESSAGE }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supportWrite.mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue(authz as never);
});

describe("document intake status and retry", () => {
  it("retorna somente estado e recibo seguro, sem storage path ou claim", async () => {
    const status = query({
      id: "intake-1", message_id: MESSAGE, contact_id: CONTACT, status: "uploaded", pessoa_codigo: 42,
      filename: "whatsapp-pdf.pdf", mime_type: "application/pdf", attempts: 1, advomax_file_id: 99,
      media_storage_path: "whatsapp-media/private.pdf", requested_by_email: "ana@example.com", claimed_by: "request:secret",
    });
    vi.mocked(createClient).mockResolvedValue({ from: vi.fn(() => status) } as never);

    const response = await GET(request(), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ status: "uploaded", advomax_file_id: 99, documents_url: `/app/contacts/${CONTACT}` });
    expect(body.data).not.toHaveProperty("media_storage_path");
    expect(body.data).not.toHaveProperty("requested_by_email");
    expect(body.data).not.toHaveProperty("claimed_by");
  });

  it("não duplica upload quando outro worker já está enviando", async () => {
    const message = query({ id: MESSAGE, conversation_id: "conversation-1", contact_id: CONTACT, media_storage_path: "media/private.pdf", media_mime: "application/pdf", type: "document" });
    const link = query(null);
    const processing = query({ id: "intake-1", message_id: MESSAGE, contact_id: CONTACT, status: "processing", pessoa_codigo: 42, attempts: 1, claimed_by: "cron:other" });
    const from = vi.fn()
      .mockReturnValueOnce(message)
      .mockReturnValueOnce(link)
      .mockReturnValueOnce(processing);
    vi.mocked(createClient).mockResolvedValue({ from } as never);

    const response = await POST(request("POST", { pessoa_codigo: 42 }), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("processing");
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("reprocessa falha com claim próprio e preserva a chave idempotente da mensagem", async () => {
    const message = query({ id: MESSAGE, conversation_id: "conversation-1", contact_id: CONTACT, media_storage_path: "media/private.pdf", media_mime: "application/pdf", type: "document" });
    const link = query(null);
    const failed = query({ id: "intake-1", organization_id: ORG, message_id: MESSAGE, contact_id: CONTACT, status: "failed", pessoa_codigo: 42, attempts: 5 });
    const claimed = query({ id: "intake-1", organization_id: ORG, message_id: MESSAGE, contact_id: CONTACT, status: "processing", pessoa_codigo: 42, attempts: 1, claimed_by: "request:req" });
    const uploaded = query({ id: "intake-1", organization_id: ORG, message_id: MESSAGE, contact_id: CONTACT, status: "uploaded", pessoa_codigo: 42, attempts: 1, advomax_file_id: 77 });
    const from = vi.fn()
      .mockReturnValueOnce(message)
      .mockReturnValueOnce(link)
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(claimed)
      .mockReturnValueOnce(uploaded);
    vi.mocked(createClient).mockResolvedValue({ from } as never);
    vi.mocked(createAdminClient).mockReturnValue({
      storage: { from: vi.fn(() => ({ download: vi.fn(async () => ({ data: new Blob(["pdf"]), error: null })) })) },
    } as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ codigo: 77 }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("POST", { pessoa_codigo: 42 }), ctx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("uploaded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "X-CRM-Message-Id": MESSAGE }),
    }));
    expect(claimed.update).toHaveBeenCalledWith(expect.objectContaining({ status: "processing", attempts: 1 }));
    expect(uploaded.update).toHaveBeenCalledWith(expect.objectContaining({ status: "uploaded", advomax_file_id: 77 }));
  });
});
