import type { SupabaseClient } from "@supabase/supabase-js";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { Role } from "@/lib/auth/types";
import { roleAtLeast } from "@/lib/auth/types";
import type { WorkspaceScope, WorkspaceSource } from "./schema";

/** Cookie-authenticated client only: database RLS keeps attendant visibility intact. */
export async function loadWorkspaceContext(
  db: SupabaseClient,
  orgId: string,
  role: Role,
  scope: WorkspaceScope,
  question: string,
) {
  const sources: WorkspaceSource[] = [];
  const warnings: string[] = [];
  if (scope === "all" || scope === "conversations") {
    const { data, error } = await db
      .from("conversations")
      .select(
        "id,channel,status,last_message_at,last_message_preview,contacts:contact_id!inner(display_name,is_anonymized)",
      )
      .eq("organization_id", orgId)
      .eq("contacts.is_anonymized", false)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(20);
    if (error) throw new Error("Não foi possível consultar as conversas.");
    const conversations = data ?? [];
    const ids = conversations.map((c) => c.id as string);
    const messages = ids.length
      ? await db
          .from("messages")
          .select("conversation_id,body,direction,sent_at")
          .eq("organization_id", orgId)
          .in("conversation_id", ids)
          .is("revoked_at", null)
          .order("sent_at", { ascending: false })
          .limit(80)
      : { data: [], error: null };
    if (messages.error) throw new Error("Não foi possível consultar as mensagens.");
    for (const c of conversations) {
      const contact = Array.isArray(c.contacts) ? c.contacts[0] : c.contacts;
      const recent = (messages.data ?? [])
        .filter((m) => m.conversation_id === c.id)
        .slice(0, 8)
        .reverse();
      sources.push({
        id: `conversation:${c.id}`,
        title: rotuloDoContato(contact),
        kind: "Conversa",
        href: `/app/inbox?id=${c.id}`,
        text: `${c.channel} · ${c.status} · ${c.last_message_at ?? "sem data"}\n${recent.map((m) => `${m.sent_at} ${m.direction}: ${String(m.body ?? "[mídia sem transcrição]").slice(0, 800)}`).join("\n") || "Sem mensagem de texto disponível"}`,
      });
    }
    warnings.push("Até 20 conversas recentes e 80 mensagens acessíveis ao seu usuário.");
  }
  if (scope === "all" || scope === "leads") {
    const { data, error } = await db
      .from("crm_leads")
      .select("id,title,description,status,last_activity_at,expected_close_date")
      .eq("organization_id", orgId)
      .order("last_activity_at", { ascending: false, nullsFirst: false })
      .limit(30);
    if (error) throw new Error("Não foi possível consultar o funil.");
    for (const lead of data ?? [])
      sources.push({
        id: `lead:${lead.id}`,
        title: lead.title,
        kind: "Funil",
        href: "/app/kanban",
        text: `${lead.status} · última atividade: ${lead.last_activity_at ?? "não registrada"} · fechamento previsto: ${lead.expected_close_date ?? "não informado"}\n${String(lead.description ?? "").slice(0, 1000)}`,
      });
    warnings.push("Até 30 oportunidades recentes; este recorte não representa totais da operação.");
  }
  if (scope === "all" || scope === "knowledge") {
    if (!roleAtLeast(role, "manager")) {
      if (scope === "knowledge")
        throw new Error("Seu perfil não tem acesso aos materiais de Conhecimento.");
    } else {
      const { data: materials, error } = await db
        .from("ai_knowledge_sources")
        .select("id,name,active_kb_version_id")
        .eq("is_active", true)
        .neq("status", "archived")
        .eq("organization_id", orgId)
        .not("active_kb_version_id", "is", null)
        .limit(100);
      if (error) throw new Error("Não foi possível consultar os materiais.");
      if (materials?.length) {
        let query = db
          .from("ai_chunks")
          .select("id,knowledge_source_id,content")
          .eq("organization_id", orgId)
          .in(
            "knowledge_source_id",
            materials.map((m) => m.id),
          )
          .in(
            "kb_version_id",
            materials.map((m) => m.active_kb_version_id),
          )
          .order("position", { ascending: true })
          .limit(12);
        // Only letters/numbers enter PostgREST's filter grammar.
        const ignored = new Set(
          "quero encontre encontrar sobre meus minhas meu minha conteúdo conteúdos materiais material mostre mostrar quais como para pelo pela uma voce você pode consultar buscar resumir resumo empresa escreve isso esse essa preciso saber".split(
            " ",
          ),
        );
        const terms = [
          ...new Set(
            (question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
              (w) => w.length > 3 && !ignored.has(w),
            ),
          ),
        ].slice(0, 5);
        if (terms.length)
          query = query.or(terms.map((word) => `content.ilike.%${word}%`).join(","));
        const { data: chunks, error: chunkError } = await query;
        if (chunkError) throw new Error("Não foi possível ler os trechos dos materiais.");
        for (const chunk of chunks ?? [])
          sources.push({
            id: `knowledge:${chunk.id}`,
            title: materials.find((m) => m.id === chunk.knowledge_source_id)?.name ?? "Material",
            kind: "Conhecimento",
            href: "/app/ai/knowledge/sources",
            text: String(chunk.content).slice(0, 1800),
          });
      }
      warnings.push(
        "Até 12 trechos das versões ativas de 100 materiais, por palavras da pergunta.",
      );
    }
  }
  return { sources, notice: warnings.join(" ") };
}
