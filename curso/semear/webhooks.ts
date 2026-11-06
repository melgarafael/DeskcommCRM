/**
 * Semente do módulo "Webhooks": três fontes de formulário (duas ativas, uma
 * pausada), o histórico do que chegou por elas ("Leads recebidos"), três
 * automações — duas que avisam outro sistema — e o histórico delas (Atividade):
 * um aviso que chegou e um que o outro sistema recusou.
 *
 * Os endereços das automações usam o domínio reservado `.example`, que não
 * resolve: nem um worker ligado por engano conseguiria falar com alguém de fora.
 *
 * Idempotente: apaga só as linhas de ids fixos daqui, o que chegou pelas fontes
 * daqui (o "Enviar lead de teste" da lição grava captação e recebimento) e o que
 * as lições criam pela tela (fonte e automação de nome fixo). Contatos e
 * negócios a base já apaga antes de cada lição.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

const uuid = (prefixo: string) => (n: number) => `${prefixo}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fonteId = uuid("0e0b0000");
const capturaId = uuid("0e0c0000");
const regraId = uuid("0e0d0000");
const execucaoId = uuid("0e0e0000");
const recebimentoId = uuid("0e0f0000");
const negocioId = uuid("0e0a0000");
const contatoId = uuid("0e090000");

/** O que as lições criam pela tela — a semente apaga para a lição seguinte partir limpa. */
export const FONTE_DA_LICAO = "Formulário de avaliação postural";
export const AUTOMACAO_DA_LICAO = "Avisar o laboratório de horário marcado";

const DIA = 24 * 60;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

export async function semear(c: Contexto) {
  const { db, org, pessoa, sessao, funil } = c;
  const [primeiroContato, consultaAgendada] = funil.etapas;
  if (!primeiroContato || !consultaAgendada) throw new Error("o funil Pacientes precisa de pelo menos 2 etapas");

  // ---------- limpa ----------
  const fontesFixas = [1, 2, 3].map(fonteId);
  const daLicao = exigir(
    await db.from("webhook_sources").select("id").eq("organization_id", org).eq("name", FONTE_DA_LICAO),
    "fontes da lição",
  ) as Array<{ id: string }>;
  const todasAsFontes = [...fontesFixas, ...daLicao.map((f) => f.id)];
  const tokens = exigir(
    await db.from("webhook_sources").select("path_token").eq("organization_id", org).in("id", todasAsFontes),
    "tokens",
  ) as Array<{ path_token: string }>;
  if (tokens.length) {
    semErro(await db.from("webhook_events_log").delete().eq("organization_id", org).in("webhook_path_token", tokens.map((t) => t.path_token)), "limpar recebimentos");
  }
  semErro(await db.from("webhook_lead_captures").delete().eq("organization_id", org).in("webhook_source_id", todasAsFontes), "limpar captações das fontes");
  semErro(await db.from("webhook_lead_captures").delete().eq("organization_id", org).in("id", [1, 2, 3, 4, 5].map(capturaId)), "limpar captações");
  semErro(await db.from("webhook_sources").delete().eq("organization_id", org).in("id", todasAsFontes), "limpar fontes");
  // as execuções caem junto com a regra (on delete cascade)
  semErro(await db.from("automation_rules").delete().eq("organization_id", org).in("id", [1, 2, 3].map(regraId)), "limpar automações");
  semErro(await db.from("automation_rules").delete().eq("organization_id", org).eq("name", AUTOMACAO_DA_LICAO), "limpar automação da lição");
  // "Enviar lead de teste" (ligar-ao-site p5) cria um contato e um lead de verdade a cada
  // captura; sem isto eles se acumulam e aparecem nas fotos de Contatos e do funil.
  const testes = exigir(
    await db.from("contacts").select("id").eq("organization_id", org).eq("name", "Lead de Teste"),
    "contatos de teste",
  ) as Array<{ id: string }>;
  if (testes.length) {
    const ids = testes.map((t) => t.id);
    semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("contact_id", ids), "limpar leads de teste");
    semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", ids), "limpar contatos de teste");
  }

  // ---------- fontes de formulário ----------
  const TOKEN = ["bV7kQ2nR9xLp4tWz8cYh3mJd6sFa1gEuKo2R", "pL3sT8vB1nQ6wE9rY4uI7oZ2xC5mK0aHf6Dt", "dH5jN2kV8bM1qW4eR7tY0uP3sX6zC9lAg3Yh"];
  const autoria = (minutos: number) => ({ last_change_actor_kind: "user", last_change_at: ha(minutos) });
  semErro(await db.from("webhook_sources").insert([
    {
      id: fonteId(1), name: "Formulário do site — Avaliação nutricional", path_token: TOKEN[0], is_active: true,
      default_stage_id: primeiroContato, last_received_at: ha(25), created_at: ha(3 * DIA), ...autoria(3 * DIA),
      form_fields: [{ key: "objetivo", label: "Qual é o seu objetivo?", type: "select", required: true, options: ["Emagrecer", "Ganhar massa muscular", "Reeducação alimentar"] }],
    },
    {
      id: fonteId(2), name: "Landing page — Pilates para iniciantes", path_token: TOKEN[1], is_active: false,
      default_stage_id: primeiroContato, last_received_at: ha(9 * DIA), created_at: ha(40 * DIA), ...autoria(8 * DIA), form_fields: [],
    },
    {
      id: fonteId(3), name: "Campanha de clareamento dental", path_token: TOKEN[2], is_active: true,
      default_stage_id: primeiroContato, last_received_at: ha(3 * 60), created_at: ha(10 * DIA), ...autoria(10 * DIA), form_fields: [],
    },
  ].map((f) => ({ ...f, organization_id: org, default_pipeline_id: funil.id, created_by_user_id: pessoa.helena, field_map: {} }))), "fontes");

  // ---------- quem chegou pelos formulários (e virou paciente no funil) ----------
  const PESSOAS = [
    { n: 1, nome: "Larissa Mendes", telefone: "+5511987650041", email: "larissa.mendes@email.com", minutos: 25, fonte: 1, titulo: "Avaliação nutricional — Larissa Mendes" },
    { n: 3, nome: "Rodrigo Pacheco", telefone: "+5511987650043", email: null, minutos: 3 * 60, fonte: 3, titulo: "Clareamento dental — Rodrigo Pacheco" },
    { n: 5, nome: "Vanessa Couto", telefone: "+5511987650045", email: "vanessa.couto@email.com", minutos: 9 * DIA, fonte: 2, titulo: "Pilates para iniciantes — Vanessa Couto" },
  ];
  semErro(await db.from("contacts").insert(PESSOAS.map((p) => ({
    id: contatoId(p.n), organization_id: org, name: p.nome, phone_number: p.telefone, email: p.email, tags: [],
  }))), "contatos dos formulários");
  semErro(await db.from("crm_leads").insert(PESSOAS.map((p) => ({
    id: negocioId(p.n), organization_id: org, pipeline_id: funil.id, stage_id: primeiroContato, title: p.titulo,
    contact_id: contatoId(p.n), status: "open", source: "webhook", webhook_source_id: fonteId(p.fonte), created_at: ha(p.minutos),
  }))), "negócios dos formulários");

  const nomeDa = (f: number) => ["", "Formulário do site — Avaliação nutricional", "Landing page — Pilates para iniciantes", "Campanha de clareamento dental"][f]!;
  const CAPTACOES = [
    {
      n: 1, fonte: 1, minutos: 25, outcome: "criado", lead: 1, nome: "Larissa Mendes", telefone: "+5511987650041", email: "larissa.mendes@email.com",
      fields: { objetivo: "Reeducação alimentar" }, utm: { utm_source: "instagram", utm_campaign: "avaliacao-outubro" },
      origin: "https://www.clinicabemviver.com.br/avaliacao-nutricional", ip: "187.45.120.33", ua: IPHONE,
    },
    {
      n: 2, fonte: 1, minutos: 24, outcome: "duplicado", lead: 1, nome: "Larissa Mendes", telefone: "+5511987650041", email: "larissa.mendes@email.com",
      fields: { objetivo: "Reeducação alimentar" }, utm: { utm_source: "instagram", utm_campaign: "avaliacao-outubro" },
      origin: "https://www.clinicabemviver.com.br/avaliacao-nutricional", ip: "187.45.120.33", ua: IPHONE,
    },
    {
      n: 3, fonte: 3, minutos: 3 * 60, outcome: "criado", lead: 3, nome: "Rodrigo Pacheco", telefone: "+5511987650043", email: null,
      fields: {}, utm: { utm_source: "google", utm_campaign: "clareamento" },
      origin: "https://www.clinicabemviver.com.br/clareamento", ip: "200.150.33.12", ua: WINDOWS,
    },
    {
      n: 4, fonte: 1, minutos: 5 * 60, outcome: "recusado", lead: null, nome: null, telefone: null, email: null, motivo: "sem_campo_mapeavel",
      fields: { "your-subject": "Consulta", "your-message": "Quero marcar uma avaliação" }, utm: {},
      origin: "https://www.clinicabemviver.com.br/contato", ip: "177.92.10.4", ua: WINDOWS,
    },
    {
      n: 5, fonte: 2, minutos: 9 * DIA, outcome: "criado", lead: 5, nome: "Vanessa Couto", telefone: "+5511987650045", email: "vanessa.couto@email.com",
      fields: {}, utm: { utm_source: "facebook", utm_campaign: "pilates-iniciantes" },
      origin: "https://pilates.clinicabemviver.com.br/", ip: "189.6.44.71", ua: IPHONE,
    },
  ] as const;
  semErro(await db.from("webhook_lead_captures").insert(CAPTACOES.map((x) => ({
    id: capturaId(x.n), organization_id: org, webhook_source_id: fonteId(x.fonte), source_name: nomeDa(x.fonte),
    lead_id: x.lead ? negocioId(x.lead) : null, contact_id: x.lead ? contatoId(x.lead) : null,
    outcome: x.outcome, reject_reason: "motivo" in x ? x.motivo : null,
    captured_name: x.nome, captured_phone: x.telefone, captured_email: x.email,
    fields: x.fields, utm: x.utm, remote_ip: x.ip, user_agent: x.ua, origin: x.origin, received_at: ha(x.minutos),
  }))), "captações");

  // "Últimos recebimentos" do painel da fonte: um por envio que chegou por ela
  semErro(await db.from("webhook_events_log").insert(CAPTACOES.map((x) => {
    const corpo = { nome: x.nome ?? undefined, telefone: x.telefone ?? undefined, email: x.email ?? undefined, ...x.fields, ...x.utm };
    return {
      id: recebimentoId(x.n), organization_id: org, provider: "generic", webhook_path_token: TOKEN[x.fonte - 1],
      raw_body: JSON.stringify(corpo), payload_parsed: corpo, valid_signature: null, status: "processed",
      processed_at: ha(x.minutos), received_at: ha(x.minutos),
    };
  })), "recebimentos");

  // ---------- automações ----------
  semErro(await db.from("automation_rules").insert([
    {
      id: regraId(1), name: "Boas-vindas a quem preencher o formulário", trigger_event: "lead.created", is_active: false,
      actions: [{ type: "send_whatsapp_message", config: { channel_session_id: sessao, template: "Oi, {{primeiro_nome}}! Recebemos seu cadastro na Clínica Bem Viver. Já já a recepção fala com você." } }],
      created_at: ha(30 * DIA),
    },
    {
      id: regraId(2), name: "Avisar a agenda do consultório de cancelamento", trigger_event: "appointment.cancelled", is_active: true,
      actions: [{ type: "call_webhook", config: { url: "https://agenda.bemviver.example/cancelamentos" } }],
      created_at: ha(20 * DIA), run_count: 4, last_run_at: ha(90),
    },
    {
      id: regraId(3), name: "Avisar o financeiro quando o paciente fechar", trigger_event: "lead.won", is_active: true,
      actions: [{ type: "call_webhook", config: { url: "https://financeiro.bemviver.example/novo-paciente" } }],
      created_at: ha(12 * DIA), run_count: 7, last_run_at: ha(35),
    },
  ].map((r) => ({ conditions: [], trigger_config: {}, run_count: 0, ...r, organization_id: org, created_by_user_id: pessoa.helena, last_change_actor_kind: "user", last_change_at: r.created_at }))), "automações");

  semErro(await db.from("automation_rule_runs").insert([
    {
      id: execucaoId(1), rule_id: regraId(3), status: "success", created_at: ha(35),
      actions_result: [{ type: "call_webhook", status: "success", detail: { response_status: 200, attempt: 1, delivery_id: execucaoId(101) } }],
    },
    {
      id: execucaoId(2), rule_id: regraId(2), status: "failed", created_at: ha(90), error: "http_404",
      actions_result: [{ type: "call_webhook", status: "failed", error: "http_404", detail: { response_status: 404, attempts: 3, attempt: 3, delivery_id: execucaoId(102) } }],
    },
  ].map((r) => ({ ...r, organization_id: org, event_id: null }))), "execuções");
}
