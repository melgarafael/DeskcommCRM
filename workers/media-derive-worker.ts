/**
 * Consome `media.derive_requested`: baixa a mídia persistida (Onda 0), gera o
 * derivado textual model-agnóstico (transcrição/visão/pdf) e grava em
 * messages.media_derived_text. Camada UNIVERSAL da Onda 3 — o texto alimenta
 * qualquer modelo de chat. Retry/backoff delegados ao drain (padrão do repo).
 */
import { generateText } from "ai";
import type pg from "pg";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { resolveOrgLlmConfig, type LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createPool } from "@/lib/agent-engine/db/pool";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const MEDIA_DERIVE_CONSUMER_KEY = "media_derive_v1";
const DRAIN_MAX_ATTEMPTS = 5; // espelho de lib/event-log/drain.ts

const DERIVABLE = new Set(["audio", "image", "document"]);

// ponytail: singleton lazy — o drain só nos dá o admin client; resolveOrgLlmConfig
// exige pg.Pool direto. Sem pool global no processo Next.js, então criamos um sob
// demanda (nunca no import). `pg.Pool` só conecta na primeira query — se
// SUPABASE_DB_URL faltar, o erro aparece ali (capturado pelo try/catch abaixo),
// não na construção.
let _pool: pg.Pool | null = null;
function derivePool(): pg.Pool {
  if (!_pool) _pool = createPool(process.env.SUPABASE_DB_URL ?? "");
  return _pool;
}

interface MessageRow {
  id: string;
  organization_id: string;
  type: string;
  media_mime: string | null;
  media_storage_path: string | null;
  media_derived_status: string | null;
}

export async function deriveMessageMedia(row: EventRow): Promise<HandlerResult> {
  const consumer_key = MEDIA_DERIVE_CONSUMER_KEY;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "no message_id" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .select("id, organization_id, type, media_mime, media_storage_path, media_derived_status")
    .eq("id", messageId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return { consumer_key, status: "error", detail: error.message };

  const msg = data as MessageRow | null;
  if (!msg?.media_storage_path) return { consumer_key, status: "skipped", detail: "no media" };
  if (msg.media_derived_status === "ready") return { consumer_key, status: "skipped", detail: "already derived" };
  if (!DERIVABLE.has(msg.type)) return { consumer_key, status: "skipped", detail: `type ${msg.type}` };

  const markFailed = async () => {
    await admin.from("messages").update({ media_derived_status: "failed" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
  };

  try {
    const dl = await admin.storage.from("whatsapp-media").download(msg.media_storage_path);
    if (dl.error || !dl.data) throw new Error(`storage_download_failed: ${dl.error?.message ?? "no_data"}`);
    const buffer = Buffer.from(await dl.data.arrayBuffer());

    // Credencial BYOK da org p/ visão (imagem). Transcrição usa a mesma chave se
    // o provider for openai; senão exige credencial openai dedicada (Whisper).
    const llmCfg: LlmEdgeConfig = { anthropicApiKey: process.env.ANTHROPIC_API_KEY, cacheTtl: "1h" };
    const llm = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id);
    const deps = buildDeriveDeps(llm);

    const text = await deriveMediaText(msg.type, buffer, msg.media_mime ?? "application/octet-stream", deps);
    await admin.from("messages")
      .update({ media_derived_text: text, media_derived_status: "ready" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
    return { consumer_key, status: "ok" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (row.attempts >= DRAIN_MAX_ATTEMPTS - 1) {
      logger.error("[media-derive] failed permanently", { message_id: msg.id, detail });
      await markFailed();
    }
    return { consumer_key, status: "error", detail };
  }
}

function buildDeriveDeps(llm: { provider: string; apiKey: string; defaultModel: string | null }): DeriveDeps {
  const registry = createDefaultRegistry();
  const visionCapable = modelCapabilities(llm.provider, llm.defaultModel ?? "").image;
  const describeImage: DeriveDeps["describeImage"] = async (buffer, mime) => {
    if (!visionCapable) return ""; // provider sem visão → sem descrição (áudio/pdf ainda funcionam)
    const factory = registry[llm.provider];
    if (!factory) return "";
    const res = await generateText({
      model: factory(llm.apiKey, llm.defaultModel ?? ""),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Descreva objetivamente esta imagem em 1-2 frases, em português, para um atendente de vendas entender o que o cliente enviou." },
            // AI SDK v7: file part com mediaType (o antigo image part é deprecated).
            { type: "file", data: buffer, mediaType: mime.split(";")[0]! },
          ],
        },
      ],
    });
    return res.text;
  };
  return {
    transcriber: apiTranscriptionProvider({ apiKey: llm.apiKey }),
    describeImage,
    extractPdf: extractPdfText,
  };
}
