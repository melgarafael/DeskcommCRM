// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mensagemDaRecusaDePublicacao } from "@/lib/agenda/google/sync-executor";

/**
 * ERRO PERMANENTE DO BANCO NÃO É "O COMPROMISSO MUDOU" (#4448).
 *
 * O executor gravava a frase "O compromisso mudou. A sincronização vai reler a
 * versão atual." para QUALQUER erro de banco que trouxesse `code`. A frase é um
 * convite a tentar de novo — e é verdade para o `PT409` (`google_stale`), que
 * nasce de uma versão vencida e se resolve relendo. Para o `42501`
 * (`google_connection_unavailable`) ela é mentira: nada mudou, a agenda de
 * destino está indisponível e repetir não muda o resultado.
 *
 * É essa diferença que este arquivo mede — a frase persistida em
 * `google_sync_error` e mostrada a quem opera.
 */

/** O erro como o `googleRpc` entrega: `Error` com `code` do SQLSTATE. */
function erroDoBanco(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe("erro de banco no executor: permanente tem frase própria", () => {
  it("42501 (google_connection_unavailable) não é lido como versão desatualizada", () => {
    const mensagem = mensagemDaRecusaDePublicacao(
      erroDoBanco("42501", "google_connection_unavailable"),
      "PATCH",
    );
    expect(mensagem).not.toContain("O compromisso mudou");
    expect(mensagem).not.toContain("reler a versão atual");
    expect(mensagem).toContain("agenda de destino");
    expect(mensagem.length).toBeLessThanOrEqual(200);
  });

  it("o PT409 continua dizendo que o compromisso mudou (nada mudou aqui)", () => {
    const mensagem = mensagemDaRecusaDePublicacao(erroDoBanco("PT409", "google_stale"), "PATCH");
    expect(mensagem).toBe(
      "O compromisso mudou. A sincronização vai reler a versão atual.",
    );
  });

  it("guarda que não é de versão (42501 do dono, P0002) também não vira 'mudou'", () => {
    for (const [code, texto] of [
      ["42501", "google_owner_unavailable"],
      ["42501", "google_contact_redacted"],
      ["P0002", "appointment_not_found"],
      ["22023", "google_action_invalid"],
    ] as const) {
      const mensagem = mensagemDaRecusaDePublicacao(erroDoBanco(code, texto), "PATCH");
      expect(mensagem, `${code}/${texto}`).not.toContain("O compromisso mudou");
    }
  });

  it("erro sem `code` mantém a frase genérica de conexão", () => {
    expect(mensagemDaRecusaDePublicacao(new Error("falhou"), "PATCH")).toBe(
      "Não foi possível sincronizar. Confira a conexão e tente novamente.",
    );
  });

  it("falha de rede (`code` vazio ou indefinido) também não é guarda permanente", () => {
    for (const code of ["", undefined]) {
      const erro = Object.assign(new Error("TypeError: fetch failed"), { code });
      expect(mensagemDaRecusaDePublicacao(erro, "PATCH"), String(code)).toBe(
        "Não foi possível sincronizar. Confira a conexão e tente novamente.",
      );
    }
  });
});
