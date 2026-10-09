/**
 * Aviso na Central quando um negócio ENTRA numa etapa marcada para avisar
 * (`crm_stages.avisar_na_central`, migration 0440).
 *
 * ─── Por que uma etapa, e não o ganho ───────────────────────────────────────
 *
 * O produto já avisa o ganho (`lead.won` → push ao dono do negócio). Numa
 * operação de pagamento na entrega, porém, o ganho é a ENTREGA — e o momento
 * que pede ação da equipe vem antes: o cliente confirmou o pedido com todos os
 * dados e alguém precisa separar e despachar. Qual etapa é essa é decisão da
 * organização; o código só obedece a marca.
 *
 * ─── Por que `kind = 'other'` e `ref_kind = 'lead'` ─────────────────────────
 *
 * `other` já existe no vocabulário do banco e já tem destino "Abrir negócio"
 * (`POLITICAS_DE_AVISO.other` em `lib/ai/inbox-destino.ts`). Um kind novo
 * exigiria reconstruir o CHECK de `agent_inbox_items`, que tem bloco único no
 * baseline — custo sem ganho para um aviso que é, por natureza, genérico.
 *
 * ─── Sem dado pessoal no texto ──────────────────────────────────────────────
 *
 * O título do negócio costuma ser o nome ou o telefone do cliente. O aviso diz
 * só a ETAPA e aponta para o negócio: quem abre vê o resto com a permissão que
 * tem, e a anonimização (LGPD) não precisa alcançar esta linha.
 *
 * O texto sai no idioma da ORGANIZAÇÃO, porque a Central mostra título e corpo
 * como foram gravados (`./aviso-de-etapa.ts`).
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";

import { corpoDoAvisoDeEtapa, tituloDoAvisoDeEtapa } from "./aviso-de-etapa";

const CONSUMER_KEY = "leads.aviso-de-etapa";

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

/**
 * Falha do banco é `error`, não `retry`: o `retry` do dreno é o reagendamento
 * BENIGNO (janela de envio, espera de rede) e não conta tentativa — uma falha
 * que não passa ficaria girando para sempre. Com `error`, o dreno aplica o
 * backoff, conta a tentativa e, no teto, marca o evento morto e avisa na
 * Central (`lib/event-log/drain.ts`).
 */
const falhou = (detail: string): HandlerResult => ({ consumer_key: CONSUMER_KEY, status: "error", detail });

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor : null;
}

async function handle(row: EventRow): Promise<HandlerResult> {
  const leadId = row.entity_id;
  const etapaId = texto(row.payload?.to_stage_id);
  if (!leadId || !etapaId) return resultado("skipped", "sem_etapa_de_destino");
  if (texto(row.payload?.from_stage_id) === etapaId) return resultado("skipped", "mesma_etapa");

  const admin = createAdminClient();

  // ⚠️ Organização junto do id: o client é service-role e ignora RLS.
  const { data: etapa, error } = await admin
    .from("crm_stages")
    .select("name, avisar_na_central")
    .eq("id", etapaId)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (error) return falhou(`leitura da etapa falhou: ${error.message}`);
  const lida = etapa as { name: string; avisar_na_central: boolean | null } | null;
  if (!lida?.avisar_na_central) return resultado("skipped", "etapa_sem_aviso");

  const { data: org } = await admin
    .from("organizations")
    .select("locale")
    .eq("id", row.organization_id)
    .maybeSingle();
  const idioma = normalizarIdioma((org as { locale?: string | null } | null)?.locale);
  const titulo = tituloDoAvisoDeEtapa(lida.name, idioma);

  // Um aviso aberto por negócio e etapa: o mesmo evento reprocessado, ou um
  // negócio que sai e volta antes de alguém ler, não empilha itens iguais.
  const { data: jaAberto, error: erroDaBusca } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", row.organization_id)
    .eq("kind", "other")
    .eq("ref_kind", "lead")
    .eq("ref_id", leadId)
    .eq("status", "open")
    .eq("title", titulo)
    .limit(1);
  if (erroDaBusca) return falhou(`busca de aviso aberto falhou: ${erroDaBusca.message}`);
  if ((jaAberto ?? []).length > 0) return resultado("skipped", "aviso_ja_aberto");

  const { error: erroDoInsert } = await admin.from("agent_inbox_items").insert({
    organization_id: row.organization_id,
    kind: "other",
    severity: "info",
    title: titulo,
    body: corpoDoAvisoDeEtapa(idioma),
    ref_kind: "lead",
    ref_id: leadId,
  });
  if (erroDoInsert) return falhou(`aviso não entrou na Central: ${erroDoInsert.message}`);
  return resultado("ok", "aviso_aberto");
}

export const avisoDeEtapaHandler: EventHandler = {
  key: CONSUMER_KEY,
  naOrgParada: "roda",
  events: ["lead.stage_changed"],
  handle,
};
