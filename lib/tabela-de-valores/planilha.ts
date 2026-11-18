import type { SheetMatrix } from "@/lib/planilha/ler-arquivo";
import type {
  LeituraDaTabelaDeValores,
  LinhaDaTabela,
  LinhaRecusada,
  MotivoDeRecusa,
} from "@/lib/tabela-de-valores/tipos";
import {
  TEXTO_DO_MOTIVO,
  TABELA_MAX_LINHAS,
} from "@/lib/tabela-de-valores/tipos";

/**
 * A PLANILHA DA TABELA DE VALORES — leitura e recusa, sem gravar nada.
 *
 * O arquivo que a empresa manda é a tabela do convênio: código do procedimento,
 * descrição e as duas pontas de preço, em US e em reais. Quase nunca vem limpo
 * — vem com "R$" na célula, com "1.234,56" do Excel em português, com o limite
 * digitado abaixo da partida (que é o erro que motiva a fatia inteira) e com o
 * mesmo código em duas linhas.
 *
 * Este módulo só LÊ e VALIDA: devolve o que seria gravado e a lista de recusas
 * com motivo. Quem grava é `store.ts`, e só depois do "confirmar" — a prévia
 * passa pelo mesmo leitor, então o que o operador vê é exatamente o que entra.
 *
 * ─── Por que a coluna é reconhecida por palavra, e não por nome exato ─────
 *
 * "Valor de partida (R$)", "VALOR PARTIDA R$" e "valor de partida" são a mesma
 * coluna, e nenhuma delas é `valor_brl_partida_cents`. Exigir o nome exato
 * obrigaria a empresa a renomear o cabeçalho da planilha dela — e a planilha é
 * da empresa. Então o cabeçalho é reduzido a palavras (sem acento, sem
 * maiúscula, sem pontuação) e o reconhecimento é por combinação:
 *
 *   - a MOEDA: `us`, `usd`, `dolar`/`dollar` (US) ou `reais`, `real`, `brl`, `r$`
 *     (reais). Sem moeda no cabeçalho, o valor é em REAIS — é a moeda da casa;
 *   - a PONTA: `partida`, `inicial`, `minimo`, `piso` (partida) ou `limite`,
 *     `maximo`, `teto`, `final` (limite).
 *
 * Cabeçalho que não vira campo nenhum é IGNORADO e volta em `colunasIgnoradas`,
 * para a tela poder dizer "não usei estas colunas" em vez de o operador achar
 * que entrou tudo.
 */

type Campo =
  | "codigo"
  | "descricao"
  | "unidade"
  | "observacao"
  | "us_partida"
  | "us_limite"
  | "brl_partida"
  | "brl_limite";

/** Teto do valor aceito: um trilhão de reais em centavos é absurdo que só vem de planilha errada. */
const MAX_CENTS = 100_000_000_000_000;

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const PALAVRAS_US = new Set(["us", "usd", "dolar", "dolares", "dollar", "dollars"]);
const PALAVRAS_BRL = new Set(["brl", "r", "real", "reais"]);

/**
 * O cabeçalho vira campo (ou nada).
 *
 * A ordem das perguntas importa: `codigo`/`descricao`/`unidade`/`observacao`
 * primeiro, porque "código do procedimento em US" não existe e "unidade" não
 * pode ser confundida com "un" de outra coisa. Só depois entram moeda e ponta.
 */
export function campoDoCabecalho(titulo: string): Campo | null {
  const palavras = normalizar(titulo).split(" ").filter(Boolean);
  if (palavras.length === 0) return null;
  const junto = palavras.join(" ");

  if (/\b(codigo|cod|code)\b/.test(junto)) return "codigo";
  if (/\b(descricao|descripcion|description|procedimento|procedimiento|item)\b/.test(junto))
    return "descricao";
  if (/\b(unidade|unit)\b/.test(junto)) return "unidade";
  if (/\b(observacao|observacoes|observacion|observaciones|obs|nota|notas|note|notes)\b/.test(junto))
    return "observacao";

  const moeda = palavras.some((p) => PALAVRAS_US.has(p))
    ? "us"
    : palavras.some((p) => PALAVRAS_BRL.has(p))
      ? "brl"
      : null;
  const ponta = /\b(limite|maximo|max|teto|final)\b/.test(junto)
    ? "limite"
    : /\b(partida|inicial|minimo|min|piso|padrao)\b/.test(junto)
      ? "partida"
      : null;

  if (!ponta) return null;
  return `${moeda ?? "brl"}_${ponta}` as Campo;
}

/**
 * "R$ 1.234,56", "1234.56", "1,234.56", "1.234" e "450" viram CENTAVOS inteiros.
 *
 * As duas convenções que chegam de verdade são a do Excel em português
 * (`1.234,56`) e a do Excel em inglês (`1,234.56`). A regra do separador
 * decimal:
 *
 *   - tem ponto E vírgula: o ÚLTIMO dos dois é o decimal;
 *   - só vírgula: é decimal (pt-BR escreve milhar com ponto);
 *   - só ponto, e exatamente 3 dígitos depois dele: é MILHAR (`1.234` = R$ 1.234);
 *     qualquer outra quantidade de casas é decimal.
 *
 * Devolve `null` para o que não é número — "a combinar", "-", vazio, texto.
 * Recusar é a função: preço chutado numa tabela de negociação é pior que linha
 * faltando, porque ninguém confere o que entrou.
 */
export function centavosDe(bruto: string): number | null {
  let t = bruto.replace(/\u00a0/g, " ").trim();
  if (!t) return null;
  // Símbolo de moeda antes ou depois do número ("R$ 10", "10 US$", "USD 10").
  t = t
    .replace(/^(us\$|u\$s|r\$|usd|brl)\s*/i, "")
    .replace(/\s*(us\$|u\$s|r\$|usd|brl)$/i, "")
    .replace(/\s+/g, "");
  if (!/^[\d.,]+$/.test(t)) return null;

  const temPonto = t.includes(".");
  const temVirgula = t.includes(",");
  let decimal: "." | "," | null = null;
  if (temPonto && temVirgula) {
    decimal = t.lastIndexOf(",") > t.lastIndexOf(".") ? "," : ".";
  } else if (temVirgula) {
    decimal = ",";
  } else if (temPonto) {
    const partes = t.split(".");
    decimal = partes.length === 2 && partes[1]!.length === 3 ? null : ".";
  }

  let limpo: string;
  if (decimal === ",") limpo = t.replace(/\./g, "").replace(",", ".");
  else if (decimal === ".") limpo = t.replace(/,/g, "");
  else limpo = t.replace(/[.,]/g, "");

  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(limpo);
  if (!m) return null;
  const inteiro = Number(m[1]);
  if (!Number.isSafeInteger(inteiro) || inteiro > MAX_CENTS) return null;
  const fracao = (m[2] ?? "").padEnd(4, "0").slice(0, 4);
  // Arredonda para centavos (meio para cima) sem ponto flutuante.
  const cents =
    inteiro * 100 +
    Number(fracao.slice(0, 2)) +
    (Number(fracao.slice(2)) >= 50 ? 1 : 0);
  return cents > MAX_CENTS ? null : cents;
}

type LeituraOk = LeituraDaTabelaDeValores;
type LeituraComErro = { erro: string };

/**
 * Lê a matriz da planilha. Erro ESTRUTURAL (sem a coluna de código, arquivo
 * acima do teto) volta como `{ erro }` — não é linha recusada, é o arquivo
 * inteiro que não serve, e a tela precisa dizer isso de outro jeito.
 */
export function lerPlanilhaDaTabelaDeValores(sheet: SheetMatrix): LeituraOk | LeituraComErro {
  if (sheet.rows.length > TABELA_MAX_LINHAS) {
    // Importar "as primeiras 2.000" em silêncio faria o operador achar que a
    // tabela inteira entrou.
    return { erro: `Máximo de ${TABELA_MAX_LINHAS} linhas de dados por planilha.` };
  }

  const colunas = new Map<Campo, number>();
  const colunasIgnoradas: string[] = [];
  sheet.headers.forEach((titulo, i) => {
    const campo = campoDoCabecalho(titulo);
    // A primeira coluna de um campo ganha; a segunda repetição é ignorada e
    // volta na lista (o operador vê que mandou duas e só uma foi usada).
    if (campo && !colunas.has(campo)) colunas.set(campo, i);
    else if (titulo.trim() !== "") colunasIgnoradas.push(titulo.trim());
  });

  if (!colunas.has("codigo") || !colunas.has("descricao")) {
    const encontradas = sheet.headers.map((h) => h.trim()).filter(Boolean);
    return {
      erro:
        "A planilha precisa de uma coluna com o CÓDIGO do procedimento e outra com a DESCRIÇÃO. " +
        `Encontrei: ${encontradas.join(", ") || "nenhuma coluna"}. ` +
        "Cabeçalhos aceitos: codigo/código/code e descricao/descripción/description/procedimento.",
    };
  }
  const temValor = (["us_partida", "us_limite", "brl_partida", "brl_limite"] as Campo[]).some((c) =>
    colunas.has(c),
  );
  if (!temValor) {
    return {
      erro:
        "A planilha não tem nenhuma coluna de valor. " +
        "Use 'valor de partida' e 'valor limite', em reais ou em US " +
        "(por exemplo: 'valor de partida (R$)' e 'valor limite (R$)').",
    };
  }

  const celula = (linha: string[], campo: Campo): string =>
    colunas.has(campo) ? (linha[colunas.get(campo)!] ?? "").trim() : "";

  const itens: LinhaDaTabela[] = [];
  const fora: LinhaRecusada[] = [];
  const codigosVistos = new Map<string, number>();

  sheet.rows.forEach((bruto, i) => {
    const linha = sheet.rowNumbers?.[i] ?? i + 2;
    if (bruto.every((c) => c.trim() === "")) return;

    const codigo = celula(bruto, "codigo").slice(0, 60);
    const descricao = celula(bruto, "descricao").replace(/\s+/g, " ").slice(0, 300);
    const recusar = (codigoDoMotivo: MotivoDeRecusa, detalhe?: string) => {
      fora.push({
        linha,
        codigo: codigoDoMotivo,
        motivo: TEXTO_DO_MOTIVO[codigoDoMotivo],
        ...(codigo ? { codigo_do_procedimento: codigo } : {}),
        ...(detalhe ? { detalhe } : {}),
      });
    };

    if (codigo.length < 2) return recusar("sem_codigo");
    if (descricao.length < 2) return recusar("sem_descricao");

    // Os quatro campos de dinheiro: string vazia é "não cotado nesta moeda",
    // texto que não vira número é ERRO (e não zero, e não nulo).
    const lidos: Partial<Record<Campo, number | null>> = {};
    for (const campo of ["us_partida", "us_limite", "brl_partida", "brl_limite"] as const) {
      const cru = celula(bruto, campo);
      if (!cru) {
        lidos[campo] = null;
        continue;
      }
      const cents = centavosDe(cru);
      if (cents === null) {
        return recusar("valor_invalido", `${campo.startsWith("us") ? "US" : "R$"}: "${cru}"`);
      }
      lidos[campo] = cents;
    }
    const valor_us_partida_cents = lidos.us_partida ?? null;
    const valor_us_limite_cents = lidos.us_limite ?? null;
    const valor_brl_partida_cents = lidos.brl_partida ?? null;
    const valor_brl_limite_cents = lidos.brl_limite ?? null;

    if (valor_us_partida_cents === null && valor_brl_partida_cents === null) {
      return recusar("sem_valor");
    }

    // Faixa pela metade: uma ponta sem a outra não se negocia (até onde subir?).
    const moedaIncompleta =
      (valor_us_partida_cents === null) !== (valor_us_limite_cents === null)
        ? "US"
        : (valor_brl_partida_cents === null) !== (valor_brl_limite_cents === null)
          ? "R$"
          : null;
    if (moedaIncompleta) return recusar("faixa_incompleta", moedaIncompleta);

    // A CERCA PRINCIPAL. É a mesma do banco (`faixa_us`/`faixa_brl`), e ela
    // existe nos dois lugares de propósito: aqui a linha vira recusa com
    // motivo e número; lá, um erro de constraint que ninguém deve conseguir
    // gravar nem por SQL.
    if (
      valor_us_partida_cents !== null &&
      valor_us_limite_cents !== null &&
      valor_us_limite_cents < valor_us_partida_cents
    )
      return recusar("limite_menor_que_partida", "US");
    if (
      valor_brl_partida_cents !== null &&
      valor_brl_limite_cents !== null &&
      valor_brl_limite_cents < valor_brl_partida_cents
    )
      return recusar("limite_menor_que_partida", "R$");

    const jaVisto = codigosVistos.get(codigo);
    if (jaVisto !== undefined)
      return recusar("repetido_na_planilha", `já na linha ${jaVisto}`);
    codigosVistos.set(codigo, linha);

    itens.push({
      linha,
      item: {
        codigo,
        descricao,
        valor_us_partida_cents,
        valor_us_limite_cents,
        valor_brl_partida_cents,
        valor_brl_limite_cents,
        unidade: celula(bruto, "unidade").slice(0, 40) || null,
        observacao: celula(bruto, "observacao").slice(0, 500) || null,
      },
    });
  });

  return { itens, fora, colunasIgnoradas };
}
