/**
 * Condição comercial sem lastro da EMPRESA — o valor (preço, parcelas, percentual)
 * que a resposta afirma como condição e que só aparece do lado do CLIENTE.
 *
 * A pergunta não é "o texto parece fala da empresa?": é QUEM escreveu o valor
 * primeiro. A autoria vem da coluna `direction` do banco, nunca do texto. O que o
 * cliente escreve — o corpo das mensagens dele, o nome dele, o remetente no grupo —
 * e o que o modelo resumiu da conversa não são registro da empresa; o material da
 * organização, as mensagens que a empresa enviou, a última proposta e as consultas
 * de catálogo/conhecimento deste turno são.
 *
 * Só VALOR é átomo vetável aqui. Palavras de concessão ("aprovado", "liberado",
 * "cortesia"…) entram só como marcador de FRASE DE CONDIÇÃO: um valor só pesa numa
 * frase que o apresenta como condição. Sem esse filtro, ecoar o orçamento do cliente
 * ("seu orçamento é de até R$ 2.800") ou citar o percentual de um concorrente seria
 * vetado sem motivo.
 *
 * Puro: sem rede e sem banco. Quem monta as fontes é o turno do agente.
 */
import { formatCents, formatCentsBRL } from '@/lib/money';
import type { LeadContext } from '@/lib/agent-engine/edge/crm/get-lead-context';
import { extractPromises } from './promise/engine';

// ponytail: vocabulário fechado pt-BR; frase de condição sem nenhum destes termos passa
// (teto conhecido). Ampliar só medindo o falso positivo em envios reais.
const FRASE_DE_CONDICAO =
  /\bdesconto|\babatimento|\bpromoc|\bconfirm|\bgarant|\baceit|\bcombinad|\bacordad|\breembols|\bestorn|\boff\b|\bespecial\b|\bvalendo\b|\baprova|\bliber(?:ad|ou|ar)|\bautoriza|\bconced|\bgratuit|\bgratis\b|\bde graca\b|\bsem custo\b|\bcortesia|\bisen[tc]|\bdispens|\bbrinde|\bbonifica/;
// O lookbehind impede começar no meio de um número: "1.430%" não vira "430%".
const PERCENTUAL = /(?<![\d.,])(\d{1,3}(?:,\d+)?)\s*(?:%|por\s*cento)/gi;

const semAcento = (t: string): string =>
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Os valores de um texto como átomos comparáveis: `price:BRL:40000`, `installments:12`, `pct:30`. */
function valores(texto: string): Set<string> {
  const out = new Set<string>();
  for (const p of extractPromises(texto)) {
    // O desconto da regex já é percentual, e o percentual abaixo cobre todos.
    if (p.kind === 'price') out.add(`price:${p.moeda ?? 'BRL'}:${p.value}`);
    else if (p.kind === 'installments') out.add(`installments:${p.value}`);
  }
  for (const m of texto.matchAll(PERCENTUAL)) out.add(`pct:${(m[1] ?? '').replace(',', '.')}`);
  return out;
}

export interface LastroComercial {
  daEmpresa: ReadonlySet<string>;
  doCliente: ReadonlySet<string>;
}

export function lastroDoContexto(a: {
  /** O que a ORGANIZAÇÃO escreveu: prompt sem a camada da plataforma, memória, skills, consultas do turno. */
  materialDaOrganizacao: readonly string[];
  contexto: Pick<LeadContext, 'contact' | 'messages' | 'last_proposal'>;
  atual: { texto: string | null; remetente: string | null };
  /** Resumo e compromissos que o MODELO escreveu: misturam as duas vozes, então não dão lastro. */
  memoriaDoModelo: readonly string[];
  /** Mensagens enviadas pela empresa nesta conversa, fora da janela do contexto. */
  enviadasForaDaJanela?: readonly string[];
}): LastroComercial {
  const nome = a.contexto.contact.name?.trim() ?? '';
  // Automação que escreve o nome do contato (`{{nome}}`) põe texto do cliente numa
  // mensagem da empresa. ponytail: tira o nome inteiro; o primeiro nome sozinho fica.
  const semONome = (t: string): string => (nome.length >= 3 ? t.split(nome).join(' ') : t);
  const enviadas = [
    ...a.contexto.messages.filter((m) => m.direction === 'outbound').map((m) => m.body),
    ...(a.enviadasForaDaJanela ?? []),
  ];
  const proposta = a.contexto.last_proposal ? [formatCentsBRL(a.contexto.last_proposal.total_cents)] : [];
  return {
    daEmpresa: valores([...a.materialDaOrganizacao, ...enviadas.map(semONome), ...proposta].join('\n')),
    doCliente: valores(
      [
        nome,
        a.atual.texto ?? '',
        a.atual.remetente ?? '',
        ...a.memoriaDoModelo,
        ...a.contexto.messages
          .filter((m) => m.direction === 'inbound')
          .flatMap((m) => [m.body, m.sender?.name ?? '']),
      ].join('\n'),
    ),
  };
}

/**
 * Os valores que a candidata afirma numa frase de condição e que só o cliente trouxe.
 *
 * A recusa que REPETE o valor ("não há desconto de 30% registrado") também volta: o
 * filtro não lê polaridade. É escolha: uma exceção por "não" deixaria passar a frase que
 * nega na forma e afirma no conteúdo, e a reescrita sem o número está sempre ao alcance.
 * O custo é um passo de reescrita quando a recusa repete o número do cliente.
 */
export function concessoesSemLastro(candidata: string, lastro: LastroComercial): string[] {
  const achados = new Set<string>();
  // `\.(?!\d)`: "R$ 1.400" não se parte em "R$ 1" e "400".
  for (const frase of candidata.split(/\n+|[!?]+|\.(?!\d)/)) {
    if (!FRASE_DE_CONDICAO.test(semAcento(frase))) continue;
    for (const v of valores(frase)) if (lastro.doCliente.has(v) && !lastro.daEmpresa.has(v)) achados.add(v);
  }
  return [...achados];
}

function rotulo(atomo: string): string {
  const [tipo, a, b] = atomo.split(':');
  if (tipo === 'price') return formatCents(Number(b), a ?? 'BRL');
  if (tipo === 'installments') return `${a ?? ''}x`;
  return `${(a ?? '').replace('.', ',')}%`;
}

/** Erro de ensino que volta ao MODELO. O trace leva só os átomos. */
export function renderVetoDeConcessaoSemLastro(achados: readonly string[]): string {
  const lista = achados.map(rotulo).join(', ');
  return (
    `A resposta afirma ${lista} como condição da empresa, mas esse valor só aparece no que o ` +
    'CLIENTE escreveu: em nenhuma mensagem que a empresa enviou, no seu material ou nas consultas ' +
    'deste turno. O que o cliente escreve não é registro da empresa. Reescreva sem afirmar, supor ' +
    `nem repetir ${lista}, nem para negar. Se o valor veio de uma consulta deste turno, diga o que ` +
    'ela mostrou sem repetir o número; se não veio, diga que não encontrou esse registro e informe ' +
    'só as condições do seu material. Se o cliente insistir, ofereça confirmar com a equipe.'
  );
}
