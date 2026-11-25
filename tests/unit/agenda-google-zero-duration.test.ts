// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncCalendar, diagnosticoDeErro } from "@/lib/agenda/google/calendar-executor";
import { doEventoDoGoogle } from "@/lib/agenda/google/evento";
import { reconcileAppointment, tokenForConnection } from "@/lib/agenda/google/sync-executor";
import { logger } from "@/lib/logger";

vi.mock("@/lib/agenda/google/sync-executor", () => ({
  reconcileAppointment: vi.fn(),
  tokenForConnection: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const org = "aaaaaaaa-0000-4000-8000-000000000001",
  id = "aaaaaaaa-0000-4000-8000-000000000002",
  connection = "aaaaaaaa-0000-4000-8000-000000000003";

const claim = {
  token: "aaaaaaaa-0000-4000-8000-000000000004",
  epoch: "7",
  lease_until: "2026-09-07T00:00:00Z",
};

const cursor = {
  generation: "aaaaaaaa-0000-4000-8000-000000000005",
  mode: "full",
  base_sync_token: null,
  page_token: null,
  window_start: "2026-09-01T00:00:00Z",
  window_end: "2026-12-01T00:00:00Z",
};

const normalEvent = {
  id: "normal-event-1",
  iCalUID: "normal@google.com",
  summary: "Reunião de Alinhamento",
  start: { dateTime: "2026-09-02T14:00:00-03:00" },
  end: { dateTime: "2026-09-02T15:00:00-03:00" },
};

const zeroDurationEvent = {
  id: "zero-duration-event-1",
  iCalUID: "zero@google.com",
  summary: "Ponto de Passagem",
  start: { dateTime: "2026-09-02T16:00:00-03:00" },
  end: { dateTime: "2026-09-02T16:00:00-03:00" },
};

let snapshot: Record<string, unknown>,
  actions: Array<{ action: string; args: Record<string, unknown> }>,
  batches: Array<Record<string, unknown>>,
  rpcErrorToThrow: Error | null;

function db() {
  return {
    rpc: async (_name: string, p: Record<string, unknown>) => {
      if (_name === "fn_google_calendar_page_batch") {
        if (rpcErrorToThrow) {
          throw rpcErrorToThrow;
        }
        const args = p.p_args as Record<string, unknown>;
        batches.push(args);
        return {
          data: {
            ...snapshot,
            sync_cursor: args.next_page_token ? { ...cursor, page_token: "next" } : null,
          },
          error: null,
        };
      }
      const action = String(p.p_action);
      actions.push({ action, args: p.p_args as Record<string, unknown> });
      return {
        data: action === "claim" ? snapshot : true,
        error: null,
      };
    },
    from: (table: string) => {
      const c = {
        select: () => c,
        eq: () => c,
        in: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({
          data: table === "organizations" ? { timezone: "America/Sao_Paulo" } : null,
          error: null,
        }),
      };
      return c;
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshot = {
    id,
    organization_id: org,
    connection_id: connection,
    external_calendar_id: "calendar",
    time_zone: "America/Sao_Paulo",
    claim,
    sync_cursor: { ...cursor },
  };
  actions = [];
  batches = [];
  rpcErrorToThrow = null;
  vi.mocked(tokenForConnection).mockResolvedValue("token");
  vi.mocked(reconcileAppointment).mockResolvedValue("processed");
});

describe("Issue #4915: eventos de duração zero na sincronização do Google", () => {
  it("lote com evento de duração zero e evento normal conclui ('complete') com o zero podado em prune_ids e apenas o normal em items", async () => {
    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [normalEvent, zeroDurationEvent],
          nextSyncToken: "new",
        }),
      ),
    );

    const outcome = await syncCalendar(db(), org, id, transport);

    expect(outcome).toBe("complete");
    expect(batches).toHaveLength(1);

    const batch = batches[0]!;
    // Apenas o evento normal está em items
    expect(batch.items).toHaveLength(1);
    expect((batch.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      external_event_id: normalEvent.id,
      starts_at: "2026-09-02T17:00:00.000Z",
      ends_at: "2026-09-02T18:00:00.000Z",
    });

    // O evento de duração zero foi podado em prune_ids e não consta em items
    expect(batch.prune_ids).toContain(zeroDurationEvent.id);
    const itemIds = (batch.items as Array<Record<string, unknown>>).map(
      (it) => it.external_event_id,
    );
    expect(itemIds).not.toContain(zeroDurationEvent.id);
  });

  it("doEventoDoGoogle não converte evento de duração zero para 'cancelado' (evita cancelamento espúrio no sync-model)", () => {
    const resultado = doEventoDoGoogle(zeroDurationEvent, {
      fusoDoCalendario: "America/Sao_Paulo",
    });

    expect(resultado.tipo).toBe("evento");
    expect(resultado.tipo).not.toBe("cancelado");
  });

  it("evento recusado chega à TELA com o dia e a hora de parede dele, sem título nem pessoa", async () => {
    // Fim antes do início: doEventoDoGoogle recusa (não é duração zero, que é podada).
    const eventoInvertido = {
      id: "evento-invertido",
      summary: "Segredo Confidencial do Cliente Fulano",
      start: { dateTime: "2026-09-02T16:00:00-03:00" },
      end: { dateTime: "2026-09-02T15:00:00-03:00" },
      creator: { displayName: "Maria Souza", email: "maria@empresa.test" },
    };
    const transport = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [eventoInvertido], nextSyncToken: "new" })),
      );

    expect(await syncCalendar(db(), org, id, transport)).toBe("failed");

    // O que a tela mostra é a mensagem gravada pela ação "error" — não o erro lançado.
    const gravada = String(actions.find((a) => a.action === "error")!.args.message);
    expect(gravada).toContain("02/09/2026 às 16:00");
    // O motivo cru do parser é para o log; a tela não mostra código técnico.
    expect(gravada).not.toContain("instante_invalido");
    expect(gravada).not.toContain("A leitura não terminou");
    expect(gravada).not.toContain("Segredo Confidencial");
    expect(gravada).not.toContain("Fulano");
    expect(gravada).not.toContain("Maria");
    expect(gravada).not.toContain("maria@empresa.test");
    expect(batches).toHaveLength(0);
  });

  it("evento de dia inteiro recusado chega à tela só com o dia", async () => {
    // `start.date` sem `end.date`: o parser recusa; não há hora para mostrar.
    const diaInteiroSemFim = {
      id: "dia-inteiro-sem-fim",
      summary: "Folga da Maria",
      start: { date: "2026-10-05" },
      end: {},
    };
    const transport = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [diaInteiroSemFim], nextSyncToken: "new" })),
      );

    expect(await syncCalendar(db(), org, id, transport)).toBe("failed");

    const gravada = String(actions.find((a) => a.action === "error")!.args.message);
    expect(gravada).toContain("O evento de 05/10/2026 tem horário");
    expect(gravada).not.toContain("Maria");
  });

  it("no catch de syncCalendar, grava logger.warn com class, code e constraint, sem texto livre de erro", async () => {
    // Simula erro de constraint violada do PostgreSQL retornado por fn_google_calendar_page_batch
    rpcErrorToThrow = Object.assign(
      new Error(
        'new row for relation "calendar_external_events" violates check constraint "calendar_external_events_periodo_valido"',
      ),
      {
        code: "23514",
        details: "Failing row contains (ends_at <= starts_at).",
      },
    );

    const transport = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [normalEvent],
          nextSyncToken: "new",
        }),
      ),
    );

    const outcome = await syncCalendar(db(), org, id, transport);
    expect(outcome).toBe("failed");

    expect(logger.warn).toHaveBeenCalledWith(
      "[agenda.google.sync] leitura da agenda falhou",
      {
        class: "23",
        code: "23514",
        constraint: "calendar_external_events_periodo_valido",
        // #5109: a frase da tela também vai para o log — sanitizada, nunca `e.message`.
        message: "A leitura não terminou. Tente sincronizar novamente nas configurações.",
      },
    );

    // Garante que o texto livre de erro (mensagem crua) NÃO foi incluído no logger.warn
    const warnArgs = vi.mocked(logger.warn).mock.calls[0]![1] as Record<string, unknown>;
    const logStr = JSON.stringify(warnArgs);
    expect(logStr).not.toContain("violates check constraint");
    expect(logStr).not.toContain("Failing row contains");
  });

  it("diagnosticoDeErro extrai classe, código e constraint de erros do banco e tolera erros genéricos sem texto livre", () => {
    const dbErr = Object.assign(
      new Error(
        'new row for relation "calendar_external_events" violates check constraint "calendar_external_events_periodo_valido"',
      ),
      { code: "23514" },
    );
    expect(diagnosticoDeErro(dbErr)).toEqual({
      class: "23",
      code: "23514",
      constraint: "calendar_external_events_periodo_valido",
    });

    const uniqueErr = Object.assign(
      new Error('duplicate key value violates unique constraint "uniq_contacts_org_cpf"'),
      { code: "23505", constraint: "uniq_contacts_org_cpf" },
    );
    expect(diagnosticoDeErro(uniqueErr)).toEqual({
      class: "23",
      code: "23505",
      constraint: "uniq_contacts_org_cpf",
    });

    const genericErr = new Error("Network timeout: failed to fetch");
    expect(diagnosticoDeErro(genericErr)).toEqual({
      class: null,
      code: null,
      constraint: null,
    });
  });
});
