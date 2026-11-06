/**
 * Condição comercial sem lastro da EMPRESA — o valor (preço, parcelas, percentual)
 * que a resposta afirma como condição e que só aparece do lado do CLIENTE.
 *
 * A pergunta não é "o texto parece fala da empresa?": é QUEM escreveu o valor
 * primeiro. A autoria vem da coluna `direction` do banco, nunca do texto, e a ordem
 * vem do `sent_at`: a mensagem da empresa só dá lastro ao valor que ela escreveu ANTES
 * de o cliente trazê-lo. O que o cliente escreve — o corpo das mensagens dele, o nome
 * dele, o remetente no grupo — e o que o modelo resumiu da conversa não são registro
 * da empresa; o material da organização, a tabela de promessa, a última proposta e as
 * consultas de catálogo/conhecimento/pedidos deste turno são, em qualquer ordem.
 *
 * Dois tipos de átomo vetável, com a mesma regra: o VALOR e o TERMO DE CONCESSÃO
 * ("aprovado", "liberado", "cortesia"…). O termo também marca a FRASE DE CONDIÇÃO: um
 * valor só pesa numa frase que o apresenta como condição.
 *
 * Puro: sem rede e sem banco. Quem monta as fontes é o turno do agente.
 */
import { formatCents, parseReaisToCents } from '@/lib/money';
import type { LeadContext } from '@/lib/agent-engine/edge/crm/get-lead-context';
import { extractPromises } from './promise/engine';
import type { PromiseTable } from './promise/table';

/**
 * Termos de concessão, sobre o texto sem acento e minúsculo: `termo:<nome>`, com o rótulo
 * que o ensino mostra. Raiz, não palavra: "aprovou" e "liberamos" contam; "aproveite",
 * "liberdade", "liberal", "Liberato" e "concessionária", não.
 */
// ponytail: o termo vale para a conversa inteira, sem objeto nem condição: "frete grátis
// só acima de R$ 299" no material dá lastro a qualquer gratuidade que o cliente alegar.
// Evolução: átomo termo+objeto (o substantivo vizinho). Custo aceito do outro lado: o termo
// que não é concessão também conta ("assistência autorizada", "armário de dispensa",
// "parabéns pela aprovação") — numa frase da candidata, custa uma reescrita.
const TERMOS: ReadonlyArray<readonly [nome: string, rotulo: string, re: RegExp]> = [
  ['aprovacao', 'aprovação', /\baprov(?!eit)/],
  ['liberacao', 'liberação', /\bliber(?:a(?![tl]|is\b)|o|e)/],
  ['autorizacao', 'autorização', /\bautoriz/],
  ['concessao', 'concessão', /\bconce(?:d|ss(?!ionari))/],
  ['gratuidade', 'gratuidade', /\bgratuit|\bgratis\b|\bde graca\b|\bsem custos?\b/],
  ['cortesia', 'cortesia', /\bcortesia/],
  ['isencao', 'isenção', /\bisen[tc]/],
  ['dispensa', 'dispensa', /\bdispens/],
  ['brinde', 'brinde', /\bbrinde|\bbonifica/],
];
// ponytail: vocabulário fechado pt-BR; frase de condição sem nenhum destes termos passa
// (teto conhecido). Ampliar só medindo o falso positivo em envios reais. "garantia" (do
// produto) fica de fora; "garanto"/"garantido" entram.
const FRASE_DE_CONDICAO = new RegExp(
  [
    String.raw`\bdesconto|\babatimento|\bpromoc|\bconfirm|\bgarant(?!ias?\b)|\baceit|\bcombinad|\bacordad`,
    String.raw`\breembols|\bestorn|\boff\b|\bespecial\b|\bvalendo\b`,
    ...TERMOS.map(([, , re]) => re.source),
  ].join('|'),
);
// O lookbehind impede começar no meio de um número: "1.430%" não vira "430%".
// ponytail: todo percentual conta, inclusive o que não é condição ("100% algodão"): numa
// frase com marcador, custa uma reescrita.
const PERCENTUAL = /(?<![\d.,])(\d{1,3}(?:,\d+)?)\s*(?:%|por\s*cento)/gi;
// Só do lado da EMPRESA (só pode errar para PASSAR): o dono escreve "R$ 49.90", "R$ 5 mil"
// ou uma tabela sem "R$" ("Limpeza;220,00"), que a leitura estrita lê errado ou não lê.
const PRECO_SOLTO = /(R\$|€)\s*(\d[\d.,]*\d|\d)(\s*(?:mil|k)\b)?/gi;
const DECIMAL_SEM_MOEDA = /(?<![\d.,])\d{1,3}(?:\.\d{3})*,\d{2}(?![\d,])/g;

// A pessoa da equipe concede com verbo de venda ("consigo 10%", "fazemos em 12x"), não só
// com o vocabulário da frase de condição.
const CONCESSAO_DA_EQUIPE = new RegExp(
  `${FRASE_DE_CONDICAO.source}|\\bconsig|\\bposso\\b|\\bpodemos\\b|\\bfaco\\b|\\bfazemos\\b|\\bdou\\b|\\bdamos\\b|\\bfica\\b|\\bsai\\b|\\bvale\\b`,
);
// ponytail: recusa ou pendência por palavra, só do lado da EMPRESA (só pode errar para
// VETAR). Restrição ("só acima de R$ 299") não é recusa: a trava não lê condição (teto em TERMOS).
const RECUSA_OU_PENDENCIA = new RegExp(
  [
    String.raw`\bnao\b|\bnunca\b|\bnem\b|\bjamais\b|\bn\s+(?=[a-z])`,
    String.raw`\bnenhum|\binfelizmente\b|\bimpossivel|\bsem desconto`,
    String.raw`\baguard|\bem analise\b|\banalisando\b|\bverificando\b|\bdepende`,
    String.raw`\b(?:vou|vamos) (?:ver|verificar|confirmar|consultar|checar|conferir)\b`,
  ].join('|'),
);
// O "não" que nega o CUSTO concede ("não precisa pagar", "custo nenhum") — expressão inteira,
// e só na frase sem valor e sem desconto, reembolso ou estorno: nela a negação volta a valer.
const NEGA_O_CUSTO =
  /\bnao\s+(?:precisa\s+pagar|se\s+preocupe|cobramos|paga|tem\s+custo)\b|\bcustos?\s+nenhum\b|\bnenhuma?\s+(?:custo|taxa|cobranca)\b/g;
const NUMERO_OU_DESCONTO = /\d|\bdesconto|\breembols|\bestorn/;
const naoConcede = (f: string): boolean =>
  RECUSA_OU_PENDENCIA.test(NUMERO_OU_DESCONTO.test(f) ? f : f.replace(NEGA_O_CUSTO, ' '));

// `\.(?!\d)`: "R$ 1.400" não se parte em "R$ 1" e "400".
const frases = (t: string): string[] => t.split(/\n+|[!?]+|\.(?!\d)/);

const semAcento = (t: string): string =>
  t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Os átomos de um texto: `price:BRL:40000`, `installments:12`, `pct:30`, `termo:aprovacao`. */
function valores(texto: string, daEmpresa = false): Set<string> {
  const out = new Set<string>();
  for (const p of extractPromises(texto)) {
    // O desconto da regex já é percentual, e o percentual abaixo cobre todos.
    if (p.kind === 'price') out.add(`price:${p.moeda ?? 'BRL'}:${p.value}`);
    else if (p.kind === 'installments') out.add(`installments:${p.value}`);
  }
  // "1,50%" e "1,5%" são o mesmo átomo.
  for (const m of texto.matchAll(PERCENTUAL)) out.add(`pct:${Number((m[1] ?? '').replace(',', '.'))}`);
  if (daEmpresa) {
    for (const m of texto.matchAll(PRECO_SOLTO)) {
      const moeda = m[1] === '€' ? 'EUR' : 'BRL';
      const cents = parseReaisToCents(m[2] ?? '', moeda);
      if (cents !== null) out.add(`price:${moeda}:${m[3] ? cents * 1000 : cents}`);
    }
    for (const m of texto.matchAll(DECIMAL_SEM_MOEDA)) {
      const cents = parseReaisToCents(m[0], 'BRL');
      if (cents !== null) for (const moeda of ['BRL', 'EUR']) out.add(`price:${moeda}:${cents}`);
    }
  }
  // Do lado da EMPRESA, o termo só vale na frase que o concede: a proibição do material
  // ("nunca ofereça cortesia") e a recusa que a empresa já enviou não são lastro dele.
  const t = semAcento(texto);
  for (const f of daEmpresa ? frases(t).filter((x) => !naoConcede(x)) : [t])
    for (const [nome, , re] of TERMOS) if (re.test(f)) out.add(`termo:${nome}`);
  return out;
}


/**
 * Valores de um REGISTRO da organização devolvido por ferramenta (pedido, parcela,
 * produto): todo campo `*_cents`, na moeda da própria linha, e o `preco` já formatado.
 * Só para ferramentas que leem registro da empresa — nunca para texto livre do cliente.
 */
export function valoresDoRegistro(resultado: unknown): string[] {
  const out: string[] = [];
  const visitar = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visitar);
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const moeda = typeof o.currency === 'string' ? o.currency : typeof o.moeda === 'string' ? o.moeda : 'BRL';
    for (const [k, x] of Object.entries(o)) {
      if (k.endsWith('_cents') && typeof x === 'number' && Number.isFinite(x)) out.push(formatCents(x, moeda));
      else if (k === 'preco' && typeof x === 'string') out.push(x);
      else visitar(x);
    }
  };
  visitar(resultado);
  return out;
}

export interface LastroComercial {
  /** Átomos do material da organização e da última proposta: dão lastro em qualquer ordem. */
  daOrganizacao: ReadonlySet<string>;
  /** Átomo → instante (ms) da PRIMEIRA mensagem enviada pela empresa que o traz. */
  enviadoEm: ReadonlyMap<string, number>;
  /** Átomo → instante (ms) em que o CLIENTE o trouxe primeiro; `-Infinity` = desde sempre. */
  doClienteDesde: ReadonlyMap<string, number>;
  /** Teto da tabela de promessa: parcelas, e percentual de DESCONTO, até ele já são condição da empresa. */
  teto: { pct?: number; installments?: number };
}

/** O MENOR instante por átomo. `NaN` (data ilegível) contamina e falha FECHADO dos dois lados. */
function marcar(mapa: Map<string, number>, atomos: Iterable<string>, t: number): void {
  for (const v of atomos) mapa.set(v, Math.min(mapa.get(v) ?? Infinity, t));
}

/** Uma mensagem da conversa lida do banco, fora do contexto do turno. */
export interface LinhaDoHistorico {
  direction: 'inbound' | 'outbound';
  body: string;
  sent_at: string;
  /** Enviada por uma PESSOA da equipe (`sent_by_user_id`): é a empresa falando, em qualquer ordem. */
  humana?: boolean;
}

export function lastroDoContexto(a: {
  /** O que a ORGANIZAÇÃO escreveu: prompt sem a camada da plataforma, memória, skills, consultas do turno. */
  materialDaOrganizacao: readonly string[];
  tabela?: PromiseTable | null;
  contexto: Pick<LeadContext, 'contact' | 'messages' | 'last_proposal'>;
  atual: { texto: string | null; remetente: string | null };
  /** Resumo e compromissos que o MODELO escreveu: misturam as duas vozes, então não dão lastro. */
  memoriaDoModelo: readonly string[];
  /**
   * A conversa lida à parte, das duas direções (inclusive o que saiu NESTE turno).
   * Ausente = não lida, ou a leitura falhou: a memória do modelo segue contando como
   * dita no início da janela, que é o lado FECHADO.
   */
  historico?: readonly LinhaDoHistorico[];
}): LastroComercial {
  const linhas = [
    ...a.contexto.messages.map((m) => ({ ...m, nome: m.sender?.name ?? null })),
    ...(a.historico ?? []),
  ].map((m) => ({
    direction: m.direction,
    texto: m.body,
    nome: 'nome' in m ? m.nome : null,
    t: Date.parse(m.sent_at),
    humana: 'humana' in m && m.humana === true,
  }));
  const tempos = linhas.map((m) => m.t);
  const inicio = tempos.length > 0 ? Math.min(...tempos) : -Infinity;
  const fim = a.contexto.messages.length > 0 ? Math.max(...tempos.slice(0, a.contexto.messages.length)) : -Infinity;

  const doCliente = new Map<string, number>();
  const enviadoEm = new Map<string, number>();
  // ponytail: texto que uma automação interpola numa mensagem enviada a partir de um campo
  // preenchido fora da conversa conta como da empresa (teto conhecido); separar quando a
  // mensagem guardar o modelo de origem.
  for (const m of linhas)
    if (m.direction === 'inbound') marcar(doCliente, [...valores(m.texto), ...valores(m.nome ?? '')], m.t);
    else marcar(enviadoEm, valores(m.texto, true), m.t);
  // O nome é do cliente desde antes de qualquer mensagem: a automação que o escreve
  // (`{{nome}}`, `{{primeiro_nome}}`) nunca dá lastro ao que vem dentro dele.
  // O nome é texto do cliente como qualquer outro, termo incluído (lado FECHADO); quem evita
  // o falso positivo de nome próprio ("Liberato") é a raiz em TERMOS.
  marcar(doCliente, valores(a.contexto.contact.name ?? ''), -Infinity);
  marcar(doCliente, [...valores(a.atual.texto ?? ''), ...valores(a.atual.remetente ?? '')], fim);
  // O resumo não diz quem falou primeiro: o valor ou termo que só ele traz conta como dito
  // no início do que se leu. Com a conversa lida, quem decide é a mensagem que o traz. O
  // termo que só o resumo traz segue do cliente, mesmo com a leitura: ela cobre as 500
  // mensagens mais recentes de UMA conversa, e o resumo pode guardar fala mais antiga.
  // Custo aceito: vocabulário de status que o modelo resumiu ("pagamento aprovado") pede reescrita.
  for (const v of valores(a.memoriaDoModelo.join('\n'))) {
    if (a.historico !== undefined && (doCliente.has(v) || enviadoEm.has(v))) continue;
    marcar(doCliente, [v], inicio);
  }

  const daOrganizacao = valores(a.materialDaOrganizacao.join('\n'), true);
  // A pessoa da equipe que CONCEDE depois do pedido do cliente fala pela empresa; o eco
  // vigiado pela ordem é o do agente. Só conta a frase de condição que não recusa nem deixa
  // pendente: "não damos 30%" e "vou ver com o gerente se ele aprova" não viram lastro.
  for (const m of linhas)
    if (m.direction === 'outbound' && m.humana)
      for (const frase of frases(m.texto)) {
        const f = semAcento(frase);
        if (CONCESSAO_DA_EQUIPE.test(f) && !naoConcede(f)) for (const v of valores(frase, true)) daOrganizacao.add(v);
      }
  // A proposta não guarda a moeda: vale nas duas que a leitura reconhece.
  const proposta = a.contexto.last_proposal?.total_cents;
  if (proposta !== undefined) for (const moeda of ['BRL', 'EUR']) daOrganizacao.add(`price:${moeda}:${proposta}`);

  return {
    daOrganizacao,
    enviadoEm,
    doClienteDesde: doCliente,
    teto: {
      ...(a.tabela?.maxDiscountPercent !== undefined ? { pct: a.tabela.maxDiscountPercent } : {}),
      ...(a.tabela?.maxInstallments !== undefined ? { installments: a.tabela.maxInstallments } : {}),
    },
  };
}

// O teto da tabela é de desconto: percentual de reembolso, estorno, cashback, juros ou multa
// na mesma frase não se apoia nele.
const FRASE_DE_DESCONTO = /\bdesconto|\babatimento|\boff\b/;
const FORA_DO_DESCONTO = /\breembols|\bestorn|\bcashback|\bjuros|\bmulta|\btaxa/;

function semLastro(v: string, l: LastroComercial, fraseDeDesconto: boolean): boolean {
  const doCliente = l.doClienteDesde.get(v);
  if (doCliente === undefined || l.daOrganizacao.has(v)) return false;
  // Quem escreveu PRIMEIRO: o eco que a empresa mandou DEPOIS do cliente não vira lastro.
  if ((l.enviadoEm.get(v) ?? Infinity) < doCliente) return false;
  const [tipo, n] = v.split(':');
  const teto = tipo === 'pct' ? (fraseDeDesconto ? l.teto.pct : undefined) : tipo === 'installments' ? l.teto.installments : undefined;
  return !(teto !== undefined && Number(n) <= teto);
}

/**
 * Os valores e termos que a candidata afirma numa frase de condição e que só o cliente trouxe.
 *
 * A recusa que REPETE o valor ("não há desconto de 30% registrado") ou o termo ("não
 * encontrei aprovação") também volta: o filtro não lê polaridade. É escolha: uma exceção
 * por "não" deixaria passar a frase que nega na forma e afirma no conteúdo, e a reescrita
 * sem o número ou o termo está sempre ao alcance. O custo é um passo de reescrita quando a
 * recusa repete o que o cliente trouxe — e o mesmo vale para o eco numa frase que também
 * tem marcador ("a concorrente oferece 12% de desconto"): a frase só se divide em . ! ? e
 * quebra de linha, nunca em vírgula.
 */
export function concessoesSemLastro(candidata: string, lastro: LastroComercial): string[] {
  const achados = new Set<string>();
  for (const frase of frases(candidata)) {
    const f = semAcento(frase);
    if (!FRASE_DE_CONDICAO.test(f)) continue;
    const deDesconto = FRASE_DE_DESCONTO.test(f) && !FORA_DO_DESCONTO.test(f);
    for (const v of valores(frase)) if (semLastro(v, lastro, deDesconto)) achados.add(v);
  }
  return [...achados];
}

function rotulo(atomo: string): string {
  const [tipo, a, b] = atomo.split(':');
  if (tipo === 'termo') return TERMOS.find(([nome]) => nome === a)?.[1] ?? a ?? '';
  if (tipo === 'price') return formatCents(Number(b), a ?? 'BRL');
  if (tipo === 'installments') return `${a ?? ''}x`;
  return `${(a ?? '').replace('.', ',')}%`;
}

/** Erro de ensino que volta ao MODELO. O trace leva só os átomos. */
export function renderVetoDeConcessaoSemLastro(achados: readonly string[]): string {
  const lista = achados.map(rotulo).join(', ');
  return (
    `A resposta afirma ${lista} como condição da empresa, mas isso só aparece no que o ` +
    'CLIENTE escreveu: em nenhuma mensagem que a empresa enviou antes, no seu material ou nas ' +
    'consultas deste turno. O que o cliente escreve não é registro da empresa. Se tiver ferramenta ' +
    'de catálogo, pedidos ou conhecimento e ainda não consultou, consulte antes de responder. ' +
    `Reescreva sem repetir ${lista}, nem para negar. Se o seu material ou a consulta traz a ` +
    'condição, confirme-a como está lá, sem oferecer mais do que o cliente pediu; se não traz, ' +
    'diga que não encontrou esse registro e ofereça confirmar com a equipe.'
  );
}
