/**
 * Materializa audiência em whatsapp_campaign_recipients (server-side).
 * Batch: contacts/people/company_people em poucas queries IN — não 1×N por contact.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  firstNameFrom,
  renderCampaignTemplate,
} from "@/lib/whatsapp-campaigns/template";

export interface AudienceSelection {
  contact_ids?: string[];
  person_ids?: string[];
  company_ids?: string[];
  import_batch_id?: string;
}

export interface MaterializeResult {
  total: number;
  eligible: number;
  skipped: number;
  skipped_reasons: Record<string, number>;
}

const CHUNK = 200;

function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
}

export async function materializeCampaignAudience(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    campaignId: string;
    channelSessionId: string;
    messageTemplate: string;
    selection: AudienceSelection;
  },
): Promise<MaterializeResult> {
  const contactIds = new Set<string>(opts.selection.contact_ids ?? []);

  if (opts.selection.person_ids?.length) {
    for (const part of chunkIds(opts.selection.person_ids)) {
      const { data } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", opts.organizationId)
        .in("person_id", part)
        .is("is_merged_into", null);
      for (const r of data ?? []) contactIds.add(r.id);
    }
  }

  if (opts.selection.company_ids?.length) {
    const personIds = new Set<string>();
    for (const part of chunkIds(opts.selection.company_ids)) {
      const { data: links } = await admin
        .from("company_people")
        .select("person_id")
        .eq("organization_id", opts.organizationId)
        .in("company_id", part);
      for (const l of links ?? []) personIds.add(l.person_id as string);
    }
    for (const part of chunkIds([...personIds])) {
      const { data } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", opts.organizationId)
        .in("person_id", part)
        .is("is_merged_into", null);
      for (const r of data ?? []) contactIds.add(r.id);
    }
  }

  if (opts.selection.import_batch_id) {
    const { data: rows } = await admin
      .from("import_rows")
      .select("contact_id")
      .eq("organization_id", opts.organizationId)
      .eq("batch_id", opts.selection.import_batch_id)
      .eq("status", "success")
      .not("contact_id", "is", null);
    for (const r of rows ?? []) {
      if (r.contact_id) contactIds.add(r.contact_id as string);
    }
  }

  const allIds = [...contactIds];
  const skipped_reasons: Record<string, number> = {};
  let eligible = 0;
  let skipped = 0;

  // Prefetch contacts + pessoas + vínculos em lote
  type ContactRow = {
    id: string;
    organization_id: string;
    phone_number: string | null;
    display_name: string | null;
    name: string | null;
    person_id: string | null;
    is_blocked: boolean;
    is_anonymized: boolean | null;
    is_merged_into: string | null;
    blocked_reason: string | null;
  };
  const contactsById = new Map<string, ContactRow>();
  for (const part of chunkIds(allIds)) {
    const { data } = await admin
      .from("contacts")
      .select(
        "id, organization_id, phone_number, display_name, name, person_id, is_blocked, is_anonymized, is_merged_into, blocked_reason",
      )
      .eq("organization_id", opts.organizationId)
      .in("id", part);
    for (const c of data ?? []) contactsById.set(c.id, c as ContactRow);
  }

  const personIds = [
    ...new Set(
      [...contactsById.values()]
        .map((c) => c.person_id)
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const peopleById = new Map<string, string>();
  const companyByPerson = new Map<
    string,
    { company_id: string; legal_name: string | null; trade_name: string | null }
  >();

  for (const part of chunkIds(personIds)) {
    const { data: people } = await admin
      .from("people")
      .select("id, full_name")
      .eq("organization_id", opts.organizationId)
      .in("id", part);
    for (const p of people ?? []) peopleById.set(p.id, p.full_name);

    const { data: links } = await admin
      .from("company_people")
      .select("person_id, company_id, companies:company_id(id, trade_name, legal_name)")
      .eq("organization_id", opts.organizationId)
      .in("person_id", part);
    for (const link of links ?? []) {
      if (companyByPerson.has(link.person_id as string)) continue;
      const co = link.companies as {
        trade_name?: string | null;
        legal_name?: string | null;
      } | null;
      companyByPerson.set(link.person_id as string, {
        company_id: link.company_id as string,
        legal_name: co?.legal_name ?? null,
        trade_name: co?.trade_name ?? null,
      });
    }
  }

  const pendingUpserts: Record<string, unknown>[] = [];
  const skippedUpserts: Record<string, unknown>[] = [];

  for (const contactId of allIds) {
    const row = contactsById.get(contactId);
    const elig = row
      ? await checkContactEligibilityFromRow(opts.organizationId, row)
      : ({ ok: false, reason: "cross_tenant" } as const);

    if (!elig.ok) {
      skipped += 1;
      skipped_reasons[elig.reason] = (skipped_reasons[elig.reason] ?? 0) + 1;
      skippedUpserts.push({
        organization_id: opts.organizationId,
        campaign_id: opts.campaignId,
        contact_id: contactId,
        channel_session_id: opts.channelSessionId,
        phone_number_snapshot: row?.phone_number ?? "unknown",
        status: "skipped",
        skipped_reason: elig.reason,
      });
      continue;
    }

    const personName = elig.contact.person_id
      ? (peopleById.get(elig.contact.person_id) ?? null)
      : null;
    const co = elig.contact.person_id
      ? companyByPerson.get(elig.contact.person_id)
      : undefined;
    const companyId = co?.company_id ?? null;
    const tradeName = co?.trade_name ?? null;
    const companyName = co?.legal_name ?? co?.trade_name ?? null;

    const fullName =
      personName || elig.contact.display_name || elig.contact.name || elig.contact.phone_number;
    const rendered = renderCampaignTemplate(opts.messageTemplate, {
      full_name: fullName,
      first_name: firstNameFrom(fullName),
      company_name: companyName,
      trade_name: tradeName,
    });

    pendingUpserts.push({
      organization_id: opts.organizationId,
      campaign_id: opts.campaignId,
      contact_id: contactId,
      person_id: elig.contact.person_id,
      company_id: companyId,
      channel_session_id: opts.channelSessionId,
      phone_number_snapshot: elig.contact.phone_number,
      contact_name_snapshot: elig.contact.display_name || elig.contact.name,
      person_name_snapshot: personName,
      company_name_snapshot: companyName || tradeName,
      message_rendered: rendered,
      status: "pending",
      skipped_reason: null,
    });
    eligible += 1;
  }

  for (let i = 0; i < skippedUpserts.length; i += CHUNK) {
    const slice = skippedUpserts.slice(i, i + CHUNK);
    await admin.from("whatsapp_campaign_recipients").upsert(slice, {
      onConflict: "campaign_id,contact_id",
      ignoreDuplicates: true,
    });
  }
  for (let i = 0; i < pendingUpserts.length; i += CHUNK) {
    const slice = pendingUpserts.slice(i, i + CHUNK);
    const { error } = await admin.from("whatsapp_campaign_recipients").upsert(slice, {
      onConflict: "campaign_id,contact_id",
    });
    if (error) {
      skipped += slice.length;
      eligible -= slice.length;
      skipped_reasons.upsert_error = (skipped_reasons.upsert_error ?? 0) + slice.length;
    }
  }

  return {
    total: contactIds.size,
    eligible,
    skipped,
    skipped_reasons,
  };
}

async function checkContactEligibilityFromRow(
  organizationId: string,
  data: {
    id: string;
    organization_id: string;
    phone_number: string | null;
    display_name: string | null;
    name: string | null;
    person_id: string | null;
    is_blocked: boolean;
    is_anonymized: boolean | null;
    is_merged_into: string | null;
    blocked_reason: string | null;
  },
): Promise<
  | {
      ok: true;
      contact: {
        id: string;
        phone_number: string;
        display_name: string | null;
        name: string | null;
        person_id: string | null;
        is_blocked: boolean;
      };
    }
  | { ok: false; reason: string }
> {
  if (data.organization_id !== organizationId) return { ok: false, reason: "cross_tenant" };
  if (data.is_anonymized) return { ok: false, reason: "anonymized" };
  if (data.is_merged_into) return { ok: false, reason: "merged" };
  if (data.is_blocked) {
    const reason = String(data.blocked_reason ?? "").toLowerCase();
    if (reason.includes("opt") || reason.includes("stop")) {
      return { ok: false, reason: "opt_out" };
    }
    return { ok: false, reason: "blocked" };
  }
  if (!data.phone_number) return { ok: false, reason: "missing_phone" };
  if (!/^\+\d{10,15}$/.test(data.phone_number)) return { ok: false, reason: "invalid_phone" };
  return {
    ok: true,
    contact: {
      id: data.id,
      phone_number: data.phone_number,
      display_name: data.display_name,
      name: data.name,
      person_id: data.person_id,
      is_blocked: data.is_blocked,
    },
  };
}
