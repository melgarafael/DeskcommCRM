/**
 * Adapter fino: pluga `aplicaEnvioDaAgencia` no dreno do `event_log`, com o
 * MESMO transporte e o MESMO pacing do aviso ao suporte
 * (`lib/escalacao/aviso-ao-suporte.handler.ts`). Mesmo motivo de lá para os
 * imports tardios: o dreno carrega este módulo por import dinâmico.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import type { TransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte";
import { createAdminClient } from "@/lib/supabase/admin";

import { EVENTO_WHATSAPP_ENFILEIRADO } from "./eventos";
import { aplicaEnvioDaAgencia, type DbDoWhatsapp, type EnvioDaAgencia, type PatchDoEnvio } from "./regra";

export const WHATSAPP_DA_AGENCIA_HANDLER_KEY = "agencia-whatsapp.v1";

/**
 * O envio para o GRUPO do cliente (SPEC-aprovacoes, P7): o "telefone" do envio é
 * o id do grupo (`…@g.us`), que já é o endereço que o WAHA usa — não passa pela
 * tradução de número do transporte, que só conhece contato.
 */
function comGrupo(t: TransporteDoAviso): TransporteDoAviso {
  return {
    ...t,
    async resolveDestino(organizationId, canal, telefone) {
      return telefone.endsWith("@g.us") ? telefone : t.resolveDestino(organizationId, canal, telefone);
    },
  };
}

export const whatsappDaAgenciaHandler: EventHandler = {
  key: WHATSAPP_DA_AGENCIA_HANDLER_KEY,
  // Sai para fora (mensagem real num número real): organização parada não fala.
  naOrgParada: "pula",
  events: [EVENTO_WHATSAPP_ENFILEIRADO],
  async handle(row): Promise<HandlerResult> {
    try {
      const envioId = typeof row.payload?.envio_id === "string" ? row.payload.envio_id : null;
      if (!envioId) return { consumer_key: WHATSAPP_DA_AGENCIA_HANDLER_KEY, status: "skipped", detail: "sem_envio_id" };

      const admin = createAdminClient();
      const [{ criarTransporteDoAviso }, { criarPacingDoCanal }, { createSupabaseAvisoDb }] = await Promise.all([
        import("@/lib/escalacao/aviso-ao-suporte.handler"),
        import("@/lib/agent-engine/pacing/ledger-supabase"),
        import("@/lib/escalacao/aviso-ao-suporte"),
      ]);
      const doSuporte = createSupabaseAvisoDb(admin);

      const db: DbDoWhatsapp = {
        async carregaEnvio(id) {
          const { data, error } = await admin
            .from("agencia_envios_whatsapp")
            .select("id, motivo, telefone, corpo, situacao, tentativas, criado_em")
            .eq("id", id)
            .maybeSingle();
          if (error) throw new Error(error.message);
          return (data as EnvioDaAgencia | null) ?? null;
        },
        async carregaConfig() {
          const { data, error } = await admin
            .from("agencia_config")
            .select("canal_organization_id, canal_session_id, janela_inicio, janela_fim")
            .eq("id", true)
            .maybeSingle();
          if (error) throw new Error(error.message);
          const c = data as {
            canal_organization_id: string | null;
            canal_session_id: string | null;
            janela_inicio: string;
            janela_fim: string;
          } | null;
          return c
            ? {
                organizationId: c.canal_organization_id,
                canalId: c.canal_session_id,
                janelaInicio: c.janela_inicio,
                janelaFim: c.janela_fim,
              }
            : null;
        },
        carregaCanal: (orgId, canalId) => doSuporte.carregaCanal(orgId, canalId),
        async atualizaEnvio(id, patch: PatchDoEnvio) {
          const { error } = await admin.from("agencia_envios_whatsapp").update(patch).eq("id", id);
          if (error) throw new Error(error.message);
        },
      };

      const desfecho = await aplicaEnvioDaAgencia(
        {
          db,
          transporte: comGrupo(await criarTransporteDoAviso(admin)),
          pacing: await criarPacingDoCanal(admin),
          clock: () => new Date(),
        },
        envioId,
      );
      return {
        consumer_key: WHATSAPP_DA_AGENCIA_HANDLER_KEY,
        status: desfecho.status,
        ...(desfecho.retry_at ? { retry_at: desfecho.retry_at } : {}),
        detail: desfecho.detail,
      };
    } catch (err) {
      return {
        consumer_key: WHATSAPP_DA_AGENCIA_HANDLER_KEY,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
