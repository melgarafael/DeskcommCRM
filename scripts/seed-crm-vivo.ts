/**
 * Seed de demonstração do CRM Vivo (Wave 0) — board determinístico em estados
 * variados. Sem isto, toda verificação visual passa num board vazio e não prova nada.
 *
 * Cria um pipeline PRÓPRIO ("CRM Vivo — Clínica") em vez de sujar o "Pedidos" da org
 * de teste, por três motivos:
 *   1. determinismo — "Pedidos" acumulou dezenas de leads órfãos de e2e antigos; um
 *      board poluído não prova "altura constante" nem passa no teste do metro;
 *   2. `expected_duration_hours` — nenhum estágio de "Pedidos" tem o campo preenchido,
 *      e o estado "Esfriando" (CORE 5) depende dele;
 *   3. promessa multi-nicho — estágios de clínica exercitam o mapa configurável
 *      enum→estágio que a ponte (Wave 8) precisa provar.
 *
 * Idempotente: upsert por (organization_id, title). Rodar N vezes dá o mesmo board.
 * Incremental: ganha um bloco a cada wave que adiciona coluna (owner_agent_id na
 * Wave 1, ai_probability na Wave 5, …). Aqui só entra o que o schema de hoje aceita.
 *
 * Depende de .e2e-creds.json (rode scripts/seed-e2e-credentials.ts antes).
 * Não colide com scripts/seed-e2e-kanban.ts — títulos e pipeline são outros, e
 * kanban-owner-filter.spec.ts continua enxergando os leads dele.
 *
 * Run: npx tsx scripts/seed-crm-vivo.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";
import { carregarEnvLocal } from "../scripts/lib/env-de-teste";

const env = carregarEnvLocal();

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const PIPELINE_SLUG = "crm-vivo-clinica";
const HOUR = 3_600_000;

interface Creds {
  org_id: string;
  users: Record<string, { id: string }>;
  crm_vivo?: unknown;
}

/** Estágios da clínica. `expected_duration_hours` é o prazo que o CORE 5 vigia. */
const STAGES = [
  { slug: "primeiro_contato", name: "Primeiro contato", position: 1000, hours: 24 },
  { slug: "avaliacao", name: "Avaliação", position: 2000, hours: 48 },
  { slug: "proposta", name: "Proposta enviada", position: 3000, hours: 72 },
  { slug: "negociacao", name: "Negociação", position: 4000, hours: 96 },
  { slug: "fechado", name: "Tratamento fechado", position: 5000, hours: null, isWon: true },
  { slug: "perdido", name: "Perdido", position: 6000, hours: null, isLost: true },
] as const;

const LONG_TITLE =
  "Clínica Vitalis — pacote completo de implantes dentários com enxerto ósseo, " +
  "protocolo superior e acompanhamento de 24 meses";

/**
 * O board de demonstração. Cada linha existe para provar um caso da régua visual
 * (§5 do briefing) — nenhuma é decorativa.
 */
const LEADS = [
  {
    key: "dono_humano",
    title: "Clínica Vitalis — implantes",
    stage: "negociacao",
    owner: "manager" as const,
    valueCents: 1_240_000,
    tags: ["implante"],
    staleHours: 2,
    why: "dono humano, valor cheio, dentro do prazo — o card 'normal'",
  },
  {
    key: "sem_dono",
    title: "Marina Costa — clareamento",
    stage: "primeiro_contato",
    owner: null,
    valueCents: 180_000,
    tags: [],
    staleHours: 3,
    why: "sem responsável — prova o estado vazio do slot de dono",
  },
  {
    key: "valor_nulo",
    title: "Rogério Paiva — avaliação inicial",
    stage: "avaliacao",
    // Wave 1 (0070): dono AGENTE. Resolvido por nome, nunca por uuid fixo —
    // um clone tem outros ids. Se o agente não existir, cai para sem dono.
    agentOwner: "Lia — AgendaPlus",
    owner: null,
    valueCents: null,
    tags: ["primeira-consulta"],
    staleHours: 5,
    why: "valor nulo + dono agente — faixa ② não pode virar 'R$ NaN'; avatar vazado com anel",
  },
  {
    key: "titulo_longo",
    title: LONG_TITLE,
    stage: "proposta",
    owner: "manager" as const,
    valueCents: 3_890_000,
    tags: ["implante", "enxerto"],
    staleHours: 8,
    why: "título de 120+ caracteres — altura constante sob texto longo",
  },
  {
    key: "muitas_tags",
    title: "Família Andrade — 4 tratamentos",
    stage: "avaliacao",
    owner: "agent" as const,
    valueCents: 2_150_000,
    tags: [
      "implante",
      "ortodontia",
      "clareamento",
      "canal",
      "protese",
      "familia",
      "convenio",
      "indicacao",
    ],
    staleHours: 12,
    why: "8 tags — provam que tags saíram do card (§5) sem quebrar layout",
  },
  {
    key: "esfriando",
    title: "Bruno Tavares — protocolo superior",
    stage: "proposta",
    owner: "manager" as const,
    valueCents: 4_500_000,
    tags: ["protocolo"],
    staleHours: 150, // estágio "proposta" espera 72h → estourado por 2x
    why: "estourou expected_duration_hours do estágio — estado Esfriando (CORE 5)",
  },
  {
    key: "esfriando_critico",
    title: "Helena Marques — ortodontia adulto",
    stage: "negociacao",
    owner: null,
    valueCents: 960_000,
    tags: ["ortodontia"],
    staleHours: 480, // 20 dias
    why: "frio há 20 dias E sem dono — o pior caso, tem que gritar no board",
  },
  {
    key: "fresco_alto_valor",
    title: "Grupo Odonto Sul — contrato corporativo",
    stage: "negociacao",
    owner: "admin" as const,
    valueCents: 12_400_000,
    tags: ["corporativo"],
    staleHours: 1,
    why: "maior valor do board — tabular-nums alinhado com os demais",
  },
  {
    key: "primeiro_contato_novo",
    title: "Caio Ribeiro — dor de dente",
    stage: "primeiro_contato",
    agentOwner: "Bot Padrão E2E",
    owner: null,
    valueCents: 45_000,
    tags: ["urgencia"],
    staleHours: 1,
    why: "menor valor + segundo dono agente, em outra coluna — prova o filtro por agente",
  },
  {
    key: "avaliacao_media",
    title: "Patrícia Nunes — prótese fixa",
    stage: "avaliacao",
    owner: "manager" as const,
    valueCents: 780_000,
    tags: ["protese"],
    staleHours: 60, // estágio "avaliacao" espera 48h → levemente estourado
    why: "estouro leve do prazo — a fronteira do Esfriando, não o caso extremo",
  },
  {
    // O caso que faltava e é o mais importante do CORE 5: o agente É O DONO e o
    // lead ESFRIOU MESMO ASSIM. Não é "ninguém está olhando" — é "quem está
    // olhando não conseguiu destravar". É aqui que o humano precisa decidir se
    // assume, e é o único estado em que o Radar tem de mostrar um dono-agente.
    key: "agente_esfriando",
    title: "Sônia Vasconcelos — implante unitário",
    stage: "proposta", // janela de 72h
    agentOwner: "Lia — AgendaPlus",
    owner: null,
    valueCents: 690_000,
    tags: ["implante"],
    staleHours: 200, // ~8 dias: estoura a janela de 72h com folga
    why: "dono agente E esfriando — o humano decide se assume; o Radar tem de nomear o agente",
  },
  {
    // O ESPÉCIME. Este contato existe de verdade no banco e o agente já
    // conversou 33 turnos com ele (lead_checkpoints) e decidiu 87 vezes se
    // enviava (before_send_traces), com lead_state.stage='qualified' — e o CRM
    // NÃO tinha negócio nenhum para ele. É a doença dos dois funis paralelos em
    // estado puro. Ligar um crm_lead a este contato é o que dá à Wave 3 um caso
    // com histórico REAL para traduzir contato→negócio, em vez de dado sintético.
    key: "ponte_real",
    title: "Carlos — Clínica Vida Odonto · manutenção de protocolo",
    stage: "negociacao",
    contactRef: "Carlos — Clínica Vida Odonto",
    agentOwner: "Lia — AgendaPlus",
    owner: null,
    valueCents: 2_800_000,
    tags: ["protocolo", "manutencao"],
    staleHours: 30,
    why: "contato com histórico real do harness (33 checkpoints, 87 traces) — o caso da ponte",
  },
] as const;

async function ensurePipeline(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("slug", PIPELINE_SLUG)
    .maybeSingle();

  const vocabulary = {
    lead: "Paciente",
    lead_plural: "Pacientes",
    deal: "Tratamento",
    deal_plural: "Tratamentos",
    won: "Fechado",
    lost: "Perdido",
    stage: "Etapa",
    stage_plural: "Etapas",
  };
  // canonical_tags: a UMA tag que sobrevive no card como ponto de 6px (§5).
  const settings = {
    fields: [],
    canonical_tags: ["implante"],
    lost_reasons: [],
    identity_resolution: { fields_in_priority_order: ["nuit", "phone_e164", "email"] },
  };

  if (existing) {
    const id = (existing as { id: string }).id;
    await admin
      .from("crm_pipelines")
      .update({ vocabulary, settings } as never)
      .eq("id", id);
    console.log(`[seed] pipeline existente: ${id}`);
    return id;
  }

  const { data, error } = await admin
    .from("crm_pipelines")
    .insert({
      organization_id: orgId,
      name: "CRM Vivo — Clínica",
      slug: PIPELINE_SLUG,
      description: "Board de demonstração do CRM Vivo. Determinístico e re-executável.",
      is_default: false,
      position: 9000,
      vocabulary,
      settings,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert pipeline: ${error?.message}`);
  const id = (data as { id: string }).id;
  console.log(`[seed] pipeline criado: ${id}`);
  return id;
}

async function ensureStages(
  orgId: string,
  pipelineId: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const s of STAGES) {
    const row = {
      organization_id: orgId,
      pipeline_id: pipelineId,
      name: s.name,
      slug: s.slug,
      position: s.position,
      expected_duration_hours: s.hours,
      is_won: "isWon" in s ? s.isWon : false,
      is_lost: "isLost" in s ? s.isLost : false,
      is_archived: false,
    };
    const { data: existing } = await admin
      .from("crm_stages")
      .select("id")
      .eq("pipeline_id", pipelineId)
      .eq("slug", s.slug)
      .maybeSingle();
    if (existing) {
      const id = (existing as { id: string }).id;
      await admin.from("crm_stages").update(row as never).eq("id", id);
      ids[s.slug] = id;
      continue;
    }
    const { data, error } = await admin
      .from("crm_stages")
      .insert(row as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert stage ${s.slug}: ${error?.message}`);
    ids[s.slug] = (data as { id: string }).id;
  }
  console.log(`[seed] ${STAGES.length} estágios garantidos`);
  return ids;
}

/**
 * Agentes resolvidos por NOME, nunca por uuid fixo: um clone tem outros ids.
 * Devolve mapa nome→id só dos que existirem — o seed continua válido numa org
 * sem nenhum agente (os leads correspondentes ficam sem dono).
 */
async function resolveAgents(orgId: string, names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (names.length === 0) return found;
  const { data, error } = await admin
    .from("ai_agents")
    .select("id,name")
    .eq("organization_id", orgId)
    .in("name", names);
  if (error) throw new Error(`resolver agentes: ${error.message}`);
  for (const a of (data ?? []) as { id: string; name: string }[]) found.set(a.name, a.id);
  for (const n of names) {
    if (!found.has(n)) {
      console.warn(`[seed] agente "${n}" não existe nesta org — lead ficará sem dono`);
    }
  }
  return found;
}

/**
 * Contatos resolvidos por NOME — mesma razão dos agentes: um clone tem outros
 * ids. Um contato que o harness já conhece (tem `lead_state`/`lead_checkpoints`)
 * é o que dá à ponte um caso com histórico real em vez de dado sintético.
 */
async function resolveContacts(orgId: string, names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (names.length === 0) return found;
  const { data, error } = await admin
    .from("contacts")
    .select("id,name")
    .eq("organization_id", orgId)
    .in("name", names);
  if (error) throw new Error(`resolver contatos: ${error.message}`);
  for (const c of (data ?? []) as { id: string; name: string }[]) found.set(c.name, c.id);
  for (const n of names) {
    if (!found.has(n)) console.warn(`[seed] contato "${n}" não existe — lead ficará sem contato`);
  }
  return found;
}

async function upsertLead(
  orgId: string,
  pipelineId: string,
  stageIds: Record<string, string>,
  spec: (typeof LEADS)[number],
  ownerIds: Record<string, string>,
  agentIds: Map<string, string>,
  contactIds: Map<string, string>,
  position: number,
): Promise<string> {
  const stageId = stageIds[spec.stage];
  if (!stageId) throw new Error(`estágio desconhecido: ${spec.stage}`);
  const lastActivityAt = new Date(Date.now() - spec.staleHours * HOUR).toISOString();

  const agentName = "agentOwner" in spec ? spec.agentOwner : undefined;
  const ownerAgentId = agentName ? (agentIds.get(agentName) ?? null) : null;
  // A constraint crm_leads_owner_kind_coherence exige exatamente UM dono.
  const ownerUserId = ownerAgentId ? null : spec.owner ? ownerIds[spec.owner]! : null;
  const ownerKind = ownerAgentId ? "ai" : ownerUserId ? "user" : null;

  const contactRef = "contactRef" in spec ? spec.contactRef : undefined;
  const contactId = contactRef ? (contactIds.get(contactRef) ?? null) : null;

  const mutable = {
    stage_id: stageId,
    contact_id: contactId,
    owner_user_id: ownerUserId,
    owner_agent_id: ownerAgentId,
    owner_kind: ownerKind,
    assigned_at: ownerKind ? lastActivityAt : null,
    value_cents: spec.valueCents,
    currency: spec.valueCents === null ? null : "BRL",
    tags: spec.tags,
    last_activity_at: lastActivityAt,
    position_in_stage: position,
    description: spec.why,
  };

  const { data: existing } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .eq("title", spec.title)
    .maybeSingle();

  if (existing) {
    const id = (existing as { id: string }).id;
    const { error } = await admin.from("crm_leads").update(mutable as never).eq("id", id);
    if (error) throw new Error(`update lead "${spec.key}": ${error.message}`);
    console.log(`[seed] lead atualizado ${spec.key}: ${id}`);
    return id;
  }

  const { data, error } = await admin
    .from("crm_leads")
    .insert({
      organization_id: orgId,
      pipeline_id: pipelineId,
      title: spec.title,
      status: "open",
      source: "manual",
      ...mutable,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insert lead "${spec.key}": ${error?.message}`);
  const id = (data as { id: string }).id;
  console.log(`[seed] lead criado ${spec.key}: ${id}`);
  return id;
}


/**
 * Garante que o board da demo TENHA o que a Wave 4 mostra.
 *
 * O `@QAVivo` mediu a interseção "contato com `next_action`" × "negócio aberto" e
 * ela oscilou 0 → 1 → 1 → 0 entre rodadas: os testes movem e fecham leads, e o
 * caso da demo evaporava. **Feature que passa no teste e some do board não está
 * entregue** — quem abrir o Kanban precisa ver a próxima ação, não só o CI.
 *
 * REGRA: só preenche quando está VAZIO. Nunca sobrescreve o que o agente
 * realmente decidiu — o Carlos tem 33 turnos e 87 decisões de envio reais, e
 * apagar a proposta dele para pôr uma de semente seria trocar dado por cenário,
 * que é o oposto do que esta entrega defende.
 */
async function garantirProximaAcao(
  orgId: string,
  contactIds: Map<string, string>,
): Promise<void> {
  const PROPOSTAS: Record<string, string> = {
    "Carlos — Clínica Vida Odonto":
      "Confirmar a data da manutenção do protocolo e enviar o orçamento revisado",
    "P A N A R O": "Retomar contato — sem resposta desde a última proposta",
  };

  let postos = 0;
  const naoResolvidos: string[] = [];
  for (const [nome, acao] of Object.entries(PROPOSTAS)) {
    const contactId = contactIds.get(nome) ?? (await resolverPorExibicao(orgId, nome));
    if (!contactId) {
      // GRITA. A versão anterior fazia `continue` calado, e o @QAVivo achou:
      // o alvo "Sônia Vasconcelos" não existe como contato (o lead dela está
      // com contact_id nulo), então metade desta garantia era INERTE — e o
      // board parecia protegido com 3 propostas quando só UMA era garantida.
      // A função vizinha (`resolveContacts`) avisa quando um alvo não existe;
      // este laço pulava em silêncio, no arquivo ao lado do que faz certo.
      naoResolvidos.push(nome);
      continue;
    }

    const { data: atual } = await admin
      .from("lead_state")
      .select("id,next_action")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .maybeSingle();

    const jaTem = typeof atual?.next_action === "string" && atual.next_action.trim() !== "";
    if (jaTem) continue;

    const { error } = atual
      ? await admin.from("lead_state").update({ next_action: acao }).eq("id", atual.id)
      : await admin
          .from("lead_state")
          .insert({ organization_id: orgId, contact_id: contactId, next_action: acao });
    if (error) throw new Error(`próxima ação de ${nome}: ${error.message}`);
    postos += 1;
  }
  if (postos > 0) console.log(`   próxima ação semeada em ${postos} contato(s) que estavam sem`);
  if (naoResolvidos.length > 0) {
    console.warn(
      `   ⚠ próxima ação NÃO garantida para: ${naoResolvidos.join(", ")} — ` +
        `contato inexistente na org. O board pode mostrar a proposta destes por dado VIVO do ` +
        `agente, que o seed não protege: se sair, a demo encolhe sem ninguém saber.`,
    );
  }
}

/**
 * Segunda tentativa de resolver o alvo: por `display_name`.
 *
 * Contato do WhatsApp costuma chegar com `name` nulo e só o `display_name`
 * preenchido — foi o caso do "P A N A R O Especialista", que tem proposta viva
 * do agente e ficava fora da garantia por causa da coluna consultada.
 */
async function resolverPorExibicao(orgId: string, nome: string): Promise<string | null> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .ilike("display_name", `%${nome}%`)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;
  const ownerIds: Record<string, string> = {
    admin: creds.users.admin!.id,
    manager: creds.users.manager!.id,
    agent: creds.users.agent!.id,
  };

  const pipelineId = await ensurePipeline(orgId);
  const stageIds = await ensureStages(orgId, pipelineId);

  const agentNames = [
    ...new Set(
      LEADS.flatMap((l) => ("agentOwner" in l && l.agentOwner ? [l.agentOwner] : [])),
    ),
  ];
  const agentIds = await resolveAgents(orgId, agentNames);

  const contactNames = [
    ...new Set(
      LEADS.flatMap((l) => ("contactRef" in l && l.contactRef ? [l.contactRef] : [])),
    ),
  ];
  const contactIds = await resolveContacts(orgId, contactNames);

  const leadIds: Record<string, string> = {};
  let position = 1000;
  for (const spec of LEADS) {
    leadIds[spec.key] = await upsertLead(
      orgId,
      pipelineId,
      stageIds,
      spec,
      ownerIds,
      agentIds,
      contactIds,
      position,
    );
    position += 1000;
  }

  await garantirProximaAcao(orgId, contactIds);

  creds.crm_vivo = {
    pipeline_id: pipelineId,
    pipeline_slug: PIPELINE_SLUG,
    stage_ids: stageIds,
    lead_ids: leadIds,
    agent_ids: Object.fromEntries(agentIds),
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));

  console.log(
    `\n✅ Seed CRM Vivo completo: ${LEADS.length} leads em ${STAGES.length} estágios.` +
      `\n   Board: /app/pipelines/${pipelineId}`,
  );
}

main().catch((err) => {
  console.error("❌ Seed CRM Vivo falhou:", err);
  process.exit(1);
});
