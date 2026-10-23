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
 * ─── O destinatário é o NÚMERO DA EQUIPE, e não muda ───────────────────────
 *
 * O recorte do mantenedor no PR #2834 deixou esta ação com UM caminho: o
 * WhatsApp para o número que o ADMIN cadastrou em `config_aviso_de_caso` (a
 * tela de Avisos, a mesma escrita server-side da disciplina da #1347). NÃO
 * existe campo de número nem de endereço na regra — colar destino aqui seria
 * a porta de spam que aquela disciplina fechou —, e por isso o editor também
 * não pergunta mais "quem recebe": o destino é o da empresa.
 *
 * O e-mail para uma PESSOA da equipe não mora mais aqui: ele é o destinatário
 * "membro da equipe" do `send_email` (#2726), com o teto de envios por
 * organização valendo e com a variável `{{resumo}}`. Uma ação, um caminho.
 *
 * Como a ação não escolhe destinatário, não há portão de papel: o gerente
 * configura esta ação como configura as outras (o portão só-admin que existia
 * na rota e no editor saiu junto com o recorte).
 *
 * ─── NÃO abre conversa com o lead ──────────────────────────────────────────
 *
 * O WhatsApp sai pelo MESMO transporte direto do aviso de caso
 * (`criarTransporteDoAviso`): fora do `sendMessageHandler`, sem linha em
 * `messages`, sem conversa nova, sem timeline de ninguém. A ingestão tem um
 * corte (`numero-interno-de-aviso`) que descarta o que vem do número interno
 * justamente para um aviso não virar conversa — e este aviso respeita o mesmo
 * corte. O trigger desta ação é a virada para ganho; o que a conversa
 * combinou fica no registro do lead e não vai na mensagem, que leva o atalho
 * para o negócio (doc 176, A).
 *
 * ─── O resumo é LIDO AGORA, nunca gravado ──────────────────────────────────
 *
 * Nada de texto fixo gravado na regra: `carregarResumoParaAEquipe`
 * (`resumo-do-evento.ts`) lê o lead, o contato e a pontuação numérica no
 * MOMENTO do disparo, e
 * `montarResumoParaAEquipe` escreve o texto. É o MESMO carregador que alimenta
 * a variável `{{resumo}}` do `send_email` — uma régua de limpeza só.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { carregarResumoParaAEquipe, leadDoContexto } from "../resumo-do-evento";
import type { ActionCtx, ActionExecutor, ActionResultDetail } from "../types";
import { registerAction } from "@/lib/automation/actions";

const TIPO = "notify_team";

/**
 * A configuração da ação — e ela não escolhe DESTINO nem PESSOA.
 *
 * O recorte do mantenedor no PR #2834 deixou um caminho só: o WhatsApp do
 * número que o ADMIN cadastrou em Avisos. `canal` continua existindo como
 * `z.literal("whatsapp")` no schema para que a regra gravada diga, por
 * escrito, por onde o aviso sai — e para que uma regra que ainda traga
 * `"email"` morra na porta em vez de sair por um canal que ninguém configurou.
 */
interface ConfigNotifyTeam {
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

/**
 * O resumo sai quando o WhatsApp da EQUIPE pode enviar AGORA.
 *
 * `postponeUntil` é o mecanismo esperado (mesmo de `send_whatsapp_message`):
 * a régua do canal atrasa o EVENTO INTEIRO — e não só esta ação —, porque uma
 * regra que disparou não pode deixar a outra ação meia-executada.
 */
async function decideEspera(ctx: ActionCtx): Promise<string | null> {
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

/**
 * `canal` só aceita `whatsapp`; qualquer outra coisa é configuração torta.
 *
 * O schema já recusa `email` na porta, e esta checagem é a defesa em
 * profundidade do executor: uma regra que chegue aqui com outro canal (gravada
 * antes do recorte, ou por uma escrita direta no banco) não pode sair pelo
 * WhatsApp fingindo que o canal pedido foi respeitado.
 */
function canalDesconhecido(config: Record<string, unknown>): boolean {
  const bruto = (config as ConfigNotifyTeam).canal;
  return bruto !== undefined && bruto !== "whatsapp";
}

export async function executeNotifyTeam(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<ActionResultDetail> {
  if (canalDesconhecido(config)) {
    return { type: TIPO, status: "failed", detail: { reason: "canal_nao_suportado" } };
  }

  const lead = leadDoContexto(ctx.context.lead);
  if (lead === null) return resumoVazio("sem_negocio_no_evento");

  const resumo = await carregarResumoParaAEquipe({
    admin: ctx.admin,
    organizationId: ctx.organizationId,
    regra: ctx.ruleName,
    contexto: ctx.context,
  });
  // O PISO existe porque uma linha `Pontuação: ` vazia AFIRMARIA pontuação
  // nenhuma. Sem lead não há o que a equipe ler.
  if (resumo === null || resumo.trim() === "") return resumoVazio("sem_resumo_para_enviar");

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
