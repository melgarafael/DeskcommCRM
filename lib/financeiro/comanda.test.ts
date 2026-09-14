/**
 * A comissão é a conta que a rota faz ANTES do insert, e que a finalização não
 * refaz. Um erro aqui não aparece em teste de tela: a comanda fecha, o dinheiro
 * entra, o cliente vai embora satisfeito, e o que falta é a parte de quem
 * atendeu — descoberta no fim do mês, por uma pessoa conferindo à mão.
 */
import { describe, expect, it } from "vitest";

import { percentualDaComissao, totalDoItem, type RegraDeComissao } from "./comanda";

const ANA = "11111111-1111-4111-8111-111111111111";
const BIA = "22222222-2222-4222-8222-222222222222";
const MANICURE = "33333333-3333-4333-8333-333333333333";
const PEDICURE = "44444444-4444-4444-8444-444444444444";

const regra = (over: Partial<RegraDeComissao>): RegraDeComissao => ({
  attendant_user_id: null,
  event_type_id: null,
  percent: 0,
  ...over,
});

describe("percentualDaComissao", () => {
  it("sem regra nenhuma é zero, e zero é resposta legítima", () => {
    expect(percentualDaComissao([], { attendantUserId: ANA, eventTypeId: MANICURE })).toBe(0);
  });

  it("regra por SERVIÇO vale para quem atender", () => {
    const regras = [regra({ event_type_id: MANICURE, percent: 30 })];
    expect(percentualDaComissao(regras, { attendantUserId: ANA, eventTypeId: MANICURE })).toBe(30);
    expect(percentualDaComissao(regras, { attendantUserId: BIA, eventTypeId: MANICURE })).toBe(30);
  });

  it("regra por PESSOA vale para o que ela fizer", () => {
    const regras = [regra({ attendant_user_id: ANA, percent: 40 })];
    expect(percentualDaComissao(regras, { attendantUserId: ANA, eventTypeId: PEDICURE })).toBe(40);
    expect(percentualDaComissao(regras, { attendantUserId: BIA, eventTypeId: PEDICURE })).toBe(0);
  });

  it("PESSOA vence SERVIÇO — a regra sobre quem atende é mais específica", () => {
    const regras = [
      regra({ event_type_id: MANICURE, percent: 30 }),
      regra({ attendant_user_id: ANA, percent: 40 }),
    ];
    expect(percentualDaComissao(regras, { attendantUserId: ANA, eventTypeId: MANICURE })).toBe(40);
  });

  it("PESSOA + SERVIÇO vence as duas, mesmo sendo o MENOR percentual", () => {
    // O caso que prova que a precedência é por especificidade, e não por valor:
    // se ganhasse o maior, a combinação exata que alguém escreveu para este par
    // seria ignorada sempre que fosse mais baixa.
    const regras = [
      regra({ event_type_id: MANICURE, percent: 30 }),
      regra({ attendant_user_id: ANA, percent: 40 }),
      regra({ attendant_user_id: ANA, event_type_id: MANICURE, percent: 10 }),
    ];
    expect(percentualDaComissao(regras, { attendantUserId: ANA, eventTypeId: MANICURE })).toBe(10);
  });

  it("a regra exata de OUTRO par não contamina este", () => {
    const regras = [
      regra({ attendant_user_id: BIA, event_type_id: MANICURE, percent: 90 }),
      regra({ event_type_id: MANICURE, percent: 30 }),
    ];
    expect(percentualDaComissao(regras, { attendantUserId: ANA, eventTypeId: MANICURE })).toBe(30);
  });

  it("item sem profissional cai na regra do serviço, nunca na de uma pessoa", () => {
    const regras = [
      regra({ attendant_user_id: ANA, percent: 40 }),
      regra({ event_type_id: MANICURE, percent: 30 }),
    ];
    expect(percentualDaComissao(regras, { attendantUserId: null, eventTypeId: MANICURE })).toBe(30);
  });

  it("item sem serviço cai na regra da pessoa", () => {
    const regras = [regra({ attendant_user_id: ANA, percent: 40 })];
    expect(percentualDaComissao(regras, { attendantUserId: ANA, eventTypeId: null })).toBe(40);
  });

  it("empate no MESMO nível resolve pelo maior — a favor de quem trabalhou", () => {
    const regras = [
      regra({ attendant_user_id: ANA, percent: 20 }),
      regra({ attendant_user_id: ANA, percent: 35 }),
    ];
    expect(percentualDaComissao(regras, { attendantUserId: ANA, eventTypeId: MANICURE })).toBe(35);
  });
});

describe("totalDoItem", () => {
  it("quantidade vezes preço, menos o desconto do item", () => {
    expect(totalDoItem({ quantidade: 2, precoUnitarioCents: 5000, descontoCents: 1000 })).toBe(9000);
  });

  it("sem desconto é quantidade vezes preço", () => {
    expect(totalDoItem({ quantidade: 3, precoUnitarioCents: 2500, descontoCents: 0 })).toBe(7500);
  });

  it("desconto maior que o item vira zero, nunca crédito", () => {
    // Um total negativo entraria na soma da comanda abatendo os outros itens —
    // um desconto que se espalha sem ninguém ter pedido.
    expect(totalDoItem({ quantidade: 1, precoUnitarioCents: 3000, descontoCents: 5000 })).toBe(0);
  });

  it("item de cortesia é zero, e é uma configuração legítima", () => {
    expect(totalDoItem({ quantidade: 1, precoUnitarioCents: 0, descontoCents: 0 })).toBe(0);
  });
});
