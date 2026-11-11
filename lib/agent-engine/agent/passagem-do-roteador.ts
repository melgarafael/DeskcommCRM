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
): string {
  if (!passagem) return '';
  const nome = passagem.agenteAnteriorNome?.trim();
  const deQuem = nome !== undefined && nome !== '' ? `o agente "${nome}"` : 'outro agente';
  return [
    TITULO_DO_BLOCO_DE_PASSAGEM,
    'O roteador deste número trocou quem atende esta conversa: até a mensagem anterior quem ' +
      `respondia era ${deQuem}, e agora é você. O cliente ainda NÃO foi avisado da troca.`,
    '',
    '- Apresente-se ao cliente pelo seu nome e diga, em uma frase, que você vai continuar o atendimento.',
    '- Continue do ponto em que a conversa está: NÃO recomece, NÃO repita perguntas que o histórico ' +
      'já responde e não peça de novo dados que o cliente já deu. O que o atendimento anterior ' +
      'combinou com o cliente continua valendo.',
    `- Fale ${IDIOMA_DA_CONVERSA[idioma]} — o idioma desta organização.`,
  ].join('\n');
}
