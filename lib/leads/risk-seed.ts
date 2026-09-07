import { protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import type { SupabaseClient } from "@supabase/supabase-js";

import { classifyRisk, resolveStageWindow, type RiskBucket } from "@/lib/leads/risk-radar";
import { sinceDoBucket } from "@/lib/leads/risk-since";

/**
 * A ESTREIA do estado de risco: grava o que JÁ existe, sem mentir sobre quando
 * aconteceu e sem deixar o acervo absolvido por decreto de migração.
 *
 * Três decisões, e cada uma responde a um jeito específico de errar:
 *
 *  1. ZERO ATIVIDADE DE TIMELINE. Os negócios do acervo esfriaram há dias;
 *     emitir "esfriou agora" para cada um encheria a linha do tempo de eventos
 *     falsos, e falso na superfície que promete contar a vida do negócio é pior
 *     que ausência. Da estreia em diante, só TRAVESSIA REAL emite.
 *
 *  2. `since` NO PASSADO (ver `risk-since.ts`). Com `since = now`, o histórico
 *     diria para sempre que cinquenta negócios esfriaram no mesmo minuto.
 *
 *  3. UM item de caixa agregado, com dono e AÇÃO NOMEADA — não cinquenta itens,
 *     e não zero. O `event_log` sozinho é rastro de máquina: registra que
 *     aconteceu e não coloca ninguém para agir. Cinquenta itens seriam ruído
 *     equivalente a nenhum. "Revise os N e decida quais encerrar" é trabalho.
 *
 * ⚠️ A CLASSIFICAÇÃO VEM DE `classifyRisk`, nunca de SQL reescrito aqui. O radar
 * (`/api/v1/leads/at-risk`), o card e este seed têm de dizer a MESMA coisa sobre
 * o mesmo negócio; uma segunda definição de "esfriando" começaria idêntica e
 * divergiria no primeiro ajuste de janela — e a divergência apareceria como
 * "o card diz uma coisa e o radar diz outra", que ninguém consegue depurar.
 */

/**
 * ⚠️ `detected_at` NÃO É ENVIADO — vem do default `now()` do BANCO.
 *
 * ⚠️ DOIS RELÓGIOS NA MESMA DECISÃO É DEFEITO, e este custou uma quebra real: o
 * `since` deriva de `last_activity_at`, que o trigger carimba com o `now()` do
 * BANCO; o `detected_at` vinha de `new Date()`, que é o relógio do PROCESSO.
 * Medido nesta máquina: o banco está 2 SEGUNDOS à frente. Um negócio tocado no
 * instante anterior à passada do worker produzia `since > detected_at` e o
 * INSERT morria em `crm_lead_risk_states_since_no_passado` — o worker inteiro
 * abortava por causa de dois segundos.
 *
 * A constraint estava CERTA: ela pegou a incoerência que eu não teria visto.
 * O conserto é ancorar os dois no MESMO relógio, e ele é o do banco, porque é o
 * banco que carimba os fatos com que a decisão é tomada. `since` já era do
 * banco (deriva de `last_activity_at`); `detected_at` passa a ser também, por
 * omissão.
 *
 * O relógio do processo continua CLASSIFICANDO (o `now` de `classifyRisk`), e
 * isso é aceitável por uma razão que vale escrever: a classificação compara
 * JANELAS DE HORAS, onde segundos não mudam bucket. O `CHECK` compara INSTANTES,
 * onde mudam. Grandezas diferentes toleram precisões diferentes — e confundir as
 * duas foi exatamente o defeito.
 */
/** Um negócio classificado AGORA — o que o seed grava e o worker compara. */
export interface EstadoCalculado {
  leadId: string;
  contactId: string | null;
  bucket: RiskBucket;
  since: Date;
  coldHours: number;
}

export interface ResultadoDoSeed {
  gravados: number;
  porBucket: Record<RiskBucket, number>;
  /** Negócios abertos sem relógio nenhum (sem atividade e sem created_at). */
  semRelogio: number;
  itemDeCaixaId: string | null;
}

interface LeadRow {
  id: string;
  stage_id: string;
  contact_id: string | null;
  last_activity_at: string | null;
  created_at: string | null;
}

/**
 * O estado de risco de cada negócio aberto da org, AGORA.
 *
 * Compartilhada entre o seed (que grava tudo, uma vez) e o observador de
 * travessia (que compara com o gravado). Extraída e não copiada porque uma
 * segunda definição de "esfriando" começaria idêntica e divergiria no primeiro
 * ajuste de janela — e a divergência apareceria para o usuário como "o card diz
 * uma coisa e o radar diz outra", que ninguém consegue depurar.
 *
 * Devolve também `semRelogio`: negócio sem `last_activity_at` E sem `created_at`
 * fica de FORA e é CONTADO. Chutar `now` o marcaria como recém-tocado e o
 * esconderia do radar para sempre — buraco silencioso no lugar de buraco visível.
 */
export async function calculaBucketsAtuais(
  admin: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<EstadoCalculado[]> {
  const { estados } = await coletaEClassifica(admin, organizationId, now);
  return estados;
}

async function coletaEClassifica(
  admin: SupabaseClient,
  organizationId: string,
  now: Date,
): Promise<{ estados: EstadoCalculado[]; semRelogio: number }> {
  const { data: leadRows, error: leadErr } = await admin
    .from("crm_leads")
    .select("id, stage_id, contact_id, last_activity_at, created_at")
    .eq("organization_id", organizationId)
    .eq("status", "open");
  if (leadErr) throw new Error(`seed de risco: ${leadErr.message}`);
  const leads = (leadRows ?? []) as LeadRow[];

  const stageIds = [...new Set(leads.map((l) => l.stage_id).filter(Boolean))];
  const janelaPorEstagio = new Map<string, ReturnType<typeof resolveStageWindow>>();
  if (stageIds.length > 0) {
    const { data: stages } = await admin
      .from("crm_stages")
      .select("id, expected_duration_hours")
      .eq("organization_id", organizationId)
      .in("id", stageIds);
    for (const s of (stages ?? []) as Array<{ id: string; expected_duration_hours: number | null }>) {
      janelaPorEstagio.set(s.id, resolveStageWindow(s));
    }
  }

  // "em voo" = a IA prometeu voltar. Sem isto, um negócio com follow-up agendado
  // entraria como `critico` na estreia e apareceria como abandono — o oposto do
  // que ele é. A fonte é a mesma que o radar usa.
  const contactIds = [...new Set(leads.map((l) => l.contact_id).filter((c): c is string => !!c))];
  const followupPorContato = new Set<string>();
  if (contactIds.length > 0) {
    const { data: jobs } = await admin
      .from("cron_jobs")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .eq("kind", "at")
      .eq("enabled", true)
      .gt("next_run_at", now.toISOString())
      .in("contact_id", contactIds);
    for (const j of (jobs ?? []) as Array<{ contact_id: string }>) {
      followupPorContato.add(j.contact_id);
    }
  }

  const agenda = await protecaoAgendaSupabase(admin, organizationId, contactIds, now);
  if ([...agenda.values()].some(p => p.motivo === "leitura_indisponivel")) throw new Error("risk_agenda_indisponivel");
  const estados: EstadoCalculado[] = [];
  let semRelogio = 0;

  for (const l of leads) {
    const relogio = l.last_activity_at ?? l.created_at;
    if (!relogio) {
      semRelogio += 1;
      continue;
    }
    const lastActivityAt = new Date(relogio);
    const window = janelaPorEstagio.get(l.stage_id) ?? resolveStageWindow(null);
    const { bucket } = classifyRisk({
      lastActivityAt,
      now,
      inFlight: l.contact_id ? followupPorContato.has(l.contact_id) : false,
      window,
      agenda: l.contact_id ? agenda.get(l.contact_id) : undefined,
    });
    estados.push({
      leadId: l.id,
      contactId: l.contact_id,
      bucket,
      since: sinceDoBucket(bucket, lastActivityAt, window),
      coldHours: window.coldHours,
    });
  }
  return { estados, semRelogio };
}

export async function semeiaEstadosDeRisco(
  admin: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<ResultadoDoSeed> {
  const { estados, semRelogio } = await coletaEClassifica(admin, organizationId, now);
  const porBucket: Record<RiskBucket, number> = { critico: 0, em_risco: 0, em_voo: 0, em_dia: 0 };
  for (const e of estados) porBucket[e.bucket] += 1;
  const linhas = estados.map((e) => ({
    lead_id: e.leadId,
    organization_id: organizationId,
    bucket: e.bucket,
    since: e.since.toISOString(),
    cold_hours: e.coldHours,
  }));

  if (linhas.length > 0) {
    // `upsert` e não `insert`: a estreia tem de poder ser re-executada sem
    // duplicar nem quebrar — quem rodar duas vezes por engano não pode ficar
    // com metade do acervo gravado e um erro na tela.
    const { error } = await admin
      .from("crm_lead_risk_states")
      .upsert(linhas, { onConflict: "lead_id" });
    if (error) throw new Error(`seed de risco (gravação): ${error.message}`);
  }

  const emRisco = porBucket.critico + porBucket.em_risco;

  // O rastro de máquina — para o acervo não aparecer do nada sem origem.
  await admin.rpc("emit_event", {
    p_event_type: "lead.risk_backlog_seeded",
    p_entity_kind: "organization",
    p_entity_id: organizationId,
    p_payload: { ...porBucket, sem_relogio: semRelogio, total: linhas.length },
    p_metadata: { source: "lib/leads/risk-seed.ts" },
    p_organization_id: organizationId,
  });

  // E o item humano. Só nasce se houver o que revisar (caixa com item de zero
  // negócios é a definição de ruído) e SÓ SE JÁ NÃO HOUVER UM ABERTO.
  //
  // A segunda guarda não é teórica: a primeira versão era idempotente nos
  // ESTADOS (upsert por lead) e não no ITEM, então rodar o seed duas vezes —
  // que o script permite e a doutrina exige — criava dois agregados. Um item
  // que se duplica ao ser reprocessado é a mesma praga que ele existe para
  // evitar: a caixa vira lista de avisos repetidos e o operador para de abrir.
  //
  // A checagem é por `status = 'open'`: item já resolvido NÃO bloqueia um novo.
  // Se o operador revisou o acervo e fechou o item, um acervo novo merece
  // convite novo — bloquear por item fechado esconderia trabalho real.
  let itemDeCaixaId: string | null = null;
  const { data: jaAberto } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", "risk_backlog_seeded")
    .eq("status", "open")
    .maybeSingle();
  if (jaAberto) {
    itemDeCaixaId = (jaAberto as { id: string }).id;
  } else if (emRisco > 0) {
    const { data: item } = await admin
      .from("agent_inbox_items")
      .insert({
        organization_id: organizationId,
        kind: "risk_backlog_seeded",
        severity: emRisco > 10 ? "warn" : "info",
        // A AÇÃO VAI NO TÍTULO. "48 negócios em risco" é um número e não move
        // ninguém; o item precisa dizer o que fazer com ele.
        title: `Revise ${emRisco} ${emRisco === 1 ? "negócio parado" : "negócios parados"} e decida quais encerrar`,
        body:
          `${porBucket.critico} sem resposta há muito tempo e ${porBucket.em_risco} esfriando. ` +
          `Eles já estavam assim antes de o sistema passar a acompanhar — por isso ` +
          `aparecem juntos agora, e não porque algo aconteceu hoje. ` +
          `Encerrar o que morreu é o que faz o radar voltar a significar alguma coisa.`,
        ref_kind: "organization",
        ref_id: organizationId,
      })
      .select("id")
      .maybeSingle();
    itemDeCaixaId = (item as { id: string } | null)?.id ?? null;
  }

  return { gravados: linhas.length, porBucket, semRelogio, itemDeCaixaId };
}
