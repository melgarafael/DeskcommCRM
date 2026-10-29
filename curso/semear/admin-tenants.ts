/**
 * Semente do módulo Tenants (Admin): cinco empresas de exemplo, uma em cada
 * situação que a lista e a ficha mostram.
 *
 *  - Odonto Sorriso Leve: ativa, com número conectado e agente publicado.
 *  - FisioVida Reabilitação: ativa, com o número desligado (saúde "Crítico"),
 *    gasto de IA em 92% do teto e um agente só em rascunho.
 *  - NutriBem Consultório: sem a configuração inicial feita (selo "Onboarding").
 *  - Studio Movimento Pilates: suspensa pelo admin (suspensão administrativa).
 *  - Espaço Equilíbrio Psicologia: anonimizada (selo "Redigido").
 *
 * Nenhuma tem Helena, Ana ou Carlos como membro: a Helena enxerga todas por ser
 * admin da plataforma. A base apaga organizações extras antes de cada lição;
 * mesmo assim esta semente apaga as suas pelos ids fixos antes de recriar.
 *
 * ⚠️ `created_at` de toda empresa daqui fica DEPOIS do da Clínica Bem Viver: a
 * base trata a org mais antiga como a da instalação e apaga as outras. Uma
 * empresa de exemplo "criada há 60 dias" fez a base mirar na Clínica Bem Viver.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

export const ORG = {
  odonto: "a7000000-0000-4000-8000-000000000001",
  fisio: "a7000000-0000-4000-8000-000000000002",
  nutri: "a7000000-0000-4000-8000-000000000003",
  pilates: "a7000000-0000-4000-8000-000000000004",
  psico: "a7000000-0000-4000-8000-000000000005",
};

const PACIENTES: Array<[org: string, nome: string, pergunta: string]> = [
  [ORG.odonto, "Renata Albuquerque", "Oi, queria agendar uma limpeza para sábado."],
  [ORG.odonto, "Marcos Vinícius Tavares", "Vocês fazem clareamento? Qual o valor?"],
  [ORG.odonto, "Patrícia Lemos", "Preciso remarcar a manutenção do aparelho."],
  [ORG.odonto, "Gustavo Henrique Prado", "Estou com dor no dente do siso, tem encaixe hoje?"],
  [ORG.odonto, "Luana Cristina Reis", "Aceitam o convênio OdontoPrev?"],
  [ORG.odonto, "Eduardo Sampaio", "Obrigado, até a próxima consulta!"],
  [ORG.fisio, "Silvia Moura", "Bom dia, a sessão de RPG de amanhã está confirmada?"],
  [ORG.fisio, "Rogério Bastos", "Preciso do relatório para o convênio."],
  [ORG.fisio, "Débora Antunes", "Qual o valor do pacote de 10 sessões?"],
  [ORG.pilates, "Cláudia Ferraz", "Quero cancelar meu plano trimestral."],
  [ORG.pilates, "Helena Duarte Lins", "Tem vaga na turma de quinta às 7h?"],
];

export async function semear(c: Contexto) {
  const principal = exigir(await c.db.from("organizations").select("created_at").eq("id", c.org).single(), "criação da org principal") as { created_at: string };
  // um minuto por empresa depois da principal, nunca no futuro; a mais nova sai primeiro na lista
  const depois = (min: number) => new Date(Math.min(new Date(principal.created_at).getTime() + min * 60_000, Date.now() - (10 - min) * 1000)).toISOString();
  semErro(await c.db.from("organizations").delete().in("id", Object.values(ORG)), "apagar empresas de exemplo");
  semErro(
    await c.db.from("organizations").insert([
      {
        id: ORG.odonto, slug: "odonto-sorriso-leve", display_name: "Odonto Sorriso Leve",
        legal_name: "Odonto Sorriso Leve Clínica Odontológica Ltda", cnpj: "23.456.789/0001-10",
        status: "active", onboarded_at: depois(3.5), created_at: depois(3), settings: { plan: "pro" },
      },
      {
        id: ORG.fisio, slug: "fisiovida-reabilitacao", display_name: "FisioVida Reabilitação",
        legal_name: "FisioVida Fisioterapia e Reabilitação Ltda", cnpj: "34.567.890/0001-21",
        status: "active", onboarded_at: depois(4.5), created_at: depois(4), settings: { plan: "standard" },
      },
      {
        id: ORG.nutri, slug: "nutribem-consultorio", display_name: "NutriBem Consultório",
        legal_name: "NutriBem Consultório de Nutrição Ltda", cnpj: null,
        status: "active", onboarded_at: null, created_at: depois(5), settings: { plan: "standard" },
      },
      {
        id: ORG.pilates, slug: "studio-movimento-pilates", display_name: "Studio Movimento Pilates",
        legal_name: "Studio Movimento Pilates e Fisioterapia Ltda", cnpj: "45.678.901/0001-32",
        status: "suspended", suspended_kind: "administrativa", suspended_at: ha(20),
        suspended_reason: "Contrato encerrado a pedido da clínica; aguardando a exportação dos dados.",
        suspended_by: c.pessoa.helena,
        onboarded_at: depois(2.5), created_at: depois(2), settings: { plan: "standard" },
      },
      {
        id: ORG.psico, slug: "espaco-equilibrio-psicologia", display_name: "Espaço Equilíbrio Psicologia",
        legal_name: "Espaço Equilíbrio Psicologia Clínica Ltda", cnpj: "56.789.012/0001-43",
        status: "redacted", redacted_at: ha(10),
        onboarded_at: depois(1.5), created_at: depois(1), settings: { plan: "standard" },
      },
    ]),
    "empresas de exemplo",
  );

  // ---------- números de WhatsApp: um no ar, um desligado ----------
  const numeros = exigir(
    await c.db.from("channel_sessions").insert([
      { organization_id: ORG.odonto, provider: "waha", waha_session_name: "sorrisoleve-recepcao", webhook_secret_encrypted: "\\x00", status: "WORKING", phone_number: "+551130451200", display_name: "Recepção Sorriso Leve" },
      { organization_id: ORG.fisio, provider: "waha", waha_session_name: "fisiovida-central", webhook_secret_encrypted: "\\x00", status: "STOPPED", phone_number: "+551130453400", display_name: "Central FisioVida" },
      { organization_id: ORG.pilates, provider: "waha", waha_session_name: "movimento-pilates", webhook_secret_encrypted: "\\x00", status: "STOPPED", phone_number: "+551130455600", display_name: "Studio Movimento" },
    ]).select("id, organization_id"),
    "números das empresas de exemplo",
  ) as Array<{ id: string; organization_id: string }>;
  const numeroDe = (org: string) => numeros.find((n) => n.organization_id === org)!.id;

  // ---------- pacientes e conversas (as colunas "Conversas" e "Volumes") ----------
  const contatos = PACIENTES.map(([org, nome], i) => ({
    id: `a7200000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    organization_id: org, name: nome, phone_number: `+5511977700${String(i + 1).padStart(3, "0")}`,
  }));
  semErro(await c.db.from("contacts").insert(contatos), "pacientes de exemplo");
  semErro(
    await c.db.from("conversations").insert(PACIENTES.map(([org, , pergunta], i) => ({
      organization_id: org, contact_id: contatos[i]!.id, channel_session_id: numeroDe(org), status: "open",
      last_inbound_at: ha(30 + i * 45), last_message_at: ha(30 + i * 45), last_message_preview: pergunta,
    }))),
    "conversas de exemplo",
  );

  // ---------- agentes: um publicado (Odonto), um só em rascunho (FisioVida) ----------
  const agentes = exigir(
    await c.db.from("ai_agents").insert([
      { organization_id: ORG.odonto, name: "Lia — Atendimento Sorriso Leve", system_prompt: "Você é a Lia, recepcionista virtual da Odonto Sorriso Leve.", is_default: true, is_active: true },
      { organization_id: ORG.fisio, name: "Fisio — Recepção virtual", system_prompt: "Você é a recepcionista virtual da FisioVida.", is_default: true, is_active: false },
    ]).select("id, organization_id"),
    "agentes de exemplo",
  ) as Array<{ id: string; organization_id: string }>;
  const lia = agentes.find((a) => a.organization_id === ORG.odonto)!.id;
  const versao = exigir(
    await c.db.from("ai_agent_versions").insert({
      organization_id: ORG.odonto, agent_id: lia, version_number: 3, system_prompt: "Você é a Lia, recepcionista virtual da Odonto Sorriso Leve.",
      provider: "anthropic", model: "claude-sonnet-4-6", credential_id: null, channel_session_id: numeroDe(ORG.odonto),
      status: "published", published_at: depois(3.6),
    }).select("id").single(),
    "versão publicada da Lia",
  ) as { id: string };
  semErro(await c.db.from("ai_agents").update({ published_version_id: versao.id }).eq("id", lia), "publicar a Lia");

  // ---------- gasto de IA da FisioVida: 92% de um teto de US$ 100, só avisando ----------
  semErro(
    await c.db.from("ai_budgets").upsert(
      { organization_id: ORG.fisio, monthly_limit_cents: 10_000, current_month_consumed_cents: 0, enforcement_mode: "avisar" },
      { onConflict: "organization_id" },
    ),
    "teto de IA da FisioVida",
  );
  semErro(
    await c.db.from("llm_calls").insert({
      organization_id: ORG.fisio, purpose: "agent_turn", provider: "anthropic", model: "claude-sonnet-4-6",
      input_tokens: 1_850_000, output_tokens: 240_000, cost_cents: 9_200,
    }),
    "gasto de IA da FisioVida",
  );
}
