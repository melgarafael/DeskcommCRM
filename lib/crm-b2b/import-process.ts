/**
 * Processador de import companies/people/contacts.
 * NÃO cria crm_leads. Reusa normalizePhoneBR. Dedup por regras da Fase 1.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { enrichCompanyFromBrasilApi } from "@/lib/crm-b2b/enrich";
import { normalizeCnpj, normalizePersonName } from "@/lib/crm-b2b/normalize";
import {
  applyMapping,
  type MappingField,
  type SheetMatrix,
} from "@/lib/crm-b2b/spreadsheet";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

type SB = SupabaseClient;

export interface ProcessImportOpts {
  organizationId: string;
  batchId: string;
  userId: string;
  sheet: SheetMatrix;
  mapping: Partial<Record<MappingField, string>>;
  enrichCompanies?: boolean;
}

export interface ProcessImportResult {
  successful_rows: number;
  failed_rows: number;
  conflict_rows: number;
  processed_rows: number;
}

type CompanyCacheKey = string; // normalized_cnpj OR __name__:normalized trade/legal
type PersonCacheKey = string; // companyId + '|' + normalized_name

export async function processCompaniesPeopleImport(
  supabase: SB,
  opts: ProcessImportOpts,
): Promise<ProcessImportResult> {
  const { organizationId, batchId, userId, sheet, mapping } = opts;
  const enrich = opts.enrichCompanies !== false;

  await supabase
    .from("import_batches")
    .update({
      status: "processing",
      total_rows: sheet.rows.length,
      column_mapping: mapping,
    })
    .eq("id", batchId)
    .eq("organization_id", organizationId);

  const companyByKey = new Map<CompanyCacheKey, string>();
  const personByKey = new Map<PersonCacheKey, string>();
  const companiesToEnrich = new Set<string>();

  let successful = 0;
  let failed = 0;
  let conflict = 0;

  for (let i = 0; i < sheet.rows.length; i++) {
    const rowNumber = i + 2; // 1-based data with header on line 1
    const rawCells = sheet.rows[i]!;
    const rawObj: Record<string, string> = {};
    sheet.headers.forEach((h, idx) => {
      rawObj[h] = rawCells[idx] ?? "";
    });
    const mapped = applyMapping(sheet.headers, rawCells, mapping);

    const rowInsert = {
      organization_id: organizationId,
      batch_id: batchId,
      row_number: rowNumber,
      raw_data: rawObj,
      normalized_data: mapped,
      status: "processing" as const,
    };

    const { data: rowRec, error: rowErr } = await supabase
      .from("import_rows")
      .insert(rowInsert)
      .select("id")
      .single();

    if (rowErr || !rowRec) {
      failed += 1;
      continue;
    }
    const rowId = rowRec.id as string;

    try {
      const outcome = await processOneRow(supabase, {
        organizationId,
        userId,
        mapped,
        companyByKey,
        personByKey,
        companiesToEnrich,
      });

      await supabase
        .from("import_rows")
        .update({
          status: outcome.status,
          error: outcome.error ?? null,
          company_id: outcome.companyId ?? null,
          person_id: outcome.personId ?? null,
          contact_id: outcome.contactId ?? null,
          normalized_data: {
            ...mapped,
            phone_e164: outcome.phoneE164 ?? null,
            normalized_cnpj: outcome.normalizedCnpj ?? null,
          },
        })
        .eq("id", rowId)
        .eq("organization_id", organizationId);

      if (outcome.status === "success") successful += 1;
      else if (outcome.status === "conflict") conflict += 1;
      else failed += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "erro desconhecido";
      await supabase
        .from("import_rows")
        .update({ status: "failed", error: msg })
        .eq("id", rowId)
        .eq("organization_id", organizationId);
      failed += 1;
    }
  }

  if (enrich) {
    for (const companyId of companiesToEnrich) {
      // Não bloqueia o lote: falha de enriquecimento fica no status da empresa.
      void enrichCompanyFromBrasilApi(supabase, { organizationId, companyId });
    }
  }

  const processed = successful + failed + conflict;
  await supabase
    .from("import_batches")
    .update({
      status: "completed",
      processed_rows: processed,
      successful_rows: successful,
      failed_rows: failed,
      conflict_rows: conflict,
      completed_at: new Date().toISOString(),
    })
    .eq("id", batchId)
    .eq("organization_id", organizationId);

  return {
    successful_rows: successful,
    failed_rows: failed,
    conflict_rows: conflict,
    processed_rows: processed,
  };
}

async function processOneRow(
  supabase: SB,
  ctx: {
    organizationId: string;
    userId: string;
    mapped: Record<MappingField, string>;
    companyByKey: Map<string, string>;
    personByKey: Map<string, string>;
    companiesToEnrich: Set<string>;
  },
): Promise<{
  status: "success" | "conflict" | "failed";
  error?: string;
  companyId?: string;
  personId?: string;
  contactId?: string;
  phoneE164?: string | null;
  normalizedCnpj?: string | null;
}> {
  const { organizationId, userId, mapped } = ctx;
  const phoneE164 = mapped.phone ? normalizePhoneBR(mapped.phone) : null;
  const normalizedCnpj = mapped.cnpj ? normalizeCnpj(mapped.cnpj) : null;
  const personName = mapped.person_name.trim();
  const trade =
    mapped.trade_name.trim() ||
    mapped.company_name.trim() ||
    mapped.legal_name.trim() ||
    "";
  const legal = mapped.legal_name.trim() || mapped.company_name.trim() || trade;

  // Linha sem nada útil
  if (!trade && !legal && !normalizedCnpj && !personName && !phoneE164) {
    return { status: "failed", error: "Linha vazia — sem empresa, pessoa ou telefone." };
  }

  // Telefone inválido quando informado
  if (mapped.phone.trim() && !phoneE164) {
    return { status: "failed", error: "Telefone inválido.", phoneE164: null, normalizedCnpj };
  }

  // --- Company ---
  let companyId: string | undefined;
  if (trade || legal || normalizedCnpj) {
    const cacheKey = normalizedCnpj
      ? `cnpj:${normalizedCnpj}`
      : `name:${normalizePersonName(trade || legal) ?? (trade || legal).toLowerCase()}`;

    const cached = ctx.companyByKey.get(cacheKey);
    if (cached) {
      companyId = cached;
    } else if (normalizedCnpj) {
      const { data: existing } = await supabase
        .from("companies")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("normalized_cnpj", normalizedCnpj)
        .maybeSingle();
      if (existing) {
        companyId = existing.id as string;
      } else {
        const { data: created, error } = await supabase
          .from("companies")
          .insert({
            organization_id: organizationId,
            legal_name: legal || null,
            trade_name: trade || legal || null,
            cnpj: normalizedCnpj,
            normalized_cnpj: normalizedCnpj,
            enrichment_status: "pending",
            created_by: userId,
          })
          .select("id")
          .single();
        if (error || !created) {
          return { status: "failed", error: error?.message ?? "falha ao criar empresa", normalizedCnpj };
        }
        companyId = created.id as string;
        ctx.companiesToEnrich.add(companyId);
      }
      ctx.companyByKey.set(cacheKey, companyId);
    } else {
      // Sem CNPJ: agrupa só dentro do lote pelo nome (não dedupa no banco por nome).
      const { data: created, error } = await supabase
        .from("companies")
        .insert({
          organization_id: organizationId,
          legal_name: legal || null,
          trade_name: trade || null,
          enrichment_status: "pending",
          created_by: userId,
        })
        .select("id")
        .single();
      if (error || !created) {
        return { status: "failed", error: error?.message ?? "falha ao criar empresa" };
      }
      companyId = created.id as string;
      ctx.companyByKey.set(cacheKey, companyId);
    }
  }

  // --- Person ---
  let personId: string | undefined;
  if (personName) {
    const nName = normalizePersonName(personName) ?? personName.toLowerCase();
    const pKey = `${companyId ?? "none"}|${nName}`;
    const cachedP = ctx.personByKey.get(pKey);
    if (cachedP) {
      personId = cachedP;
    } else {
      const { data: created, error } = await supabase
        .from("people")
        .insert({
          organization_id: organizationId,
          full_name: personName,
          normalized_name: nName,
          email: mapped.email.trim() || null,
          created_by: userId,
        })
        .select("id")
        .single();
      if (error || !created) {
        return {
          status: "failed",
          error: error?.message ?? "falha ao criar pessoa",
          companyId,
          normalizedCnpj,
        };
      }
      personId = created.id as string;
      ctx.personByKey.set(pKey, personId);

      if (companyId) {
        await supabase.from("company_people").upsert(
          {
            organization_id: organizationId,
            company_id: companyId,
            person_id: personId,
            job_title: mapped.job_title.trim() || null,
            is_decision_maker: true,
          },
          { onConflict: "company_id,person_id", ignoreDuplicates: true },
        );
      }
    }
  }

  // --- Contact / phone ---
  let contactId: string | undefined;
  if (phoneE164) {
    const variants = phoneLookupVariants(phoneE164);
    let existing: { id: string; person_id: string | null } | null = null;
    for (const v of variants.length ? variants : [phoneE164]) {
      const { data } = await supabase
        .from("contacts")
        .select("id, person_id")
        .eq("organization_id", organizationId)
        .eq("phone_number", v)
        .is("is_merged_into", null)
        .maybeSingle();
      if (data) {
        existing = data as { id: string; person_id: string | null };
        break;
      }
    }

    if (existing) {
      if (existing.person_id && personId && existing.person_id !== personId) {
        return {
          status: "conflict",
          error: `Telefone ${phoneE164} já vinculado a outra pessoa.`,
          companyId,
          personId,
          contactId: existing.id,
          phoneE164,
          normalizedCnpj,
        };
      }
      contactId = existing.id;
      if (!existing.person_id && personId) {
        await supabase
          .from("contacts")
          .update({ person_id: personId })
          .eq("id", contactId)
          .eq("organization_id", organizationId);
      }
    } else {
      if (!phoneE164) {
        return { status: "failed", error: "Telefone obrigatório para criar contact." };
      }
      const { data: created, error } = await supabase
        .from("contacts")
        .insert({
          organization_id: organizationId,
          name: personName || trade || phoneE164,
          display_name: personName || trade || phoneE164,
          phone_number: phoneE164,
          email: mapped.email.trim() || null,
          person_id: personId ?? null,
          source: "import_csv",
          source_metadata: { import_batch_id: true },
          created_by_user_id: userId,
        })
        .select("id")
        .single();
      if (error || !created) {
        // 23505 race → conflict
        if (error?.code === "23505") {
          return {
            status: "conflict",
            error: `Telefone ${phoneE164} já existe (conflito de unicidade).`,
            companyId,
            personId,
            phoneE164,
            normalizedCnpj,
          };
        }
        return {
          status: "failed",
          error: error?.message ?? "falha ao criar contact",
          companyId,
          personId,
          phoneE164,
          normalizedCnpj,
        };
      }
      contactId = created.id as string;
    }
  }

  // Sucesso parcial: só empresa/pessoa sem telefone também conta
  if (!companyId && !personId && !contactId) {
    return { status: "failed", error: "Nada a importar na linha.", phoneE164, normalizedCnpj };
  }

  return {
    status: "success",
    companyId,
    personId,
    contactId,
    phoneE164,
    normalizedCnpj,
  };
}
