/**
 * contact-phones — descobre o telefone por trás da identidade opaca.
 *
 * ─── O problema ────────────────────────────────────────────────────────────
 *
 * O WhatsApp passou a identificar quem escreve por um id opaco em vez do
 * número. Medido numa instalação real: 52 de 54 contatos sem telefone. O
 * atendente abre a conversa e não sabe para quem está falando — e ligar, mandar
 * boleto ou conferir cadastro deixa de ser possível a partir do CRM.
 *
 * Escrever CONTINUA funcionando sem o número (o canal endereça pelo id opaco),
 * e é por isso que o defeito passa despercebido: nada quebra, só falta.
 *
 * ─── Por que um cron, e não na entrada ─────────────────────────────────────
 *
 * A tabela de tradução do canal é povoada por ATIVIDADE: nasce vazia e enche
 * conforme as conversas acontecem. Perguntar no webhook responderia "não sei"
 * para quase todo mundo, uma vez só, e nunca mais. Aqui a pergunta se repete —
 * e a resposta chega quando o canal aprender.
 *
 * ─── Duas regras herdadas do cron de fotos, e não por simetria ─────────────
 *
 * 1. `is_anonymized = false` é OBRIGATÓRIO, não filtro de eficiência. Sem ele,
 *    um contato anonimizado por pedido LGPD voltaria a ser varrido e o cron
 *    REESCREVERIA o telefone dele — reintroduzindo sozinho, periodicamente, o
 *    dado pessoal que acabara de ser apagado. Aparece também no UPDATE, e ali
 *    fecha uma corrida: entre selecionar o lote e gravar há I/O de rede por
 *    contato, e a anonimização em escopo de tenant percorre centenas enquanto
 *    isto roda.
 *
 * 2. Carimba MESMO sem resposta. Sem isso os mesmos primeiros N voltariam em
 *    toda rodada, para sempre, e os do fim da fila nunca seriam perguntados.
 *
 * Auth: Bearer INTERNAL_SECRET (fail-closed), igual aos demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { logger } from "@/lib/logger";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";

export const dynamic = "force-dynamic";

/** Contatos por invocação. Cada um é uma chamada de rede ao canal. */
const SCAN_LIMIT = 40;
/**
 * Revisita quem já foi perguntado a cada 3 dias.
 *
 * Não é "toda hora": a tabela do canal enche devagar, e insistir de minuto em
 * minuto gastaria chamada para receber o mesmo `null`. Também não é "nunca
 * mais": a resposta MUDA com o tempo, e um contato perguntado no dia em que a
 * tabela estava vazia merece nova chance.
 */
const RETRY_AFTER_DAYS = 3;

interface ContactRow {
  id: string;
  organization_id: string;
  wa_identity: string | null;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - RETRY_AFTER_DAYS * 86_400_000).toISOString();

  const { data: contatos, error: queryError } = await admin
    .from("contacts")
    .select("id, organization_id, wa_identity")
    .is("phone_number", null)
    .not("wa_identity", "is", null)
    .eq("is_anonymized", false)
    .or(`phone_lookup_at.is.null,phone_lookup_at.lt.${cutoff}`)
    // Quem nunca foi perguntado entra antes de quem só está desatualizado — o
    // contato que nunca teve número incomoda mais que o que já foi tentado.
    .order("phone_lookup_at", { ascending: true, nullsFirst: true })
    .limit(SCAN_LIMIT);

  if (queryError) {
    logger.error("[contact-phones] query failed", { detail: queryError.message, requestId });
    return fail("internal_error", queryError.message, 500, { requestId });
  }

  const rows = (contatos ?? []) as ContactRow[];
  let resolvidos = 0;
  let semResposta = 0;
  let semCanal = 0;

  for (const c of rows) {
    const carimbar = async (phone: string | null): Promise<boolean> => {
      const { data: afetadas } = await admin
        .from("contacts")
        .update({
          ...(phone ? { phone_number: canonicalPhoneBR(phone) } : {}),
          phone_lookup_at: new Date().toISOString(),
        })
        .eq("id", c.id)
        .eq("organization_id", c.organization_id)
        .eq("is_anonymized", false)
        // Só preenche o que está VAZIO: entre a seleção e esta gravação o
        // contato pode ter ganhado número por outra via (webhook do canal
        // oficial, edição na tela), e sobrescrever apagaria o dado mais fresco
        // por um que já era velho quando o lote foi montado.
        .is("phone_number", null)
        .select("id");
      return (afetadas ?? []).length > 0;
    };

    // A sessão DESTE contato — pela conversa dele, não uma qualquer da org.
    //
    // Medido em produção: com dois canais ligados, pegar "a primeira sessão
    // WORKING da organização" escolheu a errada e os 40 contatos do lote caíram
    // em "sem canal". Eles são de um canal; a sessão sorteada era do outro, que
    // nem sabe traduzir identidade opaca. O vínculo certo está na conversa.
    //
    // As COLUNAS do ref vêm do seam, não escritas aqui: cada canal guarda o seu
    // identificador numa coluna própria, e nomeá-la faria este cron saber com
    // quem fala — o que o invariante 1 da doutrina proíbe, e o `lint:channels`
    // reprovou na primeira versão deste arquivo.
    const { data: conversa } = await admin
      .from("conversations")
      .select(`channel_sessions:channel_session_id (${CHANNEL_SESSION_REF_COLUMNS}, status, archived_at)`)
      .eq("organization_id", c.organization_id)
      .eq("contact_id", c.id)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const sessaoDaConversa = (conversa as { channel_sessions?: unknown } | null)?.channel_sessions as
      | (ChannelSessionRef & { status: string | null; archived_at: string | null })
      | null
      | undefined;

    // Canal arquivado ou fora do ar não responde — carimba e tenta depois.
    const s =
      sessaoDaConversa && !sessaoDaConversa.archived_at && sessaoDaConversa.status === "WORKING"
        ? (sessaoDaConversa as ChannelSessionRef)
        : null;
    const sessionRef = s ? resolveSessionRef(s) : null;
    if (!s || !sessionRef) {
      await carimbar(null);
      semCanal++;
      continue;
    }

    // Pergunta ao CANAL, não ao provider: quem sabe traduzir implementa o
    // método; quem não sabe simplesmente não o tem, e o cron segue adiante.
    const adapter = getAdapter((s.provider ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider);
    if (!adapter.resolvePhoneForIdentity || !c.wa_identity) {
      await carimbar(null);
      semCanal++;
      continue;
    }

    let phone: string | null = null;
    try {
      phone = await adapter.resolvePhoneForIdentity({
        organizationId: c.organization_id,
        sessionRef,
        identity: c.wa_identity,
      });
    } catch (err) {
      // Falha de rede não é "não existe": carimba e tenta de novo no ciclo
      // seguinte, sem derrubar o lote inteiro por um contato.
      logger.warn("[contact-phones] lookup falhou", {
        contactId: c.id,
        detail: err instanceof Error ? err.message : "erro",
        requestId,
      });
    }

    const gravou = await carimbar(phone);
    if (phone && gravou) resolvidos++;
    else semResposta++;
  }

  return ok(
    { varridos: rows.length, resolvidos, sem_resposta: semResposta, sem_canal: semCanal },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
