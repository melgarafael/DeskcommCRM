/**
 * Semente do módulo Contatos: cinco cadastros que a base (as 12 conversas da
 * Inbox) não tem e que as lições fotografam — um contato vindo do site sem
 * conversa ainda (o ícone "Iniciar conversa"), dois vindos de planilha (filtro
 * de origem), um só com e-mail, um pessoal (filtro "Pessoais") e a mesma
 * Juliana da base cadastrada de novo com o número antigo, sem o nono dígito (a
 * tela de duplicados).
 *
 * Mais três linhas na Timeline da Fernanda (a ficha que a lição abre), presas
 * ao negócio que a base cria para ela.
 *
 * Só INSERT, com ids fixos `be2c…`/`be2d…`; apaga e recria só as próprias
 * linhas. A base já limpa contatos e negócios da organização a cada lição.
 */
import { type Contexto, contatoId, exigir, ha, ontemAs, semErro } from "../semear-demonstracao";

const id = (n: number) => `be2c0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DIA = 24 * 60;

const CONTATOS = [
  {
    n: 1, name: "Gabriela Duarte", phone_number: "+5511987650021", email: "gabriela.duarte@email.com",
    tags: ["primeira-consulta"], source: "site", criado: 25, atividade: 25 as number | null,
  },
  {
    n: 2, name: "Ricardo Teixeira", phone_number: "+5511987650022", email: "ricardo.teixeira@email.com",
    tags: ["odontologia", "particular"], source: "import_csv", birthdate: "1978-11-02", criado: 40 * DIA, atividade: 9 * DIA,
  },
  {
    n: 3, name: "Sandra Lopes", phone_number: null, email: "sandra.lopes@email.com",
    tags: ["nutricao"], source: "manual", criado: 60 * DIA, atividade: 15 * DIA,
  },
  {
    n: 4, name: "Marcos Prado", phone_number: "+5511987650023", email: null,
    tags: [], source: "manual", is_personal: true, criado: 90 * DIA, atividade: 2 * DIA,
  },
  // a Juliana Castro da base (contatoId(3), +5511987650003) com o número antigo
  {
    n: 5, name: "Juliana Castro Silva", phone_number: "+551187650003", email: "juliana.castro@email.com",
    tags: ["convenio"], source: "import_csv", criado: 120 * DIA, atividade: null,
  },
];

const atividadeId = (n: number) => `be2d0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export async function semear({ db, org, pessoa }: Contexto) {
  const ids = CONTATOS.map((c) => id(c.n));
  semErro(await db.from("contacts").delete().eq("organization_id", org).in("id", ids), "limpar contatos do módulo");
  semErro(
    await db.from("contacts").insert(
      CONTATOS.map(({ n, criado, atividade, ...c }) => ({
        // mesmas chaves em toda linha: no insert em lote, chave ausente vira NULL, não o default
        birthdate: null,
        is_personal: false,
        ...c,
        id: id(n),
        organization_id: org,
        created_at: ha(criado),
        last_activity_at: atividade === null ? null : ha(atividade),
      })),
    ),
    "contatos do módulo",
  );

  // ---------- Timeline da Fernanda ----------
  const negocio = exigir(
    await db.from("crm_leads").select("id").eq("organization_id", org).eq("contact_id", contatoId(5)).limit(1).single(),
    "negócio da Fernanda",
  ) as { id: string };
  const vazio = { performed_by_user_id: null as string | null, reason: null as string | null, payload: {} };
  const ATIVIDADES = [
    // "system", não "ai": atividade de IA exige o lastro da execução (crm_lead_activities_ai_needs_evidence)
    { ...vazio, n: 1, type: "lead_created", source_module: "whatsapp", actor_kind: "system", reason: "Chegou pela primeira mensagem no WhatsApp.", performed_at: ontemAs(16, 4) },
    { ...vazio, n: 2, type: "stage_changed", source_module: "crm", actor_kind: "user", performed_by_user_id: pessoa.helena, reason: "Retorno confirmado para quinta às 9h30 com o Dr. Paulo.", performed_at: ha(124) },
    { ...vazio, n: 3, type: "note", source_module: "crm", actor_kind: "user", performed_by_user_id: pessoa.carlos, payload: { body: "Confirmar com o Dr. Paulo se precisa trocar o curativo no retorno." }, performed_at: ha(110) },
  ];
  semErro(await db.from("crm_lead_activities").delete().eq("organization_id", org).in("id", ATIVIDADES.map((a) => atividadeId(a.n))), "limpar atividades do módulo");
  semErro(
    await db.from("crm_lead_activities").insert(
      ATIVIDADES.map(({ n, ...a }) => ({ ...a, id: atividadeId(n), organization_id: org, lead_id: negocio.id, contact_id: contatoId(5) })),
    ),
    "atividades da Fernanda",
  );
}
