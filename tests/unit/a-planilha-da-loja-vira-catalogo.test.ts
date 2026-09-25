import { describe, expect, it } from "vitest";

import { lerPlanilha } from "@/lib/catalogo/planilha";
import { traduzir } from "@/lib/i18n/dicionario";

/**
 * A PLANILHA QUE A LOJA JÁ TEM VIRA CATÁLOGO.
 *
 * Ela não vem no formato que a gente gostaria: cabeçalho com acento, preço em
 * quatro grafias, linha em branco no meio, coluna a mais que ninguém pediu.
 * Nada disso é erro de quem mandou — é o arquivo real, exportado do Excel em
 * português.
 *
 * O que NÃO se aceita em silêncio é o ambíguo. Preço ilegível vira linha
 * recusada COM o valor cru na mensagem, para a pessoa achar a célula. Um chute
 * aqui vira preço errado dito a um cliente três dias depois.
 */

const planilha = (...linhas: string[]) => linhas.join("\n");

describe("lê o arquivo que a loja exporta", () => {
  it("aceita cabeçalho com acento, ponto-e-vírgula e preço em várias grafias", () => {
    // Excel pt-BR exporta com ";" — o parser detecta sozinho.
    const r = lerPlanilha(
      planilha(
        "Código;Produto;Preço;Marca",
        "IP15-128;iPhone 15 128GB;R$ 5.499,00;Apple",
        "PERF-212;212 VIP Men 100ml;449,90;Carolina Herrera",
        "FONE-01;Fone Bluetooth;199;Genérico",
      ),
    );

    expect("erro" in r).toBe(false);
    if ("erro" in r) return;
    expect(r.produtos).toHaveLength(3);
    expect(r.produtos[0]?.preco_cents).toBe(549900);
    expect(r.produtos[1]?.preco_cents).toBe(44990);
    expect(r.produtos[2]?.preco_cents).toBe(19900);
    expect(r.produtos[0]?.marca).toBe("Apple");
  });

  it("pula linha em branco no meio sem chamar de erro", () => {
    const r = lerPlanilha(planilha("nome,preco", "iPhone 15,5499", "", "MacBook Air,9999"));

    expect("erro" in r).toBe(false);
    if ("erro" in r) return;
    expect(r.produtos).toHaveLength(2);
    expect(r.erros).toEqual([]);
  });

  it("cada produto carrega a LINHA de onde veio", () => {
    // Sem isso, um erro que só o banco vê (constraint, código longo demais)
    // seria relatado sem endereço — e quem importou 300 linhas não teria como
    // achar a célula.
    const r = lerPlanilha(planilha("nome,preco", "iPhone 15,5499", "MacBook,9999"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos.map((p) => p.linha)).toEqual([2, 3]);
  });

  it("sem coluna de código, o NOME vira a identidade", () => {
    // É o que permite reimportar a planilha com preço novo e ATUALIZAR em vez
    // de duplicar — o gesto real da loja quando o dólar muda.
    const r = lerPlanilha(planilha("produto,valor", "iPhone 15 128GB,5499"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos[0]?.codigo).toBe("iPhone 15 128GB");
  });
});

/**
 * NOME LONGO NÃO PODE VIRAR O CÓDIGO DE OUTRO PRODUTO.
 *
 * ─── O defeito que este bloco guarda ────────────────────────────────────────
 *
 * Sem coluna `codigo`, o nome vira a identidade do produto, cortada em 60
 * caracteres. Nome de importado é longo e difere NO FIM — e é justamente o
 * sufixo (100 ml vs 200 ml, 128 vs 256 GB) que o corte comia: os dois produtos
 * chegavam com o MESMO código, e a segunda linha era recusada como "código
 * repetido na planilha (…)" citando um código que não existe em lugar nenhum da
 * planilha. O segundo produto simplesmente não entrava no catálogo.
 *
 * O corte também rodava ANTES de colapsar os espaços: nome cujo 60º caractere é
 * espaço saía com o código TERMINADO em espaço. O índice único do banco é sobre
 * o texto exato e o Zod da tela (`lib/schemas/produtos.ts`) faz `.trim()` —
 * editar o produto pela tela mudava a identidade dele, e a reimportação seguinte
 * criava uma SEGUNDA linha do mesmo produto: a duplicata que o cabeçalho da rota
 * de import promete impedir.
 *
 * Os dois casos usam o nome do achado da triagem de propósito: encurtado, ele
 * deixa de exercitar o corte, e as travas no meio dos testes avisam disso.
 */
describe("nome longo demais para o código não vira o código de OUTRO produto", () => {
  const IMPORTADO = "Perfume Importado Masculino Amadeirado Frasco Grande Edicao Especial";

  it("dois nomes que só diferem depois do caractere 60 entram como DOIS produtos", () => {
    const de100 = `${IMPORTADO} 100ml`;
    const de200 = `${IMPORTADO} 200ml`;
    // Trava do caso: os dois nomes compartilham os 60 primeiros caracteres.
    expect(de100.slice(0, 60)).toBe(de200.slice(0, 60));

    const r = lerPlanilha(planilha("nome,preco", `${de100},89,90`, `${de200},129,90`));

    if ("erro" in r) throw new Error(r.erro);
    // Antes, a segunda linha voltava como "código repetido na planilha" e o
    // produto simplesmente não existia para o agente.
    expect(r.erros).toEqual([]);
    expect(r.produtos).toHaveLength(2);
    expect(r.produtos[0]?.codigo).not.toBe(r.produtos[1]?.codigo);
  });

  it("o código não termina em espaço: a tela grava a MESMA identidade", () => {
    const de100 = `${IMPORTADO} 100ml`;
    // Trava do caso: o 60º caractere é um espaço — sem isso este teste deixa de
    // exercitar o corte-antes-do-colapso.
    expect(de100[59]).toBe(" ");

    const r = lerPlanilha(planilha("nome,preco", `${de100},89,90`));

    if ("erro" in r) throw new Error(r.erro);
    const codigo = r.produtos[0]?.codigo ?? "";
    expect(codigo).toBe(codigo.trim());
    expect(codigo).not.toMatch(/ {2}/);
    expect(codigo.length).toBeLessThanOrEqual(60);
  });

  it("reimportar a mesma planilha dá o MESMO código (atualiza em vez de duplicar)", () => {
    // Par do "não faça": uma assinatura vinda de relógio ou sorteio passaria no
    // teste de colisão e quebraria a reimportação, que é o gesto da loja quando
    // o preço muda.
    const linha = `${IMPORTADO} 100ml,89,90`;
    const primeira = lerPlanilha(planilha("nome,preco", linha));
    const segunda = lerPlanilha(planilha("nome,preco", linha));

    if ("erro" in primeira || "erro" in segunda) throw new Error("planilha recusada");
    expect(primeira.produtos[0]?.codigo).toBe(segunda.produtos[0]?.codigo);
  });

  it("código escrito à mão maior que a coluna também não colide", () => {
    const prefixo = "SKU-LOJA-2026-CONDICIONADOR-PROFISSIONAL-RECONSTRUCAO-TOTAL-QUERATINA-";
    const r = lerPlanilha(
      planilha(
        "codigo,nome,preco",
        `${prefixo}MANHA,Condicionador Manhã,89,90`,
        `${prefixo}NOITE,Condicionador Noite,89,90`,
      ),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos).toHaveLength(2);
    expect(r.produtos[0]?.codigo).not.toBe(r.produtos[1]?.codigo);
    expect(r.produtos[0]?.codigo.length).toBeLessThanOrEqual(60);
  });
});

describe("recusa o que não dá para ler — e diz onde", () => {
  it("preço ilegível vira erro COM o valor cru e o número da linha", () => {
    const r = lerPlanilha(
      planilha("nome,preco", "iPhone 15,5499", "MacBook,sob consulta", "AirPods,1299"),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos).toHaveLength(2);
    expect(r.erros).toHaveLength(1);
    // A linha 3 é a que a pessoa vê na planilha, contando o cabeçalho.
    expect(r.erros[0]?.linha).toBe(3);
    expect(r.erros[0]?.motivo).toContain("sob consulta");
  });

  it("recusa a planilha INTEIRA quando falta nome ou preço, antes de processar", () => {
    // Dizer isso de saída evita um relatório com 300 erros idênticos.
    const r = lerPlanilha(planilha("marca,categoria", "Apple,Celular"));

    expect("erro" in r).toBe(true);
    if (!("erro" in r)) return;
    expect(r.erro).toContain("preço");
  });

  it("código repetido na mesma planilha é recusado, não sobrescrito em silêncio", () => {
    const r = lerPlanilha(
      planilha("codigo,nome,preco", "IP15,iPhone 15,5499", "IP15,iPhone 15 Pro,7999"),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos).toHaveLength(1);
    expect(r.erros[0]?.motivo).toContain("repetido");
    // A mensagem aponta a OUTRA linha do par: a recusada já vem no `linha`.
    expect(r.erros[0]).toMatchObject({ linha: 3 });
    expect(r.erros[0]?.motivo).toContain("linha 2");
  });
});

/**
 * "IP15" E "ip15" SÃO O MESMO PRODUTO (#482, decisão do mantenedor de 22/09/2026).
 *
 * A busca do agente ignora a caixa (`normalizar()` em `lib/catalogo/busca.ts`):
 * duas linhas que só diferem nela virariam um produto com dois preços na
 * conversa. A planilha recusa a segunda — e, como a diferença não salta aos
 * olhos, a mensagem diz com qual linha ela colide e como estava escrita lá.
 */
describe("o código não diferencia maiúsculas", () => {
  it("IP15 e ip15 na mesma planilha: a segunda linha é recusada citando a primeira", () => {
    const r = lerPlanilha(
      planilha(
        "codigo,nome,preco",
        "IP15,iPhone 15 128GB,5499",
        "ip15,iPhone 15 128GB (importado),4999",
      ),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos.map((p) => p.codigo)).toEqual(["IP15"]);
    expect(r.erros).toEqual([
      {
        linha: 3,
        motivo:
          'código repetido na planilha ("ip15") — já está na linha 2, escrito "IP15". Maiúsculas e minúsculas não mudam o código.',
      },
    ]);
  });

  it("IP15 e IP16 entram os dois", () => {
    const r = lerPlanilha(
      planilha("codigo,nome,preco", "IP15,iPhone 15,5499", "IP16,iPhone 16,6499"),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.erros).toEqual([]);
    expect(r.produtos.map((p) => p.codigo)).toEqual(["IP15", "IP16"]);
  });

  it("a mensagem nova chega em espanhol a quem usa a tela em espanhol", () => {
    const r = lerPlanilha(
      planilha("codigo,nome,preco", "IP15,iPhone 15,5499", "ip15,iPhone 15,4999"),
      (texto) => traduzir(texto, "es"),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.erros[0]?.motivo).toBe(
      'código repetido en la hoja ("ip15") — ya está en la fila 2, escrito "IP15". Mayúsculas y minúsculas no cambian el código.',
    );
  });

  it("o código repetido escrito igual também chega inteiro em espanhol", () => {
    const r = lerPlanilha(
      planilha("codigo,nome,preco", "IP15,iPhone 15,5499", "IP15,iPhone 15 Pro,7999"),
      (texto) => traduzir(texto, "es"),
    );

    if ("erro" in r) throw new Error(r.erro);
    expect(r.erros[0]?.motivo).toBe('código repetido en la hoja ("IP15") — ya está en la fila 2');
  });

  it("o código entra na mensagem como foi escrito, mesmo parecendo placeholder", () => {
    const r = lerPlanilha(planilha("codigo,nome,preco", "X{linha}$&,Um,10", "x{linha}$&,Dois,20"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.erros[0]?.motivo).toBe(
      'código repetido na planilha ("x{linha}$&") — já está na linha 2, escrito "X{linha}$&". Maiúsculas e minúsculas não mudam o código.',
    );
  });
});

describe("a coluna de estoque AUSENTE não é estoque zero", () => {
  it("sem coluna de quantidade, o produto não é controlado por estoque", () => {
    // A distinção decide se o agente enxerga o catálogo: marcado como
    // controlado com zero unidades, todo produto sumiria da busca.
    const r = lerPlanilha(planilha("nome,preco", "Decant 10ml,89,90"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos[0]?.controla_estoque).toBe(false);
  });

  it("com a coluna, o estoque é respeitado", () => {
    const r = lerPlanilha(planilha("nome,preco,estoque", "iPhone 15,5499,3"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.produtos[0]?.controla_estoque).toBe(true);
    expect(r.produtos[0]?.quantidade).toBe(3);
  });
});

describe("coluna desconhecida é relatada, não ignorada em silêncio", () => {
  it("avisa o que não foi usado", () => {
    // Quem mandou a planilha precisa saber que a coluna "Fornecedor" não entrou
    // — senão vai procurar por ela depois e concluir que o sistema perdeu dado.
    const r = lerPlanilha(planilha("nome,preco,Fornecedor", "iPhone 15,5499,Distribuidora X"));

    if ("erro" in r) throw new Error(r.erro);
    expect(r.colunasIgnoradas).toEqual(["Fornecedor"]);
  });
});
