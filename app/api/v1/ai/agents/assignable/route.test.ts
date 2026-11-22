import { expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { GET } from "./route";

vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(),
  tetoDeEscritaDoToken: vi.fn(),
}));

it("oferece na Telefonia apenas os agentes de voz ativos, mesmo sem versão", async () => {
  const org = "11111111-1111-4111-8111-111111111111";
  const voz = { channel: "voice", organization_id: org, published_version_id: null, archived_at: null, paused_at: null };
  let agentes = [
    { ...voz, id: "ativo", name: "Recepção", is_active: true },
    { ...voz, id: "inativo", name: "Em configuração", is_active: false },
    { ...voz, id: "vizinho", name: "Outra empresa", organization_id: "vizinha", is_active: true },
    { ...voz, id: "arquivado", name: "Antigo", archived_at: "2026-01-01", is_active: true },
    { ...voz, id: "mensagens", name: "Mensagens", channel: "whatsapp", is_active: true },
  ];
  const consulta = {
    select: () => consulta,
    eq(coluna: "channel" | "organization_id", valor: string) {
      agentes = agentes.filter((a) => a[coluna] === valor);
      return consulta;
    },
    is(coluna: "archived_at", valor: null) {
      agentes = agentes.filter((a) => a[coluna] === valor);
      return consulta;
    },
    order(coluna: string) {
      return coluna === "created_at" ? Promise.resolve({ data: agentes, error: null }) : consulta;
    },
  };
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    organizationId: org,
    supabase: { from: () => consulta },
  } as unknown as Awaited<ReturnType<typeof resolveAuthDual>>);
  vi.mocked(tetoDeEscritaDoToken).mockResolvedValue(null);

  const res = await GET(new NextRequest("http://localhost/api/v1/ai/agents/assignable?channel=voice"));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    data: [{ agent_id: "ativo", name: "Recepção", version_number: null }],
  });
});
