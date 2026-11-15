/**
 * A ENTREGA DO LINK DE REUNIÃO CONFERE A LISTA DE TESTE DO CANAL (issue #4701).
 *
 * O pré-go-live é o período em que o canal está fechado ao público: só os
 * números escolhidos para teste podem receber mensagem da IA. O dreno, o turno,
 * o follow-up e a varredura de silêncio já conferem essa lista pela régua única
 * (`decidirElegibilidade`). A entrega da agenda também chama a MESMA régua —
 * mas montava o estado sem `ai_gate_mode`, sem a lista e sem o telefone do
 * contato, então `preGoLiveAtivo` saía sempre `false` e a decisão caía no
 * caminho do allowlist comum: um contato autorizado por campanha (carimbo
 * `ai_authorized_at` fresco) recebia o link de reunião de um canal ainda em
 * teste, sem que a lista fosse olhada uma vez.
 *
 * O caso que importa é o do furo real: contato FORA da lista + autorização
 * positiva de outra origem. Antes, era entrega; agora, recusa com motivo
 * próprio (`fora_da_lista_de_teste`), que é o que aparece no log e no
 * `calendar_appointments.meeting_delivery.error` via `fn_meet_delivery_settle`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertMeetingDeliveryPg,
  assertMeetingDeliverySupabase,
  type MeetingDeliveryContext,
} from "@/lib/agenda/meet-delivery";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";

const CONTEXTO: MeetingDeliveryContext = {
  organizationId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
  jobClaim: { worker_id: "w", acquired_at: "2026-11-15T00:00:00Z" },
};

const NUMERO_DE_TESTE = "+5511987654321";
const NUMERO_DE_FORA = "+5511911112222";

/** Política de um contato liberado para a IA em tudo, menos no que o caso muda. */
function politica(over: Record<string, unknown> = {}) {
  return {
    current: true,
    human_command: false,
    contact_id: "55555555-5555-4555-8555-555555555555",
    channel_session_id: "66666666-6666-4666-8666-666666666666",
    force_human: false,
    ai_opt_out: false,
    ai_gate: "allowlist",
    ai_authorized_at: null,
    assignee_kind: "ai",
    bot_silenced_until: null,
    // Campos que a política passou a devolver na 9399 (#4701).
    ai_gate_mode: null,
    ai_test_phone_numbers: [],
    contact_phone_number: NUMERO_DE_FORA,
    ...over,
  };
}

/** Canal em pré-go-live, lista com um número só. */
const PRE_GO_LIVE = {
  ai_gate: "allowlist",
  ai_gate_mode: "pre_go_live",
  ai_test_phone_numbers: [NUMERO_DE_TESTE],
};

const pg = (policy: unknown) =>
  ({ query: async () => ({ rows: [{ policy }] }) }) as unknown as Queryable;
const supa = (data: unknown, error: unknown = null) =>
  ({ rpc: async () => ({ data, error }) }) as unknown as SupabaseClient;

const autorizadoAgora = () => new Date(Date.now() - 60_000).toISOString();

describe("#4701 · entrega do link de reunião em canal de pré-go-live", () => {
  it("(a) contato FORA da lista: recusa com motivo legível, mesmo autorizado por outra origem", async () => {
    // O furo medido: a campanha carimbou `ai_authorized_at`; o canal está em
    // teste. Antes do conserto a entrega passava, porque a lista nunca era lida.
    const p = politica({ ...PRE_GO_LIVE, ai_authorized_at: autorizadoAgora() });
    await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).rejects.toMatchObject({
      reason: "fora_da_lista_de_teste",
    });
    await expect(assertMeetingDeliverySupabase(supa(p), CONTEXTO)).rejects.toMatchObject({
      reason: "fora_da_lista_de_teste",
    });
  });

  it("(b) contato DENTRO da lista: entrega normal, sem precisar de carimbo de campanha", async () => {
    const p = politica({
      ...PRE_GO_LIVE,
      contact_phone_number: NUMERO_DE_TESTE,
      ai_authorized_at: null,
    });
    await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).resolves.toEqual({
      humanCommand: false,
      contactId: p.contact_id,
      channelSessionId: p.channel_session_id,
    });
    await expect(assertMeetingDeliverySupabase(supa(p), CONTEXTO)).resolves.toMatchObject({
      humanCommand: false,
    });
  });

  it("(c) canal já liberado: a lista de teste não bloqueia quem está fora dela", async () => {
    // `ai_gate_mode` ausente é o allowlist comum (o modo de antes do pré-go-live):
    // a régua continua sendo `ai_authorized_at`, e a lista é irrelevante.
    const p = politica({
      ai_gate: "allowlist",
      ai_gate_mode: null,
      ai_test_phone_numbers: [NUMERO_DE_TESTE],
      contact_phone_number: NUMERO_DE_FORA,
      ai_authorized_at: autorizadoAgora(),
    });
    await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).resolves.toMatchObject({
      humanCommand: false,
    });
    await expect(assertMeetingDeliverySupabase(supa(p), CONTEXTO)).resolves.toMatchObject({
      humanCommand: false,
    });
  });

  it("(d) modo desligado continua como hoje: sem gate, entrega com ou sem lista", async () => {
    const p = politica({
      ai_gate: null,
      ai_gate_mode: null,
      ai_test_phone_numbers: [NUMERO_DE_TESTE],
      contact_phone_number: NUMERO_DE_FORA,
      ai_authorized_at: null,
    });
    await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).resolves.toMatchObject({
      humanCommand: false,
    });
    await expect(assertMeetingDeliverySupabase(supa(p), CONTEXTO)).resolves.toMatchObject({
      humanCommand: false,
    });
  });
});

describe("#4701 · a política do banco carrega o que a régua precisa", () => {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

  it("a última `fn_meet_delivery_policy` do baseline devolve modo, lista e telefone", () => {
    const corpos = [
      ...baseline.matchAll(
        /create or replace function public\.fn_meet_delivery_policy\([^)]*\)[\s\S]*?end;\$\$/g,
      ),
    ];
    const ultima = corpos.at(-1)?.[0] ?? "";
    expect(ultima).toContain("ai_gate_mode");
    expect(ultima).toContain("ai_test_phone_numbers");
    expect(ultima).toContain("c.phone_number");
  });

  it("o settle aceita o motivo novo, senão a recusa vira exceção e trava o job", () => {
    const listas = [
      ...baseline.matchAll(
        /if reason not in \(([^)]*)\) then raise exception 'meet_reason_invalid'/g,
      ),
    ];
    expect(listas.at(-1)?.[1] ?? "").toContain("fora_da_lista_de_teste");
  });
});
