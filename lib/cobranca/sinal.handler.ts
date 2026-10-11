/**
 * O CONSUMIDOR DE `cobranca.sinal` (spec da cobrança do revendedor §7c, §8).
 *
 * Roda com a empresa suspensa (`naOrgParada: "roda"`): é o caminho por onde
 * quem pagou volta sozinho. Coalescer: leitura aplicada há menos de 30 s →
 * `retry` para depois dela. A rajada de avisos de um checkout (a Stripe manda
 * três) vira UMA releitura, e um sinal forjado por um membro via `emit_event`
 * custa no máximo o mesmo que o botão "Já paguei". O `retry` do dreno não
 * conta tentativa; `error` conta, faz backoff e, no teto, vira `event_dead` na
 * Central — a reconciliação do cron cura o resto.
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

import { sincronizar } from "./sincronizar";

const CONSUMER_KEY = "cobranca.sinal";
export const JANELA_DO_COALESCER_MS = 30_000;

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

async function handle(row: EventRow): Promise<HandlerResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("cobranca_assinaturas")
    .select("relida_em")
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return resultado("error", `leitura da assinatura falhou: ${error.code ?? "sem_codigo"}`);
  if (!data) return resultado("skipped", "org_isenta");
  const relida = (data as { relida_em: string | null }).relida_em;
  const desde = relida === null ? null : Date.parse(relida);
  if (desde !== null && Date.now() - desde < JANELA_DO_COALESCER_MS) {
    return { consumer_key: CONSUMER_KEY, status: "retry", retry_at: new Date(desde + JANELA_DO_COALESCER_MS).toISOString(), detail: "coalescer" };
  }
  const r = await sincronizar(admin, row.organization_id);
  // Só o transitório vale retry. Chave quebrada ou leitura inválida não se curam
  // repetindo, e no teto o dreno abriria `event_dead` na Central DA EMPRESA por um
  // problema do dono (§2.5). O `ultimo_erro` já ficou gravado: a Visão geral o
  // mostra ao dono, e a reconciliação de 6 h relê quando ele consertar.
  if (r.tipo === "falhou") {
    return r.transitorio
      ? resultado("error", `leitura do provedor falhou: ${r.erro}`)
      : resultado("skipped", `leitura_nao_transitoria:${r.erro}`);
  }
  return resultado("ok", r.tipo);
}

export const cobrancaSinalHandler: EventHandler = {
  key: CONSUMER_KEY,
  naOrgParada: "roda",
  events: ["cobranca.sinal"],
  handle,
};
