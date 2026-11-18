/**
 * A MÍDIA FIXA DA PRIMEIRA ABORDAGEM (#4581).
 *
 * A campanha de prospecção mandava só texto. Aqui nasce o arquivo que vai JUNTO
 * da primeira mensagem — imagem, vídeo ou PDF —, escolhido pelo operador e
 * IGUAL para todos os candidatos daquela campanha.
 *
 * ── O que esta fatia NÃO faz, de propósito ──────────────────────────────────
 *
 * · Não há upload novo: o campo aponta para um arquivo que JÁ está no Storage
 *   desta instalação (bucket `whatsapp-media`, o mesmo das mídias do
 *   atendimento e das respostas rápidas). O descritor gravado — caminho, mime e
 *   tamanho — é o mesmo vocabulário de `message_templates.midias` (0643), que a
 *   rota de upload já preenche conferindo os BYTES do arquivo.
 * · A IA não escolhe mídia: o campo é configuração, gravado pelo dono da
 *   campanha. Um arquivo por campanha, sempre o mesmo.
 * · O follow-up não muda: esta mídia é da PRIMEIRA abordagem.
 *
 * ── Por que a régua daqui é mais ESTREITA que a do passo do follow-up ───────
 *
 * `classificarMidiaComLegenda` (`lib/messaging/media/midia-com-legenda.ts`)
 * aceita também áudio, porque um passo de fluxo pode mandar nota de voz para
 * quem já conversa. Abordagem FRIA é outra coisa: o primeiro contato de alguém
 * que nunca falou com a empresa, com um número que pode ser banido. Áudio e
 * documento genérico ficam de fora — a fatia aceita o que o pedido nomeia:
 * imagem, vídeo e PDF. Tipo fora desta lista é recusado, nunca rebaixado.
 *
 * ── Por que a URL é ASSINADA, e não `media_storage_path` ────────────────────
 *
 * O handler de envio só aceita `media_storage_path` sob `{org}/{conversa}/`
 * (`isMediaPathOwnedBy`) — posse do arquivo PELA conversa. O arquivo da
 * campanha é um só para todas as conversas, então nunca mora sob o prefixo de
 * nenhuma delas. O caminho que resta é o que o PDF da proposta já usa
 * (`lib/propostas/storage.ts`): assinar a URL com a service role e mandar por
 * `media_url`. A guarda anti-SSRF reconhece a URL assinada do próprio Storage
 * como entrega legítima (`url-de-midia-externa.ts`), então nada é afrouxado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Queryable } from "@/lib/agent-engine/queue/queue";

import { BUCKET_DAS_MIDIAS, TAMANHO_MAXIMO_DA_MIDIA } from "@/lib/templates/midias";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

/** O bucket onde o arquivo já existe: o das mídias do atendimento. */
export const BUCKET_DA_MIDIA_DA_CAMPANHA = BUCKET_DAS_MIDIAS;

/**
 * 16 MB — o teto de VÍDEO do WhatsApp oficial, a mesma fonte que fixa 5 MB para
 * imagem e 16 MB para áudio (`TAMANHO_MAXIMO_DO_AUDIO`, `lib/templates/midias.ts`).
 * É o número do TERCEIRO (quem recebe), não um gosto nosso: acima dele o envio
 * falha no provider, depois de a mídia já ter sido assinada.
 */
export const TAMANHO_MAXIMO_DO_VIDEO = 16 * 1024 * 1024;

/**
 * O teto de legenda de uma mídia no WhatsApp. A PRIMEIRA bolha vira legenda
 * quando a campanha tem mídia, então ela precisa caber aqui — o resto da
 * abordagem segue nas bolhas seguintes.
 */
export const TETO_DE_LEGENDA = 1024;

/**
 * O TETO DIÁRIO DE ABORDAGENS COM MÍDIA, POR NÚMERO (decisão do dono, 15/11,
 * doc 358 › 2A). O mesmo arquivo indo para muitos números frios pesa mais na
 * régua de banimento do que texto variado. Acima do teto, a abordagem do dia
 * sai SÓ COM TEXTO: a campanha não trava, e a trilha registra a omissão.
 *
 * ponytail: constante, não knob. É do NÚMERO, então o lugar de um ajuste seria
 * `channel_knobs` — coluna nova, com migration. Vira knob quando alguém pedir.
 */
export const TETO_DIARIO_DE_MIDIA_POR_NUMERO = 30;

/**
 * Quantas abordagens COM MÍDIA este número já mandou desde `desde` (o início do
 * dia no fuso da janela do número). Fonte: as próprias mensagens — a 1ª bolha da
 * abordagem é a linha `messages.id = prospecting_candidates.message_id`, e o
 * `type` dela diz se levou arquivo. Sem contador novo: o que conta é o que saiu.
 * `failed` não conta, porque a plataforma recusou e nada chegou a ninguém.
 */
export const ABORDAGENS_COM_MIDIA_DESDE_SQL =
  "select count(*)::int as n from prospecting_candidates p join messages m on m.organization_id = p.organization_id and m.id = p.message_id where p.organization_id = $1 and p.attempted_at >= $3 and m.channel_session_id = $2 and m.created_at >= $3 and m.type in ('image','video','document') and m.status <> 'failed'";

export async function abordagensComMidiaDesde(
  db: Queryable,
  organizationId: string,
  channelSessionId: string,
  desde: Date,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(ABORDAGENS_COM_MIDIA_DESDE_SQL, [
    organizationId,
    channelSessionId,
    desde,
  ]);
  return rows[0]?.n ?? 0;
}

/** O tipo que o canal entende — o mesmo vocabulário de `messages.type`. */
export type TipoDeMidiaDaAbordagem = "image" | "video" | "document";

/** O que a configuração da campanha guarda: a DESCRIÇÃO de um arquivo existente. */
export interface MidiaDaAbordagem {
  /** Caminho no bucket `whatsapp-media`, sob `{org}/`. */
  storage_path: string;
  media_mime: string;
  /** Tamanho gravado pela rota de upload que recebeu o arquivo. */
  media_size_bytes: number;
}

/**
 * A lista FECHADA do que pode ir numa abordagem fria, com o teto de cada tipo.
 *
 * Fechada porque "não reconheci" e "reconheci algo que não aceito" levam ao
 * mesmo lugar: recusar. O mime é comparado já normalizado (sem `;charset` e em
 * minúsculas), como o resto do caminho de mídia faz.
 */
const REGRAS: Record<string, { tipo: TipoDeMidiaDaAbordagem; teto: number }> = {
  "image/jpeg": { tipo: "image", teto: TAMANHO_MAXIMO_DA_MIDIA },
  "image/png": { tipo: "image", teto: TAMANHO_MAXIMO_DA_MIDIA },
  "image/webp": { tipo: "image", teto: TAMANHO_MAXIMO_DA_MIDIA },
  "video/mp4": { tipo: "video", teto: TAMANHO_MAXIMO_DO_VIDEO },
  "video/3gpp": { tipo: "video", teto: TAMANHO_MAXIMO_DO_VIDEO },
  "video/quicktime": { tipo: "video", teto: TAMANHO_MAXIMO_DO_VIDEO },
  // PDF: o único documento da fatia. O teto é o do bucket (50 MB); o do WhatsApp
  // para documento é maior, então quem manda aqui é o que o Storage aceita.
  "application/pdf": { tipo: "document", teto: MAX_MEDIA_BYTES },
};

export type ClassificacaoDaMidiaDaAbordagem =
  { ok: true; tipo: TipoDeMidiaDaAbordagem; mime: string } | { ok: false; motivo: string };

/** O mime normalizado: minúsculo e sem parâmetros (`;charset=…`). */
export function mimeNormalizado(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0]!.trim().toLowerCase();
}

const MOTIVO_DE_TIPO =
  "A mídia da abordagem precisa ser uma imagem (jpg, png ou webp), um vídeo (mp4, 3gp ou mov) ou um PDF. Áudio e outros documentos não saem numa abordagem fria.";

/**
 * A mídia da campanha pode ir junto da primeira abordagem? Tipo primeiro, depois
 * tamanho — a mesma ordem da tela: recusar por tamanho um arquivo cujo tipo nem
 * era aceito manda o operador procurar no lugar errado.
 */
export function classificarMidiaDaAbordagem(midia: {
  media_mime?: string | null;
  media_size_bytes?: number | null;
}): ClassificacaoDaMidiaDaAbordagem {
  const mime = mimeNormalizado(midia.media_mime);
  const regra = REGRAS[mime];
  if (!regra) return { ok: false, motivo: MOTIVO_DE_TIPO };
  const tamanho = Number(midia.media_size_bytes ?? 0);
  if (!Number.isFinite(tamanho) || tamanho <= 0)
    return { ok: false, motivo: "A mídia da abordagem não tem tamanho conhecido." };
  if (tamanho > regra.teto)
    return {
      ok: false,
      motivo: `A mídia da abordagem passa do limite de ${Math.floor(
        regra.teto / (1024 * 1024),
      )} MB para este tipo de arquivo.`,
    };
  return { ok: true, tipo: regra.tipo, mime };
}

/**
 * Por que a mídia NÃO pode ir; `null` quando pode. Existe para o schema Zod e
 * para a tela dizerem a MESMA frase — a mesma régua de `problemaNoTextoDaSaida`.
 */
export function problemaNaMidiaDaAbordagem(midia: {
  media_mime?: string | null;
  media_size_bytes?: number | null;
}): string | null {
  const classificada = classificarMidiaDaAbordagem(midia);
  return classificada.ok ? null : classificada.motivo;
}

/**
 * Quanto tempo a URL assinada continua valendo, em segundos.
 *
 * 24 h, e não os 10 minutos do caminho de leitura do inbox: a mensagem pode
 * ficar na fila do canal (número em aquecimento, ritmo, reconexão) e quem baixa
 * o arquivo é o PROVIDER, no instante em que a entrega acontece. O PDF da
 * proposta usa 7 dias pelo mesmo motivo; aqui 24 h cobrem a fila inteira da
 * esteira fria (`daily_limit` × `interval_minutes`) sem deixar o arquivo
 * pendurado mais do que o necessário.
 */
export const VALIDADE_DA_URL_DA_MIDIA_S = 60 * 60 * 24;

export type MidiaProntaParaEnvio =
  | { ok: true; tipo: TipoDeMidiaDaAbordagem; mime: string; url: string }
  | { ok: false; motivo: string };

/**
 * Prepara o envio: confere o descritor e assina a URL do arquivo que JÁ está no
 * Storage. Nada é baixado nem reenviado — a assinatura é metadado.
 *
 * Falha de assinatura é RECUSA, não "manda só o texto": a campanha foi
 * configurada para abordar COM aquele arquivo, e entregar uma abordagem
 * diferente da configurada é efeito que ninguém pediu. Quem decide o que fazer
 * com a recusa é o tick (o escopo do `ProspectingError`).
 */
export async function prepararMidiaDaAbordagem(
  admin: SupabaseClient,
  midia: MidiaDaAbordagem | null | undefined,
): Promise<MidiaProntaParaEnvio | null> {
  if (!midia) return null;
  const classificada = classificarMidiaDaAbordagem(midia);
  if (!classificada.ok) return { ok: false, motivo: classificada.motivo };
  const { data, error } = await admin.storage
    .from(BUCKET_DA_MIDIA_DA_CAMPANHA)
    .createSignedUrl(midia.storage_path, VALIDADE_DA_URL_DA_MIDIA_S);
  const url = data?.signedUrl?.trim();
  if (error || !url)
    return {
      ok: false,
      motivo:
        "A mídia da abordagem não pôde ser preparada: o arquivo configurado não está no Storage desta instalação. Escolha o arquivo de novo antes de retomar a campanha.",
    };
  return { ok: true, tipo: classificada.tipo, mime: classificada.mime, url };
}
