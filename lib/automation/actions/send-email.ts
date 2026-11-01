/**
 * Ação `send_email` (#2726) — o e-mail como SAÍDA das regras.
 *
 * ═══ O que esta ação NÃO faz ═══
 *
 * Ela não escolhe transporte, não abre conexão e não conhece credencial: quem
 * entrega é `lib/email/roteador.ts` (SMTP configurado → SMTP; sem SMTP →
 * Resend), o MESMO caminho de um convite ou de um alarme de LGPD. Escrever um
 * segundo transporte aqui seria o defeito que o roteador existe para matar
 * (ver o cabeçalho dele: trocar oito `import` por um não é somar).
 *
 * ═══ O que ela faz ═══
 *
 *   1. resolve PARA QUEM (contato do negócio, responsável do negócio, uma
 *      PESSOA DA EQUIPE ou um endereço fixo escrito na tela);
 *   2. renderiza assunto e corpo com as MESMAS variáveis do WhatsApp
 *      (`{{nome}}`, `{{primeiro_nome}}`, `{{lead.*}}` e os campos do funil
 *      como `{{destino}}`) — `renderTemplate` é o mesmo de sempre —, mais a
 *      variável `{{resumo}}`, que é desta ação: o resumo automático do negócio
 *      (cliente, telefone, valor, pontuação e o atalho para o negócio —
 *      nenhum texto livre da conversa, doc 176 A), montado no disparo pelo
 *      MESMO carregador do `notify_team`;
 *   3. entrega o pedido pronto e registra o desfecho honesto: sucesso só com
 *      o resultado do provedor na mão, recusa de configuração/destinatário
 *      como `skipped`, e falha do transporte como `failed` com o CÓDIGO no
 *      `error` (é o que a aba Atividade traduz, ver `MOTIVO_DA_PARADA`) e a
 *      mensagem crua do provedor no `detail.error`, como detalhe técnico.
 *
 * ═══ O destinatário "membro da equipe" (#2642) ═══
 *
 * O recorte do mantenedor no PR #2834 tirou o e-mail do `notify_team` e o
 * trouxe para cá: uma ação, um caminho de e-mail. O que ele acrescenta é um
 * destinatário que é uma PESSOA (`user_organizations.user_id`), com o endereço
 * lido do GoTrue — nunca digitado na regra.
 *
 * O VÍNCULO é conferido NO MOMENTO DO ENVIO, e não no save: a regra é salva
 * uma vez e dispara para sempre, então uma pessoa removida da organização
 * continuaria recebendo se a checagem morasse na tela. Era o defeito do #2794;
 * aqui a consulta a `user_organizations` (`revoked_at is null`) vem ANTES do
 * endereço, e a recusa é `skipped` com o motivo — não um envio para fora.
 * Consulta que não voltou não é "não é membro": é `membro_indeterminado`.
 *
 * ═══ Por que as recusas são `skipped` e as do transporte são `failed` ═══
 *
 * A mesma régua de `create-task.ts`: sem e-mail no contato ou opt-out
 * registrado é uma recusa que REENVIAR não conserta (o reenvio bate no mesmo
 * contato); recusa de CONFIGURAÇÃO como `failed` ensinaria quem opera a
 * tentar de novo sem mudar nada. Já o provedor caindo no meio do caminho é
 * infraestrutura — `failed` diz que tentou e não deu, que é o que a pessoa
 * precisa para olhar Admin › E-mail.
 *
 * O consentimento segue o gate FIXO de `guarda-do-contato.ts` (lê
 * `declined_at`, não a ausência de `granted_at` — ver o cabeçalho daquele
 * arquivo): sem isso, TODO contato que nunca perguntado não receberia nada.
 *
 * ═══ DE QUEM o e-mail sai (#3287, fatia 1) ═══
 *
 * O remetente é da ORG quando ela configurou nome de exibição e/ou "responder
 * para" (`lib/email/remetente-da-organizacao.ts`), e da PLATAFORMA quando não.
 * O ENDEREÇO do `From` NUNCA vem daqui: trocar o transporte é a fatia 2 desta
 * mesma issue (o SMTP próprio da organização), e o e-mail de SISTEMA — convite,
 * recuperação de senha, LGPD — segue intocado, com o remetente da plataforma.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { carregarResumoParaAEquipe } from "@/lib/automation/resumo-do-evento";
import { renderTemplate } from "@/lib/automation/template";
import {
  remetenteDaOrganizacaoDeSettings,
  SEM_REMETENTE_DA_ORGANIZACAO,
  type RemetenteDaOrganizacao,
} from "@/lib/email/remetente-da-organizacao";
import { sendEmail, type EmailDeliveryError } from "@/lib/email/roteador";
import { logger } from "@/lib/logger";
import { checkRateLimit, peekRateLimit } from "@/lib/ai/dispatcher/rate-limit";

/**
 * Teto de e-mails de automação por organização, por janela. O remetente é da
 * INSTALAÇÃO (compartilhado entre empresas), então uma regra desgovernada de
 * uma empresa queimaria a reputação de envio de todas.
 *
 * Duas operações, como em `rate-limit.ts` (#64): `postponeUntil` só CONSULTA
 * (o motor roda a pré-checagem de todas as ações a cada nova tentativa do
 * evento, e um adiamento por OUTRA ação não pode gastar o orçamento), e o
 * `execute` só CONTA quando há tentativa real de envio — recusa (bloqueado,
 * sem e-mail, opt-out) não consome.
 *
 * A consulta do `postponeUntil` sozinha NÃO segura o teto: eventos
 * processados em paralelo passam todos pela consulta antes de qualquer um
 * contar. Quem segura é o retorno do `checkRateLimit` no `execute` — o
 * incremento é atômico (INCR no Redis), então só os primeiros 200 da janela
 * saem; o resto vira `skipped` com `email_limite_atingido`.
 *
 * ponytail: constante, não env — vira knob quando alguém pedir.
 */
export const LIMITE_DE_EMAILS_POR_JANELA = 200;
export const JANELA_DO_LIMITE_SEG = 3600;

const baldeDaOrg = (ctx: ActionCtx) => `automacao-email:${ctx.organizationId}`;

async function postponeUntil(ctx: ActionCtx): Promise<string | null> {
  const enviados = await peekRateLimit(baldeDaOrg(ctx), JANELA_DO_LIMITE_SEG);
  if (enviados < LIMITE_DE_EMAILS_POR_JANELA) return null;
  const janelaMs = JANELA_DO_LIMITE_SEG * 1000;
  return new Date((Math.floor(Date.now() / janelaMs) + 1) * janelaMs).toISOString();
}

/** Quem recebe: o contato, o responsável do negócio, uma pessoa da equipe ou um endereço gravado na regra. */
type Destinatario = "contato" | "dono_do_lead" | "membro_da_equipe" | "fixo";

/**
 * Endereço com cara de endereço. NÃO é validação de entregabilidade — é o
 * piso: `to: "sem arroba"` não é um endereço a tentar, é configuração torta
 * que o provedor devolveria como erro genérico três segundos depois.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailValido(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return EMAIL.test(limpo) ? limpo : null;
}

interface ContatoDoContexto {
  id: string;
  is_blocked?: boolean;
  email?: string | null;
  consent?: { marketing?: { declined_at?: string | null } | null } | null;
}

/** O veredito do destinatário — o `motivo` é o que vira `detail.reason`. */
type DestinatarioResolvido = { ok: true; endereco: string } | { ok: false; motivo: string };

/**
 * PARA QUEM este envio sai, com as recusas na frente.
 *
 * A ordem importa: bloqueio e opt-out vêm ANTES do endereço, porque dizer
 * "sem e-mail" para um contato que pediu para não receber ensinaria quem lê
 * a caçar um cadastro que não é o problema.
 */
async function resolverDestinatario(
  ctx: ActionCtx,
  destinatario: Destinatario,
  fixo: string,
  membroId: string,
): Promise<DestinatarioResolvido> {
  if (destinatario === "fixo") return { ok: true, endereco: fixo };

  if (destinatario === "membro_da_equipe") {
    if (membroId === "") return { ok: false, motivo: "sem_membro" };
    // O VÍNCULO, conferido AGORA (#2794). A regra é salva uma vez e dispara
    // para sempre; revogar a pessoa não reescreve a regra, então a checagem
    // tem de ser no envio. Mesmo filtro de `assign-owner.ts` e do extinto
    // caminho de e-mail do `notify_team`: só membro ativo DESTA organização.
    const { data: membro, error: erroDaConsulta } = await ctx.admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", ctx.organizationId)
      .eq("user_id", membroId)
      .is("revoked_at", null)
      .maybeSingle();
    // Consulta que não voltou não é "não é membro": não envia, e diz que foi a
    // consulta (frase de `membro_indeterminado`), não a configuração.
    if (erroDaConsulta) return { ok: false, motivo: "membro_indeterminado" };
    if (!membro) return { ok: false, motivo: "membro_fora_da_equipe" };
    try {
      const { data } = await ctx.admin.auth.admin.getUserById(membroId);
      const email = emailValido(data?.user?.email);
      return email ? { ok: true, endereco: email } : { ok: false, motivo: "membro_sem_email" };
    } catch {
      // Mesma tolerância do caminho do dono: o acesso da pessoa nunca derruba o
      // envio inteiro — aqui ele só não tem endereço para mandar.
      return { ok: false, motivo: "membro_sem_email" };
    }
  }

  if (destinatario === "dono_do_lead") {
    const lead = ctx.context.lead as { owner_user_id?: string | null } | undefined;
    const ownerId = typeof lead?.owner_user_id === "string" ? lead.owner_user_id : null;
    if (!ownerId) return { ok: false, motivo: "dono_sem_email" };
    // Só quem ainda é da equipe recebe: revogar um membro não limpa
    // `crm_leads.owner_user_id`, então o responsável gravado pode ser um
    // ex-membro. Mesma régua de `assign-owner.ts` e das funções de agenda.
    const { data: membro, error: erroDaConsulta } = await ctx.admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", ctx.organizationId)
      .eq("user_id", ownerId)
      .is("revoked_at", null)
      .maybeSingle();
    // Consulta que não voltou não é "não é membro": não envia, e diz que foi a
    // consulta (frase de `membro_indeterminado`), não a configuração.
    if (erroDaConsulta) return { ok: false, motivo: "membro_indeterminado" };
    if (!membro) return { ok: false, motivo: "dono_fora_da_equipe" };
    try {
      const { data } = await ctx.admin.auth.admin.getUserById(ownerId);
      const email = emailValido(data?.user?.email);
      return email ? { ok: true, endereco: email } : { ok: false, motivo: "dono_sem_email" };
    } catch {
      // Mesma tolerância de `call-webhook.ts`: o apelido/contato do dono nunca
      // derruba o envio inteiro — aqui ele só não tem endereço para mandar.
      return { ok: false, motivo: "dono_sem_email" };
    }
  }

  const contact = ctx.context.contact as ContatoDoContexto | undefined;
  if (!contact) return { ok: false, motivo: "no_contact" };
  if (contact.is_blocked) return { ok: false, motivo: "contact_blocked" };
  // Recusa registrada — não "grant ausente". Ver `guarda-do-contato.ts`.
  if (contact.consent?.marketing?.declined_at) return { ok: false, motivo: "consent_declined" };
  const email = emailValido(contact.email);
  return email ? { ok: true, endereco: email } : { ok: false, motivo: "no_email" };
}

/**
 * O CÓDIGO da falha que vai para a tela, um por vocabulário do provedor.
 *
 * Não é tradução: é o mapa que `MOTIVO_DA_PARADA` (aba Atividade) usa para
 * dar a frase. `not_configured` e `sender_rejected` mandam para lugares
 * diferentes (uma chave em branco, um remetente rejeitado), e achatar os dois
 * em "falhou" é o defeito que o roteador já pagou uma vez.
 */
function codigoDaFalha(erro: EmailDeliveryError | undefined): string {
  switch (erro) {
    case "not_configured":
      return "email_nao_configurado";
    case "rate_limited":
      return "email_limite_atingido";
    case "sender_rejected":
      return "remetente_recusado";
    case "dominio_nao_verificado":
      return "dominio_nao_verificado";
    default:
      return "email_recusado";
  }
}

/** Códigos de falha já registrados neste processo — sem isto, um banco fora do ar enche o log. */
const avisosDeRemetenteRegistrados = new Set<string>();

/**
 * O REMETENTE com que este e-mail sai (#3287, fatia 1).
 *
 * Lê `organizations.settings` — a MESMA linha onde a marca da organização já
 * vive — e devolve o nome de exibição e o "responder para" que ela configurou,
 * quando configurou. Sem configuração, ou com a leitura falhando, devolve o
 * vazio: o envio sai exatamente como sempre saiu.
 *
 * `ctx.admin` e não um cliente novo: a ação já recebe este client para as
 * outras leituras (vínculo de equipe, resumo), e uma segunda conexão aqui
 * esconderia de quem testa que este caminho também vai ao banco.
 */
async function remetenteDaAutomacao(ctx: ActionCtx): Promise<RemetenteDaOrganizacao> {
  const { data, error } = await ctx.admin
    .from("organizations")
    .select("settings")
    .eq("id", ctx.organizationId)
    .maybeSingle();
  if (error) {
    // Recusa que NÃO derruba o envio: o e-mail sai como sempre saiu, e o motivo
    // fica no log — mesma disciplina de `lib/branding/saida.ts`, onde a leitura
    // da marca degrada em vez de trocar um problema de estética por um e-mail
    // que não sai. Um aviso por código evita encher o log a cada disparo.
    if (!avisosDeRemetenteRegistrados.has(error.code ?? "?")) {
      avisosDeRemetenteRegistrados.add(error.code ?? "?");
      logger.warn("remetente da automação: não deu para ler a organização; vale o remetente da plataforma", {
        codigo: error.code,
        detalhe: error.message,
      });
    }
    return SEM_REMETENTE_DA_ORGANIZACAO;
  }
  return remetenteDaOrganizacaoDeSettings((data as { settings?: unknown } | null)?.settings ?? null);
}

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * O corpo nos DOIS formatos que a tela oferece.
 *
 * Em `texto`, o `<` digitado pelo operador é dado de quem escreve, não HTML —
 * escapar é o que impede `a < b` de virar tag quebrada no cliente de e-mail.
 * Em `html`, a marcação do OPERADOR entra como está (é a promessa do
 * formato), mas os valores interpolados já chegam escapados: o nome do
 * contato é texto, não marcação. A versão `text` tira as tags: cliente sem
 * HTML e leitor de tela comem a mesma frase.
 */
function corpoParaHtml(corpo: string, formato: string): string {
  if (formato === "html") return corpo;
  return escaparHtml(corpo).replace(/\n/g, "<br />\n");
}

function corpoParaTexto(corpo: string, formato: string): string {
  if (formato === "texto") return corpo;
  return corpo.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * O contexto das variáveis do envio: o do evento, mais `{{resumo}}`.
 *
 * ─── Por que só quando o modelo USA a variável ─────────────────────────────
 *
 * Montar o resumo custa duas consultas (`organizations`, `crm_lead_scores`).
 * Fazer isso em TODO e-mail de automação seria pagar esse
 * preço por um texto que a maioria dos modelos não usa — e a ação já tem o teto
 * de envios como parte mais cara. O gatilho é o próprio modelo, e o teste de
 * `{{resumo}}` cobre os dois lados (usa → resolvido; não usa → nenhuma leitura).
 *
 * Evento sem negócio devolve o contexto intacto: a marcação fica vazia, que é a
 * verdade disponível (o mesmo critério de `resumo-para-a-equipe.ts` para linha
 * sem conteúdo).
 */
async function contextoDoEnvio(
  ctx: ActionCtx,
  assunto: string,
  corpo: string,
): Promise<Record<string, unknown>> {
  const usaResumo =
    /\{\{\s*resumo\s*\}\}/.test(assunto) || /\{\{\s*resumo\s*\}\}/.test(corpo);
  if (!usaResumo) return ctx.context;

  const resumo = await carregarResumoParaAEquipe({
    admin: ctx.admin,
    organizationId: ctx.organizationId,
    regra: ctx.ruleName,
    contexto: ctx.context,
  });
  return resumo === null ? ctx.context : { ...ctx.context, resumo };
}

async function execute(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<ActionResultDetail> {
  const bruto = config.destinatario;
  const destinatario: Destinatario | null =
    bruto === "contato" ||
    bruto === "dono_do_lead" ||
    bruto === "membro_da_equipe" ||
    bruto === "fixo"
      ? bruto
      : null;
  const assunto = typeof config.assunto === "string" ? config.assunto.trim() : "";
  const corpo = typeof config.corpo === "string" ? config.corpo.trim() : "";
  const formato = config.formato === "html" ? "html" : "texto";
  const fixo = typeof config.email_fixo === "string" ? config.email_fixo.trim() : "";
  const membroId = typeof config.membro_id === "string" ? config.membro_id.trim() : "";

  // Mesma recusa de `send-whatsapp.ts`: sem o essencial a regra não roda, e
  // dizer "failed silencioso" aqui deixaria quem opera procurando o transporte.
  const semDestino =
    !destinatario ||
    !assunto ||
    !corpo ||
    (destinatario === "fixo" && !fixo) ||
    (destinatario === "membro_da_equipe" && !membroId);
  if (semDestino) {
    return { type: "send_email", status: "failed", error: "missing_config" };
  }

  const para = await resolverDestinatario(ctx, destinatario, fixo, membroId);
  if (!para.ok) {
    return { type: "send_email", status: "skipped", detail: { reason: para.motivo } };
  }

  const contexto = await contextoDoEnvio(ctx, assunto, corpo);
  const assuntoPronto = renderTemplate(assunto, contexto);
  const corpoPronto = renderTemplate(corpo, contexto);
  // No HTML, cada valor de fora (contato, negócio) entra como texto.
  const corpoHtml = formato === "html" ? renderTemplate(corpo, contexto, escaparHtml) : corpoPronto;

  // A consulta do `postponeUntil` é só o atalho; quem decide é esta contagem.
  // `skipped`, não `postponed`: o motor não reexecuta um evento por resultado
  // de `execute`, então "adiado" aqui diria que o e-mail ainda vai sair.
  const teto = await checkRateLimit(baldeDaOrg(ctx), LIMITE_DE_EMAILS_POR_JANELA, JANELA_DO_LIMITE_SEG);
  if (!teto.allowed) {
    return { type: "send_email", status: "skipped", detail: { reason: "email_limite_atingido", destinatario } };
  }
  // Depois do teto, de propósito: recusa por limite não paga a leitura do
  // `settings` da organização. Quem não vai enviar não precisa saber o remetente.
  const remetente = await remetenteDaAutomacao(ctx);
  const resultado = await sendEmail({
    to: para.endereco,
    subject: assuntoPronto,
    html: corpoParaHtml(corpoHtml, formato),
    text: corpoParaTexto(corpoPronto, formato),
    // O remetente da ORGANIZAÇÃO (#3287, fatia 1): quando ela configurou um
    // nome de exibição e/ou um "responder para", o e-mail da automação sai com
    // eles. O ENDEREÇO do `From` continua sendo o da PLATAFORMA — quem entrega
    // não muda nesta fatia (o SMTP próprio é a fatia 2). Sem configuração, as
    // duas chaves ficam AUSENTES e o envio sai byte a byte como sempre saiu:
    // `fromName: undefined` não é o mesmo que a chave ausente para quem monta o
    // cabeçalho (o SMTP da plataforma usa o `fromName` DELE quando ninguém
    // passa um).
    ...(remetente.fromName ? { fromName: remetente.fromName } : {}),
    ...(remetente.replyTo ? { replyTo: remetente.replyTo } : {}),
    // Mesma tag da cobrança, com o valor que diz de ONDE veio: no painel da
    // Resend dá para separar o envio de automação do convite de equipe.
    tags: [{ name: "origem", value: "automacao" }],
  });

  const base = { destinatario, via: resultado.via ?? null };
  if (!resultado.ok) {
    return {
      type: "send_email",
      status: "failed",
      error: codigoDaFalha(resultado.error),
      // A frase do provedor é detalhe TÉCNICO (aba Atividade mostra em corpo
      // menor): ela é em inglês e vem do provedor, não é o que quem opera lê
      // primeiro — por isso mora aqui e não no `error`.
      detail: { ...base, error: resultado.details ?? null },
    };
  }
  return {
    type: "send_email",
    status: "success",
    detail: { ...base, email_id: resultado.id ?? null },
  };
}

registerAction({ type: "send_email", postponeUntil, execute });
