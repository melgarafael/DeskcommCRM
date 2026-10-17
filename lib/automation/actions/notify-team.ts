/**
 * A ação `notify_team` — MENSAGEM PARA A EQUIPE (#2642).
 *
 * ─── O defeito que esta ação fecha ─────────────────────────────────────────
 *
 * Hoje o agente não avisa a EQUIPE quando o negócio vira ganho. Os caminhos que
 * existem todos entregam no lugar errado:
 *
 *  - `send_whatsapp_message` e `send_ai_message` mandam para o LEAD. São escritas
 *    para o primeiro contato com o cliente, não para a virada para ganho;
 *  - o aviso de caso (`lib/escalacao/texto-do-aviso.ts`) nasce quando o caso
 *    ABRE, com texto fixo e primeiro nome só — nunca quando o negócio é ganho;
 *  - `crm_start_conversation_and_send` é recusado por `escopo-das-escritas.ts`,
 *    e está certo: ele escreveria para outro contato do turno;
 *  - `call-webhook` exige um serviço externo e manda corpo fixo; e-mail nem
 *    existe como ação.
 *
 * Ficava sem resposta o caminho mais provável de todos: o closer fechou a
 * venda e ninguém da equipe ficou sabendo.
 *
 * ─── O destinatário é uma PESSOA DA EQUIPE, e só ADMIN escolhe ─────────────
 *
 * A configuração da ação guarda o `membro_id` (`user_organizations.user_id`) e
 * o canal de entrega — e nada mais. NÃO existe campo de número nem de
 * endereço: o que o administrador registrou é que vale. O WhatsApp sai para o
 * número que o ADMIN cadastrou em `config_aviso_de_caso` (a mesma tela de
 * Avisos, a mesma escrita server-side da disciplina da #1347), e o e-mail sai
 * para o endereço que JÁ ESTÁ cadastrado no GoTrue da própria pessoa. Colar
 * número novo na regra seria abrir a porta de spam — e a disciplina da #1347
 * foi justamente matar isso.
 *
 * O portão de papel é da rota (`requireRole("admin")`, mais baixo que o
 * `manager` que abre a tela de regras) e a opção some do editor para quem não
 * é administrador. O executor não confia em nenhum dos dois: ele só aceita
 * membro ATIVO dest-ESTA organização, com papel acima de viewer.
 *
 * ─── NÃO abre conversa com o lead ──────────────────────────────────────────
 *
 * O WhatsApp sai pelo MESMO transporte direto do aviso de caso
 * (`criarTransporteDoAviso`): fora do `sendMessageHandler`, sem linha em
 * `messages`, sem conversa nova, sem timeline de ninguém. A ingestão tem um
 * corte (`numero-interno-de-aviso`) que descarta o que vem do número interno
 * justamente para um aviso não virar conversa — e este aviso respeita o mesmo
 * corte. O trigger desta ação é a virada para ganho, e a passagem para o
 * humano é tratada no MESMO corpo: compromissos, objeções e próxima ação saem
 * do checkpoint, que é o que o closer precisa ler antes de ligar.
 *
 * ─── O resumo é LIDO AGORA, nunca gravado ──────────────────────────────────
 *
 * Nada de texto fixo gravado na regra: `montarResumoParaAEquipe` lê o lead, o
 * contato, a pontuação (número E motivo, do jeito que `crm_lead_scores` grava)
 * e a passagem no MOMENTO do disparo. Ver `resumo-para-a-equipe.ts` para a
 * régua de limpeza.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { IDIOMAS, type Idioma } from "@/lib/i18n/idiomas";

import {
  montarResumoParaAEquipe,
  type PassagemDoResumo,
  type PontuacaoDoResumo,
} from "../resumo-para-a-equipe";
import type { ActionCtx, ActionExecutor, ActionResultDetail } from "../types";
import { registerAction } from "@/lib/automation/actions";

const TIPO = "notify_team";

interface ConfigNotifyTeam {
  /** `user_organizations.user_id` — a pessoa da equipe que recebe. */
  membro_id?: string;
  /** Por onde o resumo sai. */
  canal?: string;
}

/** O que `config_aviso_de_caso` tem que ter para o WhatsApp sair. */
interface NumeroDaEquipe {
  channel_session_id: string;
  telefone_destino: string;
}

/** A linha de `channel_sessions` que a checagem de capacidade olha. */
interface CanalDaEquipe {
  id: string;
  status: string;
  archived_at: string | null;
  provider: string;
  /** `null` quando o canal está ligado; o valor, quando desligado. */
  metadata: unknown;
}

type Admin = SupabaseClient;

/**
 * Contexto de um evento: o motor monta `lead` e `contact` (`buildContext`),
 * mas o tipo é `Record<string, unknown>` — então o executor tem de estreitar
 * com as MESMAS colunas que o banco devolve. Nomes que batem com
 * `database.types.ts`, e não com o que parece bom.
 */
interface LeadDoContexto {
  id: string;
  title: string | null;
  description: string | null;
  status: string | null;
  value_cents: number | null;
  currency: string | null;
  won_reason: string | null;
  contact_id: string | null;
}

interface ContatoDoContexto {
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
}

function estreitarLead(bruto: unknown): LeadDoContexto | null {
  if (typeof bruto !== "object" || bruto === null) return null;
  const l = bruto as Record<string, unknown>;
  if (typeof l.id !== "string" || l.id === "") return null;
  return {
    id: l.id,
    title: typeof l.title === "string" ? l.title : null,
    description: typeof l.description === "string" ? l.description : null,
    status: typeof l.status === "string" ? l.status : null,
    value_cents: typeof l.value_cents === "number" ? l.value_cents : null,
    currency: typeof l.currency === "string" ? l.currency : null,
    won_reason: typeof l.won_reason === "string" ? l.won_reason : null,
    contact_id: typeof l.contact_id === "string" ? l.contact_id : null,
  };
}

function estreitarContato(bruto: unknown): ContatoDoContexto | null {
  if (typeof bruto !== "object" || bruto === null) return null;
  const c = bruto as Record<string, unknown>;
  return {
    name: typeof c.name === "string" ? c.name : null,
    display_name: typeof c.display_name === "string" ? c.display_name : null,
    phone_number: typeof c.phone_number === "string" ? c.phone_number : null,
  };
}

/** `organizations.locale` pode trazer o que for; o catálogo decide o que é idioma. */
async function idiomaDaOrganizacao(admin: Admin, organizationId: string): Promise<Idioma> {
  const { data } = await admin.from("organizations").select("locale").eq("id", organizationId).maybeSingle();
  const bruto = (data as { locale?: string | null } | null)?.locale;
  return typeof bruto === "string" && (IDIOMAS as readonly string[]).includes(bruto)
    ? (bruto as Idioma)
    : "pt-BR";
}

/**
 * O membro tem de ser ATIVO DESTA organização, e não pode ser viewer.
 *
 * Mesmo filtro de `assign_owner`: a regra é salva uma vez e dispara para
 * sempre, então um membro revogado ou trocado de empresa tem de morrer aqui e
 * não num envio para gente de fora.
 */
async function membroAtivo(
  admin: Admin,
  organizationId: string,
  membroId: string,
): Promise<{ user_id: string; role: string } | null> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", membroId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error !== null || data === null) return null;
  const linha = data as { user_id: string; role: string };
  if (linha.role === "viewer") return null;
  return linha;
}

/**
 * `crm_lead_scores` — número E motivo na mesma linha.
 *
 * Os dois vêm juntos porque a própria constraint do banco não deixa número sem
 * frase ("score sem razão não é gravado"). A coluna é `integer`, de 0 a 100.
 */
async function pontuacaoDoLead(
  admin: Admin,
  organizationId: string,
  leadId: string,
): Promise<PontuacaoDoResumo | null> {
  const { data } = await admin
    .from("crm_lead_scores")
    .select("ai_probability, ai_probability_reason")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .maybeSingle();
  if (data === null) return null;
  const linha = data as { ai_probability?: number | null; ai_probability_reason?: string | null };
  return {
    probabilidade: typeof linha.ai_probability === "number" ? linha.ai_probability : null,
    motivo: typeof linha.ai_probability_reason === "string" ? linha.ai_probability_reason : null,
  };
}

/** O checkpoint mais novo do contato: o que a conversa COMBINOU com o cliente. */
async function passagemDoContato(
  admin: Admin,
  organizationId: string,
  contactId: string,
): Promise<PassagemDoResumo | null> {
  const { data } = await admin
    .from("lead_checkpoints")
    .select("commitments, objections, next_action")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data === null) return null;
  const linha = data as {
    commitments?: string[] | null;
    objections?: string[] | null;
    next_action?: string | null;
  };
  return {
    compromissos: Array.isArray(linha.commitments) ? linha.commitments : [],
    objecoes: Array.isArray(linha.objections) ? linha.objections : [],
    proximaAcao: typeof linha.next_action === "string" ? linha.next_action : null,
  };
}

/**
 * O NÚMERO DA EQUIPE é o que o ADMIN registrou em `config_aviso_de_caso`.
 *
 * `null` quando não há nada cadastrado — e o `skipped` diz isso com todas as
 * letras, porque é um erro de CONFIGURAÇÃO, não de execução.
 */
async function numeroDaEquipe(admin: Admin, organizationId: string): Promise<NumeroDaEquipe | null> {
  const { data } = await admin
    .from("config_aviso_de_caso")
    .select("channel_session_id, telefone_destino, ligado")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (data === null) return null;
  const linha = data as {
    channel_session_id: string | null;
    telefone_destino: string | null;
    ligado: boolean | null;
  };
  if (linha.ligado !== true) return null;
  if (typeof linha.channel_session_id !== "string" || linha.channel_session_id === "") return null;
  if (typeof linha.telefone_destino !== "string" || linha.telefone_destino === "") return null;
  return { channel_session_id: linha.channel_session_id, telefone_destino: linha.telefone_destino };
}

/** A linha de `channel_sessions` que decide se o canal aceita envio agora. */
async function canalDaEquipe(
  admin: Admin,
  organizationId: string,
  canalId: string,
): Promise<CanalDaEquipe | null> {
  const { data } = await admin
    .from("channel_sessions")
    .select("id, status, archived_at, provider, metadata")
    .eq("organization_id", organizationId)
    .eq("id", canalId)
    .maybeSingle();
  if (data === null) return null;
  const linha = data as {
    id?: string;
    status?: string | null;
    archived_at?: string | null;
    provider?: string | null;
    metadata?: unknown;
  };
  const desligado =
    typeof linha.metadata === "object" &&
    linha.metadata !== null &&
    (linha.metadata as { disabled?: unknown }).disabled === true;
  return {
    id: typeof linha.id === "string" ? linha.id : canalId,
    status: typeof linha.status === "string" ? linha.status : "",
    archived_at: typeof linha.archived_at === "string" ? linha.archived_at : null,
    provider: typeof linha.provider === "string" ? linha.provider : "",
    metadata: desligado ? linha.metadata : null,
  };
}

/**
 * A CHECAGEM DE CAPACIDADE do canal, antes de qualquer envio.
 *
 * Mesma régua do aviso de caso: arquivado, pausado, desligado e canal que não
 * aceita mensagem livre (template-only) não podem receber este texto. Um envio
 * que passasse por aqui desligaria o número da empresa ou cairia na fila de
 * revisão do provedor.
 *
 * O import de capacidades é TARDIO, pelo mesmo motivo do aviso de caso: o
 * catálogo de capacidades puxa o inventário de provedores, e arrastá-lo para
 * o topo de quem só REGISTRA a ação derrubaria o bundle de quem nunca envia.
 */
async function motivoDeBloqueioDoCanal(canal: CanalDaEquipe): Promise<string | null> {
  if (canal.archived_at !== null) return "canal_arquivado";
  if (canal.status !== "WORKING") return "canal_pausado";
  if (canal.metadata !== null) return "canal_desligado";
  if (canal.provider === "") return "canal_sem_provedor";
  const { capabilitiesOf } = await import("@/lib/channels/capabilities");
  if (!capabilitiesOf(canal.provider as never).freeformOutsideWindow) return "canal_nao_aceita_texto_livre";
  return null;
}

/** Escapa para o HTML do e-mail: o resumo traz fala do MODELO, não é nosso. */
function emHtml(texto: string): string {
  const escapado = texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapado}</pre>`;
}

function resumoVazio(motivo: string): ActionResultDetail {
  return { type: TIPO, status: "skipped", detail: { reason: motivo } };
}

/** WhatsApp: número do ADMIN → capacidade do canal → transporte direto. */
async function enviaPorWhatsApp(
  ctx: ActionCtx,
  resumo: string,
): Promise<ActionResultDetail> {
  const numero = await numeroDaEquipe(ctx.admin, ctx.organizationId);
  if (numero === null) {
    // Nada de "número colado na ação": o que falta é a configuração do ADMIN.
    return { type: TIPO, status: "skipped", detail: { reason: "sem_numero_de_aviso_cadastrado" } };
  }
  const canal = await canalDaEquipe(ctx.admin, ctx.organizationId, numero.channel_session_id);
  if (canal === null) {
    return { type: TIPO, status: "skipped", detail: { reason: "canal_da_equipe_nao_encontrado" } };
  }
  const bloqueio = await motivoDeBloqueioDoCanal(canal);
  if (bloqueio !== null) {
    return { type: TIPO, status: "skipped", detail: { reason: bloqueio } };
  }

  const { criarTransporteDoAviso } = await import("@/lib/escalacao/aviso-ao-suporte.handler");
  const transporte = await criarTransporteDoAviso(ctx.admin as never);
  if (!(await transporte.configurado(ctx.organizationId, canal as never))) {
    return { type: TIPO, status: "skipped", detail: { reason: "canal_sem_chave" } };
  }
  const destino = await transporte.resolveDestino(ctx.organizationId, canal as never, numero.telefone_destino);
  if (destino === null) {
    return { type: TIPO, status: "failed", detail: { reason: "telefone_da_equipe_invalido" } };
  }

  const agora = new Date();
  // Mesma forma de `aviso-ao-suporte` e `aviso-no-whatsapp`: o contrato do
  // transporte é `{ externalId }` — NÃO existe `ok`. Falha é EXCEÇÃO; sucesso é
  // não lançar (`externalId: null` = canal noop/resposta sem id reconhecível, e
  // o aviso de caso também o trata como entregue).
  try {
    await transporte.envia(ctx.organizationId, canal as never, destino, resumo);
  } catch (err) {
    return {
      type: TIPO,
      status: "failed",
      detail: { reason: "whatsapp_falhou", error: String(err instanceof Error ? err.message : err) },
    };
  }

  // Mesma disciplina do aviso de caso: o envio entra no ledger, que é quem
  // cobra o teto diário e o espaçamento da próxima rodada.
  const { criarPacingDoCanal } = await import("@/lib/agent-engine/pacing/ledger-supabase");
  await (await criarPacingDoCanal(ctx.admin)).registraEnvio(ctx.organizationId, canal.id, agora);

  return { type: TIPO, status: "success", detail: { reason: "whatsapp_enviado", canal: "whatsapp" } };
}

/** E-mail: o endereço JÁ CADASTRADO da pessoa, o SMTP que o admin registrou. */
async function enviaPorEmail(
  ctx: ActionCtx,
  membro: { user_id: string },
  assunto: string,
  resumo: string,
): Promise<ActionResultDetail> {
  const { data } = await ctx.admin.auth.admin.getUserById(membro.user_id);
  const email = data?.user?.email ?? null;
  if (typeof email !== "string" || !email.includes("@")) {
    return { type: TIPO, status: "skipped", detail: { reason: "membro_sem_email" } };
  }

  const { emailConfigurado, sendEmail } = await import("@/lib/email/roteador");
  if (!emailConfigurado()) {
    return { type: TIPO, status: "skipped", detail: { reason: "smtp_nao_configurado" } };
  }
  const { marcaDaSaida } = await import("@/lib/branding/saida");
  const marca = await marcaDaSaida(ctx.organizationId);
  const envio = await sendEmail({
    to: email,
    subject: assunto,
    html: emHtml(resumo),
    text: resumo,
    fromName: marca.nome,
    tags: [{ name: "tipo", value: "automacao" }],
  });
  if (!envio.ok) {
    return {
      type: TIPO,
      status: "failed",
      detail: { reason: "email_falhou", error: envio.error ?? "desconhecido" },
    };
  }
  return { type: TIPO, status: "success", detail: { reason: "email_enviado", canal: "email" } };
}

/**
 * O resumo sai quando o WhatsApp da EQUIPE pode enviar AGORA.
 *
 * `postponeUntil` é o mecanismo esperado (mesmo de `send_whatsapp_message`):
 * a régua do canal atrasa o EVENTO INTEIRO — e não só esta ação —, porque uma
 * regra que disparou não pode deixar a outra ação meia-executada.
 */
async function decideEspera(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  if (canalDe(config) !== "whatsapp") return null;
  const numero = await numeroDaEquipe(ctx.admin, ctx.organizationId);
  if (numero === null) return null;
  const canal = await canalDaEquipe(ctx.admin, ctx.organizationId, numero.channel_session_id);
  if (canal === null || (await motivoDeBloqueioDoCanal(canal)) !== null) return null;
  const { criarPacingDoCanal } = await import("@/lib/agent-engine/pacing/ledger-supabase");
  const pacing = await criarPacingDoCanal(ctx.admin);
  const decisao = await pacing.decide(ctx.organizationId, canal.id, new Date());
  if (decisao.liberado) return null;
  return decisao.liberaEm.toISOString();
}

/** `canal` só aceita os dois valores que a UI oferece; qualquer outra coisa é WhatsApp. */
function canalDe(config: Record<string, unknown> | ConfigNotifyTeam): "whatsapp" | "email" {
  const bruto = (config as ConfigNotifyTeam).canal;
  return bruto === "email" ? "email" : "whatsapp";
}

export async function executeNotifyTeam(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<ActionResultDetail> {
  const cfg = config as ConfigNotifyTeam;
  const membroId = typeof cfg.membro_id === "string" ? cfg.membro_id : "";
  if (membroId === "") {
    return { type: TIPO, status: "failed", error: "missing_config", detail: { reason: "sem_membro" } };
  }

  const membro = await membroAtivo(ctx.admin, ctx.organizationId, membroId);
  if (membro === null) {
    return { type: TIPO, status: "failed", detail: { reason: "membro_invalido" } };
  }

  const lead = estreitarLead(ctx.context.lead);
  if (lead === null) return resumoVazio("sem_negocio_no_evento");

  const idioma = await idiomaDaOrganizacao(ctx.admin, ctx.organizationId);
  const resumo = montarResumoParaAEquipe({
    idioma,
    regra: ctx.ruleName,
    lead,
    contato: estreitarContato(ctx.context.contact),
    pontuacao: await pontuacaoDoLead(ctx.admin, ctx.organizationId, lead.id),
    passagem:
      lead.contact_id !== null && lead.contact_id !== ""
        ? await passagemDoContato(ctx.admin, ctx.organizationId, lead.contact_id)
        : null,
  });
  // O PISO existe porque uma linha `Pontuação: ` vazia AFIRMARIA pontuação
  // nenhuma. Sem lead não há o que a equipe ler.
  if (resumo.trim() === "") return resumoVazio("sem_resumo_para_enviar");

  const titulo = typeof lead.title === "string" && lead.title.trim() !== "" ? lead.title.trim() : null;
  const assunto = titulo === null ? "Resumo do lead para a equipe" : `Resumo do lead para a equipe — ${titulo}`;

  if (canalDe(config) === "email") return enviaPorEmail(ctx, membro, assunto, resumo);
  return enviaPorWhatsApp(ctx, resumo);
}

/**
 * Uma entrega por disparo, e o texto NUNCA sai pela conversa do lead.
 *
 * A disciplina do `envio_por_evento` não está exposta aqui: ela vive no canal
 * (`pacing_ledger`), e o `registraEnvio` do caminho de WhatsApp é quem a
 * alimenta. O que segura o disparo quando o canal não está livre é o
 * `postponeUntil` acima, que atrasa o EVENTO INTEIRO — é a mesma alavanca do
 * `send_whatsapp_message`, e reescrevê-la aqui faria a ação nova nascer sem o
 * conserto que a irmã acabou de receber.
 */
const executor: ActionExecutor = {
  type: TIPO,
  postponeUntil: decideEspera,
  execute: executeNotifyTeam,
};

registerAction(executor);
