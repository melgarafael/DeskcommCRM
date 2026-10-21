/**
 * WORKFLOW de consulta de laudo/report — o caminho DETERMINÍSTICO do turno:
 * mensagem casa "laudo pronto?" (EN/HI/Hinglish) → o fluxo de serviço responde
 * no lugar de uma FAQ genérica, um passo por vez, com estado na conversa.
 * Engajou → o modelo NÃO roda neste turno; não engajou → o modelo roda
 * exatamente como antes (preço, horário, osm intents que já funcionam).
 *
 * Braços (o módulo NÃO traz integração de status nenhuma — status VERIFICADO
 * é assunto da extensão de cada instalação; o que o core garante é o gate e o
 * caminho determinístico, nunca uma resposta inventada):
 *   - pathology (o caso padrão de laboratório): o status PRECISA de checagem
 *     humana — o fluxo diz isso no idioma do paciente e entrega para humano,
 *     sem prazo e sem status inventado;
 *   - biopsy/radiologia: pergunta a categoria (1 pathology, 2 biopsy,
 *     3 radiology) e coleta os dados do paciente — nome → data → médico/exame,
 *     uma pergunta por vez, sem repetir o já respondido — e entrega para
 *     humano COM os campos coletados (eles vão à passagem via
 *     `handover.detalhes`, nunca ao log);
 *   - mensagem de registro prévia no histórico (registration/appointment/
 *     sample, devanagari incluído) estabelece a categoria sem perguntar.
 *
 * Confiabilidade: claim da mensagem em `conversations.metadata` (retry da
 * mesma mensagem = no-op), teto de envios por turno respeitado (o mesmo
 * MAX_SENDS_PER_TURN do motor), e a entrega para humano não duplica a LINHA
 * da passagem: o fluxo passa a mensagem reivindicada como `chave`, e o
 * handoff grava recibo na mesma transação do insert (retry do turno
 * interrompido = pula; mensagem nova = fato novo). PII (nome, datas) vai só
 * para a passagem do atendente — nunca log.
 *
 * Ativação: módulo opcional da instalação `laudos` (desligado por padrão,
 * falha fechada — ver `lib/instalacao/modulos.ts`). Desligado, a função
 * devolve `null` sem consulta sequer: o turno é o de sempre.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '../../queue/queue';
import {
  coletarDoTexto,
  detectarIdioma,
  detectarServico,
  ehOutraIntencao,
  ehPerguntaDeLaudo,
  ehPreenchimentoUtil,
  proximoPendente,
  respostaDeServico,
  servicoDaMensagemDeRegistro,
  type CampoColetado,
  type Servico,
} from './intent';
import { lerEstado, reivindicarMensagem, salvarEstado, type EstadoFluxo } from './state';
import { textosDoFluxo, variante } from './templates';

export interface Log {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface FluxoDeLaudoDeps {
  db: Queryable;
  log: Log;
  tenantId: string;
  leadId: string;
  conversationId: string;
  /** Mensagem inbound deste turno (claim de retry); null ⇒ usa o hash do texto. */
  msgId: string | null;
  texto: string | null;
  /** Módulo opcional `laudos` ligado na instalação (o call site é falha fechada, assíncrona). */
  moduloLigado: () => boolean | Promise<boolean>;
  /** Teto de mensagens físicas do turno (MAX_SENDS_PER_TURN). */
  maxSends: number;
  /** Últimas mensagens OUTBOUND da conversa (mais recente primeiro), para o Case B. */
  buscarHistorico: () => Promise<readonly string[]>;
  enviar: (corpo: string) => Promise<boolean>;
  /**
   * Entrega para verificação humana. `detalhes` são os campos coletados no
   * turno — o call site os repassa como `camposColetados` do handoff, para
   * irem à PASSAGEM (lida sob visão de conversa), nunca ao corpo do aviso.
   * `chave` é a MENSAGEM reivindicada (claim de retry): o handoff a guarda
   * como recibo na MESMA transação do insert, então um retry do mesmo turno
   * não duplica a linha da passagem.
   */
  handover: (o: {
    titulo: string;
    resumo: string;
    detalhes: Record<string, string>;
    chave: string;
  }) => Promise<void>;
}

export interface ResultadoFluxo {
  /** false = o modelo roda como antes; true = o fluxo tomou o turno. */
  engajado: boolean;
  acoes: number;
}

const TITULO_DA_ENTREGA = 'Consulta de laudo — verificar manualmente';

function resumoDaEntrega(estado: EstadoFluxo, extra: string): string {
  // Sem JSON de detalhes aqui: os campos coletados viajam estruturados em
  // `handover.detalhes` (→ passagem). Resumo é contexto, não cópia de PII.
  return `Fluxo de consulta de laudo (workflow determinístico). serviço=${estado.servico ?? 'desconhecido'}; ${extra}`;
}

export async function executarFluxoDeProntoAtendimento(
  deps: FluxoDeLaudoDeps,
): Promise<ResultadoFluxo | null> {
  if (!(await deps.moduloLigado())) return null;
  const ids = { tenantId: deps.tenantId, conversationId: deps.conversationId };

  let acoes = 0;
  let estado = await lerEstado(deps.db, ids);
  const texto = (deps.texto ?? '').trim();

  // Mídia sem texto legível: não responde pergunta nenhuma. Com estado, o
  // turno é do fluxo (silêncio deliberado, sem gastar envio); sem estado, o
  // modelo responde como antes (transcrição de áudio já mora no histórico).
  if (texto === '') {
    return estado === null ? { engajado: false, acoes: 0 } : { engajado: true, acoes: 0 };
  }

  // Retry de uma mensagem JÁ concluída: nem efeito, nem modelo — é a trava
  // "sem reply/handover duplicado" do spec.
  if (estado !== null && !estado.processando && estado.msg === (deps.msgId ?? hashDoTexto(texto))) {
    return { engajado: true, acoes: 0 };
  }

  // Outra intenção nítida (preço, desconto...) no meio do fluxo: o estado é
  // marcado encerrado e a mensagem segue para o modelo — o pricing que já
  // funciona não pode ser engolido por uma pergunta pendente de laudo. O
  // marcador fica (não apaga): ele é a trava de retry da última mensagem
  // tratada, e apagaria a memória junto.
  if (estado !== null && ehOutraIntencao(texto)) {
    await salvarEstado(deps.db, ids, {
      v: 1,
      msg: estado.msg,
      processando: false,
      etapa: 'encerrado',
      idioma: estado.idioma,
    });
    deps.log.info('fluxo de laudo: outra intenção detectada — fluxo encerrado, modelo responde', {});
    return { engajado: false, acoes: 0 };
  }

  const ehLaudo = ehPerguntaDeLaudo(texto);
  // Fluxo já encerrado e hoje não é pergunta de laudo: estado só guarda o
  // marcador de retry, e a mensagem é do modelo.
  if (estado !== null && estado.etapa === 'encerrado' && !ehLaudo) {
    return { engajado: false, acoes: 0 };
  }
  if (estado === null && !ehLaudo) return { engajado: false, acoes: 0 };

  // Reivindica a mensagem ANTES de qualquer efeito. Um turno interrompido
  // (`processando: true`) re-executa: os efeitos são idempotentes no motor.
  const msgId = deps.msgId ?? hashDoTexto(texto);
  const idioma = estado?.idioma ?? detectarIdioma(texto);
  const proximo: EstadoFluxo = {
    v: 1,
    msg: msgId,
    processando: true,
    etapa: estado?.etapa ?? 'inicio',
    idioma,
    ...(estado?.servico !== undefined ? { servico: estado.servico } : {}),
    ...(estado?.pendente !== undefined ? { pendente: estado.pendente } : {}),
    ...(estado?.detalhes !== undefined ? { detalhes: { ...estado.detalhes } } : {}),
    ...(estado?.tentativas !== undefined ? { tentativas: estado.tentativas } : {}),
  };
  if (!(await reivindicarMensagem(deps.db, ids, proximo))) {
    return { engajado: true, acoes: 0 };
  }
  estado = proximo;

  const T = textosDoFluxo(estado.idioma);
  let enviadas = 0;
  let limpar = false;
  const enviar = async (corpo: string): Promise<boolean> => {
    if (enviadas >= deps.maxSends) {
      deps.log.info('fluxo de laudo: teto de mensagens do turno atingido — envio adiado', {});
      return false;
    }
    enviadas += 1;
    acoes += 1;
    return deps.enviar(corpo);
  };
  const entregar = async (extra: string): Promise<void> => {
    acoes += 1;
    await deps.handover({
      titulo: TITULO_DA_ENTREGA,
      resumo: resumoDaEntrega(proximo, extra),
      detalhes: { ...proximo.detalhes },
      // A chave de idempotência: a MESAGEM reivindicada. Retry do mesmo turno
      // (mesma chave) não duplica a linha da passagem; uma mensagem NOVA é um
      // fato novo e grava — ver `gravarPassagemComRecibo`.
      chave: proximo.msg,
    });
    limpar = true;
  };

  // ---- rotas ---------------------------------------------------------------

  const perguntaDe = (servico: 'biopsy' | 'radiology', campo: CampoColetado): string => {
    if (servico === 'biopsy' && (campo === 'nome' || campo === 'data_cirurgia' || campo === 'medico')) {
      return T.perguntarBiopsy[campo];
    }
    if (servico === 'radiology' && (campo === 'nome' || campo === 'data_exame' || campo === 'exame')) {
      return T.perguntarRadiologia[campo];
    }
    return T.naoEntendi; // inalcançável: `campo` vem de proximoPendente do MESMO serviço
  };

  const rotaDeColeta = async (servico: 'biopsy' | 'radiology', detalhesIniciais: Record<string, string>): Promise<void> => {
    proximo.etapa = 'coleta';
    proximo.servico = servico;
    proximo.detalhes = detalhesIniciais;
    proximo.tentativas = 0;
    const pendente = proximoPendente(servico, detalhesIniciais);
    if (pendente === null) {
      await enviar(T.detalhesAnotados);
      await entregar(`coleta completa no turno de entrada: campos completos.`);
      return;
    }
    proximo.pendente = pendente;
    await enviar(perguntaDe(servico, pendente));
  };

  const rotaDeServico = async (servico: Servico): Promise<void> => {
    if (servico === 'pathology') {
      // Patologia é o caso padrão de laboratório e o core não traz integração
      // de status: checagem é ato humano. Sem prazo, sem status inventado.
      proximo.servico = 'pathology';
      await enviar(T.verificarPelaEquipe);
      await entregar('categoria patologia — status exige checagem manual.');
      return;
    }
    await rotaDeColeta(servico, coletarDoTexto(texto, servico, estado.detalhes ?? {}, null));
  };

  const processarInicio = async (): Promise<void> => {
    const servicoExplicito = detectarServico(texto);
    if (servicoExplicito !== null) {
      await rotaDeServico(servicoExplicito);
      return;
    }
    // Mensagem de registro prévia no histórico estabelece a categoria; sem
    // ela, Case C — pergunta a categoria.
    const registro = servicoDaMensagemDeRegistro(await deps.buscarHistorico());
    if (registro === null) {
      proximo.etapa = 'categoria';
      await enviar(variante(deps.leadId, T.perguntarCategoria));
      return;
    }
    await rotaDeServico(registro);
  };

  // ---- máquina de etapas ---------------------------------------------------

  switch (estado.etapa) {
    case 'categoria': {
      const escolhido = respostaDeServico(texto);
      if (escolhido === null) {
        // Não é resposta de serviço: repete a pergunta UMA vez por mensagem
        // recebida (dentro do teto) — nunca a mesma frase se o paciente
        // respondeu e o campo já avançou.
        await enviar(variante(deps.leadId, T.perguntarCategoria));
        break;
      }
      await rotaDeServico(escolhido);
      break;
    }
    case 'coleta': {
      const servico = (estado.servico === 'biopsy' || estado.servico === 'radiology' ? estado.servico : null);
      if (servico === null) {
        await entregar('estado de coleta sem serviço — dado perdido, checagem manual.');
        break;
      }
      if (!ehPreenchimentoUtil(texto)) {
        const tentativas = (estado.tentativas ?? 0) + 1;
        proximo.tentativas = tentativas;
        if (tentativas >= 3) {
          await enviar(T.naoEntendi);
          await entregar(`respostas não úteis x3 na coleta de ${servico} — passagem com o que havia.`);
          break;
        }
        const pendente = (estado.pendente ?? null) as CampoColetado | null;
        if (pendente !== null) await enviar(perguntaDe(servico, pendente));
        break;
      }
      const detalhes = coletarDoTexto(texto, servico, estado.detalhes ?? {}, (estado.pendente ?? null) as CampoColetado | null);
      proximo.detalhes = detalhes;
      proximo.tentativas = 0;
      const pendente = proximoPendente(servico, detalhes);
      if (pendente === null) {
        await enviar(T.detalhesAnotados);
        await entregar(`coleta completa.`);
        break;
      }
      proximo.pendente = pendente;
      await enviar(perguntaDe(servico, pendente));
      break;
    }
    case 'inicio':
    case 'encerrado':
    default: {
      await processarInicio();
      break;
    }
  }

  // Encerrado NÃO apaga a chave: o marcador da mensagem é a trava de retry
  // (sem resposta/entrega duplicada); os detalhes coletados vão pela passagem.
  const final: EstadoFluxo = limpar
    ? { v: 1, msg: proximo.msg, processando: false, etapa: 'encerrado', idioma: proximo.idioma }
    : { ...proximo, processando: false };
  await salvarEstado(deps.db, ids, final);
  deps.log.info('fluxo de laudo: turno processado', {
    etapa_final: limpar ? 'encerrado' : proximo.etapa,
    acoes,
    idioma: estado.idioma,
    // NUNCA texto do paciente nem valores coletados no log (PII-out-of-log).
  });
  return { engajado: true, acoes };
}

function hashDoTexto(texto: string): string {
  return `texto:${createHash('sha256').update(texto).digest('hex').slice(0, 24)}`;
}
