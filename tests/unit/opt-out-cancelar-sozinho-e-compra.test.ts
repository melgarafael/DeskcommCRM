/**
 * #4579 — `cancelar` SOZINHO, "cancelar a inscrição" e "não quero receber o
 * boleto" gravavam `is_blocked` na INGESTÃO de um curso que atende pelo
 * WhatsApp.
 *
 * O vocabulário do aluno é o da compra: matrícula, inscrição, boleto, pix,
 * plano. Medido com as funções reais na `main` (1.110.0): as dez frases do
 * bloco "antes" abaixo devolviam `ehPedidoDeOptOut === true`. O bloqueio é
 * gravado ANTES do modelo (`lib/channels/pos-entrada.ts`), então o contato
 * sumia da conversa em silêncio, os negócios abertos viravam perdidos com
 * `opted_out_of_messages` e nenhum aviso ia à Central.
 *
 * ─── As três decisões, cada uma com o seu lado negativo ─────────────────────
 *
 * 1. `cancelar` sai de `PALAVRAS_DE_OPT_OUT`. No canal, a palavra solta é quase
 *    sempre a RESPOSTA a uma pergunta que a ofereceu ("confirmar, remarcar ou
 *    cancelar?") ou um botão com esse rótulo. NÃO vai para as ambíguas: o
 *    ambíguo manda ao cliente "vou parar de te enviar mensagens", promessa
 *    falsa para quem só respondeu a um menu. Cai em NADA.
 * 2. "cancelar a inscrição" SEM objeto vai para `FRASES_AMBIGUAS_DE_OPT_OUT`,
 *    o espelho da decisão da #2886 para `assinatura`: escala para um humano e
 *    não bloqueia. COM objeto de comunicação ("cancelar a inscrição das
 *    mensagens") continua bloqueando na hora.
 * 3. "não quero receber o boleto/o pix/o material" ganha o lookahead de objeto
 *    de compra que "parar de mandar o pedido" já tinha. Sem objeto ("não quero
 *    receber mais nada") segue bloqueando.
 *
 * O controle negativo que a issue exige está no primeiro `describe`: "quero
 * cancelar o pedido anterior" é a COMPRA, e não pode descadastrar ninguém.
 */
import { describe, expect, it } from "vitest";

import {
  PALAVRAS_DE_OPT_OUT,
  ehOptOutProvavel,
  ehPedidoDeOptOut,
} from "@/lib/opt-out/deteccao";

/** As dez frases que bloqueavam na `main`, medidas com as funções reais. */
describe("#4579 — antes: as frases que gravavam `is_blocked` na ingestão", () => {
  it("`cancelar` sozinho não é palavra de saída — é resposta de menu", () => {
    // Antes: `bloqueia=true` (estava em `PALAVRAS_DE_OPT_OUT`).
    for (const texto of ["cancelar", "Cancelar.", "CANCELAR", "Cancelar \u{1F44D}"]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      // Não escala: o ambíguo calaria a IA com uma promessa que ninguém pediu.
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    }
    expect(PALAVRAS_DE_OPT_OUT.has("cancelar")).toBe(false);
  });

  it("`cancelar a inscrição` SEM objeto só escala — não bloqueia", () => {
    // Antes: `bloqueia=true` (estava em `FRASES_DE_OPT_OUT`).
    for (const texto of [
      "quero cancelar a inscrição",
      "posso cancelar a inscrição e voltar depois?",
      "gostaria de cancelar a inscrição do concurso",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(true);
    }
  });

  it("`cancelar a inscrição` COM objeto de comunicação continua bloqueando", () => {
    // O outro lado: mover a forma sem objeto não pode afrouxar quem de fato
    // pediu para parar de receber.
    for (const texto of [
      "quero cancelar a inscrição das mensagens",
      "cancelar a inscrição da newsletter",
      "cancelar a inscrição dos avisos",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(true);
    }
  });

  it("`não quero receber o boleto` é forma de pagamento — não descadastro", () => {
    // Antes: `bloqueia=true` (o padrão só isentava ligação/chamada/telefone).
    for (const texto of [
      "não quero receber o boleto",
      "nao quero receber boleto, prefiro cartão",
      "não quero receber mais o boleto",
      "não quero receber o pix",
      "não quero receber o material do curso",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    }
  });
});

/**
 * O CONTROLE NEGATIVO obrigatório da issue: uma frase legítima de venda não
 * pode virar cancelamento. "quero cancelar o pedido anterior" já não bloqueava
 * na `main`; este bloco existe para que o conserto de cima não a leve junto.
 */
describe("#4579 — controle negativo: pedido de venda não descadastra", () => {
  it("`quero cancelar o pedido anterior` não descadastra ninguém", () => {
    expect(ehPedidoDeOptOut("quero cancelar o pedido anterior")).toBe(false);
    expect(ehOptOutProvavel("quero cancelar o pedido anterior")).toBe(false);
  });

  it("as outras frases de compra do mesmo corpus também não", () => {
    for (const texto of [
      "quero cancelar o pedido",
      "posso cancelar a consulta de amanhã?",
      "confirmar, remarcar ou cancelar?",
      "cancelar minha inscrição no curso",
      "quero trocar a forma de pagamento do boleto",
    ]) {
      expect(ehPedidoDeOptOut(texto), texto).toBe(false);
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    }
  });
});

/** O lado que NÃO pode regredir: quem pede para sair continua saindo. */
describe("#4579 — o pedido de saída de verdade segue bloqueando", () => {
  it("as palavras de saída do rodapé e as frases com objeto", () => {
    for (const texto of [
      "parar",
      "PARAR",
      "sair",
      "stop",
      "descadastrar",
      "não quero receber mais nada",
      "não quero receber mensagens",
      "não quero receber propaganda",
      "não quero mais receber nada de vocês",
      "não quero receber ligação, só whatsapp",
      // "envios" é o disparo em português (a lista de objetos é compartilhada
      // com o espanhol, onde é a remessa), e "material promocional" é a
      // própria propaganda: nenhum dos dois é forma de pagamento.
      "não quero receber mais envios",
      "não quero receber os envios de vocês",
      "não quero mais receber os envios",
      "não quero receber material promocional",
      "não quero receber material de propaganda",
      "não quero receber kit promocional",
    ]) {
      if (texto === "não quero receber ligação, só whatsapp") {
        // Troca de canal: quem diz isso QUER continuar no WhatsApp.
        expect(ehPedidoDeOptOut(texto), texto).toBe(false);
        continue;
      }
      expect(ehPedidoDeOptOut(texto), texto).toBe(true);
    }
  });
});
