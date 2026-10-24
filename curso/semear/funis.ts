/**
 * Semente do módulo Funis: os negócios da Clínica Bem Viver no funil
 * "Pacientes" (o funil padrão que a base renomeia), espalhados pelas etapas e
 * pelos estados que as lições fotografam — com e sem responsável (pessoa e a
 * Bia), com conversa e sem, ganho, perdido, um atrasado e etiquetas para filtrar.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos) e recria. A base já apaga
 * todos os negócios e contatos da organização antes de cada lição; o que esta
 * semente apaga a mais é o funil que a lição "organizar-funis" cria pela tela,
 * caso uma captura tenha parado antes do passo que o exclui.
 *
 * Não grava em tabela que a base não limpa (tarefas, funis, etapas): o que
 * ficasse lá apareceria nas fotos de outros módulos.
 */
import { type Contexto, contatoId, exigir, semErro } from "../semear-demonstracao";

const negocioId = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contatoNovoId = (n: number) => `f2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Funis que as lições criam pela tela (e excluem no fim). */
export const FUNIS_DAS_LICOES = ["Pilates em grupo", "Pilates"];

const HORA = 3_600_000;
const haHoras = (h: number) => new Date(Date.now() - h * HORA).toISOString();
/** Dia de hoje + `dias` no fuso de São Paulo, como "AAAA-MM-DD" (coluna date). */
function dia(dias: number) {
  const sp = new Date(Date.now() - 3 * HORA + dias * 24 * HORA);
  return sp.toISOString().slice(0, 10);
}

const CONTATOS_NOVOS = [
  { n: 1, name: "Sérgio Tavares", phone_number: "+5511987650031", email: "sergio.tavares@email.com" },
  { n: 2, name: "Patrícia Lemos", phone_number: "+5511987650032" },
  { n: 3, name: "Ricardo Nunes", phone_number: "+5511987650033" },
];

type Dono = "helena" | "ana" | "carlos" | "bia" | null;
type Negocio = {
  n: number;
  titulo: string;
  etapa: string;
  contato: string;
  reais: number;
  dono: Dono;
  horasNaEtapa: number;
  tags?: string[];
  descricao?: string;
  fechamento?: string;
  motivoDaPerda?: string;
};

export async function semear(c: Contexto) {
  const { db, org, pessoa, agenteId, funil } = c;

  // ---------- limpa o que é desta semente ----------
  const ids = Array.from({ length: 12 }, (_, i) => negocioId(i + 1));
  semErro(await db.from("crm_leads").delete().eq("organization_id", org).in("id", ids), "limpar negócios");
  semErro(
    await db.from("contacts").delete().eq("organization_id", org).in("id", CONTATOS_NOVOS.map((x) => contatoNovoId(x.n))),
    "limpar contatos",
  );
  const sobras = exigir(
    await db.from("crm_pipelines").select("id").eq("organization_id", org).in("name", FUNIS_DAS_LICOES),
    "funis das lições",
  ) as Array<{ id: string }>;
  for (const f of sobras) {
    semErro(await db.from("crm_leads").delete().eq("organization_id", org).eq("pipeline_id", f.id), "negócios do funil da lição");
    semErro(await db.from("crm_stages").delete().eq("organization_id", org).eq("pipeline_id", f.id), "etapas do funil da lição");
    semErro(await db.from("crm_pipelines").delete().eq("organization_id", org).eq("id", f.id), "funil da lição");
  }

  // ---------- o que a base deixa com cara de loja ----------
  // A base renomeia o funil e as 4 primeiras etapas; o endereço ("/pedidos") e
  // as etapas 5-7 ("Enviado", "Entregue", "Pós-venda") continuam de loja e
  // aparecem nas fotos. Só troca rótulos (por posição, idempotente).
  // ponytail: altera linhas da base; o lugar certo é semear-demonstracao.ts.
  semErro(await db.from("crm_pipelines").update({ slug: "pacientes" }).eq("organization_id", org).eq("id", funil.id), "endereço do funil");
  const todas = exigir(
    await db.from("crm_stages").select("id, is_lost").eq("pipeline_id", funil.id).order("position"),
    "etapas por posição",
  ) as Array<{ id: string; is_lost: boolean }>;
  for (const [i, nome] of ["Reavaliação", "Alta", "Pós-tratamento"].entries()) {
    const e = todas[4 + i];
    if (e && !e.is_lost) semErro(await db.from("crm_stages").update({ name: nome }).eq("id", e.id), `etapa ${nome}`);
  }

  // ---------- etapas do funil Pacientes, pelo nome ----------
  const etapas = exigir(
    await db.from("crm_stages").select("id, name").eq("pipeline_id", funil.id).eq("is_archived", false),
    "etapas",
  ) as Array<{ id: string; name: string }>;
  const etapa = (nome: string) => {
    const e = etapas.find((x) => x.name === nome);
    if (!e) throw new Error(`etapa "${nome}" não existe no funil Pacientes`);
    return e.id;
  };
  const perdida = exigir(
    await db.from("crm_stages").select("id").eq("pipeline_id", funil.id).eq("is_lost", true).eq("is_archived", false).order("position").limit(1).single(),
    "etapa de perda",
  ) as { id: string };

  // ---------- contatos sem conversa (pacientes que chegaram por telefone) ----------
  semErro(
    await db.from("contacts").insert(CONTATOS_NOVOS.map(({ n, ...x }) => ({ id: contatoNovoId(n), organization_id: org, ...x }))),
    "contatos novos",
  );

  const NEGOCIOS: Negocio[] = [
    {
      n: 1, titulo: "Avaliação de fisioterapia — Roberto Almeida", etapa: "Primeiro contato", contato: contatoId(2),
      reais: 180, dono: "ana", horasNaEtapa: 3, tags: ["fisioterapia"],
      descricao: "Dor no joelho direito depois da corrida. Prefere horário cedo.",
    },
    {
      n: 2, titulo: "Pacote de pilates — Camila Rocha", etapa: "Primeiro contato", contato: contatoId(7),
      reais: 960, dono: "bia", horasNaEtapa: 5, tags: ["pilates"],
    },
    {
      n: 3, titulo: "Consulta nutricional — Pedro Henrique Lima", etapa: "Primeiro contato", contato: contatoId(4),
      reais: 280, dono: null, horasNaEtapa: 2,
    },
    {
      n: 4, titulo: "Avaliação odontológica — Sérgio Tavares", etapa: "Consulta agendada", contato: contatoNovoId(1),
      reais: 150, dono: "helena", horasNaEtapa: 4 * 24, tags: ["odontologia"], fechamento: dia(-3),
      descricao: "Ficou de confirmar a data da avaliação e não voltou mais.",
    },
    {
      n: 5, titulo: "Clareamento dental — Juliana Castro", etapa: "Consulta agendada", contato: contatoId(3),
      reais: 1200, dono: "carlos", horasNaEtapa: 8, tags: ["odontologia"], fechamento: dia(10),
    },
    {
      n: 6, titulo: "Pacote de 10 sessões de fisioterapia — Lucas Martins", etapa: "Em tratamento", contato: contatoId(6),
      reais: 1500, dono: "ana", horasNaEtapa: 3 * 24, tags: ["fisioterapia"],
    },
    {
      n: 7, titulo: "Acompanhamento nutricional — Tereza Gomes", etapa: "Em tratamento", contato: contatoId(12),
      reais: 840, dono: "helena", horasNaEtapa: 6 * 24,
    },
    {
      n: 8, titulo: "Retorno de nutrição — Patrícia Lemos", etapa: "Retorno", contato: contatoNovoId(2),
      reais: 200, dono: "ana", horasNaEtapa: 2 * 24,
    },
    {
      n: 9, titulo: "Implante dentário — Ricardo Nunes", etapa: "", contato: contatoNovoId(3),
      reais: 4500, dono: "carlos", horasNaEtapa: 5 * 24, tags: ["odontologia"], motivoDaPerda: "price",
    },
  ];

  for (const [i, x] of NEGOCIOS.entries()) {
    const perdido = Boolean(x.motivoDaPerda);
    const stageId = perdido ? perdida.id : etapa(x.etapa);
    const ganho = x.etapa === "Em tratamento"; // a etapa que era "Pago": é a de ganho
    const donoHumano = x.dono && x.dono !== "bia" ? pessoa[x.dono] : null;
    const entrou = haHoras(x.horasNaEtapa);
    semErro(await db.from("crm_leads").insert({
      id: negocioId(x.n), organization_id: org, pipeline_id: funil.id, stage_id: stageId,
      title: x.titulo, description: x.descricao ?? null, contact_id: x.contato,
      value_cents: x.reais * 100, currency: "BRL",
      status: perdido ? "lost" : ganho ? "won" : "open",
      closed_at: perdido || ganho ? entrou : null,
      lost_reason: x.motivoDaPerda ?? null,
      owner_user_id: donoHumano,
      owner_agent_id: x.dono === "bia" ? agenteId : null,
      owner_kind: x.dono === "bia" ? "ai" : donoHumano ? "user" : null,
      assigned_at: x.dono ? entrou : null,
      tags: x.tags ?? [],
      expected_close_date: x.fechamento ?? null,
      // depois dos dois negócios da base (posição 1000), na ordem da lista
      position_in_stage: 2000 + i * 1000,
      // a última atividade é a entrada na etapa: é por ela que o Radar decide quem esfriou
      stage_changed_at: entrou, last_activity_at: entrou, created_at: haHoras(x.horasNaEtapa + 24),
    }), `negócio ${x.titulo}`);
  }
}
