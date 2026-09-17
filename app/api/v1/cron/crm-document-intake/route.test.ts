import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/env", () => ({ env: {
  INTERNAL_SECRET: "local-secret", INTERNAL_CRON_SECRET: "",
  ADVOMAX_API_URL: "http://127.0.0.1:8080", ADVOMAX_CRM_INTEGRATION_KEY: "local-key",
} }));

const ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Intake = {
  id: string;
  organization_id: string;
  message_id: string;
  pessoa_codigo: number;
  filename: string;
  mime_type: string;
  media_storage_path: string;
  descricao: string | null;
  attempts: number;
  requested_by: string | null;
  requested_by_email: string | null;
};

const candidate: Intake = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organization_id: ORG_ID,
  message_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  pessoa_codigo: 42,
  filename: "contrato.pdf",
  mime_type: "application/pdf",
  media_storage_path: "org/message/contrato.pdf",
  descricao: "Contrato recebido",
  attempts: 0,
  requested_by: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  requested_by_email: "ana@example.com",
};

function request(secret = "local-secret") {
  return new NextRequest("http://127.0.0.1:3000/api/v1/cron/crm-document-intake", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

function query(finalResult: unknown, terminal: "limit" | "maybeSingle" | "select" | "in") {
  const q: Record<string, ReturnType<typeof vi.fn>> = {};
  q.select = vi.fn(() => terminal === "select" ? Promise.resolve(finalResult) : q);
  q.eq = vi.fn(() => q);
  q.lte = vi.fn(() => q);
  q.lt = vi.fn(() => q);
  q.order = vi.fn(() => q);
  q.update = vi.fn(() => q);
  q.in = vi.fn(() => terminal === "in" ? Promise.resolve(finalResult) : q);
  q.limit = vi.fn(async () => terminal === "limit" ? finalResult : ({ data: [], error: null }));
  q.maybeSingle = vi.fn(async () => terminal === "maybeSingle" ? finalResult : ({ data: null, error: null }));
  return q;
}

function setup(rows: Intake[] = [candidate], organization: { status: string; advomax_empresa_codigo: number | null } = { status: "active", advomax_empresa_codigo: 7 }) {
  let intakeFromCalls = 0;
  let claimCalls = 0;
  let writes = 0;
  const pendingQuery = query({ data: rows, error: null }, "limit");
  const recoveryQuery = query({ data: [], error: null }, "select");
  const claimQueries: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const organizations = query({ data: [{ id: ORG_ID, ...organization }], error: null }, "in");
  const admin = {
    from: vi.fn((table: string) => {
      if (table === "organizations") return organizations;
      intakeFromCalls++;
      if (intakeFromCalls >= 3) {
        const isClaim = writes++ % 2 === 0;
        if (isClaim) claimCalls++;
        const row = { ...rows[claimCalls - 1], status: isClaim ? "processing" : "uploaded", attempts: (rows[claimCalls - 1]?.attempts ?? 0) + 1 };
        const write = query({ data: row, error: null }, "maybeSingle");
        if (isClaim) claimQueries.push(write);
        return write;
      }
      return intakeFromCalls === 1 ? pendingQuery : recoveryQuery;
    }),
    storage: { from: vi.fn(() => ({ download: vi.fn(async () => ({ data: new Blob(["pdf"]), error: null })) })) },
  };
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  return { admin, claimQueries };
}

beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("cron de intake de documentos", () => {
  it("não reivindica documento quando a licença CRM está inativa", async () => {
    const setupResult = setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: false, source: "advomax" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());
    const body = await response.json() as { data: { claimed: number; skipped: number; skipped_reasons: { license_inactive: number } } };
    expect(response.status).toBe(200);
    expect(body.data.claimed).toBe(0);
    expect(body.data.skipped).toBe(1);
    expect(body.data.skipped_reasons.license_inactive).toBe(1);
    expect(setupResult.claimQueries).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("valida a licença uma vez por organização e envia os documentos elegíveis", async () => {
    const rows = [candidate, { ...candidate, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", message_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }];
    const setupResult = setup(rows);
    const fetchMock = vi.fn((input: RequestInfo | URL) => String(input).endsWith("/integracoes/crm/acesso")
      ? Promise.resolve(new Response(JSON.stringify({ enabled: true, source: "advomax" }), { status: 200 }))
      : Promise.resolve(new Response(JSON.stringify({ codigo: 9001 }), { status: 201 })));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());
    const body = await response.json() as { data: { claimed: number; uploaded: number } };
    expect(response.status).toBe(200);
    expect(body.data.claimed).toBe(2);
    expect(body.data.uploaded).toBe(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/integracoes/crm/acesso"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/documentos"))).toHaveLength(2);
    expect(setupResult.claimQueries).toHaveLength(2);
  });

  it("bloqueia fila de organização sem mapeamento sem chamar a Gestão", async () => {
    setup([candidate], { status: "active", advomax_empresa_codigo: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request());
    const body = await response.json() as { data: { blocked: number; skipped_reasons: { organization_unmapped: number } } };
    expect(response.status).toBe(200);
    expect(body.data.blocked).toBe(1);
    expect(body.data.skipped_reasons.organization_unmapped).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
