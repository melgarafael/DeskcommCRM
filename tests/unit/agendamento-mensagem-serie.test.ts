import { describe, expect, it } from "vitest";
import { proximoDaSerie } from "@/lib/agendamento-mensagem/serie";
import { criarAgendamentoSchema, regraDoCorpo } from "@/lib/agendamento-mensagem/schema";
import { motivoRegraInvalida, type RegraDeRecorrencia } from "@/lib/agendamento-mensagem/recorrencia";

const TZ = "America/Cuiaba"; // UTC-4 sem horário de verão

function regra(parcial: Partial<RegraDeRecorrencia>): RegraDeRecorrencia {
  return { recorrencia: "diaria", inicio: "2026-11-10T08:00", termino: null, intervalo_dias: null, tz: TZ, ...parcial };
}

const encaminhada = { status: "encaminhada" as const, motivo: null };

describe("série: o que acontece depois de cada ocorrência", () => {
  it("encaminhada: a série segue para a próxima ocorrência, a partir de agora", () => {
    const agora = new Date("2026-11-10T12:05:00Z"); // 08:05 em Cuiabá
    expect(proximoDaSerie(regra({}), agora, encaminhada)).toBe("2026-11-11T12:00:00.000Z");
  });

  it("falhou: a série segue (o envio de uma ocorrência não encerra a repetição)", () => {
    const agora = new Date("2026-11-10T12:05:00Z");
    expect(proximoDaSerie(regra({}), agora, { status: "falhou", motivo: "envio_recusado" })).toBe("2026-11-11T12:00:00.000Z");
  });

  it("pulada com número desconectado: a série segue, a ocorrência fica como cancelada", () => {
    const agora = new Date("2026-11-10T12:05:00Z");
    expect(proximoDaSerie(regra({}), agora, { status: "cancelada", motivo: "numero_desconectado" })).toBe("2026-11-11T12:00:00.000Z");
  });

  it("quem agendou perdeu o acesso: a série inteira para", () => {
    const agora = new Date("2026-11-10T12:05:00Z");
    expect(proximoDaSerie(regra({}), agora, { status: "cancelada", motivo: "sem_acesso" })).toBeNull();
  });

  it("passou do término: a série termina", () => {
    const agora = new Date("2026-11-10T12:05:00Z");
    expect(proximoDaSerie(regra({ termino: "2026-11-10T23:59" }), agora, encaminhada)).toBeNull();
  });

  it("término no dia da próxima ocorrência: a última ocorrência ainda conta", () => {
    const agora = new Date("2026-11-10T12:05:00Z");
    expect(proximoDaSerie(regra({ termino: "2026-11-11T23:59" }), agora, encaminhada)).toBe("2026-11-11T12:00:00.000Z");
  });

  it("não dispara em rajada: se o cron ficou parado, pula as ocorrências que já passaram", () => {
    // Três dias sem cron: a próxima é a primeira que cai DEPOIS de agora, não a fila inteira.
    const agora = new Date("2026-11-13T15:00:00Z"); // 11:00 em Cuiabá, dia 13
    expect(proximoDaSerie(regra({}), agora, encaminhada)).toBe("2026-11-14T12:00:00.000Z");
  });
});

describe("schema: recorrência e data final opcional", () => {
  const base = {
    conversation_id: "11111111-1111-4111-8111-111111111111",
    body: "Oi, passando para lembrar.",
    inicio_local: "2026-11-10T08:00",
    tz: TZ,
    se_desconectado: "esperar" as const,
  };

  it("aceita envio único sem término", () => {
    const r = criarAgendamentoSchema.safeParse({ ...base, recorrencia: "nenhuma" });
    expect(r.success).toBe(true);
  });

  it("aceita série semanal com término opcional", () => {
    const r = criarAgendamentoSchema.safeParse({ ...base, recorrencia: "semanal", termino_local: "2026-12-31T23:59" });
    expect(r.success).toBe(true);
    if (r.success) expect(motivoRegraInvalida(regraDoCorpo(r.data))).toBeNull();
  });

  it("sem recorrência informada, é envio único", () => {
    const r = criarAgendamentoSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.recorrencia).toBe("nenhuma");
  });

  it("recusa recorrência fora da lista", () => {
    expect(criarAgendamentoSchema.safeParse({ ...base, recorrencia: "todo_dia" }).success).toBe(false);
  });

  it("recusa início com formato que não é hora de parede", () => {
    expect(criarAgendamentoSchema.safeParse({ ...base, recorrencia: "diaria", inicio_local: "10/11/2026 08:00" }).success).toBe(false);
  });

  it("'a cada N dias' exige o intervalo", () => {
    const r = criarAgendamentoSchema.safeParse({ ...base, recorrencia: "a_cada_n_dias" });
    expect(r.success).toBe(true);
    if (r.success) expect(motivoRegraInvalida(regraDoCorpo(r.data))).not.toBeNull();
  });

  it("término antes do início é recusado pela régua", () => {
    const r = criarAgendamentoSchema.safeParse({ ...base, recorrencia: "diaria", termino_local: "2026-11-01T23:59" });
    expect(r.success).toBe(true);
    if (r.success) expect(motivoRegraInvalida(regraDoCorpo(r.data))).toBe("termino_antes_do_inicio");
  });
});
