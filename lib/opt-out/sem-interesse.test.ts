import { describe, expect, it } from "vitest";

import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { classificarSemInteresse, ehFraseDeSemInteresse } from "@/lib/opt-out/sem-interesse";

/**
 * A frase do "não tenho interesse" (decisão D3). Quem decide ONDE ela vale é a
 * ingestão (só na conversa de prospecção); aqui só se mede a frase.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * Desligar o `SINAL_DE_INTERESSE` em `ehFraseDeSemInteresse`: as quatro últimas frases
 * de "cliente escolhendo" ficam vermelhas, e só elas (as outras têm uma segunda régua:
 * pergunta, complemento escolhido, condição ou contraste).
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
    // Recusa de UM item com pedido de outro, sem pergunta nem complemento escolhido:
    // só o sinal de interesse ("quero", "me manda", "quanto") as separa da recusa.
    "Não tenho interesse nisso, quero o outro modelo",
    "Não tenho interesse agora, me manda o preço para o mês que vem",
    "Por enquanto não tenho interesse, quanto fica no ano que vem",
    "Não tenho interesse nesse serviço, quero o site completo",
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

/**
 * Recusa ou adiamento (decisão do dono, 15/11, doc 360 · 2A): o "não" com data de volta
 * vira tarefa, não Perdido. Erro nos dois sentidos custa caro — adiamento lido como
 * recusa perde a venda marcada; recusa lida como adiamento volta a abordar quem disse não.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - `classificarSemInteresse` devolvendo "recusa" sempre que a frase casa (o
 *   comportamento antigo): todo o bloco "adiamento" fica vermelho.
 * - Tirar `!ehPedidoDeOptOut(texto)` de `podeSerAdiamento`: "por enquanto, me tira da
 *   lista" vira adiamento e fica vermelho.
 * - Tirar `RECUSA_DEFINITIVA`: "nem agora nem nunca" fica vermelho.
 */
describe("classificarSemInteresse", () => {
  it.each([
    "Não tenho interesse agora, me chama mês que vem",
    "não estou interessado agora, talvez mais pra frente",
    "Não temos interesse no momento.",
    "Por enquanto não tenho interesse",
    "Não tenho interesse agora, valeu",
    "agora não tenho interesse, quem sabe depois",
    "não me interessa por enquanto, obrigado",
    "Agora não, me chama mês que vem",
    "no momento não, me procura mais pra frente",
    // clínica
    "Por enquanto não tenho interesse, talvez depois das férias",
    "Não tenho interesse no momento, me chama no mês que vem que eu vejo a agenda",
    // imobiliária
    "No momento não estamos interessados, me procura no ano que vem",
    "não tenho interesse agora, só quando eu vender o apartamento, mais pra frente",
    // espanhol
    "No tengo interés por ahora",
  ])("adiamento: %s", (frase) => {
    expect(classificarSemInteresse(frase)).toBe("adiamento");
  });

  it.each([
    "Não tenho interesse",
    "nao tenho interesse, obrigado",
    "Não tenho mais interesse",
    "Não estou interessado, já tenho site",
    "não tenho interesse, nem agora nem nunca",
    "Não tenho interesse, não me chama nunca mais",
    // clínica e imobiliária
    "não tenho interesse, já tenho dentista",
    "Não temos interesse, já fechamos com outra imobiliária",
  ])("recusa: %s", (frase) => {
    expect(classificarSemInteresse(frase)).toBe("recusa");
  });

  it.each([
    "não tenho interesse, agora me tira da lista",
    "Não tenho interesse agora nem depois, me tira da lista",
    // o marcador de adiamento casa ("por enquanto"): só a guarda do PARAR a separa
    "Não tenho interesse por enquanto, me tira da lista",
  ])("pedido de saída nunca é adiamento — é o PARAR: %s", (frase) => {
    expect(ehPedidoDeOptOut(frase)).toBe(true);
    expect(classificarSemInteresse(frase)).not.toBe("adiamento");
  });

  it.each([
    "agora não",
    "Agora não posso falar",
    "Oi! Qual o horário de vocês?",
    "Não tenho interesse nesse horário, tem às 15h?",
    "não tenho interesse em fazer o clareamento agora, só a limpeza",
    "Não tenho interesse nesse apartamento, tem outro de dois quartos?",
    "Não tenho interesse agora, me manda o preço para o mês que vem",
  ])("nem recusa nem adiamento: %s", (frase) => {
    expect(classificarSemInteresse(frase)).toBeNull();
  });
});
