/**
 * Gate de HORÁRIO SEM FONTE — a garantia DURA de que todo dia+horário que o modelo
 * escreve ao cliente saiu da agenda NESTE turno, e de que "está agendada" só sai
 * depois de a marcação ter sido gravada.
 *
 * Por que existe apesar do `agendaStallGate`: aquele só pergunta se ALGUMA ferramenta
 * de agenda rodou. Medido em produção (2026-10-27, mesmo tenant, `gpt-5.4-mini`):
 *
 *   - o modelo chamou `crm_find_free_slots` e, mesmo assim, escreveu a grade inteira
 *     de cabeça (9h–11h15 de 03/11), por cima de duas consultas já marcadas;
 *   - o modelo respondeu "Sua teleconsulta ... está agendada: 03/11 11:00" sem chamar
 *     `crm_book_appointment` — e o `agendaStallGate` passou, porque a busca do mesmo
 *     turno conta como "checou a agenda", e porque "teleconsulta" não está entre os
 *     substantivos do `AGENDA_CONFIRMED_PATTERN`.
 *
 * A cura é conferir o TEXTO contra o que as ferramentas DEVOLVERAM, não contra o fato
 * de terem sido chamadas. Só olha horário ancorado numa data `DD/MM`: "às 9h" solto não
 * é verificável sem adivinhar o dia, e adivinhar aqui é o mesmo defeito que o gate cura.
 *
 * Puro (sem banco, sem relógio global): o call site entrega o que as tools devolveram.
 */

export interface HorariosDaAgenda {
  /** Arma o gate. Falso/ausente = no-op. */
  ativo: boolean;
  /** Fuso em que o texto do cliente fala (o `fuso_da_regra` da agenda). */
  fuso: string;
  /** Instantes ISO da `horarios[]` que as tools de agenda devolveram NESTE turno. */
  livres: readonly string[];
  /** Instantes ISO dos compromissos deste contato (já existentes + marcados neste turno). */
  doContato: readonly string[];
  /** `crm_book_appointment`/`crm_reschedule_appointment` gravou com sucesso neste turno. */
  marcouNesteTurno: boolean;
  /** Quantas vezes este gate já vetou neste turno — escala o ensino. */
  vetosAnteriores: number;
}

export interface HorarioCitado {
  instante: number;
  rotulo: string;
}

const DATA_DM = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
// "9h", "9h15", "09:15", "11:00" — não casa "1/2", "R$ 10,00" nem o "15" de "15/11".
const HORA = /\b(\d{1,2})(?:h(\d{2})?|:(\d{2}))(?![\d/])/g;

const CONFIRMACAO = [
  /\b(esta|ficou|foi|fica|segue|estao|ficaram)\s+(confirmad|agendad|marcad|reservad|garantid)[oa]s?\b/,
  /\b(confirmad|agendad|marcad|reservad)[oa]s?\s*(com sucesso|para voce|pra voce)\b/,
  /\b(agendamento|consulta|teleconsulta|reserva)\s+(confirmad|feit|realizad)[oa]\b/,
];
const NEGACAO = /\b(nao|ainda nao|sem)\s+(\w+\s+){0,2}$/;

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Desvio do fuso (ms) num instante — Intl, sem tabela própria de horário de verão. */
function desvioDoFuso(instante: number, fuso: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instante));
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  const comoUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return comoUtc - instante;
}

/** Hora de parede no fuso → instante. Duas passadas cobrem a virada de horário de verão. */
export function instanteLocal(
  ano: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  fuso: string,
): number {
  const ingenuo = Date.UTC(ano, mes - 1, dia, hora, minuto);
  let t = ingenuo - desvioDoFuso(ingenuo, fuso);
  t = ingenuo - desvioDoFuso(t, fuso);
  return t;
}

function anoLocal(instante: number, fuso: string): { ano: number; mes: number; dia: number } {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(instante))
    .split('-')
    .map(Number);
  return { ano: p[0] ?? 1970, mes: p[1] ?? 1, dia: p[2] ?? 1 };
}

/**
 * Cada horário fica com a data `DD/MM` mais próxima ANTES dele; numa mensagem com uma
 * data só, todos os horários são dela (a mensagem de agendamento põe a hora na linha de baixo).
 */
export function horariosCitados(corpo: string, agora: Date, fuso: string): HorarioCitado[] {
  const hoje = anoLocal(agora.getTime(), fuso);
  const datas = [...corpo.matchAll(DATA_DM)]
    .map((m) => {
      const dia = Number(m[1]);
      const mes = Number(m[2]);
      if (!(dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12)) return null;
      let ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : hoje.ano;
      // "05/01" dito em dezembro é janeiro que vem.
      if (!m[3] && (mes < hoje.mes - 2 || (mes === hoje.mes - 2 && dia < hoje.dia))) ano += 1;
      return { pos: m.index ?? 0, fim: (m.index ?? 0) + m[0].length, dia, mes, ano };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
  if (datas.length === 0) return [];

  const out: HorarioCitado[] = [];
  for (const h of corpo.matchAll(HORA)) {
    const pos = h.index ?? 0;
    if (datas.some((d) => pos >= d.pos && pos < d.fim)) continue;
    const hora = Number(h[1]);
    const minuto = Number(h[2] ?? h[3] ?? 0);
    if (hora > 23 || minuto > 59) continue;
    const antes = datas.filter((d) => d.pos < pos);
    const alvo = antes.length > 0 ? antes[antes.length - 1] : datas.length === 1 ? datas[0] : undefined;
    if (!alvo) continue;
    out.push({
      instante: instanteLocal(alvo.ano, alvo.mes, alvo.dia, hora, minuto, fuso),
      rotulo: `${String(alvo.dia).padStart(2, '0')}/${String(alvo.mes).padStart(2, '0')} ${hora}h${minuto ? String(minuto).padStart(2, '0') : ''}`,
    });
  }
  return out;
}

export function afirmaQueMarcou(corpo: string): boolean {
  const b = semAcento(corpo);
  return CONFIRMACAO.some((re) => {
    const m = re.exec(b);
    if (!m) return false;
    return !NEGACAO.test(b.slice(Math.max(0, (m.index ?? 0) - 20), m.index));
  });
}

function minuto(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 60_000);
}

export type VereditoDoHorario =
  | { pass: true }
  | { pass: false; code: 'agenda_confirmou_sem_marcar' | 'horario_sem_fonte'; reason: string };

const SAIDA_PELA_EQUIPE =
  'Não escreva nenhum dia nem horário nesta mensagem e não diga que está agendado. ' +
  'Diga "Vou pedir para a equipe finalizar e já te retornam por aqui." e chame a ferramenta de passar para um humano.';

export function avaliarHorarios(corpo: string, agora: Date, h: HorariosDaAgenda | undefined): VereditoDoHorario {
  if (h === undefined || !h.ativo) return { pass: true };
  const citados = horariosCitados(corpo, agora, h.fuso);
  const doContato = new Set(h.doContato.map(minuto).filter((m): m is number => m !== null));
  const livres = new Set(h.livres.map(minuto).filter((m): m is number => m !== null));
  const escalar = h.vetosAnteriores >= 2;

  if (afirmaQueMarcou(corpo) && !h.marcouNesteTurno) {
    // Falar da consulta que o cliente JÁ tem é legítimo: a data citada precisa ser dela.
    const sobreExistente =
      citados.length > 0
        ? citados.every((c) => doContato.has(Math.floor(c.instante / 60_000)))
        : doContato.size > 0;
    if (!sobreExistente) {
      return {
        pass: false,
        code: 'agenda_confirmou_sem_marcar',
        reason: escalar
          ? SAIDA_PELA_EQUIPE
          : 'Você escreveu que a consulta está agendada/confirmada, mas crm_book_appointment NÃO ' +
            'gravou nada neste turno. Nada foi marcado. Se já tem os dados do paciente, chame ' +
            'crm_find_free_slots do dia escolhido e depois crm_book_appointment, e só então ' +
            'confirme. Se faltam dados, peça os dados sem dizer que está agendado.',
      };
    }
  }

  const semFonte = citados.filter((c) => {
    const m = Math.floor(c.instante / 60_000);
    return !livres.has(m) && !doContato.has(m);
  });
  if (semFonte.length === 0) return { pass: true };
  const lista = [...new Set(semFonte.map((c) => c.rotulo))].slice(0, 12).join(', ');
  return {
    pass: false,
    code: 'horario_sem_fonte',
    reason: escalar
      ? SAIDA_PELA_EQUIPE
      : `Estes horários NÃO vieram da agenda neste turno (crm_find_free_slots ou a lista ` +
        `\`horarios\` da tentativa de marcação): ${lista}. Eles podem estar ` +
        'ocupados. Para cada dia que vai citar, chame crm_find_free_slots com `dia` (AAAA-MM-DD) e ' +
        'limite 50, e escreva SOMENTE os horários que vierem na resposta. Não complete a lista de cabeça.',
  };
}

/** O objeto de topo do resultado: objeto, JSON em string ou `content[].text` (MCP). */
function topoDoResultado(resultado: unknown): Record<string, unknown> | null {
  let r: unknown = resultado;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
  const conteudo = (r as { content?: unknown }).content;
  if (Array.isArray(conteudo)) {
    const texto = conteudo.find(
      (c): c is { text: string } => typeof (c as { text?: unknown } | null)?.text === 'string',
    );
    return texto ? topoDoResultado(texto.text) : null;
  }
  return r as Record<string, unknown>;
}

function instanteValido(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

export interface ColheitaDaFerramenta {
  /** `inicio` de cada item de `horarios[]` de TOPO — o que a agenda disse que está livre. */
  livres: string[];
  /** O instante gravado, só quando a marcação/remarcação gravou. */
  marcados: string[];
  marcou: boolean;
  fuso: string | null;
}

/**
 * O que uma tool de agenda DEVOLVEU, sem olhar o nome dela: `crm_find_free_slots`, a
 * conjunta `crm_find_and_book_appointment` (que, com o horário pedido ocupado, devolve
 * `marcado:false` + `horarios[]` e manda oferecer um deles) e a recusa de marcação trazem
 * a mesma `horarios[]` de topo (`payloadDeHorarios`).
 *
 * ⚠️ Só o TOPO. `servico.horarios[]` é a disponibilidade crua do serviço e traz itens com
 * `disponivel:false` — colhê-los aprovaria horário ocupado.
 */
export function colherDaFerramenta(resultado: unknown): ColheitaDaFerramenta {
  const topo = topoDoResultado(resultado);
  if (topo === null) return { livres: [], marcados: [], marcou: false, fuso: null };
  const horarios: unknown[] = Array.isArray(topo.horarios) ? topo.horarios : [];
  const livres = horarios
    .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
    .filter((h) => h.disponivel !== false)
    .map((h) => h.inicio)
    .filter(instanteValido);
  const marcou = marcouComSucesso(topo);
  const compromisso =
    typeof topo.compromisso === 'object' && topo.compromisso !== null
      ? (topo.compromisso as Record<string, unknown>)
      : {};
  const marcados = marcou
    ? [compromisso.starts_at, topo.new_starts_at, topo.starts_at].filter(instanteValido)
    : [];
  const fuso = typeof topo.fuso_da_regra === 'string' && topo.fuso_da_regra ? topo.fuso_da_regra : null;
  return { livres, marcados, marcou, fuso };
}

/** A tool de marcação/remarcação gravou? (`marcado`/`remarcado` true, ou devolveu o compromisso). */
export function marcouComSucesso(resultado: unknown): boolean {
  let r: unknown = resultado;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return false;
    }
  }
  if (r === null || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (o.marcado === false || o.remarcado === false || o.ok === false) return false;
  return o.marcado === true || o.remarcado === true || (typeof o.compromisso === 'object' && o.compromisso !== null);
}
