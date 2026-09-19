/**
 * AS DUAS ROTAS QUE MOSTRAM A JANELA LEVAM O FUSO DA ORGANIZAÇÃO ATÉ A TELA.
 *
 * `janela-no-fuso-da-organizacao.test.ts` prova `effectiveKnobs` sozinho; isto
 * prova que o GET de Conexões › Proteção de envio e o contexto da retenção
 * leem `organizations.timezone` e o repassam — sem essa leitura, "Usar o
 * padrão" volta a anunciar São Paulo a uma empresa de Lisboa.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

import { GET as getPacing, PUT as putPacing } from "@/app/api/v1/ai/pacing/route";
import { GET as getRetention } from "@/app/api/v1/conversations/[id]/retention/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

/** Cliente que responde por TABELA; toda cadeia (`select`, `eq`, `in`…) devolve a si mesma. */
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

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u", idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: "admin" },
  } as never);
  vi.mocked(loadAuthUser).mockResolvedValue({ idioma: "pt-BR" } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG } as never);
});

describe("o fuso da organização chega à tela", () => {
  it("Conexões › Proteção de envio: o efetivo de um número sem knobs é o da organização", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      cliente({
        channel_sessions: [{ id: CANAL, status: "WORKING" }],
        channel_knobs: [],
        organizations: { timezone: "Europe/Lisbon" },
      }),
    );
    const corpo = (await (await getPacing()).json()) as {
      data: { items: { effective: { timezone: string } }[] };
    };
    expect(corpo.data.items[0]?.effective.timezone).toBe("Europe/Lisbon");
  });

  it("Conexões › Proteção de envio: a resposta do salvar também, e não só a do abrir", async () => {
    // Sem isto, a tela voltava a anunciar São Paulo logo depois de salvar.
    vi.mocked(createAdminClient).mockReturnValue(
      cliente({
        channel_sessions: { id: CANAL },
        channel_knobs: { window_start_hour: 8, timezone: null, warmup_daily_caps: null },
        organizations: { timezone: "Europe/Lisbon" },
      }),
    );
    const res = await putPacing(
      new NextRequest("http://localhost/api/v1/ai/pacing", {
        method: "PUT",
        body: JSON.stringify({ channel_session_id: CANAL, window_start_hour: 8 }),
      }),
    );
    const corpo = (await res.json()) as { data: { effective: { timezone: string; windowStartHour: number } } };
    expect(corpo.data.effective).toMatchObject({ timezone: "Europe/Lisbon", windowStartHour: 8 });
  });

  it("retenção: o contexto diz em que fuso a janela segurou o envio", async () => {
    vi.mocked(createClient).mockResolvedValue(
      cliente({
        conversations: { id: "c", contact_id: "k", channel_session_id: CANAL },
        before_send_traces: [],
        channel_knobs: null,
        organizations: { timezone: "Europe/Lisbon" },
      }),
    );
    const res = await getRetention(new NextRequest("http://localhost/api/v1/conversations/c/retention"), {
      params: Promise.resolve({ id: "c" }),
    });
    const corpo = (await res.json()) as { data: { context: { timezone: string } } };
    expect(corpo.data.context.timezone).toBe("Europe/Lisbon");
  });
});
