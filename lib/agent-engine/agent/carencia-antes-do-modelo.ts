/**
 * A CARÊNCIA CURTA ANTES DO MODELO PAGO (#4835).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * Lead que chega por integração com a janela de 24 h fechada só pode receber
 * MODELO APROVADO, que é pago. Só que o cliente é levado ao WhatsApp na mesma
 * hora e costuma escrever nos primeiros segundos — e aí a janela abriria DE
 * GRAÇA, com o agente respondendo em texto livre.
 *
 * No caminho do webhook de captação a inscrição e o primeiro tick acontecem
 * DENTRO do POST (`kickLocalPipeline`), e o job é claimado no ciclo seguinte da
 * fila (`QUEUE_POLL_INTERVAL_MS`, piso de 2 s). Ou seja: a conferência da janela
 * que já existe (`janelaFechada`, em `followup-turn.ts`) roda ~2–4 s depois de o
 * lead nascer, quando o cliente ainda não teve tempo de escrever. Nos outros
 * caminhos (drenagem do `event_log` a cada 2 s ocupada / 10 s ociosa, cron de
 * 1 min) o turno roda entre ~4 s e ~60 s depois — e ali a conferência de hoje já
 * costuma acertar.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * Quando o passo vai gastar MODELO PAGO, é o primeiro contato da conversa
 * (`last_outbound_at` nulo: o lead acabou de chegar) e a janela está fechada, o
 * turno NÃO envia: devolve o MESMO job para a fila com `run_after = agora + N`
 * (`rescheduleJob`, já usado pelo adiamento de janela) e um rastro no payload.
 * Na volta, a janela é relida com `last_inbound_at` fresco:
 *
 *   - janela continua fechada → manda o modelo pago, como hoje;
 *   - janela abriu (o cliente escreveu) → NÃO paga modelo: o passo de IA segue
 *     para o turno, que escreve texto livre; o passo de modelo puro (que não tem
 *     texto livre a mandar) é pulado com motivo nomeado na linha do tempo.
 *
 * ─── Por que N = 10 s, e o que ele deixa de cobrir ──────────────────────────
 *
 * 10 s cobre o caminho mais rápido que existe (webhook: ~2–4 s até o claim) com
 * folga de 6–8 s para a escrita do cliente, e continua abaixo do tick de 30 s do
 * cron — quem espera a carência não espera um minuto inteiro por causa dela. É a
 * mesma ordem de grandeza do debounce de inbound já existente (`INBOUND_DEBOUNCE_MS`,
 * 8 s), e é knob: `FOLLOWUP_CARENCIA_DO_MODELO_MS = 0` desliga e devolve o
 * comportamento de antes, byte a byte.
 *
 * O que fica FORA: (a) o cliente que escreve depois de N — aí o modelo pago sai
 * como hoje, e é o preço declarado da espera; (b) o passo de modelo puro com a
 * janela JÁ aberta e sem carência: continua saindo, porque mudar isso é decisão
 * de produto sobre o passo que o operador configurou, não reconferência; (c) o
 * caminho inline do texto fixo (`enviar-texto-fixo.ts`), que não manda modelo
 * pago.
 *
 * Puro e síncrono onde dá; quem lê banco é `lerJanelaDaConversa`.
 */
import { estadoDaJanela } from '@/lib/channels/janela';
import type { Queryable } from '../queue/queue';

/** Quanto o modelo pago espera o cliente escrever, quando ninguém configurou nada. */
export const CARENCIA_PADRAO_MS = 10_000;

/** Chave do rastro no `payload` do job: a carência já foi usada por este turno. */
export const CHAVE_CARENCIA = 'carencia_do_modelo';

/** O que o turno faz com o passo depois de reler a janela. */
export type DecisaoAntesDoModelo =
  /** Pode gastar o modelo pago (janela fechada, ou fora do recorte da carência). */
  | { acao: 'enviar' }
  /** Devolve o job para a fila sem gastar nada. */
  | { acao: 'esperar'; esperaMs: number; ate: Date }
  /** A janela abriu durante a carência: o turno de IA responde em texto livre. */
  | { acao: 'texto_livre' }
  /** A janela abriu durante a carência e o passo não tem texto livre: não sai. */
  | { acao: 'dispensar'; motivo: string };

/** Motivo nomeado na linha do tempo quando o modelo pago é dispensado. */
export const MOTIVO_DO_MODELO_DISPENSADO =
  'O modelo pago foi dispensado: o cliente escreveu antes, e a janela de 24 horas abriu.';

export interface LeituraDaJanela {
  /** A janela de 24 h está fechada: fora dela só modelo aprovado sai. */
  fechada: boolean;
  /** Nenhuma saída nesta conversa — este passo seria o PRIMEIRO contato do lead. */
  primeiroContato: boolean;
}

/** `N` do ambiente: `0` desliga; valor ausente ou inválido cai no padrão. */
export function carenciaDoAmbiente(valor: number | undefined | null): number {
  if (valor === undefined || valor === null || !Number.isFinite(valor)) return CARENCIA_PADRAO_MS;
  return valor > 0 ? Math.floor(valor) : 0;
}

/**
 * A decisão, sem banco e sem relógio próprio — `agora` entra por parâmetro.
 *
 * `jaEsperou` vem do payload do job (a carência NÃO se repete: depois da volta o
 * turno decide e conclui, esperando ou enviando — nunca devolve o job de novo
 * pela mesma razão).
 */
export function decidirAntesDoModeloPago(input: {
  /** O passo vai gastar modelo aprovado do canal (é isso que a carência protege). */
  passoEhModeloPago: boolean;
  /** O passo tem texto livre no lugar do modelo (reserva da IA) — `false` no passo de modelo puro. */
  temTextoLivreNoLugar: boolean;
  carenciaMs: number;
  /** `null` = canal sem restrição de janela, nada a esperar. */
  janela: LeituraDaJanela | null;
  /** O job já passou pela carência uma vez (rastro no payload). */
  jaEsperou: boolean;
  agora: Date;
}): DecisaoAntesDoModelo {
  if (!input.passoEhModeloPago) return { acao: 'enviar' };
  // Canal sem restrição de janela (a capability diz qual) e passo fora do
  // primeiro contato: nada a proteger.
  if (input.janela === null) return { acao: 'enviar' };
  if (input.jaEsperou) {
    // A VOLTA: é aqui que a reconferência tem o que decidir.
    if (input.janela.fechada) return { acao: 'enviar' };
    return input.temTextoLivreNoLugar
      ? { acao: 'texto_livre' }
      : { acao: 'dispensar', motivo: MOTIVO_DO_MODELO_DISPENSADO };
  }
  if (!input.janela.fechada) return { acao: 'enviar' };
  if (!input.janela.primeiroContato) return { acao: 'enviar' };
  if (input.carenciaMs <= 0) return { acao: 'enviar' };
  return {
    acao: 'esperar',
    esperaMs: input.carenciaMs,
    ate: new Date(input.agora.getTime() + input.carenciaMs),
  };
}

/** O rastro que `rescheduleJob` grava no payload: a carência deste turno. */
export function rastroDaCarencia(input: { esperaMs: number; agora: Date }): Record<string, unknown> {
  return {
    [CHAVE_CARENCIA]: {
      esperou_em: input.agora.toISOString(),
      espera_ms: input.esperaMs,
    },
  };
}

/** Este job já passou pela carência? */
export function jaEsperouPelaCarencia(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const rastro = (payload as Record<string, unknown>)[CHAVE_CARENCIA];
  return rastro !== null && typeof rastro === 'object';
}

/**
 * A janela desta conversa e se este seria o PRIMEIRO contato do lead.
 *
 * `null` quando a conversa não existe (turno de fluxo sem conversa resolvida):
 * sem leitura não há carência — fail-open de propósito, porque o defeito que se
 * fecha é pagar modelo à toa, e travar um envio por falta de leitura seria pior.
 */
export async function lerJanelaDaConversa(
  db: Queryable,
  alvo: { organizationId: string; conversationId: string; agora: Date },
): Promise<LeituraDaJanela | null> {
  const { rows } = await db.query(
    `select s.provider, c.last_inbound_at, c.last_outbound_at
       from conversations c
       join channel_sessions s
         on s.organization_id = c.organization_id and s.id = c.channel_session_id
      where c.organization_id = $1 and c.id = $2
      limit 1`,
    [alvo.organizationId, alvo.conversationId],
  );
  const linha = rows[0] as
    | { provider: string | null; last_inbound_at: Date | string | null; last_outbound_at: Date | string | null }
    | undefined;
  if (linha === undefined) return null;
  const ultimo = linha.last_inbound_at === null ? null : new Date(linha.last_inbound_at).toISOString();
  return {
    fechada: estadoDaJanela(linha.provider, ultimo, alvo.agora).tipo === 'fechada',
    primeiroContato: linha.last_outbound_at === null,
  };
}
