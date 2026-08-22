/**
 * Adapter do canal intermediado — o transporte de um BSP.
 *
 * Burro como os dois irmãos: traduz formato e nada mais. Se aparecer aqui um
 * `if` sobre janela de 24h, cap diário ou horário, o desenho vazou — essas
 * regras vivem na cadeia `before_send` (doutrina `restricao-de-canal.md`).
 *
 * ─── A diferença que morde quem copia o adapter do canal oficial ────────────
 *
 * Os dois canais existentes DERIVAM o destinatário do contato: um monta o
 * chatId a partir do telefone, o outro usa o E.164 em dígitos. **Este não.**
 * Quem endereça é um id de thread que o intermediário inventa, e que chega pelo
 * webhook. Medido contra a API real, não lido da doc:
 *
 *   POST /v1/inbox/conversations/6a3580f68fcd5b3a5b946bf8/messages  → 200
 *   { success: true, data: { messageId: "wamid.HBgMNTk1...", conversationId } }
 *
 * Por isso `send` exige `providerConversationId`. Sem ele NÃO existe envio de
 * texto livre: o endpoint que aceita telefone exige template e devolve
 * `TEMPLATE_REQUIRED`, que é o caminho de reengajamento, não o de resposta.
 *
 * `resolveRecipient` continua devolvendo o telefone porque é o que identifica o
 * contato para o resto do sistema (dedup de eco, log, abertura de conversa por
 * template) — mas não é o que endereça este envio.
 *
 * ─── Duas coisas medidas na API, não supostas ───────────────────────────────
 *
 * 1. O `messageId` devolvido é um **wamid da Meta**, não um id do
 *    intermediário. É o mesmo espaço de identificador do canal oficial, então
 *    o eco do webhook casa direto e não precisa de `echoExternalIds`.
 * 2. Os dois endpoints devolvem a MESMA forma (`data.messageId`), mas com
 *    status HTTP diferentes — 201 ao abrir a conversa, 200 ao responder nela.
 *    Ler `res.ok` e não o código exato é o que faz os dois caminhos
 *    conviverem.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { FetchedMedia } from "@/lib/messaging/media/types";

import { resolveZernioCreds } from "../zernio/credentials";
import { zernioTemplateOps } from "../zernio/templates";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { zernioMediaFetchInit } from "../zernio/webhook";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

/** Só dígitos. `+595 (99) 173-3685` → `595991733685`. */
function toE164Digits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** `kind` do envelope → o par (attachmentType, voiceNote) que a API espera. */
function attachmentFields(env: OutboundEnvelope): Record<string, unknown> {
  if (!env.media) return {};
  const base: Record<string, unknown> = {
    attachmentUrl: env.media.url,
    ...(env.media.filename ? { attachmentName: env.media.filename } : {}),
    ...(env.media.caption ? { message: env.media.caption } : {}),
  };
  switch (env.kind) {
    case "image":
      return { ...base, attachmentType: "image" };
    case "video":
      return { ...base, attachmentType: "video" };
    case "audio":
      // `voiceNote: true` é o que faz virar BOLHA DE VOZ. A API aceita a flag
      // mas NÃO converte: exige ogg/opus mono, igual ao canal oficial. Mandar
      // mp3 com a flag entrega anexo de música — por isso a capability declara
      // `opus-only`, e a conversão é de quem prepara a mídia, não daqui.
      return { ...base, attachmentType: "audio", voiceNote: true };
    default:
      return { ...base, attachmentType: "file" };
  }
}

export const zernioAdapter: ChannelAdapter = {
  provider: "zernio",

  /**
   * Telefone em dígitos — é o `participantId` da API.
   *
   * Grupo devolve `null`: a API de grupos deste canal é outro recurso
   * (`/wa-groups`), com id próprio, e fingir que um chatId de grupo cabe aqui
   * mandaria a mensagem para o lugar errado.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return null;

    const doIdentity = input.waIdentity?.startsWith("phone:")
      ? input.waIdentity.slice("phone:".length)
      : null;
    const bruto = doIdentity ?? input.phoneNumber ?? null;
    if (bruto) {
      const digitos = toE164Digits(bruto);
      if (digitos.length > 0) return digitos;
    }

    // Sem telefone, devolve o id opaco da plataforma em vez de `null`.
    //
    // Medido em produção: um contato do rollout novo chega com BSUID e o envio
    // parava em `missing_phone_number` — mas para ESTE canal o telefone não
    // endereça nada. Quem endereça é a thread; `to` só existe para o handler
    // saber que há um destinatário conhecido, e um id de plataforma é um
    // destinatário conhecido.
    //
    // Devolver `null` aqui é dizer "não há como falar com esta pessoa", e é
    // falso: acabamos de receber uma mensagem dela.
    const opaco = input.waIdentity?.includes(":")
      ? input.waIdentity.slice(input.waIdentity.indexOf(":") + 1)
      : null;
    return opaco && opaco.length > 0 ? opaco : null;
  },

  /**
   * SEMPRE `true`, e isso não é preguiça: para este canal a pergunta não tem
   * resposta síncrona honesta.
   *
   * A credencial vive na SESSÃO (cifrada no banco), não no ambiente — foi a
   * decisão da 0118, para que duas organizações possam ter contas diferentes na
   * mesma instalação. `isConfigured` é síncrono e não pode consultar o banco,
   * então olhar só o env responde "não configurado" para toda instalação que
   * conectou pela tela.
   *
   * Medido em produção: o handler gravava `queued` com
   * `queued_reason: zernio_not_configured` e NUNCA chamava `send` — a mensagem
   * ficava parada no inbox, sem erro, com o canal conectado e funcionando.
   *
   * O custo de responder `true` é que `send` precisa ser quem desiste — e ele
   * LANÇA em vez de devolver `{externalId: null}`, para o handler gravar
   * `failed` com motivo em vez de um `sent` sem id, que diria "enviado" para
   * algo que nunca saiu.
   */
  isConfigured(): boolean {
    // Sempre `true`, e NÃO `zernioCredsFromEnv() !== null` — que é o que a
    // `main` trazia. Esta é uma divergência DELIBERADA, resolvida aqui a favor
    // do lado do fork, e vale registrar por quê.
    //
    // A preocupação do lado de lá é real e continua valendo: o par
    // `isConfigured() === true  ⟹  há credencial` não pode abrir, porque o
    // handler grava `status:'sent'` quando `send()` não lança. Só que quem
    // fecha esse par mudou de lugar: `send()` LANÇA `zernio_not_configured`
    // quando não acha credencial nem na sessão nem no ambiente. O caso que
    // aquele comentário descreve — "devolve `{externalId: null}` SEM lançar" —
    // não existe mais neste arquivo.
    //
    // E exigir env aqui REINTRODUZ um defeito medido: `resolveZernioCreds`
    // procura primeiro na SESSÃO (conta conectada pela tela) e só depois no
    // ambiente. Uma instalação que conectou pelo botão tem a credencial no
    // banco e nada no `.env` — com a checagem por env, `isConfigured()` diria
    // "não configurado" para um canal que está conectado e funcionando, e toda
    // mensagem ficaria parada em `queued` sem nunca tentar sair. Foi exatamente
    // esse o bug do commit "canal conectado pela tela ficava não configurado".
    //
    // O método é síncrono e não pode consultar o banco; por isso ele não é o
    // lugar de decidir. Quem decide é `send()`, que pode.
    return true;
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.kind === "contact") {
      throw new Error("zernio_contact_not_supported: envio de cartão de contato não suportado neste canal.");
    }
    const admin = createAdminClient();
    const creds = await resolveZernioCreds(admin, {
      organizationId: envelope.organizationId,
      accountId: envelope.sessionRef,
    });
    // LANÇA, não devolve null: com `isConfigured` sempre true, quem desiste é
    // este ponto — e `{externalId: null}` faria o handler gravar `sent` sem id,
    // dizendo "enviado" para algo que nunca saiu.
    if (!creds) {
      throw new Error(
        "zernio_not_configured: nenhuma credencial para esta conta (nem na sessão, nem no ambiente).",
      );
    }

    // Sem thread conhecida não há envio livre. Falhar aqui, com mensagem que
    // nomeia o motivo, é melhor que montar uma URL com `undefined` e receber um
    // 404 que ninguém consegue interpretar seis meses depois.
    if (!envelope.providerConversationId) {
      throw new Error(
        "zernio_no_conversation: envio livre exige a thread do provider; " +
          "abra a conversa com um template antes (a thread chega no webhook).",
      );
    }

    const url =
      `${creds.baseUrl}/v1/inbox/conversations/` +
      `${encodeURIComponent(envelope.providerConversationId)}/messages`;

    const body: Record<string, unknown> = {
      accountId: creds.accountId,
      ...(envelope.media ? attachmentFields(envelope) : { message: envelope.body ?? "" }),
      // ─── A CITAÇÃO ──────────────────────────────────────────────────────
      // `replyTo` recebe o id que a PLATAFORMA conhece — para WhatsApp, o
      // `wamid`. É o `external_id` da linha citada, nunca o `id` da nossa
      // tabela: o provider nunca viu o nosso. Só entra quando existe.
      ...(envelope.replyToExternalId ? { replyTo: envelope.replyToExternalId } : {}),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { messageId?: string };
      error?: string;
      code?: string;
    } | null;

    if (!res.ok || json?.success === false) {
      // O `code` do provider entra na mensagem quando existe: é ele que
      // distingue "fora da janela" de "número bloqueado" de "conta suspensa", e
      // sem isso o operador vê só "falhou".
      const detalhe = json?.code ? `${json.code}: ${json.error ?? ""}` : (json?.error ?? res.statusText);
      throw new Error(`zernio_send_failed: ${res.status} ${detalhe}`.trim());
    }

    // 201 ao abrir a conversa, 200 ao responder nela — os dois caminhos
    // devolvem a mesma forma, então quem lê não precisa saber qual foi.
    return { externalId: json?.data?.messageId ?? null };
  },

  /**
   * Manda uma definição aprovada — e, com ela, REABRE a janela de 24h.
   *
   * Vai por `POST /v1/inbox/conversations`, que é o endpoint de ABRIR conversa,
   * e não pelo de mandar mensagem numa thread. É de propósito: fora da janela a
   * thread antiga não aceita mais nada, e o provider trata "abrir com template"
   * como o caminho único de reentrada. Quando já existe conversa com o mesmo
   * destinatário, ele reaproveita em vez de duplicar (documentado no contrato
   * dele) — por isso `providerConversationId` não entra no corpo.
   *
   * `templateParams` é uma LISTA na ordem dos `{{n}}`, não um objeto: é assim
   * que a plataforma numera os valores, e mandar um mapa faria o segundo
   * parâmetro virar o primeiro na hora em que alguém renomeasse uma chave.
   */
  async sendTemplate(input: ChannelTenantScope & {
    sessionRef: string;
    to: string;
    name: string;
    language: string;
    values: Record<string, string>;
  }): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveZernioCreds(admin, {
      organizationId: input.organizationId,
      accountId: input.sessionRef,
    });
    if (!creds) {
      throw new Error(
        "zernio_not_configured: nenhuma credencial para esta conta (nem na sessão, nem no ambiente).",
      );
    }

    // `{{1}}`, `{{2}}`… viram posições. Chave que não é número fica de fora em
    // vez de entrar em ordem alfabética — ordem inventada manda o valor errado
    // para o lugar errado, e o cliente recebe o nome de outra pessoa.
    const params = Object.keys(input.values)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => input.values[k] ?? "");

    const res = await fetch(`${creds.baseUrl}/v1/inbox/conversations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: creds.accountId,
        participantId: input.to,
        templateName: input.name,
        ...(input.language ? { templateLanguage: input.language } : {}),
        ...(params.length ? { templateParams: params } : {}),
      }),
    });

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { messageId?: string };
      error?: string;
      code?: string;
    } | null;

    if (!res.ok || json?.success === false) {
      const detalhe = json?.code ? `${json.code}: ${json.error ?? ""}` : (json?.error ?? res.statusText);
      throw new Error(`zernio_template_failed: ${res.status} ${detalhe}`.trim());
    }

    return { externalId: json?.data?.messageId ?? null };
  },

  /**
   * Baixa o anexo que o cliente mandou.
   *
   * A URL do provider é endpoint AUTENTICADO, não link público: buscá-la sem o
   * Bearer devolve 401, e a plataforma descarta a mídia depois de um tempo,
   * quando passa a devolver 400. Por isso o `zernioMediaFetchInit` existe desde
   * que o canal entrou — e ficou sem um único chamador de produção, que é
   * exatamente por que a mídia recebida aqui nunca virou bytes.
   */
  async fetchInboundMedia(input: ChannelTenantScope & {
    sessionRef: string;
    url: string;
    hintMime?: string | null;
  }): Promise<FetchedMedia> {
    const admin = createAdminClient();
    const creds = await resolveZernioCreds(admin, {
      organizationId: input.organizationId,
      accountId: input.sessionRef,
    });
    if (!creds) throw new Error("zernio_not_configured: sem credencial para baixar a mídia.");

    // A URL do anexo vem do PAYLOAD do webhook, e este fetch leva a API key do
    // tenant no Authorization. Sem guarda, um payload com
    // `http://169.254.169.254/...` faz o servidor buscar metadado de nuvem —
    // e, pior que o SSRF comum, ENTREGA a credencial ao host que o payload
    // escolheu. O irmão WAHA resolve por construção
    // (`lib/messaging/media/waha-source.ts`), descartando host e porta do
    // payload; aqui não dá para reconstruir sobre uma base fixa porque o
    // provedor pode servir mídia de outro host, então vale o par que o repo
    // já usa em `lib/automation/actions/call-webhook.ts`: o textual recusa de
    // graça o que dá (esquema, http em produção, literal IPv6, faixa privada)
    // e o outro paga o DNS e julga o IP resolvido, fechando o rebinding.
    assertSafeOutboundUrl(input.url);
    await assertDestinoResolvidoSeguro(new URL(input.url).hostname);

    const res = await fetch(input.url, zernioMediaFetchInit(creds.apiKey));
    if (!res.ok) {
      // 400 costuma ser mídia já descartada pela plataforma, e 401 credencial —
      // desfechos diferentes, e o status no erro é o que distingue os dois para
      // quem for investigar depois.
      throw new Error(`zernio_media_failed: ${res.status} ${res.statusText}`.trim());
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    // O `content-type` da resposta manda sobre a dica do webhook: é o que o
    // arquivo REALMENTE é, e é ele que vai no `contentType` do upload.
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || input.hintMime || "application/octet-stream";
    return { buffer, mime };
  },

  /**
   * Pergunta ao provedor se a conta ainda está de pé.
   *
   * ─── Por que este método faltava, e o que isso custava ─────────────────────
   *
   * Só o canal por QR o implementava. O cron de saúde faz
   * `if (!adapter.checkHealth) continue` — então a sessão oficial era PULADA,
   * sem log e sem contador, e `channel_sessions.status` só era escrito no
   * momento de conectar. Resultado: chave revogada, número suspenso ou webhook
   * sem assinatura viravam silêncio absoluto, para sempre, com a tela dizendo
   * "conectado". O canal avisava dos eventos que o provedor empurra
   * (`account.disconnected`, `number.suspended`); cego mesmo ele era para a
   * falha CALADA, que é justamente a que ninguém percebe.
   *
   * Reusa a MESMA chamada da validação de credencial (`GET /v1/accounts`), com
   * o mesmo casamento de conta (`_id ?? id`) — medido contra a API, não lido da
   * doc: o endpoint por id aceita só `PUT` e responde 405 ao GET.
   *
   * ─── Os quatro desfechos, e por que a diferença importa ────────────────────
   *
   *   401/403      → a chave foi recusada. É FAILED: a credencial existe e não
   *                  vale mais, que é exatamente a falha calada que se procura.
   *   conta ausente→ a chave presta mas não alcança mais esta conta. STOPPED:
   *                  a sessão não existe mais do lado de lá.
   *   respondeu ok → WORKING.
   *   qualquer erro→ NÃO sabemos. `reachable: false`, sem status. Inventar um
   *                  faria uma oscilação de rede virar "canal caído", e o
   *                  operador aprenderia a ignorar o aviso — que é pior que não
   *                  ter aviso nenhum.
   */
  async checkHealth(
    input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    const admin = createAdminClient();
    const creds = await resolveZernioCreds(admin, {
      organizationId: input.organizationId,
      accountId: input.sessionRef,
    });
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    let res: Response;
    try {
      // Teto de espera: sem ele, um provedor que pendura a conexão pendura o
      // cron junto, e a varredura de saúde deixa de rodar para TODAS as sessões.
      res = await fetch(`${creds.baseUrl}/v1/accounts`, {
        headers: { Authorization: `Bearer ${creds.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: null, detail: detail.slice(0, 200) };
    }

    if (res.status === 401 || res.status === 403) {
      return { reachable: true, status: "FAILED", detail: null };
    }
    if (!res.ok) {
      return { reachable: false, status: null, detail: `provedor_respondeu_${res.status}` };
    }

    const json = (await res.json().catch(() => null)) as {
      accounts?: Record<string, unknown>[];
    } | null;
    const contas = Array.isArray(json?.accounts) ? json.accounts : [];
    const conta = contas.find((c) => String(c._id ?? c.id) === creds.accountId) ?? null;

    return conta
      ? { reachable: true, status: "WORKING", detail: null }
      : { reachable: true, status: "STOPPED", detail: null };
  },

  /** Gestão das definições aprovadas — ver `../zernio/templates.ts`. */
  templates: zernioTemplateOps,

  codes: {
    notConfigured: "zernio_not_configured",
    sendFailed: "zernio_error",
    unknownError: "zernio_unknown",
  },
};
