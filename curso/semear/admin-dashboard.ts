/**
 * Semente do módulo Dashboard (Admin): três empresas de exemplo na instalação,
 * cada uma acendendo um sinal diferente do painel.
 *
 *  - Rede Sorriso Pleno: 54 conversas na fila esperando uma pessoa (cartão
 *    "Pendentes >10min" e o alerta "Overflow", que exige mais de 50) e um
 *    pedido de LGPD já vencido (alerta "Crítico").
 *  - FisioMove Reabilitação: pedido de LGPD que vence em 3 dias e gasto de IA
 *    em 92% do teto, no modo "avisar".
 *  - NutriVida Consultório: gasto de IA em 87% do teto, no modo "bloquear".
 *
 * Nenhuma tem Helena, Ana ou Carlos como membro: a Helena enxerga todas por ser
 * admin da plataforma. A base apaga organizações extras antes de cada lição;
 * mesmo assim esta semente apaga as suas pelos ids fixos antes de recriar.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

const ORG = {
  sorriso: "ad000000-0000-4000-8000-000000000001",
  fisio: "ad000000-0000-4000-8000-000000000002",
  nutri: "ad000000-0000-4000-8000-000000000003",
};
const DIA = 86_400_000;
/** `due_at` guarda a meia-noite UTC do dia civil do prazo (lib/lgpd/sla.ts). */
const diaDoPrazo = (deslocamento: number) => {
  const d = new Date(Date.now() + deslocamento * DIA);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};

const NOMES = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gisele", "Hugo", "Isabela"];
const SOBRENOMES = ["Moraes", "Teixeira", "Barros", "Cardoso", "Pacheco", "Vieira"];
const PERGUNTAS = [
  "Oi, queria marcar uma limpeza.",
  "Vocês fazem clareamento? Qual o valor?",
  "Preciso remarcar minha consulta de amanhã.",
  "Estou com dor de dente, tem encaixe hoje?",
  "Aceitam o convênio OdontoPrev?",
  "Qual o horário de atendimento no sábado?",
];

export async function semear(c: Contexto) {
  semErro(await c.db.from("organizations").delete().in("id", Object.values(ORG)), "apagar empresas de exemplo");
  semErro(
    await c.db.from("organizations").insert([
      { id: ORG.sorriso, slug: "rede-sorriso-pleno", legal_name: "Rede Sorriso Pleno Odontologia Ltda", display_name: "Rede Sorriso Pleno" },
      { id: ORG.fisio, slug: "fisiomove-reabilitacao", legal_name: "FisioMove Reabilitação Física Ltda", display_name: "FisioMove Reabilitação" },
      { id: ORG.nutri, slug: "nutrivida-consultorio", legal_name: "NutriVida Consultório de Nutrição Ltda", display_name: "NutriVida Consultório" },
    ].map((o) => ({ ...o, status: "active", onboarded_at: ha(60 * 24 * 40) }))),
    "empresas de exemplo",
  );

  // ---------- Rede Sorriso Pleno: a fila cheia ----------
  const sessao = exigir(
    await c.db.from("channel_sessions").insert({
      organization_id: ORG.sorriso, provider: "waha", waha_session_name: "sorrisopleno-central", webhook_secret_encrypted: "\\x00",
      status: "WORKING", phone_number: "+551130457700", display_name: "Central Sorriso Pleno",
    }).select("id").single(),
    "número da Sorriso Pleno",
  ) as { id: string };
  const fila = Array.from({ length: 54 }, (_, i) => ({
    i,
    contato: `ad200000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    nome: `${NOMES[i % NOMES.length]} ${SOBRENOMES[i % SOBRENOMES.length]}`,
    telefone: `+5511988800${String(i + 1).padStart(3, "0")}`,
    em: ha(14 + i * 2),
    pergunta: PERGUNTAS[i % PERGUNTAS.length]!,
  }));
  semErro(
    await c.db.from("contacts").insert(fila.map((f) => ({ id: f.contato, organization_id: ORG.sorriso, name: f.nome, phone_number: f.telefone }))),
    "contatos da Sorriso Pleno",
  );
  semErro(
    await c.db.from("conversations").insert(fila.map((f) => ({
      organization_id: ORG.sorriso, contact_id: f.contato, channel_session_id: sessao.id, status: "pending",
      last_inbound_at: f.em, last_message_at: f.em, last_message_preview: f.pergunta, unread_count_for_assignee: 1,
    }))),
    "fila da Sorriso Pleno",
  );

  // ---------- pedidos de LGPD: um vencido, um perto do prazo ----------
  semErro(
    await c.db.from("lgpd_requests").insert([
      { organization_id: ORG.sorriso, request_type: "data_request", source: "manual", status: "received", received_at: ha(60 * 24 * 10), due_at: diaDoPrazo(-3), created_at: ha(60 * 24 * 10) },
      { organization_id: ORG.fisio, request_type: "redact", source: "manual", status: "received", received_at: ha(60 * 24 * 12), due_at: diaDoPrazo(3), created_at: ha(60 * 24 * 12) },
    ]),
    "pedidos de LGPD",
  );

  // ---------- gasto de IA perto do teto ----------
  semErro(
    await c.db.from("ai_budgets").upsert([
      { organization_id: ORG.fisio, monthly_limit_cents: 10_000, current_month_consumed_cents: 9_200, enforcement_mode: "avisar" },
      { organization_id: ORG.nutri, monthly_limit_cents: 20_000, current_month_consumed_cents: 17_400, enforcement_mode: "bloquear" },
    ], { onConflict: "organization_id" }),
    "orçamentos de IA",
  );
}
