import { describe, expect, it } from "vitest";

import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { ehFraseDeSemInteresse } from "@/lib/opt-out/sem-interesse";

/**
 * A frase do "não tenho interesse" (decisão D3). Quem decide ONDE ela vale é a
 * ingestão (só na conversa de prospecção); aqui só se mede a frase.
 */
describe("ehFraseDeSemInteresse", () => {
  it.each([
    "Não tenho interesse",
    "nao tenho interesse, obrigado",
    "Não temos interesse no momento.",
    "Não tenho mais interesse",
    "não tenho nenhum interesse nisso",
    "Aqui não tem interesse",
    "A empresa não tem interesse",
    "Não me interessa",
    "não nos interessa, valeu",
    "Não estou interessado",
    "não tô interessada",
    "Não estamos interessados",
    "Estou sem interesse",
    "Sem interesse, obrigado",
    "Não tenho interesse, mas obrigado pelo contato",
    "não tenho interesse. quem te passou meu número?",
    "Bom dia. Não temos interesse.",
    "Não tenho interesse no serviço de vocês",
    "não tenho interesse em contratar, obrigado",
    "Por enquanto não tenho interesse",
    "Não tenho interesse agora, valeu",
    "não quero, não tenho interesse",
    "Não tenho interesse, de onde vocês tiraram meu número?",
    "Não estou interessado, já tenho site",
    // espanhol
    "No tengo interés",
    "no me interesa, gracias",
    "No estamos interesados",
  ])("recusa: %s", (frase) => {
    expect(ehFraseDeSemInteresse(frase)).toBe(true);
  });

  it.each([
    "Tenho interesse, quanto custa?",
    "Não quero pagar caro",
    "Não quero perder a vaga",
    "e se eu não tiver interesse?",
    "Caso não tenha interesse eu aviso",
    "Se não tenho interesse, por que responderia?",
    "Não é que não tenho interesse, só estou sem tempo",
    "Não tenho interesse nesse plano, mas tem outro mais barato?",
    "Vocês não têm interesse em uma parceria?",
    "Não tem interesse em conhecer nosso produto?",
    "parcelamento sem juros?",
    "",
    // espanhol
    "No me interesa ese plan, pero sí el otro",
  ])("NÃO é recusa: %s", (frase) => {
    expect(ehFraseDeSemInteresse(frase)).toBe(false);
  });

  // Achado de revisão: as frases de cliente INTERESSADO que a primeira régua gravava
  // como recusa. Numa conversa de prospecção, cada uma fechava o negócio como Perdido.
  it.each([
    "Não tenho interesse no plano mensal, quero o anual",
    "não tenho interesse em parcelar, vou pagar à vista",
    "Não estou interessado em pagar caro, qual o valor?",
    "Não me interessa o preço, quero qualidade",
    "Quem disse que não tenho interesse?",
    "Não tenho interesse? Claro que tenho! Me manda o preço",
    "Eu não disse que não tenho interesse",
    "Não tenho interesse em fidelidade, quero avulso. Quanto fica?",
    // vizinhas das de cima
    "Não tenho interesse no plano mensal",
    "Se for caro, não tenho interesse",
    "Você acha que não tenho interesse?",
    "Quero o anual. Não tenho interesse no mensal",
    "Não tenho interesse. Vocês fazem entrega?",
  ])("cliente escolhendo, NÃO é recusa: %s", (frase) => {
    expect(ehFraseDeSemInteresse(frase)).toBe(false);
    expect(ehPedidoDeOptOut(frase)).toBe(false);
  });

  it("nulo e vazio não casam", () => {
    expect(ehFraseDeSemInteresse(null)).toBe(false);
    expect(ehFraseDeSemInteresse(undefined)).toBe(false);
    expect(ehFraseDeSemInteresse("   ")).toBe(false);
  });

  it("não alarga o PARAR: 'não tenho interesse' continua sem bloquear", () => {
    // A cerca da outra regra: esta frase grava recusa de ofertas, nunca is_blocked.
    expect(ehPedidoDeOptOut("Não tenho interesse")).toBe(false);
    expect(ehPedidoDeOptOut("Não me interessa")).toBe(false);
  });
});
