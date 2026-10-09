/**
 * O formato de `GET /api/v1/reports/tags` (#1888) — a tela lê EXATAMENTE o
 * que a rota entrega, sem recalcular nada.
 *
 * ─── Por que os tipos moram aqui e não no componente ────────────────────────
 *
 * A rota já faz a conta inteira: volume (`conversas`), desfecho
 * (`abertas`/`resolvidas`), espera (`espera_media_segundos`) e `fatia` com o
 * denominador declarado. Repetir a soma na tela criaria um segundo número que
 * pode discordar do primeiro — e número que discorda de si mesmo é o defeito
 * mais caro de relatório (é o que o `/reports/financeiro` registrou: R$
 * 141.436 contra R$ 641.103,60).
 *
 * `null` em `espera_media_segundos` é "não medido", e não zero: sem
 * `awaiting_since` não há régua, e a doutrina do `/metrics/atrito` proíbe zero
 * onde o certo é "—" (invariante da própria rota).
 */
export interface LinhaDeEtiqueta {
  etiqueta: string;
  conversas: number;
  abertas: number;
  resolvidas: number;
  /** `null` = nenhuma conversa da etiqueta teve espera mensurável. */
  espera_media_segundos: number | null;
  /** 0–100, já arredondado pela rota — a barra não recalcula nem divide de novo. */
  fatia: number;
}

/** A resposta inteira de `/api/v1/reports/tags`. */
export interface RelatorioPorEtiqueta {
  /** A régua junto do número: período e fuso de quem leu. */
  janela: { de: string; ate: string; tz: string };
  linhas: LinhaDeEtiqueta[];
  /** Soma das etiquetagens — o denominador das fatias: uma conversa de duas
 * etiquetas conta em DUAS linhas, pela própria regra da rota.
 */
  total_etiquetagens: number;
  /**
   * Duas ausências, ditas: `nenhuma_etiqueta_em_uso` ou
   * `nenhuma_conversa_com_etiqueta_no_periodo`.
   */
  sem_dados: boolean;
  motivo: string | null;
  /** A leitura foi cortada antes do fim — o corte é DITO, nunca silencioso. */
  truncado: boolean;
}

function isoData(data: Date): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}`;
}

/**
 * Janela SEMIABERTA [de, ate] de `dias` dias de CALENDÁRIO, com o mesmo corte
 * da rota: `ate` é hoje, `de` é hoje menos (dias - 1) — os dois extremos
 * entram na conta, como `diasDeJanela` faz do lado do servidor.
 *
 * A data nasce no fuso de quem lê (a mesma `tz` que vai na query), senão o
 * "últimos 7 dias" de Brasília começaria ontem à meia-noite de UTC.
 */
export function janelaDeDias(dias: number, agora: Date = new Date()): { de: string; ate: string } {
  const inicio = new Date(agora);
  inicio.setDate(inicio.getDate() - (dias - 1));
  return { de: isoData(inicio), ate: isoData(agora) };
}

/**
 * A espera em algo que se lê: `—` para `null` (não medido, nunca zero) e
 * unidades curtas que não precisam de tradução — 45s, 12 min, 1h30.
 */
export function esperaLegivel(segundos: number | null): string {
  if (segundos === null) return "—";
  if (segundos < 60) return `${segundos}s`;
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto > 0 ? `${horas}h${resto}` : `${horas}h`;
}
