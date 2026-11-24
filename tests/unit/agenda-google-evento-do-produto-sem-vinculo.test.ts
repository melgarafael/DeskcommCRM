// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncCalendar } from "@/lib/agenda/google/calendar-executor";
import { idDeEventoDoGoogle } from "@/lib/agenda/google/escrita";
import { reconcileAppointment, tokenForConnection } from "@/lib/agenda/google/sync-executor";
import { logger } from "@/lib/logger";

/**
 * Issue #5109 — evento do produto sem compromisso no banco não pode travar a
 * leitura da agenda para sempre.
 *
 * O buraco: a leitura lançava "Evento do produto sem vínculo" ANTES do ramo que
 * trata `cancelado`. Quando o compromisso que publicou o evento foi excluído
 * (o `calendar_appointments` some junto), a lápide `status: "cancelled"` que o
 * Google devolve ficava sem par e a página inteira falhava — para sempre, a
 * cada tentativa, inclusive na leitura completa. Como era um `Error` comum, a
 * tela repetia "A leitura não terminou" e o log não levava a frase real.
 *
 * O que se mede aqui é o desfecho da página e o que fica gravado na tela e no
 * log — nunca o texto livre do evento (título, pessoa).
 */

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

const eventoPessoal = {
  id: "evento-pessoal-1",
  iCalUID: "pessoal@google.com",
  summary: "Reunião de Alinhamento",
  start: { dateTime: "2026-09-02T14:00:00-03:00" },
  end: { dateTime: "2026-09-02T15:00:00-03:00" },
};

/** Lápide do produto: o compromisso foi excluído, o vínculo não existe mais. */
const lapideDoProdutoSemVinculo = {
  id: idDeEventoDoGoogle("11111111-1111-4111-8111-111111111111"),
  status: "cancelled",
};

/** Evento do produto ainda ATIVO: continua ocupando horário, não há o que podar. */
const ativoDoProdutoSemVinculo = {
  id: idDeEventoDoGoogle("22222222-2222-4222-8222-222222222222"),
  status: "confirmed",
  summary: "Consulta da Maria Souza",
  attendees: [{ email: "maria.souza@exemplo.test", displayName: "Maria Souza" }],
  start: { dateTime: "2026-09-02T16:00:00-03:00" },
  end: { dateTime: "2026-09-02T17:00:00-03:00" },
};

let snapshot: Record<string, unknown>,
  actions: Array<{ action: string; args: Record<string, unknown> }>,
  batches: Array<Record<string, unknown>>;

function db() {
  return {
    rpc: async (_name: string, p: Record<string, unknown>) => {
      if (_name === "fn_google_calendar_page_batch") {
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
      return { data: action === "claim" ? snapshot : true, error: null };
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

function transport(items: unknown[]) {
  return vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ items, nextSyncToken: "new" })));
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
  vi.mocked(tokenForConnection).mockResolvedValue("token");
  vi.mocked(reconcileAppointment).mockResolvedValue("processed");
});

describe("Issue #5109: evento do produto sem compromisso no banco", () => {
  it("lápide cancelada sem vínculo é podada e a leitura conclui, em vez de falhar para sempre", async () => {
    const outcome = await syncCalendar(
      db(),
      org,
      id,
      transport([eventoPessoal, lapideDoProdutoSemVinculo]),
    );

    expect(outcome).toBe("complete");
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.prune_ids).toContain(lapideDoProdutoSemVinculo.id);
    const itens = batch.items as Array<Record<string, unknown>>;
    expect(itens.map((i) => i.external_event_id)).not.toContain(lapideDoProdutoSemVinculo.id);
    // A leitura que antes travava agora guarda o evento normal e conclui.
    expect(itens.map((i) => i.external_event_id)).toContain(eventoPessoal.id);
    // Sem recusa: nada de frase genérica persistida.
    expect(actions.some((a) => a.action === "error")).toBe(false);
  });

  it("evento do produto ATIVO sem vínculo continua recusando, mas nomeia dia e hora em vez da frase genérica", async () => {
    const outcome = await syncCalendar(db(), org, id, transport([ativoDoProdutoSemVinculo]));

    expect(outcome).toBe("failed");
    expect(batches).toHaveLength(0);
    const recusa = actions.find((a) => a.action === "error");
    expect(recusa).toBeDefined();
    const gravada = String(recusa!.args.message);
    // Diz QUAL evento corrigir: dia e hora de parede, como a tela do Google mostra.
    expect(gravada).toContain("02/09/2026 às 16:00");
    expect(gravada).not.toContain("A leitura não terminou");
    // Nada do conteúdo do evento (título, convidado) viaja para a tela.
    expect(gravada).not.toContain("Maria");
    expect(gravada).not.toContain("Consulta");
    expect(gravada).not.toContain("@");
  });

  it("a mensagem diagnóstica chega ao log, e o log continua sem texto livre", async () => {
    await syncCalendar(db(), org, id, transport([ativoDoProdutoSemVinculo]));

    const [marcador, campos] = vi.mocked(logger.warn).mock.calls.at(-1)!;
    expect(marcador).toBe("[agenda.google.sync] leitura da agenda falhou");
    expect(campos).toMatchObject({ message: expect.stringContaining("02/09/2026 às 16:00") });
    const logStr = JSON.stringify(campos);
    expect(logStr).not.toContain("Maria");
    expect(logStr).not.toContain("Consulta");
    expect(logStr).not.toContain("@");
  });

  it("lápide cancelada de evento PESSOAL continua entrando como cancelada (regressão)", async () => {
    const lapidePessoal = { id: "evento-pessoal-cancelado", status: "cancelled" };
    const outcome = await syncCalendar(db(), org, id, transport([lapidePessoal]));

    expect(outcome).toBe("complete");
    expect(batches).toHaveLength(1);
    expect((batches[0]!.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      external_event_id: lapidePessoal.id,
      status: "cancelled",
    });
  });
});
