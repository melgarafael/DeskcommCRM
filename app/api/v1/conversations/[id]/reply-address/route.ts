/**
 * GET /api/v1/conversations/[id]/reply-address — para qual número a resposta sai (Spec 31, B4).
 *
 * `{ phone_number, via, has_extras, provider }`:
 * - `via: "ultima_recebida"` — a resposta volta pelo número da última mensagem
 *   recebida da conversa (WAHA, conversa individual, ficha com telefone extra);
 * - `via: "principal"` — o principal da ficha (ficha sem extra, grupo, outro canal,
 *   ou nenhuma mensagem recebida).
 *
 * Só leitura: papel `viewer` ou acima, sem `requireSupportWrite`. A organização vem
 * da sessão; a conversa e a ficha são lidas com o filtro de organização explícito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { enderecoDaUltimaRecebida } from "@/lib/channels/endereco-da-ultima-recebida";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

type Via = "ultima_recebida" | "principal";

/** `<digitos>@c.us`, `<digitos>@s.whatsapp.net` ou `<digitos>@lid`: o que o helper devolve. */
const CHAT_INDIVIDUAL = /^([0-9]+)@(c\.us|s\.whatsapp\.net|lid)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, ctx: Context): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const organizationId = authz.org.orgId;

  if (!UUID_RE.test(id)) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const supabase = await createClient();

  const { data: bruta, error: errConversa } = await supabase
    .from("conversations")
    .select("id, contact_id, is_group, channel_sessions:channel_session_id(provider)")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (errConversa) {
    return fail("internal_error", "Não foi possível ler a conversa.", 500, { requestId });
  }
  if (!bruta) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const conversa = bruta as unknown as {
    id: string;
    contact_id: string | null;
    is_group: boolean | null;
    channel_sessions: { provider: string } | null;
  };
  const provider = conversa.channel_sessions?.provider ?? null;

  let principal: { phone_number: string | null; lid: string | null } = { phone_number: null, lid: null };
  let extras: Array<{ phone_number: string; wa_lid: string | null }> = [];
  if (conversa.contact_id) {
    const { data: ficha, error: errFicha } = await supabase
      .from("contacts")
      .select("phone_number, source_metadata")
      .eq("organization_id", organizationId)
      .eq("id", conversa.contact_id)
      .maybeSingle();
    if (errFicha) {
      return fail("internal_error", "Não foi possível ler a ficha.", 500, { requestId });
    }
    if (ficha) {
      const meta = (ficha.source_metadata ?? {}) as Record<string, unknown>;
      const lid = typeof meta.waha_lid === "string" ? meta.waha_lid.replace(/@.*$/, "") : "";
      principal = { phone_number: ficha.phone_number ?? null, lid: lid || null };
    }
    const { data: linhas, error: errExtras } = await supabase
      .from("contact_phones")
      .select("phone_number, wa_lid")
      .eq("organization_id", organizationId)
      .eq("contact_id", conversa.contact_id);
    if (errExtras) {
      return fail("internal_error", "Não foi possível ler os telefones da ficha.", 500, { requestId });
    }
    extras = (linhas ?? []) as Array<{ phone_number: string; wa_lid: string | null }>;
  }
  const hasExtras = extras.length > 0;

  // Sem extra (ou grupo, ou outro canal) o helper devolve null e a resposta é a de sempre.
  const chat = await enderecoDaUltimaRecebida(supabase, {
    provider,
    isGroup: conversa.is_group,
    organizationId,
    conversationId: conversa.id,
    contactId: conversa.contact_id,
  });

  let phoneNumber = principal.phone_number;
  let via: Via = "principal";

  const casado = chat ? CHAT_INDIVIDUAL.exec(chat) : null;
  if (casado) {
    const digitos = casado[1];
    if (casado[2] !== "lid") {
      phoneNumber = `+${digitos}`;
      via = "ultima_recebida";
    } else {
      // `@lid`: o número é o do extra com esse identificador, ou o principal da ficha.
      const doExtra = extras.find((e) => e.wa_lid === digitos);
      if (doExtra) {
        phoneNumber = doExtra.phone_number;
        via = "ultima_recebida";
      } else if (principal.lid === digitos && principal.phone_number) {
        phoneNumber = principal.phone_number;
        via = "ultima_recebida";
      }
    }
  }

  return ok(
    { phone_number: phoneNumber, via, has_extras: hasExtras, provider },
    { requestId },
  );
}
