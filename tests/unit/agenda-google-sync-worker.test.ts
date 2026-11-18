import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncCalendar } from "@/lib/agenda/google/calendar-executor";
import { reconcileAppointment, tokenForConnection } from "@/lib/agenda/google/sync-executor";
import { idDeEventoDoGoogle } from "@/lib/agenda/google/escrita";
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: log }));
vi.mock("@/lib/agenda/google/sync-executor", () => ({
  reconcileAppointment: vi.fn(),
  tokenForConnection: vi.fn(),
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
const event = {
  id: "third-party",
  iCalUID: "third@google.com",
  summary: "Privado",
  start: { dateTime: "2026-09-02T14:00:00-03:00" },
  end: { dateTime: "2026-09-02T15:00:00-03:00" },
};
let snapshot: Record<string, unknown>,
  actions: Array<{ action: string; args: Record<string, unknown> }>,
  batches: Array<Record<string, unknown>>,
  consultasDeVinculo: number[],
  linked: { id: string; google_event_id: string } | null,
  falhaNoLote: Error | null,
  transport: ReturnType<typeof vi.fn<typeof fetch>>;
function db() {
  return {
    rpc: async (_name: string, p: Record<string, unknown>) => {
      if (_name === "fn_google_calendar_page_batch") {
        if (falhaNoLote) throw falhaNoLote;
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
        data:
          action === "claim"
            ? snapshot
            : true,
        error: null,
      };
    },
    from: (table: string) => {
      const c = {
        select: () => c,
        eq: () => c,
        in: async (_k: string, ids: string[]) => {
          consultasDeVinculo.push(ids.length);
          return { data: linked ? [linked] : [], error: null };
        },
        maybeSingle: async () => ({ data: linked, error: null }),
        single: async () => ({
          data: table === "organizations" ? { timezone: "America/Manaus" } : null,
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
  consultasDeVinculo = [];
  linked = null;
  falhaNoLote = null;
  transport = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ items: [event], nextSyncToken: "new" })));
  vi.mocked(tokenForConnection).mockResolvedValue("token");
  vi.mocked(reconcileAppointment).mockResolvedValue("processed");
});
const item = () => batches[0]?.items && (batches[0].items as unknown[])[0];
describe("leitura paginada sob claim original", () => {
  it("traduz terceiro sem duplicar título pessoal e só conclui após itens", async () => {
    expect(await syncCalendar(db(), org, id, transport)).toBe("complete");
    expect(item()).toMatchObject({
      external_event_id: event.id,
      starts_at: "2026-09-02T17:00:00.000Z",
      title: null,
      transparency: "opaque",
      ical_uid: event.iCalUID,
    });
    expect(actions.map((a) => a.action)).toEqual(["claim", "release"]);
  });
  it("sem fuso de calendário usa organização, inclusive dia inteiro", async () => {
    snapshot.time_zone = null;
    transport.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ ...event, start: { date: "2026-09-02" }, end: { date: "2026-09-03" } }],
          nextSyncToken: "new",
        }),
      ),
    );
    await syncCalendar(db(), org, id, transport);
    expect(item()).toMatchObject({ starts_at: "2026-09-02T04:00:00.000Z" });
  });
  it("tupla ligada reconcilia antes de remover ocupação duplicada, mesmo tombstone", async () => {
    linked = { id: "appointment", google_event_id: event.id };
    transport.mockResolvedValue(
      new Response(
        JSON.stringify({ items: [{ id: event.id, status: "cancelled" }], nextSyncToken: "new" }),
      ),
    );
    await syncCalendar(db(), org, id, transport);
    expect(reconcileAppointment).toHaveBeenCalledWith(
      expect.anything(),
      org,
      "appointment",
      expect.objectContaining({
        calendarFence: { id, claim, cursor },
        remote: { id: event.id, status: "cancelled" },
      }),
    );
    expect(batches[0]?.prune_ids).toEqual([event.id]);
  });
  it("prefixo sem tupla é problema visível, nunca silêncio por anti-eco", async () => {
    transport.mockResolvedValue(
      new Response(
        JSON.stringify({ items: [{ ...event, id: idDeEventoDoGoogle(id) }], nextSyncToken: "new" }),
      ),
    );
    expect(await syncCalendar(db(), org, id, transport)).toBe("failed");
    expect(actions.some((a) => a.action === "error")).toBe(true);
    expect(batches).toHaveLength(0);
  });
  it("cancelamento de terceiro preserva lápide sem horários", async () => {
    transport.mockResolvedValue(
      new Response(
        JSON.stringify({ items: [{ id: "deleted", status: "cancelled" }], nextSyncToken: "new" }),
      ),
    );
    await syncCalendar(db(), org, id, transport);
    expect(item()).toMatchObject({ external_event_id: "deleted", status: "cancelled" });
  });
  it("410 invalida ciclo com fence e agenda reconstrução sem falso fim", async () => {
    transport.mockResolvedValue(new Response("{}", { status: 410 }));
    expect(await syncCalendar(db(), org, id, transport)).toBe("failed");
    expect(actions.map((a) => a.action)).toEqual(["claim", "reset", "release"]);
    expect(actions[1]!.args).toEqual({ claim, cursor });
  });
  it("mestre de série impede avanço e prune", async () => {
    transport.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ ...event, recurrence: ["RRULE:FREQ=WEEKLY"] }],
          nextSyncToken: "new",
        }),
      ),
    );
    expect(await syncCalendar(db(), org, id, transport)).toBe("failed");
    expect(item()).toBeUndefined();
    expect(batches).toHaveLength(0);
  });
  it("cifra indisponível não faz HTTP nem grava cache", async () => {
    vi.mocked(tokenForConnection).mockRejectedValue(new Error("cipher unavailable"));
    expect(await syncCalendar(db(), org, id, transport)).toBe("failed");
    expect(transport).not.toHaveBeenCalled();
    expect(item()).toBeUndefined();
  });
  it("página vazia parcial não conclui cobertura; próxima página mantém aquisição", async () => {
    transport.mockResolvedValue(new Response(JSON.stringify({ items: [], nextPageToken: "next" })));
    expect(await syncCalendar(db(), org, id, transport)).toBe("partial");
    expect(batches[0]).toEqual({
      claim,
      cursor,
      items: [],
      prune_ids: [],
      next_page_token: "next",
      next_sync_token: null,
    });
  });
  it("incremental não vira full por página vazia", async () => {
    snapshot.sync_cursor = { ...cursor, mode: "incremental", base_sync_token: "original" };
    transport.mockResolvedValue(new Response(JSON.stringify({ items: [], nextSyncToken: "next" })));
    await syncCalendar(db(), org, id, transport);
    expect(String(transport.mock.calls[0]![0])).toContain("syncToken=original");
    expect(String(transport.mock.calls[0]![0])).not.toContain("timeMin");
    expect(batches[0]!.cursor).toEqual(snapshot.sync_cursor);
  });
  it("compromisso ocupado por outro claim impede checkpoint de página", async () => {
    linked = { id: "appointment", google_event_id: event.id };
    vi.mocked(reconcileAppointment).mockResolvedValue("busy");
    expect(await syncCalendar(db(), org, id, transport)).toBe("deferred");
    expect(batches).toHaveLength(0);
    expect(actions.map((a) => a.action)).toEqual(["claim", "renew", "release"]);
  });
  it("todos os writes carregam claim recebido, sem recuperação de token novo", async () => {
    await syncCalendar(db(), org, id, transport);
    for (const action of actions.filter((a) => a.action !== "claim")) {
      expect(action.args.claim).toEqual(claim);
    }
    expect(batches[0]!.cursor).toEqual(cursor);
  });
  it("página cheia consulta os vínculos em blocos de até 50 ids", async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({ ...event, id: `${event.id}-${i}` }));
    transport.mockResolvedValue(new Response(JSON.stringify({ items, nextSyncToken: "new" })));
    expect(await syncCalendar(db(), org, id, transport)).toBe("complete");
    expect(consultasDeVinculo).toEqual([50, 50, 20]);
    expect(batches[0]!.items).toHaveLength(120);
  });
  it("evento de duração zero é podado e não derruba a página inteira", async () => {
    // O CHECK `calendar_external_events_periodo_valido` exige ends_at > starts_at:
    // um evento de terceiro com início igual ao fim recusava o LOTE inteiro e a
    // leitura relia a mesma página para sempre. Duração zero não ocupa horário.
    const duracaoZero = {
      ...event,
      id: "terceiro-duracao-zero",
      start: { dateTime: "2026-09-03T09:00:00-03:00" },
      end: { dateTime: "2026-09-03T09:00:00-03:00" },
    };
    transport.mockResolvedValue(
      new Response(JSON.stringify({ items: [duracaoZero, event], nextSyncToken: "new" })),
    );
    expect(await syncCalendar(db(), org, id, transport)).toBe("complete");
    expect(batches[0]?.prune_ids).toEqual(["terceiro-duracao-zero"]);
    expect(
      (batches[0]!.items as Array<{ external_event_id: string }>).map((i) => i.external_event_id),
    ).toEqual([event.id]);
  });
  it("evento recusado diz a data e a hora dele, sem título nem pessoa", async () => {
    transport.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              ...event,
              id: "terceiro-ilegivel",
              summary: "Consulta de rotina da Maria",
              attendees: [
                { email: "maria.souza@exemplo.test", displayName: "Maria Souza", self: false },
              ],
              start: { dateTime: "2026-09-02T14:00:00-03:00" },
              end: { dateTime: "2026-09-02T13:00:00-03:00" },
            },
          ],
          nextSyncToken: "new",
        }),
      ),
    );
    expect(await syncCalendar(db(), org, id, transport)).toBe("failed");
    const erro = actions.find((a) => a.action === "error")!;
    const mensagem = String(erro.args.message);
    expect(mensagem).toContain("02/09/2026");
    expect(mensagem).toContain("14:00");
    expect(mensagem).toContain("instante_invalido");
    expect(mensagem).not.toContain("Consulta de rotina");
    expect(mensagem).not.toContain("Maria");
    expect(mensagem).not.toContain("maria.souza");
    expect(batches).toHaveLength(0);
  });
  it("recusa do banco vai ao log por classe, código e restrição, sem texto livre", async () => {
    falhaNoLote = Object.assign(
      new Error(
        'new row for relation "calendar_external_events" violates check constraint "calendar_external_events_periodo_valido"',
      ),
      { code: "23514" },
    );
    expect(await syncCalendar(db(), org, id, transport)).toBe("failed");
    const [, contexto] = log.warn.mock.calls[0]!;
    expect(contexto).toEqual({
      classe: "Error",
      codigo: "23514",
      restricao: "calendar_external_events_periodo_valido",
    });
    expect(JSON.stringify(contexto)).not.toContain("new row for relation");
    expect(actions.map((a) => a.action)).toEqual(["claim", "error", "release"]);
  });
});
