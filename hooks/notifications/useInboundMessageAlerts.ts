"use client";

import { useCallback, useEffect } from "react";

import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { getOpenConversationId } from "@/hooks/notifications/OpenConversationContext";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { avatarUrlServivel } from "@/lib/notifications/avatar_url";
import { entregarAviso } from "@/lib/notifications/deliver";
import { shouldNotifyInbound } from "@/lib/notifications/policy";
import { syncPushSubscription } from "@/lib/notifications/push_client";

function tabFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** postgres_changes entrega `{ new }`; alguns mocks aninham em `payload`. */
function rowFromRealtime(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    tipo?: unknown;
    new?: unknown;
    record?: unknown;
    payload?: { new?: unknown };
  };
  if (p.tipo === "reassinado") return null;
  const raw = p.new ?? p.record ?? p.payload?.new;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function previewFromMessage(row: { type?: unknown; body?: unknown }): string {
  if (row.type !== "text") return "Mídia";
  const body = typeof row.body === "string" ? row.body.trim() : "";
  return body || "Nova mensagem";
}

/**
 * ⚠️ POR QUE ESTA LEITURA PASSA PELA ROTA, E NÃO PELO SUPABASE DO BROWSER.
 *
 * Este bloco JÁ FOI um `createClient().from("contacts").select(...)`, e era o
 * defeito da issue #376: o client do browser não enxerga a sessão (o cookie é
 * httpOnly — o mecanismo inteiro está em `lib/supabase/browser.ts`), então o
 * select saía como `anon`, e a RLS de `contacts` filtra por
 * `organization_id`/membro da organização. Anônimo não é membro de nada: a
 * resposta é ZERO LINHAS, sem erro e sem exceção. Como o código só lia `data`,
 * `nomeDoContato(null)` devolvia `null` em silêncio e TODO aviso de mensagem
 * caía no literal "Nova mensagem" — o nome de quem escreveu nunca aparecia.
 *
 * Não é um caso de "faltou checar `error`": não havia erro para checar. Zero
 * linhas é um resultado legítimo da RLS, indistinguível de "contato sem nome"
 * para quem lê só o corpo da resposta. A diferença que conserta isto é QUEM
 * pergunta: a rota `/api/v1/contacts/[id]` autentica no servidor, com a sessão
 * de verdade, e já é o caminho usado pela busca de avatar logo abaixo — que
 * sempre funcionou justamente por isso.
 *
 * A lição vale para o resto do arquivo: no browser, leitura de dado de
 * organização não se faz com o client anônimo. Se um dia isto voltar a ser
 * supabase-js aqui, a regressão é muda.
 */
async function contatoDaRota(contactId: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`/api/v1/contacts/${contactId}`, { credentials: "include" });
    if (!r.ok) return null;
    const json = (await r.json()) as { data?: unknown };
    const dado = json.data;
    if (!dado || typeof dado !== "object" || Array.isArray(dado)) return null;
    return dado as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function contactNotifyBits(contactId: string): Promise<{ title: string; icon?: string }> {
  const row = await contatoDaRota(contactId);
  const title = nomeDoContato(row as { display_name?: string | null; name?: string | null } | null) ?? "Nova mensagem";
  let icon: string | undefined;
  try {
    const r = await fetch(`/api/v1/contacts/${contactId}/avatar`, {
      credentials: "include",
      redirect: "follow",
    });
    icon = r.ok ? avatarUrlServivel(r.url, window.location.origin) : undefined;
  } catch {
    // sem foto: badge da marca
  }
  return { title, icon };
}

async function contactIdFromRow(
  row: Record<string, unknown>,
  conversationId: string | null,
): Promise<string | null> {
  if (typeof row.contact_id === "string") return row.contact_id;
  if (!conversationId) return null;
  // Mesmo motivo de `contatoDaRota`: pelo client do browser este select voltava
  // vazio SEM erro, e a mensagem ficava sem nome. A rota autentica no servidor.
  try {
    const r = await fetch(`/api/v1/conversations/${conversationId}`, { credentials: "include" });
    if (!r.ok) return null;
    const json = (await r.json()) as { data?: { contact_id?: string | null } | null };
    const c = json.data;
    return typeof c?.contact_id === "string" ? c.contact_id : null;
  } catch {
    return null;
  }
}

export function useInboundMessageAlerts(): void {
  const orgId = useActiveOrg()?.orgId ?? null;

  useEffect(() => {
    if (!orgId) return;
    void syncPushSubscription();
  }, [orgId]);

  const onChange = useCallback((payload: unknown) => {
    const row = rowFromRealtime(payload);
    if (!row) return;
    const conversationId = typeof row.conversation_id === "string" ? row.conversation_id : null;
    const direction = typeof row.direction === "string" ? row.direction : null;
    if (
      !shouldNotifyInbound({
        direction,
        conversationId,
        openConversationId: getOpenConversationId(),
        tabFocused: tabFocused(),
        tipo: (payload as { tipo?: unknown }).tipo,
      })
    ) {
      return;
    }
    void (async () => {
      const contactId = await contactIdFromRow(row, conversationId);
      const bits = contactId
        ? await contactNotifyBits(contactId)
        : { title: "Nova mensagem" as const, icon: undefined };
      entregarAviso({
        category: "message",
        kind: "message_inbound",
        title: bits.title,
        body: previewFromMessage(row),
        tag: conversationId ?? undefined,
        href: conversationId ? `/app/inbox?id=${conversationId}` : undefined,
        icon: bits.icon,
      });
    })();
  }, []);

  useRealtimeChannel({
    name: orgId ? `alerts-messages-${orgId}` : "alerts-messages-disabled",
    postgresChanges: orgId
      ? {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange,
    enabled: !!orgId,
  });
}
