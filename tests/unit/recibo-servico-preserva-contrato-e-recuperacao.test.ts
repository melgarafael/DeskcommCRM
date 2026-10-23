import { describe, expect, it } from "vitest";
import { reciboDoServico } from "@/lib/agenda/servicos/escrita";
import { publicationReceipt } from "@/lib/agenda/google/publication-flow";

const persisted = {
  id: "3de219db-4798-427f-8956-2560656c654d", service_occurrence_id: "656a577b-3f5a-4a85-97e5-8f9baaa41376",
  starts_at: "2027-01-12T17:00:00Z", ends_at: "2027-01-12T17:40:00Z", time_zone: "America/Sao_Paulo",
  status: "confirmed", revision: 2, owner_user_id: null, participant_name: "Pessoa fictícia",
  service_booking_mode: "collective_unlimited", service_capacity_rule: "unlimited", service_capacity_limit: null,
  service_rule_revision: 1, service_publication_mode: "service", service_requires_confirmation: false,
  meeting_state: "none", meeting_url: null, google_event_id: null, google_local_revision: 2,
  google_synced_local_revision: 0, needs_google_push: true, google_sync_failure_kind: "transient",
  google_conflict: null, google_sync_error: "503", private_claim: "not-a-public-receipt",
};

describe("recibo nativo e estado operacional da mesma reserva", () => {
  it("preserva failed no contrato nativo sem transformar retry automático em intervenção", () => {
    expect(reciboDoServico(persisted).google_publication).toBe("failed");
    expect(publicationReceipt(persisted).google_publication).toBe("retrying");
  });
  it.each([
    [{ google_sync_error: null }, "pending"],
    [{ google_sync_error: null, google_event_id: "same-event", google_synced_local_revision: 2, needs_google_push: false }, "synced"],
    [{ google_sync_failure_kind: "human_required" }, "failed"],
    [{ google_conflict: { reason: "overlap" } }, "conflict"],
    [{ service_publication_mode: "none" }, "not_configured"],
  ] as const)("mantém os estados não transitórios nos dois recibos: %j", (patch, expected) => {
    const row = { ...persisted, ...patch };
    expect(reciboDoServico(row).google_publication).toBe(expected);
    expect(publicationReceipt(row).google_publication).toBe(expected);
  });
  it("mantém identidade/revisão e não publica claims, erro bruto ou conclusão de comunicação", () => {
    for (const receipt of [reciboDoServico(persisted), publicationReceipt(persisted)]) {
      expect(receipt).toMatchObject({ id: persisted.id, revision: 2, communication: "not_proven", human_confirmation: "not_required" });
      expect(receipt).not.toHaveProperty("private_claim");
      expect(receipt).not.toHaveProperty("google_sync_error");
      expect(receipt).not.toHaveProperty("google_sync_failure_kind");
    }
  });
});
