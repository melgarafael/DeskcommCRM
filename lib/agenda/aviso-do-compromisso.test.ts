/**
 * A FORMA do aviso de compromisso (#1612) — a função pura, sem banco.
 *
 * A prova de que o laço USA isto mora em
 * `tests/unit/agenda-aviso-de-compromisso.test.ts`; aqui é o contrato do
 * objeto: quais chaves existem sempre, o que vira `null`, e por que o
 * responsável não tem chave nenhuma.
 */
import { describe, expect, it } from "vitest";

import { payloadDoAviso } from "./aviso-do-compromisso";

const BASE = {
  appointmentId: "fff00000-0000-4000-8000-00000000000f",
  contactId: "ddd00000-0000-4000-8000-00000000000d",
  transicao: "confirmed",
  fuso: "America/Sao_Paulo",
  nomeDoTipo: "Limpeza de pele",
};

describe("payloadDoAviso", () => {
  it("carrega horário, situação, tipo e local — e mantém o contrato antigo", () => {
    // A linha real traz o endereço e o link; eles NÃO podem chegar ao evento.
    const linha = {
      starts_at: "2026-09-02T13:00:00.000Z",
      ends_at: "2026-09-02T13:30:00.000Z",
      status: "confirmed",
      location_kind: "in_person",
      location_details: "Sala 2",
      meeting_url: "https://meet.example.com/x",
    };
    const payload = payloadDoAviso({
      ...BASE,
      compromisso: linha,
      tipo: { slug: "limpeza-de-pele", name: "Limpeza de pele" },
      leadIds: ["eee00000-0000-4000-8000-00000000000e"],
    });

    expect(payload).toMatchObject({
      appointment_id: BASE.appointmentId,
      contact_id: BASE.contactId,
      event_type_name: "Limpeza de pele",
      time_zone: "America/Sao_Paulo",
      transicao: "confirmed",
      inicio: "2026-09-02T13:00:00.000Z",
      fim: "2026-09-02T13:30:00.000Z",
      situacao: "confirmed",
      tipo: { slug: "limpeza-de-pele", nome: "Limpeza de pele" },
      lead_ids: ["eee00000-0000-4000-8000-00000000000e"],
    });
    // O responsável NUNCA mora aqui: o opt-in é da ação `call_webhook`.
    expect(payload).not.toHaveProperty("owner");
    expect(payload).not.toHaveProperty("owner_user_id");
  });

  it("o endereço escrito e o link da reunião nunca entram no evento", () => {
    // O objeto vai para `event_log.payload`, que nenhuma anonimização alcança:
    // o redact anula as duas colunas no compromisso (0184), e uma cópia aqui
    // sobreviveria a ele. Quem as põe no webhook é o `call_webhook`, da linha.
    const linha = {
      location_kind: "in_person",
      location_details: "Sala 2 — Rua das Flores, 100",
      meeting_url: "https://meet.example.com/x",
    };
    const payload = payloadDoAviso({ ...BASE, compromisso: linha });

    expect(payload.local).toEqual({ tipo: "in_person" });
    expect(payload).not.toHaveProperty("meeting_url");
    expect(JSON.stringify(payload)).not.toContain("Rua das Flores");
    expect(JSON.stringify(payload)).not.toContain("meet.example.com");
  });

  it("`situacao` é a coluna, `transicao` é o caminho — remarcar não muda a situação", () => {
    const payload = payloadDoAviso({
      ...BASE,
      transicao: "rescheduled",
      compromisso: { status: "confirmed", starts_at: "2026-09-03T10:00:00.000Z" },
    });

    expect(payload.transicao).toBe("rescheduled");
    expect(payload.situacao).toBe("confirmed");
  });

  it("sem leitura da linha, os campos novos viram `null` e as chaves continuam lá", () => {
    // O contrato não muda de FORMA conforme o banco respondeu: o receptor
    // programa contra as chaves, não contra o sucesso da consulta.
    const payload = payloadDoAviso({ ...BASE, compromisso: null, tipo: null, leadIds: [] });

    expect(payload.inicio).toBeNull();
    expect(payload.fim).toBeNull();
    expect(payload.situacao).toBeNull();
    expect(payload.lead_ids).toEqual([]);
    expect(payload).toMatchObject({
      appointment_id: BASE.appointmentId,
      time_zone: "America/Sao_Paulo",
      // O nome que o emissor tinha em mãos é o fallback do tipo.
      tipo: { slug: null, nome: "Limpeza de pele" },
      local: { tipo: null },
    });
  });

  it("lead_ids não repete o mesmo negócio", () => {
    const id = "eee00000-0000-4000-8000-00000000000e";
    const payload = payloadDoAviso({ ...BASE, leadIds: [id, id] });
    expect(payload.lead_ids).toEqual([id]);
  });
});
