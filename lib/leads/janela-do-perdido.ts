/**
 * A JANELA DO NEGÓCIO PERDIDO QUE VOLTA (#4076) — a régua, sem banco.
 *
 * Vive separada do caminho que escreve (`reabrir-perdido.ts`) por um motivo
 * concreto: o SCHEMA da configuração (`lib/schemas/settings.ts`) e a TELA leem
 * estas três constantes, e `lib/leads/reabertura.ts` importa aquele schema. Com
 * a régua no mesmo arquivo do caminho de escrita, o grafo viraria
 * `settings → reabrir-perdido → reabertura → settings`, e a inicialização do
 * módulo leria uma constante ainda em TDZ — o tipo de defeito que aparece em
 * produção como `undefined.includes`, não como erro de compilação.
 *
 * A JANELA EXISTE PARA NÃO ESCONDER ROTATIVIDADE. Reabrir o perdido de meses
 * atrás apagaria a leitura de "quantas tentativas até fechar": o card voltaria a
 * `aberto` com a idade da PRIMEIRA tentativa, e o relatório de perdas deixaria
 * de contar a perda que houve. A janela curta é o que separa "o cliente
 * respondeu à despedida" (a demanda nunca morreu) de "o cliente voltou num
 * trimestre seguinte" (demanda nova, com a perda registrada no lugar dela).
 */

/** O piso da janela: 1 dia. `0` é DESLIGADO, e não "reabra o de hoje". */
export const DIAS_MINIMO_PARA_REABRIR = 1;

/**
 * O teto — dez anos. Não é regra de negócio: é o limite que impede um número
 * absurdo (linha editada à mão) de virar janela infinita e reabrir um card de
 * outra década como se a conversa tivesse continuado.
 */
export const DIAS_MAXIMO_PARA_REABRIR = 3650;

/** O que a tela sugere quando alguém liga a opção pela primeira vez. */
export const DIAS_PADRAO_PARA_REABRIR = 30;

const MILISSEGUNDOS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Os dias configurados neste funil, ou `null` quando a opção está DESLIGADA.
 *
 * Três estados viram "desligada" de propósito, e são os três que existem em
 * produção: chave ausente (todo funil de hoje), `0` (quem desligou) e qualquer
 * coisa fora da faixa (linha editada à mão). Devolver o valor cru faria a
 * reabertura depender de um número que a tela nunca ofereceu.
 */
export function diasParaReabrirPerdido(
  settings: Record<string, unknown> | null | undefined,
): number | null {
  const bruto = settings?.reabrir_perdido_dias;
  if (typeof bruto !== "number" || !Number.isInteger(bruto)) return null;
  if (bruto < DIAS_MINIMO_PARA_REABRIR || bruto > DIAS_MAXIMO_PARA_REABRIR) return null;
  return bruto;
}

/**
 * O negócio foi perdido DENTRO da janela?
 *
 * `closed_at` nulo ou ilegível conta como FORA: a data não existe, e inventá-la
 * (usar `updated_at`, ou tratar todo perdido como recente) reabriria card antigo
 * — exatamente o que a janela existe para impedir. A régua é a mesma de
 * `recortaEncerradosAntigos` (`lib/kanban/recorte-de-encerrados.ts`), inclusive
 * no `Date.parse`: data que o runtime não entende é ausência de data.
 */
export function perdidoDentroDaJanela(
  fechadoEm: string | null | undefined,
  dias: number,
  agora: Date = new Date(),
): boolean {
  if (!fechadoEm) return false;
  const quando = Date.parse(fechadoEm);
  if (Number.isNaN(quando)) return false;
  return quando >= agora.getTime() - dias * MILISSEGUNDOS_POR_DIA;
}
