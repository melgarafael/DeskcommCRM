/**
 * Entrada do canal intermediado — verificação de assinatura e leitura do
 * payload.
 *
 * PURO de propósito: nada aqui toca banco, rede ou relógio. A rota faz o
 * efeito; aqui só se decide *o que o payload diz*. É o que permite provar o
 * caso difícil (assinatura errada, campo ausente, identidade sem telefone) sem
 * subir infraestrutura.
 *
 * ─── Por que este módulo é o que destrava o envio ───────────────────────────
 *
 * O `conversationId` do provider NÃO se deriva do contato: ele o inventa e o
 * entrega AQUI. `conversations.provider_conversation_id` só existe porque este
 * webhook o traz — sem gravá-lo, responder dentro da janela de 24h fica
 * impossível, porque o endpoint que aceita telefone exige template.
 *
 * ─── A identidade em transição (rollout BSUID, abril/2026) ──────────────────
 *
 * A doc do provider é explícita: quem adota um *username* pode escrever à
 * empresa **sem expor telefone**, e aí `phoneNumber` vem ausente. O anchor
 * recomendado passa a ser o `businessScopedUserId`. Ler só o telefone
 * funcionaria hoje e criaria contato órfão amanhã — por isso a resolução de
 * identidade tem ordem explícita e devolve QUAL âncora usou, para quem grava
 * saber o que está guardando.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Localizacao } from "@/lib/messaging/localizacao";

/** Assinatura HMAC-SHA256 no header `X-Zernio-Signature`. */
export function verifyZernioSignature(
  rawBody: string,
  headerValue: string | null,
  secret: string,
): boolean {
  // Sem segredo configurado NÃO é "passa": é "não dá para verificar". Deixar
  // passar transformaria a rota num endpoint público que escreve no banco de
  // quem instalou. Quem decide seguir sem verificação faz isso explicitamente
  // na rota, não por omissão aqui.
  if (!secret || !headerValue) return false;

  const got = headerValue.startsWith("sha256=") ? headerValue.slice(7) : headerValue;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  // Comparação de tempo constante, e comprimento conferido ANTES:
  // `timingSafeEqual` lança quando os buffers têm tamanhos diferentes, e um
  // throw aqui viraria 500 em vez de 401 — o atacante aprenderia pelo código
  // de status o que não deveria.
  const a = Buffer.from(got, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** O que este evento pede que se faça com a mensagem. */
export type ZernioEventKind =
  /** Mensagem nova — do cliente ou nossa, vinda de fora do CRM. */
  | "message"
  /** Só mudou o desfecho de uma mensagem que já existe. */
  | "status";

export interface ZernioInboundMessage {
  /** De quem partiu. `outbound` cobre envio feito FORA do CRM. */
  direction: "inbound" | "outbound";
  /** `message` grava; `status` só atualiza o desfecho do que já existe. */
  kind: ZernioEventKind;
  /** Desfecho declarado pelo evento de status (`sent`/`delivered`/`read`/`failed`). */
  status?: "sent" | "delivered" | "read" | "failed";
  /** Motivo, quando o evento é de falha — é o que explica ao operador. */
  errorReason?: string | null;
  /** Id da THREAD no provider — o que endereça o envio livre depois. */
  conversationId: string;
  /** Id da mensagem na plataforma (wamid) — chave de idempotência. */
  externalId: string;
  /** Conta conectada que recebeu — casa com `channel_sessions.zernio_account_id`. */
  accountId: string | null;
  text: string | null;
  attachments: { type: string; url: string }[];
  sentAt: string | null;
  identity: ZernioIdentity;
  /**
   * O objeto `referral` do evento, cru — presente quando a conversa começou
   * por um clique em anúncio "Clique para o WhatsApp" da Meta. Repassado sem
   * interpretar (mesma regra deste módulo: PURO, decide só *o que o payload
   * diz*) — quem interpreta é `lib/leads/atribuicao-de-anuncio.ts`.
   */
  referral: unknown;
  /**
   * Coordenadas do pino, quando a mensagem é uma localização. O webhook NÃO as
   * traz — quem preenche é a ingestão, pela API (`./localizacao.ts`).
   */
  location?: Localizacao | null;
}

export interface ZernioIdentity {
  /** E.164 COM `+`, quando a pessoa expõe telefone. */
  phone: string | null;
  /** Âncora canônica da Meta para o usuário dentro do negócio. */
  bsuid: string | null;
  /** `@handle` — muda quando a pessoa quer; serve para exibir, não para casar. */
  username: string | null;
  displayName: string | null;
  /**
   * Qual âncora usar para casar o contato, já decidida aqui.
   *
   * `null` = payload sem identidade utilizável. Não é erro de parsing: é um
   * evento que não dá para atribuir a ninguém, e quem grava precisa recusá-lo
   * em vez de criar um contato anônimo por engano.
   */
  anchor: { kind: "bsuid" | "phone"; value: string } | null;
}

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Identidade do remetente, com a ordem de precedência declarada.
 *
 * BSUID primeiro porque é o que o provider chama de "âncora primária
 * recomendada" e o único que sobrevive a alguém trocar de telefone ou adotar
 * username. Telefone é o fallback — e continua sendo o caso comum hoje.
 * `whatsappUsername` NUNCA vira âncora: a própria doc avisa que não é estável.
 */
export function resolveZernioIdentity(sender: Bruto | null): ZernioIdentity {
  const s = sender ?? {};
  const phone = str(s.phoneNumber);
  const bsuid = str(s.businessScopedUserId);
  const username = str(s.whatsappUsername);
  const displayName = str(s.name) ?? str(s.displayName);

  const anchor = bsuid
    ? ({ kind: "bsuid", value: bsuid } as const)
    : phone
      ? ({ kind: "phone", value: phone } as const)
      : null;

  return { phone, bsuid, username, displayName, anchor };
}

/**
 * Lê um payload de mensagem recebida. `null` quando não é isso — outro evento,
 * mensagem de saída (o eco do nosso próprio envio) ou payload incompleto.
 *
 * Devolver `null` em vez de lançar é deliberado: a rota responde 200 para o
 * provider parar de reenviar, e um evento que não nos interessa não é falha.
 * Lançar faria o provider retentar para sempre um payload que nunca vai servir.
 */
/** Eventos que criam mensagem, e eventos que só mudam o desfecho dela. */
const EVENTOS_DE_MENSAGEM = new Set(["message.received", "message.sent"]);
const EVENTOS_DE_STATUS: Record<string, "delivered" | "read" | "failed"> = {
  "message.delivered": "delivered",
  "message.read": "read",
  "message.failed": "failed",
};

/**
 * O autor editou ou apagou a mensagem no aplicativo.
 *
 * Separado de `parseZernioInbound` porque o efeito é outro: aquele CRIA linha
 * (e conversa, e contato); este só corrige uma que já existe. Misturá-los faria
 * uma edição de mensagem que nunca chegou criar uma conversa do nada, com um
 * texto sem contexto nenhum antes dele.
 *
 * `null` quando não é dos nossos — a rota responde 200 e o provider para de
 * reenviar, que é o certo para um evento que nunca vai nos servir.
 */
export interface ZernioEdicao {
  externalId: string;
  /** `edited` traz corpo novo; `deleted` não tem corpo a trazer. */
  tipo: "edited" | "deleted";
  body: string | null;
}

export function parseZernioEdicao(payload: unknown): ZernioEdicao | null {
  const p = obj(payload);
  if (!p) return null;

  const evento = str(p.event) ?? "";
  if (evento !== "message.edited" && evento !== "message.deleted") return null;

  const m = obj(p.message);
  if (!m) return null;
  // Mesma regra do parser de mensagem: a conta serve outras plataformas, e uma
  // edição de DM de outra rede não tem linha nossa para corrigir.
  if (str(m.platform) !== "whatsapp") return null;

  const externalId = str(m.platformMessageId) ?? str(m.id);
  if (!externalId) return null;

  return {
    externalId,
    tipo: evento === "message.edited" ? "edited" : "deleted",
    body: str(m.content) ?? str(m.text) ?? str(m.body),
  };
}

export function parseZernioInbound(payload: unknown): ZernioInboundMessage | null {
  const p = obj(payload);
  if (!p) return null;

  const evento = str(p.event) ?? "";
  const deStatus = EVENTOS_DE_STATUS[evento];
  if (!EVENTOS_DE_MENSAGEM.has(evento) && !deStatus) return null;

  const m = obj(p.message);
  if (!m) return null;

  // Só WhatsApp: a mesma conta serve outras plataformas, e um DM de outra rede
  // entrando como conversa de WhatsApp é pior que ignorá-lo.
  if (str(m.platform) !== "whatsapp") return null;

  const conversationId = str(m.conversationId);
  const externalId = str(m.platformMessageId) ?? str(m.id);
  if (!conversationId || !externalId) return null;

  const anexosBrutos = Array.isArray(m.attachments) ? m.attachments : [];
  const attachments = anexosBrutos
    .map((a) => obj(a))
    .filter((a): a is Bruto => a !== null)
    .map((a) => ({ type: str(a.type) ?? "file", url: str(a.url) ?? "" }))
    .filter((a) => a.url.length > 0);

  const saida = str(m.direction) === "outgoing";

  return {
    direction: saida ? "outbound" : "inbound",
    kind: deStatus ? "status" : "message",
    ...(deStatus ? { status: deStatus } : evento === "message.sent" ? { status: "sent" as const } : {}),
    errorReason: deStatus === "failed" ? explicacaoDoErro(obj(p.error)) : null,
    conversationId,
    externalId,
    accountId: str(obj(p.account)?.id) ?? str(obj(p.account)?.accountId) ?? str(p.accountId),
    text: str(m.text),
    attachments,
    sentAt: str(m.sentAt),
    // ─── De quem é o CONTATO, e por que depende da direção ─────────────────
    //
    // Numa mensagem de SAÍDA o `sender` somos NÓS — medido no payload real, ele
    // traz o número da empresa. Usá-lo criaria um contato com o próprio número
    // do negócio, e toda conversa de saída viraria uma conversa com a gente
    // mesmo. Quem está do outro lado está em `conversation.participantId`.
    identity: saida
      ? resolveZernioIdentity(participanteDaConversa(obj(p.conversation)))
      : resolveZernioIdentity(obj(m.sender)),
    // Posição exata NÃO VERIFICADA contra o provider real (nunca chegou um
    // clique de anúncio nesta instalação) — tenta na mensagem primeiro (forma
    // documentada da Cloud API), cai para o nível do evento como fallback.
    referral: m.referral ?? p.referral ?? null,
  };
}

/** O outro lado da conversa, na forma que `resolveZernioIdentity` entende. */
function participanteDaConversa(c: Bruto | null): Bruto | null {
  if (!c) return null;
  const id = str(c.participantId);
  if (!id) return null;
  // O provider entrega o telefone SEM `+` neste campo (medido: `595985321822`).
  // Normalizar aqui mantém a âncora idêntica à do caminho de entrada — sem
  // isso o MESMO cliente viraria dois contatos, um por direção.
  const digitos = id.replace(/\D/g, "");
  return {
    phoneNumber: digitos.length >= 8 ? `+${digitos}` : null,
    name: str(c.participantName),
  };
}

/**
 * A explicação da plataforma, que é o que diz ao operador o que fazer.
 *
 * O `code` chega como NÚMERO no payload real (`"code": 131047`), não string —
 * medido nos logs de entrega. Tratá-lo só como texto o descartava em silêncio,
 * e o operador via "Re-engagement message" sem o código que permite procurar o
 * que fazer.
 */
function explicacaoDoErro(e: Bruto | null): string | null {
  if (!e) return null;
  const codigo =
    typeof e.code === "number" ? String(e.code) : typeof e.code === "string" ? e.code : null;
  const partes = [codigo, str(e.title), str(e.explanation)].filter(Boolean);
  return partes.length > 0 ? partes.join(" — ") : null;
}

/**
 * A URL do anexo é um endpoint AUTENTICADO do provider, não um link público —
 * buscá-la sem o Bearer devolve 401, e a doc avisa que a Meta descarta a mídia
 * depois de um tempo, quando passa a devolver 400.
 *
 * Existe como função nomeada para que o chamador não seja tentado a repassar a
 * URL crua para o browser: o que ela devolve é para BAIXAR e guardar, agora.
 */
export function zernioMediaFetchInit(apiKey: string): RequestInit {
  return { headers: { Authorization: `Bearer ${apiKey}` } };
}
