import { describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, ChannelSendInput } from "@/lib/agent-engine/channel-adapter";
import { executeCatalogPresentationSerial } from "@/lib/catalogo/executor-de-apresentacao";
import {
  planCatalogPresentation,
  type CatalogPresentationPlan,
  type ResolvedCatalogPresentation,
} from "@/lib/catalogo/plano-de-apresentacao";
import type { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { reconcileAcceptedSend } from "@/lib/agent-engine/edge/crm/send-ledger";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const LEAD = "bbbbbbbb-0000-4000-8000-000000000001";
const JOB = "cccccccc-0000-4000-8000-000000000001";
const CONVERSATION = "dddddddd-0000-4000-8000-000000000001";
const SESSION = "eeeeeeee-0000-4000-8000-000000000001";

function product(
  code: string,
  overrides: Partial<ResolvedCatalogPresentation> = {},
): ResolvedCatalogPresentation {
  return {
    product_id: `id-${code}`,
    product_code: code,
    product_name: `Apartamento ${code}`,
    price_cents: 900_000_00,
    currency: "BRL",
    photo_storage_paths: [],
    presentation: {
      enabled: true,
      kind: "text",
      title: null,
      text_content: `Descrição ${code}`,
      use_catalog_photos: false,
      show_price: false,
      audio_storage_path: null,
      audio_mime: null,
    },
    ...overrides,
  };
}

function audioProduct(code: string): ResolvedCatalogPresentation {
  const item = product(code);
  if (!item.presentation) throw new Error("fixture sem apresentação");
  item.presentation = {
    ...item.presentation,
    kind: "audio",
    text_content: null,
    audio_storage_path: `${ORG}/${item.product_id}/apresentacao.ogg`,
    audio_mime: "audio/ogg;codecs=opus",
  };
  return item;
}

function plan(codes: string[], items: ResolvedCatalogPresentation[]): CatalogPresentationPlan {
  const result = planCatalogPresentation({
    ordered_product_codes: codes,
    resolved_items: items,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.plan;
}

function fixture(
  options: {
    outcomes?: Array<"sent" | "already_sent" | "queued" | "blocked" | "failed" | "unavailable">;
    reconciledSeqs?: number[];
  } = {},
) {
  const events: string[] = [];
  const sent: ChannelSendInput[] = [];
  let outcomeIndex = 0;
  const channel: ChannelAdapter = {
    channel: "test",
    async send(input) {
      sent.push(input);
      events.push(`channel:${input.seq}:${input.media?.kind ?? "text"}`);
      const kind = options.outcomes?.[outcomeIndex++] ?? "sent";
      if (kind === "unavailable") return { kind, reason: "test" };
      if (kind === "blocked") return { kind, idempotencyKey: `key-${input.seq}` };
      return {
        kind,
        idempotencyKey: `key-${input.seq}`,
        messageId: `message-${input.seq}`,
      };
    },
    async sessionHealth() {
      return { healthy: true, status: "WORKING", since: null };
    },
    capabilities() {
      return { freeformAnytime: true, serviceWindowHours: null };
    },
    costPerMessage() {
      return { perMessageUsdCents: 0, model: "flat" };
    },
  };
  const beforeSend = vi.fn(async (args: Parameters<typeof runBeforeSend>[0]) => {
    events.push(`guard:${args.body}`);
    return { status: "sent" as const, outcome: await args.send(args.body), trace: [] };
  }) as unknown as typeof runBeforeSend;
  const reconcile = vi.fn(async (_db, input: { seq: number }) => {
    events.push(`ledger:${input.seq}`);
    return options.reconciledSeqs?.includes(input.seq) ?? false;
  }) as unknown as typeof reconcileAcceptedSend;
  const materializeMedia = vi.fn(async (payload: { item_index: number; step_index: number }) => {
    events.push(`media:${payload.item_index}:${payload.step_index}`);
    return { storagePath: `${ORG}/${CONVERSATION}/${payload.item_index}-${payload.step_index}` };
  });

  return {
    events,
    sent,
    channel,
    beforeSend,
    reconcile,
    materializeMedia,
    args: {
      channel,
      conversationId: CONVERSATION,
      sendsAlreadyCounted: 0,
      maxSendsPerTurn: 10,
      materializeMedia: materializeMedia as never,
      beforeSend: {
        pool: {},
        log: {},
        tenantId: ORG,
        leadId: LEAD,
        jobId: JOB,
        channelSessionId: SESSION,
        optedOutThisTurn: false,
        crmDailyLimit: null,
        now: new Date("2026-10-14T12:00:00.000Z"),
      } as never,
      contracts: { beforeSend, reconcileAcceptedSend: reconcile },
    },
  };
}

describe("executor serial da apresentação do catálogo", () => {
  it("pausa entre mensagens do mesmo produto sem iniciar a mídia seguinte", async () => {
    const f = fixture();
    let checks = 0;
    const result = await executeCatalogPresentationSerial(plan(["A"], [audioProduct("A")]), {
      ...f.args,
      pausedBeforeSend: async () => ++checks > 1,
    });
    expect(result).toMatchObject({
      status: "stopped",
      reason: "interrupted",
      next_item_index: 0,
      next_seq: 2,
    });
    expect(f.sent.map((input) => input.seq)).toEqual([1]);
    expect(f.materializeMedia).not.toHaveBeenCalled();
    expect(f.events).toEqual(["ledger:1", "guard:Apartamento A", "channel:1:text"]);
  });

  it("preserva ordem, reconcilia ledger antes do guardrail e mantém áudio como áudio", async () => {
    const center = product("CENTRO");
    const gardens = audioProduct("JARDINS");
    const f = fixture();

    const result = await executeCatalogPresentationSerial(
      plan(["CENTRO", "JARDINS"], [gardens, center]),
      f.args,
    );

    expect(result.status).toBe("completed");
    expect(f.sent.map((input) => [input.seq, input.body, input.media?.kind])).toEqual([
      [1, "Apartamento CENTRO\n\nDescrição CENTRO", undefined],
      [2, "Apartamento JARDINS", undefined],
      [3, "", "audio"],
    ]);
    expect(f.sent[2]?.media).toEqual({
      kind: "audio",
      storagePath: `${ORG}/${CONVERSATION}/1-1`,
      mime: "audio/ogg;codecs=opus",
    });
    expect(f.events).toEqual([
      "ledger:1",
      "guard:Apartamento CENTRO\n\nDescrição CENTRO",
      "channel:1:text",
      "ledger:2",
      "guard:Apartamento JARDINS",
      "channel:2:text",
      "ledger:3",
      "guard:",
      "media:1:1",
      "channel:3:audio",
    ]);
  });

  it("faz preflight do teto antes de ledger, guardrail, mídia ou canal", async () => {
    const f = fixture();
    f.args.maxSendsPerTurn = 1;

    const result = await executeCatalogPresentationSerial(
      plan(["JARDINS"], [audioProduct("JARDINS")]),
      f.args,
    );

    expect(result).toMatchObject({
      status: "not_started",
      reason: "max_sends_per_turn",
      required: 2,
      remaining: 1,
      steps: [],
    });
    expect(f.events).toEqual([]);
    expect(f.materializeMedia).not.toHaveBeenCalled();
  });

  it("para no queued e não inicia o próximo payload", async () => {
    const f = fixture({ outcomes: ["sent", "queued", "sent"] });

    const result = await executeCatalogPresentationSerial(
      plan(["A", "B", "C"], [product("A"), product("B"), product("C")]),
      f.args,
    );

    expect(result).toMatchObject({ status: "stopped", reason: "queued", next_seq: 2 });
    expect(f.sent.map((input) => input.body)).toEqual([
      "Apartamento A\n\nDescrição A",
      "Apartamento B\n\nDescrição B",
    ]);
  });

  it.each(["blocked", "failed", "unavailable"] as const)(
    "para no primeiro desfecho %s",
    async (failure) => {
      const f = fixture({ outcomes: [failure, "sent"] });

      const result = await executeCatalogPresentationSerial(
        plan(["A", "B"], [product("A"), product("B")]),
        f.args,
      );

      expect(result).toMatchObject({ status: "stopped", reason: failure });
      expect(f.sent).toHaveLength(1);
    },
  );

  it("para no veto do guardrail sem chamar o canal", async () => {
    const f = fixture();
    const veto = vi.fn(async () => ({
      status: "vetoed" as const,
      gate: "pacing",
      code: "daily_cap",
      message: "aguarde",
      trace: [],
    })) as unknown as typeof runBeforeSend;

    const result = await executeCatalogPresentationSerial(
      plan(["A", "B"], [product("A"), product("B")]),
      { ...f.args, contracts: { ...f.args.contracts, beforeSend: veto } },
    );

    expect(result).toMatchObject({
      status: "stopped",
      reason: "vetoed",
      gate: "pacing",
      code: "daily_cap",
      next_seq: 1,
    });
    expect(f.sent).toEqual([]);
  });

  it("preserva a proxima abertura do veto para o worker reagendar sem IA", async () => {
    const f = fixture();
    const nextAllowedAt = new Date("2026-10-15T10:00:00.000Z");
    const veto = vi.fn(async () => ({
      status: "vetoed" as const,
      gate: "pacing",
      code: "daily_cap",
      message: "aguarde",
      nextAllowedAt,
      trace: [],
    })) as unknown as typeof runBeforeSend;

    const result = await executeCatalogPresentationSerial(plan(["A"], [product("A")]), {
      ...f.args,
      contracts: { ...f.args.contracts, beforeSend: veto },
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "vetoed",
      next_allowed_at: nextAllowedAt,
    });
  });

  it("aceita interrupção somente na fronteira entre itens", async () => {
    const first = product("A", { photo_storage_paths: [`${ORG}/id-A/fachada.jpg`] });
    if (!first.presentation) throw new Error("fixture sem apresentação");
    first.presentation = { ...first.presentation, use_catalog_photos: true };
    const f = fixture();
    const interruptedBetweenItems = vi.fn(async () => true);

    const result = await executeCatalogPresentationSerial(plan(["A", "B"], [first, product("B")]), {
      ...f.args,
      interruptedBetweenItems,
    });

    expect(result).toMatchObject({
      status: "stopped",
      reason: "interrupted",
      next_item_index: 1,
      next_seq: 3,
    });
    expect(f.sent.map((input) => input.seq)).toEqual([1, 2]);
    expect(interruptedBetweenItems).toHaveBeenCalledWith({
      completed_item_index: 0,
      next_item_index: 1,
      next_product_id: "id-B",
      next_product_code: "B",
    });
  });

  it("replay aceito no ledger não repete guardrail nem canal e mantém o seq seguinte", async () => {
    const f = fixture({ reconciledSeqs: [1] });

    const result = await executeCatalogPresentationSerial(
      plan(["A", "B"], [product("A"), product("B")]),
      f.args,
    );

    expect(result.status).toBe("completed");
    expect(f.beforeSend).toHaveBeenCalledTimes(1);
    expect(f.sent.map((input) => input.seq)).toEqual([2]);
    expect(result.steps[0]?.outcome).toEqual({ kind: "already_sent", reconciled: true });
  });
});
