import { beforeEach, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

const consulta = vi.hoisted(() => ({
  horarios: vi.fn(async (db: unknown, _org: string, intervalo: { de: Date; ate: Date }) => ({
    ok: true,
    publicouHorarios: true,
    fusoDaRegra: "America/Sao_Paulo",
    slots:
      (db as { ocupadoEm?: (inicio: Date) => boolean }).ocupadoEm?.(intervalo.de) === true
        ? []
        : [{ inicio: intervalo.de, fim: intervalo.ate }],
  })),
  ocupacao: vi.fn(async () => ({ ok: true, ocupados: [] })),
}));
vi.mock("@/lib/agenda/consulta", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  horariosLivresDaOrg: consulta.horarios,
  coletaOQueOcupa: consulta.ocupacao,
}));

import { marcarAgendamentoHandler } from "@/app/api/v1/agenda/agendamentos/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const ORG = "00000000-0000-4000-8000-000000000001";
const TIPO = "00000000-0000-4000-8000-0000000000dd";
const DONO = "00000000-0000-4000-8000-0000000000aa";
const INICIO = "2026-09-21T13:00:00.000Z";
const OUTRO_INICIO = "2026-09-21T14:00:00.000Z";

function bancoDeTeste() {
  const recibos: Array<Record<string, unknown>> = [];
  const inseridos: Array<Record<string, unknown>> = [];
  let sequencia = 0;
  const tipo = {
    id: TIPO,
    name: "Consulta",
    is_active: true,
    duration_minutes: 30,
    default_owner_user_id: DONO,
    requires_confirmation: false,
    location_kind: "none",
    location_details: null,
  };

  const casa = (linha: Record<string, unknown>, filtros: Array<[string, unknown]>) =>
    filtros.every(([campo, valor]) => String(linha[campo]) === String(valor));
  const limites: Array<[string, unknown]> = [];

  const db = {
    ocupadoEm: (inicio: Date) =>
      inseridos.some((linha) => new Date(String(linha.starts_at)).getTime() === inicio.getTime()),
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      const q: Record<string, (...args: never[]) => unknown> = {};
      q.select = (() => q) as never;
      q.eq = ((campo: string, valor: unknown) => {
        filtros.push([campo, valor]);
        return q;
      }) as never;
      q.gt = ((campo: string, valor: unknown) => {
        limites.push([campo, valor]);
        return q;
      }) as never;
      q.maybeSingle = (async () => ({
        data:
          tabela === "calendar_event_types"
            ? tipo
            : (recibos.find(
                (linha) =>
                  casa(linha, filtros) &&
                  limites.every(([campo, valor]) => String(linha[campo]) > String(valor)),
              ) ?? null),
        error: null,
      })) as never;
      q.insert = ((linha: Record<string, unknown>) => {
        if (tabela === "idempotency_keys") {
          const existente = recibos.some(
            (r) =>
              r.organization_id === linha.organization_id &&
              r.key === linha.key &&
              r.endpoint === linha.endpoint,
          );
          if (existente) {
            return Promise.resolve({ data: null, error: { code: "23505" } });
          }
          recibos.push({ ...linha, id: `receipt-${recibos.length + 1}` });
          return Promise.resolve({ data: null, error: null });
        }

        if (tabela === "calendar_appointments") {
          inseridos.push(linha);
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: `appointment-${++sequencia}`,
                  starts_at: linha.starts_at,
                  ends_at: linha.ends_at,
                  status: linha.status,
                  time_zone: linha.time_zone,
                  revision: 1,
                  meeting_state: "none",
                  meeting_url: null,
                },
                error: null,
              }),
            }),
          };
        }
        return Promise.resolve({ data: null, error: null });
      }) as never;
      q.update = ((patch: Record<string, unknown>) => {
        const atualizar = () => {
          const linha = recibos.find((item) => casa(item, filtros));
          if (linha) Object.assign(linha, patch);
          return linha;
        };
        const update: Record<string, (...args: never[]) => unknown> = {};
        update.eq = ((campo: string, valor: unknown) => {
          filtros.push([campo, valor]);
          return update;
        }) as never;
        update.select = (() => update) as never;
        update.maybeSingle = (async () => ({
          data: atualizar() ? { id: "receipt" } : null,
          error: null,
        })) as never;
        update.then = ((resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: atualizar(), error: null }).then(resolve)) as never;
        return update;
      }) as never;
      return q;
    },
    async rpc() {
      return { data: null, error: null };
    },
  };

  return { db: db as unknown as SupabaseClient, inseridos, recibos };
}

const ctxDaIA = (sourceJobId: string): HandlerCtx =>
  ({
    organization_id: ORG,
    requestId: sourceJobId,
    sourceJobId,
    actor: { type: "ai_agent", id: sourceJobId, role: "ai_operator" },
  }) as unknown as HandlerCtx;

const ctxComChave = (idempotencyKey: string): HandlerCtx =>
  ({
    organization_id: ORG,
    requestId: "req-external",
    idempotencyKey,
    actor: { type: "ai_agent", id: "external-agent", role: "ai_operator" },
  }) as unknown as HandlerCtx;

const pedidoDe = (starts_at: string) => ({ event_type_id: TIPO, starts_at });

beforeEach(() => {
  vi.resetAllMocks();
  consulta.horarios.mockImplementation(async (db, _org, intervalo) => ({
    ok: true,
    publicouHorarios: true,
    fusoDaRegra: "America/Sao_Paulo",
    slots:
      (db as { ocupadoEm?: (inicio: Date) => boolean }).ocupadoEm?.(intervalo.de) === true
        ? []
        : [{ inicio: intervalo.de, fim: intervalo.ate }],
  }));
  consulta.ocupacao.mockResolvedValue({ ok: true, ocupados: [] });
});

it("retry da mesma operação de agente reutiliza o agendamento e o recibo original", async () => {
  const banco = bancoDeTeste();
  const ctx = ctxDaIA("00000000-0000-4000-8000-0000000000bb");
  const input = pedidoDe(INICIO);

  const primeira = await marcarAgendamentoHandler(banco.db, ctx, input);
  const repetida = await marcarAgendamentoHandler(banco.db, ctx, input);

  expect(primeira).toEqual(repetida);
  expect(primeira.id).toBe("appointment-1");
  expect(banco.inseridos).toHaveLength(1);
  expect(banco.recibos).toHaveLength(1);
});

it("duas intenções com horários diferentes no mesmo job criam agendamentos distintos", async () => {
  const banco = bancoDeTeste();
  const ctx = ctxDaIA("00000000-0000-4000-8000-0000000000bb");

  const primeiro = await marcarAgendamentoHandler(banco.db, ctx, pedidoDe(INICIO));
  const segundo = await marcarAgendamentoHandler(banco.db, ctx, pedidoDe(OUTRO_INICIO));

  expect(primeiro.id).toBe("appointment-1");
  expect(segundo.id).toBe("appointment-2");
  expect(banco.inseridos).toHaveLength(2);
  expect(banco.recibos).toHaveLength(2);
});

it("Idempotency-Key repetida com outro conteúdo devolve conflito sem gravar", async () => {
  const banco = bancoDeTeste();
  const ctx = ctxComChave("00000000-0000-4000-8000-0000000000cc");

  await marcarAgendamentoHandler(banco.db, ctx, pedidoDe(INICIO));
  await expect(
    marcarAgendamentoHandler(banco.db, ctx, pedidoDe(OUTRO_INICIO)),
  ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });

  expect(banco.inseridos).toHaveLength(1);
  expect(banco.recibos).toHaveLength(1);
});
