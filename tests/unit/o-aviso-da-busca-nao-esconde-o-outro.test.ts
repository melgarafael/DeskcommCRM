import { describe, expect, it } from "vitest";

import { avisosDaBusca } from "@/lib/mcp/tools/comercio";
import { buscarComRelaxamento } from "@/lib/catalogo/busca";

/**
 * O AVISO DE RELAXAMENTO NÃO PODE SER ENGOLIDO PELO DE EMPATE.
 *
 * ═══ O defeito, achado pelo Maestro na revisão ══════════════════════════════
 *
 * Os dois avisos eram `if/else` e o empate ganhava. Numa loja que não tem
 * nenhum produto com 512, "iphone 15 pro 512" relaxa o 512, acha o 128 e o
 * 256, e os dois empatam em 1.000 — então o agente recebia
 *
 *     "mais de um produto casa igualmente, pergunte qual é"
 *
 * e NÃO recebia "não há produto com 512 nesta loja". Resultado: ele perguntaria
 * "128 ou 256?" a quem pediu 512, que é exatamente o erro de capacidade que
 * esta busca existe para não cometer.
 *
 * ⚠️ E não é coincidência rara. Os dois coincidem SEMPRE que a variante ausente
 * empata os candidatos restantes — que é o formato do caso, não a exceção dele.
 */

const LOJA_SEM_512 = [
  { codigo: "IP15P-128", nome: "iPhone 15 Pro 128GB", marca: "Apple", categoria: "Celular" },
  { codigo: "IP15P-256", nome: "iPhone 15 Pro 256GB", marca: "Apple", categoria: "Celular" },
];

describe("os dois avisos somam, e o relaxamento vem primeiro", () => {
  it("empate + relaxamento juntos: o agente recebe OS DOIS", () => {
    const m = avisosDaBusca({ empate: true, ignorados: ["512"] });
    expect(m).toMatch(/não há produto com 512/);
    expect(m).toMatch(/Pergunte qual é/);
  });

  it("o relaxamento vem ANTES do empate — é a restrição mais forte", () => {
    // Ordem não é estética: quem lê primeiro "não temos 512" já sabe que a
    // resposta inteira muda. "Qual dos dois" é a pergunta seguinte, e só faz
    // sentido depois.
    const m = avisosDaBusca({ empate: true, ignorados: ["512"] });
    const ondeRelax = m.indexOf("não há produto");
    const ondeEmpate = m.indexOf("Pergunte qual é");

    // ⚠️ AS DUAS PRESENÇAS PRIMEIRO, E ISSO NÃO É ZELO. Só o `toBeLessThan`
    // passa VAZIO quando o relaxamento some: `indexOf` devolve -1, e -1 é menor
    // que qualquer posição. Medido — a sabotagem que apaga o relaxamento
    // deixava este caso VERDE, e ele é justamente o que deveria acusá-la.
    expect(ondeRelax, "o aviso de relaxamento sumiu da mensagem").toBeGreaterThanOrEqual(0);
    expect(ondeEmpate, "o aviso de empate sumiu da mensagem").toBeGreaterThanOrEqual(0);
    expect(ondeRelax).toBeLessThan(ondeEmpate);
  });

  it("cada um sozinho continua saindo sozinho", () => {
    expect(avisosDaBusca({ empate: true, ignorados: [] })).toMatch(/Pergunte qual é/);
    expect(avisosDaBusca({ empate: true, ignorados: [] })).not.toMatch(/não há produto/);
    expect(avisosDaBusca({ empate: false, ignorados: ["2"] })).toMatch(/não há produto com 2/);
    expect(avisosDaBusca({ empate: false, ignorados: ["2"] })).not.toMatch(/Pergunte qual é/);
  });

  it("busca exata não manda aviso nenhum (controle positivo)", () => {
    // Sem isto, "avisa sempre" satisfaria os casos acima — e aviso que aparece
    // toda vez vira ruído que o modelo aprende a ignorar.
    expect(avisosDaBusca({ empate: false, ignorados: [] })).toBe("");
  });
});

describe("o caso REAL que produz os dois ao mesmo tempo", () => {
  it('"iphone 15 pro 512" na loja sem 512: relaxa E empata', () => {
    // O cenário do defeito, montado de ponta a ponta em vez de assumido: a
    // busca de verdade tem de produzir as duas condições juntas, senão o teste
    // acima estaria medindo uma combinação que não acontece.
    const r = buscarComRelaxamento(LOJA_SEM_512, "iphone 15 pro 512");

    expect(r.ignorados).toEqual(["512"]);
    expect(r.achados).toHaveLength(2);
    expect(r.achados[0]!.nota).toBe(r.achados[1]!.nota);

    const m = avisosDaBusca({
      empate: r.achados[0]!.nota === r.achados[1]!.nota,
      ignorados: r.ignorados,
    });
    expect(m, "o agente perguntaria 128 ou 256 a quem pediu 512").toMatch(/não há produto com 512/);
  });
});
