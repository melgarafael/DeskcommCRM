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
  escolherFluxoPeloGatilho,
  iniciarFluxoDeAtendimento,
  processarInboundDoFluxo,
  registrarEventoDoRoteiro,
  renderBlocoDeAtendimento,
  type BancoDoRoteiro,
  type EstadoDeAtendimento,
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
  preenchidos: readonly { key: string; label: string; valor: string }[];
  mensagens: readonly MensagemDoContexto[];
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
  try {
    estado = await carregarEstadoDeAtendimento(deps.pool, {
      organizationId: t.organizationId,
      contactId: t.contactId,
    });
    if (estado === null) {
      const porGatilho =
        t.flowPointerDoRoteador === null
          ? await escolherFluxoPeloGatilho(deps.pool, { organizationId: t.organizationId, texto: t.texto })
          : null;
      const alvo = t.flowPointerDoRoteador ?? porGatilho?.id ?? null;
      if (alvo !== null) {
        await iniciarFluxoDeAtendimento(deps.pool, {
          organizationId: t.organizationId,
          contactId: t.contactId,
          flowPointerId: alvo,
          conversationId: t.conversationId,
          origem: t.flowPointerDoRoteador !== null ? 'roteador' : 'gatilho',
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
  try {
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
        ? [{ key: p.node.config.key, label: p.node.config.label, valor: atual.valores[p.node.config.key]! }]
        : [],
    );

    let validacoes: Array<{ campo: string; valor: string }> | undefined;
    if ((perguntas.length > 0 || preenchidos.length > 0) && (t.texto ?? '').trim() !== '') {
      const leitura = await deps.validar({ perguntas, preenchidos, mensagens: t.mensagens });
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
      texto: t.texto,
      messageId: t.messageId,
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
