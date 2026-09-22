/**
 * Backfill de endereço/fiscal nos contatos a partir do clientes-final.json
 * (dados do WP). Só preenche o que está vazio — nunca sobrescreve edição.
 *
 * Uso: pnpm exec tsx scripts/mercos-scrape/backfill-endereco.ts --org <uuid> [--apply]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { carregarEnvLocal } from "../lib/env-de-teste";

const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

function digitos(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

function forte(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(LTDA|ME|EPP|EIRELI|CIA|COMERCIO|COM|E|DE|DA|DO|DOS|DAS|SA|S)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  const base = JSON.parse(readFileSync(join(SAIDA, "clientes-final.json"), "utf8")) as {
    nome: string; fones: string; endereco: string | null; cidade: string | null; uf: string | null;
    documento: string | null; fantasia: string; tipo: string; ie: string; num: string;
    bairro: string; cep: string; email: string | null;
  }[];

  // Mapas id por documento/telefone/nome (paginado: limite de 1000 do PostgREST).
  const porDoc = new Map<string, string>();
  const porFone = new Map<string, string>();
  const porNome = new Map<string, string>();
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, cnpj, phone_number, name, display_name")
      .eq("organization_id", orgId)
      .range(de, de + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const c of data as { id: string; cnpj: string | null; phone_number: string | null; name: string | null; display_name: string | null }[]) {
      if (c.cnpj && digitos(c.cnpj)) porDoc.set(digitos(c.cnpj), c.id);
      if (c.phone_number) porFone.set(digitos(c.phone_number), c.id);
      const n = forte(c.display_name ?? c.name);
      if (n) porNome.set(n, c.id);
    }
    if (data.length < 1000) break;
  }

  let achados = 0;
  let atualizados = 0;
  const pendentes: { id: string; row: Record<string, unknown> }[] = [];
  for (const c of base) {
    const doc = digitos(c.documento);
    const fone = digitos((c.fones ?? "").split("/")[0]);
    const id = (doc && porDoc.get(doc)) || (fone && porFone.get(fone)) || porNome.get(forte(c.nome));
    if (!id) continue;
    achados++;
    const cep = digitos(c.cep);
    pendentes.push({
      id,
      row: {
        tipo_pessoa: /JURIDICA/i.test(c.tipo ?? "") ? "J" : /FISICA/i.test(c.tipo ?? "") ? "F" : null,
        fantasia: (c.fantasia ?? "").trim() || null,
        ie: (c.ie ?? "").trim() || null,
        logradouro: (c.endereco ?? "").trim() || null,
        numero_end: (c.num ?? "").trim() || null,
        bairro: (c.bairro ?? "").trim() || null,
        cidade: (c.cidade ?? "").trim() || null,
        uf: (c.uf ?? "").trim().toUpperCase().slice(0, 2) || null,
        cep: cep.length === 8 ? cep : null,
      },
    });
  }

  if (apply) {
    for (const p of pendentes) {
      // Só preenche vazio: lê antes para não apagar edição manual.
      const { data: atual } = await admin
        .from("contacts")
        .select("tipo_pessoa, fantasia, ie, logradouro, numero_end, bairro, cidade, uf, cep")
        .eq("id", p.id)
        .maybeSingle();
      const a = (atual ?? {}) as Record<string, string | null>;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.row)) {
        if (v != null && (a[k] == null || a[k] === "")) patch[k] = v;
      }
      if (Object.keys(patch).length === 0) continue;
      const { error } = await admin.from("contacts").update(patch).eq("id", p.id);
      if (!error) atualizados++;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`endereco: ${achados} vinculados, ${apply ? atualizados : pendentes.length} para atualizar${apply ? "" : " (dry-run)"}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
