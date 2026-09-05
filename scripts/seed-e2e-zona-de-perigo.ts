/**
 * Fixture da ZONA DE PERIGO (Configurações › Organização) — duas organizações
 * DESCARTÁVEIS, cada uma com os seis tipos de dado que o reset apaga.
 *
 * ⚠️ POR QUE NÃO USA A ORGANIZAÇÃO DO `.e2e-creds.json`.
 * A spec desta feature APAGA tudo da organização ativa. Rodada contra a org
 * compartilhada do harness, ela destruiria a fixture de todas as outras specs
 * do run — e o vermelho apareceria em arquivos que não têm nada a ver com isto.
 * Por isso o cenário inteiro vive em duas organizações próprias:
 *
 *   ZONA A — a que a spec zera pela tela.
 *   ZONA B — a vizinha, que tem de sair INTEIRA. É ela que prova o isolamento:
 *            o DELETE roda com service role, que bypassa RLS, então quem separa
 *            uma organização da outra é só o `.eq("organization_id", …)` da
 *            action. Sem uma segunda organização com dado, um `.eq` esquecido
 *            passaria verde.
 *
 * O usuário é o `manager` do harness — de propósito. Ele é `manager` na
 * organização compartilhada (e portanto NÃO enxerga esta tela lá, o que a spec
 * também confere) e `admin` nas duas daqui. E ele não tem fator de MFA, então o
 * login não depende do TOTP compartilhado que outros seeds rotacionam.
 *
 * Idempotente: reusa organização por slug, membership por par, e apaga/recria o
 * dado operacional a cada rodada — a spec anterior pode tê-lo apagado, que é
 * literalmente o que ela faz.
 *
 * Run: npx tsx scripts/seed-e2e-zona-de-perigo.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-zona-de-perigo", credenciais);

const admin: SupabaseClient = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Lado {
  readonly slug: string;
  readonly nome: string;
  readonly contato: string;
  readonly lead: string;
  readonly mensagem: string;
  readonly telefone: string;
  readonly sessao: string;
}

const A: Lado = {
  slug: "e2e-zona-perigo-a",
  nome: "E2E Zona De Perigo A",
  contato: "Contato Zona A Descartavel",
  lead: "Negocio Zona A Descartavel",
  mensagem: "mensagem da zona A que tem de sumir",
  telefone: "+5511970000001",
  sessao: "e2e-zona-a",
};
const B: Lado = {
  slug: "e2e-zona-perigo-b",
  nome: "E2E Zona De Perigo B",
  contato: "Contato Zona B Intocavel",
  lead: "Negocio Zona B Intocavel",
  mensagem: "mensagem da zona B que NAO pode sumir",
  telefone: "+5511970000002",
  sessao: "e2e-zona-b",
};

async function garantirOrg(lado: Lado): Promise<string> {
  const { data: existente, error } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", lado.slug)
    .maybeSingle();
  if (error) throw new Error(`buscar org ${lado.slug}: ${error.message}`);
  if (existente) {
    // `onboarded_at` reafirmado: `app/app/layout.tsx` manda para o wizard toda
    // organização sem ele, e aí a tela de Configurações nem é alcançável.
    const { error: updErr } = await admin
      .from("organizations")
      .update({ display_name: lado.nome, onboarded_at: new Date().toISOString() } as never)
      .eq("id", (existente as { id: string }).id);
    if (updErr) throw new Error(`reafirmar org ${lado.slug}: ${updErr.message}`);
    return (existente as { id: string }).id;
  }
  const { data, error: insErr } = await admin
    .from("organizations")
    .insert({
      slug: lado.slug,
      display_name: lado.nome,
      legal_name: lado.nome,
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      onboarded_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (insErr || !data) throw new Error(`criar org ${lado.slug}: ${insErr?.message}`);
  return (data as { id: string }).id;
}

async function garantirMembroAdmin(userId: string, orgId: string): Promise<void> {
  const { data: existente, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`buscar membership: ${error.message}`);
  if (existente) {
    const { error: updErr } = await admin
      .from("user_organizations")
      .update({ role: "admin", revoked_at: null } as never)
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    if (updErr) throw new Error(`atualizar membership: ${updErr.message}`);
    return;
  }
  const { error: insErr } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  } as never);
  if (insErr) throw new Error(`inserir membership: ${insErr.message}`);
}

async function garantirCanal(orgId: string, lado: Lado): Promise<string> {
  const { data: existente } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", lado.sessao)
    .maybeSingle();
  if (existente) return (existente as { id: string }).id;
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      waha_session_name: lado.sessao,
      display_name: `Canal ${lado.nome}`,
      phone_number: lado.telefone,
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`criar canal ${lado.sessao}: ${error?.message}`);
  return (data as { id: string }).id;
}

/**
 * Recria o dado operacional do zero. A ordem do apagamento é a MESMA da action
 * (filhos antes dos pais), porque as FKs para `contacts` são RESTRICT.
 */
async function semearDadoOperacional(orgId: string, lado: Lado, canalId: string) {
  for (const tabela of [
    "messages",
    "conversations",
    "calendar_appointments",
    "orders",
    "crm_leads",
    "contacts",
  ]) {
    const { error } = await admin.from(tabela).delete().eq("organization_id", orgId);
    if (error) throw new Error(`limpar ${tabela} de ${lado.slug}: ${error.message}`);
  }

  const { data: contato, error: cErr } = await admin
    .from("contacts")
    .insert({
      organization_id: orgId,
      name: lado.contato,
      display_name: lado.contato,
      phone_number: lado.telefone,
    } as never)
    .select("id")
    .single();
  if (cErr || !contato) throw new Error(`criar contato de ${lado.slug}: ${cErr?.message}`);
  const contactId = (contato as { id: string }).id;

  const { data: conversa, error: convErr } = await admin
    .from("conversations")
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      channel_session_id: canalId,
      status: "open",
    } as never)
    .select("id")
    .single();
  if (convErr || !conversa) throw new Error(`criar conversa de ${lado.slug}: ${convErr?.message}`);
  const conversationId = (conversa as { id: string }).id;

  const { error: mErr } = await admin.from("messages").insert([
    {
      organization_id: orgId,
      conversation_id: conversationId,
      channel_session_id: canalId,
      contact_id: contactId,
      type: "text",
      direction: "inbound",
      status: "received",
      body: lado.mensagem,
      external_id: `${lado.slug}-msg-1`,
    },
    {
      organization_id: orgId,
      conversation_id: conversationId,
      channel_session_id: canalId,
      contact_id: contactId,
      type: "text",
      direction: "outbound",
      status: "sent",
      body: `resposta — ${lado.mensagem}`,
      external_id: `${lado.slug}-msg-2`,
    },
  ] as never);
  if (mErr) throw new Error(`criar mensagens de ${lado.slug}: ${mErr.message}`);

  const { data: funil, error: fErr } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (fErr) throw new Error(`buscar funil de ${lado.slug}: ${fErr.message}`);
  if (!funil) throw new Error(`org ${lado.slug} sem funil padrão provisionado`);
  const pipelineId = (funil as { id: string }).id;

  const { data: etapa, error: eErr } = await admin
    .from("crm_stages")
    .select("id, name")
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (eErr || !etapa) throw new Error(`buscar etapa de ${lado.slug}: ${eErr?.message}`);

  const { error: lErr } = await admin.from("crm_leads").insert({
    organization_id: orgId,
    pipeline_id: pipelineId,
    stage_id: (etapa as { id: string }).id,
    title: lado.lead,
    contact_id: contactId,
  } as never);
  if (lErr) throw new Error(`criar lead de ${lado.slug}: ${lErr.message}`);

  const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const { error: aErr } = await admin.from("calendar_appointments").insert({
    organization_id: orgId,
    contact_id: contactId,
    title: `Consulta — ${lado.contato}`,
    starts_at: amanha.toISOString(),
    ends_at: new Date(amanha.getTime() + 30 * 60 * 1000).toISOString(),
  } as never);
  if (aErr) throw new Error(`criar agendamento de ${lado.slug}: ${aErr.message}`);

  const { error: oErr } = await admin.from("orders").insert({
    organization_id: orgId,
    contact_id: contactId,
    external_id: `${lado.slug}-pedido-1`,
    external_provider: "nuvemshop",
    status: "paid",
    total_cents: 12345,
    ordered_at: new Date().toISOString(),
  } as never);
  if (oErr) throw new Error(`criar pedido de ${lado.slug}: ${oErr.message}`);

  return { contactId, conversationId, pipelineId, etapa: (etapa as { name: string }).name };
}

async function main() {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts` antes");
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as {
    users: Record<string, { id: string; email: string } | undefined>;
    zona_de_perigo?: unknown;
  };
  const usuario = creds.users.manager;
  if (!usuario) throw new Error("`.e2e-creds.json` sem o usuário `manager`");

  const orgA = await garantirOrg(A);
  const orgB = await garantirOrg(B);
  await garantirMembroAdmin(usuario.id, orgA);
  await garantirMembroAdmin(usuario.id, orgB);

  const canalA = await garantirCanal(orgA, A);
  const canalB = await garantirCanal(orgB, B);
  const dadoA = await semearDadoOperacional(orgA, A, canalA);
  await semearDadoOperacional(orgB, B, canalB);

  creds.zona_de_perigo = {
    org_a_id: orgA,
    org_a_nome: A.nome,
    org_a_contato: A.contato,
    org_a_lead: A.lead,
    org_a_funil_id: dadoA.pipelineId,
    org_a_etapa: dadoA.etapa,
    org_b_id: orgB,
    org_b_nome: B.nome,
    org_b_contato: B.contato,
    org_b_lead: B.lead,
    usuario_email: usuario.email,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2));
  console.info(`[seed-zona] A=${orgA} B=${orgB} — dono ${usuario.email} é admin nas duas`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
