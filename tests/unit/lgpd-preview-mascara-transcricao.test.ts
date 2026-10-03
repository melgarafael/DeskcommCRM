/**
 * A prévia da solicitação LGPD mascara a transcrição da mídia como mascara o corpo.
 *
 * `GET /api/v1/lgpd/requests/[id]/preview` mostra ao admin uma AMOSTRA do que
 * o export levaria, com o `body` trocado por "[masked]" e o resto repassado
 * por spread. Quando o export passou a trazer `media_derived_text` (#1990), o
 * spread o entregava cru — a transcrição do áudio do titular aparecia na mesma
 * tela que esconde o texto digitado, inclusive para o super-admin que entra na
 * organização em modo leitura (`allowPlatformAdmin: "leitura"`).
 */
import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/v1/lgpd/requests/[id]/preview/route";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectExportData } from "@/lib/lgpd/export-collector";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/lgpd/export-collector", () => ({ collectExportData: vi.fn() }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: vi.fn(async () => ({ valor: null })) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const PEDIDO = "22222222-2222-4222-8222-222222222222";

function mensagem(id: string, body: string | null, transcricao: string | null) {
  return {
    id,
    conversation_id: "conv-a",
    direction: "inbound",
    type: "audio",
    status: "delivered",
    body,
    has_media: true,
    media_derived_text: transcricao,
    sent_at: "2026-09-15T10:00:00Z",
    created_at: "2026-09-15T10:00:00Z",
  };
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { idioma: "pt-BR" },
    org: { orgId: ORG },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  const pedido = { id: PEDIDO, contact_id: "contact-a", external_customer_id: null, request_type: "access" };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: pedido, error: null }),
  };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as unknown as ReturnType<
    typeof createAdminClient
  >);
  vi.mocked(collectExportData).mockResolvedValue({
    no_local_footprint: false,
    generated_at: "2026-09-15T10:00:00Z",
    contact: null,
    conversations: [],
    messages_count_total: 2,
    messages_recent: [
      mensagem("msg-audio", null, "TRANSCRICAO-DO-TITULAR"),
      mensagem("msg-sem", null, null),
    ],
    leads: [],
    orders: [],
    activities: [],
    audit_log_extract: [],
    consents: [],
  } as unknown as Awaited<ReturnType<typeof collectExportData>>);
});

it("a prévia mascara media_derived_text pela mesma régua do body", async () => {
  const res = await GET(new NextRequest(`http://localhost/api/v1/lgpd/requests/${PEDIDO}/preview`), {
    params: Promise.resolve({ id: PEDIDO }),
  });
  expect(res.status).toBe(200);
  const texto = await res.text();
  expect(texto).not.toContain("TRANSCRICAO-DO-TITULAR");
  const { data } = JSON.parse(texto) as {
    data: { sample: { messages_recent: Array<{ id: string; media_derived_text: string | null }> } };
  };
  expect(data.sample.messages_recent).toEqual([
    expect.objectContaining({ id: "msg-audio", media_derived_text: "[masked]" }),
    expect.objectContaining({ id: "msg-sem", media_derived_text: null }),
  ]);
});
