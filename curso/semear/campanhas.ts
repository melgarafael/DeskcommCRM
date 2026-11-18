/**
 * Semente do módulo Campanhas (CRM › Ver tudo em CRM › Campanhas).
 *
 * Cinco campanhas da Clínica Bem Viver, uma em cada estado que a lista ensina:
 * concluída, enviando, pausada, cancelada e um rascunho que a lição "Preparar a
 * lista" prepara pela tela. Mais a configuração que vale para todas: um texto
 * salvo e dois números na lista de exclusão — um deles é o da Tereza, para a
 * preparação mostrar o motivo "Está na lista de exclusão de campanhas".
 *
 * NADA aqui pode sair para o WhatsApp, nem com o worker de pé por engano:
 * - quem ainda espera envio (campanha "Enviando" e "Pausada") tem
 *   `next_attempt_at` daqui a 30 dias — a rodada só pega `pending` vencido
 *   (lib/campanhas/rodada.ts) — e não tem texto renderizado;
 * - nenhuma campanha fica "Agendada" (a tela nem oferece agendar).
 *
 * As campanhas VIVAS (Enviando e Pausada) não dividem contato entre si, como o
 * produto garante na preparação (`contatosJaEmCampanha`). A Fernanda está na
 * "Enviando": é ela que a prévia da lição de criar mostra como "Já está em outra
 * campanha ainda não concluída". A Juliana não está em nenhuma viva.
 *
 * Contatos são os da base (ids fixos de `contatoId`), só referenciados: a semente
 * nunca altera contato, conversa ou negócio. Idempotente: apaga as próprias
 * linhas (ids fixos + nomes que as lições criam pela tela) e recria.
 */
import { createHash } from "node:crypto";

import { type Contexto, contatoId, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const campanhaId = (n: number) => `d1020000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const destinatarioId = (n: number) => `d1020100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const exclusaoId = (n: number) => `d1020200-0000-4000-8000-${String(n).padStart(12, "0")}`;
const textoId = (n: number) => `d1020300-0000-4000-8000-${String(n).padStart(12, "0")}`;

const HORA = 60;
const DIA = 24 * HORA;

/** Mesmo cálculo de `hashDoEndereco` (lib/campanhas/exclusoes.ts): só dígitos, com `+`. */
const hashDoTelefone = (telefone: string) =>
  createHash("sha256").update(`+${telefone.replace(/\D/g, "")}`, "utf8").digest("hex");

const FILTRO_VAZIO = {
  com_todas_tags: [] as string[],
  com_alguma_tag: [] as string[],
  sem_tags: [] as string[],
  funis: [] as string[],
  etapas: [] as string[],
  responsaveis: [] as string[],
  situacoes_do_negocio: [] as string[],
  sem_interacao_ha_dias: null,
  com_interacao_ha_dias: null,
  cadastrado_de: null,
  cadastrado_ate: null,
  origens: [] as string[],
  incluir_contatos: [] as string[],
  excluir_contatos: [] as string[],
  limite: 100,
};

const NOMES = {
  concluida: "Reativação de pacientes do pilates",
  enviando: "Avaliação nutricional de outubro",
  pausada: "Retorno da fisioterapia",
  cancelada: "Promoção de clareamento dental",
  rascunho: "Convite para a avaliação odontológica",
};

/** Nomes que as lições criam pela tela: limpos aqui para cada lição partir do mesmo estado. */
const CRIADAS_NAS_LICOES = [
  "Lembrete de retorno — pacientes de convênio",
];

type Destinatario = {
  contato: number;
  telefone: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "replied" | "failed" | "skipped";
  motivo?: "opt_out";
  /** Minutos atrás em que saiu; null = não saiu. */
  saiu?: number;
};

export async function semear(c: Contexto) {
  const { db, org, pessoa, sessao } = c;

  // ---------- limpeza: só as linhas deste módulo ----------
  const meusIds = [1, 2, 3, 4, 5].map(campanhaId);
  const criadas = [
    ...CRIADAS_NAS_LICOES.map((n) => demo(n)),
    // "Duplicar" grava o nome com " (cópia)" (lib/campanhas/acoes.ts → duplicarAcao)
    ...Object.values(NOMES).map((n) => `${demo(n)} (cópia)`),
  ];
  semErro(await db.from("campaigns").delete().eq("organization_id", org).in("id", meusIds), "limpar campanhas");
  semErro(await db.from("campaigns").delete().eq("organization_id", org).in("name", criadas), "limpar campanhas das lições");
  semErro(
    await db.from("campaign_suppressions").delete().eq("organization_id", org).in("id", [1, 2].map(exclusaoId)),
    "limpar lista de exclusão",
  );
  semErro(
    await db.from("campaign_templates").delete().eq("organization_id", org).in("id", [1].map(textoId)),
    "limpar textos salvos",
  );

  // ---------- campanhas ----------
  const base = {
    organization_id: org,
    channel_session_id: sessao,
    base_legal: "consent",
    lia_ref: null as string | null,
    message_mode: "text",
    velocidade: "gradual",
    created_by: pessoa.helena,
  };
  const ritmoLivre = {
    intervalo_segundos: null as number | null,
    janela_inicio_hora: null as number | null,
    janela_fim_hora: null as number | null,
    teto_diario: null as number | null,
    teto_horario: null as number | null,
  };

  /** Quando cada lista foi montada: carimbo da campanha e dos destinatários dela. */
  const PREPARADA_EM: Record<number, string> = {
    1: ha(7 * DIA + HORA),
    2: ha(4 * HORA),
    3: ha(2 * DIA),
  };

  const CAMPANHAS = [
    {
      ...base,
      ...ritmoLivre,
      id: campanhaId(1),
      name: demo(NOMES.concluida),
      status: "completed",
      message_body: demo(
        "{{saudacao}}, {{primeiro_nome}}! Sentimos sua falta nas aulas de pilates da Clínica Bem Viver. Abrimos turmas novas de manhã e à noite. Quer que a gente reserve uma aula experimental para você?",
      ),
      audience_filter: { ...FILTRO_VAZIO, sem_tags: ["convenio"] },
      created_at: ha(8 * DIA),
      prepared_at: PREPARADA_EM[1],
      started_at: ha(7 * DIA),
      completed_at: ha(6 * DIA + 20 * HORA),
      snapshot_total: 6,
      snapshot_eligible: 5,
      snapshot_excluded: 1,
    },
    {
      ...base,
      id: campanhaId(2),
      name: demo(NOMES.enviando),
      status: "running",
      message_body: demo(
        "{{saudacao}}, {{primeiro_nome}}! Em outubro a avaliação nutricional da Clínica Bem Viver está com 20% de desconto. Quer que eu veja um horário com a nutricionista para você?",
      ),
      audience_filter: { ...FILTRO_VAZIO, com_alguma_tag: ["primeira-consulta", "retorno"], incluir_contatos: [contatoId(4), contatoId(11)] },
      // O ritmo próprio que a lição "Acompanhar" mostra: só deixa mais devagar que o número.
      intervalo_segundos: 120,
      janela_inicio_hora: 8,
      janela_fim_hora: 19,
      teto_diario: 40,
      teto_horario: null,
      created_at: ha(DIA + 2 * HORA),
      prepared_at: PREPARADA_EM[2],
      started_at: ha(3 * HORA),
      snapshot_total: 4,
      snapshot_eligible: 3,
      snapshot_excluded: 1,
    },
    {
      ...base,
      ...ritmoLivre,
      id: campanhaId(3),
      name: demo(NOMES.pausada),
      status: "paused",
      message_body: demo(
        "{{saudacao}}, {{primeiro_nome}}! Já faz um tempo desde a sua última sessão de fisioterapia. Que tal marcar um retorno para ver como está a recuperação?",
      ),
      audience_filter: { ...FILTRO_VAZIO, incluir_contatos: [contatoId(2), contatoId(6)] },
      created_at: ha(2 * DIA + 3 * HORA),
      prepared_at: PREPARADA_EM[3],
      started_at: ha(DIA + 22 * HORA),
      paused_at: ha(DIA + 20 * HORA),
      snapshot_total: 2,
      snapshot_eligible: 2,
      snapshot_excluded: 0,
    },
    {
      ...base,
      ...ritmoLivre,
      id: campanhaId(4),
      name: demo(NOMES.cancelada),
      status: "cancelled",
      message_body: demo(
        "{{saudacao}}, {{primeiro_nome}}! Neste mês o clareamento dental está com condição especial na Clínica Bem Viver. Quer saber como funciona?",
      ),
      audience_filter: { ...FILTRO_VAZIO, com_alguma_tag: ["particular"] },
      created_at: ha(5 * DIA),
      cancelled_at: ha(4 * DIA + 6 * HORA),
      snapshot_total: 0,
      snapshot_eligible: 0,
      snapshot_excluded: 0,
    },
    {
      ...base,
      ...ritmoLivre,
      id: campanhaId(5),
      name: demo(NOMES.rascunho),
      status: "draft",
      base_legal: "legitimate_interest",
      lia_ref: "LIA-2026-02",
      message_body: demo(
        "{{saudacao}}, {{primeiro_nome}}! A Clínica Bem Viver agora tem dentista. A primeira avaliação odontológica é gratuita para quem já é paciente. Quer agendar a sua?",
      ),
      // O público que a lição prepara pela tela: quem NÃO tem a etiqueta "convenio".
      audience_filter: { ...FILTRO_VAZIO, sem_tags: ["convenio"] },
      created_at: ha(50),
      snapshot_total: 0,
      snapshot_eligible: 0,
      snapshot_excluded: 0,
    },
  ];
  semErro(await db.from("campaigns").insert(CAMPANHAS), "campanhas");

  // ---------- quem estava em cada lista ----------
  const DESTINATARIOS: Record<number, Destinatario[]> = {
    // Concluída: 5 na lista, 1 de fora (o Osvaldo pediu para não receber).
    1: [
      { contato: 2, telefone: "+5511987650002", status: "replied", saiu: 7 * DIA - 5 },
      { contato: 6, telefone: "+5511987650006", status: "read", saiu: 7 * DIA - 10 },
      { contato: 7, telefone: "+5511987650007", status: "delivered", saiu: 7 * DIA - 15 },
      { contato: 9, telefone: "+5511987650009", status: "replied", saiu: 7 * DIA - 20 },
      { contato: 8, telefone: "+5511987650008", status: "failed" },
      { contato: 11, telefone: null, status: "skipped", motivo: "opt_out" },
    ],
    // Enviando: 2 já saíram, a Fernanda ainda espera a vez.
    2: [
      { contato: 4, telefone: "+5511987650004", status: "replied", saiu: 170 },
      { contato: 1, telefone: "+5511987650001", status: "read", saiu: 160 },
      { contato: 5, telefone: "+5511987650005", status: "pending" },
      { contato: 11, telefone: null, status: "skipped", motivo: "opt_out" },
    ],
    // Pausada: o Roberto recebeu; o Lucas ficou para depois da pausa.
    3: [
      { contato: 2, telefone: "+5511987650002", status: "delivered", saiu: DIA + 21 * HORA },
      { contato: 6, telefone: "+5511987650006", status: "pending" },
    ],
  };

  const daqui30Dias = new Date(Date.now() + 30 * DIA * 60_000).toISOString();
  const linhas = Object.entries(DESTINATARIOS).flatMap(([n, lista]) =>
    lista.map((d, i) => {
      const saiu = d.saiu;
      const passou = (min: number) => (saiu === undefined ? null : ha(saiu - min));
      const chegou = ["delivered", "read", "replied"].includes(d.status);
      const leu = ["read", "replied"].includes(d.status);
      return {
        id: destinatarioId(Number(n) * 100 + i + 1),
        organization_id: org,
        campaign_id: campanhaId(Number(n)),
        contact_id: contatoId(d.contato),
        recipient_address: d.telefone,
        status: d.status,
        eligibility_status: d.motivo ? "excluded" : "eligible",
        exclusion_reason: d.motivo ?? null,
        variables: {},
        // Sem texto pronto: o que espera a vez não teria o que enviar.
        rendered_body: null,
        sent_at: passou(0),
        delivered_at: chegou ? passou(1) : null,
        read_at: leu ? passou(25) : null,
        replied_at: d.status === "replied" ? passou(40) : null,
        attempt_count: d.status === "failed" ? 3 : saiu === undefined ? 0 : 1,
        last_attempt_at: d.status === "failed" ? ha(7 * DIA - 30) : passou(0),
        // A trava contra disparo: a rodada só pega `pending` com prazo vencido.
        next_attempt_at: d.status === "pending" ? daqui30Dias : null,
        // ordem estável na lista "Quem está na lista"
        created_at: new Date(Date.parse(PREPARADA_EM[Number(n)]!) + i * 1000).toISOString(),
      };
    }),
  );
  semErro(await db.from("campaign_recipients").insert(linhas), "destinatários");

  // ---------- configuração: lista de exclusão e um texto salvo ----------
  semErro(
    await db.from("campaign_suppressions").insert([
      {
        id: exclusaoId(1),
        organization_id: org,
        contact_id: null,
        recipient_address_hash: hashDoTelefone("+5511987650012"),
        address_tail: "0012",
        reason: demo("Prefere ser avisada por ligação"),
        source: "manual",
        created_by: pessoa.helena,
        created_at: ha(10 * DIA),
      },
      {
        id: exclusaoId(2),
        organization_id: org,
        contact_id: null,
        recipient_address_hash: hashDoTelefone("+5511944417730"),
        address_tail: "7730",
        reason: demo("Laboratório parceiro"),
        source: "manual",
        created_by: pessoa.helena,
        created_at: ha(12 * DIA),
      },
    ]),
    "lista de exclusão",
  );
  semErro(
    await db.from("campaign_templates").insert({
      id: textoId(1),
      organization_id: org,
      name: demo("Convite para aula experimental"),
      body: demo(
        "{{saudacao}}, {{primeiro_nome}}! Que tal conhecer o pilates da Clínica Bem Viver? A primeira aula é por nossa conta.",
      ),
      created_by: pessoa.helena,
    }),
    "texto salvo",
  );
}
