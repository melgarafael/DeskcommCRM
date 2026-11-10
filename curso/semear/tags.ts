/**
 * Semente do módulo "Tags" (Configurações): um vocabulário de etiquetas com a
 * bagunça que a tela existe para arrumar — duas grafias da mesma ideia ("Fisio"
 * e "fisioterapia"), uma etiqueta que uma regra automática ainda escreve
 * ("aguardando-exame"), uma campanha que acabou ("promo-julho") e um contato de
 * fornecedor para a lista de contato interno. Algumas etiquetas já têm cor
 * (gravadas em `settings.tags`, como a tela grava); outras ficam "em uso, fora
 * do vocabulário".
 *
 * As etiquetas da base (convenio, particular, primeira-consulta, retorno,
 * pos-operatorio, agendamento) não são tocadas: só ganham cor no vocabulário.
 *
 * Idempotente: apaga só os próprios contatos, negócios e a regra (ids fixos) e
 * recria. `settings` a base já devolve ao estado de fábrica antes de cada lição.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";

const contato = (n: number) => `7a900000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const negocio = (n: number) => `7a910000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REGRA = "7a920000-0000-4000-8000-000000000001";

const CONTATOS: Array<{ n: number; nome: string; tags: string[] }> = [
  { n: 1, nome: "Gustavo Pereira", tags: ["fisioterapia"] },
  { n: 2, nome: "Larissa Moura", tags: ["fisioterapia", "convenio"] },
  { n: 3, nome: "Henrique Batista", tags: ["Fisio"] },
  { n: 4, nome: "Vanessa Lopes", tags: ["Fisio", "particular"] },
  { n: 5, nome: "Marcos Vieira", tags: ["aguardando-exame"] },
  { n: 6, nome: "Simone Freitas", tags: ["aguardando-exame", "nutricao"] },
  { n: 7, nome: "Paulo Rezende", tags: ["promo-julho"] },
  { n: 8, nome: "Aline Costa", tags: ["promo-julho", "nutricao"] },
  { n: 9, nome: "Distribuidora Vida Natural", tags: ["fornecedor"] },
];

/** O vocabulário curado, com cor — o formato que `fn_vocabulario_de_tags_operar` grava. */
const VOCABULARIO = [
  { tag: "convenio", cor: "#0091ff" },
  { tag: "particular", cor: "#00655a" },
  { tag: "primeira-consulta", cor: "#ffb224" },
  { tag: "fisioterapia", cor: "#ab4aba" },
];

export async function semear(c: Contexto) {
  const { db, org, pessoa, funil } = c;

  semErro(await db.from("automation_rules").delete().eq("organization_id", org).eq("id", REGRA), "limpar regra");
  semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("id", [1, 2].map(negocio)), "limpar negócios");
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", CONTATOS.map((x) => contato(x.n))), "limpar contatos");

  semErro(
    await db.from("contacts").insert(
      CONTATOS.map((x, i) => ({
        id: contato(x.n), organization_id: org, name: x.nome, phone_number: `+55119876501${String(40 + i)}`, tags: x.tags,
        created_at: ha((20 - i) * 24 * 60),
      })),
    ),
    "contatos",
  );

  semErro(
    await db.from("crm_leads").insert([
      { id: negocio(1), contact_id: contato(1), title: "Sessões de fisioterapia — Gustavo Pereira", value_cents: 72000, tags: ["fisioterapia"] },
      { id: negocio(2), contact_id: contato(6), title: "Acompanhamento nutricional — Simone Freitas", value_cents: 84000, tags: ["nutricao"] },
    ].map((l) => ({ ...l, organization_id: org, pipeline_id: funil.id, stage_id: funil.etapas[0]!, currency: "BRL", status: "open" }))),
    "negócios",
  );

  // a regra fica DESLIGADA: só existe para a coluna "Regras de agente" contar 1
  const criada = ha(10 * 24 * 60);
  semErro(
    await db.from("automation_rules").insert({
      id: REGRA, organization_id: org, name: "Marcar quem precisa trazer exame", trigger_event: "lead.created",
      trigger_config: {}, conditions: [], is_active: false,
      actions: [{ type: "add_tag", config: { tags: ["aguardando-exame"] } }],
      created_at: criada, created_by_user_id: pessoa.helena, last_change_actor_kind: "user", last_change_at: criada,
    }),
    "regra que escreve a etiqueta",
  );

  const linha = exigir(await db.from("organizations").select("settings").eq("id", org).single(), "settings") as { settings: Record<string, unknown> | null };
  semErro(
    await db.from("organizations").update({ settings: { ...(linha.settings ?? {}), tags: VOCABULARIO } }).eq("id", org),
    "vocabulário com cor",
  );
}
