/**
 * Contexto resumido do contato para a sessão de voz (AudioSocket / OpenAI Realtime).
 *
 * Sem este bloco, o agente de voz recebe apenas o `system_prompt` genérico e
 * precisa perguntar novamente nome, e-mail e assunto mesmo quando o cliente já
 * conversou pelo WhatsApp ou tem negócio/agendamento aberto no CRM.
 *
 * Regras de segurança e latência:
 * - Usa `supabaseAdmin` (bypassa RLS), portanto TODA consulta filtra
 *   explicitamente `organization_id` e `contact_id`.
 * - Contatos anonimizados ou bloqueados retornam string vazia.
 * - Fail-open: falha de leitura nunca derruba ou atrasa o atendimento por voz.
 * - Texto compacto (teto rígido de caracteres) para não inflar latência nem
 *   custo de tokens na Realtime API.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_MENSAGENS = 6;
const MAX_CHARS_POR_MENSAGEM = 180;
const MAX_CONTEXTO_CHARS = 1400;

export interface ParamsContextoContatoVoz {
  organizationId: string;
  contactId: string;
}

function truncar(texto: string, limite: number): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (limpo.length <= limite) return limpo;
  return `${limpo.slice(0, Math.max(0, limite - 1))}…`;
}

function formatarDataCurta(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * Monta um bloco curto de contexto do contato para ser anexado às instruções
 * do agente de voz. Retorna `""` quando não há dados úteis ou em caso de falha.
 */
export async function carregarContextoDoContatoNaVoz(
  supabase: SupabaseClient,
  { organizationId, contactId }: ParamsContextoContatoVoz,
): Promise<string> {
  try {
    const { data: contato } = await supabase
      .from("contacts")
      .select("name,display_name,email,tags,is_anonymized,is_blocked")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();

    if (!contato || contato.is_anonymized || contato.is_blocked) {
      return "";
    }

    const [{ data: negocios }, { data: compromissos }, { data: conversa }] = await Promise.all([
      supabase
        .from("crm_leads")
        .select("title")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .order("updated_at", { ascending: false })
        .limit(3),
      supabase
        .from("calendar_appointments")
        .select("title,starts_at,status")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .in("status", ["pending", "confirmed"])
        .gte("starts_at", new Date().toISOString())
        .order("starts_at", { ascending: true })
        .limit(2),
      supabase
        .from("conversations")
        .select("id,channel,status,last_message_at")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("is_group", false)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const linhas: string[] = [];
    const nome = (contato.display_name || contato.name || "").trim();
    if (nome) linhas.push(`- Nome já cadastrado: ${truncar(nome, 80)}`);
    if (contato.email) linhas.push(`- E-mail já cadastrado: ${truncar(String(contato.email), 80)}`);

    const tags = Array.isArray(contato.tags)
      ? contato.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      : [];
    if (tags.length > 0) linhas.push(`- Etiquetas: ${tags.slice(0, 5).join(", ")}`);

    if (Array.isArray(negocios) && negocios.length > 0) {
      const titulos = negocios
        .map((n) => (typeof n.title === "string" ? truncar(n.title, 60) : ""))
        .filter(Boolean);
      if (titulos.length > 0) linhas.push(`- Negócios em aberto: ${titulos.join("; ")}`);
    }

    if (Array.isArray(compromissos) && compromissos.length > 0) {
      const itens = compromissos.map((c) => {
        const quando = formatarDataCurta(c.starts_at);
        return `${truncar(String(c.title || "Compromisso"), 50)}${quando ? ` (${quando})` : ""}`;
      });
      linhas.push(`- Próximos agendamentos: ${itens.join("; ")}`);
    }

    if (conversa?.id) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("direction,body,created_at")
        .eq("organization_id", organizationId)
        .eq("conversation_id", conversa.id)
        .eq("private", false)
        .not("body", "is", null)
        .order("created_at", { ascending: false })
        .limit(MAX_MENSAGENS);

      if (Array.isArray(msgs) && msgs.length > 0) {
        const resumoMsgs = [...msgs]
          .reverse()
          .map((m) => {
            const quem = m.direction === "inbound" ? "Cliente" : "Empresa";
            return `  ${quem}: ${truncar(String(m.body ?? ""), MAX_CHARS_POR_MENSAGEM)}`;
          })
          .join("\n");
        const quandoUltima = formatarDataCurta(conversa.last_message_at);
        const estadoConversa = conversa.status === "open" ? "em aberto (não finalizada)" : conversa.status;
        linhas.push(
          `- Última conversa (${conversa.channel ?? "whatsapp"}, status: ${estadoConversa}${quandoUltima ? `, última msg em ${quandoUltima}` : ""}):\n${resumoMsgs}`,
        );
      }
    }

    if (linhas.length === 0) return "";

    const cabecalho =
      "# Contexto já conhecido deste contato (use para cumprimentar pelo nome sem pedir dados que já tem e retomar assuntos não finalizados)";
    const completo = `${cabecalho}\n${linhas.join("\n")}`;
    return completo.length > MAX_CONTEXTO_CHARS
      ? `${completo.slice(0, MAX_CONTEXTO_CHARS - 1)}…`
      : completo;
  } catch {
    return "";
  }
}
