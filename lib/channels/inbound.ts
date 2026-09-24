import { ingestSocialInbound, socialPayloadBelongsToSession } from "./social/ingest";
import { CHANNEL_PROVIDER_SOCIAL } from "./capabilities";
/**
 * Entrada de webhook, do lado de dentro do seam.
 *
 * A rota não pode saber QUAL canal é — o invariante 1 da doutrina proíbe, e o
 * `lint:channels` reprovou a primeira versão desta rota exatamente por isso,
 * que é a catraca funcionando. Então a rota entrega o que sabe (a sessão, o
 * corpo cru, o header de assinatura) e recebe um desfecho; toda a decisão
 * específica de canal mora aqui.
 *
 * Um canal seguinte entra com um `case` neste arquivo e zero linhas na rota.
 *
 * ─── Por que a assinatura é verificada AQUI, e não na rota ──────────────────
 *
 * Porque o esquema é do canal: header, algoritmo e formato mudam por provider
 * (um assina SHA-512 com um nome de header, outro SHA-256 com outro). Uma rota
 * que verificasse teria que perguntar de quem é o payload — o `if (provider ===
 * ...)` que a doutrina existe para impedir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHANNEL_PROVIDER_DATAFY, CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import { canalGraphParceiroLigado } from "./graph-parceiro/credentials";
import { graphPartnerRefsDaSessao } from "./graph-parceiro/session";
import {
  HEADER_ASSINATURA,
  HEADER_TIMESTAMP,
  verifyGraphPartnerSignature,
} from "./graph-parceiro/webhook";
import { sincronizarSaudeDaConexao } from "./health";
import { lerEnvelopeMeta } from "./meta/envelope";
import { ingestMetaInbound } from "./meta/ingest";
import { parseMetaWebhook } from "./meta/webhook";
import {
  atualizarEspelhoDoTemplate,
  avisoDoEvento,
  registrarAviso,
  saudeDoEvento,
} from "./zernio/avisos";
import { aplicarEdicaoZernio, ingestZernioInbound } from "./zernio/ingest";
import { lerEnvelopeZernio } from "./zernio/envelope";
import { parseZernioEdicao, verifyZernioSignature } from "./zernio/webhook";
import type { ChannelProvider } from "./types";

/** Curto demais para ser segredo — placeholder ou lixo de decrypt. */
const MIN_SECRET_LEN = 16;

export interface InboundWebhookInput {
  session: {
    id: string;
    organization_id: string;
    provider: string;
    /** Como o operador chama esta conexão. Entra no título do aviso: com dois
     *  números ligados, "WhatsApp fora do ar" não diz QUAL. */
    display_name?: string | null;
    phone_number?: string | null;
  };
  rawBody: string;
  /** Todos os headers da requisição — cada canal lê o SEU. */
  headers: Headers;
  /** Segredo já decifrado pela rota, ou null quando não foi possível. */
  secret: string | null;
}

export type InboundWebhookOutcome =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false;
      /**
       * `contrato_violado` é distinto de `invalid_json` de propósito: um diz
       * que o corpo não é JSON, o outro que é JSON com um campo do tipo errado.
       * Quem investiga procura em lugares diferentes, e o segundo significa que
       * o fio mudou — a única causa possível num payload que passou pelo HMAC.
       */
      code: "unauthorized" | "provider_mismatch" | "invalid_json" | "contrato_violado";
      message: string;
    };

/**
 * Este canal sabe receber webhook? Perguntado pela rota ANTES de qualquer
 * trabalho — e respondido sem nomear provider do lado de fora.
 */
export function acceptsInboundWebhook(provider: string): boolean {
  // O canal Datafy é opcional da instalação: desligado, a entrada dele não
  // existe — nem para quem tem o token de uma sessão gravada antes.
  if (provider === CHANNEL_PROVIDER_DATAFY) return canalGraphParceiroLigado();
  return provider === CHANNEL_PROVIDER_ZERNIO || provider === CHANNEL_PROVIDER_SOCIAL;
}

/** Authenticate before archiving raw payloads. The handler repeats this guard for non-HTTP callers. */
export function verifyInboundWebhookSignature(provider: string, raw: string, headers: Headers, secret: string | null): boolean {
  if (!acceptsInboundWebhook(provider) || !secret || secret.length < MIN_SECRET_LEN) return false;
  // Cada canal assina do seu jeito; o esquema do Datafy está em `graph-parceiro/webhook`.
  if (provider === CHANNEL_PROVIDER_DATAFY) {
    return verifyGraphPartnerSignature(raw, headers.get(HEADER_ASSINATURA), headers.get(HEADER_TIMESTAMP), secret);
  }
  return verifyZernioSignature(raw, headers.get("x-zernio-signature"), secret);
}

export async function inboundPayloadBelongsToSession(admin: SupabaseClient, input: InboundWebhookInput): Promise<boolean> {
  return input.session.provider !== CHANNEL_PROVIDER_SOCIAL || socialPayloadBelongsToSession(
    admin, input.session.organization_id, input.session.id, input.rawBody,
  );
}

export async function handleInboundWebhook(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  const provider = input.session.provider as ChannelProvider;

  switch (provider) {
    case CHANNEL_PROVIDER_SOCIAL:
    case CHANNEL_PROVIDER_ZERNIO:
      return zernioInbound(admin, input);
    case CHANNEL_PROVIDER_DATAFY:
      return datafyInbound(admin, input);
    default:
      // Token de um canal que não entra por aqui. É configuração trocada, não
      // ataque — mas processar seria ler o payload com o parser errado.
      return { ok: false, code: "provider_mismatch", message: "canal não recebe por esta rota" };
  }
}

async function zernioInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  // Fail-closed, sem a exceção que virou regra no canal por QR: lá, "não
  // consegui verificar" virava "processa assim mesmo", e isso deixou toda
  // instalação aceitando mensagem forjada de quem soubesse a URL. Este provider
  // assina sempre, então não há dilema a herdar.
  if (!input.secret || input.secret.length < MIN_SECRET_LEN) {
    return { ok: false, code: "unauthorized", message: "webhook_secret_unavailable" };
  }

  const assinatura = input.headers.get("x-zernio-signature");
  if (!verifyZernioSignature(input.rawBody, assinatura, input.secret)) {
    return { ok: false, code: "unauthorized", message: "bad_signature" };
  }

  // ─── O contrato do fio, ANTES de qualquer leitura ─────────────────────────
  //
  // Aqui o payload era `unknown` e cada leitor se defendia sozinho com `str()`,
  // que devolve `null` para o que não é string. Nunca estourava — e era esse o
  // problema: um `conversationId` numérico virava `null`, o parser devolvia
  // `null`, e a rota respondia 200 `evento_sem_interesse`, exatamente como
  // responde a um evento que de fato não interessa. A mensagem do cliente sumia
  // com carimbo de normalidade.
  //
  // A recusa nomeia os CAMPOS e nunca os valores (dado de cliente), e a rota a
  // fecha no arquivo do webhook com `status: "error"` — onde alguém procura.
  const leitura = lerEnvelopeZernio(input.rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, code: "invalid_json", message: "invalid_json" };
    }
    return {
      ok: false,
      code: "contrato_violado",
      message: `payload fora do contrato do canal: ${leitura.campos.join(", ")}`,
    };
  }
  const payload = leitura.envelope;
  if (input.session.provider === CHANNEL_PROVIDER_SOCIAL) {
    const result = await ingestSocialInbound(admin, input.session.organization_id, input.session.id, payload);
    return { ok: true, body: { ...result } };
  }

  // ─── O que a plataforma decide sozinha ───────────────────────────────────
  //
  // Revisão de modelo e mudança de estado do número não são mensagens, mas são
  // o tipo de coisa que só se descobre no disparo que não sai — com a campanha
  // montada e o cliente esperando. Vira aviso na Central, onde o humano já
  // procura o que está errado.
  const aviso = avisoDoEvento(payload);
  if (aviso) {
    // O espelho local também: o aviso empurra para olhar, e a tela de modelos
    // precisa mostrar o estado novo. Ver o estado velho depois de ler o aviso é
    // pior que não ter avisado.
    const espelhado = await atualizarEspelhoDoTemplate(
      admin,
      input.session.organization_id,
      payload,
      input.session.id,
    );

    // ─── Evento de CONEXÃO passa pelo vigia, não por um insert cru ──────────
    //
    // `sincronizarSaudeDaConexao` é quem grava o episódio, carimba
    // `ref_kind`+`ref_id` no ítem e — a metade que faltava — RESOLVE o aviso
    // quando a conta volta. Chamando `registrarAviso` direto, o crítico ficava
    // aberto para sempre e a reconexão abria um `info` novo ao lado dele.
    //
    // Um caminho só: quem entra aqui NÃO passa também pelo insert cru, senão a
    // Central mostraria o mesmo problema duas vezes.
    const saude = saudeDoEvento(payload);
    if (saude) {
      const desfecho = await sincronizarSaudeDaConexao(
        admin,
        // O `status` que vai para `channel_session_health` é o OBSERVADO agora,
        // não o guardado: quem acabou de falar foi o provedor, e a linha do
        // episódio serve justamente para registrar o que ele disse.
        { id: input.session.id, organization_id: input.session.organization_id, status: saude.status },
        saude,
        // O APELIDO da conexão, não o texto do evento. Passar `aviso.title` aqui
        // produzia `WhatsApp "Número SUSPENSO — não é possível enviar." fora do
        // ar (FAILED)`: título quebrado que não identifica a conexão — exatamente
        // o que o apelido existe para resolver. E fica gravado na linha.
        input.session.display_name ?? input.session.phone_number ?? "sem nome",
        // Empurrão do provedor: ele é a autoridade sobre o estado do NÚMERO, e
        // por isso a varredura não fecha o que ele abriu.
        "empurrao",
      );
      return { ok: true, body: { status: "saude", kind: aviso.kind, desfecho, espelhado } };
    }

    const desfecho = await registrarAviso(admin, input.session.organization_id, aviso);
    return { ok: true, body: { status: "aviso", kind: aviso.kind, desfecho, espelhado } };
  }

  // ─── Edição e apagamento ────────────────────────────────────────────────
  //
  // Vêm ANTES da ingestão, como os avisos: são correções de linha que já
  // existe, não mensagens novas. Deixá-los cair no `ingest` faria uma edição
  // criar uma conversa do nada, com um texto sem nada antes dele.
  const edicao = parseZernioEdicao(payload);
  if (edicao) {
    const desfecho = await aplicarEdicaoZernio(admin, input.session.organization_id, edicao);
    return { ok: true, body: { status: "edicao", tipo: edicao.tipo, desfecho } };
  }

  const r = await ingestZernioInbound(admin, {
    organizationId: input.session.organization_id,
    channelSessionId: input.session.id,
    payload,
  });
  return { ok: true, body: { ...r } };
}

/**
 * Entrada do canal Datafy (recorte do #1130, @vgamkt).
 *
 * O payload é IDÊNTICO ao da Meta (o parceiro espelha a Cloud API), então a
 * leitura reusa `lerEnvelopeMeta` + `parseMetaWebhook` + `ingestMetaInbound`; o
 * que é do parceiro é só a assinatura, conferida de novo aqui porque esta
 * função também é chamada fora da rota.
 *
 * Fail-closed: sem o segredo `whsec_` gravado, nada entra. O evento só é aceito
 * se for do número e da conta DESTA sessão — a sessão veio do token do path, e
 * o corpo não escolhe onde gravar.
 */
async function datafyInbound(
  admin: SupabaseClient,
  input: InboundWebhookInput,
): Promise<InboundWebhookOutcome> {
  if (!verifyInboundWebhookSignature(input.session.provider, input.rawBody, input.headers, input.secret)) {
    return { ok: false, code: "unauthorized", message: "bad_signature" };
  }

  const leitura = lerEnvelopeMeta(input.rawBody);
  if (!leitura.ok) {
    if (leitura.motivo === "json_invalido") {
      return { ok: false, code: "invalid_json", message: "invalid_json" };
    }
    return {
      ok: false,
      code: "contrato_violado",
      message: `payload fora do contrato do canal: ${leitura.campos.join(", ")}`,
    };
  }

  const orgId = input.session.organization_id;
  const refs = await graphPartnerRefsDaSessao(admin, orgId, input.session.id);
  const eventos = parseMetaWebhook(leitura.envelope);
  const desfechos: string[] = [];
  const agora = new Date().toISOString();

  for (const e of eventos) {
    // Mesma régua da rota do canal oficial: evento carimbado com outra conta é
    // de outra sessão, e ignorá-lo é o certo (200, para o provedor não repetir).
    if (refs.wabaId && e.wabaId && e.wabaId !== refs.wabaId) {
      desfechos.push("outra_conta");
      continue;
    }
    if (e.kind === "inbound_message") {
      if (e.phoneNumberId !== refs.phoneNumberId) {
        desfechos.push("outro_numero");
        continue;
      }
      const r = await ingestMetaInbound(admin, e, {
        organizationId: orgId,
        channelSessionId: input.session.id,
      });
      desfechos.push(r.status);
      continue;
    }
    if (e.kind === "message_status") {
      await admin
        .from("messages")
        .update({ status: e.status === "failed" ? "failed" : "sent", updated_at: agora })
        .eq("organization_id", orgId)
        .eq("external_id", e.externalId);
      desfechos.push("status");
      continue;
    }
    if (e.kind === "template_status") {
      // A revisão da plataforma decide depois da criação: sem isto a definição
      // ficava PENDING no espelho até alguém clicar em Sincronizar, e o seletor
      // do inbox não a oferecia. Escopo pela CONEXÃO desta entrega — a coluna
      // `waba_id` do espelho deste canal guarda o número, não a conta.
      const { error } = await admin
        .from("meta_templates")
        .update({ status: e.event, rejected_reason: e.reason, updated_at: agora })
        .eq("organization_id", orgId)
        .eq("channel_session_id", input.session.id)
        .eq("name", e.templateName)
        .eq("language", e.templateLanguage);
      desfechos.push(error ? "modelo_nao_atualizado" : "modelo");
      continue;
    }
    desfechos.push("ignorado");
  }

  return { ok: true, body: { received: eventos.length, outcomes: desfechos } };
}
