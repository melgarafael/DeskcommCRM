import { describe, expect, it } from "vitest";

import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";

import { MOTIVO_DA_PAUSA_EM_TEXTO, mensagemDaRecusaDoCanal } from "./motivo-da-pausa";

/**
 * A PAUSA DA PROSPECÇÃO FALA HUMANO (#4170).
 *
 * O caso que abriu a issue: canal em modo de teste com a lista vazia — o
 * estado de TODO canal novo — e a campanha pausa dizendo
 * `fora_da_lista_de_teste`. Aqui mede-se o texto, e o CONTROLE NEGATIVO: um
 * motivo que ninguém traduziu continua saindo cru, porque inventar explicação
 * para um motivo não medido manda a pessoa mexer no que não está quebrado.
 */
describe("motivo da pausa da Prospecção em texto de tela", () => {
  it("fora da lista de teste: diz que o número está em modo de teste, o que a IA faz e onde liberar", () => {
    const texto = mensagemDaRecusaDoCanal("fora_da_lista_de_teste");

    expect(texto).toContain("modo de teste");
    expect(texto).toContain("só fala com os números da lista de teste");
    expect(texto).toContain("Conexões");
    expect(texto).toContain("Configurar acesso da IA");
    expect(texto).toContain("Liberar atendimento ao público");
    expect(texto, "o código interno não é texto de tela").not.toContain(
      "fora_da_lista_de_teste",
    );
  });

  it("motivo desconhecido: o código cru continua na tela, sem frase inventada", () => {
    const texto = mensagemDaRecusaDoCanal("motivo_que_ninguem_traduziu");

    expect(texto).toBe("O canal ainda não permite esta abordagem: motivo_que_ninguem_traduziu.");
    expect(texto).toContain("motivo_que_ninguem_traduziu");
  });

  it("todo texto do mapa tem espanhol no dicionário, e o português é a própria chave", () => {
    for (const [motivo, texto] of Object.entries(MOTIVO_DA_PAUSA_EM_TEXTO)) {
      expect(traduzir(texto, "pt-BR"), `mapa de ${motivo}`).toBe(texto);
      const espanhol = DICIONARIO[texto]?.es;
      expect(espanhol, `falta espanhol para o motivo ${motivo}`).toBeTruthy();
      expect(espanhol).not.toBe(texto);
    }
  });
});
