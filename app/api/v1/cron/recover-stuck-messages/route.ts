/**
 * GET/POST /api/v1/cron/recover-stuck-messages — issue #129.
 *
 * Mensagem outbound nasce com `status='sending'` e só sai desse estado quando
 * quem envia confirma (ack do canal, resposta do worker). Quando o envio nunca
 * acontece, a linha fica `sending` PARA SEMPRE — e o que o self-hoster vê no
 * inbox é uma mensagem eternamente "enviando": um sinal de progresso para algo
 * que não vai acontecer.
 *
 * Essa é a pior forma de falha num produto que a pessoa instala sozinha numa
 * VPS: não há ninguém monitorando, então ela conclui que o produto é lento, não
 * que está quebrado, e nunca abre um chamado. O `CLAUDE.md` e o PRD 03 prometem
 * este cron desde o começo (regra de negócio W-12); ele simplesmente não
 * existia — o `git grep` só achava a promessa, nunca a rota.
 *
 * O que ele faz, e o que deliberadamente NÃO faz:
 *
 *   - marca `failed` toda outbound `sending` mais velha que 5 min (o prazo do
 *     `CLAUDE.md`), gravando `error_code`/`error_message` para quem investigar;
 *   - emite `message.failed` por mensagem, como manda a regra W-12. Não dá para
 *     contar com o trigger: `trg_messages_emit_event` é AFTER **INSERT**, então
 *     mudança de status não emite nada — o evento que a regra promete só existe
 *     se este cron o emitir;
 *   - abre UM aviso por organização por rodada na Central de avisos
 *     (`agent_inbox_items`, kind `message_send_stuck`), porque marcar `failed`
 *     em silêncio troca uma falha invisível por outra: a bolha muda de ícone
 *     numa conversa que ninguém tem motivo para reabrir;
 *   - avisa (sem tocar na linha) a outbound `queued` vencida numa conexão que
 *     JÁ VOLTOU a WORKING — a espera que ninguém vê (`avisarEsperaEsquecida`,
 *     abaixo);
 *   - **não reenvia nada.** Reenviar exigiria saber POR QUE não foi, e o envio
 *     em dobro é pior que o não-envio: o cliente recebe a mesma mensagem duas
 *     vezes. Retry é decisão de quem lê o aviso.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|
 * INTERNAL_SECRET, fail-closed).
 *
 * NOTA DE DEPLOY: não há `vercel.json` neste repo (self-host). O agendamento
 * vive no serviço `scheduler` do `docker-compose.prod.yml`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  emitirFalhaDeEntrega,
  telefoneDoEmbed,
  type EmbedDoContato,
} from "@/lib/messaging/falha-de-entrega";
import { MAX_REENVIOS, TETO_DA_ESPERA_DA_FILA_MS } from "@/lib/messaging/reenvio-desacelerado";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";

export const dynamic = "force-dynamic";

/**
 * Prazo do `CLAUDE.md` (seção de canal) e da regra W-12. Não é chute: é maior que
 * qualquer envio legítimo (o throttle anti-ban trabalha em segundos) e menor
 * que a paciência de quem está olhando a tela.
 */
export const STUCK_AFTER_MS = 5 * 60 * 1000;

/**
 * Quanto tempo uma mensagem pode esperar antes de virar aviso.
 *
 * Mais folgado que o de `sending` de propósito: esperar é legítimo enquanto a
 * conexão está caída, e só vira problema quando ela volta e a mensagem fica.
 */
const ESPERA_ESQUECIDA_MS = 15 * 60 * 1000;

/**
 * O prazo da `queued` que pode ter nova tentativa agendada. O reenvio
 * desacelerado faz até 5 pedidos (o inicial + `MAX_REENVIOS`), e cada um espera
 * até 5 min — ou até `TETO_DA_ESPERA_DA_FILA_MS` atrás de outra mensagem da
 * mesma conversa, porque esse teto conta do pedido, não da mensagem. Antes
 * disso o aviso diria "parada" de uma mensagem que ainda vai sair. Só a linha
 * que esperava a conexão (`channel_session_not_working`) fica com os 15 min:
 * ela não tem tentativa nenhuma agendada.
 */
const ESPERA_COM_TENTATIVA_MS = (MAX_REENVIOS + 1) * TETO_DA_ESPERA_DA_FILA_MS;

/**
 * Passado isto a mensagem sai do radar. A `queued` não tem quem a tire desse
 * estado, então sem teto a primeira rodada depois de atualizar acusaria todo o
 * histórico da instalação. E com a janela de 24 h fechada o canal oficial já
 * recusa o reenvio: o aviso não teria saída.
 */
const ESPERA_TETO_MS = 24 * 60 * 60 * 1000;

/**
 * Fixo, sem a contagem: o dedup casa pelo título, e um título com número abriria
 * um segundo aviso quando 1 virasse 2, com o primeiro ainda aberto.
 */
const TITULO_DA_ESPERA = "Mensagens ficaram esperando e não saíram";

interface EsperaRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  created_at: string;
  metadata: { queued_reason?: unknown } | null;
  channel_sessions: { status: string | null } | null;
}

/** Quando a mensagem deixa de ser espera legítima e passa a merecer aviso. */
function vencimentoDaEspera(m: EsperaRow): number {
  const prazo =
    m.metadata?.queued_reason === "channel_session_not_working"
      ? ESPERA_ESQUECIDA_MS
      : ESPERA_COM_TENTATIVA_MS;
  return new Date(m.created_at).getTime() + prazo;
}

/** Teto por invocação — a rodada seguinte pega o resto. */
const SCAN_LIMIT = 500;

interface StuckMessage {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string | null;
  created_at: string;
  sent_via: string;
  contacts: EmbedDoContato;
}

export interface RecoverResult {
  scanned: number;
  failed: number;
  organizations: number;
  /** Mensagens que esperavam num canal que já voltou — viraram aviso. */
  esperando: number;
}

/**
 * AS QUE FICARAM ESPERANDO NUM CANAL QUE JÁ VOLTOU.
 *
 * ─── O defeito, medido numa instalação real ─────────────────────────────────
 *
 *   20:00:16  a conexão oficial sai de WORKING
 *   20:00:22  o operador manda um texto   → queued
 *   20:01:19  o operador manda um áudio   → queued
 *   20:05:01  a conexão volta
 *             ...e nada nunca as reintentou
 *
 * Duas mensagens de cliente, escritas à mão, que nunca saíram — e nada na tela
 * dizia isso. `queued` não parece erro: parece "indo".
 *
 * ─── Por que este cron não as MARCA como falha ──────────────────────────────
 *
 * Porque `queued` tem dono no canal por QR — o agent-engine reagenda, e falhar
 * a linha perderia mensagem que ia sair. A doutrina do repo está certa ali. O
 * que ela não previu é o canal cujo dono NÃO o alcança: `redriveQueued` fala um
 * transporte só e pula quem não é dele, então para o canal oficial ninguém
 * reagenda a mensagem que esperava a conexão voltar. (A que esperava porque o
 * canal pediu para DESACELERAR tem dono — `lib/messaging/reenvio-desacelerado.ts`
 * — e este aviso é a rede dela quando o pedido de nova tentativa se perde.)
 *
 * Aqui a linha não é tocada. O que muda é que ela deixa de ser invisível: se
 * está esperando há tempo demais E a conexão já voltou, alguém precisa saber —
 * porque nesse estado o motivo original não existe mais, e o único desfecho
 * possível é ninguém receber a mensagem.
 *
 * Reenviar automaticamente ficou de fora de propósito: reenviar é a decisão de
 * quem escreveu, e o texto pode não fazer mais sentido meia hora depois.
 *
 * ─── O aviso não volta sozinho ──────────────────────────────────────────────
 *
 * A linha segue `queued` depois de o operador resolver o aviso, então "não há
 * aviso aberto" não basta: a rodada seguinte recriaria o que ele acabou de
 * fechar. Quem reabre é mensagem que venceu DEPOIS do último aviso; a que venceu
 * antes já estava coberta por ele. Comparar com a CRIAÇÃO da mensagem perderia a
 * que nasceu antes do aviso e venceu depois dele.
 */
async function avisarEsperaEsquecida(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  requestId: string,
): Promise<number> {
  const corte = new Date(now.getTime() - ESPERA_ESQUECIDA_MS).toISOString();
  const teto = new Date(now.getTime() - ESPERA_TETO_MS).toISOString();

  // Da mais nova para a mais velha: com mais linhas que o limite, é a mais nova
  // que decide se o aviso reabre.
  const { data, error } = await admin
    .from("messages")
    .select(
      "id, organization_id, conversation_id, created_at, metadata, channel_sessions:channel_session_id(status)",
    )
    .eq("direction", "outbound")
    .eq("status", "queued")
    .lt("created_at", corte)
    .gte("created_at", teto)
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);

  if (error) {
    logger.warn("[recover-stuck-messages] varredura de espera falhou", {
      error: error.message,
      requestId,
    });
    return 0;
  }

  // Só as que esperam num canal que JÁ VOLTOU. Enquanto a conexão segue caída,
  // esperar é o comportamento certo e avisar seria repetir o alerta de queda.
  const esquecidas = ((data ?? []) as unknown as EsperaRow[]).filter(
    (m) => m.channel_sessions?.status === "WORKING" && vencimentoDaEspera(m) <= now.getTime(),
  );
  if (esquecidas.length === 0) return 0;

  const porOrg = new Map<string, EsperaRow[]>();
  for (const m of esquecidas) {
    porOrg.set(m.organization_id, [...(porOrg.get(m.organization_id) ?? []), m]);
  }

  let avisadas = 0;
  for (const [orgId, linhas] of porOrg) {
    const n = linhas.length;

    // Um aviso por organização: o mesmo enquanto estiver aberto, e outro só para
    // a mensagem que venceu depois dele (ver "O aviso não volta sozinho").
    const { data: ultimo, error: lerErr } = await admin
      .from("agent_inbox_items")
      .select("status, created_at")
      .eq("organization_id", orgId)
      .eq("kind", "message_send_stuck")
      .eq("title", TITULO_DA_ESPERA)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lerErr) {
      // Sem saber se já há aviso, abrir arriscaria duplicar um crítico. A rodada
      // seguinte pergunta de novo.
      logger.warn("[recover-stuck-messages] leitura do aviso de espera falhou", {
        error: lerErr.message,
        organization_id: orgId,
        requestId,
      });
      continue;
    }
    const venceuPorUltimo = Math.max(...linhas.map(vencimentoDaEspera));
    const jaCoberta = ultimo && new Date(ultimo.created_at).getTime() >= venceuPorUltimo;
    if (ultimo?.status === "open" || jaCoberta) continue;

    const { error: insErr } = await admin.from("agent_inbox_items").insert({
      organization_id: orgId,
      kind: "message_send_stuck",
      severity: "critical",
      title: TITULO_DA_ESPERA,
      body:
        `${n === 1 ? "Uma mensagem segue" : `${n} mensagens seguem`} aguardando envio, ` +
        `e a conexão já está de pé. Abra a conversa para decidir o que fazer. ` +
        `Nada foi reenviado automaticamente: o texto pode não fazer mais sentido ` +
        `depois de tanto tempo.`,
      ref_kind: "conversation",
      ref_id: linhas[0]?.conversation_id ?? null,
    });
    if (insErr) {
      logger.error("[recover-stuck-messages] aviso de espera esquecida falhou", {
        error: insErr.message,
        organization_id: orgId,
        requestId,
      });
      continue;
    }
    avisadas += n;
  }
  return avisadas;
}

/**
 * Separado do handler HTTP para o teste poder exercitar a REGRA sem montar
 * request/auth — e para o handler ficar sendo só borda.
 */
export async function recoverStuckMessages(
  admin: ReturnType<typeof createAdminClient>,
  now: Date,
  requestId: string,
): Promise<RecoverResult> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS).toISOString();

  // O corte é por `created_at`, como a regra W-12 escreve — e não por `sent_at`,
  // que é o campo que o caminho de envio reescreve. Medir a idade pela coluna
  // que outro código atualiza faria a mensagem rejuvenescer e escapar do cron.
  const { data, error } = await admin
    .from("messages")
    .select(
      "id, organization_id, conversation_id, contact_id, created_at, sent_via, contacts:contact_id(phone_number)",
    )
    .eq("direction", "outbound")
    .eq("status", "sending")
    .lt("created_at", cutoff)
    .limit(SCAN_LIMIT);

  if (error) throw new Error(`query_failed: ${error.message}`);

  const stuck = (data ?? []) as StuckMessage[];
  if (stuck.length === 0) {
    // Sair aqui seria pular a varredura de espera — e ela é o caso COMUM: o
    // normal é não haver nada preso em `sending` e haver mensagem esperando
    // num canal que já voltou. A primeira versão deste conserto tinha esse
    // buraco, e teria deixado o defeito exatamente onde estava.
    const esperando = await avisarEsperaEsquecida(admin, now, requestId);
    return { scanned: 0, failed: 0, organizations: 0, esperando };
  }

  const porOrg = new Map<string, StuckMessage[]>();
  for (const m of stuck) porOrg.set(m.organization_id, [...(porOrg.get(m.organization_id) ?? []), m]);

  const MOTIVO_DO_TIMEOUT = `Envio não confirmado em ${STUCK_AFTER_MS / 60000} min — marcada como falha por recover-stuck-messages.`;
  let marcadas = 0;
  const orgsComAviso: string[] = [];

  for (const [orgId, mensagens] of porOrg) {
    // O `.eq("status","sending")` no UPDATE É o claim atômico: se o envio
    // concluiu entre o SELECT e o UPDATE (corrida real — o ack pode chegar a
    // qualquer momento), a linha já não está `sending` e não é tocada. Sem
    // isso, este cron marcaria como falha uma mensagem que o cliente recebeu.
    const { data: updated, error: updErr } = await admin
      .from("messages")
      .update({
        status: "failed",
        error_code: "send_timeout",
        error_message: MOTIVO_DO_TIMEOUT,
        updated_at: now.toISOString(),
      })
      .in(
        "id",
        mensagens.map((m) => m.id),
      )
      .eq("organization_id", orgId)
      .eq("status", "sending")
      .select("id");

    if (updErr) {
      logger.error("[recover-stuck-messages] update falhou", {
        error: updErr.message,
        organization_id: orgId,
        requestId,
      });
      continue;
    }

    const marcadasAgora = (updated ?? []) as { id: string }[];
    const n = marcadasAgora.length;
    if (n === 0) continue; // outra rodada (ou o ack) chegou primeiro
    marcadas += n;
    orgsComAviso.push(orgId);

    // W-12 promete o evento `message.failed`. O trigger não serve: ele é AFTER
    // INSERT, então mudar o status não emite nada. Só as linhas que ESTE tick
    // realmente marcou — emitir pelas que a corrida levou seria evento de uma
    // falha que não houve.
    // O MESMO contrato do envio e do webhook da Meta (`emitirFalhaDeEntrega`,
    // #1614): quem integra assina um `message.failed` só, e a condição
    // `event.erro.codigo = send_timeout` casa aqui como casa lá.
    const porMensagem = new Map(mensagens.map((m) => [m.id, m]));
    await Promise.all(
      marcadasAgora.map(({ id }) => {
        const m = porMensagem.get(id);
        return emitirFalhaDeEntrega(admin, {
          organizationId: orgId,
          source: "recover-stuck-messages",
          requestId,
          falha: {
            message_id: id,
            conversation_id: m?.conversation_id ?? null,
            contact_id: m?.contact_id ?? null,
            contact: telefoneDoEmbed(m?.contacts),
            sent_via: m?.sent_via ?? null,
            erro: { codigo: "send_timeout", titulo: MOTIVO_DO_TIMEOUT },
          },
        });
      }),
    );

    // Um aviso por org por rodada, não um por mensagem: quando um worker cai, o
    // que trava não é uma mensagem, é o envio inteiro — N avisos idênticos
    // enterrariam a Central de avisos exatamente no dia em que ela mais precisa
    // ser lida.
    const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
      organization_id: orgId,
      kind: "message_send_stuck",
      severity: "critical",
      title:
        n === 1
          ? "Uma resposta não chegou ao cliente"
          : `${n} respostas não chegaram ao cliente`,
      body:
        `Ficaram mais de ${STUCK_AFTER_MS / 60000} minutos aguardando envio e foram marcadas como falha. ` +
        `Verifique se a conexão do WhatsApp está ativa e se o worker de envio está rodando. ` +
        `Nada foi reenviado automaticamente — reenviar sem saber a causa arrisca mandar a mesma mensagem duas vezes.`,
      ref_kind: "conversation",
      ref_id: mensagens[0]?.conversation_id ?? null,
    });
    if (inboxErr) {
      // O aviso é o que torna a falha visível; perdê-lo em silêncio recriaria o
      // defeito que este cron existe para consertar.
      logger.error("[recover-stuck-messages] aviso na Central falhou", {
        error: inboxErr.message,
        organization_id: orgId,
        requestId,
      });
    }
  }

  // A outra metade do mesmo problema: `sending` morre em silêncio, `queued`
  // espera em silêncio. Roda mesmo quando não havia nada em `sending`.
  const esperando = await avisarEsperaEsquecida(admin, now, requestId);

  return {
    scanned: stuck.length,
    failed: marcadas,
    organizations: orgsComAviso.length,
    esperando,
  };
}

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O portão abaixo é saída antecipada da ROTA INTEIRA: em instalação ociosa a
 * rota sai antes de tudo isto. `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova quando o que está de fato abaixo do portão diverge
 * desta lista — passo novo que não roda na instalação parada não pode nascer
 * sem alguém ver.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "let result",
  "try",
  "if (result.failed > 0 || result.esperando > 0)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // O PISO OCIOSO (#3731): Sem mensagem `sending` antiga não há envio travado para marcar.
  // A saída vem antes de qualquer consulta da rodada, e o portão responde de um
  // retrato em memória (`lib/cron/piso-ocioso.ts`): esta rota ia ao PostgREST a
  // cada batida só para descobrir que a fila está vazia.
  if (await recursoOcioso("mensagem_presa")) return ok({ pulado: "recurso_ocioso" }, { requestId });

  let result: RecoverResult;
  try {
    result = await recoverStuckMessages(createAdminClient(), new Date(), requestId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[recover-stuck-messages] falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to recover stuck messages.", 500, { requestId });
  }

  // Varredura que não marcou nada nem abriu aviso não é mutação e não ocupa linha
  // de auditoria (mesmo critério do snooze-watcher e do followup-flow-worker).
  if (result.failed > 0 || result.esperando > 0) {
    void audit({
      action: "message.recover_stuck_run",
      organizationId: null,
      bypassedRls: true,
      metadata: result as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
