import { describe, expect, it } from "vitest";
import { criarEfeitoDasEscrituras } from "./efeito-das-escritas";

const recibo = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "confirmed",
  starts_at: "2026-12-10T13:00:00Z",
  ends_at: "2026-12-10T13:30:00Z",
  revision: 1,
};

describe("recibos da agenda no coletor do turno", () => {
  it("conserva o recibo devolvido pela ponte, separado do booleano de efeito", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const geracao = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(geracao, { marcado: true, compromisso: recibo });
    expect(efeitos.recibosDeAgendamento()).toEqual([recibo]);
    expect(efeitos.produziuEfeito("crm_book_appointment")).toBe(false);
    expect(criarEfeitoDasEscrituras().recibosDeAgendamento()).toEqual([]);
  });

  it.each([
    { marcado: false, compromisso: recibo },
    { marcado: true, compromisso: { ...recibo, status: "pending" } },
    { marcado: true, compromisso: { ...recibo, status: "unknown" } },
    { marcado: true, compromisso: { ...recibo, ends_at: "inválido" } },
    { marcado: true, compromisso: { ...recibo, revision: undefined } },
    { marcado: true, compromisso: { ...recibo, human_confirmation: "check_human_record" } },
    { marcado: true, compromisso: recibo, agenda_externa_nunca_lida: true },
    { marcado: true, compromisso: recibo, aguarda_confirmacao: true },
    { mensagem: JSON.stringify(recibo) },
    { error: "falha", compromisso: recibo },
    { resultado_incerto: true, compromisso: recibo },
  ])("não transforma retorno inválido/pendente/incerto em confirmação: %j", (resultado) => {
    const efeitos = criarEfeitoDasEscrituras();
    const geracao = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(geracao, resultado);
    expect(efeitos.recibosDeAgendamento()).toEqual([]);
  });

  it("nova tentativa invalida a anterior, mesmo se falhar; resposta antiga não ressuscita", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const primeira = efeitos.iniciarAgendamento();
    efeitos.registrarRecibosDeAgendamento(primeira, { marcado: true, compromisso: recibo });
    efeitos.iniciarAgendamento();
    expect(efeitos.recibosDeAgendamento()).toEqual([]);
    efeitos.registrarRecibosDeAgendamento(primeira, { marcado: true, compromisso: recibo });
    expect(efeitos.recibosDeAgendamento()).toEqual([]);
  });

  it("devolve cópias: editar o resultado ou a leitura não fabrica outro comprovante", () => {
    const efeitos = criarEfeitoDasEscrituras();
    const resultado = { marcado: true, compromisso: { ...recibo } };
    efeitos.registrarRecibosDeAgendamento(efeitos.iniciarAgendamento(), resultado);
    resultado.compromisso.starts_at = "2026-12-11T13:00:00Z";
    const leitura = efeitos.recibosDeAgendamento();
    leitura[0]!.starts_at = "2026-12-12T13:00:00Z";
    expect(efeitos.recibosDeAgendamento()).toEqual([recibo]);
  });
});
