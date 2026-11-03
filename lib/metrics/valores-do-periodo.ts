/**
 * AS DUAS PARCELAS DO PERÍODO — a fatia 2, item 1, da issue #3602.
 *
 * ─── O número que os painéis não sabiam dizer ───────────────────────────────
 *
 * Quem vende setup + mensalidade (agência, clínica, escola, software) guarda o
 * setup em `value_cents` e a mensalidade em `recurring_value_cents` (fatia 1,
 * migration 9028). Até aqui os painéis liam só a primeira coluna: o contrato de
 * R$ 3.000 + R$ 500/mês aparecia como R$ 3.000, seis vezes menor, e a
 * mensalidade nova do mês não aparecia em número NENHUM.
 *
 * ─── O que este módulo decide ───────────────────────────────────────────────
 *
 * O período devolve DUAS parcelas, separadas e nomeadas:
 *
 *   `unico`              — soma de `value_cents` dos negócios ganhos na janela;
 *   `recorrente_mensal`  — soma de `recurring_value_cents` desses mesmos
 *                          negócios, quando `recurring_period` é mensal
 *                          (ausente = mensal, a régua da fatia 1);
 *   `negocios_com_recorrencia` — quantos ganhos têm recorrência preenchida.
 *
 * Não existe `total` neste objeto, e é de propósito: somar as duas parcelas é
 * o defeito que a issue descreve ("tudo num número, e ninguém sabe quanto entra
 * todo mês"). A régua da fatia 1 (`lib/leads/valor-recorrente.ts`) já decidiu
 * que duas parcelas visíveis são o produto; este módulo só transporta a mesma
 * decisão para os painéis.
 *
 * ─── Quem entra na conta ────────────────────────────────────────────────────
 *
 * `status = 'won'` E `closed_at` em `[from, to)` — o mesmo par que as rotas
 * irmãs chamam de venda. Negócio ganho fora da janela não conta em nenhuma das
 * duas parcelas (nem no numerador, nem no denominador de ninguém), e negócio
 * aberto ou perdido não conta mesmo que tenha recorrência preenchida: previsão
 * e carteira são outras fatias.
 *
 * ─── Valor só por moeda (Régua 3) ──────────────────────────────────────────
 *
 * Somar dólar com real produz um número que não existe. `por_moeda` sempre traz
 * o corte honesto. No topo, `moeda` é a moeda ÚNICA da janela; quando a janela
 * mistura moedas, `moeda` sai `null`, `moeda_mista` sai `true` e
 * `unico.centavos` / `recorrente_mensal.centavos` saem `null` — ausência de
 * número, não zero. A moeda do negócio é a dele; a da organização é a reserva
 * (o mesmo critério do rótulo da fatia 1).
 *
 * ─── Truncado é PISO, não total ─────────────────────────────────────────────
 *
 * `truncado: true` significa que a rota parou no teto de páginas e as parcelas
 * somam o que foi lido. A nota viaja junto para a tela não apresentar um piso
 * como se fosse o mês inteiro.
 *
 * Módulo PURO: recebe linhas, devolve números. Quem lê o banco é a rota.
 */
import { PERIODICIDADE_PADRAO } from "@/lib/leads/valor-recorrente";

/** A linha do negócio como os painéis precisam dela — nada além disso. */
export interface NegocioComValor {
  status: string | null;
  closed_at: string | null;
  currency?: string | null;
  value_cents?: number | null;
  recurring_value_cents?: number | null;
  recurring_period?: string | null;
}

/** Uma das duas parcelas do período. */
export interface ParcelaDoPeriodo {
  /**
   * Soma em centavos — `null` quando a janela mistura moedas (aí a leitura
   * honesta é `por_moeda`, porque um único número somaria dólar com real).
   */
  centavos: number | null;
  /** Quantos negócios entraram nesta soma. */
  negocios: number;
}

/** O mesmo par de parcelas, dentro de uma moeda só. */
export interface BaldeDeMoeda {
  /** `null` = a organização não declarou moeda e o negócio também não. */
  moeda: string | null;
  unico_centavos: number;
  recorrente_mensal_centavos: number;
  negocios: number;
  negocios_com_recorrencia: number;
}

export interface ValoresDoPeriodo {
  /** De que universo saem os números — viaja junto para não virar mentira. */
  base: string;
  /** A moeda única da janela; `null` quando mistura moedas ou não há moeda. */
  moeda: string | null;
  /** `true` quando `por_moeda` tem mais de um balde. */
  moeda_mista: boolean;
  unico: ParcelaDoPeriodo;
  recorrente_mensal: ParcelaDoPeriodo;
  /** Quantos ganhos da janela têm `recurring_value_cents` preenchido. */
  negocios_com_recorrencia: number;
  por_moeda: BaldeDeMoeda[];
  /** A rota não leu todas as linhas da janela: as parcelas são um piso. */
  truncado: boolean;
  /** Só quando há algo a declarar (piso ou moeda mista); senão `null`. */
  nota: string | null;
}

/**
 * Centavos que uma coluna pode somar.
 *
 * Coluna nula soma zero (não é erro: negócio sem valor é estado legítimo), e
 * valor negativo ou não-finito entra como zero em vez de DIMINUIR a parcela —
 * venda negativa não existe, e um `-500` numa coluna estragada não pode fazer o
 * mês aparecer menor do que as vendas que existiram.
 */
function centavos(valor: number | null | undefined): number {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return 0;
  return Math.max(0, Math.round(valor));
}

/** O negócio foi GANHO dentro da janela? (`closed_at` é a data da venda.) */
function ganhoNaJanela(negocio: NegocioComValor, de: number, ate: number): boolean {
  if (negocio.status !== "won") return false;
  if (!negocio.closed_at) return false;
  const quando = Date.parse(negocio.closed_at);
  if (!Number.isFinite(quando)) return false;
  if (!Number.isFinite(de) || !Number.isFinite(ate)) return false;
  return quando >= de && quando < ate;
}

export function separarValoresDoPeriodo(entrada: {
  negocios: readonly NegocioComValor[];
  janela: { from: string; to: string };
  /** Moeda da organização: reserva quando o negócio não traz a própria. */
  moedaDaOrganizacao?: string | null;
  /** A rota parou no teto de páginas e as parcelas são um piso. */
  truncado?: boolean;
}): ValoresDoPeriodo {
  const de = Date.parse(entrada.janela.from);
  const ate = Date.parse(entrada.janela.to);
  const reserva = entrada.moedaDaOrganizacao?.trim() || null;

  const baldes = new Map<string, BaldeDeMoeda>();
  let negociosComRecorrencia = 0;

  for (const negocio of entrada.negocios) {
    if (!ganhoNaJanela(negocio, de, ate)) continue;

    const moeda = negocio.currency?.trim() || reserva;
    const chave = moeda ?? "";
    const balde = baldes.get(chave) ?? {
      moeda,
      unico_centavos: 0,
      recorrente_mensal_centavos: 0,
      negocios: 0,
      negocios_com_recorrencia: 0,
    };

    balde.negocios += 1;
    balde.unico_centavos += centavos(negocio.value_cents);

    // `null` é "não há recorrência"; qualquer outra coisa é "há" — inclusive
    // zero, que é recorrência preenchida com valor zero (dado esquisito, mas
    // que existe e não pode sumir da contagem).
    const temRecorrencia =
      negocio.recurring_value_cents !== null && negocio.recurring_value_cents !== undefined;
    if (temRecorrencia) {
      balde.negocios_com_recorrencia += 1;
      negociosComRecorrencia += 1;
      // A periodicidade ausente nasce MENSAL (regra 2 da fatia 1). Uma
      // periodicidade que este build não conhece não entra na parcela mensal —
      // somá-la como se fosse mensal inventaria um número, e ignorá-la em
      // silêncio seria pior: ela continua visível em `negocios_com_recorrencia`.
      const periodicidade = negocio.recurring_period?.trim() || PERIODICIDADE_PADRAO;
      if (periodicidade === PERIODICIDADE_PADRAO) {
        balde.recorrente_mensal_centavos += centavos(negocio.recurring_value_cents);
      }
    }

    baldes.set(chave, balde);
  }

  // Balde sem moeda é ausência, não é código ISO: fica por último (a mesma
  // ordem do `calcularOrigem` do funil).
  const porMoeda = [...baldes.values()].sort((a, b) => {
    const semA = Number(a.moeda === null);
    const semB = Number(b.moeda === null);
    if (semA !== semB) return semA - semB;
    return (a.moeda ?? "").localeCompare(b.moeda ?? "", "pt-BR");
  });

  const moedaMista = porMoeda.length > 1;
  const unico = porMoeda[0];
  const truncado = entrada.truncado === true;
  const negociosNoPeriodo = porMoeda.reduce((soma, balde) => soma + balde.negocios, 0);

  const nota = truncado
    ? "A leitura parou no teto de páginas desta rota: as parcelas somam o que foi lido e são um piso, não o total do período."
    : moedaMista
      ? "A janela tem mais de uma moeda: as parcelas do topo ficam nulas de propósito e o número honesto é o de `por_moeda`."
      : null;

  return {
    base: "Negócios GANHOS com `closed_at` dentro da janela; valor único é `value_cents` e recorrência nova é `recurring_value_cents` mensal. As duas parcelas nunca são somadas.",
    moeda: moedaMista ? null : (unico?.moeda ?? null),
    moeda_mista: moedaMista,
    unico: {
      centavos: moedaMista ? null : (unico?.unico_centavos ?? 0),
      negocios: negociosNoPeriodo,
    },
    recorrente_mensal: {
      centavos: moedaMista ? null : (unico?.recorrente_mensal_centavos ?? 0),
      negocios: unico?.negocios_com_recorrencia ?? 0,
    },
    negocios_com_recorrencia: negociosComRecorrencia,
    por_moeda: porMoeda,
    truncado,
    nota,
  };
}
