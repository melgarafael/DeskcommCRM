/**
 * A TAREFA QUE SE REPETE (#4595): "toda segunda às 9h, ligar para a carteira".
 *
 * Hoje cada ocorrência dessa ligação nasce à mão, uma por semana. Este módulo é
 * a regra inteira entre a REGRA que a pessoa escolheu (dias da semana + hora) e
 * a PRÓXIMA tarefa que nasce sozinha.
 *
 * ═══ O QUE JÁ EXISTIA, E POR QUE NENHUM DOS DOIS SERVE ═══
 *
 *  • `lib/tarefas/plano.ts` (plano de tarefas, #1752) é uma SEQUÊNCIA aplicada
 *    por um comando, disparada por um fato do negócio ("proposta enviada"). Ele
 *    não tem relógio: nada nele responde "toda segunda às 9h", e a marca de
 *    aplicado existe justamente para NÃO repetir.
 *  • `app/api/v1/cron/recurring-entries` repete lançamento FINANCEIRO por dia do
 *    mês (`recurring_entries` → `financial_entries`). A competência é mensal e
 *    a tabela é outra; copiá-la seria um segundo molde de recorrência com
 *    vocabulário de dinheiro no meio das tarefas.
 *
 * O que os dois emprestam, isso sim, é o DESENHO: a idempotência não é da
 * rotina, é do índice único — aqui `(recurrence_source_id, due_date)`, criado
 * pela migration 9369. A checagem "já existe ocorrência futura?" é otimização;
 * quem fecha a corrida de dois geradores no mesmo minuto é o banco.
 *
 * ═══ A REGRA É JSON NA PRÓPRIA TAREFA ═══
 *
 * `crm_tasks.recurrence` = `{"dias":[1],"hora":9,"ativa":true}`. `dias` segue o
 * dia da semana LOCAL da organização (domingo = 0, a mesma régua de
 * `diaDaSemanaLocal` e do `dow` da jornada) e `hora` é hora de PAREDE da
 * organização — o instante sai de `instanteDe(parede, fuso)`, que é o único
 * lugar do produto que converte hora de parede em instante. UTC cru aqui
 * marcaria a ligação das 9h para as 6h de Brasília.
 *
 * A leitura é TOLERANTE de propósito: `recurrence` é JSON escrito por gente (e
 * por tela antiga), então dia fora de 0–6, hora fora de 0–23 e lista vazia
 * derrubam SÓ aquela série — nunca a varredura das outras.
 */
import { z } from "zod";

import type { Db } from "@/lib/db";
import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { fusoDaOrganizacao } from "@/lib/automation/cron-de-data";
import type { RegraDeRecorrencia } from "@/lib/tarefas/tipos";

/** Domingo = 0, a mesma régua de `diaDaSemanaLocal` e do `dow` da jornada. */
export const DIAS_DA_SEMANA = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * A forma que a TELA manda — validada antes de virar JSON no banco.
 *
 * Existe uma vez só porque as duas rotas de tarefa (criar e editar) aceitam a
 * regra: validação escrita duas vezes diverge no primeiro ajuste, e aqui a
 * divergência seria muda — a tela salvaria a série e a edição a recusaria.
 */
export const regraDeRecorrenciaSchema = z.object({
  dias: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  hora: z.number().int().min(0).max(23),
  ativa: z.boolean().optional(),
});

/**
 * A regra como o banco a guarda — o que a rota grava e o que a tela lê.
 *
 * `ativa` vai SEMPRE explícito: ausente no JSON vale como ligada na leitura,
 * mas gravar sem a chave faria a tela ter de adivinhar o padrão em dois lugares.
 */
export function regraParaGravar(regra: RegraDeRecorrencia): {
  dias: number[];
  hora: number;
  ativa: boolean;
} {
  return { dias: [...regra.dias], hora: regra.hora, ativa: regra.ativa };
}

function numeroInteiro(valor: unknown): number | null {
  return typeof valor === "number" && Number.isInteger(valor) ? valor : null;
}

/**
 * Lê a regra do JSON da linha. `null` = não é série (ou é série torta).
 *
 * Lista vazia depois do filtro é `null`, e não "série sem dia": uma regra que
 * não escolhe dia nenhum nunca geraria nada, e devolver um objeto válido faria
 * a varredura gastar uma rodada por semana para descobrir isso.
 */
export function normalizarRegra(bruto: unknown): RegraDeRecorrencia | null {
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const objeto = bruto as Record<string, unknown>;

  const hora = numeroInteiro(objeto.hora);
  if (hora === null || hora < 0 || hora > 23) return null;

  const lista = Array.isArray(objeto.dias) ? objeto.dias : [];
  const dias = [
    ...new Set(
      lista
        .map((dia) => numeroInteiro(dia))
        .filter((dia): dia is number => dia !== null && dia >= 0 && dia <= 6),
    ),
  ].sort((a, b) => a - b);
  if (dias.length === 0) return null;

  // Só `false` desliga. Qualquer outro valor (ausente, "false" texto, lixo)
  // mantém a série ligada — desligar por acidente é o erro caro aqui: a pessoa
  // deixaria de receber a tarefa sem nunca ter pedido.
  const ativa = objeto.ativa !== false;

  return { dias, hora, ativa };
}

/**
 * O próximo instante da série, ESTRITAMENTE depois de `agora`, no fuso da
 * organização. `null` quando a série está desligada.
 *
 * A conta é em DIAS CIVIS do relógio da organização (o "hoje" que a pessoa vê),
 * e o instante de cada candidato sai de `instanteDe` — nunca de aritmética em
 * UTC, que erraria a hora em todo fuso que não é o do servidor.
 *
 * A janela de 8 dias cobre o pior caso: hoje é o dia escolhido e a hora já
 * passou (0) até o mesmo dia da semana seguinte (7).
 */
export function proximaOcorrencia(
  regra: RegraDeRecorrencia,
  agora: Date,
  fuso: string,
): Date | null {
  if (!regra.ativa) return null;

  const hoje = partesNoFuso(agora, fuso);
  for (let avanco = 0; avanco <= 7; avanco += 1) {
    // Data CIVIL (ano/mês/dia do calendário), não instante: `Date.UTC` aqui só
    // soma dias sem o fuso do processo entrar na conta. O dia da semana é o
    // dessa data civil — `getUTCDay` porque o objeto foi construído em UTC, e
    // não uma escolha de fuso: quem converte hora de parede em instante é o
    // `instanteDe`, logo abaixo, com o fuso da ORGANIZAÇÃO.
    const dia = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia + avanco));
    if (!regra.dias.includes(dia.getUTCDay())) continue;

    const candidato = instanteDe(
      { ano: dia.getUTCFullYear(), mes: dia.getUTCMonth() + 1, dia: dia.getUTCDate(), hora: regra.hora },
      fuso,
    );
    if (candidato.getTime() > agora.getTime()) return candidato;
  }
  return null;
}

/** Uma série lida do banco: a tarefa que carrega a regra. */
export interface SerieDoBanco {
  id: string;
  organization_id: string;
  timezone: string | null;
  recurrence: unknown;
}

/**
 * O que a rodada precisa saber de cada série: se gera, e para quando.
 *
 * Separado da escrita porque é a parte que o teste pode fixar sem banco: a
 * decisão ("esta série precisa de ocorrência nova?") fica aqui, e o SQL abaixo
 * só obedece.
 */
export interface OcorrenciaAResolver {
  serie: SerieDoBanco;
  quando: Date;
}

export function ocorrenciasAResolver(
  series: readonly SerieDoBanco[],
  agora: Date,
  fusoDe: (timezone: string | null) => string = fusoDaOrganizacao,
): OcorrenciaAResolver[] {
  const resolvidas: OcorrenciaAResolver[] = [];
  for (const serie of series) {
    const regra = normalizarRegra(serie.recurrence);
    if (!regra || !regra.ativa) continue;

    let quando: Date | null = null;
    try {
      quando = proximaOcorrencia(regra, agora, fusoDe(serie.timezone));
    } catch {
      // `partesNoFuso`/`instanteDe` lançam em fuso inexistente, de propósito.
      // Organização com o campo digitado errado não derruba a rodada das
      // outras — a mesma régua de `contact-birthdays` (`pular("fuso_invalido")`).
      continue;
    }
    if (quando) resolvidas.push({ serie, quando });
  }
  return resolvidas;
}

/** Quantas séries a rodada examina por vez. A varredura não abre o banco inteiro. */
export const TAMANHO_DO_LOTE = 200;

/**
 * As séries que ainda podem gerar: com regra, sem vínculo de ocorrência e SEM
 * ocorrência futura (nem a própria, nem uma já gerada).
 *
 * O `not exists` é a otimização — a trava de verdade é o índice único, e o
 * `on conflict` da inserção abaixo é o que sobrevive a duas rodadas juntas.
 */
async function lerSeries(porta: Db, agora: Date): Promise<SerieDoBanco[]> {
  return porta.query<SerieDoBanco>(
    `select t.id, t.organization_id, o.timezone, t.recurrence
       from public.crm_tasks t
       join public.organizations o on o.id = t.organization_id
      where t.recurrence is not null
        and t.recurrence_source_id is null
        and not exists (
          select 1
            from public.crm_tasks ocorrencia
           where (ocorrencia.id = t.id or ocorrencia.recurrence_source_id = t.id)
             and ocorrencia.due_date > $1::timestamptz
        )
      order by t.created_at
      limit $2`,
    [agora.toISOString(), TAMANHO_DO_LOTE],
  );
}

/**
 * A ocorrência nasce copiando o que a série descreve e herdando o vínculo.
 *
 * `status` volta a `pending`: o que se repete é o TRABALHO, não o desfecho (a
 * série pode estar concluída e ainda assim continuar valendo para a semana que
 * vem). `due_date` vem do cálculo, nunca de `now()`.
 *
 * `on conflict ... do nothing` é o desfecho correto de uma corrida: a rodada
 * irmã já gravou esta ocorrência, e as duas não podem fazer nada além de uma
 * deixar a outra passar.
 */
const INSERIR_OCORRENCIA = `
  insert into public.crm_tasks (
    organization_id, title, description, due_date, priority, status,
    lead_id, contact_id, demanda_id, assigned_to, created_by, recurrence_source_id
  )
  select t.organization_id, t.title, t.description, $2::timestamptz, t.priority, 'pending',
         t.lead_id, t.contact_id, t.demanda_id, t.assigned_to, t.created_by, t.id
    from public.crm_tasks t
   where t.id = $1
     and t.recurrence is not null
  on conflict (recurrence_source_id, due_date)
    where recurrence_source_id is not null and due_date is not null
  do nothing
  returning id
`;

export interface ResultadoDaGeracao {
  /** Quantas séries a rodada examinou (as que tinham o que gerar). */
  series: number;
  /** Quantas ocorrências nasceram nesta rodada. */
  criadas: number;
  /** Quantas já existiam (a rodada irmã chegou primeiro). */
  ja_existiam: number;
}

/**
 * Gera a próxima ocorrência de cada série que precisa de uma.
 *
 * Uma por série por rodada, de propósito: a rodada cria a PRÓXIMA, e a próxima
 * rodada (dez minutos depois) cria a seguinte só quando aquela deixou de ser
 * futura. É o que impede um cron parado uma semana de despejar sete tarefas
 * atrasadas de uma vez — o que o operador veria como um bug, não como agenda.
 */
export async function gerarOcorrencias(
  porta: Db,
  agora: Date = new Date(),
  orgsParadas: ReadonlySet<string> = new Set(),
): Promise<ResultadoDaGeracao> {
  const series = await lerSeries(porta, agora);

  let criadas = 0;
  let jaExistiam = 0;
  for (const serie of series) {
    // Organização parada não gasta nem fala (`lib/organizacao/operante.ts`): a
    // série dela continua guardada, e volta a gerar quando a org voltar. Sem
    // esta linha a suspensão não teria efeito nenhum sobre a recorrência.
    if (orgsParadas.has(serie.organization_id)) continue;

    const [resolvida] = ocorrenciasAResolver([serie], agora);
    if (!resolvida) continue;

    const linhas = await porta.query<{ id: string }>(INSERIR_OCORRENCIA, [
      serie.id,
      resolvida.quando.toISOString(),
    ]);
    if (linhas.length > 0) criadas += 1;
    else jaExistiam += 1;
  }

  return { series: series.length, criadas, ja_existiam: jaExistiam };
}
