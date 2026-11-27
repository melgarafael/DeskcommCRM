/**
 * #3067 fatia E1 — "Quem conduz" na rota do detalhe do compromisso.
 *
 * A rota do detalhe já devolvia `principal_user_id` e `responsaveis`; esta
 * fatia acrescenta `equipe_travada` para sessões coletivas, com uma consulta
 * separada a `calendar_event_types` que filtra organização E id do tipo.
 *
 * Render da página não alcança isto (providers, hooks, rede). O que não pode
 * se perder cabe numa leitura do arquivo: o select inclui `event_type_id`,
 * a resposta devolve `equipe_travada`, e a consulta do tipo filtra a
 * organização da sessão.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * As colunas que a rota do detalhe deve ler para decidir `equipe_travada`:
 * `event_type_id` (para saber qual tipo consultar) e
 * `calendar_appointment_responsibles(user_id)` (para `responsaveis`).
 */
const rota = readFileSync("app/api/v1/agenda/agendamentos/[id]/route.ts", "utf8");

describe("detalhe do compromisso — quem conduz (#3067)", () => {
  it("a resposta devolve principal_user_id e responsaveis", () => {
    expect(rota).toContain("principal_user_id: _ownerUserId");
    expect(rota).toContain("responsaveis: (equipe ?? []).map((r) => r.user_id)");
    // `equipe_travada` viaja ao lado de `principal_user_id`.
    expect(rota).toContain("equipe_travada, responsaveis:");
  });

  it("sem ocorrência de serviço: equipe_travada é false e nenhuma consulta ao tipo", () => {
    // Sem `service_occurrence_id` a rota não consulta `calendar_event_types`
    // para decidir a equipe travada; o bloco só entra quando há ocorrência.
    expect(rota).toMatch(/if \(data\.service_occurrence_id && data\.event_type_id\)/);
  });

  it("com ocorrência e tipo: consulta separada a calendar_event_types, filtrando organização e id", () => {
    expect(rota).toContain('from("calendar_event_types")');
    expect(rota).toContain('select("service_enabled, booking_mode")');
    expect(rota).toContain(".eq(\"id\", data.event_type_id)");
    expect(rota).toContain(".eq(\"organization_id\", org)");
    expect(rota).toContain(".maybeSingle()");
  });

  it("equipe_travada é true só para sessão coletiva (service_enabled e booking_mode não individual)", () => {
    expect(rota).toContain("tipo?.service_enabled && tipo.booking_mode !== \"individual\"");
    expect(rota).toContain("let equipe_travada = false;");
  });
});
