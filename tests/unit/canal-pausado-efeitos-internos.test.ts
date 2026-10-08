/**
 * Canal PAUSADO: os efeitos INTERNOS de `message.received` (#2329) — a
 * continuação do #2318.
 *
 * O #2318 cortou a superfície: canal desativado não entra na inbox, não acorda
 * a IA e não envia. Esta issue fecha o resto — os cinco consumidores do
 * `message.received` que continuavam REAGINDO a uma mensagem de canal
 * desligado. Nenhum deles entrega mensagem ao cliente (o envio seria recusado
 * em `messages/_handler`), mas todos custam e poluem:
 *
 *  1. push no celular — `lib/notifications/push.handler.ts`;
 *  2. fluxo de follow-up — `lib/followup/reactivity.handler.ts`;
 *  3. gatilho de retorno — `lib/followup/gatilho-retorno.handler.ts`;
 *  4. regra de automação / webhook HTTP de SAÍDA — `lib/automation/engine.handler.ts`
 *     (o único que de fato vaza para fora);
 *  5. `followup_turn` agendado — `lib/agent-engine/agent/followup-turn.ts`, que
 *     queimava 5 tentativas e virava `dead` com aviso crítico (o 5º mora em
 *     `tests/unit/canal-desativado-quarentena.test.ts`, que é onde a guarda
 *     já existia).
 *
 * A régua é uma só, `canalDoEventoDesativado()`: o payload do
 * `fn_emit_message_event` já traz `channel_session_id`, então a pergunta é uma
 * ida por evento. Cada teste abaixo prende UM consumidor — quem soltar um de
 *les vê aquele teste ficar vermelho, e não a suíte inteira.
 *
 * O dublê de `channel_sessions` é o MESMO para todos: canais ligado/desligado,
 * e o caso de leitura falhada (a régua abre, como `idsDosCanaisDesativados`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { canalDoEventoDesativado } from "@/lib/channels/desativado";

// ─── O canal ────────────────────────────────────────────────────────────────
const canal = { desativado: true, leituraFalha: false };

/** Cadeia estreita o bastante para a régua, larga o bastante para não travar. */
function cadeiaDoCanal() {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    maybeSingle: async () => {
      if (canal.leituraFalha) throw new Error("leitura falhou (dublê)");
      return {
        data: canal.desativado ? { metadata: { disabled: true } } : { metadata: {} },
        error: null,
      };
    },
  };
  return self;
}

/** Qualquer outra tabela: linha nula, para o caminho vermelho não explodir. */
function cadeiaQualquer() {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    order: () => self,
    limit: () => self,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }),
  };
  return self;
}

function adminDublho() {
  return {
    from: (tabela: string) =>
      tabela === "channel_sessions" ? cadeiaDoCanal() : cadeiaQualquer(),
  } as never;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminDublho(),
}));

// ─── 1. push ────────────────────────────────────────────────────────────────
const enviarPushDaOrg = vi.fn(async (_org: string, _payload: unknown) => ({ sent: 1, gone: 0 }));
const enviarPushAQuemVeAConversa = vi.fn(async (_org: string, _conv: string, _payload: unknown) => ({
  sent: 1,
  gone: 0,
}));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushDaOrg: (org: string, payload: unknown) => enviarPushDaOrg(org, payload),
  enviarPushAQuemVeAConversa: (org: string, conv: string, payload: unknown) =>
    enviarPushAQuemVeAConversa(org, conv, payload),
  enviarPushAoUsuario: async () => ({ sent: 0, gone: 0 }),
}));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => true }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Marca" }) }));

// ─── 2. reatividade do fluxo ────────────────────────────────────────────────
const applyReactivityEvent = vi.fn(async (_db: unknown, _clock: unknown, _row: unknown) => ({
  matched: true,
  reacted: 1,
}));
const aplicarTextoNosFollowups = vi.fn(async (_admin: unknown, _opts: unknown) => undefined);
vi.mock("@/lib/followup/reactivity", () => ({
  applyReactivityEvent: (db: unknown, clock: unknown, row: unknown) =>
    applyReactivityEvent(db, clock, row),
  createSupabaseReactivityClient: () => ({}),
}));
vi.mock("@/lib/followup/aplicar-inbound", () => ({
  aplicarTextoNosFollowups: (admin: unknown, opts: unknown) =>
    aplicarTextoNosFollowups(admin, opts),
  avancarFollowupsAtivosDoContato: async () => undefined,
  textoDoPayloadInbound: () => "oi",
}));

// ─── 3. gatilho de retorno ──────────────────────────────────────────────────
const aplicaGatilhoDeRetorno = vi.fn(async (_deps: unknown, _row: unknown) => ({
  matched: true, enrolled: 1, contact_id: "contato-1",
  pointers_armados: 1, skipped_stale_origin: 0, skipped_existing: 0,
  pointers_barrados_pelo_gate: 0, skipped_gap: 0, skipped_humano: 0,
  skipped_grupo: 0, skipped_bloqueado: 0,
}));
vi.mock("@/lib/followup/gatilho-retorno", () => ({
  EVENTO_DE_RETORNO: "message.received",
  aplicaGatilhoDeRetorno: (deps: unknown, row: unknown) => aplicaGatilhoDeRetorno(deps, row),
  createSupabaseGatilhoRetornoDb: () => ({}),
}));
vi.mock("@/lib/followup/agent-followup-gate", () => ({
  createSupabaseFollowupGateDb: () => ({}),
}));

// ─── 4. automação (o webhook de saída) ──────────────────────────────────────
const runAutomationForEvent = vi.fn(async (_admin: unknown, _row: unknown) => ({
  consumer_key: "automation-rules", status: "ok" as const, detail: "no_rules",
}));
vi.mock("@/lib/automation/engine", () => ({
  AUTOMATION_CONSUMER_KEY: "automation-rules",
  runAutomationForEvent: (admin: unknown, row: unknown) => runAutomationForEvent(admin, row),
}));
// Os executors só se registram por efeito colateral — irrelevante aqui, e
// puxariam o motor inteiro para dentro da régua.
vi.mock("@/lib/automation/actions/register-all", () => ({}));

import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { followupReactivityHandler } from "@/lib/followup/reactivity.handler";
import { followupGatilhoRetornoHandler } from "@/lib/followup/gatilho-retorno.handler";
import { automationRulesHandler } from "@/lib/automation/engine.handler";

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "evt-1",
    organization_id: "org-1",
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "msg-1",
    payload: {
      message_id: "msg-1",
      conversation_id: "conv-1",
      contact_id: "contato-1",
      direction: "inbound",
      type: "text",
      status: "received",
      external_id: null,
      channel_session_id: "canal-1",
      body_preview: "oi",
    },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

beforeEach(() => {
  canal.desativado = true;
  canal.leituraFalha = false;
  enviarPushDaOrg.mockClear();
  enviarPushAQuemVeAConversa.mockClear();
  applyReactivityEvent.mockClear();
  aplicarTextoNosFollowups.mockClear();
  aplicaGatilhoDeRetorno.mockClear();
  runAutomationForEvent.mockClear();
});

describe("régua — canalDoEventoDesativado", () => {
  it.each([
    ["canal desativado", { desativado: true, leituraFalha: false }, true],
    ["canal ligado", { desativado: false, leituraFalha: false }, false],
    ["leitura falha → abre (mesma régua da lista da inbox)", { desativado: true, leituraFalha: true }, false],
  ])("%s", async (_rotulo, estado, esperado) => {
    canal.desativado = estado.desativado;
    canal.leituraFalha = estado.leituraFalha;
    await expect(
      canalDoEventoDesativado(adminDublho(), "org-1", { channel_session_id: "canal-1" }),
    ).resolves.toBe(esperado);
  });

  it("evento sem canal no payload não paga nenhuma ida (lead.*, handoff)", async () => {
    const from = vi.fn();
    const db = { from } as never;
    await expect(canalDoEventoDesativado(db, "org-1", { lead_id: "lead-1" })).resolves.toBe(false);
    await expect(canalDoEventoDesativado(db, "org-1", null)).resolves.toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("consumidor 1 — push no celular", () => {
  it("canal pausado → skipped e NENHUM push sai", async () => {
    const r = await webPushInboundHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "canal_desativado" });
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
    expect(enviarPushAQuemVeAConversa).not.toHaveBeenCalled();
  });

  it("canal ligado → o push sai (a guarda não engoliu o caminho bom)", async () => {
    canal.desativado = false;
    const r = await webPushInboundHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(enviarPushAQuemVeAConversa).toHaveBeenCalledTimes(1);
  });

  // O grupo é o irmão que a primeira passada não viu: `message.group_received`
  // traz o MESMO payload (com `channel_session_id`) e cai em `handleGroupInbound`,
  // não em `handleInbound`. A inbox esconde o grupo do canal pausado também.
  it("grupo em canal pausado → skipped e NENHUM push sai", async () => {
    const r = await webPushInboundHandler.handle(evento({ event_type: "message.group_received" }));
    expect(r).toMatchObject({ status: "skipped", detail: "canal_desativado" });
    expect(enviarPushDaOrg).not.toHaveBeenCalled();
    expect(enviarPushAQuemVeAConversa).not.toHaveBeenCalled();
  });

  it("grupo em canal ligado → o push sai", async () => {
    canal.desativado = false;
    const r = await webPushInboundHandler.handle(evento({ event_type: "message.group_received" }));
    expect(r.status).toBe("ok");
    expect(enviarPushAQuemVeAConversa).toHaveBeenCalledTimes(1);
  });
});

describe("consumidor 2 — fluxo de follow-up", () => {
  it("canal pausado → skipped, o fluxo não avança nem grava texto", async () => {
    const r = await followupReactivityHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "canal_desativado" });
    expect(applyReactivityEvent).not.toHaveBeenCalled();
    expect(aplicarTextoNosFollowups).not.toHaveBeenCalled();
  });

  it("canal ligado → a reatividade roda", async () => {
    canal.desativado = false;
    const r = await followupReactivityHandler.handle(evento());
    expect(applyReactivityEvent).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("ok");
  });
});

describe("consumidor 3 — gatilho de retorno", () => {
  it("canal pausado → skipped, o contato não é inscrito no retorno", async () => {
    const r = await followupGatilhoRetornoHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "canal_desativado" });
    expect(aplicaGatilhoDeRetorno).not.toHaveBeenCalled();
  });

  it("canal ligado → o gatilho arma", async () => {
    canal.desativado = false;
    const r = await followupGatilhoRetornoHandler.handle(evento());
    expect(aplicaGatilhoDeRetorno).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("ok");
  });
});

describe("consumidor 4 — regra de automação e webhook de SAÍDA", () => {
  it("canal pausado → skipped, o motor não roda e nenhum webhook HTTP sai", async () => {
    const r = await automationRulesHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "canal_desativado" });
    expect(runAutomationForEvent).not.toHaveBeenCalled();
  });

  it("canal ligado → o motor roda (a guarda não desligou a automação)", async () => {
    canal.desativado = false;
    const r = await automationRulesHandler.handle(evento());
    expect(runAutomationForEvent).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("ok");
  });

  it("evento sem channel_session_id (lead.assigned) passa — a guarda é do canal", async () => {
    canal.desativado = true;
    await automationRulesHandler.handle(
      evento({ event_type: "lead.assigned", entity_kind: "lead", payload: { lead_id: "lead-1" } }),
    );
    expect(runAutomationForEvent).toHaveBeenCalledTimes(1);
  });
});
