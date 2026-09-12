/**
 * contact-avatars — baixa e mantém atualizada a foto de perfil dos contatos.
 *
 * POR QUE UM CRON, E NÃO NA INGESTÃO
 * O webhook de entrada precisa responder rápido: baixar e subir uma imagem no meio
 * dele atrasaria a gravação da mensagem e, num pico, faria o canal reenfileirar.
 * Aqui vale a mesma regra do resto do repo — trabalho pesado sai do caminho
 * quente e vira varredura periódica.
 *
 * POR QUE O ARQUIVO, E NÃO A URL
 * O canal devolve uma URL assinada do CDN do WhatsApp, com `oe=<expiração>` no
 * fim. Medido numa instalação real: 9 dias. Guardar a URL faria todo avatar
 * sumir da tela em pouco mais de uma semana, sem erro nenhum. Então o arquivo
 * vai para o bucket privado `whatsapp-media`, como já se faz com a mídia das
 * mensagens, e a tela pede URL assinada na hora.
 *
 * ORDEM DA VARREDURA: `avatar_updated_at nulls first` — quem nunca teve foto
 * entra antes de quem só está desatualizado. O rosto que falta incomoda mais
 * que o rosto velho.
 *
 * Auth: Bearer INTERNAL_SECRET (fail-closed), igual aos demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { DEFAULT_CHANNEL_PROVIDER, getAdapter, type ChannelProvider } from "@/lib/channels";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";

export const dynamic = "force-dynamic";

/** Contatos por invocação. Baixar imagem é I/O: cap baixo evita segurar o cron. */
const SCAN_LIMIT = 25;
/** Revisita a foto a cada 7 dias — gente troca de foto, mas não toda hora. */
const REFRESH_AFTER_DAYS = 7;
/** Foto de perfil do WhatsApp é pequena; acima disto é resposta errada. */
const MAX_BYTES = 2 * 1024 * 1024;

interface ContactRow {
  id: string;
  organization_id: string;
  wa_identity: string | null;
  avatar_storage_path: string | null;
}

/** `lid:123…` / `phone:+55…` → o chatId que o adapter espera. */
function chatIdFromIdentity(identity: string): string | null {
  if (identity.startsWith("lid:")) return `${identity.slice(4)}@lid`;
  if (identity.startsWith("phone:")) return `${identity.slice(6).replace(/\D/g, "")}@c.us`;
  return null;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - REFRESH_AFTER_DAYS * 86_400_000).toISOString();

  // Nunca buscados (null) OU buscados há mais de REFRESH_AFTER_DAYS.
  //
  // `is_anonymized` fora é OBRIGATÓRIO, não otimização: sem esse filtro, um
  // contato anonimizado por pedido LGPD voltaria a ser varrido no refresh
  // seguinte e o cron BAIXARIA O ROSTO DELE DE NOVO — reintroduzindo, sozinho e
  // periodicamente, o dado pessoal que acabara de ser apagado. A anonimização é
  // declarada irreversível no produto; esta linha é o que sustenta isso.
  const { data: contatos, error: queryError } = await admin
    .from("contacts")
    .select("id, organization_id, wa_identity, avatar_storage_path")
    .not("wa_identity", "is", null)
    .eq("is_anonymized", false)
    .or(`avatar_updated_at.is.null,avatar_updated_at.lt.${cutoff}`)
    .order("avatar_updated_at", { ascending: true, nullsFirst: true })
    .limit(SCAN_LIMIT);

  if (queryError) {
    logger.error("[contact-avatars] query failed", { detail: queryError.message, requestId });
    return fail("internal_error", queryError.message, 500, { requestId });
  }

  const rows = (contatos ?? []) as ContactRow[];
  let atualizados = 0;
  let semFoto = 0;
  let falhas = 0;

  for (const c of rows) {
    const chatId = c.wa_identity ? chatIdFromIdentity(c.wa_identity) : null;
    // Carimba mesmo sem conseguir resolver o chatId: sem isso o contato voltaria
    // em TODA rodada do cron, para sempre, batendo no canal à toa.
    //
    // `is_anonymized = false` no UPDATE não repete o filtro do SELECT — fecha uma
    // corrida. Entre a seleção do lote e esta gravação há I/O de rede por contato
    // (canal, download, upload), e a anonimização em escopo de tenant percorre
    // centenas de contatos enquanto isto roda. Se o pedido LGPD alcançar este
    // contato no meio do caminho, sem esta cláusula o cron gravaria o rosto de
    // volta num contato JÁ anonimizado — e o filtro do SELECT nunca mais o
    // escolheria para corrigir. Devolve as linhas afetadas para que quem chamou
    // saiba se a gravação valeu.
    const carimbar = async (path: string | null): Promise<boolean> => {
      const { data: afetadas } = await admin
        .from("contacts")
        .update({
          ...(path !== null ? { avatar_storage_path: path } : {}),
          avatar_updated_at: new Date().toISOString(),
        })
        .eq("id", c.id)
        .eq("organization_id", c.organization_id)
        .eq("is_anonymized", false)
        .select("id");
      return (afetadas ?? []).length > 0;
    };

    if (!chatId) {
      await carimbar(null);
      semFoto++;
      continue;
    }

    try {
      const { data: sessao } = await admin
        .from("channel_sessions")
        .select("waha_session_name, provider")
        .eq("organization_id", c.organization_id)
        .eq("status", "WORKING")
        // Sem o filtro, a linha de chamada de voz (spec 18) — que nasce
        // `WORKING` ao parear — podia ganhar este `limit(1)` sem ordenação e
        // devolver `waha_session_name` nulo: a foto de todo mundo parava de
        // atualizar em silêncio, com o `carimbar(null)` logo abaixo parecendo
        // "este contato não tem foto".
        .in("provider", [...PROVIDERS_DE_MENSAGEM])
        .limit(1)
        .maybeSingle();
      const ref = (sessao as { waha_session_name?: string | null } | null)?.waha_session_name;
      if (!ref) {
        await carimbar(null);
        semFoto++;
        continue;
      }

      // Pelo adapter, nunca falando com o canal direto: a doutrina
      // `restricao-de-canal` proíbe nomear provider fora de lib/channels/, e o
      // `pnpm lint:channels` reprova o build se acontecer (foi o que pegou a
      // primeira versão desta rota). Testar a PRESENÇA do método é como se
      // pergunta "este canal sabe fazer isso?" sem perguntar qual canal é.
      const adapter = getAdapter(
        (sessao as { provider?: ChannelProvider | null } | null)?.provider ??
          DEFAULT_CHANNEL_PROVIDER,
      );
      if (!adapter.fetchProfilePictureUrl) {
        await carimbar(null);
        semFoto++;
        continue;
      }
      const profilePictureURL = await adapter.fetchProfilePictureUrl({
        organizationId: c.organization_id,
        sessionRef: ref,
        recipient: chatId,
      });
      if (!profilePictureURL) {
        // Contato sem foto ou com privacidade fechada: estado normal, não erro.
        await carimbar(null);
        semFoto++;
        continue;
      }

      const img = await fetch(profilePictureURL);
      if (!img.ok) {
        await carimbar(null);
        falhas++;
        continue;
      }
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        await carimbar(null);
        falhas++;
        continue;
      }

      // Caminho estável por contato: `upsert` sobrescreve a foto antiga em vez
      // de acumular um arquivo órfão por refresh (7 dias × N contatos viraria
      // lixo pago no bucket).
      const path = `${c.organization_id}/avatars/${c.id}.jpg`;
      const { error: upErr } = await admin.storage
        .from("whatsapp-media")
        .upload(path, buf, { contentType: "image/jpeg", upsert: true });
      if (upErr) {
        await carimbar(null);
        falhas++;
        continue;
      }

      const gravou = await carimbar(path);
      if (!gravou) {
        // O contato foi anonimizado enquanto baixávamos a foto dele. O arquivo
        // já subiu, então bloquear a gravação não basta: sem isto o objeto ficaria
        // no bucket sem ponteiro nenhum — pior que o defeito original, porque
        // invisível. Devolvemos à fila de redação, o mesmo caminho que a cascata
        // usa, e o worker de limpeza remove.
        await admin.from("storage_redaction_queue").upsert(
          {
            organization_id: c.organization_id,
            bucket: "whatsapp-media",
            object_path: path,
            status: "pending",
            attempts: 0,
            processed_at: null,
            error_message: null,
          },
          { onConflict: "bucket,object_path" },
        );
        logger.warn("[contact-avatars] anonimizado durante a busca; foto devolvida à fila", {
          contact_id: c.id,
          organization_id: c.organization_id,
          requestId,
        });
        semFoto++;
        continue;
      }
      atualizados++;
    } catch (err) {
      await carimbar(null);
      falhas++;
      logger.warn("[contact-avatars] contato falhou", {
        contact_id: c.id,
        detail: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  return ok(
    { scanned: rows.length, updated: atualizados, no_picture: semFoto, failed: falhas },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
