/**
 * O motor que anda a cadência — chamado pelo cron `cadencia-worker`, minuto a
 * minuto (mesma cadência do `campaign-worker`). Separado da rota HTTP para o
 * teste exercitar a REGRA sem montar request/auth, mesmo padrão de
 * `recover-stuck-messages`.
 *
 * ═══ O que este worker SABE fazer hoje ═══
 *  - `email`: renderiza variáveis do lead, embute pixel de abertura e link de
 *    descadastro, envia pelo transporte único da instalação (`lib/email/roteador`).
 *  - `espera`: avança `dias úteis` preservando a hora.
 *  - `ramo`: só a condição `abriu` é real (lê `aberturas`/`ultimo_email_em`).
 *    `clicou`/`respondeu` NÃO têm fonte de dado ainda (exigiriam reescrever
 *    links e um webhook de resposta) — o ramo aguarda o prazo (`dentroDeDias`)
 *    e cai em "não", nunca em "sim": é a resposta honesta de quem não tem o
 *    sinal, não uma mentira otimista.
 *  - `tarefa`: cria em `crm_tasks` e registra na timeline do negócio.
 *  - `whatsapp`: AINDA NÃO ENVIA. Mandar mensagem fora do pipeline de
 *    anti-banimento (throttle, janela, STOP) seria arriscar a conexão do
 *    cliente — decisão deliberada de não improvisar isso aqui. A inscrição
 *    PARA com `motivo_parada='falha'`, visível na aba Atividade, em vez de
 *    pular o passo em silêncio.
 *
 * `configuracao.paradas.ganhoOuPerdido` é a única parada automática hoje
 * (lê `crm_leads.status`). `respondeu`/`bounce` exigem infra que não existe
 * (webhook de resposta / de bounce do provedor) — mesmo motivo do ramo acima.
 *
 * ═══ Teto diário de envio (migration 0431) ═══
 * O transporte de e-mail é ÚNICO por instalação (`lib/email/roteador.ts`) —
 * a MESMA caixa/conta leva o volume de TODAS as organizações do clone, e
 * provedor de e-mail trava/bane quem manda volume alto de uma vez. Antes de
 * CADA envio o worker checa `CADENCIA_LIMITE_EMAILS_POR_DIA` (padrão 60,
 * `lib/env.ts`) por `checkRateLimit` (Upstash Redis, janela fixa de 24h —
 * o mesmo mecanismo do resto do produto, nenhuma tabela nova). Passado o
 * teto, a inscrição NÃO falha nem soma `tentativas` (não é erro do lead nem
 * da cadência) — só é adiada, reconferida em 1h, com um evento
 * `limite_diario_atingido` na timeline pra quem opera ver O PORQUÊ do atraso
 * em vez de achar que o envio travou sem motivo.
 */
import { contatoRestringido } from "./guarda-do-contato";
import { audit } from "@/lib/audit";
import { dentroDaJanela } from "./janela";
import { avancarDiasUteis } from "./dias-uteis";
import { passoParaExecutar, primeiroDoLado, proximoIrmao } from "./proximo-passo";
import { renderizarComLead } from "./renderizar";
import { signCadenciaLink } from "./token";
import type { Cadencia, Passo } from "./tipos";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { sendEmail } from "@/lib/email/roteador";
import { env } from "@/lib/env";
import { cadenciasLigadas } from "@/lib/cadencias/modulo";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;


/**
 * Bucket ÚNICO (sem sufixo de organização) — de propósito: é a MESMA caixa de
 * e-mail que leva o volume de toda a instalação, então o teto tem que ser
 * medido no agregado, não por organização.
 */
const BUCKET_TETO_DIARIO_DE_EMAIL = "cadencia-email-diario";
const JANELA_DO_TETO_DIARIO_SEG = 24 * 60 * 60;
/** Quantos minutos até reconferir depois que o teto bateu — não martela a cada minuto, nem faz o lead esperar até amanhã sem checar de novo. */
const MINUTOS_DE_ESPERA_POR_TETO = 60;

export interface InscricaoRow {
  id: string;
  organization_id: string;
  cadence_id: string;
  lead_id: string;
  contact_id: string;
  passo_atual_id: string | null;
  ultimo_email_em: string | null;
  ultimo_email_passo_id: string | null;
  aberturas: number;
  aberturas_ultimo_email?: number;
  emails_enviados: number;
  tentativas: number;
  inscrito_por: string | null;
  rastreio_consentido?: boolean;
  envio_pendente_passo_id?: string | null;
  processamento_id?: string | null;
}

export interface ResultadoDoTick {
  processadas: number;
  emailsEnviados: number;
  concluidas: number;
  paradas: number;
  falhas: number;
}

async function carregarCadencia(admin: Admin, cadenceId: string, orgId: string) {
  const { data } = await admin
    .from("email_cadences")
    .select("id, status, passos, configuracao")
    .eq("id", cadenceId)
    .eq("organization_id", orgId)
    .maybeSingle();
  return data as { id: string; status: string; passos: Passo[]; configuracao: Cadencia["configuracao"] } | null;
}

/** `Re: <assunto>` — anda pra trás na árvore só até achar um assunto não vazio. Não é threading de verdade (sem In-Reply-To); é o prefixo visível. */
export function assuntoDaResposta(passos: Passo[], ultimoPassoId: string | null): string {
  if (!ultimoPassoId) return "Re:";
  const alvo = passoParaExecutar(passos, ultimoPassoId);
  const assunto = alvo && alvo.tipo === "email" ? alvo.assunto.trim() : "";
  return assunto ? `Re: ${assunto}` : "Re:";
}

function corpoEmHtml(texto: string): string {
  const escapado = texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escapado.replace(/\n/g, "<br>\n");
}

async function executarPassoEmail(
  admin: Admin,
  passo: Extract<Passo, { tipo: "email" }>,
  ctx: {
    inscricao: InscricaoRow;
    cadencia: NonNullable<Awaited<ReturnType<typeof carregarCadencia>>>;
    contato: { email: string; name: string | null };
    nomeDoVendedor: string | null;
    emailDoVendedor: string | null;
    requestId: string;
  },
): Promise<{ ok: boolean; erro?: string }> {
  const { inscricao, cadencia, contato, nomeDoVendedor, emailDoVendedor } = ctx;

  const assunto = passo.mesmaConversa
    ? renderizarComLead(assuntoDaResposta(cadencia.passos, inscricao.ultimo_email_passo_id), { nomeDoContato: contato.name, nomeDoVendedor, segmento: cadencia.configuracao.tagDoSegmento })
    : renderizarComLead(passo.assunto, {
        nomeDoContato: contato.name,
        nomeDoVendedor,
        segmento: cadencia.configuracao.tagDoSegmento,
      });
  const corpoRenderizado = renderizarComLead(passo.corpo, {
    nomeDoContato: contato.name,
    nomeDoVendedor,
    segmento: cadencia.configuracao.tagDoSegmento,
  });

  if (/\{\{\s*[a-z_]+\s*\}\}/.test(`${assunto}\n${corpoRenderizado}`)) return { ok: false, erro: "cadencia_variable_missing" };

  const linkPixel = signCadenciaLink({
    enrollment_id: inscricao.id,
    organization_id: inscricao.organization_id,
    cadence_id: inscricao.cadence_id,
    lead_id: inscricao.lead_id,
    passo_id: passo.id,
  }, "abertura");
  const linkDescadastro = signCadenciaLink({
    enrollment_id: inscricao.id,
    organization_id: inscricao.organization_id,
    cadence_id: inscricao.cadence_id,
    lead_id: inscricao.lead_id,
    passo_id: passo.id,
  }, "descadastro");
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const urlPixel = `${base}/api/v1/webhooks/cadencia-pixel/${linkPixel}`;
  const urlDescadastro = `${base}/api/v1/webhooks/cadencia-descadastro/${linkDescadastro}`;

  const html =
    `${corpoEmHtml(corpoRenderizado)}` +
    `<p style="margin-top:24px;font-size:11px;color:#888">` +
    `Não quer mais receber estes e-mails? <a href="${urlDescadastro}">Descadastrar</a></p>` +
    (inscricao.rastreio_consentido === true
      ? `<p>Você autorizou a contagem de abertura deste e-mail. Ela pode ser revogada com o descadastro.</p><img src="${urlPixel}" width="1" height="1" alt="" style="display:none" />`
      : "");

  if (!(await cadenciasLigadas(admin, inscricao.organization_id))) return { ok: false, erro: "cadencia_desligada" };
  // Persistir ANTES do efeito: um timeout pode significar que o provedor aceitou.
  // Outra rodada nunca repete um envio cuja confirmação local ficou incerta.
  const { data: reserva, error: erroReserva } = await admin.rpc("fn_cadencia_reservar_envio", {
    p_organization_id: inscricao.organization_id, p_enrollment_id: inscricao.id,
    p_processamento_id: inscricao.processamento_id, p_passo_id: passo.id,
  });
  if (erroReserva?.message === "cadencia_claim_lost") throw new Error("cadencia_claim_lost");
  if (erroReserva?.message === "cadencia_modulo_indisponivel") return { ok: false, erro: "cadencia_desligada" };
  if (erroReserva?.message === "cadencia_descadastrado" || erroReserva?.message === "cadencia_contato_restrito") return { ok: false, erro: "cadencia_contact_restricted" };
  if (erroReserva || reserva !== true) return { ok: false, erro: "cadencia_send_not_reserved" };
  const resultado = await sendEmail({
    to: contato.email,
    subject: assunto || "(sem assunto)",
    html,
    text: `${corpoRenderizado}\n\n---\nNão quer mais receber estes e-mails? ${urlDescadastro}`,
    fromName: nomeDoVendedor ?? undefined,
    replyTo: emailDoVendedor ?? undefined,
    tags: [
      { name: "cadencia_id", value: inscricao.cadence_id },
      { name: "enrollment_id", value: inscricao.id },
    ],
  });

  if (!resultado.ok) {
    logger.error("[cadencia-worker] envio de e-mail falhou", {
      enrollment_id: inscricao.id,
      codigo: resultado.error,
      via: resultado.via,
    });
    return { ok: false, erro: resultado.error ?? "send_failed" };
  }

  await admin.from("email_cadence_events").insert({
    organization_id: inscricao.organization_id,
    cadence_id: inscricao.cadence_id,
    enrollment_id: inscricao.id,
    lead_id: inscricao.lead_id,
    tipo: "email_enviado",
    passo_id: passo.id,
    metadata: { via: resultado.via },
  });

  return { ok: true };
}

/** true = leva pro "sim"; false = leva pro "não"; null = ainda não dá pra decidir (aguarda). */
export function avaliarRamo(
  passo: Extract<Passo, { tipo: "ramo" }>,
  inscricao: InscricaoRow,
  agora: Date,
  aberturasNoPrazo?: number,
): boolean | null {
  const desde = inscricao.ultimo_email_em ? new Date(inscricao.ultimo_email_em) : null;
  const prazoVenceu = desde
    ? agora.getTime() - desde.getTime() >= passo.condicao.dentroDeDias * 24 * 60 * 60 * 1000
    : true; // nunca houve e-mail: nada a esperar, decide já

  if (passo.condicao.tipo === "abriu") {
    if ((aberturasNoPrazo ?? inscricao.aberturas_ultimo_email ?? inscricao.aberturas) >= passo.condicao.vezes) return true;
    return prazoVenceu ? false : null;
  }
  // `clicou`/`respondeu`: sem fonte de dado ainda — nunca resolve pra "sim",
  // só aguarda o prazo e cai em "não" (ver o cabeçalho do arquivo).
  return prazoVenceu ? false : null;
}

/** Uma linha da fila, do claim até o desfecho. Nunca lança — falha vira `ultimo_erro` na própria linha. */
async function processarInscricao(admin: Admin, inscricao: InscricaoRow, agora: Date, requestId: string) {
  if (!(await cadenciasLigadas(admin, inscricao.organization_id))) {
    await liberarSemAvancar(admin, inscricao, agora, 60);
    return { desfecho: "adiada" as const };
  }
  if (inscricao.envio_pendente_passo_id) {
    await pararInscricao(admin, inscricao, "falha", "cadencia_delivery_unconfirmed");
    return { desfecho: "falha" as const };
  }
  const cadencia = await carregarCadencia(admin, inscricao.cadence_id, inscricao.organization_id);
  if (!cadencia) {
    await liberarSemAvancar(admin, inscricao, agora, 60);
    return { desfecho: "adiada" as const };
  }
  if (cadencia.status !== "ativa") {
    // Pausada/rascunho: a inscrição continua ativa, só espera — o operador
    // decide quando reativar. Reconferir daqui a 1h evita martelar a cada minuto.
    await liberarSemAvancar(admin, inscricao, agora, 60);
    return { desfecho: "adiada" as const };
  }

  if (cadencia.configuracao.paradas.ganhoOuPerdido) {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("status")
      .eq("id", inscricao.lead_id)
      .eq("organization_id", inscricao.organization_id)
      .maybeSingle();
    if (lead && (lead as { status: string }).status !== "open") {
      await pararInscricao(admin, inscricao, "ganho_ou_perdido");
      return { desfecho: "parada" as const };
    }
  }

  const passo = passoParaExecutar(cadencia.passos, inscricao.passo_atual_id);
  if (!passo) {
    await concluirInscricao(admin, inscricao);
    return { desfecho: "concluida" as const };
  }

  if (passo.tipo === "email") {
    if (!dentroDaJanela(cadencia.configuracao, agora)) {
      await liberarSemAvancar(admin, inscricao, agora, 1);
      return { desfecho: "adiada" as const };
    }
    const tetoDaCadencia = await checkRateLimit(
      `cadencia-email:${inscricao.organization_id}:${inscricao.cadence_id}`,
      cadencia.configuracao.limiteDiarioPorCaixa,
      JANELA_DO_TETO_DIARIO_SEG,
    );
    const teto = await checkRateLimit(
      BUCKET_TETO_DIARIO_DE_EMAIL,
      env.CADENCIA_LIMITE_EMAILS_POR_DIA,
      JANELA_DO_TETO_DIARIO_SEG,
    );
    if (!teto.allowed || !tetoDaCadencia.allowed) {
      await admin.from("email_cadence_events").insert({
        organization_id: inscricao.organization_id,
        cadence_id: inscricao.cadence_id,
        enrollment_id: inscricao.id,
        lead_id: inscricao.lead_id,
        tipo: "limite_diario_atingido",
        passo_id: passo.id,
        metadata: { escopo: !tetoDaCadencia.allowed ? "cadencia" : "instalacao", limite: !tetoDaCadencia.allowed ? cadencia.configuracao.limiteDiarioPorCaixa : env.CADENCIA_LIMITE_EMAILS_POR_DIA, contagem: !tetoDaCadencia.allowed ? tetoDaCadencia.count : teto.count },
      });
      await liberarSemAvancar(admin, inscricao, agora, MINUTOS_DE_ESPERA_POR_TETO);
      return { desfecho: "adiada" as const };
    }

    const { data: contatoRow } = await admin
      .from("contacts")
      .select("email, name, display_name, is_anonymized, is_blocked, is_personal, consent")
      .eq("id", inscricao.contact_id)
      .eq("organization_id", inscricao.organization_id)
      .maybeSingle();
    const contato = contatoRow as
      | { email: string | null; name: string | null; display_name: string | null; is_anonymized: boolean; is_blocked: boolean; is_personal: boolean; consent: unknown }
      | null;
    if (!contato || !contato.email || contato.is_anonymized) {
      await pararInscricao(admin, inscricao, "sem_email");
      return { desfecho: "parada" as const };
    }

    if (contatoRestringido(contato)) {
      await pararInscricao(admin, inscricao, "falha", "cadencia_contact_restricted");
      return { desfecho: "parada" as const };
    }

    let nomeDoVendedor: string | null = null;
    let emailDoVendedor: string | null = null;
    const { data: leadRow } = await admin
      .from("crm_leads")
      .select("owner_user_id")
      .eq("id", inscricao.lead_id)
      .eq("organization_id", inscricao.organization_id)
      .maybeSingle();
    const ownerId = (leadRow as { owner_user_id: string | null } | null)?.owner_user_id;
    if (ownerId) {
      try {
        const { data } = await admin.auth.admin.getUserById(ownerId);
        nomeDoVendedor = (data?.user?.user_metadata?.full_name as string | undefined) ?? null;
        emailDoVendedor = data?.user?.email ?? null;
      } catch {
        // Sem nome/e-mail do dono: o envio segue com o remetente padrão da instalação.
      }
    }

    const envio = await executarPassoEmail(admin, passo, {
      inscricao,
      cadencia,
      contato: { email: contato.email, name: nomeDoContato(contato) },
      nomeDoVendedor,
      emailDoVendedor,
      requestId,
    });

    if (!envio.ok && envio.erro === "cadencia_desligada") {
      await liberarSemAvancar(admin, inscricao, agora, 60);
      return { desfecho: "adiada" as const };
    }
    if (!envio.ok) {
      await pararInscricao(admin, inscricao, "falha", envio.erro ?? "send_failed");
      return { desfecho: "falha" as const };
    }

    const proximo = proximoIrmao(cadencia.passos, passo.id);
    await avancar(admin, inscricao, {
      passoAtualId: proximo?.id ?? null,
      proximoEm: agora,
      extras: {
        envio_pendente_passo_id: null,
        aberturas_ultimo_email: 0,
        ultimo_email_em: agora.toISOString(),
        ultimo_email_passo_id: passo.id,
        emails_enviados: inscricao.emails_enviados + 1,
        tentativas: 0,
      },
      concluirSeSemProximo: proximo === null,
    });
    return { desfecho: "email_enviado" as const };
  }

  if (passo.tipo === "espera") {
    const proximo = proximoIrmao(cadencia.passos, passo.id);
    await avancar(admin, inscricao, {
      passoAtualId: proximo?.id ?? null,
      proximoEm: avancarDiasUteis(agora, passo.diasUteis),
      concluirSeSemProximo: proximo === null,
    });
    return { desfecho: "avancou" as const };
  }

  if (passo.tipo === "tarefa") {
    await criarTarefaDoPasso(admin, passo, inscricao, cadencia.configuracao, agora, requestId);
    const proximo = proximoIrmao(cadencia.passos, passo.id);
    await avancar(admin, inscricao, {
      passoAtualId: proximo?.id ?? null,
      proximoEm: agora,
      concluirSeSemProximo: proximo === null,
    });
    return { desfecho: "avancou" as const };
  }

  if (passo.tipo === "ramo") {
    // O contador total não diz QUANDO o sinal chegou. Mesmo com cron atrasado,
    // só eventos do e-mail anterior dentro do prazo podem decidir o lado Sim.
    let noPrazo = 0;
    if (passo.condicao.tipo === "abriu" && inscricao.ultimo_email_em && inscricao.ultimo_email_passo_id) {
      const limite = new Date(new Date(inscricao.ultimo_email_em).getTime() + passo.condicao.dentroDeDias * 86_400_000).toISOString();
      const { count, error } = await admin.from("email_cadence_events").select("id", { count: "exact", head: true })
        .eq("organization_id", inscricao.organization_id).eq("enrollment_id", inscricao.id)
        .eq("tipo", "aberto").eq("passo_id", inscricao.ultimo_email_passo_id)
        .gte("created_at", inscricao.ultimo_email_em).lte("created_at", limite);
      if (error || typeof count !== "number") throw new Error("cadencia_open_count_failed");
      noPrazo = count;
    }
    const decisao = avaliarRamo(passo, inscricao, agora, noPrazo);
    if (decisao === null) {
      // Ainda dentro do prazo, sem sinal: reconfere em 15 min — nem martela a
      // cada minuto, nem deixa o lead esperando demais depois que o prazo vencer.
      await liberarSemAvancar(admin, inscricao, agora, 15);
      return { desfecho: "adiada" as const };
    }
    const lado = decisao ? "sim" : "nao";
    const proximo = primeiroDoLado(passo, lado);
    await admin.from("email_cadence_events").insert({
      organization_id: inscricao.organization_id,
      cadence_id: inscricao.cadence_id,
      enrollment_id: inscricao.id,
      lead_id: inscricao.lead_id,
      tipo: decisao ? "ramo_sim" : "ramo_nao",
      passo_id: passo.id,
    });
    await avancar(admin, inscricao, {
      passoAtualId: proximo?.id ?? null,
      proximoEm: agora,
      concluirSeSemProximo: proximo === null,
    });
    return { desfecho: "avancou" as const };
  }

  // passo.tipo === "whatsapp": ver o cabeçalho do arquivo.
  await pararInscricao(admin, inscricao, "falha", "Passo de WhatsApp ainda não é enviado pelo worker.");
  return { desfecho: "falha" as const };
}

async function criarTarefaDoPasso(
  admin: Admin, passo: Extract<Passo, { tipo: "tarefa" }>, inscricao: InscricaoRow,
  configuracao: Cadencia["configuracao"], agora: Date, requestId: string,
) {
  const { data: leadRow } = await admin.from("crm_leads").select("owner_user_id")
    .eq("id", inscricao.lead_id).eq("organization_id", inscricao.organization_id).maybeSingle();
  const ownerId = (leadRow as { owner_user_id: string | null } | null)?.owner_user_id ?? inscricao.inscrito_por;
  const { data: contato } = await admin.from("contacts").select("name, display_name")
    .eq("id", inscricao.contact_id).eq("organization_id", inscricao.organization_id).maybeSingle();
  let nomeDoVendedor: string | null = null;
  if (ownerId && passo.titulo.includes("{{vendedor}}")) {
    const { data } = await admin.auth.admin.getUserById(ownerId);
    nomeDoVendedor = (data?.user?.user_metadata?.full_name as string | undefined) ?? null;
  }
  const titulo = renderizarComLead(passo.titulo, { nomeDoContato: nomeDoContato(contato), nomeDoVendedor, segmento: configuracao.tagDoSegmento });
  if (/\{\{\s*[a-z_]+\s*\}\}/.test(titulo)) throw new Error("cadencia_variable_missing");
  const { data, error } = await admin.rpc("fn_cadencia_criar_tarefa", {
    p_organization_id: inscricao.organization_id, p_enrollment_id: inscricao.id,
    p_processamento_id: inscricao.processamento_id, p_passo_id: passo.id, p_titulo: titulo,
    p_due_date: avancarDiasUteis(agora, passo.prazoDias).toISOString(), p_assigned_to: ownerId,
  });
  if (error || !data) throw new Error(error?.message === "cadencia_claim_lost" ? "cadencia_claim_lost" : "cadencia_task_create_failed");
  if (!data.criada_agora || !data.tarefa) return;
  void audit({ action: "crm_task.created", organizationId: inscricao.organization_id, resourceType: "crm_task", resourceId: data.tarefa.id, bypassedRls: true, requestId, metadata: { origem: "cadencias", cadence_id: inscricao.cadence_id, enrollment_id: inscricao.id, passo_id: passo.id } });
  const { registraAtividadeDaTarefa } = await import("@/lib/tarefas/atividade");
  await registraAtividadeDaTarefa(admin, { organizationId: inscricao.organization_id, tarefa: data.tarefa, tipo: "task_created", actor: { type: "webhook_source", id: "cadencias" } });
}

async function avancar(
  admin: Admin,
  inscricao: InscricaoRow,
  args: {
    passoAtualId: string | null;
    proximoEm: Date;
    extras?: Record<string, unknown>;
    concluirSeSemProximo: boolean;
  },
) {
  const terminou = args.concluirSeSemProximo && args.passoAtualId === null;
  const { data, error } = await admin
    .from("email_cadence_enrollments")
    .update({
      passo_atual_id: args.passoAtualId,
      proximo_em: args.proximoEm.toISOString(),
      processando_ate: null,
      processamento_id: null,
      updated_at: new Date().toISOString(),
      ...args.extras,
      ...(terminou ? { status: "concluida", concluida_em: new Date().toISOString() } : {}),
    })
    .eq("id", inscricao.id)
    .eq("organization_id", inscricao.organization_id).eq("status", "ativa").eq("processamento_id", inscricao.processamento_id ?? "00000000-0000-0000-0000-000000000000").select("id").maybeSingle();
  if (error) throw new Error("cadencia_progress_write_failed");
  if (!data) throw new Error("cadencia_claim_lost");
  if (terminou) await admin.from("email_cadence_events").insert({ organization_id: inscricao.organization_id, cadence_id: inscricao.cadence_id, enrollment_id: inscricao.id, lead_id: inscricao.lead_id, tipo: "concluida" });
}

async function concluirInscricao(admin: Admin, inscricao: InscricaoRow) {
  const agora = new Date().toISOString();
  const { data: mudou, error: erroGravacao } = await admin
    .from("email_cadence_enrollments")
    .update({ status: "concluida", concluida_em: agora, processando_ate: null, processamento_id: null, updated_at: agora })
    .eq("id", inscricao.id)
    .eq("organization_id", inscricao.organization_id).eq("status", "ativa").eq("processamento_id", inscricao.processamento_id ?? "00000000-0000-0000-0000-000000000000").select("id").maybeSingle();
  if (erroGravacao) throw new Error("cadencia_progress_write_failed");
  if (!mudou) return;
  await admin.from("email_cadence_events").insert({
    organization_id: inscricao.organization_id,
    cadence_id: inscricao.cadence_id,
    enrollment_id: inscricao.id,
    lead_id: inscricao.lead_id,
    tipo: "concluida",
  });
}

async function pararInscricao(
  admin: Admin,
  inscricao: InscricaoRow,
  motivo: "sem_email" | "ganho_ou_perdido" | "falha",
  erro?: string,
) {
  const agora = new Date().toISOString();
  const { data: mudou, error: erroGravacao } = await admin
    .from("email_cadence_enrollments")
    .update({
      status: "parada",
      motivo_parada: motivo,
      parada_em: agora,
      processando_ate: null,
      processamento_id: null,
      updated_at: agora,
      ...(erro ? { ultimo_erro: erro } : {}),
    })
    .eq("id", inscricao.id)
    .eq("organization_id", inscricao.organization_id).eq("status", "ativa").eq("processamento_id", inscricao.processamento_id ?? "00000000-0000-0000-0000-000000000000").select("id").maybeSingle();
  if (erroGravacao) throw new Error("cadencia_progress_write_failed");
  if (!mudou) return;
  await admin.from("email_cadence_events").insert({
    organization_id: inscricao.organization_id,
    cadence_id: inscricao.cadence_id,
    enrollment_id: inscricao.id,
    lead_id: inscricao.lead_id,
    tipo: "parada",
    metadata: erro ? { motivo, erro } : { motivo },
  });
}

async function registrarTentativaFalha(admin: Admin, inscricao: InscricaoRow, erro: string, agora: Date) {
  const tentativas = inscricao.tentativas + 1;
  // Backoff da fonte: 5 min, 10 min; a terceira falha para de
  // vez — envio em dobro (reenviar cego pra sempre) é pior que registrar a falha
  // e deixar visível na Atividade.
  if (tentativas >= 3) {
    await pararInscricao(admin, inscricao, "falha", erro);
    return;
  }
  const { data: mudou, error: erroGravacao } = await admin
    .from("email_cadence_enrollments")
    .update({
      tentativas,
      ultimo_erro: erro,
      proximo_em: new Date(agora.getTime() + tentativas * 5 * 60 * 1000).toISOString(),
      processando_ate: null,
      processamento_id: null,
      updated_at: agora.toISOString(),
    })
    .eq("id", inscricao.id)
    .eq("organization_id", inscricao.organization_id).eq("status", "ativa").eq("processamento_id", inscricao.processamento_id ?? "00000000-0000-0000-0000-000000000000").select("id").maybeSingle();
  if (erroGravacao) throw new Error("cadencia_progress_write_failed");
  if (!mudou) return;
  await admin.from("email_cadence_events").insert({
    organization_id: inscricao.organization_id,
    cadence_id: inscricao.cadence_id,
    enrollment_id: inscricao.id,
    lead_id: inscricao.lead_id,
    tipo: "email_falhou",
    metadata: { erro, tentativa: tentativas },
  });
}

async function liberarSemAvancar(admin: Admin, inscricao: InscricaoRow, agora: Date, minutos: number) {
  await admin
    .from("email_cadence_enrollments")
    .update({
      proximo_em: new Date(agora.getTime() + minutos * 60 * 1000).toISOString(),
      processando_ate: null,
      processamento_id: null,
    })
    .eq("id", inscricao.id)
    .eq("organization_id", inscricao.organization_id).eq("status", "ativa").eq("processamento_id", inscricao.processamento_id ?? "00000000-0000-0000-0000-000000000000");
}

export async function processarCadencias(admin: Admin, agora: Date, requestId: string): Promise<ResultadoDoTick> {
  const vazio: ResultadoDoTick = { processadas: 0, emailsEnviados: 0, concluidas: 0, paradas: 0, falhas: 0 };
  if (!(await moduloLigado(admin, "cadencias"))) return vazio;
  const { data: candidatas, error: erroLeitura } = await admin.rpc("fn_cadencias_reivindicar", { p_agora: agora.toISOString() });
  if (erroLeitura || !Array.isArray(candidatas)) throw new Error("cadencia_queue_claim_failed");
  const resultado: ResultadoDoTick = vazio;
  for (const linha of candidatas as InscricaoRow[]) {
    if (!linha.processamento_id) throw new Error("cadencia_invalid_claim");
    // A linha é o estado ATUAL devolvido pelo claim atômico, nunca um snapshot
    // lido antes de outro worker avançar o passo e liberar a inscrição.
    resultado.processadas++;
    try {
      const desfecho = await processarInscricao(admin, linha, agora, requestId);
      if (desfecho.desfecho === "email_enviado") resultado.emailsEnviados++;
      if (desfecho.desfecho === "concluida") resultado.concluidas++;
      if (desfecho.desfecho === "parada") resultado.paradas++;
      if (desfecho.desfecho === "falha") resultado.falhas++;
    } catch (erro) {
      if (erro instanceof Error && erro.message === "cadencia_claim_lost") continue;
      logger.error("[cadencia-worker] inscrição falhou", {
        enrollment_id: linha.id,
        erro: "cadencia_processing_failed",
      });
      const codigo = erro instanceof Error && ["cadencia_variable_missing", "cadencia_task_create_failed", "cadencia_open_count_failed"].includes(erro.message) ? erro.message : "cadencia_processing_failed";
      if (codigo === "cadencia_variable_missing") await pararInscricao(admin, linha, "falha", codigo);
      else await registrarTentativaFalha(admin, linha, codigo, agora);
      resultado.falhas++;
    }
  }
  return resultado;
}
