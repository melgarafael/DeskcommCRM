/**
 * Tempo NA ETAPA dos relatórios (issue #2032) — a conta, sem rota nem tela.
 *
 * ## Por que este arquivo existe
 *
 * O card do Kanban já está resolvido: o PR #1908 (follow-up da #1748) passou o
 * rodapé a ler `crm_leads.stage_changed_at`. Falta o mesmo na camada de
 * relatório — e os relatórios de tempo/quantidade por etapa NÃO EXISTIAM:
 * zero leituras de `last_activity_at` em `lib/metrics`, `lib/reports`,
 * `app/api/v1/metrics` e `app/api/v1/reports`. Este módulo é a camada de
 * cálculo que a #2032 entrega e que destrava as propostas de «Análise do
 * funil» (#1750) e «Taxa histórica de ganho por etapa» (#1753) — e quem já
 * consome é justamente a rota e a tela da #1753
 * (`app/api/v1/pipelines/[id]/stages/win-rates`), que publicam este número
 * AO LADO da taxa histórica, com o nome de etapa atual, em vez de a tela
 * reimplementar a escolha da coluna.
 *
 * ## As duas regras que este arquivo não deixa errar
 *
 * 1. **A âncora é `stage_changed_at`.** É a ENTRADA do negócio na etapa atual,
 *    carimbada pelo trigger `trg_stamp_stage_changed_at` desde a migration 0071.
 *    O `created_at` fica de RESERVA para o lead sem carimbo (dado legado; o
 *    backfill da 0071 já o preencheu, então nulo é exceção): é a única data
 *    honesta que existe nesse caso — inventar entrada na etapa a partir da
 *    última mensagem seria o mesmo defeito do card, com sinal trocado.
 *
 * 2. **`last_activity_at` nunca entra na conta.** Ele é TEMPO SEM RESPOSTA,
 *    outra pergunta: qualquer nota escrita na conversa o zera, e um negócio
 *    parado há três semanas mostraria «agora» justamente para quem mais olha o
 *    número. A coluna é ACEITA no formato de entrada — a linha de `crm_leads`
 *    chega inteira e o chamador não precisa fiar o recorte — e é declarada aqui
 *    para o teste poder provar que é ignorada mesmo sendo mais recente que o
 *    carimbo. Aceitar não é ler: nenhuma expressão deste arquivo a referencia.
 *
 * ## O que este módulo NÃO alcança — declarado, não escondido
 *
 * - **Só a etapa ATUAL.** Um negócio que atravessou três etapas hoje aparece com
 *   o tempo da última perna; o histórico de passagens é
 *   `crm_lead_activities.type = 'stage_changed'`, que é o que
 *   `lib/metrics/taxa-da-etapa.ts` já lê. Tempo por etapa do passado é outra
 *   consulta, com outra janela.
 * - **Não ordena etapas.** `position` mora em `crm_stages`, e este módulo não
 *   toca em banco: quem chama é que devolve na ordem do funil. A ordem daqui é
 *   a de primeira aparição na lista recebida.
 * - **Não é a taxa histórica.** Quem consome aqui — a rota `win-rates` da #1753 —
 *   publica os dois números juntos e diz qual é qual: `taxas` é a passagem
 *   reconstruída das atividades (quem TRAVEJOU a etapa na janela), este bloco é
 *   a etapa ATUAL (quem está nela agora). Medida de uma não preenche a outra.
 *
 * Puro de propósito — sem cliente de banco, sem env, sem fuso: o relógio (`agora`)
 * é parâmetro, como em `lib/kanban/card-state.ts`, para que o teste não meça a
 * data do dia em que roda.
 */

/**
 * Qual das duas colunas deu a âncora. Viaja no resultado para o relatório
 * poder mostrar a amostra — número medido sobre reserva não é o mesmo número
 * medido sobre carimbo, e esconder a diferença seria metade do defeito.
 */
export type FonteDaAncora = "stage_changed_at" | "created_at";

/**
 * O recorte de `crm_leads` que a medição lê — e o ÚNICO que ela lê.
 *
 * `stage_id` é a chave do agrupamento (nulo = negócio sem etapa atribuída).
 * `last_activity_at` é aceito e ignorado: ver a regra 2 do cabeçalho.
 */
export interface LeadEmMedicao {
  stage_id: string | null;
  stage_changed_at: string | null;
  created_at: string;
  /** Aceito para a linha chegar inteira; nunca lido por este módulo. */
  last_activity_at?: string | null;
}

/** Uma etapa do relatório: quantidade, tempo e a origem das duas medidas. */
export interface EtapaMedida {
  /** `crm_stages.id`; `null` agrupa os negócios sem etapa. */
  stageId: string | null;
  /** Negócios atualmente nesta etapa. */
  quantidade: number;
  /** Média de horas na etapa; `null` só se a etapa não tiver ninguém. */
  horasMedia: number | null;
  /** Mediana de horas — a média puxada por um preso há meses não a substitui. */
  horasMediana: number | null;
  /** Amostra à vista: quantos medem por carimbo e quantos por reserva. */
  comCarimbo: number;
  semCarimbo: number;
}

/**
 * De qual coluna veio a âncora deste lead. `created_at` aqui significa dado
 * legado sem carimbo — não é um caminho de primeira escolha, é a reserva.
 */
export function fonteDaAncora(lead: LeadEmMedicao): FonteDaAncora {
  return lead.stage_changed_at ? "stage_changed_at" : "created_at";
}

/** A data da entrada na etapa atual: carimbo, com `created_at` de reserva. */
export function entradaNaEtapa(lead: LeadEmMedicao): string {
  return lead.stage_changed_at ?? lead.created_at;
}

/**
 * Horas desde a entrada na etapa, arredondadas a zero: um carimbo no futuro
 * (relógio dessincronizado, escrita adiantada) devolve 0, nunca idade negativa.
 * O mesmo corte de `buildCardInput` — idade de relógio monotônico, não é
 * problema do dado.
 */
export function horasNaEtapa(lead: LeadEmMedicao, agora: Date): number {
  const ancora = new Date(entradaNaEtapa(lead)).getTime();
  if (Number.isNaN(ancora)) return 0;
  return Math.max(0, (agora.getTime() - ancora) / 3_600_000);
}

/**
 * Agrupa por `stage_id`, na ordem de primeira aparição: quantidade e tempo de
 * cada etapa, com `comCarimbo`/`semCarimbo` para o relatório dizer sobre quantos
 * casos a reserva foi usada. Duas passagens não são defeito de desempenho — a
 * mediana exige os valores na mão, e a lista que a rota lê é cortada em centenas
 * de linhas, não em milhões.
 */
export function agregarPorEtapa(
  leads: readonly LeadEmMedicao[],
  agora: Date,
): EtapaMedida[] {
  const grupos = new Map<string | null, number[]>();
  const fontes = new Map<string | null, { comCarimbo: number; semCarimbo: number }>();

  for (const lead of leads) {
    const horas = horasNaEtapa(lead, agora);
    const lista = grupos.get(lead.stage_id);
    if (lista) lista.push(horas);
    else grupos.set(lead.stage_id, [horas]);

    const fonte = fontes.get(lead.stage_id) ?? { comCarimbo: 0, semCarimbo: 0 };
    if (lead.stage_changed_at) fonte.comCarimbo += 1;
    else fonte.semCarimbo += 1;
    fontes.set(lead.stage_id, fonte);
  }

  return [...grupos.entries()].map(([stageId, horas]) => {
    // O grupo nasceu nesta mesma varredura, então a contagem de fontes existe —
    // o `??` é para satisfazer o tipo, não um caso que os dados alcançem.
    const fonte = fontes.get(stageId) ?? { comCarimbo: 0, semCarimbo: 0 };
    return {
      stageId,
      quantidade: horas.length,
      horasMedia: media(horas),
      horasMediana: mediana(horas),
      comCarimbo: fonte.comCarimbo,
      semCarimbo: fonte.semCarimbo,
    };
  });
}

function media(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  return valores.reduce((soma, v) => soma + v, 0) / valores.length;
}

/**
 * Mediana clássica: com quantidade par, a média dos dois do meio. `null` sem
 * valores, e não `0` — «sem dado» e «zero horas» são afirmações diferentes, o
 * mesmo argumento do `percentual: null` de `lib/metrics/taxa-da-etapa.ts`.
 */
function mediana(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  const ordenado = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  // `slice` em vez de índice: com `noUncheckedIndexedAccess` ligado, `ordenado[meio]`
  // é `number | undefined` e a matemática passaria a negociar com o compilador.
  const doMeio = ordenado.slice(ordenado.length % 2 === 0 ? meio - 1 : meio, meio + 1);
  return doMeio.reduce((soma, v) => soma + v, 0) / doMeio.length;
}
