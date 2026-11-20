/**
 * O PAINEL DE VENDAS — a conta, sem banco e sem tela (Orken CRM).
 *
 * ─── A pergunta ──────────────────────────────────────────────────────────────
 *
 * "Quanto vendi no período, quantas vendas foram, qual o ticket médio, quanto
 * converti e como isso andou dia a dia?" — tudo numa tela só, em cartões
 * grandes. Para quem vende pelo WhatsApp, a VENDA é o negócio ganho no funil,
 * com o valor do card: é essa a fonte aqui, e não as comandas.
 *
 * ─── As réguas (o contrato da rota `/api/v1/reports/painel-de-vendas`) ────────────────
 *
 *  - VENDA = negócio `won` com `closed_at` dentro da janela. A data é a do
 *    GANHO, no fuso da organização: mover o card depois não muda o dia em que
 *    ele conta.
 *  - VALOR VENDIDO = soma de `value_cents` das vendas NA MOEDA DA ORGANIZAÇÃO.
 *    Venda em outra moeda conta como venda, mas fica fora da soma — e é dita
 *    (`excluidos.outra_moeda`): somar real com dólar daria um número falso.
 *  - TICKET MÉDIO = valor vendido ÷ vendas COM valor (na moeda). Venda sem valor
 *    preenchido não puxa a média para baixo como se fosse de graça; ela é
 *    contada à parte (`vendas_sem_valor`). Sem venda com valor, é `null`.
 *  - CONVERSÃO = ganhos ÷ (ganhos + perdidos) FECHADOS na janela — a taxa de
 *    ganho dos negócios que terminaram no período. Sem nenhum fechado, `null`
 *    (nunca 0%: "não fechou nada" não é "perdeu tudo").
 *  - SÉRIE = um ponto por DIA da janela; acima de `DIAS_DA_SERIE_DIARIA` dias,
 *    um ponto por MÊS (400 pontos não cabem num gráfico legível). Dia sem venda
 *    é ponto zero, não buraco — o gráfico tem de mostrar o vale.
 */
import { dataNoFuso, proximoDia, type JanelaDoRelatorio } from "./janela";

/** Acima disto a série vira mensal. */
export const DIAS_DA_SERIE_DIARIA = 62;

export interface NegocioDoPainel {
  status: string;
  closed_at: string | null;
  value_cents: number | null;
  currency: string | null;
}

export type GranularidadeDoPainel = "dia" | "mes";

export interface PontoDaSerie {
  /** `AAAA-MM-DD` (dia) ou `AAAA-MM` (mês), na parede da organização. */
  chave: string;
  vendas: number;
  centavos: number;
}

export interface PainelDeVendas {
  moeda: string;
  vendas: number;
  vendido_centavos: number;
  vendas_com_valor: number;
  vendas_sem_valor: number;
  ticket_medio_centavos: number | null;
  perdidos: number;
  /** De 0 a 1. `null` quando nada fechou na janela. */
  conversao: number | null;
  granularidade: GranularidadeDoPainel;
  serie: PontoDaSerie[];
  excluidos: { outra_moeda: number };
}

/** Quantos dias de calendário a janela cobre (`de` e `ate` inclusivos). */
export function diasDaJanela(de: string, ate: string): number {
  let dias = 0;
  for (let dia = de; dia <= ate && dias <= 1000; dia = proximoDia(dia)) dias++;
  return dias;
}

/** As chaves da série, na ordem, cobrindo a janela inteira. */
export function chavesDaSerie(de: string, ate: string, granularidade: GranularidadeDoPainel): string[] {
  const chaves: string[] = [];
  for (let dia = de; dia <= ate && chaves.length <= 1000; dia = proximoDia(dia)) {
    const chave = granularidade === "dia" ? dia : dia.slice(0, 7);
    if (chaves[chaves.length - 1] !== chave) chaves.push(chave);
  }
  return chaves;
}

export function montarPainelDeVendas(entrada: {
  negocios: readonly NegocioDoPainel[];
  janela: JanelaDoRelatorio;
  moedaDaOrganizacao: string;
}): PainelDeVendas {
  const { janela } = entrada;
  const moeda = entrada.moedaDaOrganizacao.trim().toUpperCase();
  const granularidade: GranularidadeDoPainel =
    diasDaJanela(janela.de, janela.ate) > DIAS_DA_SERIE_DIARIA ? "mes" : "dia";

  const serie: PontoDaSerie[] = chavesDaSerie(janela.de, janela.ate, granularidade).map((chave) => ({
    chave,
    vendas: 0,
    centavos: 0,
  }));
  const indice = new Map(serie.map((ponto, i) => [ponto.chave, i]));

  const inicio = Date.parse(janela.from);
  const fim = Date.parse(janela.to);
  let vendas = 0;
  let vendido = 0;
  let comValor = 0;
  let semValor = 0;
  let perdidos = 0;
  let outraMoeda = 0;

  for (const negocio of entrada.negocios) {
    if (typeof negocio.closed_at !== "string") continue;
    const instante = Date.parse(negocio.closed_at);
    // Janela SEMIABERTA, como a consulta: quem fechou à meia-noite do dia
    // seguinte é do dia seguinte.
    if (!Number.isFinite(instante) || instante < inicio || instante >= fim) continue;

    if (negocio.status === "lost") {
      perdidos++;
      continue;
    }
    if (negocio.status !== "won") continue;

    vendas++;
    const dia = dataNoFuso(new Date(instante), janela.tz);
    const ponto = serie[indice.get(granularidade === "dia" ? dia : dia.slice(0, 7)) ?? -1];
    if (ponto) ponto.vendas++;

    const moedaDoNegocio = (negocio.currency ?? moeda).trim().toUpperCase();
    if (moedaDoNegocio !== moeda) {
      outraMoeda++;
      continue;
    }
    const valor = typeof negocio.value_cents === "number" ? negocio.value_cents : 0;
    if (valor > 0) {
      comValor++;
      vendido += valor;
      if (ponto) ponto.centavos += valor;
    } else {
      semValor++;
    }
  }

  const fechados = vendas + perdidos;
  return {
    moeda,
    vendas,
    vendido_centavos: vendido,
    vendas_com_valor: comValor,
    vendas_sem_valor: semValor,
    ticket_medio_centavos: comValor > 0 ? Math.round(vendido / comValor) : null,
    perdidos,
    conversao: fechados > 0 ? vendas / fechados : null,
    granularidade,
    serie,
    excluidos: { outra_moeda: outraMoeda },
  };
}
