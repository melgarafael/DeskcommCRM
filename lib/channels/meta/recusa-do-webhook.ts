/**
 * A RECUSA DO WEBHOOK DA META NÃO PODE PEDIR REENTREGA (issue #290, item 3).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Payload fora do contrato respondia `400 validation_failed`. A Meta reentrega
 * tudo que NÃO recebe 2xx, em backoff — então um corpo que nunca vai melhorar
 * ficava em laço por horas, e reentrega em excesso é caminho para a WABA ser
 * suspensa. O corpo torto não é evento que interessa, mas também não é motivo
 * para pedir de novo: é o fio que mudou, e quem precisa saber disso é quem
 * opera, não o provedor.
 *
 * ─── O desenho (o mesmo do lado WAHA, que já está na main) ──────────────────
 *
 *   - responde 200, com um corpo que diz o que aconteceu (não finge que
 *     processou — `accepted: false`, `arquivo: "error"` / `"ja_arquivado"`);
 *   - arquiva o corpo CRU em `webhook_events_log` com `status = 'error'` e o
 *     motivo no mesmo prefixo do WAHA (`contrato_violado: <campos>`), para que
 *     quem relê distinga pelo prefixo o corpo que nunca vai passar do que só
 *     falhou de forma transitória;
 *   - mantém o log estruturado da rota;
 *   - abre UM aviso na Central (`agent_inbox_items`, kind `other`), que é a
 *     superfície que existe hoje para degradação operacional da instalação.
 *
 * ─── Idempotência sem coluna nova ───────────────────────────────────────────
 *
 * A Meta reentrega a MESMA entrega, com o mesmo corpo. Duas linhas no arquivo
 * seriam dois "eventos" para quem investiga, e dois avisos seriam a Central
 * inundada que ninguém lê. A chave é o CONTEÚDO da entrega: o `id` da linha é
 * um UUID derivado de `organization_id + provider + token + raw_body`, então a
 * reentrega tenta gravar o mesmo `id` e o Postgres responde `23505` — que esta
 * função trata como "já arquivado", não como falha. É a mesma ideia do
 * `uniq_webhook_events_log_cobranca` (0601), sem migration: a chave primária já
 * é a restrição única que se precisa. Dois corpos diferentes são duas entregas
 * e ganham duas linhas, como devem.
 *
 * O aviso é deduplicado pelo índice parcial `agent_inbox_other_por_titulo_aberto_unico`
 * (organização + título, `status = 'open'`): a segunda entrega tenta o INSERT,
 * leva `23505` e não abre nada — por isso a tentativa é repetida mesmo quando a
 * linha do arquivo já existia (se o aviso da primeira tentativa falhou por um
 * soluço do banco, a reentrega ainda tem a chance de abri-lo).
 *
 * ─── O que este módulo NÃO faz ──────────────────────────────────────────────
 *
 * Não confere assinatura: quem chama só chega aqui DEPOIS do HMAC (rota). Um
 * corpo não autenticado continua 401 e não vira linha — assinatura inválida é
 * caso DIFERENTE de contrato, e marcar como `error` no arquivo o tornaria
 * alcançável por qualquer um que conhecesse a URL.
 *
 * Também não lança: perder a linha de arquivo é ruim, derrubar a resposta é
 * pior (e uma resposta 5xx faria a Meta reentregar o corpo que já recusamos).
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { cabecalhosSeguros } from "../arquivo-de-webhook";
import { CHANNEL_PROVIDER_META } from "../capabilities";
import type { MetaWebhookSession } from "./session";

/**
 * O prefixo do motivo, o MESMO do lado WAHA (`lib/waha/envelope.ts` +
 * `contrato_violado`): é contrato de leitura para quem for separar, no arquivo,
 * o corpo que nunca vai passar do que apenas falhou agora.
 */
export const MOTIVO_DO_CONTRATO_VIOLADO = "contrato_violado";

/** Título estável: é ele que deduplica a abertura do aviso entre entregas. */
export const TITULO_DO_AVISO_DE_CONTRATO = "O webhook da Meta recebeu um payload fora do contrato";

/**
 * Corpo FIXO, e de propósito: o motivo técnico (com os nomes dos campos) fica no
 * arquivo e no log. Um corpo variável por entrega deduplicaria por texto — isto
 * é, não deduplicaria — e ainda levaria dado do payload para a Central.
 */
export const CORPO_DO_AVISO_DE_CONTRATO =
  "A Cloud API entregou um corpo que não segue o contrato do canal. " +
  "O evento foi arquivado como erro e a Meta recebeu 200, então não há reentrega: " +
  "se isto se repetir, o formato do webhook mudou e mensagens podem estar deixando de entrar. " +
  "Confira os eventos com status de erro em webhook_events_log e o log da rota do webhook da Meta.";

/** `kind` fechado por CHECK; `other` = degradação operacional, como nos outros avisos da casa. */
const KIND_DO_AVISO = "other";

export interface RecusaRegistradaDoWebhookMeta {
  /** O `id` da linha no arquivo — o mesmo nas reentregas da MESMA entrega. */
  logId: string;
  /**
   * O desfecho do arquivo, e são TRÊS de propósito: `ja_existia` é a reentrega
   * da Meta deduplicada pelo `id`, e `falhou` é o banco tendo recusado a
   * escrita. Colapsar os dois em "não gravei agora" faria a resposta dizer
   * "já arquivado" para uma linha que não existe.
   */
  arquivo: "novo" | "ja_existia" | "falhou";
  /** `falhou` = a Central não aceitou o aviso agora (fica para a próxima entrega). */
  aviso: "aberto" | "ja_aberto" | "falhou";
}

/**
 * UUID derivado do conteúdo da entrega.
 *
 * Formato v5 (versão e variante marcadas) para ser um UUID válido de verdade —
 * não um hash fantasiado de UUID. A colisão exigiria achar dois corpos com o
 * mesmo SHA-256, e o mesmo corpo da mesma sessão é, por definição, a MESMA
 * entrega.
 */
function idDaEntrega(organizationId: string, token: string, rawBody: string): string {
  const digest = createHash("sha256")
    .update(organizationId)
    .update("\u0000")
    .update(CHANNEL_PROVIDER_META)
    .update("\u0000")
    .update(token)
    .update("\u0000")
    .update(rawBody)
    .digest();

  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // versão 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 4122
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `jsonb` só aceita objeto: lista e escalar são JSON legítimo e não cabem na coluna. */
function comoObjeto(rawBody: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(rawBody) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Arquiva a recusa e avisa a Central. Nunca lança — ver o cabeçalho.
 */
export async function registrarRecusaDoWebhookMeta(
  admin: SupabaseClient,
  entrada: {
    sessao: MetaWebhookSession;
    token: string;
    rawBody: string;
    headers: Headers;
    /** Nomes dos campos recusados — o VALOR recusado é dado de cliente e não vai para o arquivo. */
    campos: readonly string[];
    requestId: string;
  },
): Promise<RecusaRegistradaDoWebhookMeta> {
  const id = idDaEntrega(entrada.sessao.organizationId, entrada.token, entrada.rawBody);
  const motivo = `${MOTIVO_DO_CONTRATO_VIOLADO}: ${entrada.campos.join(", ")}`;

  let arquivo: RecusaRegistradaDoWebhookMeta["arquivo"] = "falhou";
  try {
    const { error } = await admin
      .from("webhook_events_log")
      .insert({
        id,
        organization_id: entrada.sessao.organizationId,
        channel_session_id: entrada.sessao.id,
        provider: CHANNEL_PROVIDER_META,
        webhook_path_token: entrada.token,
        http_method: "POST",
        headers: cabecalhosSeguros(entrada.headers),
        raw_body: entrada.rawBody,
        payload_parsed: comoObjeto(entrada.rawBody),
        signature_header: entrada.headers.get("x-hub-signature-256"),
        // A assinatura CONFERIU (a rota só chega aqui depois do HMAC): `false`
        // aqui mandaria quem investiga procurar um segredo errado que não existe.
        valid_signature: true,
        // Sem `event_type` de provedor: o payload não chegou a ser classificado,
        // e inventar um nome seria mentir sobre o fio.
        event_type: null,
        external_id: null,
        status: "error",
        error_message: motivo,
        attempts: 0,
      })
      .select("id")
      .maybeSingle();

    if (!error) {
      arquivo = "novo";
    } else if (error.code === "23505") {
      arquivo = "ja_existia";
    } else {
      // Falha que não é dedup: o corpo cru é justamente o que se queria guardar,
      // então isso vai para o log com força (o aviso abaixo ainda é tentado).
      logger.error("[meta.webhook] não consegui arquivar a recusa", {
        request_id: entrada.requestId,
        log_id: id,
        detail: error.message.slice(0, 160),
      });
    }
  } catch (err) {
    logger.error("[meta.webhook] não consegui arquivar a recusa", {
      request_id: entrada.requestId,
      log_id: id,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }

  const aviso = await abrirAvisoDaRecusa(admin, entrada.sessao.organizationId);
  return { logId: id, arquivo, aviso };
}

/**
 * Uma chamada, dois desfechos possíveis de "já existe": o índice único parcial
 * da Central (`23505`) ou qualquer erro de escrita. Best-effort — a resposta ao
 * provedor não depende do aviso.
 */
async function abrirAvisoDaRecusa(
  admin: SupabaseClient,
  organizationId: string,
): Promise<RecusaRegistradaDoWebhookMeta["aviso"]> {
  try {
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: KIND_DO_AVISO,
      severity: "warn",
      title: TITULO_DO_AVISO_DE_CONTRATO,
      body: CORPO_DO_AVISO_DE_CONTRATO,
      ref_kind: null,
      ref_id: null,
    });
    if (!error) return "aberto";
    if (error.code === "23505") return "ja_aberto";
    logger.warn("[meta.webhook] não consegui avisar a Central sobre a recusa", {
      organization_id: organizationId,
      detail: error.message.slice(0, 160),
    });
    return "falhou";
  } catch (err) {
    logger.warn("[meta.webhook] não consegui avisar a Central sobre a recusa", {
      organization_id: organizationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return "falhou";
  }
}
