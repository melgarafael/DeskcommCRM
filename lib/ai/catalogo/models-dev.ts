import { z } from "zod";

import type { createAdminClient } from "@/lib/supabase/admin";

import type { LinhaDeCatalogo } from "./openrouter";

export const FONTE_MODELS_DEV = "models.dev";

const modelo = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  name: z.string().trim().min(1),
  description: z.string().optional(),
  tool_call: z.boolean(),
  type: z.string().optional(),
  status: z.string().optional(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }),
  limit: z.object({ context: z.number().int().nonnegative().optional() }),
  cost: z
    .object({
      input: z.number().nonnegative().optional(),
      output: z.number().nonnegative().optional(),
    })
    .optional(),
});
const provedor = z.object({ models: z.record(z.string(), modelo) });
const catalogo = z.object({ openai: provedor, anthropic: provedor });

/** IDs do endpoint NATIVO, sem converter os aliases de um gateway em nomes do fabricante. */
export function traduzirCatalogoNativo(resposta: unknown): LinhaDeCatalogo[] {
  const validado = catalogo.parse(resposta);
  return Object.entries(validado).flatMap(([provider, dados]) =>
    Object.entries(dados.models).flatMap(([id, m]): LinhaDeCatalogo[] => {
      if (id !== m.id) throw new Error("catalogo_nativo_id_divergente");
      if (
        m.status === "deprecated" ||
        (m.type !== undefined && m.type !== "chat") ||
        !m.tool_call ||
        !m.modalities.input.includes("text") ||
        !m.modalities.output.includes("text")
      )
        return [];
      return [
        {
          provider,
          model_id: m.id,
          display_name: m.name,
          description: m.description?.slice(0, 300) ?? null,
          context_window: m.limit.context || null,
          input_price_per_million_cents:
            m.cost?.input === undefined ? null : Math.ceil(m.cost.input * 100),
          output_price_per_million_cents:
            m.cost?.output === undefined ? null : Math.ceil(m.cost.output * 100),
          supports_tools: m.tool_call,
          supports_vision: m.modalities.input.includes("image"),
          source: FONTE_MODELS_DEV,
        },
      ];
    }),
  );
}

/**
 * Catálogo público: https://github.com/anomalyco/models.dev#api.
 * Só acrescenta modelos. Ausência num agregador não confirma aposentadoria no
 * fabricante; conflito preserva inclusive curadoria e depreciação manuais.
 */
export async function sincronizarModelosNativos(
  admin: ReturnType<typeof createAdminClient>,
  buscar: () => Promise<unknown> = buscarCatalogoNativo,
) {
  const linhas = traduzirCatalogoNativo(await buscar());
  if (
    !["openai", "anthropic"].every((provider) =>
      linhas.some((linha) => linha.provider === provider),
    )
  ) {
    throw new Error("catalogo_nativo_vazio");
  }
  const agora = new Date().toISOString();
  const { data, error } = await admin
    .from("ai_models")
    .upsert(
      linhas.map((linha) => ({ ...linha, synced_at: agora })),
      { onConflict: "provider,model_id", ignoreDuplicates: true },
    )
    .select("provider,model_id");
  if (error) throw new Error(`catalogo_nativo_gravacao_falhou: ${error.message}`);
  return { fonte: FONTE_MODELS_DEV, recebidos: linhas.length, gravados: data?.length ?? 0 };
}

async function buscarCatalogoNativo(): Promise<unknown> {
  const resposta = await fetch("https://models.dev/api.json", {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!resposta.ok) throw new Error(`catalogo_nativo_status_${resposta.status}`);
  return resposta.json();
}
