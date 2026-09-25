/**
 * O aviso de retenção da Inbox diz o estado de AGORA, e diz de ONDE é a janela.
 *
 * Dois defeitos medidos numa instalação real (organização em America/Manaus):
 *
 *   1. A rota devolvia TODO trace de retenção da conversa. Uma mensagem retida
 *      às 23h e enviada às 7h seguia anunciada como "retida" o dia inteiro, e o
 *      "fora da janela" continuava na tela com a janela já aberta — o próximo
 *      turno reavalia com ela aberta, então o aviso afirmava o que não vale mais.
 *   2. O aviso dizia "7h–22h" sem cidade. O dono em Manaus lia o horário como
 *      se fosse o dele.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { GET as getRetention } from "@/app/api/v1/conversations/[id]/retention/route";
import { retentionCopy } from "@/lib/inbox/retention-copy";
import { cidadeDoFuso } from "@/lib/tempo/fusos";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

/** Cliente que responde por TABELA; toda cadeia devolve a si mesma. */
function cliente(porTabela: Record<string, unknown>) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) },
    from: (tabela: string) => {
      const resposta = { data: porTabela[tabela] ?? null, error: null };
      const cadeia: unknown = new Proxy(
        {},
        {
          get: (_alvo, chave) =>
            chave === "then"
              ? (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok)
              : chave === "maybeSingle"
                ? async () => resposta
                : () => cadeia,
        },
      );
      return cadeia;
    },
  } as never;
}

async function retencoes(tabelas: Record<string, unknown>) {
  vi.mocked(createClient).mockResolvedValue(
    cliente({
      conversations: { id: "c", contact_id: "k", channel_session_id: CANAL },
      channel_knobs: null,
      organizations: { timezone: "America/Sao_Paulo" },
      ...tabelas,
    }),
  );
  const res = await getRetention(new NextRequest("http://localhost/api/v1/conversations/c/retention"), {
    params: Promise.resolve({ id: "c" }),
  });
  const corpo = (await res.json()) as { data: { retentions: Array<{ vetoed_code: string }> } };
  return corpo.data.retentions;
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u", idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
  vi.mocked(loadAuthUser).mockResolvedValue({ idioma: "pt-BR" } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a rota de retenção devolve só o que vale agora", () => {
  it("retenção seguida de uma resposta que SAIU já foi resolvida — some", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-20T15:00:00Z"), toFake: ["Date"] }); // 12h em São Paulo
    const r = await retencoes({
      before_send_traces: [{ vetoed_code: "daily_cap", created_at: "2026-09-20T10:00:00Z" }],
      messages: { created_at: "2026-09-20T11:00:00Z" },
    });
    expect(r).toEqual([]);
  });

  it("'fora da janela' com a janela ABERTA agora — some (o próximo turno reavalia)", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-20T15:00:00Z"), toFake: ["Date"] }); // 12h, janela 7h–22h
    const r = await retencoes({
      before_send_traces: [{ vetoed_code: "outside_window", created_at: "2026-09-20T02:00:00Z" }],
      messages: null,
    });
    expect(r).toEqual([]);
  });

  it("'fora da janela' com a janela FECHADA agora e nada enviado depois — fica", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-20T05:30:00Z"), toFake: ["Date"] }); // 2h30 em São Paulo
    const r = await retencoes({
      before_send_traces: [{ vetoed_code: "outside_window", created_at: "2026-09-20T05:00:00Z" }],
      messages: { created_at: "2026-09-19T20:00:00Z" },
    });
    expect(r.map((t) => t.vetoed_code)).toEqual(["outside_window"]);
  });
});

describe("o aviso diz de ONDE é a janela", () => {
  it("cidadeDoFuso diz o fuso como gente fala", () => {
    expect(cidadeDoFuso("America/Manaus")).toBe("Manaus");
    expect(cidadeDoFuso("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(cidadeDoFuso("UTC")).toBe("UTC");
  });

  it("o texto da Inbox nomeia a cidade do fuso que segurou o envio", () => {
    const r = retentionCopy("outside_window", {
      window_start_hour: 7,
      window_end_hour: 22,
      allow_sunday: true,
      timezone: "America/Manaus",
    } as never);
    expect(JSON.stringify(r)).toContain("Manaus");
  });
});
