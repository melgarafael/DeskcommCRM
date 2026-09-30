/**
 * Desliga do transporte TODOS os canais de uma organização que vai deixar de
 * existir — o par da conexão, visto pela exclusão de tenant
 * (`lib/tenants/exclusao.ts`).
 *
 * Mora aqui, e não na exclusão, porque só a fronteira de canais nomeia o
 * transporte (cerca `pnpm lint:channels`): quem pede é "o tenant está sendo
 * excluído", quem sabe o que cada transporte exige para soltar o número é este
 * módulo. É o mesmo desligamento da exclusão de UM canal
 * (`app/api/v1/channel-sessions/[id]/route.ts`), aplicado a todos:
 *
 *  - sessão por QR: sai do aparelho (logout) e o servidor apaga a sessão;
 *  - número oficial: o webhook do número volta para a URL do app — precisa da
 *    credencial da linha, então roda ANTES de a cascata apagá-la. A inscrição
 *    na WABA não entra: ela é compartilhada com outros números.
 *
 * Best-effort, canal por canal: um transporte fora do ar não segura a exclusão
 * que o admin pediu, e o desfecho de cada canal volta para o registro final.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { desfazerWebhookDoNumero } from "@/lib/channels/meta/webhook-override";
import { getWahaClient } from "@/lib/waha/client";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export type DesfechoDoDesligamento = "ok" | "falhou" | "nao_se_aplica";

export interface CanalDesligado {
  id: string;
  provedor: string;
  desfecho: DesfechoDoDesligamento;
  motivo?: string;
}

interface LinhaDoCanal {
  id: string;
  provider: string;
  waha_session_name: string | null;
  meta_phone_number_id: string | null;
  meta_token_encrypted: string | null;
}

function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function desligarCanaisDaOrganizacao(
  admin: SupabaseClient,
  orgId: string,
): Promise<CanalDesligado[]> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, provider, waha_session_name, meta_phone_number_id, meta_token_encrypted")
    .eq("organization_id", orgId);
  if (error) throw new Error(`desligar_canais: ${error.message}`);

  const waha = getWahaClient();
  const saida: CanalDesligado[] = [];
  for (const canal of (data ?? []) as LinhaDoCanal[]) {
    try {
      if (canal.provider === CHANNEL_PROVIDER_WAHA) {
        if (!waha || !canal.waha_session_name) {
          saida.push({ id: canal.id, provedor: canal.provider, desfecho: "nao_se_aplica" });
          continue;
        }
        await waha.logoutSession(canal.waha_session_name);
        await waha.deleteSession(canal.waha_session_name);
        saida.push({ id: canal.id, provedor: canal.provider, desfecho: "ok" });
      } else if (canal.meta_token_encrypted && canal.meta_phone_number_id) {
        const token = await decryptWebhookSecret(admin, canal.meta_token_encrypted);
        if (!token) {
          saida.push({
            id: canal.id,
            provedor: canal.provider,
            desfecho: "falhou",
            motivo: "credencial_ilegivel",
          });
          continue;
        }
        const desfecho = await desfazerWebhookDoNumero({
          phoneNumberId: canal.meta_phone_number_id,
          token,
        });
        saida.push({
          id: canal.id,
          provedor: canal.provider,
          desfecho: desfecho.ok ? "ok" : "falhou",
          ...(desfecho.ok
            ? {}
            : { motivo: String(desfecho.motivo ?? desfecho.etapa ?? "recusado") }),
        });
      } else {
        saida.push({ id: canal.id, provedor: canal.provider, desfecho: "nao_se_aplica" });
      }
    } catch (err) {
      saida.push({
        id: canal.id,
        provedor: canal.provider,
        desfecho: "falhou",
        motivo: mensagemDe(err),
      });
    }
  }
  return saida;
}
