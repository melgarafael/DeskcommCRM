/**
 * A ROTA DA AGENDA NÃO CHAMA DE FALHA DO SERVIDOR O ERRO DE QUEM CHAMA (issue #540).
 *
 * ─── O que estava lá (medido em 60079eb5) ───────────────────────────────────
 *
 *     app/api/v1/agenda/agendamentos/route.ts:182-189
 *       if (!resultado.ok) {
 *         return fail(
 *           resultado.codigo === "sem_alvo" ? "agenda_listagem_sem_recorte" : "internal_error",
 *           t(resultado.motivoParaOperador),
 *           resultado.codigo === "sem_alvo" ? 422 : 500,
 *           { requestId },
 *         );
 *       }
 *
 * O ternário conhece DUAS recusas. Com o #526, `lib/agenda/consulta.ts` passou a
 * emitir uma terceira — `alvo_nao_e_lead` — e ela cai no `else` do mapa: vira
 * HTTP 500 `internal_error`.
 *
 * Só que `alvo_nao_e_lead` é erro de QUEM CHAMA: o parâmetro `lead_id` veio
 * preenchido com o id de um CONTATO (a troca de parâmetros medida em #509), o
 * servidor está inteiro, e a requisição é que não é processável. 500 diz a um
 * cliente server-to-server que a culpa é nossa — e acorda o Sentry por consulta
 * malformada, que é ruído puro.
 *
 * ─── E a guarda do #526 não alcançava a rota (classe 6-bis) ─────────────────
 *
 * Os casos de `agenda-nao-mente-sobre-id-de-contato.test.ts` exercitam
 * `listaAgendamentos` direto, sem passar por nenhuma rota. A biblioteca estava
 * certa e a rota continuava publicando 500: um teste de biblioteca não prova a
 * camada que serializa o erro. Este arquivo atravessa o `GET` DE VERDADE, com a
 * biblioteca REAL no meio, e é por isso que ele fica vermelho quando qualquer
 * um dos dois lados é sabotado:
 *
 *   - sabotado `lib/agenda/consulta.ts` (a recusa volta a ser `ok([])`), o caso
 *     ⭐ recebe 200 — o defeito de #509 de volta, agora visível na rota;
 *   - sabotada a rota (o mapa vira `internal_error`/500 para tudo), o caso ⭐
 *     recebe 500 em vez de 422.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
/** O id do CONTATO — que é o que o contexto do turno chama de `lead_id` (#509). */
const CONTATO = "33333333-3333-4333-8333-333333333333";

const usuario: AuthUser = {
  id: ANA,
  email: "ana@clinica.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "agent" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "agent" };

/**
 * Dublê do Supabase que distingue as tabelas — sem ele não dá para separar
 * "lead de verdade sem nada marcado" (200, lista vazia) de "isto nem é lead"
 * (422), que é a distinção inteira desta issue. Mesmo desenho de
 * `agenda-nao-mente-sobre-id-de-contato.test.ts`.
 */
function db(opts: { ehLead: boolean; vinculos?: string[]; falhaAoConsultarVinculo?: string }) {
  const q = (tabela: string) => {
    const enc: Record<string, unknown> = {};
    const passa = () => enc;
    for (const m of ["select", "eq", "in", "order", "limit", "gte", "lt", "lte", "is", "not", "neq"]) {
      enc[m] = passa;
    }
    enc.maybeSingle = async () => ({
      data: tabela === "crm_leads" && opts.ehLead ? { id: CONTATO } : null,
      error: null,
    });
    enc.then = (ok: (v: unknown) => unknown) => {
      if (tabela === "crm_lead_links") {
        return Promise.resolve(
          ok({
            data: (opts.vinculos ?? []).map((t) => ({ target_id: t })),
            error: opts.falhaAoConsultarVinculo ? { message: opts.falhaAoConsultarVinculo } : null,
          }),
        );
      }
      if (tabela === "crm_leads") {
        return Promise.resolve(ok({ data: opts.ehLead ? [{ id: CONTATO }] : [], error: null }));
      }
      return Promise.resolve(ok({ data: [], error: null }));
    };
    return enc;
  };
  return { from: (t: string) => q(t) } as never;
}

function pedido(query = ""): NextRequest {
  return new NextRequest(`https://crm.exemplo/api/v1/agenda/agendamentos${query}`, {
    headers: { "x-request-id": "req-540" },
  });
}

/** Importa a ROTA (e não a biblioteca) para exercitar o mapa de recusas dela. */
async function rota() {
  return (await import("@/app/api/v1/agenda/agendamentos/route")).GET;
}

function comBanco(opts: Parameters<typeof db>[0]) {
  vi.mocked(createClient).mockResolvedValue(db(opts) as never);
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
});

describe("GET /api/v1/agenda/agendamentos — erro de quem chama não vira 500", () => {
  it("⭐ lead_id que não é lead responde 422 (e não 500) com código próprio", async () => {
    comBanco({ ehLead: false });
    const GET = await rota();

    const res = await GET(pedido(`?lead_id=${CONTATO}`));
    const corpo = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(res.status, "o id que não é lead é erro de QUEM CHAMA: 500 manda o cliente server-to-server abrir chamado de indisponibilidade").toBe(422);
    expect(corpo.error?.code).toBe("agenda_listagem_alvo_nao_e_lead");
    // A recusa ensina: o motivo que a biblioteca escreveu chega ao operador.
    expect(corpo.error?.message ?? "").toContain("contact_id");
  });

  it("⭐ sabotagem da rota não escapa: um `else` que devolvesse 500 aqui deixaria este caso vermelho", async () => {
    comBanco({ ehLead: false });
    const GET = await rota();

    const res = await GET(pedido(`?lead_id=${CONTATO}`));

    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("continua 422 quando falta recorte — o desfecho que já estava certo não regrediu", async () => {
    comBanco({ ehLead: true });
    const GET = await rota();

    const res = await GET(pedido());
    const corpo = (await res.json()) as { error?: { code?: string } };

    expect(res.status).toBe(422);
    expect(corpo.error?.code).toBe("agenda_listagem_sem_recorte");
  });

  it("lead de VERDADE sem vínculo segue 200 com lista vazia — a recusa não é apressada", async () => {
    comBanco({ ehLead: true });
    const GET = await rota();

    const res = await GET(pedido(`?lead_id=${CONTATO}`));
    const corpo = (await res.json()) as { data?: unknown; error?: unknown };

    expect(res.status).toBe(200);
    expect(corpo.error).toBeUndefined();
    expect(corpo.data).toEqual([]);
  });

  it("aí sim é nosso: falha real de consulta continua 500 internal_error", async () => {
    comBanco({ ehLead: true, falhaAoConsultarVinculo: "connection reset" });
    const GET = await rota();

    const res = await GET(pedido(`?lead_id=${CONTATO}`));
    const corpo = (await res.json()) as { error?: { code?: string } };

    expect(res.status).toBe(500);
    expect(corpo.error?.code).toBe("internal_error");
  });
});
