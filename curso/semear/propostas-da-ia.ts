/**
 * Semente do módulo "Propostas" da IA (Agente de IA › Ver tudo em IA › Propostas,
 * `/app/ai/proposals`).
 *
 * A tela lista os PRÓXIMOS PASSOS que a IA anotou para os negócios abertos
 * (`lead_state.next_action`, um por contato, roteado para o negócio aberto do
 * contato por `roteiaProximasAcoes`) e o histórico de decisões
 * (`crm_lead_activities` `next_action_approved` / `next_action_dismissed`).
 * Não são propostas comerciais.
 *
 * Com o worker parado a IA não escreve nada, então gravamos o que a ferramenta
 * de estado do lead (`lib/agent-engine/agent/lead-state.ts`) gravaria: o texto e
 * o `next_action_seq`. O histórico é gravado como a rota de decisão
 * (`POST /api/v1/leads/{id}/next-action` → `emitLeadActivity`) grava.
 *
 * Cinco pacientes PRÓPRIOS do módulo, cada um com um negócio aberto no funil da
 * base (para a etapa aparecer na lista e o cartão aparecer no quadro):
 * - três com sugestão esperando decisão (1 dia, 5 horas, 40 minutos);
 * - dois já decididos (uma aprovada pelo Carlos, uma ignorada pela Helena).
 * As lições aprovam e ignoram pela tela SÓ estas linhas. As decisões criadas na
 * aula caem junto com os negócios (FK `on delete cascade`), e a sugestão volta
 * porque o `lead_state` é recriado.
 *
 * `limpar` (chamada pela base antes de QUALQUER aula) tira tudo daqui: os
 * negócios extras não podem sobrar no quadro de Funis de outro módulo.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos `d121…`) e recria.
 */
import { type Contexto, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const contatoId = (n: number) => `d1210000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const negocioId = (n: number) => `d1210100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const decisaoId = (n: number) => `d1210200-0000-4000-8000-${String(n).padStart(12, "0")}`;

const HORA = 60;
const DIA = 24 * HORA;

type Paciente = {
  n: number;
  nome: string;
  telefone: string;
  negocio: string;
  /** Posição da etapa no funil "Pacientes" da base. */
  etapa: number;
  reais: number;
  /** Sugestão esperando decisão: o texto e há quantos minutos a IA a escreveu. */
  sugestao?: { texto: string; ha: number };
};

const PACIENTES: Paciente[] = [
  {
    n: 1,
    nome: "Patrícia Gomes",
    telefone: "+5511987652101",
    negocio: "Avaliação de pilates",
    etapa: 0,
    reais: 480,
    sugestao: { texto: "Oferecer 20% de desconto se ela fechar o pacote de pilates hoje", ha: 26 * HORA },
  },
  {
    n: 2,
    nome: "Henrique Duarte",
    telefone: "+5511987652102",
    negocio: "Fisioterapia do joelho",
    etapa: 1,
    reais: 900,
    sugestao: {
      texto: "Enviar amanhã cedo o lembrete da fisioterapia de quinta, com o endereço da clínica",
      ha: 5 * HORA,
    },
  },
  {
    n: 3,
    nome: "Sônia Martins",
    telefone: "+5511987652103",
    negocio: "Acompanhamento nutricional",
    etapa: 3,
    reais: 320,
    sugestao: { texto: "Oferecer um horário de retorno com a nutricionista na semana que vem", ha: 40 },
  },
  { n: 4, nome: "Marcos Antunes", telefone: "+5511987652104", negocio: "Sessões de RPG", etapa: 2, reais: 1200 },
  { n: 5, nome: "Regina Lima", telefone: "+5511987652105", negocio: "Clareamento dental", etapa: 1, reais: 750 },
];

/** Decisões já tomadas, como a rota de decisão as grava. */
const DECISOES = [
  {
    n: 1,
    paciente: 4,
    tipo: "next_action_approved" as const,
    quem: "carlos" as const,
    texto: "Confirmar por mensagem a sessão de RPG de sábado às 9h",
    ha: 2 * DIA,
  },
  {
    n: 2,
    paciente: 5,
    tipo: "next_action_dismissed" as const,
    quem: "helena" as const,
    texto: "Ligar hoje à noite para insistir no clareamento dental",
    ha: 3 * DIA,
  },
];

/** Limpeza chamada antes de QUALQUER aula: estes pacientes e negócios não sobram em outra tela. */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  // os negócios levam junto as decisões (inclusive as tomadas na aula); os contatos, o lead_state
  semErro(
    await db.from("crm_leads").delete().eq("organization_id", org).in("id", PACIENTES.map((p) => negocioId(p.n))),
    "limpar negócios do módulo",
  );
  semErro(
    await db.from("contacts").delete().eq("organization_id", org).in("id", PACIENTES.map((p) => contatoId(p.n))),
    "limpar pacientes do módulo",
  );
}

export async function semear(c: Contexto) {
  const { db, org, pessoa, funil } = c;

  await limpar(c);

  semErro(
    await db.from("contacts").insert(
      PACIENTES.map((p) => ({
        id: contatoId(p.n),
        organization_id: org,
        name: p.nome,
        phone_number: p.telefone,
        created_at: ha(10 * DIA),
      })),
    ),
    "pacientes do módulo",
  );

  semErro(
    await db.from("crm_leads").insert(
      PACIENTES.map((p) => {
        const etapa = funil.etapas[p.etapa];
        if (!etapa) throw new Error(`o funil da base não tem a etapa ${p.etapa}`);
        return {
          id: negocioId(p.n),
          organization_id: org,
          pipeline_id: funil.id,
          stage_id: etapa,
          title: demo(p.negocio),
          contact_id: contatoId(p.n),
          value_cents: p.reais * 100,
          currency: "BRL",
          status: "open",
        };
      }),
    ),
    "negócios do módulo",
  );

  // A sugestão mora no estado do CONTATO (um por contato); `updated_at` é o "proposta há…" da lista.
  semErro(
    await db.from("lead_state").insert(
      PACIENTES.filter((p) => p.sugestao).map((p) => ({
        organization_id: org,
        contact_id: contatoId(p.n),
        stage: "qualifying",
        next_action: demo(p.sugestao!.texto),
        next_action_seq: 1,
        updated_at: ha(p.sugestao!.ha),
      })),
    ),
    "sugestões esperando decisão",
  );

  semErro(
    await db.from("crm_lead_activities").insert(
      DECISOES.map((d) => {
        const texto = demo(d.texto);
        const aprovou = d.tipo === "next_action_approved";
        return {
          id: decisaoId(d.n),
          organization_id: org,
          lead_id: negocioId(d.paciente),
          contact_id: contatoId(d.paciente),
          type: d.tipo,
          source_module: "crm",
          source_id: negocioId(d.paciente),
          actor_kind: "user",
          actor_agent_id: null,
          performed_by_user_id: pessoa[d.quem],
          reason: `${aprovou ? "Aprovou" : "Descartou"}: ${texto}`,
          evidence: null,
          payload: { next_action: texto, decision: aprovou ? "approve" : "dismiss" },
          performed_at: ha(d.ha),
          created_at: ha(d.ha),
        };
      }),
    ),
    "decisões já tomadas",
  );
}
