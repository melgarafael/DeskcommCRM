/**
 * Semente do módulo "Etapas do funil" (CRM › Ver tudo em CRM › Etapas do funil).
 *
 * As lições criam, renomeiam, reordenam e arquivam etapas, mudam o papel de uma
 * coluna e gravam motivos de perda. Nada disso pode tocar o funil "Pacientes"
 * da base — ele é de todos os módulos. Por isso esta semente cria um funil
 * PRÓPRIO, "Pilates", com etapas, negócios abertos e um histórico de negócios
 * encerrados (é dele que sai a "Chance de fechamento" sugerida pela tela).
 *
 * Idempotente: apaga só as próprias linhas (ids fixos com o prefixo d111…) e
 * recria. Apaga também um funil "Pilates" que não seja o daqui: é o nome que a
 * lição "organizar-funis" do módulo Funis cria pela tela (a semente de Funis o
 * apaga pelo nome, ver FUNIS_DAS_LICOES), e uma captura interrompida lá deixaria
 * o endereço "pilates" ocupado.
 *
 * ⚠️ O FUNIL FICA NO BANCO DEPOIS DA ÚLTIMA LIÇÃO: a base não apaga funis. A
 * semente de Funis o remove (mesmo nome), mas um módulo fotografado entre este e
 * o de Funis veria um segundo funil. Ver o registro no resultado do módulo.
 */
import { type Contexto, exigir, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const id = (bloco: string, n: number) => `d111${bloco}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const FUNIL_PILATES = id("0000", 1);
const etapaId = (n: number) => id("0100", n);
const negocioId = (n: number) => id("0200", n);
const contatoId = (n: number) => id("0300", n);

const HORA = 3_600_000;
const haHoras = (h: number) => new Date(Date.now() - h * HORA).toISOString();

/** As colunas do funil, na ordem do quadro. `passo` é o vínculo com o agente de IA. */
const ETAPAS = [
  { n: 1, nome: "Novo", slug: "novo", passo: "new" },
  { n: 2, nome: "Lista de espera", slug: "lista-de-espera" },
  { n: 3, nome: "Aula experimental marcada", slug: "aula-experimental-marcada", passo: "negotiating" },
  {
    n: 4,
    nome: "Aula experimental feita",
    slug: "aula-experimental-feita",
    janelaHoras: 48,
    avisar: true,
  },
  { n: 5, nome: "Matrícula feita", slug: "matricula-feita", passo: "won", ganho: true },
  { n: 6, nome: "Não seguiu", slug: "nao-seguiu", passo: "lost", perda: true },
] as const;

const CONTATOS = [
  { n: 1, name: "Marina Duarte", phone_number: "+5511987651101", email: "marina.duarte@exemplo.com.br" },
  { n: 2, name: "Gustavo Prado", phone_number: "+5511987651102" },
  { n: 3, name: "Larissa Moura", phone_number: "+5511987651103" },
  { n: 4, name: "Otávio Ribeiro", phone_number: "+5511987651104" },
  { n: 5, name: "Beatriz Nogueira", phone_number: "+5511987651105", email: "beatriz.nogueira@exemplo.com.br" },
  { n: 6, name: "Bruno Lacerda", phone_number: "+5511987651106" },
];

type Dono = "ana" | "helena" | null;
/** Os negócios em aberto: os que aparecem no quadro e nas contas "nesta etapa agora". */
const ABERTOS: Array<{ n: number; titulo: string; nome: string; etapa: number; reais: number; horas: number; dono: Dono }> = [
  { n: 1, titulo: "Pacote de 10 aulas", nome: "Marina Duarte", etapa: 1, reais: 640, horas: 5, dono: "ana" },
  { n: 2, titulo: "Aula experimental", nome: "Gustavo Prado", etapa: 1, reais: 0, horas: 30, dono: null },
  { n: 3, titulo: "Pilates para gestante", nome: "Larissa Moura", etapa: 2, reais: 320, horas: 3 * 24, dono: "ana" },
  { n: 4, titulo: "Pilates para dor nas costas", nome: "Otávio Ribeiro", etapa: 2, reais: 320, horas: 6 * 24, dono: null },
  { n: 5, titulo: "Plano trimestral", nome: "Beatriz Nogueira", etapa: 3, reais: 870, horas: 20, dono: "helena" },
  { n: 6, titulo: "Plano mensal", nome: "Bruno Lacerda", etapa: 4, reais: 320, horas: 10, dono: "ana" },
];

/**
 * O HISTÓRICO: negócios já encerrados e o caminho de cada um pelas etapas.
 * É dele que a tela tira "N encerrados passaram por esta etapa; M foram ganhos"
 * — 13 passaram por "Aula experimental marcada" (8 ganhos, 62%), o bastante
 * para a tela sugerir a chance; "Novo" e "Aula experimental feita" ficam abaixo
 * de 10 casos e mostram "Poucos casos para sugerir".
 */
const ENCERRADOS: Array<{ n: number; nome: string; caminho: number[]; motivo?: string; diasAtras: number }> = [
  { n: 21, nome: "Sílvia Rangel", caminho: [1, 3, 4, 5], diasAtras: 95 },
  { n: 22, nome: "Daniel Moreira", caminho: [1, 3, 4, 5], diasAtras: 88 },
  { n: 23, nome: "Paula Teixeira", caminho: [1, 3, 4, 5], diasAtras: 74 },
  { n: 24, nome: "Rafael Antunes", caminho: [1, 3, 4, 5], diasAtras: 61 },
  { n: 25, nome: "Jéssica Barros", caminho: [1, 3, 4, 5], diasAtras: 47 },
  { n: 26, nome: "Marcos Pires", caminho: [1, 3, 4, 5], diasAtras: 33 },
  { n: 27, nome: "Vanessa Lopes", caminho: [3, 4, 5], diasAtras: 26 },
  { n: 28, nome: "Igor Freitas", caminho: [3, 4, 5], diasAtras: 15 },
  { n: 29, nome: "Caio Mendes", caminho: [1, 3, 6], motivo: "price", diasAtras: 80 },
  { n: 30, nome: "Letícia Araújo", caminho: [1, 3, 6], motivo: "no_response", diasAtras: 52 },
  { n: 31, nome: "Simone Prates", caminho: [3, 6], motivo: "no_response", diasAtras: 40 },
  { n: 32, nome: "André Faria", caminho: [3, 6], motivo: "price", diasAtras: 21 },
  { n: 33, nome: "Natália Cunha", caminho: [3, 4, 6], motivo: "no_response", diasAtras: 12 },
];

/** A base chama antes de QUALQUER aula: o funil que sobra aparece no Kanban e nos seletores de funil dos outros módulos. */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  // o que é desta semente (e um "Pilates" que sobrou de Funis)
  const funis = exigir(
    await db.from("crm_pipelines").select("id").eq("organization_id", org).or(`id.eq.${FUNIL_PILATES},name.eq.Pilates,slug.eq.pilates`),
    "funis a limpar",
  ) as Array<{ id: string }>;
  for (const f of funis) {
    // negócios primeiro: crm_leads → crm_stages é ON DELETE RESTRICT (o histórico aponta para a etapa)
    semErro(await db.from("crm_leads").delete().eq("organization_id", org).eq("pipeline_id", f.id), "negócios do funil Pilates");
    semErro(await db.from("crm_stages").delete().eq("organization_id", org).eq("pipeline_id", f.id), "etapas do funil Pilates");
    semErro(await db.from("crm_pipelines").delete().eq("organization_id", org).eq("id", f.id), "funil Pilates");
  }
  semErro(
    await db.from("contacts").delete().eq("organization_id", org).in("id", CONTATOS.map((x) => contatoId(x.n))),
    "contatos do funil Pilates",
  );
}

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;
  await limpar(c);

  // ---------- o funil ----------
  semErro(
    await db.from("crm_pipelines").insert({
      id: FUNIL_PILATES,
      organization_id: org,
      name: demo("Pilates"),
      slug: "pilates",
      is_default: false,
      is_archived: false,
      is_client_pipeline: false,
      // depois do "Pacientes" (1000) em todas as listas de funis
      position: 2000,
      vocabulary: { lead: demo("Aluno"), deal: demo("Plano"), won: demo("Matriculado"), lost: demo("Desistiu") },
      settings: { fields: [], lost_reasons: [] },
    }),
    "funil Pilates",
  );

  // ---------- as etapas ----------
  for (const e of ETAPAS) {
    semErro(
      await db.from("crm_stages").insert({
        id: etapaId(e.n),
        organization_id: org,
        pipeline_id: FUNIL_PILATES,
        name: demo(e.nome),
        slug: e.slug,
        position: e.n * 1000,
        is_won: "ganho" in e,
        is_lost: "perda" in e,
        is_archived: false,
        agent_stage_hint: "passo" in e ? e.passo : null,
        expected_duration_hours: "janelaHoras" in e ? e.janelaHoras : null,
        avisar_na_central: "avisar" in e,
        win_probability: e.n === 1 ? 10 : null,
      }),
      `etapa ${e.nome}`,
    );
  }

  // ---------- contatos e negócios em aberto ----------
  semErro(
    await db.from("contacts").insert(CONTATOS.map(({ n, ...x }) => ({ id: contatoId(n), organization_id: org, ...x }))),
    "contatos do funil Pilates",
  );
  for (const [i, x] of ABERTOS.entries()) {
    const entrou = haHoras(x.horas);
    const dono = x.dono ? pessoa[x.dono] : null;
    semErro(
      await db.from("crm_leads").insert({
        id: negocioId(x.n),
        organization_id: org,
        pipeline_id: FUNIL_PILATES,
        stage_id: etapaId(x.etapa),
        title: `${demo(x.titulo)} — ${x.nome}`,
        contact_id: contatoId(x.n),
        value_cents: x.reais ? x.reais * 100 : null,
        currency: "BRL",
        status: "open",
        owner_user_id: dono,
        owner_kind: dono ? "user" : null,
        assigned_at: dono ? entrou : null,
        tags: [],
        position_in_stage: 1000 + i * 1000,
        stage_changed_at: entrou,
        last_activity_at: entrou,
        created_at: haHoras(x.horas + 24),
      }),
      `negócio ${x.titulo}`,
    );
  }

  // ---------- o histórico: negócios encerrados e cada troca de etapa ----------
  for (const [i, x] of ENCERRADOS.entries()) {
    const ganho = !x.motivo;
    const ultima = x.caminho[x.caminho.length - 1]!;
    // cada troca de etapa a 2 dias da anterior; a última é o encerramento
    const quando = (passo: number) => haHoras((x.diasAtras + 2 * (x.caminho.length - 1 - passo)) * 24);
    const fechou = quando(x.caminho.length - 1);
    semErro(
      await db.from("crm_leads").insert({
        id: negocioId(x.n),
        organization_id: org,
        pipeline_id: FUNIL_PILATES,
        stage_id: etapaId(ultima),
        title: `${demo("Plano mensal")} — ${x.nome}`,
        contact_id: null,
        value_cents: 32000,
        currency: "BRL",
        status: ganho ? "won" : "lost",
        closed_at: fechou,
        lost_reason: x.motivo ?? null,
        owner_user_id: pessoa.ana,
        owner_kind: "user",
        assigned_at: quando(0),
        tags: [],
        position_in_stage: 1000 + i * 1000,
        stage_changed_at: fechou,
        last_activity_at: fechou,
        created_at: quando(0),
      }),
      `negócio encerrado ${x.nome}`,
    );
    const trocas = x.caminho.slice(1).map((para, k) => ({
      organization_id: org,
      lead_id: negocioId(x.n),
      source_module: "crm",
      type: "stage_changed",
      payload: { from_stage_id: etapaId(x.caminho[k]!), to_stage_id: etapaId(para), pipeline_id: FUNIL_PILATES },
      performed_at: quando(k + 1),
      performed_by_user_id: pessoa.ana,
      actor_kind: "user",
    }));
    semErro(await db.from("crm_lead_activities").insert(trocas), `histórico de ${x.nome}`);
  }
}
