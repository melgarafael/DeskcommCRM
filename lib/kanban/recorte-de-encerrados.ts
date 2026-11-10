import type { Lead } from "@/lib/types/leads";

/**
 * O RECORTE DE ENCERRADOS ANTIGOS DO QUADRO (#2995).
 *
 * O quadro do funil traz TODO negócio não arquivado — os ganhos e as perdas de
 * meses atrás inclusive — e a tela não oferecia nada para tirá-los: num funil
 * com histórico longo ele fica ilegível. A opção é POR FUNIL e mora no
 * `settings` que o funil já tem (`crm_pipelines.settings.ocultar_encerrados_dias`,
 * o mesmo jsonb de `fields`, `lost_reasons` e `reabertura`): nenhuma coluna
 * nova, nenhuma migration, e nenhum funil existente precisa migrar dado —
 * chave ausente é a opção DESLIGADA, o comportamento de sempre.
 *
 * ELA É DE EXIBIÇÃO, e nada mais: o quadro esconde o card, a linha continua no
 * banco com o histórico intacto e volta inteira ao desligar a opção. Nada aqui
 * apaga, arquiva ou mexe em `status` — a mesma decisão do filtro de contato
 * pessoal, que esconde sem apagar.
 *
 * AS TRÊS RÉGUAS, uma por caso de teste em
 * `app/api/v1/pipelines/[id]/board/route.test.ts`:
 *
 *  1. o corte é por DATA DE ENCERRAMENTO (`closed_at`), não por `status`, por
 *     última atividade nem por `is_active`: negócio fechado ontem continua no
 *     quadro mesmo que ninguém o toque desde o começo do ano;
 *  2. negócio ABERTO nunca sai, por antigo que seja — é justamente o que
 *     precisa de atenção humana, e sumir com ele seria o pior recorte
 *     possível;
 *  3. encerrado SEM `closed_at` legível fica: a data não existe e INVENTÁ-LA
 *     (usar `updated_at`/`created_at`, ou tratar todo encerrado como antigo)
 *     tiraria do quadro um negócio que ninguém sabe quando fechou.
 */

/** O piso do recorte: 1 dia. `0` é DESLIGADO, e não "esconda o de hoje". */
export const DIAS_MINIMO_DO_RECORTE = 1;

/**
 * O teto — dez anos. Não é regra de negócio: é o limite que impede um número
 * absurdo de virar `Infinity` no cálculo do corte e esconder o quadro inteiro.
 */
export const DIAS_MAXIMO_DO_RECORTE = 3650;

/** O que a tela sugere quando alguém liga a opção pela primeira vez. */
export const DIAS_PADRAO_DO_RECORTE = 30;

const MILISSEGUNDOS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Os dias configurados neste funil, ou `null` quando a opção está DESLIGADA.
 *
 * Três estados viram "desligada" de propósito, e são os mesmos que o quadro
 * encontra em produção: chave ausente (todo funil de hoje), `0` (quem
 * desligou) e qualquer coisa fora da faixa (linha editada à mão). Devolver o
 * valor cru faria o recorte depender de um número que a tela nunca ofereceu.
 */
export function diasDeRecorte(
  settings: Record<string, unknown> | null | undefined,
): number | null {
  const bruto = settings?.ocultar_encerrados_dias;
  if (typeof bruto !== "number" || !Number.isInteger(bruto)) return null;
  if (bruto < DIAS_MINIMO_DO_RECORTE || bruto > DIAS_MAXIMO_DO_RECORTE) return null;
  return bruto;
}

/**
 * Tira do quadro os negócios ENCERRADOS há mais de `dias` dias.
 *
 * Pura de propósito (recebe a lista e o relógio) para a régua poder ser medida
 * sem banco: a rota do quadro lê a lista inteira e filtra em memória, como já
 * faz com o contato pessoal — o quadro não pagina, então nada se perde por
 * filtrar depois de ler.
 *
 * `dias` nulo (ou fora da faixa) devolve a MESMA lista, cópia à parte: é o
 * "desligado", e é o que mantém o funil de quem não ligou a opção idêntico ao
 * de antes.
 *
 * `manter` é o negócio que alguém PEDIU pelo link (`?lead=`, e `/app/leads/<id>`,
 * que redireciona para ele): ele fica mesmo encerrado há muito tempo. Sem isso
 * o dossiê procura o negócio na lista do quadro, não o acha e não abre — e com
 * a opção ligada um encerrado antigo deixava de ter caminho pela tela.
 */
export function recortaEncerradosAntigos<
  T extends Pick<Lead, "id" | "status" | "closed_at">,
>(
  leads: readonly T[],
  dias: number | null | undefined,
  agora: Date = new Date(),
  manter: string | null = null,
): T[] {
  if (!ehDiasValidos(dias)) return [...leads];
  const corte = agora.getTime() - dias * MILISSEGUNDOS_POR_DIA;

  return leads.filter((lead) => {
    if (lead.status === "open") return true;
    if (manter !== null && lead.id === manter) return true;
    if (!lead.closed_at) return true;
    const encerradoEm = Date.parse(lead.closed_at);
    // Data que o `Date.parse` não entende é ausência de data: fica.
    if (Number.isNaN(encerradoEm)) return true;
    return encerradoEm >= corte;
  });
}

function ehDiasValidos(dias: number | null | undefined): dias is number {
  return (
    typeof dias === "number" &&
    Number.isInteger(dias) &&
    dias >= DIAS_MINIMO_DO_RECORTE &&
    dias <= DIAS_MAXIMO_DO_RECORTE
  );
}
