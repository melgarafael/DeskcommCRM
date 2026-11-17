/**
 * Em pré-go-live, o link de reunião que a IA envia só sai para quem está na
 * lista de teste do canal (#4701), como nos outros caminhos da IA. Antes,
 * `requirePolicy` montava a elegibilidade sem o modo do canal nem o telefone
 * do contato, e o contato fora da lista recebia o link.
 */
import { describe, expect, it } from "vitest";

import { assertMeetingDeliveryPg, assertMeetingDeliverySupabase } from "@/lib/agenda/meet-delivery";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";

const CONTEXTO = {
  organizationId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
  jobClaim: { worker_id: "w", acquired_at: "2026-10-15T00:00:00Z" },
} as Parameters<typeof assertMeetingDeliveryPg>[1];

/** Canal em pré-go-live com um número na lista; contato sem autorização própria. */
function politica(over: Record<string, unknown> = {}) {
  return {
    current: true,
    human_command: false,
    contact_id: "55555555-5555-4555-8555-555555555555",
    channel_session_id: "66666666-6666-4666-8666-666666666666",
    force_human: false,
    ai_opt_out: false,
    ai_gate: "allowlist",
    ai_gate_mode: "pre_go_live",
    ai_test_phone_numbers: ["+5511999990000"],
    contact_phone_number: "+5511988887777",
    ai_authorized_at: null,
    assignee_kind: "ai",
    bot_silenced_until: null,
    ...over,
  };
}

/** Contato de Instagram (sem telefone) e o testador da lista social do canal (9394, 9408). */
const TESTADOR_SOCIAL = "instagram:6af9e0ef28984e27de07bef4:1011223655361506";
const OUTRO_SOCIAL = "instagram:6af9e0ef28984e27de07bef4:2022334466472617";

const pg = (policy: unknown) => ({ query: async () => ({ rows: [{ policy }] }) }) as unknown as Queryable;
const supa = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as unknown as SupabaseClient;

describe("envio do link da agenda em canal pré-go-live", () => {
  describe("negative cases", () => {
    it("contato fora da lista de teste: recusa pelo motivo da lista", async () => {
      await expect(assertMeetingDeliveryPg(pg(politica()), CONTEXTO)).rejects.toMatchObject({
        reason: "fora_da_lista_de_teste",
      });
      await expect(assertMeetingDeliverySupabase(supa(politica()), CONTEXTO)).rejects.toMatchObject({
        reason: "fora_da_lista_de_teste",
      });
    });

    it("contato fora da lista, mesmo autorizado antes: recusa", async () => {
      const p = politica({ ai_authorized_at: new Date().toISOString() });
      await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).rejects.toMatchObject({
        reason: "fora_da_lista_de_teste",
      });
    });

    it("política sem o modo do canal (banco sem a 9399) é recusada, nunca lida como canal aberto", async () => {
      // Autorizado antes: na `main`, sem a chave obrigatória, ele passaria.
      const { ai_gate_mode: _ausente, ...semModo } = politica({
        ai_authorized_at: new Date().toISOString(),
      });
      await expect(assertMeetingDeliveryPg(pg(semModo), CONTEXTO)).rejects.toThrow();
    });

    it("contato de rede social fora da lista social: recusa pela lista", async () => {
      const p = politica({
        contact_phone_number: null,
        ai_test_social_identities: [TESTADOR_SOCIAL],
        contact_social_identity: OUTRO_SOCIAL,
      });
      await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).rejects.toMatchObject({
        reason: "fora_da_lista_de_teste",
      });
    });

    it("política sem a lista social (banco sem a 9408): o testador social não passa", async () => {
      const p = politica({ contact_phone_number: null, contact_social_identity: TESTADOR_SOCIAL });
      await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).rejects.toMatchObject({
        reason: "fora_da_lista_de_teste",
      });
    });
  });

  describe("positive cases", () => {
    it("contato da lista de teste recebe o link", async () => {
      const p = politica({ contact_phone_number: "+5511999990000" });
      await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).resolves.toMatchObject({ humanCommand: false });
    });

    it("testador de Instagram/Facebook da lista social recebe o link", async () => {
      const p = politica({
        contact_phone_number: null,
        ai_test_social_identities: [TESTADOR_SOCIAL],
        contact_social_identity: TESTADOR_SOCIAL,
      });
      await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).resolves.toMatchObject({ humanCommand: false });
      await expect(assertMeetingDeliverySupabase(supa(p), CONTEXTO)).resolves.toMatchObject({ humanCommand: false });
    });

    it("comando humano passa pelo porteiro mesmo fora da lista", async () => {
      const p = politica({ human_command: true });
      await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).resolves.toMatchObject({ humanCommand: true });
    });
  });
});
