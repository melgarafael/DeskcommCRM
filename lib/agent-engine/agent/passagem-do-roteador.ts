/**
 * A PASSAGEM AUTOMÁTICA DO ROTEADOR, DITA AO AGENTE QUE RECEBE A CONVERSA (#4363).
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * Com roteador sticky, a troca de agente acontece SOZINHA: o cliente responde
 * algo da intenção do membro 2 e a próxima mensagem já é atendida por ele
 * (`reclassified` em `resolve-turn-agent.ts`). O agente 1 nunca fica sabendo, o
 * cliente não é avisado da troca — e o agente 2 responde como se a conversa
 * tivesse começado ali, ou pior, como se ele fosse o agente 1: repete perguntas
 * que o histórico já respondeu e ignora o que o outro combinou. O membro tentou
 * escrever a regra no prompt do agente 1; ela nunca era usada, porque o turno já
 * ia para o outro agente.
 *
 * ─── Por que TEXTO NO CONTEXTO, e não um campo por membro ───────────────────
 *
 * A alternativa (um campo configurável por membro do roteador, com a mensagem de
 * transição escrita pelo cliente) exige coluna nova e migration — decisão de
 * schema que não é desta frente. Aqui o aviso é DERIVADO do fato que o turno já
 * conhece (houve `reclassified`, e de qual agente veio): nenhum schema novo, e o
 * agente que recebe sabe que herdou a conversa para se apresentar e continuar.
 *
 * ─── Onde ele entra, e por quê ──────────────────────────────────────────────
 *
 * No PRIMEIRO bloco do ritual de abertura (sufixo por-lead, depois do prefixo
 * cacheável): vale só no turno da troca — nos seguintes o desfecho é `sticky` e
 * o bloco é '' —, então não custa token em conversa nenhuma que não trocou de
 * agente. Não é a passagem EXPLÍCITA (`transferir-agente.ts`, #3823): lá o
 * agente decide passar e avisa o cliente na mesma resposta; aqui quem troca é o
 * classificador, e o aviso ao cliente é a primeira fala do agente novo.
 *
 * O idioma é o da ORGANIZAÇÃO (`organizations.locale`, a mesma régua do rodapé
 * de saída e do agente da campanha): o prompt é escrito em português, mas a
 * língua que a instrução manda o modelo falar é a da empresa.
 */
import type pg from 'pg';

import { normalizarIdioma, type Idioma } from '@/lib/i18n/idiomas';
import { IDIOMA_DA_CONVERSA } from '@/lib/prospecting/idioma';

/**
 * A troca que o turno resolveu: de qual agente a conversa veio. `null` no nome
 * quando a versão publicada do agente anterior não pôde ser lida — o aviso
 * continua valendo, só não inventa um nome que não se conhece.
 */
export interface PassagemRecebida {
  agenteAnteriorId: string;
  agenteAnteriorNome: string | null;
}

/**
 * O idioma da organização para o aviso da passagem. Lido SÓ quando houve troca —
 * conversa que não trocou de agente não paga a consulta. Falha de leitura não
 * derruba o turno: cai no padrão (português), como a régua de locale do produto.
 */
export async function idiomaDaOrganizacaoDoTurno(
  db: Pick<pg.Pool, 'query'>,
  tenantId: string,
  log: { warn: (msg: string, fields?: Record<string, unknown>) => void },
): Promise<Idioma> {
  try {
    const { rows } = await db.query<{ locale: string | null }>(
      'select locale from organizations where id=$1',
      [tenantId],
    );
    return normalizarIdioma(rows[0]?.locale ?? null);
  } catch (err) {
    log.warn('passagem do roteador: locale da organização não lido — aviso sai em português', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return normalizarIdioma(null);
  }
}

/** O cabeçalho do bloco — a régua dos testes e do turno, num lugar só. */
export const TITULO_DO_BLOCO_DE_PASSAGEM =
  '## Passagem de atendimento — esta conversa ACABOU de chegar para você';

/**
 * O bloco, ou '' quando NÃO houve troca (o controle positivo contra vacuidade:
 * sticky, classificação inicial e fallback não anunciam passagem nenhuma).
 *
 * Puro de propósito: o texto que o modelo lê é medido sem banco, e o turno só
 * decide QUANDO chamar.
 */
export function montarBlocoDePassagemDoRoteador(
  passagem: PassagemRecebida | null | undefined,
  idioma: Idioma = 'pt-BR',
  clienteAvisado = false,
): string {
  if (!passagem) return '';
  const nome = passagem.agenteAnteriorNome?.trim();
  const deQuem = nome !== undefined && nome !== '' ? `o agente "${nome}"` : 'outro agente';
  // #4363 — a OUTRA metade: quando o roteador tem frase de passagem ligada, o
  // cliente JÁ recebeu a mensagem antes deste turno (o turno a envia antes de
  // chamar o modelo). Dizer "ainda NÃO foi avisado" ali faria o agente novo se
  // apresentar DE NOVO, e o cliente leria duas passagens na mesma troca.
  const situacaoDoCliente = clienteAvisado
    ? 'O cliente JÁ foi avisado da troca por uma mensagem automática deste número.'
    : 'O cliente ainda NÃO foi avisado da troca.';
  const primeiraInstrucao = clienteAvisado
    ? '- NÃO se apresente de novo nem repita o aviso da troca: o cliente já o recebeu. Retome o ' +
      'atendimento dizendo em que ponto vocês estão.'
    : '- Apresente-se ao cliente pelo seu nome e diga, em uma frase, que você vai continuar o atendimento.';
  return [
    TITULO_DO_BLOCO_DE_PASSAGEM,
    'O roteador deste número trocou quem atende esta conversa: até a mensagem anterior quem ' +
      `respondia era ${deQuem}, e agora é você. ${situacaoDoCliente}`,
    '',
    primeiraInstrucao,
    '- Continue do ponto em que a conversa está: NÃO recomece, NÃO repita perguntas que o histórico ' +
      'já responde e não peça de novo dados que o cliente já deu. O que o atendimento anterior ' +
      'combinou com o cliente continua valendo.',
    `- Fale ${IDIOMA_DA_CONVERSA[idioma]} — o idioma desta organização.`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// A OUTRA METADE (#4363): a mensagem que o CLIENTE lê na troca automática
// ─────────────────────────────────────────────────────────────────────────────
//
// O bloco acima avisa o AGENTE. Sem esta parte, o cliente só sabe da troca se o
// agente novo resolver se apresentar — e a apresentação é do modelo, não da
// empresa. A frase abaixo é do DONO DO ROTEADOR (`ai_routers.passagem_ao_cliente`,
// migration 9367): uma frase por roteador, no idioma da organização, enviada UMA
// vez quando o classificador troca quem atende.
//
// ─── Quando NÃO se manda nada ──────────────────────────────────────────────
//
//   * a frase está desligada (`null`, `''` ou só espaço): o comportamento é o
//     de antes, e o agente novo se apresenta — é o padrão do produto;
//   * o desfecho do turno não é `reclassified`: `sticky` (o mesmo agente segue),
//     `classified` (a conversa nasceu agora, não houve troca) e as quedas para
//     reserva não são troca de agente, e anunciar "passagem" para quem sempre
//     atendeu seria mentira;
//   * o responsável não mudou (id igual, ou não havia agente antes — conversa
//     nova não é passagem);
//   * a passagem foi EXPLÍCITA (`transferir-agente.ts`, #3823): ali quem avisa é
//     o próprio agente, na mesma resposta, com o texto dele — e o turno seguinte
//     chega com desfecho `sticky`, então esta régua nem chega a olhar a frase.
//
// ─── Uma vez só ────────────────────────────────────────────────────────────
//
// O turno chama isto UMA vez, no ponto em que o desfecho é conhecido, antes de
// chamar o modelo. Não há reenvio em retry do job: o ledger de envio
// (`send_ledger`, `unique (job_id, seq)`) deduplica o MESMO seq do turno, e este
// aviso usa `SEQ_DA_PASSAGEM_AO_CLIENTE`, que não colide com as falas do modelo
// (1..n) nem com o aviso de escalação (0).

/** O `seq` deste aviso no ledger do job — ver o cabeçalho, e `SEQ_DO_AVISO`. */
export const SEQ_DA_PASSAGEM_AO_CLIENTE = -1;

/** O que a cadeia de envio devolveu, no vocabulário do `send_ledger`. */
export type DesfechoDoEnvioDaPassagem =
  | 'sent'
  | 'already_sent'
  | 'queued'
  | 'blocked'
  | 'failed'
  | 'unavailable';

/**
 * A troca que o turno resolveu, do ponto de vista de quem decide o aviso. Nada
 * de `TurnAgentResolution` aqui: o módulo continua puro, e o teste mede a régua
 * sem banco e sem LLM.
 */
export interface TrocaQuePedeAviso {
  /** O desfecho do roteamento neste turno (`reclassified` é o único que avisa). */
  outcome: string;
  /** `ai_routers.passagem_ao_cliente` — `null`/`''` = desligado. */
  textoConfigurado: string | null | undefined;
  /** O sticky que a conversa tinha antes do turno. */
  agenteAnteriorId: string | null | undefined;
  /** O agente que atende a partir deste turno. */
  agenteNovoId: string | null | undefined;
}

export type DesfechoDaPassagemAoCliente =
  | { enviado: true; desfecho: 'sent' | 'already_sent' }
  | {
      enviado: false;
      motivo:
        | 'nao_e_troca'
        | 'sem_texto'
        | 'mesmo_agente'
        | 'na_fila'
        | 'contato_bloqueado'
        | 'canal_falhou'
        | 'canal_indisponivel';
    };

/**
 * A frase a enviar — ou `null` quando NÃO há o que enviar. PURA de propósito:
 * é a régua inteira num lugar só, e o controle positivo contra vacuidade (todo
 * caso que não é troca devolve `null`, medido no teste).
 */
export function textoDaPassagemAoCliente(troca: TrocaQuePedeAviso): string | null {
  if (troca.outcome !== 'reclassified') return null;
  const texto = troca.textoConfigurado?.trim() ?? '';
  if (texto === '') return null;
  const anterior = troca.agenteAnteriorId ?? null;
  const novo = troca.agenteNovoId ?? null;
  if (anterior === null || novo === null || anterior === novo) return null;
  return texto;
}

/**
 * Envia a frase ao cliente — no máximo UMA vez, e nunca lança: a troca já
 * aconteceu no roteamento, e um erro de canal não pode derrubar o turno (o
 * cliente sem a frase é ruim; sem resposta nenhuma é pior).
 *
 * `enviar` é a cadeia de envio já montada pelo turno (`runBeforeSend` +
 * `channel.send`), injetada para que esta régua seja medida sem banco.
 */
export async function avisarClienteDaTrocaDeAgente(
  deps: {
    enviar: (texto: string) => Promise<DesfechoDoEnvioDaPassagem>;
    log: {
      info: (msg: string, fields?: Record<string, unknown>) => void;
      warn: (msg: string, fields?: Record<string, unknown>) => void;
    };
  },
  troca: TrocaQuePedeAviso,
): Promise<DesfechoDaPassagemAoCliente> {
  if (troca.outcome !== 'reclassified') return { enviado: false, motivo: 'nao_e_troca' };
  const texto = textoDaPassagemAoCliente(troca);
  if (texto === null) {
    const motivo =
      (troca.textoConfigurado?.trim() ?? '') === '' ? 'sem_texto' : 'mesmo_agente';
    return { enviado: false, motivo };
  }

  try {
    const desfecho = await deps.enviar(texto);
    switch (desfecho) {
      case 'sent':
      case 'already_sent':
        deps.log.info('passagem do roteador: cliente avisado da troca de agente', {
          desfecho,
          agente_anterior_id: troca.agenteAnteriorId ?? null,
          agente_novo_id: troca.agenteNovoId ?? null,
        });
        return { enviado: true, desfecho };
      case 'queued':
        // Custódia do CRM, não entrega: a conversa abre igual, e quem atende
        // precisa saber que o cliente talvez não tenha lido nada.
        deps.log.warn('passagem do roteador: aviso ao cliente ficou na fila', { desfecho });
        return { enviado: false, motivo: 'na_fila' };
      case 'blocked':
        return { enviado: false, motivo: 'contato_bloqueado' };
      case 'failed':
        return { enviado: false, motivo: 'canal_falhou' };
      case 'unavailable':
        return { enviado: false, motivo: 'canal_indisponivel' };
    }
  } catch (err) {
    deps.log.warn('passagem do roteador: aviso ao cliente falhou — o turno segue', {
      error: err instanceof Error ? err.message.slice(0, 200) : 'erro desconhecido',
    });
    return { enviado: false, motivo: 'canal_falhou' };
  }
}
