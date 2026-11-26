import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";

import { traduzErroResponsaveis } from "./responsaveis";

const REQ = "req-teste";
const UUID = "aaaaaaaa-0000-4000-8000-0000000000aa";

describe("traduzErroResponsaveis — exceção nomeada do banco vira ApiError", () => {
  it("teto de adicionais vira 422 agenda_responsaveis_teto", () => {
    const erro = traduzErroResponsaveis({ message: "appointment_responsibles_limit" }, REQ);
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 422, code: "agenda_responsaveis_teto" });
  });

  it("forma/membro/principal/repetido vira 422 agenda_responsaveis_invalidos", () => {
    const erro = traduzErroResponsaveis({ message: "ERROR: appointment_responsibles_invalid" }, REQ);
    expect(erro).toMatchObject({ status: 422, code: "agenda_responsaveis_invalidos" });
  });

  it("ocupação de adicional vira 409 responsavel_indisponivel e leva o uuid de quem ficou ocupado", () => {
    const erro = traduzErroResponsaveis({ message: "responsible_unavailable", details: UUID }, REQ);
    expect(erro).toMatchObject({
      status: 409,
      code: "responsavel_indisponivel",
      details: { user_id: UUID },
    });
  });

  it("ocupação sem DETAIL devolve user_id nulo, sem quebrar", () => {
    const erro = traduzErroResponsaveis({ message: "responsible_unavailable" }, REQ);
    expect(erro).toMatchObject({ code: "responsavel_indisponivel", details: { user_id: null } });
  });

  it("conflito de equipe da sessão coletiva vira 409 service_team_conflict", () => {
    const erro = traduzErroResponsaveis({ message: "service_team_conflict" }, REQ);
    expect(erro).toMatchObject({ status: 409, code: "service_team_conflict" });
  });

  it("erro que não é de responsáveis devolve null, para o mapeamento genérico de quem chamou", () => {
    expect(traduzErroResponsaveis({ message: "agenda_horario_indisponivel" }, REQ)).toBeNull();
    expect(traduzErroResponsaveis({ message: "" }, REQ)).toBeNull();
    expect(traduzErroResponsaveis({}, REQ)).toBeNull();
  });
});

describe("traduzErroResponsaveis — exceções da criação para ids forjados viram 422, nunca 500", () => {
  it("tipo de outra organização vira 422 agenda_tipo_invalido", () => {
    expect(traduzErroResponsaveis({ message: "appointment_event_type_invalid" }, REQ)).toMatchObject({
      status: 422,
      code: "agenda_tipo_invalido",
    });
  });

  it("contato de outra organização vira 422 agenda_contato_invalido", () => {
    expect(traduzErroResponsaveis({ message: "appointment_contact_invalid" }, REQ)).toMatchObject({
      status: 422,
      code: "agenda_contato_invalido",
    });
  });

  it("dono fora da organização vira 422 agenda_dono_invalido", () => {
    expect(traduzErroResponsaveis({ message: "appointment_owner_invalid" }, REQ)).toMatchObject({
      status: 422,
      code: "agenda_dono_invalido",
    });
  });

  it("conversa de outra organização vira 422 agenda_conversa_invalida", () => {
    expect(traduzErroResponsaveis({ message: "appointment_conversation_invalid" }, REQ)).toMatchObject({
      status: 422,
      code: "agenda_conversa_invalida",
    });
  });

  it("convidado da equipe de outra organização vira 422 agenda_equipe_invalida", () => {
    expect(traduzErroResponsaveis({ message: "appointment_team_guests_invalid" }, REQ)).toMatchObject({
      status: 422,
      code: "agenda_equipe_invalida",
    });
  });
});
