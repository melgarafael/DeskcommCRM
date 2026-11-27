import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";
import { erroComNomeDoResponsavel } from "./erro-de-responsavel";

const errBase = new ApiError(409, "responsavel_indisponivel", { user_id: "x-1" }, "req-1");

describe("erroComNomeDoResponsavel (#3067)", () => {
  it("responsavel_indisponivel com user_id conhecido → ApiError com frase contendo o nome, mesmos status/code/requestId", () => {
    const r = erroComNomeDoResponsavel(
      errBase,
      [{ id: "x-1", nome: "Ana" }],
      "{nome} não está disponível neste horário.",
    );
    expect(r).toBeInstanceOf(ApiError);
    const api = r as ApiError;
    expect(api.status).toBe(409);
    expect(api.code).toBe("responsavel_indisponivel");
    expect(api.requestId).toBe("req-1");
    expect(api.message).toContain("Ana");
  });

  it("id desconhecido → devolve o mesmo objeto", () => {
    const r = erroComNomeDoResponsavel(
      errBase,
      [{ id: "outro", nome: "Bruno" }],
      "{nome} está ocupado.",
    );
    expect(r).toBe(errBase);
  });

  it("outro código → mesmo objeto", () => {
    const outro = new ApiError(422, "agenda_horario_indisponivel", undefined, "req-2");
    const r = erroComNomeDoResponsavel(
      outro,
      [{ id: "x-1", nome: "Ana" }],
      "{nome} está ocupado.",
    );
    expect(r).toBe(outro);
  });

  it("erro que não é ApiError → mesmo objeto", () => {
    const erro = new Error("falhou");
    const r = erroComNomeDoResponsavel(erro, [{ id: "x-1", nome: "Ana" }], "{nome} está ocupado.");
    expect(r).toBe(erro);
  });
});
