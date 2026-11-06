import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * NUM SERVIÇO NÃO HÁ EQUIPE NA MARCAÇÃO (#4006), e dizer isso é a resposta honesta.
 *
 * A reserva passa por `fn_calendar_service_book`, que não grava
 * `team_guest_user_ids`, e desvia antes da conferência de organização. Sem a
 * recusa, a tela dizia "marcado" (201) com a lista vazia no banco e ninguém
 * convidado. É o mesmo precedente de `agenda_duracao_do_servico` (#3709).
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const DONO = "00000000-0000-4000-8000-0000000000aa";
const COLEGA = "00000000-0000-4000-8000-0000000000bb";
const TIPO = "00000000-0000-4000-8000-0000000000dd";

function sbDeTeste(chamadas: string[]) {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({
      data: { id: TIPO, name: "Aula", is_active: true, duration_minutes: 30, service_enabled: true },
      error: null,
    }),
  };
  return {
    from: () => q,
    rpc: async (nome: string) => {
      chamadas.push(nome);
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
}

const ctx = {
  organization_id: ORG,
  requestId: "req-4006",
  actor: { type: "user", id: DONO, role: "agent" },
} as unknown as HandlerCtx;

const marcacao = {
  event_type_id: TIPO,
  starts_at: "2026-09-21T13:00:00.000Z",
  team_guest_user_ids: [COLEGA],
};

describe("#4006 · a equipe fica de fora do tipo de serviço", () => {
  it("POST com convidados é 422 nomeado e a reserva não é chamada", async () => {
    const chamadas: string[] = [];
    await expect(marcarAgendamentoHandler(sbDeTeste(chamadas), ctx, marcacao)).rejects.toMatchObject({
      status: 422,
      code: "agenda_equipe_no_servico",
    });
    expect(chamadas).toEqual([]);
  });

  const tela = readFileSync("app/app/agenda/_client.tsx", "utf8");

  it("a tela não mostra os botões de convidado num serviço", () => {
    expect(tela).toContain('{!remarcandoId && !tipo?.servico ? (\n              <fieldset>');
  });

  it("marcar a equipe e depois trocar para um serviço não envia a lista", () => {
    const inicio = tela.indexOf("return marcar");
    const bloco = tela.slice(inicio, tela.indexOf(".then((r) => {", inicio));
    expect(bloco).toMatch(/team_guest_user_ids:\s*convidadosDaEquipe\.length && !tipo\.servico/);
  });
});
