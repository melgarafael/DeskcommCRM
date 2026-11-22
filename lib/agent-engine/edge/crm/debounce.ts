/**
 * Coalescência de rajada inbound — a janela que junta as mensagens de UM contato
 * em UM turno.
 *
 * Morava inline no `drain.ts`; saiu para cá com teste próprio (issue #1390)
 * porque o comportamento carrega duas leis que se cruzam — a janela de debounce
 * e a exclusão do job em HOLD — e as duas precisam de régua própria.
 *
 * Contrato:
 *   - mensagem que chega enquanto há job PENDING **do mesmo contato** dentro da
 *     janela viaja de carona nele: o turno lê o histórico completo e responde a
 *     todas as mensagens do lote;
 *   - mensagem que chega fora da janela abre janela nova;
 *   - `debounceMs = 0` desliga a coalescência: job imediato, zero consulta.
 *
 * ─── A janela é DESLIZANTE, com TETO (issue #196, parte (b)) ──────────────────
 *
 * Até aqui a janela era ANCORADA no primeiro job: `run_after = created_at +
 * debounceMs`, fixado na criação, e nada o empurrava para frente. Rajada humana
 * típica — bolhas de WhatsApp com 10-20s de intervalo — caía fora: cada bolha
 * que chegava depois do `run_after` abria job novo, e o agente respondia bolha
 * por bolha ("IA respondendo em duplicidade", o oposto do que o debounce
 * existe para fazer). Medido na issue #196: 3 mensagens do mesmo contato, gaps
 * de 12,1s e 17,5s (rajada de 29,6s), zero coalescência, 3 jobs.
 *
 * Agora cada mensagem que encontra o job da rajada o EMPURRA para frente
 * (`run_after = agora + debounceMs`) e a janela segue aceitando carona até o
 * TETO contado da PRIMEIRA mensagem (`created_at + tetoMs`, o
 * `INBOUND_BURST_MAX_MS` da instalação). O teto é o que impede o contato que não
 * para de escrever de adiar a resposta indefinidamente: passado ele, a próxima
 * mensagem abre rajada nova.
 *
 * Quem mede o pior caso (espera por mensagem, turnos por rajada) é
 * `debounce.medicao.test.ts`; quem reproduz o caso de produção, com relógio
 * fixo, é `debounce.deslizante.test.ts`.
 */
import type pg from 'pg';

import { adiadoPelaJanelaDeResposta } from '../../pacing/adiados-da-janela';

/**
 * Job pendente do contato que pode receber a mensagem de carona.
 *
 * Duas portas, e as DUAS precisam existir:
 *
 *   (a) `run_after > now()` — a janela ancorada de sempre. É a única porta que
 *       casa com o job adiado pela JANELA DE RESPOSTA (#3383): ele tem
 *       `run_after` às 07:00 de amanhã e `created_at` de hoje, então a porta (b)
 *       nunca o alcança. Tirá-la faria a mensagem da madrugada abrir turno
 *       próprio em vez de viajar de carona para as 7h.
 *   (b) `created_at + teto > now()` — a rajada deslizante (#196): o job segue
 *       recebendo carona e sendo empurrado até o teto, mesmo depois de o
 *       `run_after` original ter vencido. Sem ela, gap de 12s com debounce de
 *       8s escapa — que é exatamente o defeito medido.
 *
 * ⚠️ Nenhuma das duas sozinha pode casar com um job em HOLD (`enforceHolds`,
 * session-watchdog.ts), que usa `run_after = 'infinity'` como marcador, e
 * 'infinity' É maior que `now()`. Um job em hold por sessão MORTA (WhatsApp
 * reconectado, sessão antiga arquivada) nunca libera — a condição de liberação
 * exige a MESMA sessão antiga voltar a 'WORKING', o que não acontece nunca.
 * Sem a exclusão por `held_run_after`, TODA mensagem nova do mesmo contato —
 * inclusive na sessão NOVA — coalescia nesse job morto para sempre: o cliente
 * escrevia, o evento saía "done" sem erro nenhum, e nenhum turno rodava. Medido
 * em produção (2026-09-14): 6 mensagens ao longo de 7h, zero resposta, zero job
 * novo — só o coalescing silencioso repetido no mesmo job.
 *
 * `order by created_at asc`: com dois jobs pendentes do mesmo contato (um
 * adiado pela janela + um da rajada), a âncora é o MAIS ANTIGO — é dele que o
 * teto conta e é ele que o contato está esperando.
 */
const SQL_JOB_PARA_COALESCER = `select id, payload, created_at, run_after from job_queue
 where organization_id = $1 and contact_id = $2
   and kind = 'inbound_turn' and status = 'pending'
   and (run_after > now() or created_at + ($3::int * interval '1 millisecond') > now())
   and not (payload ? 'held_run_after')
 order by created_at asc
 limit 1`;

/**
 * Empurra o `run_after` do job da rajada. Guardas, todas de propósito:
 *
 *   - `status = 'pending'`: o claim pode ter vencido a corrida entre o SELECT e
 *     este UPDATE. Job já claimado não pode ter o horário mexido — quem manda
 *     nele agora é o turno em curso (e ele lê o histórico completo do mesmo
 *     jeito);
 *   - `organization_id`: mesma cerca das outras consultas do drenador, que roda
 *     com service role, onde RLS não filtra nada por nós;
 *   - `kind = 'inbound_turn'`: id de outro tipo de job nunca chega aqui, mas o
 *     UPDATE é a única escrita deste módulo e ela fica presa ao tipo que ele
 *     governa.
 */
const SQL_ESTENDER_JANELA = `update job_queue set run_after = $2::timestamptz
 where id = $1 and organization_id = $3 and kind = 'inbound_turn' and status = 'pending'`;

/** O que fazer com a mensagem que acabou de chegar. */
export type DecisaoDeRajada =
  | {
      tipo: 'coalescido';
      jobId: string;
      /**
       * Novo `run_after` quando esta mensagem empurrou a janela; `null` quando
       * não havia o que empurrar (teto alcançado, job adiado pela janela de
       * resposta, dublê sem `created_at`) ou quando o UPDATE falhou.
       */
      janelaEstendidaAte: Date | null;
      /** Preenchido só quando o UPDATE falhou — o chamador loga, o evento segue. */
      erroAoEstender?: string;
    }
  | {
      tipo: 'enfileirar';
      runAfter: Date | undefined;
      /**
       * Job que ERA o candidato natural à carona mas está adiado pela JANELA DE
       * RESPOSTA que já ABRIU (#3383): não recebe a mensagem, e quem acorda o
       * adiado é quem chama (`drain.ts` — ver `soltarAdiadoPelaJanela`).
       */
      caronaRecusadaEm?: string;
    };

/** Job pendente do contato que pode receber a mensagem de carona. */
export interface CandidatoDeCarona {
  id: string;
  /** `true` quando o job espera a ABERTURA da janela de resposta (rastro do #3383). */
  adiadoPelaJanelaDeResposta: boolean;
  /**
   * `created_at` do job — a ÂNCORA da rajada, de onde o teto conta. `null`
   * quando quem responde é um dublê que não devolve a coluna: aí não há como
   * estender, e a decisão fica a coalescência ancorada de antes.
   */
  criadoEm: number | null;
  /** `run_after` vigente — nunca encurtado por uma extensão. */
  runAfterEm: number | null;
}

/**
 * `Date`/ISO do driver → ms; qualquer coisa que não seja data vira `null`.
 *
 * É RÉGUA DE LEITURA de data de armazenamento, e por isso está declarada na
 * lista ÚNICA (`tests/invariants/reguas-de-data.ts`): `jobs.created_at` (a
 * âncora da rajada) e `jobs.run_after` chegam `Date` pelo driver `pg` e string
 * pelo PostgREST/payload clonado. Recusar o `Date` aqui devolveria `null` e a
 * janela simplesmente NÃO estenderia — modo de falha mudo, sem uma linha de
 * erro, que é exatamente o que aquela cerca existe para pegar.
 */
export function emMs(valor: Date | string | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  const ms = valor instanceof Date ? valor.getTime() : new Date(valor).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export async function buscarJobParaCoalescer(
  pool: pg.Pool,
  alvo: { organizationId: string; contactId: string },
  tetoMs: number,
): Promise<CandidatoDeCarona | undefined> {
  const { rows } = await pool.query<{
    id: string;
    payload: unknown;
    created_at?: Date | string | null;
    run_after?: Date | string | null;
  }>(SQL_JOB_PARA_COALESCER, [alvo.organizationId, alvo.contactId, tetoMs]);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    adiadoPelaJanelaDeResposta: adiadoPelaJanelaDeResposta(row.payload),
    criadoEm: emMs(row.created_at),
    runAfterEm: emMs(row.run_after),
  };
}

/**
 * Janela da rajada aberta por esta mensagem: `undefined` quando não há debounce
 * (o job nasce claimável agora).
 *
 * `agora` é injetável porque a janela é aritmética — o teste prende o número
 * sem depender do relógio.
 */
export function janelaDeRajada(debounceMs: number, agora: number = Date.now()): Date | undefined {
  return debounceMs > 0 ? new Date(agora + debounceMs) : undefined;
}

/**
 * Teto da janela de rajada configurável por agente (#1856): não deixar ninguém
 * travar o atendimento sem querer. Vale também como default de tela/UX.
 */
export const TETO_DEBOUNCE_MS = 60_000;

/**
 * Teto EFETIVO da rajada deslizante.
 *
 * `tetoMs` ausente ou `0` = janela ANCORADA (`run_after` nasce e não anda): é o
 * opt-out explícito e é o que mantém o comportamento antigo em qualquer
 * chamador que não passe o knob.
 *
 * Teto menor que a própria janela é incoerência de configuração e resolve para
 * a janela: sem isso o teto venceria antes de o job nascer claimável, e a
 * mensagem seguinte abriria rajada nova sempre — o defeito, de volta.
 */
export function tetoDaRajada(tetoMs: number | null | undefined, debounceMs: number): number {
  if (debounceMs <= 0) return 0;
  if (tetoMs === null || tetoMs === undefined || tetoMs <= 0) return debounceMs;
  return Math.max(tetoMs, debounceMs);
}

/**
 * Horário para onde a janela vai: `agora + debounce`, mas NUNCA além de
 * `created_at + teto`.
 *
 * Puro de propósito — o teto é a parte que a issue pede para provar, e provar
 * aritmética não precisa de relógio de parede nem de `sleep`.
 */
export function janelaEstendidaAte(
  criadoEm: number,
  tetoMs: number,
  debounceMs: number,
  agora: number,
): number {
  return Math.min(agora + debounceMs, criadoEm + tetoMs);
}

/**
 * Janela de rajada EFETIVA de um agente.
 *
 * `null`/`undefined` (campo vazio na versão) = o `INBOUND_DEBOUNCE_MS` da
 * instalação — regressão zero para quem nunca mexeu no campo. O valor
 * configurado é CLAMPADO em [0, TETO_DEBOUNCE_MS]: 0 desliga a coalescência e
 * valores acima do teto (dado sujo que entrou por fora da validação) caem para
 * 60s em vez de travar o atendimento.
 */
export function debounceEfetivo(
  configurado: number | null | undefined,
  padraoInstalacao: number,
): number {
  if (configurado === null || configurado === undefined) return padraoInstalacao;
  return Math.min(Math.max(0, configurado), TETO_DEBOUNCE_MS);
}

/**
 * Empurra a janela do job da rajada, respeitando o teto.
 *
 * NÃO LANÇA. Estender é o que evita a resposta em duplicidade; falhar nisso
 * devolve o comportamento ancorado — pior, mas não perde mensagem — e derrubar
 * o evento por causa de um UPDATE de conveniência custaria um retry inteiro (e,
 * no limite, um evento morto na Central). O erro sobe em `erroAoEstender` para
 * quem chama logar.
 */
async function estenderJanelaDaRajada(
  pool: pg.Pool,
  alvo: { organizationId: string; contactId: string },
  candidato: CandidatoDeCarona,
  p: { agora: number; debounceMs: number; tetoMs: number },
): Promise<{ ate: Date | null; erro?: string }> {
  if (candidato.criadoEm === null || candidato.runAfterEm === null) return { ate: null };
  const alvoEm = janelaEstendidaAte(candidato.criadoEm, p.tetoMs, p.debounceMs, p.agora);
  // Já no teto (`alvoEm <= runAfterEm`) ou janela MAIOR que a nossa (job adiado
  // pela janela de resposta, com `run_after` às 07:00 de amanhã): não escreve.
  // Encurtar aqui seria o pior dos mundos — adiantaria a resposta do lote e, no
  // caso da janela de resposta, furaria o horário combinado.
  if (alvoEm <= candidato.runAfterEm) return { ate: null };
  try {
    await pool.query(SQL_ESTENDER_JANELA, [
      candidato.id,
      new Date(alvoEm).toISOString(),
      alvo.organizationId,
    ]);
    return { ate: new Date(alvoEm) };
  } catch (err) {
    return { ate: null, erro: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Decide entre carona em job existente e janela nova.
 *
 * `janelaDeRespostaAberta` (#3383) é opcional e SÓ é consultada quando o
 * candidato carrega o rastro `adiado_por_janela` — job de debounce (8 s), cap,
 * saldo ou sessão não pagam a leitura e continuam exatamente como antes.
 *
 * Com a janela ABERTA, o job adiado pela janela não recebe carona: a mensagem
 * nova enfileira o próprio turno (e o chamador acorda o adiado, que senão
 * dormiria até o horário antigo). Com a janela FECHADA o comportamento é o de
 * sempre — a mensagem viaja de carona e os dois respondem juntos às 7h.
 * Sem o quinto argumento (todos os chamadores antigos), nada muda.
 *
 * `tetoMs` é o `INBOUND_BURST_MAX_MS` (#196). Ausente = janela ANCORADA, que é
 * o comportamento de antes desta mudança: nenhum chamador antigo muda de
 * comportamento sem passar o knob.
 */
export async function decidirRajada(
  pool: pg.Pool,
  alvo: { organizationId: string; contactId: string },
  debounceMs: number,
  agora: number = Date.now(),
  janelaDeRespostaAberta?: () => Promise<boolean>,
  tetoMs?: number,
): Promise<DecisaoDeRajada> {
  if (debounceMs > 0) {
    const teto = tetoDaRajada(tetoMs, debounceMs);
    const candidato = await buscarJobParaCoalescer(pool, alvo, teto);
    if (candidato !== undefined) {
      if (
        candidato.adiadoPelaJanelaDeResposta &&
        janelaDeRespostaAberta !== undefined &&
        (await janelaDeRespostaAberta())
      ) {
        return {
          tipo: 'enfileirar',
          runAfter: janelaDeRajada(debounceMs, agora),
          caronaRecusadaEm: candidato.id,
        };
      }
      const extensao = await estenderJanelaDaRajada(pool, alvo, candidato, {
        agora,
        debounceMs,
        tetoMs: teto,
      });
      return {
        tipo: 'coalescido',
        jobId: candidato.id,
        janelaEstendidaAte: extensao.ate,
        ...(extensao.erro === undefined ? {} : { erroAoEstender: extensao.erro }),
      };
    }
  }
  return { tipo: 'enfileirar', runAfter: janelaDeRajada(debounceMs, agora) };
}
