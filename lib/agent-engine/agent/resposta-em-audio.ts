/**
 * RESPOSTA EM ÁUDIO — a IA responde com nota de voz quando o CLIENTE pede.
 *
 * Opcional por agente e desligada de fábrica. Três condições, todas obrigatórias:
 *
 *   1. o agente tem a opção ligada (`ai_agents.config.resposta_em_audio`,
 *      cartão "Responder em áudio quando o cliente pedir" na tela do agente);
 *   2. há chave de voz: a da organização, em IA › Provedores › Voz e áudio,
 *      ou, de reserva, `GOOGLE_TTS_API_KEY` (`edge/voz/credencial.ts`);
 *   3. o cliente PEDIU áudio ("manda um áudio", "responde por áudio") ou disse
 *      que não consegue ler ("não sei ler", "não consigo ler").
 *
 * ─── Por que a preferência vale para a conversa, e não só para a mensagem ───
 *
 * Quem diz "não sei ler" não aprende a ler na mensagem seguinte. Responder em
 * áudio só ao turno do pedido e voltar ao texto no "e quanto custa?" logo depois
 * deixaria essa pessoa sem resposta que entenda. Por isso `preferenciaDeAudio`
 * lê as mensagens do cliente que o agente já enxerga (a janela do histórico),
 * da MAIS RECENTE para trás, e a primeira que expressa preferência decide —
 * inclusive a volta: "pode escrever", "prefiro texto" ou "não consigo ouvir"
 * devolvem a conversa ao texto. Sem pedido na janela, é texto, como sempre.
 *
 * ─── Fallback ───────────────────────────────────────────────────────────────
 *
 * Voz não configurada, síntese que falha, upload que falha, resposta longa
 * demais para um áudio, ou a resposta com foto de produto: sai o TEXTO, pelo
 * caminho de sempre, e o motivo vai para o log do turno. Nunca sai áudio vazio
 * (`edge/voz/sintese.ts` recusa) e nunca saem os dois — o áudio que o canal
 * recusar depois de tentado é desfecho de envio como qualquer outro, e mandar
 * o texto por cima seria a resposta em dobro.
 *
 * O TEXTO fica no CRM: a mensagem de áudio é gravada com `body` igual ao que foi
 * falado (o balão mostra o player e o texto embaixo, e o histórico do agente lê
 * esse `body` no turno seguinte). O handler de envio não manda esse `body` ao
 * cliente como legenda — nota de voz não tem legenda.
 */
import type { Logger } from '../obs/logger';
import { FalhaDaVoz, MAX_BYTES_DO_TEXTO, type Sintetizar } from '../edge/voz/sintese';
import type { BubbleOutcome } from './split-message';

/** O formato que o WhatsApp aceita como nota de voz (o mesmo do gravador da inbox). */
export const MIME_DA_VOZ = 'audio/ogg;codecs=opus';

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// ─── O vocabulário ──────────────────────────────────────────────────────────
//
// Regras sobre o texto SEM acento e em minúsculas. A ordem de avaliação é a da
// função abaixo: a recusa de áudio vence o pedido na MESMA mensagem ("não manda
// áudio, prefiro texto"), porque errar para o texto é o lado seguro.

/** "não manda áudio", "não consigo ouvir", "prefiro texto", "pode escrever". */
const PREFERE_TEXTO: readonly RegExp[] = [
  /\bnao\b[^.!?]{0,25}\b(manda|mande|envia|envie|quero|precisa|grava|grave)\b[^.!?]{0,15}\baudios?\b/,
  /\bsem audios?\b/,
  /\bnao (consigo|da pra|posso|to conseguindo|estou conseguindo) (ouvir|escutar)\b/,
  /\b(prefiro|quero|melhor|pode ser) (por |em )?(texto|escrito|mensagem escrita)\b/,
  /\b(pode|podem|prefiro que) (me )?(escrever|escreva|digitar|digite)\b/,
];

/** Pedido explícito de áudio. */
const PEDE_AUDIO: readonly RegExp[] = [
  /\b(manda|mande|mandar|envia|envie|enviar|grava|grave|gravar|faz|faca|fazer)\b[^.!?]{0,20}\baudios?\b/,
  /\b(responde|responda|responder|fala|fale|falar|explica|explique|explicar|conta|conte|contar)\b[^.!?]{0,30}\b(por|em|num|no) audio\b/,
  /\b(prefiro|quero|melhor|pode ser|seria bom|gostaria de|gostaria do|gostaria de um) (um |uma |o |por |em )?audios?\b/,
  /\b(por|em) audio\b[^.!?]{0,10}(por favor|pfv|pf|\?)/,
];

/** "Não consigo ler" — a dificuldade de LEITURA da pessoa, não de abrir um arquivo. */
const NAO_CONSEGUE_LER: readonly RegExp[] = [
  /\bnao (consigo|sei|to conseguindo|estou conseguindo|consegui|consigo mais) ler\b(?! (o|a|esse|essa|este|esta|seu|sua) (arquivo|pdf|documento|anexo|link|imagem|foto|print))/,
  /\b(dificuldade|problema|problemas) (de|pra|para|em) (ler|leitura|enxergar)\b/,
  /\bnao (leio|enxergo)\b/,
  /\b(analfabet[oa]|semianalfabet[oa]|baixa visao|deficiente visual|cego|cega)\b/,
];

export type PreferenciaDeAudio = 'audio' | 'texto' | null;

/** O que UMA mensagem do cliente diz sobre áudio. `null` = não diz nada. */
export function preferenciaDaMensagem(texto: string): PreferenciaDeAudio {
  const t = normalizar(texto);
  if (PREFERE_TEXTO.some((r) => r.test(t))) return 'texto';
  if (PEDE_AUDIO.some((r) => r.test(t)) || NAO_CONSEGUE_LER.some((r) => r.test(t))) return 'audio';
  return null;
}

/**
 * A preferência em vigor na conversa: a mensagem do cliente MAIS RECENTE que
 * diz alguma coisa sobre áudio decide. Só mensagens recebidas contam — o que a
 * própria IA escreveu ("posso te mandar um áudio?") não é pedido do cliente.
 */
export function preferenciaDeAudio(
  mensagens: ReadonlyArray<{ direction: 'inbound' | 'outbound'; body: string }>,
): boolean {
  for (let i = mensagens.length - 1; i >= 0; i -= 1) {
    const m = mensagens[i];
    if (m === undefined || m.direction !== 'inbound') continue;
    const p = preferenciaDaMensagem(m.body);
    if (p !== null) return p === 'audio';
  }
  return false;
}

/**
 * O texto que vira fala: sem marcação do WhatsApp (`*negrito*`, `_itálico_`,
 * `~riscado~`, crase) — lida em voz alta, ela vira ruído ou some — e com o
 * espaço normalizado. O conteúdo não muda.
 */
export function textoParaFala(texto: string): string {
  return texto
    .replace(/[*_~`]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** O que o modelo lê quando a resposta deste turno vai sair em áudio. */
export const INSTRUCAO_DE_AUDIO =
  '## Resposta em áudio\n' +
  'O cliente pediu para ser atendido por áudio (ou disse que tem dificuldade para ler). A sua ' +
  'resposta será convertida em voz e enviada como nota de voz. Escreva como quem fala: frases ' +
  'curtas e diretas, sem listas, tabelas, emojis, links ou formatação, e numa única chamada de ' +
  'send_message. Se precisar passar um número, data ou endereço, escreva por extenso de forma clara.';

/** Caminho determinístico na pasta da conversa: o replay do job sobrescreve, não duplica. */
export function caminhoDoAudio(input: {
  tenantId: string;
  conversationId: string;
  jobId: string;
  seq: number;
}): string {
  return `${input.tenantId}/${input.conversationId}/voz-ia-${input.jobId}-${input.seq}.ogg`;
}

/** Sobe o áudio para o Storage da conversa. Lança em falha. */
export type GuardarAudio = (caminho: string, audio: Buffer) => Promise<void>;

/**
 * Manda a resposta como nota de voz; qualquer falha ANTES do envio manda o texto.
 *
 * `sintetizar` nulo = voz não configurada na instalação. A falha é registrada no
 * log com o código (nunca a chave nem o texto do cliente) e o turno segue em
 * texto. O envio do áudio fica FORA do `try`: um desfecho ruim do canal não pode
 * virar um segundo envio, em texto, da mesma resposta.
 */
export async function enviarComoAudio<T extends BubbleOutcome>(
  body: string,
  opts: {
    sintetizar: Sintetizar | null;
    /** Motivo de `sintetizar` nulo, para o log (`nao_configurada`, `voz_nao_permitida`). */
    motivoSemVoz?: string;
    guardar: GuardarAudio;
    caminho: string;
    enviarAudio: (caminho: string) => Promise<T>;
    enviarTexto: (body: string) => Promise<T>;
    log: Pick<Logger, 'info' | 'warn'>;
  },
): Promise<T> {
  const fala = textoParaFala(body);
  if (opts.sintetizar === null) {
    opts.log.warn('resposta em áudio: voz indisponível; resposta enviada em texto', {
      event: 'resposta_em_audio_fallback',
      motivo: opts.motivoSemVoz ?? 'nao_configurada',
    });
    return opts.enviarTexto(body);
  }
  if (fala === '' || Buffer.byteLength(fala, 'utf8') > MAX_BYTES_DO_TEXTO) {
    opts.log.info('resposta em áudio: texto vazio ou longo demais para áudio; enviada em texto', {
      event: 'resposta_em_audio_fallback',
      motivo: fala === '' ? 'texto_vazio' : 'texto_longo',
    });
    return opts.enviarTexto(body);
  }
  try {
    const audio = await opts.sintetizar(fala);
    if (audio.length === 0) throw new FalhaDaVoz('audio_vazio');
    await opts.guardar(opts.caminho, audio);
  } catch (err) {
    opts.log.warn('resposta em áudio: síntese ou armazenamento falhou; resposta enviada em texto', {
      event: 'resposta_em_audio_fallback',
      motivo: err instanceof FalhaDaVoz ? err.code : 'armazenamento',
      ...(err instanceof FalhaDaVoz && err.status !== null ? { status: err.status } : {}),
    });
    return opts.enviarTexto(body);
  }
  opts.log.info('resposta em áudio: nota de voz preparada', { event: 'resposta_em_audio' });
  return opts.enviarAudio(opts.caminho);
}
