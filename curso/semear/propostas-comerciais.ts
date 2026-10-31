/**
 * Semente do módulo "Propostas" do CRM (Ver tudo em CRM › Propostas, /app/proposals).
 *
 * A tela só existe com Propostas ligado nos DOIS níveis — o módulo da instalação
 * e a chave da empresa — e as propostas daqui usam o modelo da clínica
 * "Pacote de nutrição — 3 meses". Quem liga os dois níveis e cria esse modelo é
 * a semente de "Modelos de proposta"; chamamos a dela em vez de repetir o
 * mesmo dado aqui (ela é idempotente e só mexe nas próprias linhas).
 *
 * Cinco situações na lista, nos dois negócios da base (achados pelo título: a
 * base os recria com id novo a cada rodada):
 *   - Mariana: um rascunho que a IA (Bia) preparou e espera revisão, com um item
 *     sem preço e um campo do documento por preencher; e uma consulta aceita.
 *   - Fernanda: uma proposta enviada esperando resposta e uma recusada. O
 *     negócio dela fica SEM rascunho, porque é nele que a lição cria a proposta
 *     nova (a regra é um rascunho aberto por negócio).
 *
 * Nada é enviado: as enviadas nascem aqui já como `enviada`, sem mensagem.
 * Idempotente: apaga as próprias propostas (ids fixos), as que as lições criam
 * pela tela (pelo título) e as novas versões das próprias (substitui_id), com o
 * registro que elas deixam na linha do tempo do negócio, e recria. A mesma
 * limpeza é exportada como `limpar`, que a base chama antes de qualquer aula.
 */
import { type Contexto, conversaId, contatoId, exigir, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { semear as semearModelosDeProposta } from "./modelos-de-proposta";

const propostaId = (n: number) => `d1090000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const itemId = (n: number) => `d1090100-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** O modelo da clínica criado pela semente de "Modelos de proposta". */
const MODELO_DA_CLINICA = "empresa_pacote_de_nutricao_3_meses";

const LEAD_MARIANA = "Primeira consulta nutricional — Mariana";
const LEAD_FERNANDA = "Retorno pós-cirúrgico — Fernanda Oliveira";

/** Títulos que as lições gravam pela tela: somem antes de cada lição. */
const CRIADAS_NAS_LICOES = ["Pacote de fisioterapia pós-cirúrgica — 10 sessões"];

const DIA = 24 * 60;

/** Data (AAAA-MM-DD) de hoje + `dias` no fuso de São Paulo (UTC-3, sem horário de verão). */
function diaSP(dias: number) {
  const sp = new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000);
  return sp.toISOString().slice(0, 10);
}
const ANO = Number(diaSP(0).slice(0, 4));

type Item = { descricao: string; quantidade: number; preco: number | null };
type Proposta = {
  n: number;
  lead: "mariana" | "fernanda";
  titulo: string;
  status: "rascunho" | "enviada" | "aceita" | "recusada";
  criadaHa: number;
  validade: number;
  itens: Item[];
  briefing: Record<string, unknown>;
  condicoes: string | null;
  ia?: boolean;
  numero?: number;
  enviadaHa?: number;
  decididaHa?: number;
  motivo?: string;
};

/** As propostas desta semente — ids fixos, os mesmos `n` da lista PROPOSTAS. */
const IDS_DAS_PROPOSTAS = [1, 2, 3, 4].map(propostaId);

/**
 * Apaga o que este módulo põe no banco: as próprias propostas, as que as lições
 * criam pela tela (pelo título) e as novas versões das próprias (substitui_id),
 * com o registro que elas deixam na linha do tempo. Só linhas deste módulo.
 */
async function apagarAsDoModulo({ db, org }: Contexto) {
  const daLicao = exigir(
    await db
      .from("crm_proposals")
      .select("id")
      .eq("organization_id", org)
      .in(
        "titulo",
        CRIADAS_NAS_LICOES.map((t) => demo(t)),
      ),
    "propostas das lições",
  ) as Array<{ id: string }>;
  const versoes = exigir(
    await db
      .from("crm_proposals")
      .select("id")
      .eq("organization_id", org)
      .in("substitui_id", IDS_DAS_PROPOSTAS),
    "novas versões",
  ) as Array<{ id: string }>;
  const derivadas = [...daLicao.map((p) => p.id), ...versoes.map((p) => p.id)];
  semErro(
    await db
      .from("crm_lead_activities")
      .delete()
      .eq("organization_id", org)
      .eq("source_module", "proposals")
      .in("source_id", [...IDS_DAS_PROPOSTAS, ...derivadas]),
    "limpar linha do tempo das propostas",
  );
  // as versões apontam para as próprias (substitui_id): saem primeiro
  semErro(
    await db.from("crm_proposals").delete().eq("organization_id", org).in("id", derivadas),
    "limpar propostas das lições",
  );
  semErro(
    await db.from("crm_proposals").delete().eq("organization_id", org).in("id", IDS_DAS_PROPOSTAS),
    "limpar propostas",
  );
}

/**
 * Chamada pela base antes de QUALQUER aula (`limparSementesDeModulo`). Sem ela as
 * propostas daqui sobreviviam à base — `lead_id` e `contact_id` são ON DELETE SET
 * NULL — e ficavam órfãs no banco de todas as outras aulas.
 */
export async function limpar(c: Contexto) {
  await apagarAsDoModulo(c);
}

export async function semear(c: Contexto) {
  const { db, org, pessoa, agenteId } = c;

  // Liga Propostas (instalação + empresa) e cria o modelo "Pacote de nutrição — 3 meses".
  await semearModelosDeProposta(c);
  const modelo = exigir(
    await db
      .from("proposal_templates")
      .select("slug, version")
      .eq("organization_id", org)
      .eq("slug", MODELO_DA_CLINICA)
      .single(),
    "modelo da clínica",
  ) as { slug: string; version: number };

  const leads = exigir(
    await db
      .from("crm_leads")
      .select("id, title, contact_id")
      .eq("organization_id", org)
      .in("title", [demo(LEAD_MARIANA), demo(LEAD_FERNANDA)]),
    "negócios da base",
  ) as Array<{ id: string; title: string; contact_id: string }>;
  const lead = (titulo: string) => {
    const l = leads.find((x) => x.title === demo(titulo));
    if (!l) throw new Error(`negócio da base sumiu: ${titulo}`);
    return l;
  };
  const NEGOCIO = {
    mariana: {
      lead: lead(LEAD_MARIANA),
      contato: contatoId(1),
      conversa: conversaId(1),
      nome: "Mariana Souza",
    },
    fernanda: {
      lead: lead(LEAD_FERNANDA),
      contato: contatoId(5),
      conversa: conversaId(5),
      nome: "Fernanda Oliveira",
    },
  };

  const PROPOSTAS: Proposta[] = [
    {
      // O rascunho da IA: falta o preço de um item e o campo "O que está incluído".
      n: 1,
      lead: "mariana",
      titulo: "Acompanhamento nutricional — 3 meses",
      status: "rascunho",
      ia: true,
      criadaHa: 25,
      validade: 15,
      condicoes: null,
      briefing: {
        project: {
          name: demo("acompanhamento nutricional de 3 meses"),
          objective: demo("perder 6 kg com reeducação alimentar, sem dietas restritivas"),
        },
      },
      itens: [
        { descricao: "Consulta nutricional mensal", quantidade: 3, preco: 18000 },
        { descricao: "Plano alimentar personalizado", quantidade: 1, preco: null },
      ],
    },
    {
      n: 2,
      lead: "mariana",
      titulo: "Consulta nutricional com bioimpedância",
      status: "aceita",
      numero: 2,
      criadaHa: 9 * DIA,
      enviadaHa: 9 * DIA - 30,
      decididaHa: 8 * DIA,
      validade: 6,
      condicoes: "Pagamento no dia da consulta, no cartão ou no Pix.",
      briefing: {
        project: {
          name: demo("plano de consulta inicial com bioimpedância"),
          objective: demo(
            "entender a rotina alimentar e medir a composição corporal antes de montar o plano",
          ),
        },
        included: {
          list: demo("Consulta de 60 minutos, exame de bioimpedância e plano alimentar inicial."),
        },
      },
      itens: [
        { descricao: "Consulta nutricional inicial", quantidade: 1, preco: 28000 },
        { descricao: "Exame de bioimpedância", quantidade: 1, preco: 12000 },
      ],
    },
    {
      // A enviada que espera resposta — é nela que a lição marca o aceite.
      n: 3,
      lead: "fernanda",
      titulo: "Plano alimentar para a recuperação pós-cirúrgica",
      status: "enviada",
      numero: 3,
      criadaHa: 2 * DIA + 120,
      enviadaHa: 2 * DIA,
      validade: 12,
      condicoes: "Pagamento em até 3x sem juros no cartão ou 5% de desconto no Pix.",
      briefing: {
        project: {
          name: demo("plano alimentar para a recuperação pós-cirúrgica"),
          objective: demo(
            "acelerar a cicatrização e recuperar a energia nas semanas depois da cirurgia",
          ),
        },
        included: {
          list: demo(
            "Consulta nutricional, plano alimentar de recuperação e um retorno em 30 dias.",
          ),
        },
      },
      itens: [
        { descricao: "Consulta nutricional pós-cirúrgica", quantidade: 1, preco: 28000 },
        { descricao: "Retorno em 30 dias", quantidade: 1, preco: 18000 },
      ],
    },
    {
      n: 4,
      lead: "fernanda",
      titulo: "Reeducação alimentar — 1 mês",
      status: "recusada",
      numero: 1,
      criadaHa: 13 * DIA,
      enviadaHa: 13 * DIA - 60,
      decididaHa: 11 * DIA,
      validade: 15,
      motivo: "Preferiu esperar a liberação do Dr. Paulo.",
      condicoes: "Pagamento em até 3x sem juros no cartão ou 5% de desconto no Pix.",
      briefing: {
        project: {
          name: demo("plano de reeducação alimentar de 1 mês"),
          objective: demo("organizar as refeições da semana e reduzir o açúcar"),
        },
        included: {
          list: demo("Duas consultas nutricionais e plano alimentar com lista de compras."),
        },
      },
      itens: [{ descricao: "Consulta nutricional", quantidade: 2, preco: 18000 }],
    },
  ];

  // --- limpeza: as próprias, as que as lições criam e as novas versões das próprias ---
  if (PROPOSTAS.some((p) => !IDS_DAS_PROPOSTAS.includes(propostaId(p.n))))
    throw new Error("proposta da semente fora de IDS_DAS_PROPOSTAS: a limpeza não a alcançaria");
  await apagarAsDoModulo(c);

  // --- recria ---
  let item = 0;
  for (const p of PROPOSTAS) {
    const neg = NEGOCIO[p.lead];
    const total = p.itens.reduce((s, it) => s + (it.preco ?? 0) * it.quantidade, 0);
    const semPreco = p.itens.some((it) => it.preco === null);
    const enviada = p.enviadaHa !== undefined;
    semErro(
      await db.from("crm_proposals").insert({
        id: propostaId(p.n),
        organization_id: org,
        lead_id: neg.lead.id,
        contact_id: neg.contato,
        conversation_id: neg.conversa,
        status: p.status,
        titulo: demo(p.titulo),
        condicoes: p.condicoes ? demo(p.condicoes) : null,
        total_cents: total,
        moeda: "BRL",
        valid_until: diaSP(p.validade - Math.floor(p.criadaHa / DIA)),
        numero: p.numero ?? null,
        ano: p.numero ? ANO : null,
        versao: 1,
        drafted_by_agent_id: p.ia ? agenteId : null,
        sent_at: enviada ? ha(p.enviadaHa!) : null,
        sent_by_user_id: enviada ? pessoa.helena : null,
        destinatario_nome: enviada ? neg.nome : null,
        decided_at: p.decididaHa !== undefined ? ha(p.decididaHa) : null,
        decided_by_user_id: p.decididaHa !== undefined ? pessoa.helena : null,
        decision_reason: p.motivo ? demo(p.motivo) : null,
        pricing_status: semPreco ? "missing" : "manual",
        // O rascunho da IA chega com o modelo SUGERIDO, ainda por confirmar; as
        // enviadas já saíram com o modelo confirmado.
        template_slug: p.ia ? null : modelo.slug,
        template_version: p.ia ? null : modelo.version,
        template_slug_sugerido: p.ia ? modelo.slug : null,
        briefing_json: p.briefing,
        created_at: ha(p.criadaHa),
        updated_at: ha(p.decididaHa ?? p.enviadaHa ?? p.criadaHa),
      }),
      `proposta ${p.n}`,
    );
    semErro(
      await db.from("crm_proposal_items").insert(
        p.itens.map((it, i) => ({
          id: itemId(++item),
          proposal_id: propostaId(p.n),
          organization_id: org,
          product_id: null,
          descricao: demo(it.descricao),
          quantidade: it.quantidade,
          preco_unitario_cents: it.preco,
          desconto_cents: 0,
          position: (i + 1) * 1000,
        })),
      ),
      `itens da proposta ${p.n}`,
    );
  }

  // O contador da numeração só cresce (D9): sem acompanhar os números semeados,
  // um envio de verdade nesta empresa receberia de novo o 0001 do ano.
  const maior = Math.max(...PROPOSTAS.map((p) => p.numero ?? 0));
  const contador = exigir(
    await db
      .from("crm_proposal_counters")
      .select("ultimo_numero")
      .eq("organization_id", org)
      .eq("ano", ANO),
    "contador de propostas",
  ) as Array<{ ultimo_numero: number }>;
  if ((contador[0]?.ultimo_numero ?? 0) < maior) {
    semErro(
      await db
        .from("crm_proposal_counters")
        .upsert(
          { organization_id: org, ano: ANO, ultimo_numero: maior },
          { onConflict: "organization_id,ano" },
        ),
      "contador de propostas",
    );
  }

  // A linha do tempo do negócio, como as rotas gravam (lib/leads/activity-emitter):
  // sem ela, a ficha do negócio mostraria a proposta e diria que nada aconteceu.
  const linhas = PROPOSTAS.flatMap((p) => {
    const neg = NEGOCIO[p.lead];
    const base = {
      organization_id: org,
      lead_id: neg.lead.id,
      contact_id: neg.contato,
      source_module: "proposals",
      source_id: propostaId(p.n),
      evidence: null,
      payload: {},
    };
    const quem = (min: number) => ({
      actor_kind: "user",
      actor_agent_id: null,
      performed_by_user_id: pessoa.helena,
      performed_at: ha(min),
      created_at: ha(min),
    });
    // O rascunho da IA fica sem linha: ator `ai` exige lastro de uma execução
    // real (crm_lead_activities_ai_needs_evidence), e aqui não houve execução.
    const out: Record<string, unknown>[] = p.ia
      ? []
      : [
          {
            ...base,
            ...quem(p.criadaHa),
            type: "proposal_drafted",
            reason: `Rascunho de proposta criado: ${demo(p.titulo)}`,
          },
        ];
    if (p.enviadaHa !== undefined) {
      out.push({
        ...base,
        ...quem(p.enviadaHa),
        type: "proposal_sent",
        reason: `Proposta ${p.numero}/${ANO} enviada ao cliente`,
      });
    }
    if (p.decididaHa !== undefined) {
      out.push({
        ...base,
        ...quem(p.decididaHa),
        type: p.status === "aceita" ? "proposal_accepted" : "proposal_declined",
        reason:
          p.status === "aceita"
            ? "Proposta aceita pelo cliente"
            : `Proposta recusada: ${demo(p.motivo ?? "")}`,
      });
    }
    return out;
  });
  semErro(await db.from("crm_lead_activities").insert(linhas), "linha do tempo das propostas");
}
