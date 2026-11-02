/**
 * Semente do módulo "Conversões" (Configurações): a clínica já ligou a conta de
 * anúncios da Meta e tem um mês de vendas vindas de anúncio — duas entregues,
 * uma etapa do funil entregue, e três que NÃO foram (uma sem valor, uma recusada
 * pela Meta, uma esperando nova tentativa). Mais três links rastreáveis com
 * cliques, e a regra da etapa "Consulta agendada" gravada mas desligada (é o que
 * dá nome ao envio da etapa no Histórico e deixa o "Usar o recomendado" visível).
 *
 * O token gravado é um marcador: a tela só sabe SE existe token, nunca o valor,
 * e o worker fica parado na captura — nada sai para a Meta.
 *
 * Idempotente: apaga só as próprias linhas (ids e nomes fixos) e as tabelas que
 * só esta tela escreve (conexão da Meta, regras da Meta, endereço de captura).
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const contato = (n: number) => `c7a50000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const negocio = (n: number) => `c7a51000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const envio = (n: number) => `c7a52000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const link = (n: number) => `c7a53000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REGRA = "c7a54000-0000-4000-8000-000000000001";
const DIA = 24 * 60;

const CONTATOS = [
  { n: 1, nome: "Patrícia Lemos" },
  { n: 2, nome: "Rodrigo Sales" },
  { n: 3, nome: "Bruna Tavares" },
  { n: 4, nome: "Eduardo Nakamura" },
  { n: 5, nome: "Sofia Andrade" },
  { n: 6, nome: "Marcelo Duarte" },
];

/** Os nomes que esta semente (e a lição que cria link) usa — para limpar só os seus. */
const NOMES_DE_LINK = ["Instagram — link da bio", "Site — botão Agende sua avaliação", "Campanha Pilates — outubro"];

export async function semear(c: Contexto) {
  const { db, org, pessoa, funil } = c;

  // ---------- limpa o que é desta tela ----------
  semErro(await db.from("meta_ads_click_refs").delete().eq("organization_id", org).in("tracking_link_id", [1, 2, 3].map(link)), "limpar cliques");
  semErro(await db.from("ad_tracking_links").delete().eq("organization_id", org).in("name", NOMES_DE_LINK), "limpar links");
  semErro(await db.from("ad_conversion_dispatches").delete().eq("organization_id", org).in("id", [1, 2, 3, 4, 5, 6].map(envio)), "limpar envios");
  semErro(await db.from("meta_ads_conversion_rules").delete().eq("organization_id", org), "limpar regras da Meta");
  semErro(await db.from("ad_platform_connections").delete().eq("organization_id", org).eq("platform", "meta_ads"), "limpar conexão Meta");
  semErro(await db.from("meta_ads_landing_pages").delete().eq("organization_id", org), "limpar endereço de captura");
  semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("id", [1, 2, 3, 4, 5, 6].map(negocio)), "limpar negócios");
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", CONTATOS.map((x) => contato(x.n))), "limpar contatos");

  // ---------- conexão com a Meta (já gravada, envio ligado) ----------
  semErro(await db.from("ad_platform_connections").insert({
    organization_id: org, platform: "meta_ads", dataset_id: "784512903615270", access_token_encrypted: "\\x0102",
    test_event_code: null, enabled: true, updated_by: pessoa.helena,
  }), "conexão Meta");

  // ---------- etapas ----------
  const etapas = exigir(
    await db.from("crm_stages").select("id, name, is_won").eq("pipeline_id", funil.id).order("position"),
    "etapas",
  ) as Array<{ id: string; name: string; is_won: boolean }>;
  const ganho = etapas.find((e) => e.is_won)?.id;
  const agendada = etapas.find((e) => e.name === demo("Consulta agendada"))?.id;
  if (!ganho || !agendada) throw new Error("funil Pacientes sem etapa de ganho ou sem \"Consulta agendada\"");

  // ---------- contatos e negócios ----------
  semErro(await db.from("contacts").insert(CONTATOS.map((x, i) => ({
    id: contato(x.n), organization_id: org, name: x.nome, phone_number: `+55119876502${String(10 + i)}`, created_at: ha((25 - i) * DIA),
  }))), "contatos");

  const NEGOCIOS = [
    { n: 1, titulo: "Fisioterapia, 10 sessões — Patrícia Lemos", centavos: 120000, ganho: true, dias: 9 },
    { n: 2, titulo: "Nutrição trimestral — Rodrigo Sales", centavos: 84000, ganho: true, dias: 6 },
    { n: 3, titulo: "Avaliação nutricional — Bruna Tavares", centavos: null, ganho: true, dias: 3 },
    { n: 4, titulo: "Tratamento ortodôntico — Eduardo Nakamura", centavos: 450000, ganho: true, dias: 2 },
    { n: 5, titulo: "Limpeza e clareamento — Sofia Andrade", centavos: 98000, ganho: true, dias: 0 },
    { n: 6, titulo: "Primeira consulta de fisioterapia — Marcelo Duarte", centavos: 25000, ganho: false, dias: 1 },
  ];
  semErro(await db.from("crm_leads").insert(NEGOCIOS.map((x, i) => ({
    id: negocio(x.n), organization_id: org, pipeline_id: funil.id, stage_id: x.ganho ? ganho : agendada,
    contact_id: contato(x.n), title: x.titulo, value_cents: x.centavos, currency: "BRL",
    status: x.ganho ? "won" : "open", closed_at: x.ganho ? ha(x.dias * DIA + 60) : null,
    owner_user_id: pessoa.helena, owner_kind: "user", position_in_stage: 9000 + i * 1000,
    stage_changed_at: ha(x.dias * DIA + 60), created_at: ha((x.dias + 5) * DIA),
  }))), "negócios");

  // ---------- regra da etapa (gravada e desligada) ----------
  semErro(await db.from("meta_ads_conversion_rules").insert({
    id: REGRA, organization_id: org, stage_id: agendada, event_name: `MetaEtapa:${agendada}`,
    meta_event: "LeadSubmitted", enabled: false, updated_by: pessoa.helena,
  }), "regra da etapa");

  // ---------- o livro-razão: o que foi e o que não foi para a Meta ----------
  const base = { organization_id: org, platform: "meta_ads", currency: "BRL" };
  semErro(await db.from("ad_conversion_dispatches").insert([
    { id: envio(1), lead_id: negocio(1), event_name: "Purchase", status: "sent", reason: null, detail: null, value_cents: 120000,
      event_id: `${negocio(1)}:Purchase`, remote_request_id: "AqX7pQ2mZ9rT1vBkL0sYw3e", event_occurred_at: ha(9 * DIA + 60), attempted_at: ha(9 * DIA + 58) },
    { id: envio(2), lead_id: negocio(2), event_name: "Purchase", status: "sent", reason: null, detail: null, value_cents: 84000,
      event_id: `${negocio(2)}:Purchase`, remote_request_id: "B4nW8cHf1JqP6uZt2RmXo9a", event_occurred_at: ha(6 * DIA + 60), attempted_at: ha(6 * DIA + 58) },
    { id: envio(3), lead_id: negocio(6), event_name: `MetaEtapa:${agendada}`, meta_event_name: "LeadSubmitted", status: "sent", reason: null, detail: null,
      value_cents: null, event_id: `${negocio(6)}:MetaEtapa:${agendada}`, remote_request_id: "Cz3KdT7vQe0LpW5sYh8NbUi",
      event_occurred_at: ha(DIA + 60), attempted_at: ha(DIA + 58) },
    { id: envio(4), lead_id: negocio(3), event_name: "Purchase", status: "skipped", reason: "sem_valor", detail: null, value_cents: null,
      event_id: `${negocio(3)}:Purchase`, event_occurred_at: ha(3 * DIA + 60), attempted_at: ha(3 * DIA + 58) },
    { id: envio(5), lead_id: negocio(4), event_name: "Purchase", status: "error", reason: "recusado_pela_plataforma",
      detail: "(#100) Invalid parameter: page_id or whatsapp_business_account_id is required for business_messaging events",
      value_cents: 450000, event_id: `${negocio(4)}:Purchase`, event_occurred_at: ha(2 * DIA + 60), attempted_at: ha(2 * DIA + 58) },
    { id: envio(6), lead_id: negocio(5), event_name: "Purchase", status: "skipped", reason: "nova_tentativa_agendada", detail: null,
      value_cents: 98000, event_id: `${negocio(5)}:Purchase`, event_occurred_at: ha(70), attempted_at: ha(68) },
  ].map((l) => ({ ...base, ...l }))), "envios");

  // ---------- links rastreáveis, com cliques ----------
  const LINKS = [
    { n: 1, nome: NOMES_DE_LINK[0]!, uso: "organico", utm: { utm_source: "instagram", utm_medium: "bio", utm_campaign: "perfil" }, ativo: true, dias: 40 },
    { n: 2, nome: NOMES_DE_LINK[1]!, uso: "site", utm: { utm_source: "site", utm_medium: "botao", utm_campaign: "avaliacao-gratuita" }, ativo: true, dias: 30 },
    { n: 3, nome: NOMES_DE_LINK[2]!, uso: "anuncio", utm: { utm_source: "meta", utm_medium: "cpc", utm_campaign: "pilates-outubro" }, ativo: false, dias: 20 },
  ];
  semErro(await db.from("ad_tracking_links").insert(LINKS.map((l) => ({
    id: link(l.n), organization_id: org, name: l.nome, whatsapp_e164: "+551140028922",
    message_template: "Olá! Quero agendar uma avaliação.", use_case: l.uso, utm: l.utm, enabled: l.ativo,
    created_at: ha(l.dias * DIA),
  }))), "links");

  // cliques: 14 no da bio (3 pessoas), 9 no do site (2 pessoas), nenhum na campanha desligada
  const cliques: Array<{ link: number; contato: number | null }> = [
    ...[1, 1, 1, 2, 2, 5, 5, 5, 5, null, null, null, null, null].map((ct) => ({ link: 1, contato: ct })),
    ...[3, 3, 4, 4, 4, null, null, null, null].map((ct) => ({ link: 2, contato: ct })),
  ];
  const UTM = Object.fromEntries(LINKS.map((l) => [l.n, l.utm]));
  semErro(await db.from("meta_ads_click_refs").insert(cliques.map((k, i) => ({
    organization_id: org, token: `CURSOCV${String(i).padStart(3, "0")}`, utm: UTM[k.link], query_raw: UTM[k.link],
    tracking_link_id: link(k.link), contact_id: k.contato === null ? null : contato(k.contato),
    matched_at: k.contato === null ? null : ha((20 - i) * 60), created_at: ha((20 - i) * 60 + 5),
  }))), "cliques");
}
