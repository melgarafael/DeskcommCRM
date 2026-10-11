import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";
import { checkDailyLimit, espacarEnvio } from "@/lib/automation/throttle";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { alocarNumero } from "@/lib/propostas/numeracao";
import { decidirVersao } from "@/lib/propostas/versao";
import { salvarPdfDaProposta } from "@/lib/propostas/storage";
import { montarPdfDaProposta } from "@/lib/propostas/pdf-da-proposta";
import { montarDocumentoDaProposta } from "@/lib/propostas/documento/documento-da-proposta";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { agendaRetornoNoCrm } from "@/lib/followup/retorno-crm";
import { buscarPadroesDaOrganizacao } from "@/lib/propostas/padroes-da-organizacao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { sePropostasDesligadas } from "@/lib/propostas/porta";
import { resolverAvisoDeRevisaoSeProntaOuEncerrada } from "@/lib/propostas/aviso-de-revisao";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * N2 — traduz o código de recusa do agendamento em frase legível para a
 * timeline (`proposal_followup_skipped`). Códigos desconhecidos (futuros)
 * viajam crus em vez de virarem frase inventada.
 */
function motivoDaRecusa(codigo: string): string {
  if (codigo === "instante_fora_da_janela") return "a data calculada cai fora da janela de agendamento permitida";
  if (codigo === "instante_no_passado") return "a data calculada já passou";
  if (codigo === "instante_invalido") return "a data calculada é inválida";
  if (codigo === "negocio_nao_encontrado") return "o negócio não foi encontrado";
  if (codigo === "negocio_sem_contato") return "o negócio está sem contato vinculado";
  if (codigo === "cliente_nao_encontrado") return "o contato não foi encontrado";
  return codigo;
}

export async function POST(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_proposals" });
  if (!authz.ok) return authz.response;
  const desligada = await sePropostasDesligadas(authz.org.orgId, requestId);
  if (desligada) return desligada;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  const admin = createAdminClient();

  const { data: proposta } = await admin
    .from("crm_proposals")
    .select("*")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!proposta) return fail("not_found", t("Proposta não encontrada."), 404, { requestId });

  // A chamada vale pelo efeito de validação: lança para qualquer status que
  // não seja `rascunho`, e o catch abaixo vira o 409 (o valor de retorno não
  // é mais usado — só rascunho chega até aqui).
  try {
    decidirVersao(proposta as never);
  } catch {
    return fail("proposal_context_stale", t("Esta proposta não pode ser enviada neste estado."), 409, { requestId });
  }

  const { data: itens } = await admin
    .from("crm_proposal_items")
    .select("*")
    .eq("organization_id", authz.org.orgId)
    .eq("proposal_id", id)
    .order("position");
  if (!itens || itens.length === 0) {
    return fail("validation_failed", t("A proposta não tem itens."), 422, { requestId });
  }

  // §5.2 — enviar com qualquer item sem preço é recusado, com a lista.
  if (proposta.pricing_status === "missing") {
    const semPreco = itens
      .filter((it) => (it as { preco_unitario_cents: number | null }).preco_unitario_cents === null)
      .map((it) => (it as { descricao: string }).descricao);
    return fail(
      "validation_failed",
      t(`Item sem preço definido: ${semPreco.join(", ")}. Defina o preço antes de enviar.`),
      422,
      { requestId },
    );
  }

  // C1 da spec de 27/09 — sem modelo CONFIRMADO não há documento. Antes a
  // proposta seguia e caía no PDF legado (`renderPropostaPdf`), que não tem as
  // seções do modelo: o cliente recebia um arquivo diferente do que a tela
  // mostrava, e a diferença era invisível. Mesma frase da prévia
  // (`lib/propostas/pdf-da-proposta.ts`).
  if (!proposta.template_slug) {
    return fail("validation_failed", t("Escolha e confirme o modelo da proposta antes de enviar."), 422, { requestId });
  }

  // §7 item 2 da spec — enviar com o documento cheio de "[a definir]" é pior
  // que não enviar: o cliente recebe o PDF com a pendência que a tela já
  // avisava e ninguém tinha bloqueado.
  // D1 da spec de 26/09: o documento é calculado num lugar só, e é o MESMO
  // objeto que trava, congela no snapshot e vira o PDF abaixo.
  //
  // ⚠️ A checada de pendência fica AQUI, e não só dentro de
  // `montarPdfDaProposta`: ela precisa acontecer ANTES de alocar número, e a
  // função compartilhada só roda depois dele (o número vai impresso no PDF). A
  // MONTAGEM do arquivo, essa sim, é a função — a prévia da tela monta o PDF
  // por ela e não diverge por construção.
  const { data: contatoParaDoc } = proposta.template_slug && proposta.contact_id
    ? await admin
        .from("contacts")
        .select("name, display_name")
        .eq("organization_id", authz.org.orgId)
        .eq("id", proposta.contact_id)
        .maybeSingle()
    : { data: null };
  const documento = await montarDocumentoDaProposta(admin, authz.org.orgId, proposta as never, contatoParaDoc ?? null);
  if (documento && documento.camposFaltando.length > 0) {
    return fail(
      "validation_failed",
      t("Faltam {n} campo(s) do documento antes de enviar: {lista}. Abra a proposta e preencha.")
        .replace("{n}", String(documento.camposFaltando.length))
        .replace("{lista}", documento.camposFaltando.map((c) => t(c.rotulo)).join(", ")),
      422,
      { requestId },
    );
  }

  // D5, último item da tabela: a proposta grava a conversa do turno que a
  // originou (Task 7) — o envio prefere ESSA conversa, e só cai no fallback
  // "mais recente do contato" para propostas manuais antigas sem o campo.
  // `contact_id` entra no filtro (revisão C3): sem ele, uma referência
  // gravada errada (outro contato) seria usada do mesmo jeito, mandando o
  // PDF/preços desta proposta no WhatsApp de um contato que não é o dela.
  const { data: conversa } = proposta.conversation_id
    ? await admin
        .from("conversations")
        .select("id, channel_session_id")
        .eq("organization_id", authz.org.orgId)
        .eq("id", proposta.conversation_id)
        .eq("contact_id", proposta.contact_id)
        .maybeSingle()
    : await admin
        .from("conversations")
        .select("id, channel_session_id")
        .eq("organization_id", authz.org.orgId)
        .eq("contact_id", proposta.contact_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
  if (!conversa) return fail("validation_failed", t("Nenhuma conversa com este contato para enviar."), 422, { requestId });

  // ─── THROTTLE PRIMEIRO — antes de gastar numero ou gerar PDF (correção 1/2) ───
  const foraDaJanela = await adiarAteAJanelaAbrir(admin, authz.org.orgId, conversa.channel_session_id);
  if (foraDaJanela) {
    return fail("validation_failed", t("Fora do horário de envio configurado. Tente novamente mais tarde."), 422, { requestId });
  }
  const limiteDiario = await checkDailyLimit(admin, authz.org.orgId, conversa.channel_session_id);
  if (!limiteDiario.allowed) {
    return fail("validation_failed", t("Limite diário de mensagens desta conexão foi atingido."), 422, { requestId });
  }

  // `maybeSingle` — D10: proposta órfã (lead_id/contact_id nulos) não pode
  // derrubar o envio de uma v2 com um erro de "linha não encontrada".
  const { data: lead } = proposta.lead_id
    ? await admin
        .from("crm_leads")
        .select("id, contact_id, value_cents")
        .eq("organization_id", authz.org.orgId)
        .eq("id", proposta.lead_id)
        .maybeSingle()
    : { data: null };
  const { data: contato } = await admin
    .from("contacts")
    .select("name, display_name, email, phone_number")
    .eq("organization_id", authz.org.orgId)
    .eq("id", proposta.contact_id)
    .maybeSingle();

  // C4/D4: só chega até aqui quem está em `rascunho` (decidirVersao lança
  // para qualquer outro status, virando 409 acima). Criar a v2 é
  // responsabilidade exclusiva da rota de revisão — o envio nunca mais cria
  // versão: `propostaAlvo` é sempre a própria proposta.
  const propostaAlvo = proposta;

  // ─── Entra em `enviando` e aloca numero (D3+D9) — número reservado ao
  // entrar em `enviando`, não ao confirmar entrega ───
  let numeroEAno: { numero: number; ano: number };
  if (propostaAlvo.numero != null && propostaAlvo.ano != null) {
    // Reenvio depois de uma falha anterior (D3): o número já foi reservado e
    // RETIDO na volta a rascunho — chamar o contador de novo gastaria outro
    // número a cada tentativa e o UPDATE de alocarNumero (que exige
    // `numero is null`) nunca casaria, sempre lançando.
    numeroEAno = { numero: propostaAlvo.numero, ano: propostaAlvo.ano };
    await admin.from("crm_proposals")
      .update({ status: "enviando", ultima_falha_envio: null })
      .eq("organization_id", authz.org.orgId).eq("id", propostaAlvo.id);
  } else {
    numeroEAno = await alocarNumero(admin, { orgId: authz.org.orgId, propostaId: propostaAlvo.id });
    await admin.from("crm_proposals")
      .update({ status: "enviando", ultima_falha_envio: null })
      .eq("organization_id", authz.org.orgId).eq("id", propostaAlvo.id);
  }

  const destinatarioNome = rotuloDoContato(contato, t);

  // M5 — snapshot do modelo/documento usados nesta emissão (spec §5.5:
  // TEMPLATE, PROPOSTA e DOCUMENTO são 3 coisas — o que congela aqui nunca
  // muda depois, mesmo que o modelo evolua). Best-effort: falha ao montar isto
  // nunca pode impedir o envio (mesmo padrão do follow-up, abaixo neste
  // arquivo).
  const templateSnapshot: unknown = documento ? documento.modelo : null;
  const renderedSnapshot: unknown = documento
    ? { secoes: documento.secoes, variaveisFaltando: documento.pendencias }
    : null;

  // ─── PDF, upload e envio: qualquer EXCEÇÃO aqui (não só um desfecho de
  // mensagem) também é "falha em qualquer passo" (D3, ponto 3) — sem este
  // try/catch a proposta ficava presa em `enviando` até o cron
  // `proposta-travada` agir, 5 minutos depois, por um erro que já era
  // conhecido no mesmo request. ───
  let pdfPath: string;
  let signedUrl: string;
  let mensagem: Awaited<ReturnType<typeof sendMessageHandler>>;
  try {
    // A montagem do PDF é a MESMA função que a prévia da tela chama
    // (`lib/propostas/pdf-da-proposta.ts`): uma diferença entre o arquivo que
    // o gestor confere e o que o cliente recebe é defeito por construção.
    // Recusa aqui é o caso degenerado que a trava de pendência acima já
    // desarmou — e cai no mesmo "falha em qualquer passo" de sempre, com a
    // proposta voltando a rascunho e o motivo escrito em `ultima_falha_envio`.
    const montagem = await montarPdfDaProposta(admin, authz.org.orgId, propostaAlvo, {
      numero: numeroEAno.numero,
      ano: numeroEAno.ano,
      t,
    });
    if (!montagem.ok) throw new Error(montagem.motivo);
    const pdfBuffer = montagem.buffer;
    const salvo = await salvarPdfDaProposta(admin, {
      orgId: authz.org.orgId, propostaId: propostaAlvo.id, buffer: pdfBuffer,
    });
    pdfPath = salvo.path;
    signedUrl = salvo.signedUrl;

    await espacarEnvio(conversa.channel_session_id);

    mensagem = await sendMessageHandler(
      admin,
      { organization_id: authz.org.orgId, actor: { type: "user", id: authz.user.id }, requestId, idioma: authz.user.idioma },
      { conversation_id: conversa.id, type: "document", media_url: signedUrl, media_mime: "application/pdf" },
    );

    // O clique no anexo depois (GET /api/v1/messages/[id]/media) só reaproveita
    // uma URL assinada quando a mensagem tem `media_storage_path` — é o único
    // campo que a rota sabe reler. `sendMessageHandler` não aceita esse campo
    // aqui: o PDF vive fora da conversa (bucket `propostas`, não
    // `<org>/<conversationId>/…`), e a checagem de posse dele é para arquivo
    // que UM USUÁRIO anexou de dentro da própria conversa. Por isso é uma
    // segunda escrita, direto na linha, depois que ela já existe.
    await admin
      .from("messages")
      .update({ media_storage_path: pdfPath })
      .eq("organization_id", authz.org.orgId)
      .eq("id", mensagem.id);
  } catch (erro) {
    const { data: revertida } = await admin
      .from("crm_proposals")
      .update({
        status: "rascunho",
        ultima_falha_envio: erro instanceof Error ? erro.message : "Falha desconhecida ao enviar.",
      })
      .eq("organization_id", authz.org.orgId).eq("id", propostaAlvo.id)
      .select("*").single();
    return ok(revertida, { requestId });
  }

  // ─── Desfecho decidido pelo status DEVOLVIDO pela mensagem, nunca pela
  // ausência de exceção (D3 — "pior do que parece") ───
  if (mensagem.status === "failed") {
    const { data: revertida } = await admin
      .from("crm_proposals")
      .update({
        status: "rascunho",
        pdf_path: pdfPath,
        message_id: mensagem.id,
        ultima_falha_envio: mensagem.error_message ?? "Falha desconhecida ao enviar.",
      })
      .eq("organization_id", authz.org.orgId).eq("id", propostaAlvo.id)
      .select("*").single();
    return ok(revertida, { requestId });
  }

  if (mensagem.status === "queued") {
    const { data: emFila } = await admin
      .from("crm_proposals")
      .update({ pdf_path: pdfPath, message_id: mensagem.id })
      .eq("organization_id", authz.org.orgId).eq("id", propostaAlvo.id)
      .select("*").single();
    return ok(emFila, { requestId });
  }

  // sent | delivered | read → enviada de verdade.
  const { data: enviada } = await admin
    .from("crm_proposals")
    .update({
      status: "enviada", pdf_path: pdfPath, sent_at: new Date().toISOString(),
      sent_by_user_id: authz.user.id, message_id: mensagem.id, destinatario_nome: destinatarioNome,
      template_snapshot: templateSnapshot, rendered_snapshot: renderedSnapshot,
    })
    .eq("organization_id", authz.org.orgId).eq("id", propostaAlvo.id)
    .select("*").single();

  // N2 (aviso de revisão): enviada não está mais em rascunho — não faz mais
  // sentido revisar. Fire-and-forget, nunca derruba o envio já confirmado.
  void resolverAvisoDeRevisaoSeProntaOuEncerrada(admin, authz.org.orgId, propostaAlvo.id, { forcar: true });

  // D4 — a v2 foi EFETIVAMENTE enviada: a v1 sai de cena (vira
  // `substituida`). Só aqui: nem na criação da v2 (revise/route.ts, onde a v1
  // continua `enviada` de propósito), nem em falha/fila (a v2 volta a
  // rascunho e a v1 segue vigente).
  //
  // `.eq("status", "enviada")` (achado Crítico da revisão C4): a v1 pode ter
  // sido decidida (aceita/recusada) ENQUANTO a v2 ficava em rascunho — nada
  // impede `decide/route.ts` de agir sobre ela nesse meio-tempo, porque só
  // exige `status = 'enviada'`. Sem o filtro, este UPDATE sobrescrevia a
  // decisão já registrada (e `decided_at`/`decided_by_user_id` continuavam
  // gravados numa linha que juridicamente não conta mais como aceita/
  // recusada). Com o filtro, a v1 só vira `substituida` se AINDA estiver
  // `enviada` — decidida, o UPDATE não afeta linha nenhuma, sem erro.
  // Achado Importante da revisão final da C3b+E1: o retorno automático da v1
  // (`v1.retorno_id`) sobrevivia à troca em silêncio — `agendaRetornoNoCrm`
  // recusa por `ja_existe_retorno` (o negócio já tem retorno aberto, que É o
  // da v1) e a v2 seguia sem `retorno_id`; o decide só cancela o retorno da
  // proposta que ele está decidindo, então R1 nunca era cancelado e disparava
  // depois do cliente já ter aceitado/recusado a v2. Guardamos aqui o
  // `retorno_id` da v1 para herdá-lo na v2 quando o agendamento novo colidir
  // com ele (ver bloco N2 abaixo).
  let retornoHerdadoDaV1: string | null = null;
  if (propostaAlvo.substitui_id) {
    const { data: v1AntesDaTroca } = await admin
      .from("crm_proposals")
      .select("retorno_id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", propostaAlvo.substitui_id)
      .maybeSingle();
    retornoHerdadoDaV1 = (v1AntesDaTroca as { retorno_id: string | null } | null)?.retorno_id ?? null;

    await admin
      .from("crm_proposals")
      .update({ status: "substituida" })
      .eq("organization_id", authz.org.orgId)
      .eq("id", propostaAlvo.substitui_id)
      .eq("status", "enviada");
  }

  const totalDoLead = propostaAlvo.total_cents;
  const valorAntes = lead?.value_cents ?? null;
  if (proposta.lead_id) {
    await admin.from("crm_leads").update({ value_cents: totalDoLead }).eq("organization_id", authz.org.orgId).eq("id", proposta.lead_id);
    await emitLeadActivity(admin, {
      organizationId: authz.org.orgId, leadId: proposta.lead_id, contactId: proposta.contact_id,
      type: "proposal_sent", sourceModule: "proposals", sourceId: propostaAlvo.id,
      actor: { type: "user", id: authz.user.id },
      reason: `Proposta ${numeroEAno.numero}/${numeroEAno.ano} enviada ao cliente`,
    });
    await emitLeadActivity(admin, {
      organizationId: authz.org.orgId, leadId: proposta.lead_id, contactId: proposta.contact_id,
      type: "proposal_value_changed", sourceModule: "proposals", sourceId: propostaAlvo.id,
      actor: { type: "user", id: authz.user.id },
      reason: `Valor do negócio atualizado de ${valorAntes ?? "—"} para ${totalDoLead} centavos (proposta enviada)`,
    });

    // N2 — ao enviar, agenda o retorno automático (nunca bloqueia o envio:
    // qualquer recusa/erro do agendamento é fire-and-forget).
    try {
      const padroes = await buscarPadroesDaOrganizacao(admin, authz.org.orgId);
      const promessa = `Retomar a proposta ${numeroEAno.numero}/${numeroEAno.ano}`;
      const prometidoPara = new Date(Date.now() + padroes.followupDias * 24 * 60 * 60 * 1000).toISOString();
      // nunca depois da validade da proposta.
      const dentroDaValidade = !propostaAlvo.valid_until || prometidoPara.slice(0, 10) <= propostaAlvo.valid_until;
      if (dentroDaValidade) {
        const resultado = await agendaRetornoNoCrm(
          { admin, orgId: authz.org.orgId, actor: { type: "api_token", id: "proposal:send" } },
          { leadId: proposta.lead_id },
          { motivo: promessa, prometidoPara, promessa },
        );
        if (resultado.ok) {
          await admin.from("crm_proposals").update({ retorno_id: resultado.retorno.id }).eq("organization_id", authz.org.orgId).eq("id", propostaAlvo.id);
        } else if (resultado.codigo === "ja_existe_retorno" && retornoHerdadoDaV1) {
          // O retorno que já existe é o da v1 que acabamos de substituir: a
          // v2 herda o ponteiro, para o decide poder cancelá-lo quando o
          // cliente decidir sobre ELA (sem herança, R1 dispararia depois).
          await admin.from("crm_proposals").update({ retorno_id: retornoHerdadoDaV1 }).eq("organization_id", authz.org.orgId).eq("id", propostaAlvo.id);
        } else if (resultado.codigo !== "ja_existe_retorno") {
          // `ja_existe_retorno`: o negócio já tem retorno (serve, e ele tem
          // atividade própria) — nada a registrar. Qualquer OUTRA recusa é um
          // follow-up que não virá e ninguém saberá: a timeline registra que
          // não agendou e por quê (N2: nunca em silêncio).
          await emitLeadActivity(admin, {
            organizationId: authz.org.orgId, leadId: proposta.lead_id, contactId: proposta.contact_id,
            type: "proposal_followup_skipped", sourceModule: "proposals", sourceId: propostaAlvo.id,
            actor: { type: "user", id: authz.user.id },
            reason: `Follow-up automático não agendado: ${motivoDaRecusa(resultado.codigo)}.`,
          });
        }
      }
    } catch (erro) {
      // Best-effort de verdade: o WhatsApp já entregou, a proposta já é
      // `enviada` — um erro inesperado aqui (banco instável no meio do
      // request) não pode transformar o envio feito num 500.
      logger.warn("proposal.send: follow-up automático falhou sem bloquear o envio", {
        organizationId: authz.org.orgId, propostaId: propostaAlvo.id,
        erro: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }
  // Proposta órfã (lead_id nulo — D10): não há negócio para atualizar nem
  // atividade para gravar; a proposta ainda vira `enviada` normalmente.

  void audit({
    action: "proposal.sent", actorUserId: authz.user.id, organizationId: authz.org.orgId,
    resourceType: "crm_proposals", resourceId: propostaAlvo.id, requestId,
    metadata: { numero: numeroEAno.numero, ano: numeroEAno.ano },
  });

  return ok(enviada, { requestId });
}
