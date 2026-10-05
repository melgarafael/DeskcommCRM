// lib/propostas/aviso-no-whatsapp.handler.ts
/**
 * Adapter fino: pluga `aplicaAvisoDeProposta` no dreno do `event_log`, reusando
 * a leitura, o transporte e o pacing do aviso de caso. Imports de topo iguais
 * aos de `lib/escalacao/aviso-ao-suporte.handler.ts` — o dreno carrega isto
 * sob `tsx`, e import pesado de topo já o parou (#648).
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { audit } from "@/lib/audit";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { env } from "@/lib/env";
import { createSupabaseAvisoDb } from "@/lib/escalacao/aviso-ao-suporte";
import { criarTransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte.handler";
import { origemDoDreno } from "@/lib/event-log/origem-do-dreno";
import { createAdminClient } from "@/lib/supabase/admin";
import { EVENTO_PROPOSTA_PRONTA, aplicaAvisoDeProposta } from "./aviso-no-whatsapp";
import { resolverPadroesDaProposta } from "./padroes-da-organizacao";

export const AVISO_DE_PROPOSTA_HANDLER_KEY = "propostas-aviso-no-whatsapp.v1";

export const avisoDePropostaNoWhatsAppHandler: EventHandler = {
  key: AVISO_DE_PROPOSTA_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_PROPOSTA_PRONTA],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const doCaso = createSupabaseAvisoDb(admin);
      const desfecho = await aplicaAvisoDeProposta(
        {
          db: {
            async preferencia(orgId) {
              const { data } = await admin.from("organizations").select("settings").eq("id", orgId).maybeSingle();
              return resolverPadroesDaProposta((data as { settings?: unknown } | null)?.settings).avisarNoWhatsApp;
            },
            carregaConfig: (orgId) => doCaso.carregaConfig(orgId),
            async carregaProposta(orgId, propostaId) {
              const { data } = await admin
                .from("crm_proposals")
                .select("titulo, status, contact_id")
                .eq("organization_id", orgId)
                .eq("id", propostaId)
                .maybeSingle();
              return (data as { titulo: string | null; status: string; contact_id: string | null } | null) ?? null;
            },
            async avisoAberto(orgId, propostaId) {
              const { data } = await admin
                .from("agent_inbox_items")
                .select("id")
                .eq("organization_id", orgId)
                .eq("kind", "proposta_pronta_para_revisao")
                .eq("ref_id", propostaId)
                .eq("status", "open")
                .maybeSingle();
              return data !== null;
            },
            async nomeDoContato(orgId, contactId) {
              const { data } = await admin
                .from("contacts")
                .select("name, display_name")
                .eq("organization_id", orgId)
                .eq("id", contactId)
                .maybeSingle();
              return nomeDoContato(data as { name: string | null; display_name: string | null } | null);
            },
            carregaCanal: (orgId, canalId) => doCaso.carregaCanal(orgId, canalId),
            registraJidDoAviso: (orgId, jid) => doCaso.registraJidDoAviso(orgId, jid),
            marcaDaOrganizacao: (orgId) => doCaso.marcaDaOrganizacao(orgId),
          },
          transporte: await criarTransporteDoAviso(admin),
          pacing: await criarPacingDoCanal(admin),
          clock: () => new Date(),
          urlPublica: env.NEXT_PUBLIC_APP_URL,
          origemDoDreno,
          audita: (entrada) => {
            void audit({
              action: entrada.action,
              organizationId: entrada.organizationId,
              resourceType: "crm_proposals",
              resourceId: entrada.propostaId,
              bypassedRls: true,
              metadata: entrada.metadata,
            });
          },
        },
        row,
      );
      return {
        consumer_key: AVISO_DE_PROPOSTA_HANDLER_KEY,
        status: desfecho.status,
        ...(desfecho.retry_at ? { retry_at: desfecho.retry_at } : {}),
        detail: desfecho.detail,
      };
    } catch (err) {
      return { consumer_key: AVISO_DE_PROPOSTA_HANDLER_KEY, status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
  },
};
