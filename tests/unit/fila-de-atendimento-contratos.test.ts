import { describe, expect, it } from "vitest";

import {
  availabilityScheduleSchema,
  conversationSectorSchema,
  sectorAssignmentSchema,
  sectorPatchSchema,
} from "@/lib/schemas/routing";

/**
 * Os CONTRATOS da fila de atendimento (migration 9062), provados sem banco.
 *
 * ─── Por que existe um teste só para o schema ──────────────────────────────
 *
 * O corpo de `PUT /attendants/sector/[user_id]` MUDOU de forma para conjunto:
 * era `{ sector_id: string | null }`, virou `{ sector_ids: string[] }`. Uma
 * rota que aceitasse os dois formatos por "compatibilidade" transformaria o
 * erro de um cliente antigo em sucesso silencioso — a pessoa continuaria sem
 * fila e ninguém veria. Aqui a régua é explícita: o formato velho é RECUSADO.
 *
 * O horário da fila usa o MESMO schema da jornada do atendente. Se um dia
 * alguém criar um `sectorScheduleSchema` paralelo, é este teste que acusa a
 * segunda régua.
 */
describe("contratos da fila de atendimento", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const outro = "22222222-2222-4222-8222-222222222222";

  it("vínculo do atendente é CONJUNTO: vazio = sem fila, e o formato antigo não passa", () => {
    expect(sectorAssignmentSchema.parse({ sector_ids: [] })).toEqual({ sector_ids: [] });
    expect(sectorAssignmentSchema.parse({ sector_ids: [uuid, outro] })).toEqual({
      sector_ids: [uuid, outro],
    });
    // O corpo de antes desta migration.
    expect(sectorAssignmentSchema.safeParse({ sector_id: uuid }).success).toBe(false);
    // Estrito: campo desconhecido não entra pela porta dos fundos.
    expect(sectorAssignmentSchema.safeParse({ sector_ids: [uuid], extra: 1 }).success).toBe(false);
  });

  it("o horário é o MESMO shape da jornada (e janela inválida é recusada)", () => {
    const horario = {
      timezone: "America/Sao_Paulo",
      windows: [{ dow: 1, start: "09:00", end: "18:00" }],
    };
    expect(availabilityScheduleSchema.parse(horario)).toMatchObject({ timezone: "America/Sao_Paulo" });
    expect(
      availabilityScheduleSchema.safeParse({
        timezone: "America/Sao_Paulo",
        windows: [{ dow: 1, start: "18:00", end: "09:00" }],
      }).success,
    ).toBe(false);
    // Fuso inexistente quebraria o cálculo de janela (localMoment lança).
    expect(
      availabilityScheduleSchema.safeParse({
        timezone: "Marte/Olympus",
        windows: [{ dow: 1, start: "09:00", end: "18:00" }],
      }).success,
    ).toBe(false);
  });

  it("PATCH do setor aceita horário sozinho e continua recusando corpo vazio", () => {
    expect(sectorPatchSchema.safeParse({ schedule: { timezone: "UTC", windows: [] } }).success).toBe(true);
    expect(sectorPatchSchema.safeParse({}).success).toBe(false);
  });

  it("a fila de uma conversa aceita null (voltar ao comportamento de sempre)", () => {
    expect(conversationSectorSchema.parse({ sector_id: null })).toEqual({ sector_id: null });
    expect(conversationSectorSchema.parse({ sector_id: uuid })).toEqual({ sector_id: uuid });
    expect(conversationSectorSchema.safeParse({ sector_id: "não-é-uuid" }).success).toBe(false);
  });
});
