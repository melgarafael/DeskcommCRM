/**
 * Backfill de endereco_entrega nos pedidos a partir do endereço do contato.
 *
 * O detalhe do Mercos dizia "End. de entrega: Endereço principal do cliente",
 * mas a importação nunca gravou endereco_entrega — por isso romaneio, mapa e
 * impressão mostravam "Endereço não informado" para cliente COM endereço.
 * Só preenche o que está vazio — nunca sobrescreve edição.
 *
 * Uso: pnpm exec tsx scripts/mercos-scrape/backfill-endereco-entrega.ts --org <uuid> [--apply]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { enderecoEmLinha } from "../../lib/contacts/endereco-em-linha";
import { carregarEnvLocal } from "../lib/env-de-teste";

interface EnderecoContato {
  logradouro: string | null;
  numero_end: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--org");
  const orgId = i >= 0 ? process.argv[i + 1] : null;
  if (!orgId) throw new Error("Passe --org <uuid>.");
  const apply = process.argv.includes("--apply");

  const env = carregarEnvLocal();
  const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // --normalizar: colapsa o artefato do WP (", 65, 65 —" → ", 65 —") nas
  // linhas já gravadas antes da deduplicação do formatador. Só toca o padrão
  // exato da duplicação — edição manual sem esse padrão passa ilesa.
  if (process.argv.includes("--normalizar")) {
    const DUP = /,\s*([A-Za-z0-9/.]+),\s*\1(\s*—)/;
    let normalizados = 0;
    for (let de = 0; ; de += 1000) {
      const { data, error } = await admin
        .from("commercial_orders")
        .select("id, endereco_entrega")
        .eq("organization_id", orgId)
        .range(de, de + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const p of data as { id: string; endereco_entrega: string | null }[]) {
        const atual = p.endereco_entrega ?? "";
        if (!DUP.test(atual)) continue;
        const novo = atual.replace(DUP, ", $1$2");
        if (!apply) {
          normalizados++;
          continue;
        }
        const { error: eUp } = await admin.from("commercial_orders").update({ endereco_entrega: novo }).eq("id", p.id);
        if (!eUp) normalizados++;
      }
      if (data.length < 1000) break;
    }
    // eslint-disable-next-line no-console
    console.log(`endereco_entrega: ${normalizados} normalizados${apply ? "" : " (dry-run)"}`);
    return;
  }

  // Mapa contact_id → endereço em linha (só contatos com alguma parte).
  const enderecos = new Map<string, string>();
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, logradouro, numero_end, complemento, bairro, cidade, uf, cep")
      .eq("organization_id", orgId)
      .range(de, de + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const c of data as ({ id: string } & EnderecoContato)[]) {
      const linha = enderecoEmLinha(c);
      if (linha) enderecos.set(c.id, linha);
    }
    if (data.length < 1000) break;
  }

  // Pedidos sem endereço de entrega mas com cliente vinculado.
  let semEndereco = 0;
  let preenchiveis = 0;
  let atualizados = 0;
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin
      .from("commercial_orders")
      .select("id, contact_id, endereco_entrega")
      .eq("organization_id", orgId)
      .range(de, de + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const p of data as { id: string; contact_id: string | null; endereco_entrega: string | null }[]) {
      if (p.endereco_entrega?.trim() || !p.contact_id) continue;
      semEndereco++;
      const linha = enderecos.get(p.contact_id);
      if (!linha) continue;
      preenchiveis++;
      if (!apply) continue;
      const { error: eUp } = await admin
        .from("commercial_orders")
        .update({ endereco_entrega: linha })
        .eq("id", p.id);
      if (!eUp) atualizados++;
    }
    if (data.length < 1000) break;
  }
  // eslint-disable-next-line no-console
  console.log(
    `endereco_entrega: ${semEndereco} pedidos sem endereço, ${apply ? atualizados : preenchiveis} ` +
      `${apply ? "preenchidos" : "preenchíveis (dry-run)"}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
