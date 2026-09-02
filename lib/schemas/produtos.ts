import { z } from "zod";

/**
 * O CONTRATO DO CATÁLOGO — um só, lido pela tela E pela rota.
 *
 * ⚠️ Um schema por lado é como nasce controle decorativo: a tela oferece um
 * campo, a rota descarta o que não conhece, e o dono da loja clica em algo que
 * não faz nada. O repo já pagou isso — a tela de tipos de agendamento tem um
 * botão "Reativar" que manda um campo que o Zod da rota ignora, e a resposta
 * volta 422 sem explicar. Aqui os dois lados importam daqui.
 */

/** Como o produto entrou no catálogo. Vocabulário ABERTO, sem CHECK no banco. */
export const ORIGENS_DO_PRODUTO = ["manual", "planilha", "nuvemshop"] as const;
export type OrigemDoProduto = (typeof ORIGENS_DO_PRODUTO)[number];

/**
 * Preço em texto livre → centavos.
 *
 * ⚠️ Uma loja de rua manda "R$ 5.499,00", "5499,00", "5.499" e "5499". As
 * quatro formas significam a mesma coisa, e adivinhar errado é caro nos dois
 * sentidos: ler "5.499" como 5,499 põe um iPhone a cinco reais; ler "5,49" como
 * 549 cobra cem vezes mais.
 *
 * A regra que desfaz a ambiguidade: o ÚLTIMO separador manda, e o critério é o
 * TAMANHO do grupo depois dele. Um grupo de milhar tem SEMPRE três dígitos —
 * é o que "milhar" quer dizer. Logo um ou dois dígitos depois do último
 * separador não podem ser milhar: só podem ser centavos.
 *
 * ⚠️ Esta regra dizia "exatamente dois dígitos", e um dígito caía no ramo do
 * milhar. Um dígito é justamente o que o Excel EMITE: uma célula formatada como
 * número exibindo `1.299,90` sai no CSV como `1299,9`, porque a planilha corta
 * o zero final. Medido no fonte que estava na main:
 *
 *     "1299,9"  ->  1299900  =  R$ 12.999,00     (dez vezes o preço)
 *     "1299.9"  ->  1299900  =  R$ 12.999,00
 *
 * Sem recusar e sem avisar — o catálogo nascia com o preço errado e o agente
 * respondia esse preço ao cliente, que é o desfecho que este arquivo existe
 * para impedir. A suíte ficava verde: nenhum caso tinha um único dígito.
 *
 * ⚠️ E a limpeza APAGAVA as letras em vez de recusar a célula, o que colava os
 * dígitos do que estivesse junto:
 *
 *     "R$ 5.499,00 (promo ate 10)"  ->  R$ 54.990.010,00
 *     "de 89,90 por 49,90"          ->  R$ 899.049,90
 *
 * Agora só o símbolo da moeda e o espaço saem; qualquer outro caractere faz a
 * função devolver `null`. Preço é o campo onde adivinhar custa caro, então ele
 * falha FECHADO: a linha vira erro com motivo, que a pessoa lê e corrige, em
 * vez de virar um número plausível que ninguém confere.
 */
export function precoParaCentavos(entrada: string): number | null {
  // Só moeda e espaço são ruído conhecido. O `\u00A0` é o espaço não-quebrável
  // que o Excel gera ao formatar como moeda, e ele não casa `\s` em toda engine.
  const semRuido = entrada.replace(/\u00A0/g, " ").replace(/R\$/gi, " ").trim();
  // Qualquer coisa fora de dígito e separador significa que não sabemos ler
  // esta célula — e não saber é um desfecho melhor que chutar.
  if (!/^\d[\d.,]*$/.test(semRuido)) return null;
  const limpo = semRuido;

  const ultimoPonto = limpo.lastIndexOf(".");
  const ultimaVirgula = limpo.lastIndexOf(",");
  const corte = Math.max(ultimoPonto, ultimaVirgula);

  let inteiros = limpo;
  let decimais = "";
  if (corte !== -1) {
    const depois = limpo.slice(corte + 1);
    // Um ou dois dígitos depois do último separador = centavos, porque grupo de
    // milhar tem sempre TRÊS. Três dígitos, ou nenhum, é separador de milhar.
    if (/^\d{1,2}$/.test(depois)) {
      inteiros = limpo.slice(0, corte);
      decimais = depois;
    }
  }

  const so = inteiros.replace(/[.,]/g, "");
  if (so === "" || !/^\d+$/.test(so)) return null;
  return Number(so) * 100 + Number(decimais.padEnd(2, "0") || 0);
}

const codigo = z
  .string()
  .trim()
  .min(1, "o código não pode ficar em branco")
  .max(60)
  // Sem espaço nas pontas nem espaço duplo: o código é identidade, e "IP15 "
  // criando uma segunda linha de "IP15" é duplicata que ninguém vê.
  .transform((v) => v.replace(/\s+/g, " "));

const nome = z.string().trim().min(2, "o nome precisa de ao menos 2 letras").max(200);

export const produtoCreateSchema = z.object({
  codigo,
  nome,
  descricao: z.string().trim().max(2000).optional(),
  marca: z.string().trim().max(80).optional(),
  categoria: z.string().trim().max(80).optional(),
  preco_cents: z.number().int().min(0, "preço não pode ser negativo"),
  moeda: z.string().trim().length(3).toUpperCase().default("BRL"),
  custo_cents: z.number().int().min(0).nullable().optional(),
  controla_estoque: z.boolean().default(true),
  quantidade: z.number().int().min(0).default(0),
  ativo: z.boolean().default(true),
  imagem_url: z.string().trim().url().max(2000).optional(),
});

/** Tudo opcional: o PATCH muda o que veio e não encosta no resto. */
export const produtoPatchSchema = produtoCreateSchema.partial();

export type ProdutoCreate = z.infer<typeof produtoCreateSchema>;
export type ProdutoPatch = z.infer<typeof produtoPatchSchema>;

export interface Produto {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  marca: string | null;
  categoria: string | null;
  preco_cents: number;
  moeda: string;
  custo_cents: number | null;
  controla_estoque: boolean;
  quantidade: number;
  ativo: boolean;
  origem: string;
  imagem_url: string | null;
  updated_at: string;
}

/** As colunas que a tela e a rota leem — uma lista, não duas. */
export const COLUNAS_DO_PRODUTO =
  "id, codigo, nome, descricao, marca, categoria, preco_cents, moeda, custo_cents, " +
  "controla_estoque, quantidade, ativo, origem, imagem_url, updated_at";
