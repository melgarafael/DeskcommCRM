import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { editarAgendamentoSchema, proximoScheduledAtDaEdicao, regraDoCorpo } from "@/lib/agendamento-mensagem/schema";

/**
 * Editar uma série que JÁ COMEÇOU (início no passado). Antes, o PATCH recalculava a
 * primeira ocorrência a partir do início e devolvia 422 `horario_no_passado`: não dava
 * para mudar nem o texto sem mover a data de início para o futuro.
 */
const agora = new Date("2026-11-24T15:00:00Z");

function edicao(parcial: Record<string, unknown>) {
  const v = editarAgendamentoSchema.parse({ body: "oi", tz: "UTC", ...parcial });
  return proximoScheduledAtDaEdicao(regraDoCorpo(v), agora);
}

describe("edição de série em andamento", () => {
  it("série diária com início ontem: salva com a próxima ocorrência, depois de agora", () => {
    expect(edicao({ recorrencia: "diaria", inicio_local: "2026-11-23T16:00" })).toEqual({
      ok: true,
      scheduledAt: "2026-11-24T16:00:00.000Z",
    });
  });

  it("série com término no passado: recusa, a repetição já terminou", () => {
    expect(
      edicao({ recorrencia: "semanal", inicio_local: "2026-10-01T09:00", termino_local: "2026-11-20T23:59" }),
    ).toEqual({ ok: false, motivo: "serie_sem_proxima_ocorrencia" });
  });

  it("envio único continua exigindo horário no futuro", () => {
    expect(edicao({ recorrencia: "nenhuma", inicio_local: "2026-11-23T16:00" })).toEqual({
      ok: false,
      motivo: "horario_no_passado",
    });
  });

  it("o PATCH usa a régua da edição, não a primeira ocorrência", () => {
    const rota = readFileSync("app/api/v1/mensagens-agendadas/[id]/route.ts", "utf8");
    expect(rota).toContain("proximoScheduledAtDaEdicao(");
    expect(rota).not.toContain("primeiraOcorrenciaIso(");
  });
});
