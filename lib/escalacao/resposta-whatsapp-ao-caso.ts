/** Resposta do número interno ao caso da IA, sem criar contato/conversa. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import {
  ehNumeroInternoDeAviso,
  lerNumeroInternoDeAviso,
  registrarMensagemIgnorada,
  type ChatIdentidade,
} from "./numero-interno-de-aviso";
import { logger } from "@/lib/logger";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { audit } from "@/lib/audit";

const RESPOSTA = /^(RESPONDER|PERGUNTAR)\s+([0-9a-f-]{36})\s+([\s\S]+)$/i;
const CasoId = z.string().uuid();

export type ResultadoDeRespostaWhatsApp = "accepted" | "duplicate" | "unavailable" | "malformed" | null;

export type ComandoDeRespostaDoSuporte = {
  caseId: string;
  action: "resolved" | "need_lead_info";
  body: string;
};

/** O formato é explícito para que uma mensagem não resolva o caso errado. */
export function parseComandoDeRespostaDoSuporte(
  texto: string | null | undefined,
): ComandoDeRespostaDoSuporte | null {
  if (!texto) return null;
  const m = RESPOSTA.exec(texto.trim());
  if (!m) return null;
  const caseId = CasoId.safeParse(m[2]);
  const action = m[1]?.toUpperCase();
  const body = m[3]?.trim() ?? "";
  if (!caseId.success || !action || body.length === 0 || body.length > 4000) return null;
  return {
    caseId: caseId.data,
    action: action === "PERGUNTAR" ? "need_lead_info" : "resolved",
    body,
  };
}

/**
 * Intercepta apenas mensagens do telefone que recebeu avisos. Todo o resto
 * segue pelo ingestor normal. O RPC valida canal, destino e entrega do caso na
 * mesma transação em que grava a resposta e enfileira a retomada da IA.
 */
export async function consumirRespostaDoSuporteNoWhatsApp(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    channelSessionId: string;
    identidade: ChatIdentidade;
    direction: "inbound" | "outbound";
    texto: string | null;
    externalId: string;
  },
): Promise<boolean> {
  const { consumed } = await consumirComResultado(admin, entrada);
  return consumed;
}

export async function consumirComResultado(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    channelSessionId: string;
    identidade: ChatIdentidade;
    direction: "inbound" | "outbound";
    texto: string | null;
    externalId: string;
  },
): Promise<{ consumed: boolean; result: ResultadoDeRespostaWhatsApp }> {
  const interno = await ehNumeroInternoDeAviso(
    admin,
    entrada.organizationId,
    entrada.identidade,
  );
  if (!interno) return { consumed: false, result: null };
  // `ehNumeroInternoDeAviso` já memoiza a leitura; reusar o valor permite
  // consultar o opt-in sem uma segunda ida ao banco e mantém os ingestores que
  // só precisam do corte compatíveis com seus mocks/integrações.
  const config = await lerNumeroInternoDeAviso(admin, entrada.organizationId);
  // O corte acima já provou que é o número de avisos. Em modo privacidade
  // (`@lid`) o telefone vem do `remoteJidAlt` do payload, que o ingestor põe em
  // `identidade.phone`; só quando ele falta e o `@lid` casou pelo `destino_jid`
  // gravado o remetente é tomado como o próprio número cadastrado. O transporte
  // do aviso resolve o destino por telefone, então esse segundo caminho é raro.
  const phone = entrada.identidade.phone ??
    (entrada.identidade.kind === "lid" ? config.destino : null);

  // Comando só vale na conexão que ENVIA os avisos. Fora dela (o número de
  // vendas, por exemplo) a mensagem segue o corte de antes: ignorada e contada,
  // sem RPC e sem resposta — uma confirmação ali gastaria o ritmo anti-banimento
  // do número de clientes e ensinaria o comando a quem não devia.
  if (!config.respostaWhatsappHabilitada || config.sessaoId !== entrada.channelSessionId) {
    await registrarMensagemIgnorada(admin, entrada.organizationId, {
      direction: entrada.direction,
      sessionId: entrada.channelSessionId,
    });
    return { consumed: true, result: null };
  }

  const comando = entrada.direction === "inbound"
    ? parseComandoDeRespostaDoSuporte(entrada.texto)
    : null;
  if (!comando || !phone || !entrada.externalId) {
    await registrarMensagemIgnorada(admin, entrada.organizationId, {
      direction: entrada.direction,
      sessionId: entrada.channelSessionId,
    });
    if (entrada.direction === "inbound" && phone && entrada.externalId &&
        /^(RESPONDER|PERGUNTAR)(?:\s|$)/i.test(entrada.texto?.trim() ?? "")) {
      await enviarConfirmacao(admin, entrada, config, "malformed");
    }
    return {
      consumed: true,
      result: entrada.direction === "inbound" && /^(RESPONDER|PERGUNTAR)(?:\s|$)/i.test(entrada.texto?.trim() ?? "")
        ? "malformed"
        : null,
    };
  }

  let data: unknown;
  let error: { message: string } | null;
  try {
    const resposta = await admin.rpc("fn_responder_caso_por_whatsapp" as never, {
      p_org: entrada.organizationId,
      p_case: comando.caseId,
      p_session: entrada.channelSessionId,
      p_phone_variants: phoneLookupVariants(phone),
      p_action: comando.action,
      p_body: comando.body,
      p_message_key: `${entrada.channelSessionId}:${entrada.externalId}`,
    } as never);
    data = resposta.data;
    error = resposta.error;
  } catch (err) {
    data = null;
    error = { message: err instanceof Error ? err.message : String(err) };
  }
  if (error) {
    logger.warn("[case-reply-whatsapp] RPC falhou; ingestão segue e a mensagem interna não vira conversa", {
      organizationId: entrada.organizationId,
      channelSessionId: entrada.channelSessionId,
      causa: error.message,
    });
    await registrarMensagemIgnorada(admin, entrada.organizationId, {
      direction: entrada.direction,
      sessionId: entrada.channelSessionId,
    });
    return { consumed: true, result: null };
  }

  const resultado = typeof data === "string" ? data : null;
  if (resultado === "accepted") {
    // Sem usuário: quem respondeu não tem login no CRM. A origem vai no metadata.
    await audit({
      action: "ai.case_replied",
      actorUserId: null,
      organizationId: entrada.organizationId,
      resourceType: "agent_case",
      resourceId: comando.caseId,
      metadata: {
        case_action: comando.action,
        source: "whatsapp",
        channel_session_id: entrada.channelSessionId,
      },
    });
    await enviarConfirmacao(admin, entrada, config, "accepted");
    return { consumed: true, result: "accepted" };
  } else if (resultado === "case_unavailable") {
    await enviarConfirmacao(admin, entrada, config, "unavailable");
    return { consumed: true, result: "unavailable" };
  } else if (resultado !== "duplicate") {
    await registrarMensagemIgnorada(admin, entrada.organizationId, {
      direction: entrada.direction,
      sessionId: entrada.channelSessionId,
    });
  }
  return { consumed: true, result: resultado === "duplicate" ? "duplicate" : null };
}

async function enviarConfirmacao(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    channelSessionId: string;
    identidade: ChatIdentidade;
  },
  config: { destino: string | null },
  tipo: "accepted" | "unavailable" | "malformed",
): Promise<void> {
  try {
    const [{ criarTransporteDoAviso }, { criarPacingDoCanal }] = await Promise.all([
      import("@/lib/escalacao/aviso-ao-suporte.handler"),
      import("@/lib/agent-engine/pacing/ledger-supabase"),
    ]);
    const telefone = config.destino;
    if (!telefone) return;
    const transporte = await criarTransporteDoAviso(admin as never);
    const agora = new Date();
    const canal = {
      id: entrada.channelSessionId,
      status: "WORKING",
      archived_at: null,
      aceitaMensagemLivre: true,
    } as Parameters<Awaited<ReturnType<typeof criarTransporteDoAviso>>["configurado"]>[1];
    if (!(await transporte.configurado(entrada.organizationId, canal))) return;
    const destino = await transporte.resolveDestino(
      entrada.organizationId,
      canal,
      telefone,
    );
    if (!destino) return;
    const pacing = await criarPacingDoCanal(admin);
    const decisao = await pacing.decide(entrada.organizationId, entrada.channelSessionId, agora);
    if (!decisao.liberado) return;
    const frases = {
      accepted: "Recebido. A IA vai seguir com o cliente.",
      unavailable: "Não consegui: esse caso já foi respondido ou não existe.",
      malformed: "Formato: RESPONDER <id> <orientação> ou PERGUNTAR <id> <pergunta>.",
    };
    const { data: idiomaData } = await admin
      .from("organizations")
      .select("locale")
      .eq("id", entrada.organizationId)
      .maybeSingle();
    const idioma = normalizarIdioma((idiomaData as { locale?: string | null } | null)?.locale ?? null);
    const body = traduzir(frases[tipo], idioma);
    await transporte.envia(entrada.organizationId, canal, destino, body);
    await pacing.registraEnvio(entrada.organizationId, entrada.channelSessionId, agora);
  } catch (err) {
    logger.warn("[case-reply-whatsapp] não foi possível enviar confirmação", {
      organizationId: entrada.organizationId,
      channelSessionId: entrada.channelSessionId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
}
