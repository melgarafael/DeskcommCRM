/**
 * Consome `media.derive_requested`: baixa a mídia persistida (Onda 0), gera o
 * derivado textual model-agnóstico (transcrição/visão/pdf) e grava em
 * messages.media_derived_text. Camada UNIVERSAL da Onda 3 — o texto alimenta
 * qualquer modelo de chat. Retry/backoff delegados ao drain (padrão do repo).
 */
import { generateText } from "ai";
import type pg from "pg";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { visaoEmVigor } from "@/lib/ai/pontos/capacidade-em-vigor";
import { resolveOrgLlmConfig, type LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { createPool } from "@/lib/agent-engine/db/pool";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import { TIPOS_DERIVAVEIS } from "@/lib/messaging/media/derivable";
import { deriveVideoText } from "@/lib/messaging/media/video-derive";
import { apiTranscriptionProvider } from "@/lib/messaging/media/transcription";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const MEDIA_DERIVE_CONSUMER_KEY = "media_derive_v1";
const DRAIN_MAX_ATTEMPTS = 5; // espelho de lib/event-log/drain.ts

// Lista compartilhada com o drain do turno — ver lib/messaging/media/derivable.ts.

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
  if (!TIPOS_DERIVAVEIS.has(msg.type)) return { consumer_key, status: "skipped", detail: `type ${msg.type}` };
  // Vídeo é opt-in (custo: ffmpeg + N chamadas de visão): só deriva se algum agente
  // publicado da org tem video_frames_enabled=true (flag da migration 0058).
  if (msg.type === "video") {
    const { data: flag } = await admin
      .from("ai_agent_versions")
      .select("id")
      .eq("organization_id", row.organization_id)
      .eq("status", "published")
      .eq("video_frames_enabled", true)
      .limit(1)
      .maybeSingle();
    if (!flag) return { consumer_key, status: "skipped", detail: "video_frames_disabled" };
  }

  const markFailed = async () => {
    await admin.from("messages").update({ media_derived_status: "failed" })
      .eq("id", msg.id).eq("organization_id", msg.organization_id);
  };

  try {
    const dl = await admin.storage.from("whatsapp-media").download(msg.media_storage_path);
    if (dl.error || !dl.data) throw new Error(`storage_download_failed: ${dl.error?.message ?? "no_data"}`);
    const buffer = Buffer.from(await dl.data.arrayBuffer());

    // Credencial BYOK da org p/ visão (imagem).
    const llmCfg: LlmEdgeConfig = {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      // Sem esta linha, a instalação que escolheu OpenRouter no install.sh (a
      // primeira opção do menu) não tem chave nenhuma que este seam aceite:
      // toda derivação de mídia lança LlmNotConfiguredError ANTES de chegar ao
      // aviso, e o desfecho é 5 tentativas, media_derived_status='failed' e
      // ZERO avisos na Central — só um logger.error no log do contêiner.
      openrouterApiKey: process.env.OPENROUTER_API_KEY,
      cacheTtl: "1h",
    };
    let llm = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id);

    // ─── O painel de provedores manda AQUI também ────────────────────────────
    //
    // `visao_de_imagem` está no registro de pontos, sem `fixo`, e fora dos
    // pontos governados pela versão publicada — ou seja, a tela o oferece como
    // editável. Enquanto este worker resolvia só pela config da organização, o
    // operador escolhia um modelo com visão, a tela dizia "salvo", a linha
    // entrava em `ai_purpose_bindings` e a descrição de imagem seguia usando o
    // modelo padrão. É textualmente a classe de defeito que
    // `lib/ai/gateway-binding.ts` declara ter vindo matar — três pontos foram
    // fechados e este ficou igual.
    const bindingDaVisao = await lerBindingDoPonto(admin, row.organization_id, "visao_de_imagem");
    if (bindingDaVisao) {
      try {
        const comBinding = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id, {
          provider: bindingDaVisao.provider,
          credentialId: bindingDaVisao.credential_id,
        });
        llm = { ...comBinding, defaultModel: bindingDaVisao.model_id };
      } catch (err) {
        // Binding apontando para provedor sem chave não pode derrubar a
        // derivação inteira: cai no padrão da organização e AVISA, que é o
        // desfecho que deixa rastro em vez de silêncio.
        logger.warn("[media-derive] binding de visão sem credencial utilizável; usando o padrão da org", {
          organization_id: row.organization_id,
          provider: bindingDaVisao.provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // A transcrição é SEMPRE do Whisper (api.openai.com), então precisa de uma
    // chave OpenAI — não da chave do provedor de chat da org. O comentário
    // antigo já dizia isso ("senão exige credencial openai dedicada"), mas o
    // código passava `llm.apiKey` direto: numa org com Anthropic, a chave da
    // Anthropic era enviada para a OpenAI e voltava 401 em toda tentativa
    // (visto nesta VPS: media.derive_requested preso com transcription_401,
    // e o cliente ouvindo "não consigo ouvir áudio" com a chave certa no .env).
    let openaiKey: string | null = null;
    if (llm.provider === "openai") {
      openaiKey = llm.apiKey;
    } else {
      try {
        const oa = await resolveOrgLlmConfig(derivePool(), llmCfg, row.organization_id, {
          provider: "openai",
        });
        openaiKey = oa.apiKey;
      } catch {
        openaiKey = null; // sem credencial e sem OPENAI_API_KEY: áudio fica sem transcrição
      }
    }

    const deps = buildDeriveDeps(llm, openaiKey, row.organization_id, admin);

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

/**
 * Lê o binding de um ponto. Fora do `gateway-binding.ts` de propósito: aquele
 * módulo devolve um `LanguageModel` pronto do SDK, e aqui o que se precisa é do
 * par provider/modelo/credencial para alimentar `resolveOrgLlmConfig`, que é
 * quem sabe decifrar a chave BYOK desta organização.
 */
async function lerBindingDoPonto(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  purpose: string,
): Promise<{ provider: string; model_id: string; credential_id: string | null } | null> {
  const { data, error } = await admin
    .from("ai_purpose_bindings")
    .select("provider, model_id, credential_id")
    .eq("organization_id", organizationId)
    .eq("purpose", purpose)
    .eq("is_enabled", true)
    .maybeSingle();
  if (error) {
    logger.warn("[media-derive] não consegui ler o binding do ponto", {
      organization_id: organizationId,
      purpose,
      error: error.message,
    });
    return null;
  }
  return (data as { provider: string; model_id: string; credential_id: string | null } | null) ?? null;
}

function buildDeriveDeps(
  llm: { provider: string; apiKey: string; defaultModel: string | null },
  openaiKey: string | null,
  orgId: string,
  admin: ReturnType<typeof createAdminClient>,
): DeriveDeps {
  const registry = createDefaultRegistry();
  // Thunk, não consulta: nada vai ao banco até a visão ser de fato perguntada,
  // e num provedor direto `visaoEmVigor` nem pergunta.
  //
  // ⚠️ Por que a consulta é escrita aqui, e também em `media-parts.ts`, em vez de
  // morar num helper compartilhado: casar o client do Supabase contra a interface
  // estreita de um helper faz o checador estourar em TS2589 ("type instantiation
  // is excessively deep") — é o parser de colunas do PostgREST, não uma
  // incompatibilidade real. E ele estoura de forma DESIGUAL: `tsc --noEmit`
  // passava e o `next build` reprovava, no mesmo arquivo e na mesma linha, o que
  // torna o helper uma armadilha que só aparece no CI. O que precisava ser único
  // é a REGRA, e ela é: `visaoEmVigor` decide, aqui e em `media-parts.ts`.
  const catalogo = async (): Promise<boolean | null> => {
    const { data } = await admin
      .from("ai_models")
      .select("supports_vision")
      .eq("provider", llm.provider)
      .eq("model_id", llm.defaultModel ?? "")
      .is("deprecated_at", null)
      .maybeSingle();
    return data?.supports_vision ?? null;
  };
  const describeImage: DeriveDeps["describeImage"] = async (buffer, mime) => {
    // ⚠️ A resposta é resolvida AQUI, não na montagem das deps, porque num
    // roteador ela depende do catálogo e a consulta é assíncrona. Antes disto
    // a pergunta ia direto ao registro, que num roteador responde pelo prefixo
    // do fabricante: `openai/gpt-3.5-turbo` era dado como capaz de ver, a
    // chamada de visão saía e o aviso ao operador nunca abria.
    const visao = await visaoEmVigor({
      provider: llm.provider,
      modelId: llm.defaultModel ?? "",
      catalogo,
    });
    const visionCapable = visao.enxerga;
    // ─── Falha VISÍVEL, não string vazia ────────────────────────────────────
    //
    // Antes daqui, modelo sem visão devolvia "" e pronto: o cliente mandava a
    // foto do produto ou o comprovante, o agente respondia como se nada tivesse
    // chegado, e não havia erro, log nem aviso em lugar nenhum. Para quem
    // instalou, o produto parecia estar ignorando o cliente de propósito.
    //
    // Agora o texto derivado DIZ que a mídia não pôde ser lida — o agente passa
    // a saber que recebeu algo que não consegue interpretar, em vez de achar
    // que a mensagem veio vazia — e um aviso abre na Central para o operador
    // poder agir (invariante 7 da doutrina do Sistema Vivo: todo laço se fecha).
    if (!visionCapable) {
      // "não sei" e "não consegue" são estados diferentes, e o aviso precisa
      // dizer qual é. Um modelo que este registro não conhece cai em
      // `{image:false}` por conservadorismo — afirmar ao operador que ele "não
      // enxerga imagens" seria gravar uma alegação que ninguém verificou (e
      // era o que acontecia com todo modelo da OpenRouter).
      const motivo = visao.sabemos
        ? `o modelo ${llm.defaultModel ?? "configurado"} não enxerga imagens`
        : `não sei se o modelo ${llm.defaultModel ?? "configurado"} enxerga imagens, ` +
          `então não arrisquei enviar a foto — escolha um modelo do catálogo em Agente de IA → Provedores`;
      await avisarMidiaNaoLida(orgId, "imagem", motivo);
      return MARCADOR_NAO_LIDA;
    }
    const factory = registry[llm.provider];
    if (!factory) {
      await avisarMidiaNaoLida(orgId, "imagem", `o provedor ${llm.provider} não está disponível nesta instalação`);
      return MARCADOR_NAO_LIDA;
    }
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
  // Sem chave OpenAI não há como transcrever: devolver string vazia é honesto
  // (o derivado fica vazio e o marcador "[áudio]" continua valendo) e evita o
  // loop de 401 que retentava a cada drain.
  const transcriber: DeriveDeps["transcriber"] = openaiKey
    ? apiTranscriptionProvider({ apiKey: openaiKey })
    : {
        transcribe: async () => {
          // Mesma razão da visão: devolver "" fazia o agente responder ao áudio
          // como se ele não existisse. O aviso é o que dá ao operador a chance
          // de cadastrar a chave — sem ele, o sintoma é indistinguível de "o
          // agente é ruim".
          await avisarMidiaNaoLida(orgId, "áudio", "falta uma chave da OpenAI para transcrever");
          return MARCADOR_NAO_LIDA;
        },
      };
  return {
    transcriber,
    describeImage,
    extractPdf: extractPdfText,
    // Onda 3.1: vídeo → ffmpeg (áudio+frames) reusando transcrição e visão da org.
    deriveVideo: (buffer) => deriveVideoText(buffer, { transcriber, describeImage }),
  };
}

/**
 * O texto que substitui a string vazia quando a mídia não pôde ser lida.
 *
 * Não é cosmético: o agente recebe este texto como derivado da mensagem, então
 * ele passa a SABER que chegou algo que não conseguiu interpretar, em vez de
 * concluir que a mensagem veio vazia. A diferença aparece na resposta ao
 * cliente — "não consegui abrir sua foto, pode me dizer o que é?" no lugar de
 * um silêncio que parece descaso.
 */
export const MARCADOR_NAO_LIDA = "[o cliente enviou uma mídia que não consegui interpretar]";

/**
 * Abre UM aviso na Central por organização enquanto o problema durar.
 *
 * Um aviso por mensagem inundaria a Central numa operação com volume — e
 * Central inundada é Central que ninguém abre, que é como o alerta morre. A
 * condição de não-duplicar é a mesma que `budget_exceeded` já usa: enquanto
 * houver item aberto do mesmo kind, recusas novas não criam outro.
 *
 * Fire-and-forget: falhar ao avisar não pode derrubar a derivação da mídia.
 */
async function avisarMidiaNaoLida(
  organizationId: string,
  tipo: string,
  motivo: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "midia_nao_lida")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (jaAberto) return;

    // `warn`, não `warning`: o CHECK de `agent_inbox_items.severity` aceita
    // info|warn|critical. Com o valor errado o INSERT era recusado com 23514 —
    // e o aviso NUNCA abria. A Central ficava vazia exatamente no caso que esta
    // função existe para tornar visível.
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: organizationId,
      kind: "midia_nao_lida",
      severity: "warn",
      title: `O agente não conseguiu ler ${tipo} que o cliente enviou`,
      body:
        `Motivo: ${motivo}. Enquanto isso, o agente responde avisando que não conseguiu abrir o arquivo. ` +
        `Para resolver, ajuste o modelo desse ponto em Agente de IA → Provedores, ou cadastre a chave necessária em Credenciais.`,
    });
    // E o retorno é CONFERIDO. O supabase-js devolve `{ error }` em vez de
    // lançar, então o `catch` abaixo era inalcançável para erro de banco: a
    // recusa era engolida, o worker devolvia "ok" e nada era logado. Um aviso
    // que falha em silêncio é pior que aviso nenhum — ele faz o próximo
    // diagnóstico começar da premissa errada.
    if (error) {
      logger.warn("[media-derive] o banco recusou o aviso de mídia não lida", {
        organization_id: organizationId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("[media-derive] não consegui abrir o aviso de mídia não lida", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
