/**
 * A TRAVA DE PREÇO LÊ EURO — e não lê número pela metade.
 *
 * A trava (`guardrails/promise/engine.ts`) veta a mensagem do agente que promete
 * preço abaixo do mínimo da tabela da organização. Ela só reconhecia `R$` e
 * "reais": numa organização que cobra em euro, o agente podia escrever `1 €` e
 * nada vetava.
 *
 * O cuidado que o euro traz é o milhar por ESPAÇO (`1 497,00 €`). Um detector
 * que não o conhece leria `497,00` — mil vezes menos — e vetaria um preço
 * legítimo. Os casos abaixo cobram as duas direções.
 */
import { describe, expect, it } from "vitest";

import { decidePromise, extractPromises } from "@/lib/agent-engine/guardrails/promise/engine";

const precos = (texto: string) => extractPromises(texto).filter((p) => p.kind === "price").map((p) => p.value);

describe("a trava reconhece preço em euro", () => {
  it("símbolo depois, símbolo antes e por extenso", () => {
    expect(precos("O Vitrine custa 49 € por mês.")).toEqual([4900]);
    expect(precos("Fica por €49.")).toEqual([4900]);
    expect(precos("São 0,50 € por encomenda acima das incluídas.")).toEqual([50]);
    expect(precos("Custa 199 euros.")).toEqual([19900]);
  });

  it("lê o milhar por espaço inteiro, inclusive o espaço fino do Intl", () => {
    expect(precos("A configuração anual sai 1 497,00 €.")).toEqual([149700]);
    expect(precos("A configuração anual sai 1 497,00 €.")).toEqual([149700]);
    expect(precos("Total de € 2 150.")).toEqual([215000]);
  });

  it("não começa nem para no meio de um número: o que não lê inteiro, não lê", () => {
    // `49.90 €` não é a convenção portuguesa; ler `90 €` seria inventar preço.
    expect(precos("Custa 49.90 €.")).toEqual([]);
    // E com o símbolo ANTES: parar em `€49` ou em `€1,23` (123 centavos, da
    // convenção irlandesa `€1,234.56`) vetaria um preço legítimo.
    expect(precos("Fica €49.90.")).toEqual([]);
    expect(precos("Fica €1,234.56 no ano.")).toEqual([]);
    expect(precos("Fica €49 90.")).toEqual([]);
  });

  it("veta abaixo do mínimo e responde na moeda que a mensagem usou", () => {
    const decisao = decidePromise({ candidate: "Faço por 1 € para ti.", table: { minPriceCents: 3900 } });
    expect(decisao.allow).toBe(false);
    expect(decisao.reason).toContain("1,00 €");
    expect(decisao.reason).toContain("39,00 €");
    expect(decisao.reason).not.toContain("R$");
  });

  it("e não veta o preço legítimo com milhar por espaço", () => {
    expect(decidePromise({ candidate: "Sai 1 497,00 € no ano.", table: { minPriceCents: 100000 } }).allow).toBe(true);
  });
});

describe("o real continua como estava", () => {
  it("R$, reais e o falso-positivo que a trava já evitava", () => {
    expect(precos("Sai por R$ 1.497,00.")).toEqual([149700]);
    expect(precos("São 500 reais.")).toEqual([50000]);
    expect(precos("Temos 500 clientes.")).toEqual([]);
    const decisao = decidePromise({ candidate: "Vendo por R$ 1.", table: { minPriceCents: 3900 } });
    expect(decisao.reason).toContain("R$ 1,00");
  });
});
