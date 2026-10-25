/**
 * O ROTEIRO DE ATENDIMENTO dentro do turno do agente — o único ponto por onde o
 * módulo opcional `fluxos_atendimento` (#1130, de @vgamkt) alcança a conversa.
 *
 * ─── Onde entra, e por quê ali ──────────────────────────────────────────────
 *
 * `executarTurnoDoAgente` chama `prepararRoteiroDoTurno` DEPOIS de tudo que já
 * silencia o turno: lead em atendimento humano, conversa não elegível, agente
 * pausado ou assistido, pedido explícito de humano e suspeita de opt-out (os
 * dois últimos retornam cedo) — e só quando o contato NÃO está bloqueado. Na
 * prova prática do #1130, o início por palavra-gatilho rodava ANTES dessas
 * travas: "para de me mandar mensagem sobre financiamento" bloqueava o contato
 * E abria um roteiro para ele. A ordem é o conserto; o teste de ordem
 * (`roteiro-no-turno.test.ts`) a vigia no texto do turno.
 *
 * ─── As entradas do turno ───────────────────────────────────────────────────
 *
 * Um roteiro sem roteiro vivo começa, neste turno, por uma de três portas, em
 * precedência: o ROTEADOR (o membro aponta um roteiro — decisão já tomada sobre
 * a mensagem), a PALAVRA-GATILHO (`settings.gatilhos`, o cliente pedindo) e a
 * ETAPA DO FUNIL (`settings.etapas_do_funil`, o card do contato numa etapa —
 * contexto do card, não da mensagem). A terceira é o #2630: sem ela, um card em
 * "Proposta enviada" não disparava o roteiro daquela etapa.
 *
 * ─── A etapa vale UMA VEZ POR ENTRADA, não por turno (revisão do #3253) ──────
 *
 * A #2630 pede "começar quando o card ENTRAR na etapa". O primeiro desenho
 * começava enquanto ele ESTAVA lá — todo turno sem roteiro vivo rearmava a etapa
 * —, e o mantenedor mediu o efeito: roteiro concluído com `pode_recomecar`
 * reabria na mensagem seguinte, e de novo a cada conclusão, com o card parado na
 * etapa. Quem decide isso é `escolherFluxoDoTurno`/`entradaJaGasta` (a entrada é
 * um evento, `crm_leads.stage_changed_at`, com o `created_at` de reserva), e não
 * este arquivo: o turno continua lendo a etapa em TODO turno — o que mudou é que
 * a etapa só liga se a entrada dela ainda não tiver sido gasta. O mecanismo do
 * próximo turno segue como a issue propôs. A palavra-gatilho e a etapa entram
 * pela MESMA chamada, que lê os roteiros ativos uma vez só (revisão do #3253).
 *
 * ─── Chave desligada = nada ─────────────────────────────────────────────────
 *
 * A primeira coisa é a chave da instalação. Desligada, a função devolve `null`
 * sem uma consulta de roteiro sequer — inclusive quando existe roteiro
 * 'coletando' de quando ela estava ligada: quem desliga o módulo desliga o
 * caminho inteiro.
 *
 * ─── Falha do roteiro não derruba o atendimento ─────────────────────────────
 *
 * Toda falha aqui vira aviso no log e `null` (ou o estado que já havia): o
 * cliente continua sendo atendido pela IA, só sem o roteiro neste turno. O log
 * NUNCA leva o texto do cliente — na prova, a linha "decisão do validador" do
 * autor gravava o CPF em texto aberto no `docker logs`.
 */
import type { Logger } from '../obs/logger';
import type { LeituraDaResposta, MensagemDoContexto, PerguntaDoFluxo } from './flow-validate';
import type { EndFinish } from '@/lib/followup/graph-schema';
import {
  carregarEstadoDeAtendimento,
  escolherFluxoDoTurno,
  iniciarFluxoDeAtendimento,
  lerLoteParaORoteiro,
  processarInboundDoFluxo,
  reivindicarMensagemDoRoteiro,
  registrarEventoDoRoteiro,
  renderBlocoDeAtendimento,
  type BancoDoRoteiro,
  type EstadoDeAtendimento,
  type MensagemDoLote,
} from '@/lib/followup/atendimento';
import { perguntaSaiuNosTextos, textoDaPergunta } from '@/lib/followup/captura-do-fluxo';

export interface RoteiroDoTurno {
  estado: EstadoDeAtendimento;
  /** Ação do nó Fim, quando o roteiro concluiu NESTE turno. */
  finalizacao?: EndFinish;
  /** Vai para os sufixos da abertura (volátil, depois do prefixo cacheável). */
  bloco: string;
  /** Skills que o roteiro puxa neste passo — somadas às do matcher. */
  skills: string[];
  iniciadoNesteTurno: boolean;
}

export type ValidarResposta = (args: {
  perguntas: readonly PerguntaDoFluxo[];
  preenchidos: readonly {
    key: string;
    label: string;
    valor: string;
    type?: PerguntaDoFluxo['type'];
    options?: string[] | undefined;
  }[];
  esgotados?: readonly PerguntaDoFluxo[];
  mensagens: readonly MensagemDoContexto[];
  textoAtual?: string | null;
  perguntaAtual?: string | null;
}) => Promise<LeituraDaResposta>;

export interface DepsDoRoteiro {
  pool: BancoDoRoteiro;
  moduloLigado: () => Promise<boolean>;
  validar: ValidarResposta;
  log: Logger;
}

export interface TurnoDoRoteiro {
  organizationId: string;
  contactId: string;
  conversationId: string | null;
  /** A mensagem que ESTE turno responde (pinada no job). */
  texto: string | null;
  messageId: string | null;
  /** Roteiro que a intenção casada pelo roteador aponta (nunca no sticky). */
  flowPointerDoRoteador: string | null;
  /** Últimas mensagens da conversa, para o validador ler no contexto. */
  mensagens: readonly MensagemDoContexto[];
}

function erroCurto(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}

function montar(estado: EstadoDeAtendimento, iniciado: boolean, finalizacao?: EndFinish): RoteiroDoTurno {
  return {
    estado,
    ...(finalizacao !== undefined ? { finalizacao } : {}),
    bloco: renderBlocoDeAtendimento(estado, finalizacao),
    skills: [
      ...estado.situacao.skills,
      ...(finalizacao?.tipo === 'skill' ? [finalizacao.skill_name] : []),
    ],
    iniciadoNesteTurno: iniciado,
  };
}

/**
 * Carrega (ou começa) o roteiro do contato e processa a mensagem do turno
 * contra ele, ANTES de o modelo rodar. `null` = não há roteiro neste turno.
 */
export async function prepararRoteiroDoTurno(
  deps: DepsDoRoteiro,
  t: TurnoDoRoteiro,
): Promise<RoteiroDoTurno | null> {
  if (!(await deps.moduloLigado())) return null;

  let estado: EstadoDeAtendimento | null;
  let iniciado = false;
  // O que o ROTEIRO lê: o LOTE do turno (a mensagem pinada e as que pegaram
  // carona na rajada), cada uma com legenda + conteúdo derivado da mídia, das
  // próprias linhas (não o corpo enquadrado do histórico do agente).
  let lote: MensagemDoLote[] | null = null;
  const textoDe = (mensagens: readonly MensagemDoLote[]): string | null => {
    const legiveis = mensagens.flatMap((m) => (m.texto === null ? [] : [m.texto]));
    return legiveis.length === 0 ? null : legiveis.join('\n');
  };
  let texto = t.texto;
  try {
    if (t.messageId !== null && t.conversationId !== null) {
      lote = await lerLoteParaORoteiro(deps.pool, {
        organizationId: t.organizationId,
        conversationId: t.conversationId,
        messageId: t.messageId,
      });
      texto = textoDe(lote);
    }
    estado = await carregarEstadoDeAtendimento(deps.pool, {
      organizationId: t.organizationId,
      contactId: t.contactId,
    });
    if (estado === null) {
      // AS ENTRADAS DO TURNO, em ordem de precedência declarada:
      //   roteador → palavra-gatilho → etapa do funil.
      // O roteador é a decisão já tomada sobre ESTA mensagem (o membro aponta um
      // roteiro) e ganha de todo o resto; a palavra-gatilho é o cliente pedindo
      // agora, com todas as letras; e a etapa do funil é contexto do CARD, não
      // da mensagem — entra quando ninguém falou nada. Sem a terceira, um card
      // em "Proposta enviada" não disparava o roteiro daquela etapa (#2630). A
      // etapa é lida em todo turno, mas só LIGA uma vez por entrada do card nela
      // (revisão do #3253): quem já nasceu depois da entrada a gastou.
      //
      // A palavra-gatilho e a etapa são UMA decisão só (`escolherFluxoDoTurno`,
      // revisão do #3253): as duas leem o mesmo conjunto de roteiros ativos, e
      // lê-lo por porta fazia o turno ler a lista duas vezes quando a palavra não
      // casava. O roteador segue separado, porque não lê roteiro nenhum.
      let alvo: string | null = t.flowPointerDoRoteador;
      let origem: "roteador" | "gatilho" | "etapa" = "roteador";
      if (alvo === null) {
        const porPortaDoMotor = await escolherFluxoDoTurno(deps.pool, {
          organizationId: t.organizationId,
          contactId: t.contactId,
          texto,
        });
        if (porPortaDoMotor !== null) {
          alvo = porPortaDoMotor.id;
          origem = porPortaDoMotor.origem;
        }
      }
      if (alvo !== null) {
        await iniciarFluxoDeAtendimento(deps.pool, {
          organizationId: t.organizationId,
          contactId: t.contactId,
          flowPointerId: alvo,
          conversationId: t.conversationId,
          origem,
        });
        estado = await carregarEstadoDeAtendimento(deps.pool, {
          organizationId: t.organizationId,
          contactId: t.contactId,
        });
        iniciado = estado !== null;
      }
    }
  } catch (err) {
    deps.log.warn('roteiro: não consegui carregar ou começar o roteiro — o turno segue sem ele', {
      error: erroCurto(err),
    });
    return null;
  }
  if (estado === null) return null;
  if (t.messageId === null) return montar(estado, iniciado);

  const atual = estado;
  const mensagensDoLote = lote ?? [{ id: t.messageId, texto }];
  try {
    // Reivindica CADA mensagem do lote ANTES do validador: um retry da fila não
    // paga a chamada de modelo de novo, nem grava ou conta duas vezes; e uma
    // mensagem que outro turno já leu não é lida de novo.
    const novas: MensagemDoLote[] = [];
    for (const m of mensagensDoLote) {
      const primeiraVez = await reivindicarMensagemDoRoteiro(deps.pool, {
        organizationId: t.organizationId,
        enrollmentId: atual.enrollment.id,
        messageId: m.id,
      });
      if (primeiraVez) novas.push(m);
    }
    if (novas.length === 0) return montar(atual, iniciado);
    texto = textoDe(novas);
    // Áudio sem transcrição, figurinha: não há o que ler. Não conta tentativa
    // nem gasta o validador — a pergunta segue de pé para a próxima mensagem.
    if (texto === null) {
      deps.log.info('roteiro: mensagem sem texto legível (mídia) — não conta como resposta nem como tentativa', {
        enrollment_id: atual.enrollment.id,
      });
      return montar(atual, iniciado);
    }
    // Só é "a pergunta atual" a primeira pendente que JÁ FOI FEITA — e nunca no
    // turno que começa o roteiro, quando nada foi perguntado ainda.
    const primeiraPendente = atual.situacao.pendentes[0]?.config.key;
    const perguntaAtual =
      !iniciado && primeiraPendente !== undefined && atual.perguntasFeitas.has(primeiraPendente)
        ? primeiraPendente
        : null;

    const perguntas: PerguntaDoFluxo[] = atual.situacao.pendentes.map((n) => ({
      key: n.config.key,
      label: n.config.label,
      type: n.config.type,
      ...(n.config.options !== undefined ? { options: n.config.options } : {}),
      ...(n.config.question !== undefined ? { question: n.config.question } : {}),
    }));
    // Campos já respondidos que ACEITAM correção ("na verdade o ano é 2020").
    const preenchidos = atual.checklist.passos.flatMap((p) =>
      p.kind === 'collect' && p.node.config.permite_correcao && atual.valores[p.node.config.key] !== undefined
        ? [
            {
              key: p.node.config.key,
              label: p.node.config.label,
              valor: atual.valores[p.node.config.key]!,
              type: p.node.config.type,
              ...(p.node.config.options !== undefined ? { options: p.node.config.options } : {}),
            },
          ]
        : [],
    );

    // Campos ENCERRADOS por não resposta (teto de tentativas) também vão: se a
    // mensagem agora os informa, o valor é gravado mesmo com a pergunta fechada
    // — antes, a resposta tardia era descartada e o dado se perdia (medido pelo
    // autor: CPF informado depois de a pergunta esgotar caiu no vazio).
    const esgotados: PerguntaDoFluxo[] = atual.situacao.esgotadas.map((n) => ({
      key: n.config.key,
      label: n.config.label,
      type: n.config.type,
      ...(n.config.options !== undefined ? { options: n.config.options } : {}),
      ...(n.config.question !== undefined ? { question: n.config.question } : {}),
    }));

    let validacoes: Array<{ campo: string; valor: string }> | undefined;
    if (perguntas.length > 0 || preenchidos.length > 0 || esgotados.length > 0) {
      const leitura = await deps.validar({
        perguntas,
        preenchidos,
        esgotados,
        mensagens: t.mensagens,
        textoAtual: texto,
        perguntaAtual,
      });
      if (leitura.resultado === 'respondeu') validacoes = leitura.respostas;
      // Só chaves e o desfecho — nunca o texto do cliente nem o valor lido.
      deps.log.info('roteiro: leitura do validador', {
        enrollment_id: atual.enrollment.id,
        pendentes: perguntas.map((p) => p.key),
        resultado: leitura.resultado,
        campos: validacoes?.map((v) => v.campo) ?? [],
      });
    }

    // No turno que COMEÇOU o roteiro, a mensagem é o gatilho: só vale o que o
    // validador leu nela ("quero financiar, sou a Lia, CPF…"). A captura
    // determinística gravaria a própria frase de gatilho como resposta — medido
    // ao vivo pelo autor (2fd0a0528, f4c48dfc7).
    const temValidacao = validacoes !== undefined && validacoes.length > 0;
    if (iniciado && !temValidacao) return montar(atual, iniciado);

    const r = await processarInboundDoFluxo(deps.pool, {
      organizationId: t.organizationId,
      estado: atual,
      texto,
      // Já reivindicada acima: o processamento não reivindica de novo.
      messageId: null,
      ...(validacoes !== undefined ? { validacoes } : {}),
    });
    if (!r.concluiu) return montar(r.estado, iniciado);

    // Concluiu. Se o Fim encadeou outro roteiro, é ele que guia o resto do
    // turno (com o resumo deste como contexto); senão, o bloco diz "concluído".
    const seguinte = await carregarEstadoDeAtendimento(deps.pool, {
      organizationId: t.organizationId,
      contactId: t.contactId,
    });
    if (seguinte !== null && seguinte.enrollment.id !== r.estado.enrollment.id) {
      return montar(seguinte, true);
    }
    return montar(r.estado, iniciado, r.finalizacao ?? r.estado.checklist.fim.config.ao_finalizar);
  } catch (err) {
    deps.log.warn('roteiro: não consegui processar a mensagem no roteiro — o turno segue', {
      enrollment_id: atual.enrollment.id,
      error: erroCurto(err),
    });
    return montar(atual, iniciado);
  }
}

/**
 * O turno foi DESCARTADO (guard `resposta_obsoleta`, #1940): o cliente escreveu
 * de novo enquanto o modelo pensava. NADA mais deve sair dele — nem a pergunta
 * do roteiro. O turno da mensagem nova lê a conversa inteira, e a pergunta
 * pendente segue feita para ELE. Sem esta porta, o #1940 dava resposta dupla no
 * caso específico do roteiro: a guarda recusava o envio do modelo, `corposEnviados`
 * ficava vazio e a trava "a pergunta saiu?" mandava ela assim mesmo (#1943).
 */
export function perguntaDoRoteiroPodeSair(args: {
  /** O turno foi descartado como obsoleto — a pergunta NÃO sai. */
  turnoDescartado: boolean;
  /** Mensagens físicas já enviadas neste turno (`seq` do closure). */
  seq: number;
  /** Teto de mensagens físicas por turno (F2-15b). */
  maxSendsPerTurn: number;
}): boolean {
  if (args.turnoDescartado) return false;
  return args.seq < args.maxSendsPerTurn;
}

/**
 * TRAVA "A PERGUNTA SAIU?" (do autor, 5df1917e3): a pergunta pendente é
 * compromisso do roteiro, não sugestão. Se o modelo não a fez em NENHUMA das
 * mensagens do turno, o motor a envia em mensagem própria — pela mesma cadeia
 * de guardrails (`enviar` vem do turno e passa por `runBeforeSend`).
 */
export async function garantirPerguntaDoRoteiro(
  deps: { pool: BancoDoRoteiro; log: Logger },
  t: {
    organizationId: string;
    roteiro: RoteiroDoTurno;
    corposEnviados: readonly string[];
    enviar: (texto: string) => Promise<boolean>;
  },
): Promise<void> {
  const { estado } = t.roteiro;
  const pendente = estado.situacao.pendentes[0];
  if (pendente === undefined) return;
  const cfg = pendente.config;
  const pergunta = textoDaPergunta({
    key: cfg.key,
    label: cfg.label,
    type: cfg.type,
    ...(cfg.options !== undefined ? { options: cfg.options } : {}),
    ...(cfg.question !== undefined ? { question: cfg.question } : {}),
  });
  try {
    let origem: 'modelo' | 'motor' | null = null;
    if (perguntaSaiuNosTextos(pergunta, t.corposEnviados)) origem = 'modelo';
    else if (await t.enviar(pergunta)) origem = 'motor';
    if (origem === null) return;
    await registrarEventoDoRoteiro(deps.pool, {
      organizationId: t.organizationId,
      enrollmentId: estado.enrollment.id,
      tipo: 'roteiro_pergunta_feita',
      nodeId: pendente.id,
      payload: { campo: cfg.key, origem },
    });
  } catch (err) {
    deps.log.warn('roteiro: a trava da pergunta falhou — o turno segue', {
      enrollment_id: estado.enrollment.id,
      error: erroCurto(err),
    });
  }
}
