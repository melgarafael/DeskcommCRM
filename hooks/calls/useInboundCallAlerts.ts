"use client";

import { useCallback } from "react";

import { useActiveOrg, usePermission } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";
import { entregarAviso } from "@/lib/notifications/deliver";
import { canalLigado } from "@/lib/notifications/prefs";
import { createClient } from "@/lib/supabase/browser";

/** postgres_changes entrega `{ new }`; alguns mocks aninham em `payload`. */
function rowFromRealtime(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { tipo?: unknown; new?: unknown; record?: unknown; payload?: { new?: unknown } };
  if (p.tipo === "reassinado") return null;
  const raw = p.new ?? p.record ?? p.payload?.new;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** Nome de verdade, ou null quando rotuloDoContato só teria pra oferecer o próprio número/"Sem nome". */
async function callerName(contactId: string | null, fromNumber: string): Promise<string | null> {
  if (!contactId) return null;
  const supabase = createClient();
  const { data } = await supabase
    .from("contacts")
    .select("display_name, name")
    .eq("id", contactId)
    .maybeSingle();
  const row = data as { display_name?: string | null; name?: string | null } | null;
  const rotulo = rotuloDoContato({ display_name: row?.display_name, name: row?.name, phone_number: fromNumber });
  if (rotulo === SEM_NOME || rotulo === phoneForDisplay(fromNumber)) return null;
  return rotulo;
}

/**
 * Identificador de ligações — ao vivo. Sem ponte de áudio pro navegador do
 * atendente ainda (ver docstring de app/api/v1/calls/route.ts), então isto é
 * só aviso: quem está ligando, não um botão de atender.
 *
 * `voice_calls` (migration 0348) é compartilhada com a chamada de voz por
 * WhatsApp (WaCalls) — o `IncomingCallBanner` deles já escuta a MESMA
 * tabela/publicação. `provider !== "sip"` descarta linhas de WhatsApp aqui
 * pra não duplicar o aviso; a assinatura ainda filtra por `organization_id`
 * no servidor (o supabase-js realtime não compõe bem dois filtros de
 * igualdade na mesma assinatura), então o filtro de provider é no cliente.
 */
export function useInboundCallAlerts(): void {
  const orgId = useActiveOrg()?.orgId ?? null;
  const podeVer = usePermission("calls.view");

  const onChange = useCallback((payload: unknown) => {
    const row = rowFromRealtime(payload);
    if (!row) return;
    if (row.provider !== "sip") return;
    if (row.direction !== "inbound") return;
    if (!canalLigado("call_inbound", "in_app") && !canalLigado("call_inbound", "push")) return;

    const fromNumber = typeof row.peer_phone === "string" ? row.peer_phone : "número desconhecido";
    const contactId = typeof row.contact_id === "string" ? row.contact_id : null;
    const callId = typeof row.id === "string" ? row.id : undefined;

    void (async () => {
      const name = await callerName(contactId, fromNumber);
      entregarAviso({
        category: "call_inbound",
        kind: "call_inbound",
        title: "Ligação recebida",
        body: name ? `${name} · ${fromNumber}` : fromNumber,
        tag: callId,
        href: "/app/calls",
      });
    })();
  }, []);

  useRealtimeChannel({
    name: orgId ? `alerts-calls-${orgId}` : "alerts-calls-disabled",
    postgresChanges: orgId
      ? {
          event: "INSERT",
          schema: "public",
          table: "voice_calls",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange,
    enabled: !!orgId && podeVer,
  });
}
