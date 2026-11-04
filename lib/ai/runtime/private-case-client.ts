import type { SupabaseClient } from "@supabase/supabase-js";
import { currentExecutionBoundary } from "@/lib/atendimento/fronteira-server";

type Filter = { column: string; ids: string[] };
type Loose = { eq: (...args: unknown[]) => Loose; in: (...args: unknown[]) => Loose } & Record<
  string,
  unknown
>;
const missing = "00000000-0000-4000-8000-000000000000";
const allowedEmbeds: Record<string, Set<string>> = {
  conversations: new Set(["contact_id", "contacts", "channel_session_id", "channel_sessions"]),
  agent_cases: new Set(["conversations", "conversation_id", "contacts", "contact_id", "agent_case_events"]),
  crm_leads: new Set([
    "contacts",
    "contact_id",
    "crm_stages",
    "stage_id",
    "crm_pipelines",
    "pipeline_id",
  ]),
  crm_proposals: new Set(["crm_proposal_items", "contacts", "contact_id"]),
};
const neutral = new Set([
  "organizations",
  "crm_pipelines",
  "crm_stages",
  "crm_custom_field_definitions",
  "calendar_event_types",
  "calendar_availability",
  "calendar_weekly_availability",
  "catalog_products",
  "catalog_variants",
  "catalog_categories",
  "message_templates",
  "quick_replies",
  "ai_agents",
  "ai_agent_versions",
  "channel_sessions",
]);

/** Service tools are additionally case-scoped; never use mere contact identity as case authority. */
export async function privateCaseClient(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
  tool?: { name: string; args: Record<string, unknown> },
): Promise<SupabaseClient> {
  const privacy = await db.rpc("fn_contact_context_private", { p_org: organizationId });
  if (privacy.error) throw new Error("private_context_unavailable");
  if (privacy.data !== true) return db;
  // Refuse before any partial draft can be inserted: proposal items need a separate contract.
  if (tool?.name === "crm_draft_proposal")
    throw new Error("proposal_draft_requires_private_case_contract");
  const boundary = currentExecutionBoundary();
  if (!boundary || boundary.organization_id !== organizationId || boundary.contact_id !== contactId)
    throw new Error("private_context_requires_conversation");
  for (const [key, expected] of [
    ["contact_id", contactId],
    ["conversation_id", boundary.conversation_id],
  ] as const) {
    if (tool?.args[key] !== undefined && tool.args[key] !== expected)
      throw new Error("private_case_target_mismatch");
  }
  if (typeof tool?.args.case_id === "string") {
    const { data: record, error: caseError } = await db
      .from("agent_cases")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", tool.args.case_id)
      .eq("conversation_id", boundary.conversation_id)
      .eq(
        "context_snapshot->service_boundary->>service_revision",
        String(boundary.service_revision),
      )
      .maybeSingle();
    if (caseError || !record) throw new Error("private_case_target_mismatch");
  }
  // Handoff reuses the native eligibility/load/assignment algorithm. It may only target
  // this trusted service; beginServiceAtOrigin/guardServiceEffect revalidate it.
  if (tool?.name === "crm_request_human_handoff") {
    if (tool.args.conversation_id !== boundary.conversation_id)
      throw new Error("private_case_target_mismatch");
    return db;
  }
  const { data: context, error } = await db
    .from("conversation_business_contexts")
    .select("lead_id")
    .eq("organization_id", organizationId)
    .eq("conversation_id", boundary.conversation_id)
    .eq("service_revision", boundary.service_revision)
    .eq("status", "assigned")
    .maybeSingle();
  if (error) throw new Error("private_context_unavailable");
  const leadId = (context?.lead_id as string | null) ?? missing;
  const conversationId = boundary.conversation_id;
  const revisionTables = new Set([
    "messages",
    "conversation_notes",
    "conversation_drafts",
    "lead_notes",
    "followup_enrollments",
    "passagens_de_atendimento",
    "contact_field_proposals",
  ]);
  const scopes: Record<string, Filter> = {
    contacts: { column: "id", ids: [contactId] },
    crm_leads: { column: "id", ids: [leadId] },
    conversations: { column: "id", ids: [conversationId] },
    messages: { column: "conversation_id", ids: [conversationId] },
    conversation_drafts: { column: "conversation_id", ids: [conversationId] },
    conversation_notes: { column: "conversation_id", ids: [conversationId] },
    contact_field_proposals: { column: "conversation_id", ids: [conversationId] },
    lead_notes: { column: "conversation_id", ids: [conversationId] },
    calendar_appointments: { column: "conversation_id", ids: [conversationId] },
    followup_enrollments: { column: "conversation_id", ids: [conversationId] },
    agent_cases: { column: "conversation_id", ids: [conversationId] },
    passagens_de_atendimento: { column: "conversation_id", ids: [conversationId] },
    crm_proposals: { column: "lead_id", ids: [leadId] },
    crm_lead_activities: { column: "lead_id", ids: [leadId] },
    crm_lead_links: { column: "lead_id", ids: [leadId] },
    tasks: { column: "lead_id", ids: [leadId] },
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === "then") return undefined;
      if (key === "rpc")
        return () => {
          throw new Error("private_context_rpc_requires_explicit_contract");
        };
      if (key !== "from") {
        // No raw schema/storage/auth/functions/admin escape from this capability.
        throw new Error("private_case_client_capability_not_available");
      }
      return (table: string) => {
        const scope = scopes[table];
        if (!scope && !neutral.has(table))
          throw new Error("resource_not_available_in_private_case");
        const base = target.from(table) as unknown as Loose;
        const wrap = (value: Loose): Loose =>
          new Proxy(value, {
            get(builder, method) {
              const operation = Reflect.get(builder, method);
              if (typeof operation !== "function") return operation;
              if (method === "then") return operation.bind(builder);
              return (...args: unknown[]) => {
                if (method === "select" && typeof args[0] === "string") {
                  for (const relation of args[0].matchAll(
                    /(?:[a-zA-Z_][a-zA-Z_0-9]*:)?([a-zA-Z_][a-zA-Z_0-9]*)\s*\(/g,
                  )) {
                    if (!allowedEmbeds[table]?.has(relation[1]!))
                      throw new Error("private_context_embedded_read_requires_contract");
                  }
                }
                if (method === "delete" && !scope)
                  throw new Error("private_case_cannot_change_configuration");
                if (method === "upsert")
                  throw new Error("private_context_upsert_requires_contract");
                if (method === "insert" || method === "update") {
                  if (!scope) throw new Error("private_case_cannot_change_configuration");
                  const rows = Array.isArray(args[0]) ? args[0] : [args[0]];
                  for (const raw of rows) {
                    if (!raw || typeof raw !== "object")
                      throw new Error("invalid_private_case_write");
                    const row = raw as Record<string, unknown>;
                    if (row.organization_id !== undefined && row.organization_id !== organizationId)
                      throw new Error("private_case_organization_mismatch");
                    if (
                      row[scope.column] !== undefined &&
                      !scope.ids.includes(String(row[scope.column]))
                    )
                      throw new Error("private_case_target_mismatch");
                    if (row.contact_id !== undefined && row.contact_id !== contactId)
                      throw new Error("private_case_contact_mismatch");
                    if (
                      row.service_revision !== undefined &&
                      row.service_revision !== boundary.service_revision
                    )
                      throw new Error("private_case_revision_mismatch");
                    if (method === "insert" && row.organization_id !== organizationId)
                      throw new Error("private_case_write_requires_organization");
                    if (method === "insert" && row[scope.column] === undefined)
                      throw new Error("private_case_write_requires_link");
                  }
                }
                let result = operation.apply(builder, args) as Loose;
                if (["select", "update", "delete"].includes(String(method))) {
                  result = result.eq(table === "organizations" ? "id" : "organization_id", organizationId);
                  if (scope) result = result.in(scope.column, scope.ids);
                  if (revisionTables.has(table))
                    result = result.eq("service_revision", boundary.service_revision);
                  if (table === "agent_cases")
                    result = result.eq(
                      "context_snapshot->service_boundary->>service_revision",
                      String(boundary.service_revision),
                    );
                }
                return wrap(result);
              };
            },
          });
        return wrap(base);
      };
    },
  });
}
