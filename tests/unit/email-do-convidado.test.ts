import { describe, expect, it } from "vitest";

import { emailDoConvidadoAoTrocarDeCliente } from "@/lib/agenda/email-do-convidado";

/**
 * O e-mail já estava no sistema e era digitado à mão.
 *
 * `contacts.email` existe. O campo "E-mail do convidado" nascia vazio, e quem
 * marcava redigitava um endereço que o CRM já tinha.
 *
 * O cuidado que decide o desenho é o AVESSO do defeito do cliente herdado.
 * Naquele, o painel abria com o cliente da vez anterior e marcava compromisso no
 * nome de outra pessoa. Aqui o risco é escrever por cima do endereço que alguém
 * digitou de propósito — e essa pessoa só descobriria depois do convite enviado.
 */
describe("preencher o e-mail do convidado sem atropelar ninguém", () => {
  it("campo intocado recebe o e-mail do cliente", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({
        atual: "",
        tocado: false,
        emailDoCliente: "ana@exemplo.com",
      }),
    ).toBe("ana@exemplo.com");
  });

  it("⛔ campo DIGITADO à mão não é sobrescrito", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({
        atual: "outro@exemplo.com",
        tocado: true,
        emailDoCliente: "ana@exemplo.com",
      }),
    ).toBe("outro@exemplo.com");
  });

  it("cliente sem e-mail deixa o campo vazio, como hoje", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({ atual: "", tocado: false, emailDoCliente: null }),
    ).toBe("");
  });

  it("trocar de cliente troca o preenchimento, enquanto ninguém digitou", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({
        atual: "ana@exemplo.com",
        tocado: false,
        emailDoCliente: "bruno@exemplo.com",
      }),
    ).toBe("bruno@exemplo.com");
  });

  it("⛔ CONTROLE: apagar de propósito é uma decisão, e ela manda", () => {
    // Este é o par que impede o conserto de virar um defeito novo. Campo vazio
    // porque ninguém mexeu e campo vazio porque alguém APAGOU são estados
    // diferentes, e só o marcador `tocado` os separa. Sem ele, o sistema
    // reescreveria por cima de quem acabou de apagar — e insistir contra uma
    // decisão explícita é pior que nunca ter preenchido.
    expect(
      emailDoConvidadoAoTrocarDeCliente({
        atual: "",
        tocado: true,
        emailDoCliente: "ana@exemplo.com",
      }),
    ).toBe("");
  });

  it("tirar o cliente esvazia o campo intocado, e só ele", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({
        atual: "ana@exemplo.com",
        tocado: false,
        emailDoCliente: null,
      }),
    ).toBe("");
    expect(
      emailDoConvidadoAoTrocarDeCliente({
        atual: "eu@exemplo.com",
        tocado: true,
        emailDoCliente: null,
      }),
    ).toBe("eu@exemplo.com");
  });

  it("undefined é tratado como ausência, não como string", () => {
    expect(
      emailDoConvidadoAoTrocarDeCliente({ atual: "x@y.z", tocado: false, emailDoCliente: undefined }),
    ).toBe("");
  });
});
