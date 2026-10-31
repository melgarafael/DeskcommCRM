/**
 * Semente do módulo "Chamadas" (CRM › Ver tudo em CRM › Chamadas).
 *
 * A telefonia por SIP é módulo opcional do SERVIDOR (profile `telefonia` do
 * docker compose: Asterisk + voice-agent) — o app não tem chave para ligá-la, e
 * a bancada do curso não a tem. Então a tela mostra o que o worker de voz teria
 * gravado em `voice_calls` (provider 'sip'): seis ligações já ENCERRADAS da
 * Clínica Bem Viver, nos estados que o worker e a rota de discagem realmente
 * produzem (concluída com transcrição, não atendida, falhou, recusada de
 * bloqueado). Nenhuma ligação real, nenhum serviço externo.
 *
 * Três cuidados, porque `voice_calls` é escutada AO VIVO por todo o app:
 *  - Toda linha nasce `ended`. Uma linha `ringing`/`connected` acorda o painel de
 *    chamada de voz (hooks/voice/useVoiceCallSession.ts, sem filtro de provider)
 *    na tela de quem estiver logado na organização — inclusive nas fotos de
 *    outros módulos capturados ao mesmo tempo.
 *  - Toda linha nasce `outbound`; as de entrada viram `inbound` num UPDATE logo
 *    depois. O aviso "Ligação recebida" (hooks/calls/useInboundCallAlerts.ts)
 *    escuta só INSERT de linha de entrada: assim a semente não toca o aviso em
 *    nenhuma tela.
 *  - Toda linha aponta para um contato da base (nenhum é "pessoal"). A rota
 *    GET /api/v1/calls esconde chamadas de contato pessoal com
 *    `contact_id not in (...)`, e esse filtro também some com as linhas SEM
 *    contato assim que a organização tem um contato pessoal (outra semente cria
 *    um).
 *
 * Idempotente: apaga só as próprias linhas (ids fixos, prefixo d1060000) e
 * recria; `limpar` faz a mesma limpeza antes de qualquer aula. As lições não
 * gravam nada: a de "Nova ligação" preenche o número mas não clica em ligar.
 */
import { type Contexto, contatoId, ha, ontemAs, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const chamadaId = (n: number) => `d1060000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Fala = { quem: "ia" | "cliente"; texto: string; aos: number };
type Chamada = {
  n: number;
  contato: number;
  telefone: string;
  direcao: "inbound" | "outbound";
  inicio: string;
  /** Como o worker/rota encerra: user_ended = Concluída, timeout = Não atendida,
   *  failed = Falhou, contact_blocked = Cancelada (recusada de bloqueado). */
  fim: "user_ended" | "timeout" | "failed" | "contact_blocked";
  atendidaApos?: number;
  duracao?: number;
  falas?: Fala[];
};

const CHAMADAS: Chamada[] = [
  {
    n: 1,
    contato: 3,
    telefone: "+5511987650003",
    direcao: "inbound",
    inicio: ha(25),
    fim: "user_ended",
    atendidaApos: 4,
    duracao: 188,
    falas: [
      { quem: "ia", aos: 1, texto: "Clínica Bem Viver, aqui é a assistente virtual. Como posso ajudar?" },
      {
        quem: "cliente",
        aos: 6,
        texto: "Oi, eu queria saber se ainda tem horário de fisioterapia pelo convênio Unimed esta semana.",
      },
      {
        quem: "ia",
        aos: 14,
        texto: "Tem sim! Na quinta-feira há horário às 8h e às 16h30 com a fisioterapeuta. Qual fica melhor para você?",
      },
      { quem: "cliente", aos: 25, texto: "Às 16h30 é perfeito." },
      {
        quem: "ia",
        aos: 30,
        texto: "Combinado. A recepção vai confirmar o horário pelo WhatsApp e pedir a foto da carteirinha do convênio. Posso ajudar em mais alguma coisa?",
      },
      { quem: "cliente", aos: 44, texto: "Não, era só isso. Obrigada!" },
      { quem: "ia", aos: 48, texto: "Eu que agradeço, Juliana. Até quinta!" },
    ],
  },
  {
    n: 2,
    contato: 4,
    telefone: "+5511987650004",
    direcao: "outbound",
    inicio: ha(70),
    fim: "user_ended",
    atendidaApos: 9,
    duracao: 106,
    falas: [
      // o cliente atendeu e não disse nada: a tela mostra "(sem áudio detectado)"
      { quem: "cliente", aos: 1, texto: "" },
      { quem: "ia", aos: 3, texto: "Alô? Bom dia, falo com o Pedro Henrique?" },
      { quem: "cliente", aos: 7, texto: "Sim, é ele." },
      {
        quem: "ia",
        aos: 10,
        texto: "Aqui é da Clínica Bem Viver. Estou ligando para confirmar sua consulta de nutrição amanhã às 9h. Você confirma?",
      },
      { quem: "cliente", aos: 20, texto: "Confirmo, pode deixar." },
      { quem: "ia", aos: 24, texto: "Perfeito! Chegue uns 10 minutos antes, por favor. Tenha um ótimo dia." },
    ],
  },
  { n: 3, contato: 6, telefone: "+5511987650006", direcao: "outbound", inicio: ha(140), fim: "timeout" },
  { n: 4, contato: 11, telefone: "+5511987650011", direcao: "inbound", inicio: ha(260), fim: "contact_blocked" },
  { n: 5, contato: 7, telefone: "+5511987650007", direcao: "outbound", inicio: ontemAs(17, 40), fim: "failed" },
  {
    n: 6,
    contato: 5,
    telefone: "+5511987650005",
    direcao: "inbound",
    inicio: ontemAs(10, 15),
    fim: "user_ended",
    atendidaApos: 3,
    duracao: 141,
    falas: [
      { quem: "ia", aos: 1, texto: "Clínica Bem Viver, aqui é a assistente virtual. Como posso ajudar?" },
      { quem: "cliente", aos: 5, texto: "Oi, preciso remarcar minha consulta com a nutricionista de sexta." },
      {
        quem: "ia",
        aos: 12,
        texto: "Claro, Fernanda. Tenho horário na segunda às 14h ou na terça às 10h. Algum desses serve?",
      },
      { quem: "cliente", aos: 22, texto: "Terça às 10h." },
      { quem: "ia", aos: 26, texto: "Anotado. A recepção confirma a mudança pelo WhatsApp ainda hoje." },
    ],
  },
];

const mais = (iso: string, segundos: number) => new Date(Date.parse(iso) + segundos * 1000).toISOString();

/**
 * Chamada antes de QUALQUER aula (limparSementesDeModulo): as seis ligações não
 * ficam na base depois da aula de Chamadas. A base apaga e recria os contatos a
 * cada aula, e `voice_calls.contact_id` é `on delete set null` — sem esta
 * limpeza, as linhas sobravam órfãs de contato no banco das outras aulas.
 */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  const ids = CHAMADAS.map((x) => chamadaId(x.n));
  semErro(await db.from("voice_calls").delete().eq("organization_id", org).in("id", ids), "limpar chamadas");
}

export async function semear(c: Contexto) {
  const { db, org } = c;
  await limpar(c);

  const linhas = CHAMADAS.map((x) => {
    const atendida = x.atendidaApos !== undefined ? mais(x.inicio, x.atendidaApos) : null;
    const encerrada =
      x.fim === "failed"
        ? null // a rota de discagem marca `ended`/`failed` sem `ended_at`
        : atendida && x.duracao !== undefined
          ? mais(atendida, x.duracao)
          : mais(x.inicio, x.fim === "timeout" ? 30 : 0);
    return {
      id: chamadaId(x.n),
      organization_id: org,
      provider: "sip",
      // nasce de SAÍDA; as de entrada viram `inbound` no UPDATE abaixo (ver cabeçalho)
      direction: "outbound",
      status: "ended",
      end_reason: x.fim,
      peer_phone: x.telefone,
      contact_id: contatoId(x.contato),
      // a rota de discagem grava "ai" ao criar; a recusada de bloqueado não grava nada
      handled_by: x.fim === "contact_blocked" ? null : "ai",
      started_at: x.inicio,
      answered_at: atendida,
      ended_at: encerrada,
      duration_ms: x.duracao !== undefined ? x.duracao * 1000 : null,
      transcript: x.falas
        ? x.falas.map((f) => ({
            speaker: f.quem === "ia" ? "agent" : "customer",
            text: f.texto ? demo(f.texto) : "",
            ts: mais(atendida ?? x.inicio, f.aos),
          }))
        : null,
      metadata: {},
    };
  });
  semErro(await db.from("voice_calls").insert(linhas), "criar chamadas");

  const deEntrada = CHAMADAS.filter((x) => x.direcao === "inbound").map((x) => chamadaId(x.n));
  semErro(
    await db.from("voice_calls").update({ direction: "inbound" }).eq("organization_id", org).in("id", deEntrada),
    "marcar chamadas de entrada",
  );
}
