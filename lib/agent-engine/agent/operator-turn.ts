/**
 * Handler do job `operator_turn` — o papel OPERADOR (spec 16 §3.2).
 *
 * O que mexe no sistema, e que **nunca fala com o lead**. Não é regra de prompt:
 * ele não tem `send_message` no toolset. A separação é por AUSÊNCIA, e é a única
 * forma que não depende de o modelo obedecer.
 *
 * ═══ POR QUE ELE NÃO É CHAMADO PELO CONVERSADOR ═══
 *
 * Porque isso devolveria o problema inteiro. Se o Operador só rodasse quando o
 * Conversador lembrasse de acioná-lo, o turno em que ele "não achasse necessário"
 * seria um lead parado no funil, em silêncio — e silêncio é justamente o modo de
 * falha que ninguém vê. O disparo é do RUNTIME, não do modelo.
 *
 * "Incondicional" era o que este comentário dizia, e era falso em dois pontos que
 * vale medir em vez de prometer: o job é enfileirado DEPOIS de o checkpoint
 * existir, então um turno que morre antes do fechamento não gera Operador naquela
 * tentativa (e quando o job esgota as tentativas, quem fecha o laço é o `job_dead`
 * crítico da fila); e ele só é enfileirado com o PAPEL LIGADO, porque enfileirar
 * com o papel desligado gastava fila e a vaga do lead para escrever uma linha de
 * log. O que não depende de nada é o modelo lembrar — e é isso que importava.
 *
 * ═══ O CURTO-CIRCUITO, e por que ele é fiel em vez de econômico ═══
 *
 * Quando a declaração (spec 16 §5) diz `nada_a_declarar: true`, o Operador NÃO
 * chama modelo: registra "nada a fazer" e encerra. Não é economia disfarçada de
 * desenho — é a distinção do passo 2 valendo a pena. Quem avaliou o turno foi o
 * Conversador, que estava lá; repetir a avaliação com menos contexto para chegar
 * à mesma conclusão é gastar a chave do self-hoster para nada.
 *
 * Mas quando a declaração está AUSENTE (`null`), ele roda. Ausente significa que
 * NINGUÉM avaliou — o fechamento veio incompleto —, e é exatamente aí que um
 * turno pode ter deixado promessa sem dono. Os dois estados que o passo 2 tomou o
 * cuidado de não colapsar decidem, aqui, se uma chamada de modelo acontece.
 */
import { z } from 'zod';
import type pg from 'pg';

import { withFields } from '../obs/logger';
import type { JobRow } from '../queue/queue';
import type { InboundTurnDeps } from './inbound-turn';
import { checkpointDoJob } from './inbound-turn';
import { declaracaoDoTurnoSchema, promessasEmAberto, type DeclaracaoDoTurno } from './declaracao';
import { loadPublishedAgentConfigById } from './agent-config';
import { isLeadInHandoff } from './human-handoff';
import { fusoDaOrganizacao } from './fuso-da-org';
import { renderAgora } from '@/lib/tempo/agora';
import { insertInboxItem } from '../db/repository';
import { buildMcpTurnTools } from '../edge/crm/mcp-tools';
import { runModelCall } from '../edge/llm/run-model-call';
import { avisarCapacidadesAusentes } from './inbound-turn';
import { criaRetornoDbPg } from '../../followup/retorno-pg';
import { emitAgentActivityForContact } from '../../leads/agent-activity';
import { copyDaPromessaSemDono } from '../../ai/agent-inbox-copy';

/**
 * O que o runtime enfileira ao fim do turno do Conversador. Só PONTEIROS: org e
 * contato vêm da row do job (fonte confiável, regra dura nº 1), nunca daqui.
 *
 * `agent_id` viaja porque o Operador precisa saber QUAL agente atendeu para ler a
 * config do papel (`operator_enabled`, `operator_model`) — e resolvê-lo de novo
 * pelo router aqui poderia dar outro agente, já que o roteamento depende do sinal
 * da mensagem, que não existe mais neste ponto.
 */
export const operatorTurnPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    /** job do turno do Conversador que originou este — correlação no trace. */
    origin_job_id: z.string().uuid(),
    agent_id: z.string().uuid().nullable().default(null),
  })
  .passthrough();

/**
 * O system do papel. Fala de OPERAÇÃO com todas as letras — e pode, porque este
 * texto nunca alcança um cliente: este papel não tem canal.
 *
 * É o inverso exato do prompt do Conversador, e a assimetria é o desenho inteiro
 * da spec 16 em duas frases. Lá, vocabulário de sistema é o defeito (30% de
 * vazamento medido); aqui, é o vocabulário de trabalho.
 */
export const SYSTEM_DO_OPERADOR =
  'Você é o operador do sistema. Seu trabalho é deixar o CRM refletindo o que aconteceu na ' +
  'conversa que acabou de ocorrer — mover o lead, registrar, abrir o que precisa ser aberto.\n\n' +
  'VOCÊ NÃO FALA COM O CLIENTE. Você não tem como enviar mensagem, e não deve tentar: quem ' +
  'conversa é outro. Se algo exigir falar com a pessoa, registre e siga.\n\n' +
  'ATENÇÃO: quem conversou só FALA — ele não grava nada no CRM sozinho. Se a promessa dele veio ' +
  'redigida como já concluída ("registrei com o Fulano", "já está com a equipe", "ficou ' +
  'combinado"), isso é o que ele DISSE ao cliente, não prova de que algo foi registrado. O passado ' +
  'na frase não é evidência de ação — trate a promessa como pendente até você mesmo confirmar ou ' +
  'registrar (mover o lead, abrir nota, o que fizer sentido com as ferramentas que você tem).\n\n' +
  'Use apenas o que a conversa sustenta. Não invente avanço, não registre o que ninguém disse. ' +
  'Se não houver nada a fazer, não faça nada — um turno sem ação é uma resposta válida.';

/**
 * O briefing do turno: o que o Conversador declarou, em linguagem de negócio.
 *
 * `agoraBlock` é o relógio (`renderAgora`), e ele não é enfeite aqui: o
 * Operador é quem EXECUTA a promessa com prazo — o briefing abaixo já ecoa
 * `— até ${p.prazo}` em ISO —, e `crm_schedule_followup` pode estar entregue só
 * a ele (`entrega-de-capacidade.ts`), o que faz dele o único papel do turno com
 * a ferramenta que precisa de data. Cobrar um prazo sem saber que dia é hoje é
 * o mesmo buraco que a abertura do Conversador tinha.
 *
 * Opcional com default vazio de propósito: os chamadores de teste montam o
 * briefing sem relógio, e o que este parâmetro não pode fazer é obrigar quem já
 * chamava a mudar.
 */
export function renderBriefingDoOperador(
  declaracao: DeclaracaoDoTurno | null,
  promessas: ReturnType<typeof promessasEmAberto>,
  agoraBlock = '',
): string {
  const comAgora = (linhas: string[]): string =>
    (agoraBlock === '' ? linhas : [agoraBlock, '', ...linhas]).join('\n');
  if (declaracao === null) {
    // Ausente ≠ vazia, de novo — e aqui a diferença vira instrução. Dizer ao
    // modelo "não houve declaração" e pedir que ele olhe o estado é diferente de
    // deixá-lo achar que o turno foi vazio.
    return comAgora([
      'O turno anterior NÃO deixou declaração do que aconteceu (fechamento incompleto).',
      'Verifique o estado do lead e registre o que estiver claramente pendente.',
      'Na dúvida, não faça nada.',
    ]);
  }
  const linhas = ['Foi isto que aconteceu na conversa que acabou:'];
  if (declaracao.intencoes.length > 0) {
    linhas.push('', 'O que a pessoa quer:');
    for (const i of declaracao.intencoes) linhas.push(`- ${i.o_que} (na conversa: "${i.evidencia}")`);
  }
  if (promessas.length > 0) {
    linhas.push('', 'O que foi prometido a ela (precisa existir no sistema):');
    for (const p of promessas) {
      linhas.push(`- ${p.o_que}${p.prazo === null ? '' : ` — até ${p.prazo}`}`);
    }
  }
  linhas.push('', 'Deixe o sistema refletindo isso. O que já estiver registrado, não repita.');
  return comAgora(linhas);
}

/** O que o Operador decidiu neste turno — vai a `event_log` e, quando muda o que
 *  alguém faria a seguir, à timeline do lead. */
export type DesfechoDoOperador =
  | { tipo: 'nada_a_fazer'; porque: 'declaracao_vazia' }
  | { tipo: 'pulado'; porque: 'papel_desligado' | 'sem_agente' | 'handoff_humano' }
  | { tipo: 'agiu'; ferramentas: number };

/**
 * Os NOMES das ferramentas que o turno chamou. Só os nomes: argumento carrega o
 * que o cliente disse, e isso não entra em registro nenhum.
 *
 * ⚠️ Lê `steps`, NUNCA `result.toolCalls`. No AI SDK o `toolCalls` do topo é o do
 * ÚLTIMO passo; um turno que chamou ferramenta no passo 1 e encerrou no 2
 * contaria ZERO — e zero, aqui, vira "ninguém assumiu a promessa", que é
 * exatamente o alarme falso que este conserto existe para matar.
 */
export function nomesDasFerramentasChamadas(
  saida: { result: { steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName?: string }> }> } } | null,
): string[] {
  if (saida === null) return [];
  return saida.result.steps.flatMap((s) =>
    (s.toolCalls ?? []).map((c) => String(c.toolName ?? 'desconhecida')),
  );
}

/** Quem ficou responsável pela promessa que o Conversador declarou. */
export type DonoDaPromessa =
  | { assumida: true; por: 'ferramenta_do_operador' | 'retorno_agendado' }
  | { assumida: false; porque: 'operador_sem_ferramentas' | 'operador_nao_agiu' | 'operador_nao_rodou' };

/**
 * A APURAÇÃO — pura, testável sem banco, sem modelo e sem fila, como
 * `decidirSeRoda`.
 *
 * Ela existe porque o aviso da Central afirmava não-cumprimento sem nunca medir
 * nada: disparava pela CONTAGEM de promessas declaradas, que é um fato sobre o
 * Conversador, não sobre o Operador. Aqui se apura o que o sistema realmente
 * consegue saber — se **alguém ficou responsável** —, e é só isso que o texto
 * pode afirmar. Se a promessa foi CUMPRIDA, ninguém aqui sabe: agendar um
 * retorno não é cumprir.
 *
 * A precedência é o desenho, não detalhe de implementação:
 *
 * - ferramenta chamada NESTE turno vence retorno pré-existente, porque foi este
 *   turno que agiu;
 * - `operador_sem_ferramentas` vence `operador_nao_agiu` mesmo com o papel
 *   ligado, porque a AÇÃO que cabe ao dono do negócio é outra — marcar
 *   capacidades na tela, não decidir sobre este cliente.
 */
export function apuraDonoDaPromessa(input: {
  ferramentasChamadas: readonly string[];
  temRetornoVivo: boolean;
  operadorRodou: boolean;
  operadorTemFerramentas: boolean;
}): DonoDaPromessa {
  if (input.ferramentasChamadas.length > 0) return { assumida: true, por: 'ferramenta_do_operador' };
  if (input.temRetornoVivo) return { assumida: true, por: 'retorno_agendado' };
  if (!input.operadorRodou) return { assumida: false, porque: 'operador_nao_rodou' };
  if (!input.operadorTemFerramentas) return { assumida: false, porque: 'operador_sem_ferramentas' };
  return { assumida: false, porque: 'operador_nao_agiu' };
}

/**
 * Lê a declaração do último checkpoint do lead.
 *
 * `null` tem DOIS significados aqui e eles não se confundem: o turno que me
 * originou não fechou (não há checkpoint com aquele `job_id`) ou o checkpoint
 * existe e não trouxe declaração (o modelo não declarou). Os dois levam o
 * Operador a RODAR, não a pular — nos dois casos ninguém avaliou o turno, que é a
 * condição em que ele mais importa.
 *
 * A leitura é pela CHAVE DO TURNO, não pelo mais recente do lead: ver
 * `checkpointDoJob`. Ler o mais recente fazia o Operador N agir sobre a
 * declaração N+1 quando uma mensagem nova chegava no meio do fechamento.
 */
export async function lerDeclaracaoDoTurno(
  db: pg.Pool,
  tenantId: string,
  leadId: string,
  /**
   * O job do turno do Conversador que originou este. OBRIGATÓRIO de propósito:
   * com parâmetro opcional o compilador aceitaria o call site que esquece a
   * chave, que é exatamente o defeito que isto conserta.
   */
  originJobId: string,
): Promise<{ declaracao: DeclaracaoDoTurno | null; houveCheckpoint: boolean }> {
  const checkpoint = await checkpointDoJob(db, tenantId, leadId, originJobId);
  if (checkpoint === null) return { declaracao: null, houveCheckpoint: false };
  if (checkpoint.declaracao === null) return { declaracao: null, houveCheckpoint: true };
  // O jsonb do banco não é confiável por vir do banco: foi escrito por um modelo.
  // Shape quebrado é tratado como "não declarou" — a direção segura, porque leva
  // o Operador a rodar em vez de pular.
  const parsed = declaracaoDoTurnoSchema.safeParse(checkpoint.declaracao);
  return { declaracao: parsed.success ? parsed.data : null, houveCheckpoint: true };
}

/**
 * A decisão de RODAR OU NÃO, isolada em função pura para ser testável sem banco,
 * sem modelo e sem fila. É a regra que decide se a chave do self-hoster é gasta.
 */
export function decidirSeRoda(input: {
  papelLigado: boolean;
  declaracao: DeclaracaoDoTurno | null;
}):
  // A união é DISCRIMINADA na origem em vez de `desfecho?: DesfechoDoOperador`:
  // com o opcional, quem lê precisa de `?.` e o compilador aceita ler `porque`
  // de um desfecho que não o tem. Aqui, `roda: false` GARANTE um desfecho de
  // não-execução, e `roda: true` garante que não há desfecho a inspecionar.
  | { roda: true }
  | { roda: false; desfecho: Extract<DesfechoDoOperador, { tipo: 'nada_a_fazer' | 'pulado' }> } {
  if (!input.papelLigado) {
    return { roda: false, desfecho: { tipo: 'pulado', porque: 'papel_desligado' } };
  }
  // Declarou explicitamente que não havia nada: quem avaliou estava lá, com o
  // contexto inteiro. Repetir a avaliação com menos contexto é gastar por nada.
  if (input.declaracao !== null && input.declaracao.nada_a_declarar) {
    return { roda: false, desfecho: { tipo: 'nada_a_fazer', porque: 'declaracao_vazia' } };
  }
  return { roda: true };
}

export function createOperatorTurnHandler(deps: InboundTurnDeps) {
  return async function handleOperatorTurn(
    job: JobRow,
    pool: pg.Pool,
    ctx: { workerId: string },
  ): Promise<void> {
    const tenantId = job.organization_id;
    const leadId = job.contact_id;
    if (leadId === null) {
      throw new Error('operator_turn sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = operatorTurnPayloadSchema.parse(job.payload);
    const log = withFields(deps.log, {
      job_id: job.id,
      tenant_id: tenantId,
      lead_id: leadId,
      origin_job_id: payload.origin_job_id,
    });

    // Um humano assumiu ENTRE o turno do Conversador e este job. O Operador é
    // enfileirado no fim daquele turno e roda depois — inclusive depois de um
    // handoff pedido NO MEIO dele (a tool `request_human_handoff`) ou pelo botão
    // "assumir eu" da tela. Escrever no CRM aqui seria a IA operando por cima da
    // pessoa que assumiu, e handoff não se revoga pelo agente.
    //
    // A guarda é AQUI, na EXECUÇÃO, e não no enfileiramento: o estado nasce
    // durante o turno anterior e pode mudar depois dele, então só o instante da
    // execução lê o estado que vale. Era o único dos quatro handlers de turno sem
    // ela — `inbound-turn` e `followup-turn` a têm, e o formato aqui é o deles
    // (registrar o motivo e sair). Persistir o desfecho de cada caminho é
    // trabalho separado, e vale para os quatro do mesmo jeito.
    if (await isLeadInHandoff(pool, tenantId, leadId)) {
      // Único caminho que sai SEM apurar promessa, e é deliberado: quem assumiu
      // está com a conversa aberta na frente. Abrir um item de Central para uma
      // pessoa que já está olhando é o alarme redundante que ensina a ignorar os
      // outros. O desfecho vai a registro do mesmo jeito.
      await registrarDesfecho(
        pool,
        {
          tenantId,
          leadId,
          jobId: job.id,
          originJobId: payload.origin_job_id,
          conversationId: payload.conversation_id,
          agentId: payload.agent_id,
          desfecho: { tipo: 'pulado', porque: 'handoff_humano' },
          promessasDeclaradas: 0,
          dono: null,
          ferramentasChamadas: [],
          houveCheckpoint: null,
        },
        log,
      );
      return;
    }

    // A DECLARAÇÃO É LIDA ANTES DA CONFIG, e a ordem é o conserto.
    //
    // Ela sai de `lead_checkpoints` e não depende de agente publicado nenhum: o
    // fechamento do turno grava a declaração com ou sem agente. Lendo depois, o
    // caminho `sem_agente` — que é o estado de uma instalação FRESCA, antes de
    // alguém publicar o primeiro agente — saía antes de apurar qualquer coisa, e
    // uma promessa feita ali não gerava rede nenhuma. Primeira impressão é onde
    // um lead perdido custa o cliente inteiro.
    const { declaracao, houveCheckpoint } = await lerDeclaracaoDoTurno(pool, tenantId, leadId, payload.origin_job_id);
    const promessas = promessasEmAberto(declaracao);

    const agentConfig =
      payload.agent_id === null ? null : await loadPublishedAgentConfigById(pool, tenantId, payload.agent_id);
    if (agentConfig === null) {
      // Sem agente publicado não há config de papel para ler. Não é erro: é o
      // turno que rodou no genérico. Mas a promessa continua tendo de ter dono.
      await registrarDesfecho(
        pool,
        {
          tenantId,
          leadId,
          jobId: job.id,
          originJobId: payload.origin_job_id,
          conversationId: payload.conversation_id,
          agentId: payload.agent_id,
          desfecho: { tipo: 'pulado', porque: 'sem_agente' },
          promessasDeclaradas: promessas.length,
          dono: await apurarComRetorno(pool, tenantId, leadId, promessas.length, {
            ferramentasChamadas: [],
            operadorRodou: false,
            operadorTemFerramentas: false,
          }),
          ferramentasChamadas: [],
          houveCheckpoint,
        },
        log,
      );
      return;
    }

    const decisao = decidirSeRoda({ papelLigado: agentConfig.operatorEnabled, declaracao });

    if (!decisao.roda) {
      // "Nada a fazer" é DECISÃO REGISTRADA, não silêncio (invariante 4 do
      // sistema vivo). Um turno em que o Operador não agiu e ninguém soube é
      // indistinguível de um turno em que ele falhou.
      await registrarDesfecho(
        pool,
        {
          tenantId,
          leadId,
          jobId: job.id,
          originJobId: payload.origin_job_id,
          conversationId: payload.conversation_id,
          agentId: payload.agent_id,
          desfecho: decisao.desfecho,
          promessasDeclaradas: promessas.length,
          dono: await apurarComRetorno(pool, tenantId, leadId, promessas.length, {
            ferramentasChamadas: [],
            operadorRodou: false,
            operadorTemFerramentas: agentConfig.operatorToolIds.length > 0,
          }),
          ferramentasChamadas: [],
          houveCheckpoint,
        },
        log,
      );
      return;
    }

    // A MÃO do papel: só as ferramentas DELE (`operator_tool_ids`), nunca as do
    // Conversador. `send_message` não está aqui e não pode estar — é assim que
    // "nunca fala com o lead" deixa de ser instrução de prompt e vira ausência.
    //
    // Sem ferramenta configurada o papel ainda tem valor e ainda roda: ele
    // registra a promessa em aberto. Chamar o modelo para descobrir que ele não
    // tem mão nenhuma seria gastar a chave do self-hoster para nada.
    let mcp: Awaited<ReturnType<typeof buildMcpTurnTools>> = null;
    if (agentConfig.operatorToolIds.length > 0) {
      try {
        mcp = await buildMcpTurnTools(
          deps.crmCfg,
          { organizationId: tenantId, jobId: job.id },
          // A ponte lê `toolIds`; o papel guarda a lista dele em
          // `operatorToolIds`. A troca acontece AQUI, num ponto só, para que
          // nenhum caminho do Operador alcance a lista do Conversador por
          // engano — que seria dar a ele a mão do outro.
          { ...agentConfig, toolIds: agentConfig.operatorToolIds },
          log,
        );
      } catch (err) {
        // Mesma doutrina do turno do Conversador: capacidade que não montou não
        // derruba o job, mas também não morre no log de um contêiner que
        // ninguém abre — o aviso vai para a Central.
        const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        log.error('capacidades do operador não montadas — o papel segue sem elas', { error: detalhe });
        await avisarCapacidadesAusentes(pool, tenantId, payload.conversation_id, detalhe, log);
      }
    }

    log.info('operador rodou', {
      promessas: promessas.length,
      intencoes: declaracao?.intencoes.length ?? 0,
      declaracao_ausente: declaracao === null,
      houve_checkpoint: houveCheckpoint,
      model: agentConfig.operatorModel ?? agentConfig.model,
      tools: mcp?.toolIds ?? [],
    });

    // O RETORNO É CAPTURADO. Descartá-lo era a raiz de dois defeitos ao mesmo
    // tempo: o desfecho não tinha o que persistir (virou log.info) e o aviso
    // precisou de um proxy — a contagem de promessas DECLARADAS, que é um fato
    // sobre o Conversador, não sobre o Operador.
    let saida: Awaited<ReturnType<typeof runModelCall>> | null = null;
    try {
      if (mcp !== null) {
        saida = await runModelCall(
          pool,
          deps.llmCfg,
          {
            tenantId,
            leadId,
            jobId: job.id,
            // Atribuição de custo própria: sem isto o gasto do Operador entraria
            // como se fosse conversa, e "quanto custa ligar o papel?" — a
            // pergunta que o dono do negócio vai fazer — não teria resposta.
            purpose: 'operator_turn',
            system: SYSTEM_DO_OPERADOR,
            messages: [
              {
                role: 'user',
                content: renderBriefingDoOperador(
                  declaracao,
                  promessas,
                  renderAgora(
                    deps.clock?.() ?? new Date(),
                    await fusoDaOrganizacao(pool, tenantId, log),
                  ),
                ),
              },
            ],
            tools: mcp.tools,
            maxSteps: agentConfig.maxSteps,
            // O modelo E o provider/credencial, sempre juntos — a regra do PR
            // #151 (`aux-model-args.ts`). Este era o último call site que
            // mandava só a string: com o Operador publicado em OpenAI e a org
            // em Anthropic, o id ia para o endpoint errado e o papel morria.
            //
            // E `operatorModel` vazio significa "a mesma que conversa" — é o
            // que a tela escreve no campo (`PainelDoOperador.tsx`: "A mesma
            // que conversa (…)"). Sem o `??`, vazio caía no `default_model` da
            // organização: o controle mostrava uma promessa e entregava outra.
            model: agentConfig.operatorModel ?? agentConfig.model,
            llmOverride: {
              provider: agentConfig.provider,
              credentialId: agentConfig.credentialId,
            },
          },
          { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log },
        );
      }
    } finally {
      await mcp?.cleanup();
    }

    const ferramentasChamadas = nomesDasFerramentasChamadas(saida);
    await registrarDesfecho(
      pool,
      {
        tenantId,
        leadId,
        jobId: job.id,
        originJobId: payload.origin_job_id,
        conversationId: payload.conversation_id,
        agentId: payload.agent_id,
        desfecho: { tipo: 'agiu', ferramentas: ferramentasChamadas.length },
        promessasDeclaradas: promessas.length,
        dono: await apurarComRetorno(pool, tenantId, leadId, promessas.length, {
          ferramentasChamadas,
          operadorRodou: true,
          operadorTemFerramentas: agentConfig.operatorToolIds.length > 0,
        }),
        ferramentasChamadas,
        houveCheckpoint,
      },
      log,
    );
    void ctx;
  };
}

/**
 * A apuração, com a consulta de retorno vivo feita só quando ela decide algo.
 *
 * Sem promessa declarada não há dono a apurar, e a query não acontece — o papel
 * roda a cada turno e a maioria não promete nada.
 *
 * `buscaRetornoVivo` é REUSADO de `lib/followup/retorno-pg.ts` em vez de um SQL
 * novo aqui: é a mesma regra que decide se o lead tem retorno em voo no Radar de
 * Risco. Duas queries para a mesma pergunta viram, com o tempo, duas respostas.
 */
/**
 * EXPORTADA so para o teste alcancar a FIACAO. A regra (`apuraDonoDaPromessa`)
 * ja tinha rede; o fio que a liga ao `buscaRetornoVivo` nao tinha — medido:
 * trocar `retorno !== null` por `false` deixava a suite INTEIRA verde (3516
 * casos, exit 0), e o comportamento restaurado era exatamente o que este PR diz
 * ter matado: a Central acusando quem acabou de agendar o retorno.
 */
export async function apurarComRetorno(
  pool: pg.Pool,
  tenantId: string,
  leadId: string,
  promessasDeclaradas: number,
  entrada: {
    ferramentasChamadas: readonly string[];
    operadorRodou: boolean;
    operadorTemFerramentas: boolean;
  },
  /**
   * Costura só para o teste alcançar o FIO. Produção nunca passa este argumento.
   * Mock de módulo não serve aqui: o grafo já está carregado quando o caso roda,
   * e o `criaRetornoDbPg` real acaba chamado com um pool falso — medido,
   * `db.query is not a function`.
   */
  buscaRetorno: (t: string, l: string) => Promise<unknown> = (t, l) =>
    criaRetornoDbPg(pool).buscaRetornoVivo(t, l),
): Promise<DonoDaPromessa | null> {
  if (promessasDeclaradas === 0) return null;
  const retorno = await buscaRetorno(tenantId, leadId);
  return apuraDonoDaPromessa({ ...entrada, temRetornoVivo: retorno !== null });
}

/**
 * O desfecho do turno do Operador vira registro — e, quando muda o que alguém
 * faria a seguir, vira linha na timeline e item na Central.
 *
 * ═══ A REGRA DE EMISSÃO, E A JUSTIFICATIVA DE CADA LINHA ═══
 *
 * **`event_log`, SEMPRE.** É o que mata o `return` mudo: um turno em que o papel
 * não agiu e ninguém soube é indistinguível de um em que ele falhou. É também o
 * que torna CONTÁVEIS as três medidas que a spec 16 §7 promete — taxa de ação
 * por turno, promessas declaradas × assumidas, e turnos em que ele quis agir e
 * não pôde. Sem uma linha por execução, nenhuma delas tem denominador.
 * `status='done'` explícito porque a linha é REGISTRO, não item de trabalho: o
 * drain só processa `event_type` com handler, e sem o `done` ela ficaria
 * `pending` para sempre fingindo backlog.
 *
 * **Timeline, só quando há promessa SEM dono.** É a disciplina do
 * `diffCheckpoint`: entra o que muda o que alguém faria a seguir, não o relato do
 * turno. Quando o Operador AGE, as ferramentas dele já emitem as atividades delas
 * (`stage_changed`, `followup_scheduled`); uma segunda linha dizendo "o Operador
 * trabalhou" é exatamente o ruído que enterra a linha que importa.
 *
 * **Central, mesmo critério, MENOS o handoff.** A Central é para o que ninguém
 * está olhando.
 *
 * Tudo best-effort: o registro não derruba o job que ele descreve. Mas o
 * silêncio também não serve — log de worker em VPS não é superfície de nada, e
 * este produto é instalado por quem nunca vai abrir um contêiner.
 */
async function registrarDesfecho(
  pool: pg.Pool,
  entrada: {
    tenantId: string;
    leadId: string;
    jobId: string;
    originJobId: string;
    conversationId: string;
    agentId: string | null;
    desfecho: DesfechoDoOperador;
    promessasDeclaradas: number;
    dono: DonoDaPromessa | null;
    ferramentasChamadas: readonly string[];
    houveCheckpoint: boolean | null;
  },
  log: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  },
): Promise<void> {
  const { desfecho, dono } = entrada;
  const semDono = dono !== null && !dono.assumida;

  log.info('operador — desfecho do turno', {
    desfecho: desfecho.tipo,
    porque: 'porque' in desfecho ? desfecho.porque : null,
    promessas: entrada.promessasDeclaradas,
    promessa_assumida_por: dono?.assumida === true ? dono.por : null,
    promessa_sem_dono_porque: semDono && dono !== null && !dono.assumida ? dono.porque : null,
    ferramentas: entrada.ferramentasChamadas,
  });

  try {
    await pool.query(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, status, payload)
       values ($1, 'agent.operator_turn', 'contact', $2, 'done', $3::jsonb)`,
      [
        entrada.tenantId,
        entrada.leadId,
        // Contagens e nomes de ferramenta. NUNCA o texto da promessa: ele é o que
        // o cliente disse, e já vive em `lead_checkpoints`.
        JSON.stringify({
          desfecho: desfecho.tipo,
          porque: 'porque' in desfecho ? desfecho.porque : null,
          ferramentas_chamadas: entrada.ferramentasChamadas,
          promessas_declaradas: entrada.promessasDeclaradas,
          promessa_assumida_por: dono?.assumida === true ? dono.por : null,
          promessa_sem_dono_porque: dono !== null && !dono.assumida ? dono.porque : null,
          houve_checkpoint: entrada.houveCheckpoint,
          origin_job_id: entrada.originJobId,
        }),
      ],
    );
  } catch (err) {
    log.warn('desfecho do operador não foi registrado', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }

  if (!semDono || dono === null || dono.assumida) return;

  const texto = copyDaPromessaSemDono(entrada.promessasDeclaradas, dono.porque);

  try {
    await emitAgentActivityForContact({
      pool,
      organizationId: entrada.tenantId,
      contactId: entrada.leadId,
      type: 'promise_unowned',
      sourceModule: 'agent-operador',
      sourceId: entrada.jobId,
      ...(entrada.agentId !== null ? { agentId: entrada.agentId } : {}),
      reason: texto.title,
      payload: { promessas: entrada.promessasDeclaradas, porque: dono.porque },
    });
  } catch (err) {
    log.warn('linha de promessa sem responsável não foi emitida', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }

  if ('porque' in desfecho && desfecho.porque === 'handoff_humano') return;

  try {
    await insertInboxItem(
      pool,
      entrada.tenantId,
      {
        kind: 'promise_unfulfilled',
        severity: 'warn',
        title: texto.title,
        body: texto.body,
        refKind: 'conversation',
        refId: entrada.conversationId,
      },
      // Por conversa, não por organização: dedupar este kind org-wide engoliria a
      // promessa de OUTRO cliente, que é perder sinal em vez de sobrar ruído.
      'kind_e_ref',
    );
  } catch (err) {
    log.warn('aviso de promessa sem responsável não foi gravado', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

