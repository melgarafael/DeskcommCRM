import { parseCsv } from "@/lib/contacts/csv";
import { precoParaCentavos } from "@/lib/schemas/produtos";

/**
 * A PLANILHA DA LOJA — do arquivo que ela já tem para o catálogo.
 *
 * ─── Por que reusa o parser de contatos ─────────────────────────────────────
 *
 * `parseCsv` é RFC 4180, sem dependência, já testado, e detecta o delimitador
 * (o Excel em português exporta com `;`). Copiá-lo para cá criaria a segunda
 * verdade sobre o que é um CSV — e a segunda envelhece sozinha. O que é DESTE
 * domínio é só o mapeamento: quais colunas, e o que fazer com cada valor.
 *
 * ─── A planilha vem suja, e recusar é a função ──────────────────────────────
 *
 * Loja de rua manda "R$ 5.499,00" e "5499", nome com espaço duplo, linha em
 * branco no meio e coluna com acento. Nada disso é erro da pessoa — é o formato
 * real. O que NÃO se aceita em silêncio é o ambíguo: preço que não dá para ler
 * vira linha recusada com o motivo, nunca um chute. Um chute aqui é preço
 * errado dito a um cliente depois.
 */

/** Como cada coluna pode vir escrita. A primeira forma é a que a gente sugere. */
const COLUNAS: Record<string, readonly string[]> = {
  codigo: ["codigo", "código", "sku", "ref", "referencia", "referência", "cod"],
  nome: ["nome", "produto", "descricao", "descrição", "titulo", "título", "item"],
  preco: ["preco", "preço", "valor", "preco de venda", "preço de venda", "venda"],
  custo: ["custo", "preco de custo", "preço de custo", "compra"],
  marca: ["marca", "fabricante"],
  categoria: ["categoria", "tipo", "departamento"],
  quantidade: ["quantidade", "estoque", "qtd", "qtde", "qty"],
};

function normalizarCabecalho(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Qual campo do produto esta coluna da planilha representa? */
function campoDaColuna(cabecalho: string): string | null {
  const alvo = normalizarCabecalho(cabecalho);
  for (const [campo, formas] of Object.entries(COLUNAS)) {
    if (formas.some((f) => normalizarCabecalho(f) === alvo)) return campo;
  }
  return null;
}

export interface LinhaImportada {
  /** A linha como a pessoa a vê na planilha: 1 é o cabeçalho. */
  linha: number;
  codigo: string;
  nome: string;
  preco_cents: number;
  custo_cents: number | null;
  marca?: string;
  categoria?: string;
  quantidade: number;
  controla_estoque: boolean;
}

export interface ErroDaLinha {
  /** A linha como a pessoa a vê na planilha: 1 é o cabeçalho. */
  linha: number;
  motivo: string;
}

export interface ResultadoDaLeitura {
  produtos: LinhaImportada[];
  erros: ErroDaLinha[];
  /** Colunas que a planilha trouxe e este importador não conhece. */
  colunasIgnoradas: string[];
}

export function lerPlanilha(conteudo: string): ResultadoDaLeitura | { erro: string } {
  const linhas = parseCsv(conteudo).filter((l) => l.some((c) => c.trim() !== ""));
  if (linhas.length === 0) return { erro: "A planilha está vazia." };

  const cabecalho = linhas[0]!;
  const mapa = new Map<number, string>();
  const colunasIgnoradas: string[] = [];
  cabecalho.forEach((titulo, i) => {
    const campo = campoDaColuna(titulo);
    if (campo) mapa.set(i, campo);
    else if (titulo.trim() !== "") colunasIgnoradas.push(titulo.trim());
  });

  const campos = new Set(mapa.values());
  // Sem nome ou sem preço não há catálogo — e dizer isso ANTES de processar 300
  // linhas é o que evita um relatório com 300 erros iguais.
  const faltando = ["nome", "preco"].filter((c) => !campos.has(c));
  if (faltando.length > 0) {
    return {
      erro:
        `A planilha precisa de uma coluna de ${faltando.map((f) => (f === "preco" ? "preço" : f)).join(" e de ")}. ` +
        `Encontrei: ${cabecalho.filter((c) => c.trim()).join(", ") || "nenhuma coluna"}.`,
    };
  }

  const produtos: LinhaImportada[] = [];
  const erros: ErroDaLinha[] = [];
  const codigosVistos = new Set<string>();

  for (let i = 1; i < linhas.length; i += 1) {
    const bruto = linhas[i]!;
    const numeroNaPlanilha = i + 1;
    const valor = (campo: string): string => {
      for (const [idx, c] of mapa) if (c === campo) return (bruto[idx] ?? "").trim();
      return "";
    };

    const nome = valor("nome").replace(/\s+/g, " ");
    if (nome === "") {
      erros.push({ linha: numeroNaPlanilha, motivo: "sem nome do produto" });
      continue;
    }

    const preco_cents = precoParaCentavos(valor("preco"));
    if (preco_cents === null) {
      // O valor cru entra na mensagem: quem vai corrigir precisa achar a célula.
      erros.push({
        linha: numeroNaPlanilha,
        motivo: `preço não reconhecido ("${valor("preco")}") — escreva assim: 5.499,00`,
      });
      continue;
    }

    const custoTexto = valor("custo");
    const custo_cents = custoTexto === "" ? null : precoParaCentavos(custoTexto);
    if (custoTexto !== "" && custo_cents === null) {
      erros.push({ linha: numeroNaPlanilha, motivo: `custo não reconhecido ("${custoTexto}")` });
      continue;
    }

    // Sem código na planilha, o nome vira a identidade. É o que permite reimportar
    // a mesma planilha atualizando em vez de duplicar — que é o gesto real da
    // loja quando o preço muda.
    const codigo = (valor("codigo") || nome).slice(0, 60).replace(/\s+/g, " ");
    if (codigosVistos.has(codigo.toLowerCase())) {
      erros.push({ linha: numeroNaPlanilha, motivo: `código repetido na planilha ("${codigo}")` });
      continue;
    }
    codigosVistos.add(codigo.toLowerCase());

    // Coluna de estoque AUSENTE significa "esta loja não conta estoque" — e é
    // diferente de estoque zero. Sem essa distinção, uma planilha sem a coluna
    // deixaria o catálogo inteiro invisível para o agente.
    const temColunaEstoque = campos.has("quantidade");
    const qtdTexto = valor("quantidade");
    const quantidade = temColunaEstoque ? Number(qtdTexto.replace(/\D/g, "")) || 0 : 0;

    produtos.push({
      linha: numeroNaPlanilha,
      codigo,
      nome,
      preco_cents,
      custo_cents,
      ...(valor("marca") ? { marca: valor("marca") } : {}),
      ...(valor("categoria") ? { categoria: valor("categoria") } : {}),
      quantidade,
      controla_estoque: temColunaEstoque,
    });
  }

  return { produtos, erros, colunasIgnoradas };
}
