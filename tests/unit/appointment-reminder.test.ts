import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(),
}));

import { sendAppointmentReminders } from "@/app/api/v1/cron/appointment-reminder/route";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";

const AGORA = new Date("2026-08-30T10:00:00.000Z");

interface ContactEntry {
  contact_id: string;
  channel_session_id: string;
  conversation_id: string;
  is_anonymized?: boolean;
}

/**
 * Dublê fiel ao builder do supabase-js: cada método de filtro (`eq`/`is`/
 * `lte`/`order`/`limit`) acumula estado e devolve o MESMO objeto encadeável;
 * `single`/`maybeSingle` resolvem de imediato (como no cliente real); sem
 * eles, o objeto é `thenable` — resolve só quando `await`ado (o caminho da
 * query de `appointments`, que não chama `.single()`).
 *
 * `maybeSingle` atende DUAS tabelas com o mesmo shape de builder: `contacts`
 * (nova query LGPD, filtra por `id`) e `conversations` (filtra por
 * `contact_id`) — branch em `table` pra cada uma devolver o fixture certo,
 * ambas lidas de `contactByLead` (mesma fixture, sem inventar dado novo).
 */
function makeAdminStub(
  appointments: { id: string; lead_id: string; organization_id: string; scheduled_at: string }[],
  contactByLead: Record<string, ContactEntry>,
) {
  const marcados: string[] = [];
  const inseridos: Record<string, unknown>[] = [];

  function buildChain(table: string) {
    const filtros: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filtros[col] = val;
        return chain;
      },
      is: () => chain,
      lte: () => chain,
      order: () => chain,
      limit: () => chain,
      single: () => {
        const entry = contactByLead[filtros.id as string];
        return Promise.resolve({
          data: entry ? { contact_id: entry.contact_id } : null,
          error: null,
        });
      },
      maybeSingle: () => {
        if (table === "contacts") {
          const contactId = filtros.id as string;
          const entry = Object.values(contactByLead).find((e) => e.contact_id === contactId);
          return Promise.resolve({
            data: entry
              ? { source: null, consent: null, is_anonymized: entry.is_anonymized === true }
              : null,
            error: null,
          });
        }
        const contactId = filtros.contact_id as string;
        const entry = Object.values(contactByLead).find((e) => e.contact_id === contactId);
        return Promise.resolve({
          data: entry ? { id: entry.conversation_id, channel_session_id: entry.channel_session_id } : null,
          error: null,
        });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: () => {
          if ("reminder_sent_at" in patch) marcados.push("reminder_sent_at");
          return Promise.resolve({ error: null });
        },
      }),
      insert: (row: Record<string, unknown>) => {
        inseridos.push(row);
        return Promise.resolve({ error: null });
      },
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        resolve({ data: table === "appointments" ? appointments : [], error: null });
      },
    };
    return chain;
  }

  const client = { from: (table: string) => buildChain(table) };
  return { client, marcados, inseridos };
}

describe("appointment-reminder — a regra", () => {
  it("envia via runBeforeSend, nunca um send direto", async () => {
    vi.mocked(runBeforeSend).mockResolvedValue({
      status: "sent",
      outcome: { kind: "sent", idempotencyKey: "k", messageId: "m" },
      trace: [],
    });
    const { client, marcados } = makeAdminStub(
      [{ id: "a1", lead_id: "lead-1", organization_id: "org-1", scheduled_at: "2026-08-31T10:00:00.000Z" }],
      { "lead-1": { contact_id: "contact-1", channel_session_id: "sess-1", conversation_id: "conv-1" } },
    );

    await sendAppointmentReminders(client as never, { connect: vi.fn(), query: vi.fn() } as never, AGORA);

    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(marcados).toEqual(["reminder_sent_at"]);
  });

  it("veto (STOP/janela/anti-ban) NÃO marca reminder_sent_at", async () => {
    vi.mocked(runBeforeSend).mockResolvedValue({
      status: "vetoed",
      gate: "stop",
      code: "contato_bloqueado",
      message: "bloqueado",
      trace: [],
    });
    const { client, marcados } = makeAdminStub(
      [{ id: "a1", lead_id: "lead-1", organization_id: "org-1", scheduled_at: "2026-08-31T10:00:00.000Z" }],
      { "lead-1": { contact_id: "contact-1", channel_session_id: "sess-1", conversation_id: "conv-1" } },
    );

    await sendAppointmentReminders(client as never, { connect: vi.fn(), query: vi.fn() } as never, AGORA);

    expect(marcados).toEqual([]);
  });

  it("contato anonimizado NÃO recebe lembrete — lgpdGate veta", async () => {
    vi.mocked(runBeforeSend).mockResolvedValue({
      status: "vetoed",
      gate: "lgpd",
      code: "lgpd_anonymized",
      message: "contato anonimizado",
      trace: [],
    });
    const { client, marcados } = makeAdminStub(
      [{ id: "a1", lead_id: "lead-1", organization_id: "org-1", scheduled_at: "2026-08-31T10:00:00.000Z" }],
      {
        "lead-1": {
          contact_id: "contact-1",
          channel_session_id: "sess-1",
          conversation_id: "conv-1",
          is_anonymized: true,
        },
      },
    );

    await sendAppointmentReminders(client as never, { connect: vi.fn(), query: vi.fn() } as never, AGORA);

    expect(marcados).toEqual([]);
    const calls = vi.mocked(runBeforeSend).mock.calls;
    const call = calls[calls.length - 1][0] as { lgpd: { isAnonymized: boolean } | null };
    expect(call.lgpd?.isAnonymized).toBe(true);
  });
});
