import type { SupabaseClient } from "@supabase/supabase-js";

import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoAviso, preencher } from "@/lib/i18n/idioma-do-aviso";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";

/**
 * A PROPOSTA DE REATIVAÇÃO: nasce quando o negócio esfria, vence sozinha, e o
 * vencimento tem destino.
 *
 * ⚠️ O PRAZO É O CORAÇÃO DISTO, e a forma vale além daqui: promessa cujo fim
 * depende de outra pessoa agir NÃO É PRAZO — é condição. Sem um fallback
 * declarado, ela não é quebrada por decisão: **expira sozinha e ninguém percebe
 * que decidiu**. Aqui o fallback é o item de caixa, e ele existe justamente
 * para o vencimento não ser silêncio.
 *
 * ⚠️ E O VENCIMENTO NÃO MEXE NO BUCKET DE RISCO. O bucket mede SILÊNCIO DO
 * CLIENTE; ninguém falou com ele, então nada mudou do lado dele. A inação foi do
 * TIME, e misturar as duas coisas corromperia o significado do bucket — um
 * negócio pareceria mais frio porque a gente demorou a decidir, não porque o
 * cliente sumiu mais.
 */

/** Nasce sem rascunho de propósito — ver `propoeReativacao`. */
export interface PropostaCriada {
  id: string;
  leadId: string;
  expiresAt: Date;
}

/**
 * Propõe a reativação de um negócio que acabou de esfriar.
 *
 * ⚠️ O RASCUNHO NASCE VAZIO e o agente preenche depois. Se a proposta só
 * existisse com texto de LLM, uma indisponibilidade do provedor viraria
 * SILÊNCIO — e silêncio é exatamente a doença que esta wave existe para curar.
 * "Sem rascunho ainda" é um estado honesto que a tela sabe mostrar; "proposta
 * que não nasceu" não é estado nenhum, é ausência.
 *
 * Devolve `null` quando já existe proposta viva — o índice único parcial
 * garante no banco, e aqui a gente evita o erro em vez de tratá-lo.
 */
export async function propoeReativacao(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    leadId: string;
    /** A MESMA janela que definiu o esfriamento — ver o cabeçalho da 0082. */
    coldHours: number;
    now?: Date;
  },
): Promise<PropostaCriada | null> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.coldHours * 3_600_000);

  // ⚠️ NEGÓCIO SEM CONTATO NÃO RECEBE PROPOSTA, e isso não é detalhe: a
  // proposta é "retomar CONTATO", e o envio viaja por `cron_jobs`, que é
  // indexado por `contact_id`. Sem contato não há para quem enviar — a proposta
  // nasceria com um botão que não pode funcionar, e clicar nele produziria uma
  // decisão registrada sem consequência nenhuma. É a simulação de atenção pela
  // porta dos fundos.
  //
  // E não é caso de canto: 25% dos negócios não têm contato (medido na wave 6,
  // quando isso deixou o dossiê mudo). Eles continuam esfriando e aparecendo no
  // radar — o que muda é que a saída deles é humana, não automática.
  const { data: alvo } = await admin
    .from("crm_leads")
    .select("contact_id")
    .eq("id", input.leadId)
    .maybeSingle();
  if (!(alvo as { contact_id: string | null } | null)?.contact_id) return null;

  const { data: viva } = await admin
    .from("crm_lead_reactivations")
    .select("id")
    .eq("lead_id", input.leadId)
    .eq("status", "pending")
    .maybeSingle();
  if (viva) return null;

  const { data, error } = await admin
    .from("crm_lead_reactivations")
    .insert({
      lead_id: input.leadId,
      organization_id: input.organizationId,
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .maybeSingle();
  // Corrida com outro tick: o índice único parcial é quem decide, e perder a
  // corrida não é erro — é o outro tick tendo criado a mesma proposta.
  if (error || !data) return null;

  // NÃO emite atividade ao nascer: o esfriamento já emitiu `lead_cooled` no
  // mesmo instante, e duas linhas para um acontecimento só fariam a timeline
  // parecer que o sistema fala sozinho. A proposta aparece no CARD; o que vira
  // linha é a DECISÃO sobre ela — ou a falta dela, no vencimento.
  return { id: (data as { id: string }).id, leadId: input.leadId, expiresAt };
}

export interface ResultadoDoVencimento {
  vencidas: number;
  itensDeCaixa: number;
  falhasDeAtividade: number;
}

interface PropostaVencida {
  id: string;
  lead_id: string;
  organization_id: string;
  expires_at: string;
  crm_leads: { title: string; contact_id: string | null } | null;
}

/**
 * Vence as propostas cujo prazo passou — o FALLBACK que impede a demanda de
 * morrer por silêncio.
 *
 * Três coisas acontecem juntas e nenhuma sozinha basta:
 *  1. a proposta sai de `pending` (some do card: acaba a simulação de atenção);
 *  2. entra uma linha na timeline (o negócio registra que ninguém decidiu —
 *     isso é acontecimento, não telemetria);
 *  3. nasce UM item de caixa com ação nomeada (a demanda ganha dono e endereço).
 *
 * Sem a 3, "some do card" recria o problema anterior: negócio parado sem
 * ninguém sabendo. Sem a 2, o dossiê não sabe explicar por que o botão sumiu.
 */
export async function venceReativacoes(
  admin: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<ResultadoDoVencimento> {
  const { data, error } = await admin
    .from("crm_lead_reactivations")
    .select("id, lead_id, organization_id, expires_at, crm_leads(title, contact_id)")
    .eq("organization_id", organizationId)
    .eq("status", "pending")
    .lt("expires_at", now.toISOString());
  if (error) throw new Error(`vencimento de reativação: ${error.message}`);

  const vencidas = (data ?? []) as unknown as PropostaVencida[];
  const r: ResultadoDoVencimento = { vencidas: 0, itensDeCaixa: 0, falhasDeAtividade: 0 };
  if (vencidas.length === 0) return r;

  for (const p of vencidas) {
    // `decided_at` preenchido porque o CHECK exige: status não-pendente sem
    // data seria registro que não sabe dizer quando aconteceu. Vencer É uma
    // decisão — a do relógio, na ausência da humana.
    const { error: upErr } = await admin
      .from("crm_lead_reactivations")
      .update({ status: "expired", decided_at: now.toISOString() })
      .eq("id", p.id)
      .eq("status", "pending"); // não atropela quem decidiu no mesmo instante
    if (upErr) continue;
    r.vencidas += 1;

    const atividade = await emitLeadActivity(admin, {
      organizationId,
      leadId: p.lead_id,
      contactId: p.crm_leads?.contact_id ?? null,
      type: "reactivation_expired",
      sourceModule: "crm",
      sourceId: p.lead_id,
      actor: { type: "webhook_source", id: "reactivation-watcher" },
      // Nomeia o que aconteceu, não o conteúdo da proposta: o reason vai para a
      // tela, e a regra do §9 vale igual aqui.
      reason: "A sugestão de retomar contato venceu sem decisão",
      payload: { proposta_id: p.id, expires_at: p.expires_at },
    });
    if (!atividade.ok) {
      r.falhasDeAtividade += 1;
      await registraFalhaDeAtividade(admin, {
        organizationId,
        leadId: p.lead_id,
        tipo: "reactivation_expired",
        origem: "lib/leads/reactivation.venceReativacoes",
        erro: atividade.error,
      });
    }
  }

  if (r.vencidas > 0) {
    // UM item para o lote, não um por proposta: cinquenta avisos idênticos são
    // o mesmo ruído de cinquenta itens do acervo. E reusa o item aberto se já
    // houver — item que se duplica ao reprocessar é a praga que ele evita.
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", "reactivation_expired")
      .eq("status", "open")
      .maybeSingle();
    if (!jaAberto) {
      // A Central mostra o texto como foi gravado: o aviso nasce no idioma da organização.
      const idioma = await idiomaDoAviso(admin, organizationId);
      const um = r.vencidas === 1;
      const { data: item } = await admin
        .from("agent_inbox_items")
        .insert({
          organization_id: organizationId,
          kind: "reactivation_expired",
          severity: "warn",
          title: preencher(
            um
              ? traduzir("Decida sobre {n} negócio parado — a sugestão de retomar venceu", idioma)
              : traduzir("Decida sobre {n} negócios parados — a sugestão de retomar venceu", idioma),
            { n: r.vencidas },
          ),
          body: preencher(
            um
              ? traduzir(
                  "Um negócio esfriou e a sugestão de retomar contato ficou sem resposta até o prazo. Eles saíram do quadro para não parecerem em andamento. Retomar ou encerrar — as duas são decisões; deixar como está é a única que não é.",
                  idioma,
                )
              : traduzir(
                  "{n} negócios esfriaram e a sugestão de retomar contato ficou sem resposta até o prazo. Eles saíram do quadro para não parecerem em andamento. Retomar ou encerrar — as duas são decisões; deixar como está é a única que não é.",
                  idioma,
                ),
            { n: r.vencidas },
          ),
          ref_kind: "organization",
          ref_id: organizationId,
        })
        .select("id")
        .maybeSingle();
      if (item) r.itensDeCaixa = 1;
    }
  }

  return r;
}
