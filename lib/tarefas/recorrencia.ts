/**
 * A TAREFA QUE SE REPETE (#4595): "toda segunda às 9h, ligar para a carteira".
 *
 * Hoje cada ocorrência dessa ligação nasce à mão, uma por semana. Este módulo é
 * a regra inteira entre a REGRA que a pessoa escolheu (diária, semanal em dias
 * escolhidos, mensal) e a PRÓXIMA tarefa que nasce quando ela CONCLUI a atual.
 *
 * ═══ DOIS GATILHOS, UMA CRIAÇÃO ═══
 *
 * A próxima nasce por dois caminhos, e os dois passam por `criarProximaDaSerie`
 * → `criarTarefaInterna` (INSERT + audit + atividade + push):
 *
 *  • a CONCLUSÃO (`PATCH /api/v1/tasks/[id]`) — a saída 1 da issue, "criando a
 *    próxima ao concluir";
 *  • o AGENDADOR (`cron/task-recurrence`, a cada 10 min, aprovado no doc 352 e
 *    entregue na 1.114) — cria a próxima da série que ficou sem ocorrência
 *    futura. Fica por decisão do dono (doc 374 = A): quem já usa a 1.114 recebe
 *    a tarefa sem concluir a anterior, e a falha de uma rodada tem nova
 *    tentativa sozinha na rodada seguinte.
 *
 * Os dois chegam juntos no mesmo `on conflict` do índice único, e o segundo
 * devolve `ja_existe` em vez de duplicar.
 *
 * ═══ O QUE JÁ EXISTIA, E POR QUE NENHUM DOS DOIS SERVE ═══
 *
 *  • `lib/tarefas/plano.ts` (plano de tarefas, #1752) é uma SEQUÊNCIA aplicada
 *    por um comando, disparada por um fato do negócio ("proposta enviada"). Ele
 *    não tem relógio, e a marca de aplicado existe justamente para NÃO repetir.
 *  • `app/api/v1/cron/recurring-entries` repete lançamento FINANCEIRO por dia do
 *    mês (`recurring_entries` → `financial_entries`). A tabela é outra; copiá-la
 *    seria um segundo molde de recorrência com vocabulário de dinheiro no meio
 *    das tarefas.
 *
 * O que os dois emprestam, isso sim, é o DESENHO: a idempotência não é da
 * rotina, é do índice único — aqui `(recurrence_source_id, due_date)`, criado
 * pela migration 9369. Concluir duas vezes (ou concluir enquanto o agendador
 * roda) chega duas vezes no `on conflict do nothing` e só a primeira grava.
 *
 * ═══ A REGRA É JSON NA PRÓPRIA TAREFA ═══
 *
 * `crm_tasks.recurrence` = `{"tipo":"semanal","dias":[1],"dia_do_mes":null,
 * "hora":9,"ativa":true}`. `dias` segue o dia da semana LOCAL da organização
 * (domingo = 0) e `hora` é hora de PAREDE — o instante sai de
 * `instanteDe(parede, fuso)`, que é o único lugar do produto que converte hora
 * de parede em instante. UTC cru aqui marcaria a ligação das 9h para as 6h de
 * Brasília.
 *
 * Sem tabela nova e sem migration nova: a forma da regra vive no JSON, e o
 * `tipo` é gravado em vez de inferido para que "diária" e "semanal com os sete
 * dias" — que produzem as mesmas datas — continuem distinguíveis na edição.
 *
 * A leitura é TOLERANTE de propósito: `recurrence` é JSON escrito por gente (e
 * por tela antiga), então dia fora de 0–6, hora fora de 0–23 e lista vazia
 * derrubam SÓ aquela série — nunca a conclusão de quem está trabalhando.
 */
import { z } from "zod";

import type { Db } from "@/lib/db";
import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { fusoDaOrganizacao } from "@/lib/automation/cron-de-data";
import { logger } from "@/lib/logger";
import { criarTarefaInterna } from "@/lib/tarefas/criar-tarefa";
import {
  PERIODICIDADES_DA_SERIE,
  type PrioridadeDaTarefa,
  type RegraDeRecorrencia,
} from "@/lib/tarefas/tipos";

/** Domingo = 0, a mesma régua de `diaDaSemanaLocal` e do `dow` da jornada. */
export const DIAS_DA_SEMANA = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * A forma que a TELA manda — validada antes de virar JSON no banco.
 *
 * Existe uma vez só porque as duas rotas de tarefa (criar e editar) aceitam a
 * regra: validação escrita duas vezes diverge no primeiro ajuste, e aqui a
 * divergência seria muda — a tela salvaria a série e a edição a recusaria.
 *
 * `tipo` é OPCIONAL de propósito: é o que mantém legível a série gravada antes
 * deste campo existir (ela era sempre semanal) e o que impede um cliente antigo
 * de receber 422 por não mandar um campo que ainda não conhecia.
 */
export const regraDeRecorrenciaSchema = z.object({
  tipo: z.enum(PERIODICIDADES_DA_SERIE).optional(),
  dias: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  dia_do_mes: z.number().int().min(1).max(31).nullable().optional(),
  hora: z.number().int().min(0).max(23),
  ativa: z.boolean().optional(),
});

/**
 * A regra como o banco a guarda — o que a rota grava e o que a tela lê.
 *
 * `ativa` vai SEMPRE explícito: ausente no JSON vale como ligada na leitura,
 * mas gravar sem a chave faria a tela ter de adivinhar o padrão em dois lugares.
 * `dias` e `dia_do_mes` vão vazios quando o tipo não os usa — ver o comentário
 * de `RegraDeRecorrencia`.
 */
export function regraParaGravar(regra: RegraDeRecorrencia): {
  tipo: RegraDeRecorrencia["tipo"];
  dias: number[];
  dia_do_mes: number | null;
  hora: number;
  ativa: boolean;
} {
  return {
    tipo: regra.tipo,
    dias: regra.tipo === "semanal" ? [...regra.dias] : [],
    dia_do_mes: regra.tipo === "mensal" ? regra.dia_do_mes : null,
    hora: regra.hora,
    ativa: regra.ativa,
  };
}

function numeroInteiro(valor: unknown): number | null {
  return typeof valor === "number" && Number.isInteger(valor) ? valor : null;
}

/**
 * Lê a regra do JSON da linha. `null` = não é série (ou é série torta).
 *
 * Lista vazia depois do filtro é `null` para `semanal`, e não "série sem dia":
 * uma regra que não escolhe dia nenhum nunca geraria nada, e devolver um objeto
 * válido faria a conclusão gravar uma próxima em lugar nenhum.
 */
export function normalizarRegra(bruto: unknown): RegraDeRecorrencia | null {
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const objeto = bruto as Record<string, unknown>;

  const hora = numeroInteiro(objeto.hora);
  if (hora === null || hora < 0 || hora > 23) return null;

  // Sem `tipo` = série gravada antes deste campo existir: sempre foi semanal.
  const tipoDeclarado = objeto.tipo;
  const tipo =
    typeof tipoDeclarado === "string" &&
    (PERIODICIDADES_DA_SERIE as readonly string[]).includes(tipoDeclarado)
      ? (tipoDeclarado as RegraDeRecorrencia["tipo"])
      : "semanal";

  // Só `false` desliga. Qualquer outro valor (ausente, "false" texto, lixo)
  // mantém a série ligada — desligar por acidente é o erro caro aqui: a pessoa
  // deixaria de receber a tarefa sem nunca ter pedido.
  const ativa = objeto.ativa !== false;

  if (tipo === "diaria") {
    return { tipo, dias: [], dia_do_mes: null, hora, ativa };
  }

  if (tipo === "mensal") {
    const diaDoMes = numeroInteiro(objeto.dia_do_mes);
    // 1–31 é o que a tela oferece. Dia 31 em mês curto não invalida a série:
    // `proximaOcorrencia` ancora no último dia do mês, como um calendário.
    if (diaDoMes === null || diaDoMes < 1 || diaDoMes > 31) return null;
    return { tipo, dias: [], dia_do_mes: diaDoMes, hora, ativa };
  }

  const lista = Array.isArray(objeto.dias) ? objeto.dias : [];
  const dias = [
    ...new Set(
      lista
        .map((dia) => numeroInteiro(dia))
        .filter((dia): dia is number => dia !== null && dia >= 0 && dia <= 6),
    ),
  ].sort((a, b) => a - b);
  if (dias.length === 0) return null;

  return { tipo: "semanal", dias, dia_do_mes: null, hora, ativa };
}

/** Quantos dias tem o mês civil (1 = janeiro), sem depender do fuso do processo. */
function ultimoDiaDoMes(ano: number, mes: number): number {
  // Dia 0 do mês seguinte é o último dia deste — e `Date.UTC` aqui só faz
  // aritmética de calendário: nenhum fuso do processo entra na conta.
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/**
 * O próximo instante da série, ESTRITAMENTE depois de `referencia`, no fuso da
 * organização. `null` quando a série está desligada.
 *
 * A conta é em DIAS CIVIS do relógio da organização (o "hoje" que a pessoa vê),
 * e o instante de cada candidato sai de `instanteDe` — nunca de aritmética em
 * UTC, que erraria a hora em todo fuso que não é o do servidor.
 *
 * A janela é a menor que cobre o pior caso de cada tipo:
 *  • diária — hoje (se a hora ainda não passou) ou amanhã: 1 dia;
 *  • semanal — hoje é o dia escolhido e a hora já passou até o mesmo dia da
 *    semana seguinte: 7 dias;
 *  • mensal — o dia deste mês já passou até o do mês seguinte: 2 meses.
 */
export function proximaOcorrencia(
  regra: RegraDeRecorrencia,
  referencia: Date,
  fuso: string,
): Date | null {
  if (!regra.ativa) return null;

  const hoje = partesNoFuso(referencia, fuso);

  if (regra.tipo === "diaria") {
    for (let avanco = 0; avanco <= 1; avanco += 1) {
      const dia = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia + avanco));
      const candidato = instanteDe(
        {
          ano: dia.getUTCFullYear(),
          mes: dia.getUTCMonth() + 1,
          dia: dia.getUTCDate(),
          hora: regra.hora,
        },
        fuso,
      );
      if (candidato.getTime() > referencia.getTime()) return candidato;
    }
    return null;
  }

  if (regra.tipo === "mensal") {
    if (regra.dia_do_mes === null) return null;
    for (let avanco = 0; avanco <= 2; avanco += 1) {
      const mes = new Date(Date.UTC(hoje.ano, hoje.mes - 1 + avanco, 1));
      const ano = mes.getUTCFullYear();
      const numeroDoMes = mes.getUTCMonth() + 1;
      // Dia 31 em fevereiro cai no último dia do mês: a série "todo dia 31" não
      // pode simplesmente sumir em três meses do ano.
      const dia = Math.min(regra.dia_do_mes, ultimoDiaDoMes(ano, numeroDoMes));
      const candidato = instanteDe({ ano, mes: numeroDoMes, dia, hora: regra.hora }, fuso);
      if (candidato.getTime() > referencia.getTime()) return candidato;
    }
    return null;
  }

  for (let avanco = 0; avanco <= 7; avanco += 1) {
    // Data CIVIL (ano/mês/dia do calendário), não instante: `Date.UTC` aqui só
    // soma dias sem o fuso do processo entrar na conta. O dia da semana é o
    // dessa data civil — `getUTCDay` porque o objeto foi construído em UTC, e
    // não uma escolha de fuso: quem converte hora de parede em instante é o
    // `instanteDe`, logo abaixo, com o fuso da ORGANIZAÇÃO.
    const dia = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia + avanco));
    if (!regra.dias.includes(dia.getUTCDay())) continue;

    const candidato = instanteDe(
      {
        ano: dia.getUTCFullYear(),
        mes: dia.getUTCMonth() + 1,
        dia: dia.getUTCDate(),
        hora: regra.hora,
      },
      fuso,
    );
    if (candidato.getTime() > referencia.getTime()) return candidato;
  }
  return null;
}

/**
 * A série como a conclusão precisa dela: a regra, e tudo o que a próxima herda.
 *
 * `status` NÃO está aqui de propósito — o que se repete é o TRABALHO, não o
 * desfecho. Uma série concluída continua valendo para a semana que vem.
 */
interface SerieDaProxima {
  id: string;
  organization_id: string;
  timezone: string | null;
  title: string;
  description: string | null;
  priority: PrioridadeDaTarefa;
  lead_id: string | null;
  contact_id: string | null;
  demanda_id: string | null;
  assigned_to: string | null;
  created_by: string | null;
  recurrence: unknown;
}

/** O que a conclusão sabe da tarefa: só o necessário para achar a série. */
export interface TarefaConcluida {
  id: string;
  organization_id: string;
  /** Nulo na própria série; preenchido na ocorrência que ela gerou. */
  recurrence_source_id: string | null;
  due_date: string | Date | null;
}

export type ResultadoDaProxima =
  | { criada: true; tarefa_id: string; quando: string }
  | {
      criada: false;
      motivo: "sem_serie" | "desligada" | "ja_existe" | "sem_data" | "sem_dono" | "falha";
      erro?: string;
    };

/**
 * A PRÓXIMA ocorrência, criada AO CONCLUIR — o coração da saída 1.
 *
 * ═══ DE QUAL SÉRIE ═══
 *
 * Concluir a série ou concluir uma ocorrência dela dá no mesmo: a dona da regra
 * é sempre a série, e a série da ocorrência é `recurrence_source_id ?? id`.
 *
 * ═══ PARA QUANDO ═══
 *
 * A referência é a MAIOR entre o prazo da tarefa concluída e agora. Usar só o
 * prazo faria quem conclui uma tarefa de três semanas atrás gerar uma próxima
 * que já nasce atrasada. Usar só "agora" faria quem conclui ADIANTADO (a de
 * segunda, na sexta) pular a segunda seguinte, que é justamente a que a pessoa
 * espera.
 *
 * Com a maior das duas: concluir adiantado mantém o ritmo da série, e concluir
 * atrasado devolve a PRÓXIMA ocorrência futura — uma só, sem despejar as que
 * passaram enquanto ninguém cumpria o trabalho.
 *
 * ═══ QUANTAS ═══
 *
 * Uma. Sempre uma, nunca um lote: o `on conflict` da inserção (`criarTarefaInterna`
 * → `inserirTarefa`) é a trava do banco, e a segunda conclusão da mesma tarefa
 * devolve `ja_existe` em vez de duplicar.
 *
 * Não lança: a tarefa JÁ foi concluída quando isto roda, e derrubar a conclusão
 * por causa da próxima trocaria uma perda pequena (a próxima) por uma grande (a
 * pessoa achar que não conseguiu concluir).
 */
export async function criarProximaDaSerie(
  db: Db,
  concluida: TarefaConcluida,
  agora: Date = new Date(),
): Promise<ResultadoDaProxima> {
  const serieId = concluida.recurrence_source_id ?? concluida.id;

  let serie: SerieDaProxima | null;
  try {
    serie = await db.queryOne<SerieDaProxima>(
      `select t.id, t.organization_id, o.timezone, t.title, t.description, t.priority,
              t.lead_id, t.contact_id, t.demanda_id, t.assigned_to, t.created_by, t.recurrence
         from public.crm_tasks t
         join public.organizations o on o.id = t.organization_id
        where t.id = $1
          and t.organization_id = $2
        limit 1`,
      [serieId, concluida.organization_id],
    );
  } catch (err) {
    return { criada: false, motivo: "falha", erro: mensagemDoErro(err) };
  }
  if (!serie) return { criada: false, motivo: "sem_serie" };

  const regra = normalizarRegra(serie.recurrence);
  if (!regra || !regra.ativa) return { criada: false, motivo: "desligada" };

  const prazoDaConcluida = concluida.due_date ? new Date(concluida.due_date) : null;
  const referencia =
    prazoDaConcluida && prazoDaConcluida.getTime() > agora.getTime() ? prazoDaConcluida : agora;

  let quando: Date | null;
  try {
    quando = proximaOcorrencia(regra, referencia, fusoDaOrganizacao(serie.timezone));
  } catch {
    // Fuso inexistente na organização lança de propósito (`partesNoFuso`). A
    // conclusão de quem está trabalhando não pode virar erro por causa disso.
    return { criada: false, motivo: "falha", erro: "fuso_invalido" };
  }
  if (!quando) return { criada: false, motivo: "sem_data" };

  const resultado = await criarTarefaInterna(db, {
    organizationId: serie.organization_id,
    titulo: serie.title,
    descricao: serie.description,
    // O prazo vem CALCULADO: a série não vence "em N dias", ela vence numa data
    // e hora do calendário da organização.
    venceEm: quando.toISOString(),
    // O dono é o da série — inclusive quando a série não tem dono. `exato`
    // existe para isso: a próxima não ganha um responsável que ninguém escolheu.
    atribuirA: { exato: serie.assigned_to },
    prioridade: serie.priority,
    leadId: serie.lead_id,
    contactId: serie.contact_id,
    demandaId: serie.demanda_id,
    // Tarefa solta é caso real (`crm_tasks` nasce com os dois vínculos nulos): a
    // série sem negócio nem contato tem de continuar gerando.
    alvoOpcional: true,
    createdBy: serie.created_by,
    recurrenceSourceId: serie.id,
    origem: "tarefa:recorrencia",
    agora,
  });

  if (!resultado.ok) {
    if (resultado.codigo === "ja_existe") return { criada: false, motivo: "ja_existe" };
    return { criada: false, motivo: "falha", erro: resultado.erro };
  }

  return { criada: true, tarefa_id: resultado.tarefa_id, quando: quando.toISOString() };
}

/**
 * A mesma criação, sem derrubar quem chamou — para a rota de conclusão.
 *
 * A falha vira log e o `PATCH` responde 200: a conclusão da tarefa é o que a
 * pessoa pediu, e já está gravada. A próxima que não nasceu aqui o agendador
 * cria na rodada seguinte (`gerarOcorrencias`).
 */
export async function criarProximaSemDerrubar(
  db: Db,
  concluida: TarefaConcluida,
  agora: Date = new Date(),
): Promise<ResultadoDaProxima | null> {
  try {
    const resultado = await criarProximaDaSerie(db, concluida, agora);
    if (resultado.criada) {
      logger.info("[tarefas] próxima ocorrência criada", {
        serie_id: concluida.recurrence_source_id ?? concluida.id,
        tarefa_id: resultado.tarefa_id,
        quando: resultado.quando,
      });
    } else if (resultado.motivo === "falha") {
      // `criarProximaDaSerie` devolve a falha de banco sem lançar: sem esta linha
      // ela sumiria calada. O agendador tenta de novo na rodada seguinte.
      logger.error("[tarefas] falha ao criar a próxima ocorrência", {
        tarefa_id: concluida.id,
        error: resultado.erro,
      });
    }
    return resultado;
  } catch (err) {
    logger.error("[tarefas] falha ao criar a próxima ocorrência", {
      tarefa_id: concluida.id,
      error: mensagemDoErro(err),
    });
    return null;
  }
}

/** Quantas séries a rodada do agendador examina por vez. */
export const TAMANHO_DO_LOTE = 200;

/**
 * As séries que o agendador precisa olhar: com regra, sem vínculo de ocorrência
 * e SEM ocorrência futura (nem a própria, nem uma já gerada).
 *
 * O `not exists` é a otimização — a trava de verdade é o índice único.
 */
async function lerSeriesSemProxima(
  porta: Db,
  agora: Date,
): Promise<Array<{ id: string; organization_id: string }>> {
  return porta.query<{ id: string; organization_id: string }>(
    `select t.id, t.organization_id
       from public.crm_tasks t
      where t.recurrence is not null
        and t.recurrence_source_id is null
        -- Série desligada fora do lote: senão 200 delas ocupariam toda rodada.
        -- Só o booleano false desliga, a mesma régua de normalizarRegra.
        and t.recurrence->'ativa' is distinct from 'false'::jsonb
        -- Exclude inactive organizations before they can fill the batch.
        and public.fn_org_operante(t.organization_id)
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

export interface ResultadoDaGeracao {
  /** Eligible series from active organizations without a future occurrence. */
  series: number;
  /** Quantas ocorrências nasceram nesta rodada. */
  criadas: number;
  /** Quantas já existiam (a conclusão ou a rodada irmã chegou primeiro). */
  ja_existiam: number;
  /** Quantas falharam — ficam para a rodada seguinte. */
  falhas: number;
}

/**
 * A rodada do agendador (`cron/task-recurrence`): a próxima ocorrência de cada
 * série que ficou sem uma futura.
 *
 * Uma por série por rodada, de propósito: agendador parado por uma semana não
 * despeja sete tarefas atrasadas de uma vez. A criação é a MESMA da conclusão
 * (`criarProximaDaSerie`, referência = agora), então a ocorrência do agendador
 * também ganha audit, atividade e push.
 */
export async function gerarOcorrencias(
  porta: Db,
  agora: Date = new Date(),
): Promise<ResultadoDaGeracao> {
  const series = await lerSeriesSemProxima(porta, agora);

  let criadas = 0;
  let jaExistiam = 0;
  let falhas = 0;
  for (const serie of series) {
    const resultado = await criarProximaDaSerie(
      porta,
      { id: serie.id, organization_id: serie.organization_id, recurrence_source_id: null, due_date: null },
      agora,
    );
    if (resultado.criada) criadas += 1;
    else if (resultado.motivo === "ja_existe") jaExistiam += 1;
    else if (resultado.motivo === "falha") {
      falhas += 1;
      logger.error("[task-recurrence] falha ao criar a próxima ocorrência", {
        serie_id: serie.id,
        error: resultado.erro,
      });
    }
  }

  return { series: series.length, criadas, ja_existiam: jaExistiam, falhas };
}

function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
