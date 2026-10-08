import { precoParaCentavos, type Produto } from "@/lib/schemas/produtos";

/**
 * EDITAR O PRODUTO PELA TELA — o texto de quem digita vira o corpo do PATCH.
 *
 * ─── Por que isto mora FORA do componente ────────────────────────────────
 *
 * A tela só oferecia criar, importar, desativar e fotos: para corrigir um
 * preço era preciso reimportar a planilha (que de propósito não grava
 * `descricao` nem `ativo`). O `PATCH /api/v1/products/:id` já aceita mudanças
 * parciais desde sempre — faltava quem mandasse.
 *
 * Duas regras vivem aqui, e as duas precisam de teste sem DOM:
 *
 *  1. **Só o que mudou.** O PATCH é parcial, e a rota recusa corpo vazio com
 *     422 ("Nada para alterar."). Mandar o formulário inteiro a cada clique
 *     regravaria `updated_at` e geraria auditoria de mutação que não houve.
 *     Por isso o corpo é um DIFF contra a linha que está na tela — e a única
 *     coisa que não dá pra comparar é o preço em texto, que passa pela mesma
 *     régua fechada de sempre (`precoParaCentavos`).
 *
 *  2. **`origem` manda.** Vocabulário de `origem` é ABERTO (sem CHECK no
 *     banco): "manual" e "planilha" são escritos por quem opera este CRM,
 *     qualquer outra linha veio de uma integração que vai SOBRESCREVER o que
 *     for editado aqui na próxima sincronização. Então origem externa abre o
 *     formulário somente leitura com o aviso de que o lugar de editar é a
 *     origem — e as fotos continuam livres, porque a integração não as toca.
 */

/** O formulário: texto na tela, centavos e booleanos no PATCH. */
export interface RascunhoDaEdicao {
  codigo: string;
  nome: string;
  descricao: string;
  marca: string;
  categoria: string;
  preco: string;
  custo: string;
  quantidade: string;
  controla_estoque: boolean;
}

/** Origens que ESTE CRM escreve. Todo o resto veio de fora. */
const ORIGENS_DO_CRM = new Set(["manual", "planilha"]);

/**
 * `true` quando a linha é de uma fonte externa e editar aqui não vale.
 *
 * Origem vazia NÃO conta: linha antiga sem `origem` não indica fonte nenhuma,
 * e trancar a edição de catálogo legado por causa de um campo em branco seria
 * pior que deixar editar. Já um valor desconhecido CONTA — vocabulário aberto
 * significa que alguém escreveu aquilo de propósito, e o conservador aqui é
 * não prometer edição que a sincronização apaga.
 */
export function sincronizadoDeOrigem(origem: string): boolean {
  const valor = origem.trim().toLowerCase();
  if (valor === "") return false;
  return !ORIGENS_DO_CRM.has(valor);
}

/** Centavos do banco → o texto que a pessoa digita (24990 → "249,90"). */
export function centavosParaTexto(centavos: number | null): string {
  if (centavos === null) return "";
  const inteiro = Math.floor(centavos / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decimal = (centavos % 100).toString().padStart(2, "0");
  return `${inteiro},${decimal}`;
}

/** O formulário já preenchido com a linha que está na tela. */
export function rascunhoDaEdicao(produto: Produto): RascunhoDaEdicao {
  return {
    codigo: produto.codigo,
    nome: produto.nome,
    descricao: produto.descricao ?? "",
    marca: produto.marca ?? "",
    categoria: produto.categoria ?? "",
    preco: centavosParaTexto(produto.preco_cents),
    custo: centavosParaTexto(produto.custo_cents),
    quantidade: String(produto.quantidade),
    controla_estoque: produto.controla_estoque,
  };
}

export interface ResultadoDaEdicao {
  /** O corpo do PATCH: vazio quando nada mudou. */
  corpo: Record<string, unknown>;
  /** Motivo para não ir ao servidor, já traduzido para quem lê. */
  erro?: string;
}

type Tradutor = (texto: string) => string;

/**
 * O diff do formulário contra a linha. Só campos DIFERENTES entram — é o que
 * faz "sem mudança" virar `{}` (e a tela avisar) em vez de um PATCH que
 * regrava tudo igual.
 */
export function corpoDaEdicao(
  rascunho: RascunhoDaEdicao,
  produto: Produto,
  t: Tradutor,
): ResultadoDaEdicao {
  // Preço e custo falham FECHADO, como na criação: texto que não dá pra ler é
  // erro com motivo, não um número chutado.
  const preco = precoParaCentavos(rascunho.preco);
  if (preco === null) return { corpo: {}, erro: t("Preço inválido. Escreva assim: 5.499,00") };
  const custo = rascunho.custo.trim() === "" ? null : precoParaCentavos(rascunho.custo);
  if (rascunho.custo.trim() !== "" && custo === null) {
    return { corpo: {}, erro: t("Custo inválido.") };
  }

  // O código é identidade: mesma normalização do schema (espaço duplo vira
  // um), senão "IP15  " pareceria mudança e a rota devolveria 409.
  const codigo = rascunho.codigo.trim().replace(/\s+/g, " ");
  const nome = rascunho.nome.trim();
  const descricao = rascunho.descricao.trim();
  const marca = rascunho.marca.trim();
  const categoria = rascunho.categoria.trim();
  const quantidade = Math.max(0, Math.trunc(Number(rascunho.quantidade.replace(",", ".")) || 0));

  const corpo: Record<string, unknown> = {};
  if (codigo !== produto.codigo) corpo.codigo = codigo;
  if (nome !== produto.nome) corpo.nome = nome;
  if (descricao !== (produto.descricao ?? "")) corpo.descricao = descricao;
  if (marca !== (produto.marca ?? "")) corpo.marca = marca;
  if (categoria !== (produto.categoria ?? "")) corpo.categoria = categoria;
  if (preco !== produto.preco_cents) corpo.preco_cents = preco;
  if (custo !== produto.custo_cents) corpo.custo_cents = custo;
  if (rascunho.controla_estoque !== produto.controla_estoque) {
    corpo.controla_estoque = rascunho.controla_estoque;
  }
  if (quantidade !== produto.quantidade) corpo.quantidade = quantidade;

  return { corpo };
}
