/**
 * Parte NATIVA de mídia para o turno (Onda 3, camada de aprimoramento).
 * Capability-gated: só emite image/file para provider+modelo conhecidos por
 * aceitá-los; caso contrário [] e o derivado textual (já no contexto) cobre.
 * Usa signed URL curta do bucket privado — o provider baixa, nunca base64.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { modelCapabilities } from "@/lib/agent-engine/edge/llm/capabilities";
import { visaoEmVigor } from "@/lib/ai/pontos/capacidade-em-vigor";


/**
 * AI SDK v7: imagem E pdf vão como `file` part com `mediaType` (o antigo
 * `{type:'image', image}` foi DEPRECATED e o provider não o processa). `data`
 * são os BYTES inline (Buffer do Node), não uma URL: passar signed URL faria o
 * provider baixá-la pelo seu fetch CONTIDO (allowlist só do endpoint do vendor),
 * bloqueando o supabase.co — a imagem nunca chegava ao modelo. Baixamos os
 * bytes aqui (admin client) e mandamos direto.
 */
export type NativeMediaPart = { type: "file"; data: Buffer; mediaType: string };

export interface BuildNativeMediaPartsArgs {
  messages: LeadContextMessage[];
  provider: string;
  model: string;
  multimodalInput: boolean;
  admin: SupabaseClient;
  /** teto de mídias anexadas (default 1: só a inbound mais recente). */
  maxItems?: number;
}

export async function buildNativeMediaParts(args: BuildNativeMediaPartsArgs): Promise<NativeMediaPart[]> {
  if (!args.multimodalInput) return [];
  // ⚠️ A imagem NÃO pergunta ao registro direto. Num roteador (openrouter) o
  // registro responde pelo prefixo do fabricante — `openai/gpt-3.5-turbo` casa
  // `openai/` e o registro afirma que enxerga, quando não enxerga. Anexar a
  // parte nativa ali manda bytes que o provedor recusa, e o custo é o turno,
  // não um aviso. `visaoEmVigor` deixa o catálogo (sincronizado das
  // modalidades que a própria OpenRouter declara) decidir nesse caso, e só
  // nesse — no provedor direto ele nem toca o banco.
  //
  // O PDF continua no registro: o catálogo não tem coluna de PDF, então não há
  // medida para preferir ao palpite.
  //
  // ⚠️ A consulta é escrita aqui, e no worker também, em vez de morar num helper
  // compartilhado: casar o client do Supabase contra a interface estreita de um
  // helper faz o checador estourar em TS2589 ("type instantiation is excessively
  // deep") — é o parser de colunas do PostgREST, não incompatibilidade real. E
  // ele estoura de forma DESIGUAL: `tsc --noEmit` passava e o `next build`
  // reprovava, no mesmo arquivo e na mesma linha. O que precisava ser único é a
  // REGRA, e ela é: `visaoEmVigor` decide aqui e em `media-derive-worker.ts`.
  const catalogo = async (): Promise<boolean | null> => {
    const { data } = await args.admin
      .from("ai_models")
      .select("supports_vision")
      .eq("provider", args.provider)
      .eq("model_id", args.model)
      .is("deprecated_at", null)
      .maybeSingle();
    return (data?.supports_vision as boolean | null) ?? null;
  };
  const caps = {
    image: (await visaoEmVigor({ provider: args.provider, modelId: args.model, catalogo })).enxerga,
    pdf: modelCapabilities(args.provider, args.model).pdf,
  };
  if (!caps.image && !caps.pdf) return [];

  const maxItems = args.maxItems ?? 1;
  // Gate é "o turno atual tem mídia", não "existe mídia recente no histórico" — senão
  // uma imagem enviada 3 mensagens atrás seria re-anexada (e re-cobrada da visão) em
  // todo turno de texto seguinte. Acha a última inbound (qualquer tipo); só vira
  // candidata se ELA MESMA carrega mídia. WhatsApp = 1 mídia/msg, então isso já é
  // no máximo 1 item — maxItems fica só como teto declarado na assinatura.
  const latestInbound = [...args.messages].reverse().find((m) => m.direction === "inbound");
  const candidates = latestInbound?.media_storage_path ? [latestInbound].slice(0, maxItems) : [];

  const parts: NativeMediaPart[] = [];
  // ponytail: esta camada é aprimoramento, não caminho crítico — o derivado textual
  // (já embutido no contexto via LeadContextMessage) é o fallback universal. Uma
  // exceção aqui NUNCA pode abortar o turno inteiro, então falha vira "pula o item"
  // (try interno) ou, no limite, "devolve o que já juntou" (try externo).
  try {
    for (const m of candidates) {
      try {
        const mime = (m.media_mime ?? "").split(";")[0]!.trim().toLowerCase();
        const isImage = m.type === "image" && mime.startsWith("image/") && caps.image;
        const isPdf = m.type === "document" && mime === "application/pdf" && caps.pdf;
        if (!isImage && !isPdf) continue;

        const dl = await args.admin.storage.from("whatsapp-media").download(m.media_storage_path!);
        if (dl.error || !dl.data) continue;
        // Buffer do Node (não Uint8Array cru) — mesmo shape que o derive worker usa
        // com sucesso; alguns adapters do AI SDK tratam Buffer e Uint8Array diferente.
        const bytes = Buffer.from(await dl.data.arrayBuffer());
        // file part com mediaType p/ imagem e pdf; bytes inline (sem URL p/ o provider baixar).
        parts.push({ type: "file", data: bytes, mediaType: isImage ? mime : "application/pdf" });
      } catch {
        continue;
      }
    }
  } catch {
    return parts;
  }
  return parts;
}
