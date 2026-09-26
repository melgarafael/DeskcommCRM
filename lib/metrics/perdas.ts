/**
 * O RELATÓRIO "PERDAS" agregado (issue #1537) — a conta, sem rota nem tela.
 *
 * A issue existe porque "perdemos 40% por preço" e "perdemos 40% porque o
 * cliente não tinha o perfil" pedem ações diferentes: a primeira é perda, a
 * segunda é qualificação funcionando. Para separar, o agrupamento é por MOTIVO
 * e por CATEGORIA — e por ETAPA DE ONDE SAIU (`lost_from_stage_id`), que é o
 * que diz em que momento do funil o negócio morreu.
 *
 * ─── As duas regras que este arquivo não deixa errar ───────────────────────
 *
 * 1. MOEDA NÃO MISTURA: o valor é somado POR MOEDA (`porMoeda`), nunca num
 *    total só. R$ 1.200 e US$ 900 somados são um número que não significa
 *    nada, e um relatório que publica esse número é pior que não publicar.
 *    Lead sem moeda fica no seu próprio balde — ele não entra em moeda nenhuma.
 *
 * 2. CATEGORIA NÃO É COLUNA: ela sai do `settings.lost_reasons` do funil
 *    (`categoriaDoMotivo`). Quem não passa o resolvedor vê "Sem categoria" —
 *    honesto, porque sem configuração não há categoria a mostrar.
 */

import { MOTIVO_DA_TRANSFERENCIA } from "@/lib/leads/motivo-da-perda";
import { categoriaDoMotivo } from "@/lib/leads/motivos-de-perda-do-funil";

export interface PerdaLinha {
  lost_reason: string | null;
  lost_from_stage_id: string | null;
  value_cents: number | null;
  currency: string | null;
  /**
   * Do qual funil o lead veio (issue #1537) — a categoria do MESMO rótulo pode
   * ser diferente funil a funil, então o resolvedor precisa saber de onde ele é.
   * Ausente resolve pelo `settings` do contexto.
   */
  pipeline_id?: string | null;
}

export interface Contagem {
  /** O rótulo exibido (motivo, categoria ou etapa). */
  chave: string;
  quantidade: number;
}

export interface TotalPorMoeda {
  /** ISO 4217 como está no lead, ou o rótulo do balde sem moeda. */
  moeda: string;
  quantidade: number;
  valor_cents: number;
}

export interface RelatorioDePerdas {
  porMotivo: Contagem[];
  porCategoria: Contagem[];
  porEtapa: Contagem[];
  porMoeda: TotalPorMoeda[];
  total: number;
}

export interface ContextoDaAgregacao {
  /** `settings.lost_reasons` do funil DONO dos leads somados. */
  settings?: unknown;
  /** `settings` por funil, quando a janela junta funis diferentes. */
  settingsPorFunil?: Readonly<Record<string, unknown>>;
  /** id → nome da etapa, para `lost_from_stage_id` virar nome legível. */
  etapas?: Readonly<Record<string, string>>;
}

export const SEM_MOTIVO = "Sem motivo registrado";
export const SEM_CATEGORIA = "Sem categoria";
export const SEM_MOEDA = "sem moeda";
export const SEM_ETAPA = "Etapa desconhecida";

function ordena(mapa: Map<string, number>): Contagem[] {
  return [...mapa.entries()]
    .map(([chave, quantidade]) => ({ chave, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade || a.chave.localeCompare(b.chave, "pt-BR"));
}

/**
 * Agrupa as linhas de perda da janela.
 *
 * `settings` é o dos funis envolvidos: quando os leads vêm de funis DIFERENTES,
 * quem chama resolve a categoria por lead e passa `categoriaDo` — aí o
 * resolvedor do contexto é só o padrão para quem não passou nada.
 */
export function agruparPerdas(
  linhas: readonly PerdaLinha[],
  contexto: ContextoDaAgregacao & {
    categoriaDo?: (motivo: string, linha?: PerdaLinha) => string | undefined;
  } = {},
): RelatorioDePerdas {
  const porMotivo = new Map<string, number>();
  const porCategoria = new Map<string, number>();
  const porEtapa = new Map<string, number>();
  const moedas = new Map<string, TotalPorMoeda>();
  const resolveCategoria =
    contexto.categoriaDo ??
    ((motivo: string, linha?: PerdaLinha) =>
      categoriaDoMotivo(
        motivo,
        (linha?.pipeline_id && contexto.settingsPorFunil?.[linha.pipeline_id]) ||
          contexto.settings,
      ));

  let total = 0;
  for (const linha of linhas) {
    const motivo = linha.lost_reason?.trim() || null;
    // Transferência entre funis não é perda (migration 0266): o negócio segue
    // vivo no destino, e contá-lo aqui inflaria o relatório e o total.
    if (motivo === MOTIVO_DA_TRANSFERENCIA) continue;
    total += 1;
    const rotuloMotivo = motivo ?? SEM_MOTIVO;
    porMotivo.set(rotuloMotivo, (porMotivo.get(rotuloMotivo) ?? 0) + 1);

    const categoria = motivo ? resolveCategoria(motivo, linha) : undefined;
    const rotuloCategoria = categoria?.trim() || SEM_CATEGORIA;
    porCategoria.set(rotuloCategoria, (porCategoria.get(rotuloCategoria) ?? 0) + 1);

    const etapa = linha.lost_from_stage_id
      ? (contexto.etapas?.[linha.lost_from_stage_id] ?? linha.lost_from_stage_id)
      : SEM_ETAPA;
    porEtapa.set(etapa, (porEtapa.get(etapa) ?? 0) + 1);

    // MOEDA: balde próprio por moeda, e o sem-moeda não entra em nenhum.
    const moeda = linha.currency?.trim() || SEM_MOEDA;
    const balde = moedas.get(moeda) ?? { moeda, quantidade: 0, valor_cents: 0 };
    balde.quantidade += 1;
    balde.valor_cents += linha.value_cents ?? 0;
    moedas.set(moeda, balde);
  }

  return {
    porMotivo: ordena(porMotivo),
    porCategoria: ordena(porCategoria),
    porEtapa: ordena(porEtapa),
    // As moedas reais em ordem, o balde "sem moeda" por último: ele não é uma
    // moeda, é a ausência dela, e listá-lo no meio dos códigos ISO convida a
    // lê-lo como uma.
    porMoeda: [...moedas.values()].sort(
      (a, b) =>
        Number(a.moeda === SEM_MOEDA) - Number(b.moeda === SEM_MOEDA) ||
        a.moeda.localeCompare(b.moeda, "pt-BR"),
    ),
    total,
  };
}
