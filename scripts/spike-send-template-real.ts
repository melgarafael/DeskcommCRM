/**
 * Spike da Fase 4 Task 4: dispara um template REAL pelo caminho completo
 * (`sendTemplate` → bind → buildComponents → Graph API), no número de teste.
 *
 * ECONÔMICO DE PROPÓSITO: **um envio**. É o celular de uma pessoa.
 *
 *   pnpm exec tsx --env-file=.env.local scripts/spike-send-template-real.ts
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { graphVersion } from "@/lib/graph-version";
import { sendTemplate } from "@/lib/channels/meta/send-template";

const TEMPLATE = "deskcomm_prova_webhook_0088";
const IDIOMA = "pt_BR";
const DESTINO = "5531998966398";

async function main() {
  const db = createAdminClient();

  const { data: linha, error } = await db
    .from("meta_templates")
    .select("name, language, status, contract_hash, components")
    .eq("name", TEMPLATE)
    .eq("language", IDIOMA)
    .maybeSingle();

  if (error || !linha) throw new Error(`espelho sem ${TEMPLATE}: ${error?.message ?? "nenhuma linha"}`);

  console.info(`espelho: ${linha.name} (${linha.language}) status=${linha.status}`);
  console.info(`hash vigente: ${String(linha.contract_hash).slice(0, 16)}…`);

  const resultado = await sendTemplate({
    phoneNumberId: process.env.META_PHONE_NUMBER_ID ?? "",
    token: process.env.META_SYSTEM_USER_TOKEN ?? "",
    graphVersion: graphVersion(),
    to: DESTINO,
    binding: {
      name: linha.name,
      language: linha.language,
      // O hash vem do espelho: é exatamente o que a trava compara. Digitá-lo aqui
      // seria simular o bind em vez de exercitá-lo.
      contractHash: linha.contract_hash,
      values: { "1": "Rafael", "2": "AT-0088" },
    },
    current: {
      name: linha.name,
      language: linha.language,
      contractHash: linha.contract_hash,
      status: linha.status,
      components: linha.components,
    },
  });

  console.info("resultado:", JSON.stringify(resultado));
}

void main();
