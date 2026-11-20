import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

import {
  alterarAgendamentoHandler,
  cancelarAgendamentoHandler,
  marcarAgendamentoHandler,
} from "@/app/api/v1/agenda/agendamentos/_handler";
import { horariosLivresDaOrg } from "@/lib/agenda/consulta";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A AGENDA COM AUTORIDADE DE FORA (#4227, etapa 1 de 2 do doc 356).
 *
 * Compromisso com `authority` diferente de `'local'` é espelho de um sistema
 * externo: a agenda daqui não o remarca nem o cancela, e tipo de atendimento que
 * veio de fora não se marca nem tem grade local. O par de cada recusa é o caso
 * LOCAL com a mesma linha, que tem de seguir escrevendo como antes — é ele que
 * prova que quem não usa integração externa não viu nada mudar.
 *
 * O cliente falso registra toda chamada: a recusa tem de vir ANTES da escrita
 * (`rpc:fn_appointment_change` ausente), não depois.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const DONO = "00000000-0000-4000-8000-0000000000aa";
const COMPROMISSO = "00000000-0000-4000-8000-0000000000cc";
const TIPO = "00000000-0000-4000-8000-0000000000dd";

const compromisso = (authority: string) => ({
  id: COMPROMISSO,
  revision: 3,
  owner_user_id: DONO,
  contact_id: null,
  event_type_id: null,
  starts_at: "2099-01-10T13:00:00.000Z",
  ends_at: "2099-01-10T13:30:00.000Z",
  status: "confirmed",
  time_zone: "America/Sao_Paulo",
  authority,
  external_connection_id: authority === "local" ? null : "00000000-0000-4000-8000-0000000000ee",
});

const tipoExterno = {
  id: TIPO,
  name: "Consulta de retorno",
  is_active: true,
  duration_minutes: 30,
  default_owner_user_id: DONO,
  service_enabled: false,
  external_provider: "sistema_da_clinica",
};

function sbDeTeste(linha: Record<string, unknown>, chamadas: string[]) {
  const api = {
    from(tabela: string) {
      chamadas.push(`from:${tabela}`);
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({
          data: tabela === "calendar_appointments" ? linha : tabela === "calendar_event_types" ? tipoExterno : { name: "Consulta" },
          error: null,
        }),
        single: async () => ({ data: linha, error: null }),
        insert: () => {
          chamadas.push(`insert:${tabela}`);
          return q;
        },
        update: () => q,
        delete: () => q,
      };
      return q;
    },
    async rpc(nome: string, args: { p_patch?: { status?: string } }) {
      chamadas.push(`rpc:${nome}`);
      if (nome === "fn_colegas_podem_mexer_na_agenda") return { data: true, error: null };
      if (nome === "fn_appointment_change") {
        return { data: { ...linha, status: args?.p_patch?.status ?? linha.status }, error: null };
      }
      return { data: null, error: null };
    },
  };
  return api as unknown as SupabaseClient;
}

const ctx = {
  organization_id: ORG,
  requestId: "req-4227",
  actor: { type: "user", id: DONO, role: "admin" },
} as unknown as HandlerCtx;

beforeEach(() => {
  vi.resetAllMocks();
});

it("cancelar compromisso de autoridade externa: 409 nomeado, sem escrita", async () => {
  const chamadas: string[] = [];
  await expect(
    cancelarAgendamentoHandler(sbDeTeste(compromisso("sistema_da_clinica"), chamadas), ctx, {
      id: COMPROMISSO,
      revision: 3,
      reason: "cliente desmarcou",
    }),
  ).rejects.toMatchObject({ status: 409, code: "agenda_autoridade_externa" });
  expect(chamadas).not.toContain("rpc:fn_appointment_change");
});

it("cancelar compromisso local: escreve como antes", async () => {
  const chamadas: string[] = [];
  const r = await cancelarAgendamentoHandler(sbDeTeste(compromisso("local"), chamadas), ctx, {
    id: COMPROMISSO,
    revision: 3,
    reason: "cliente desmarcou",
  });
  expect(chamadas).toContain("rpc:fn_appointment_change");
  expect(r).toMatchObject({ status: "cancelled" });
});

it("remarcar compromisso de autoridade externa: 409 nomeado, sem escrita", async () => {
  const chamadas: string[] = [];
  await expect(
    alterarAgendamentoHandler(sbDeTeste(compromisso("sistema_da_clinica"), chamadas), ctx, {
      id: COMPROMISSO,
      revision: 3,
      notes: "trazer exames",
    }),
  ).rejects.toMatchObject({ status: 409, code: "agenda_autoridade_externa" });
  expect(chamadas).not.toContain("rpc:fn_appointment_change");
});

it("alterar compromisso local: escreve como antes", async () => {
  const chamadas: string[] = [];
  await alterarAgendamentoHandler(sbDeTeste(compromisso("local"), chamadas), ctx, {
    id: COMPROMISSO,
    revision: 3,
    notes: "trazer exames",
  });
  expect(chamadas).toContain("rpc:fn_appointment_change");
});

it("marcar num tipo que veio de fora: 422 nomeado, sem gravar compromisso", async () => {
  const chamadas: string[] = [];
  await expect(
    marcarAgendamentoHandler(sbDeTeste(compromisso("local"), chamadas), ctx, {
      event_type_id: TIPO,
      starts_at: "2099-01-10T13:00:00.000Z",
    }),
  ).rejects.toMatchObject({ status: 422, code: "agenda_tipo_de_sistema_externo" });
  expect(chamadas.filter((c) => c.startsWith("insert:") || c.startsWith("rpc:fn_appointment"))).toEqual([]);
});

it("horários livres de um tipo que veio de fora: recusa sem grade local", async () => {
  const chamadas: string[] = [];
  const r = await horariosLivresDaOrg(sbDeTeste(compromisso("local"), chamadas), ORG, {
    eventTypeId: TIPO,
    de: new Date("2099-01-10T00:00:00.000Z"),
    ate: new Date("2099-01-11T00:00:00.000Z"),
    agora: new Date("2099-01-01T00:00:00.000Z"),
  });
  expect(r).toMatchObject({ ok: false, codigo: "tipo_de_sistema_externo" });
  // Só a leitura do tipo: nenhuma jornada, ocupação ou Google consultados.
  expect(chamadas).toEqual(["from:calendar_event_types"]);
});
