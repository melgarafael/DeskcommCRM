/**
 * lib/waha/ingest.ts — pipeline de ingestão WAHA compartilhado pelos dois route
 * handlers de webhook (`/waha` global e `/waha/[token]` per-tenant).
 *
 * Fonte única da verdade para: parse de identidade WhatsApp, resolução de
 * contato/conversa e persistência de mensagem. Resolução é ATÔMICA via RPC
 * (fn_upsert_wa_contact / fn_upsert_wa_conversation) — o padrão check-then-act
 * antigo criava um contato/conversa novo a cada mensagem porque o WAHA NOWEB
 * emite `message` E `message.any` para a mesma mensagem (corrida). Ver migration
 * 0027 para o modelo de identidade canônica.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { audit } from "@/lib/audit";
import { sincronizarSaudeDaConexao } from "@/lib/channels/health";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import { acelerarPipelineDeEventos } from "@/lib/dev/kick-local-pipeline";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { extrairAtribuicaoWaha } from "@/lib/waha/atribuicao-de-anuncio";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";
import type { WahaEnvelope, WahaPayload } from "@/lib/waha/envelope";
import { bareWaMessageId, chatIdFromWaMessageId } from "@/lib/waha/message-id";
import { logger } from "@/lib/logger";

export type Admin = ReturnType<typeof createAdminClient>;

/**
 * A pausa da IA quando uma pessoa responde pelo celular vive em
 * `lib/escalacao/atendimento-manual.ts` (`pausarIaPorAtendimentoManual`), e não
 * mais aqui. Era `silenciarBotPorRetomadaHumana`, exclusiva deste arquivo e do
 * WhatsApp; o gesto é o mesmo em qualquer canal (o Zernio tem o mesmo caminho de
 * saída-por-fora-do-CRM), e duas encarnações da mesma regra divergiriam na
 * primeira vez que alguém mexesse numa só. O helper unificado mantém o que esta
 * função garantia — prazo que expira sozinho, renovado a cada fala humana, e
 * silêncio maior NUNCA encurtado — e acrescenta o rastro de handoff.
 */

/**
 * Quanto tempo um envio nosso pode ficar "em voo" antes de o eco deixar de ser
 * explicável por ele.
 *
 * 60s é folgado de propósito: o custo de errar para o lado permissivo é uma
 * digitação real do celular não silenciar a IA por um minuto; o custo de errar
 * para o outro lado é a IA muda por três horas. Os dois erros não são simétricos.
 */
const JANELA_DO_ECO_MS = 60_000;

/**
 * A mensagem `fromMe` que chegou é o eco de um envio que ESTE CRM acabou de
 * fazer — e não alguém digitando no celular?
 *
 * A prova exigida é forte: uma linha nossa na MESMA conversa, ainda sem
 * `external_id` (portanto ainda em voo), com o MESMO corpo, dentro da janela.
 * Qualquer uma dessas faltando, a resposta é "não sei" — e "não sei" silencia,
 * porque é o desfecho seguro do lado do atendente humano (#371).
 *
 * Mídia não tem corpo comparável (o eco traz `media_url`, não texto): ali a
 * prova cai para "existe envio nosso em voo do mesmo tipo na janela", que é mais
 * permissivo e assumidamente mais fraco.
 */
async function ehEcoDeEnvioNosso(
  admin: Admin,
  organizationId: string,
  conversationId: string,
  p: WahaPayload,
): Promise<boolean> {
  const desde = new Date(Date.now() - JANELA_DO_ECO_MS).toISOString();
  const { data, error } = await admin
    .from("messages")
    .select("id, body, type")
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    // `sent_via` separa o que NASCEU aqui do que veio do celular: a linha do
    // celular é gravada como `external_device` e nunca pode servir de álibi.
    .in("sent_via", ["ai", "user"])
    // Sem `external_id` = ainda não confirmada pelo canal = ainda em voo. É esta
    // a janela exata em que o eco é indistinguível de digitação humana.
    .is("external_id", null)
    .in("status", ["queued", "sending"])
    .gte("created_at", desde)
    .limit(20);

  if (error) {
    // Falha de leitura não pode virar "é eco": na dúvida, silencia — o
    // desfecho seguro é o do atendente humano.
    console.error("[waha.ingest] checagem de eco falhou", error.message);
    return false;
  }

  const corpo = (p.body ?? "").trim();
  for (const linha of data ?? []) {
    const l = linha as { body: string | null; type?: string | null };
    if (p.type && p.type !== "chat") {
      // Mídia: sem corpo para comparar, a existência do envio em voo é a prova
      // possível. Mais fraco, e escrito para ninguém supor o contrário.
      if ((l.type ?? "chat") !== "chat") return true;
      continue;
    }
    if (corpo.length > 0 && (l.body ?? "").trim() === corpo) return true;
  }
  return false;
}

interface Session {
  id: string;
  organization_id: string;
}

/**
 * O formato do fio mora em `lib/waha/envelope.ts`, onde é um schema Zod — e o
 * tipo NASCE dele (`z.infer`). Re-exportado aqui porque este módulo era o dono
 * do tipo e quem já o importava não precisa saber que ele mudou de casa.
 */
export type { WahaEnvelope, WahaPayload } from "@/lib/waha/envelope";

export type ChatIdentity =
  | { kind: "phone"; phone: string; lid: null }
  | { kind: "lid"; phone: null; lid: string } // lid = somente dígitos
  | { kind: "group"; phone: null; lid: null }
  | { kind: "unknown"; phone: null; lid: null };

/**
 * Corta o chatId no `@` do sufixo — o que `replace(/@.*$/, "")` fazia aqui, sem
 * o custo quadrático que fez o CodeQL apontar as duas linhas (js/polynomial-redos,
 * alertas #6 e #7).
 *
 * ⚠️ NÃO troque por `indexOf("@")` nem por `lastIndexOf("@")`: nenhum dos dois é
 * equivalente. `.` não casa terminador de linha e `$` (sem /m) só casa no fim da
 * string, então o `@` que a regex achava é o PRIMEIRO **depois do ÚLTIMO
 * terminador de linha**. Em `"@@@\n@lid"` a regex devolvia `"@@@\n"`; `indexOf`
 * devolveria `""` e `lastIndexOf`, `"@@@\n@"`. Medido por varredura exaustiva
 * (37.449 strings, alfabeto `{@ a \n \r LS PS + espaço}`): esta formulação diverge
 * em 0; `indexOf` em 11.760; `lastIndexOf` em 11.798.
 *
 * Os quatro terminadores são exatamente os que `.` não casa (`\n \r U+2028 U+2029`
 * — NEL, TAB e NBSP casam, então não entram). Escritos como escape de propósito:
 * a versão com o caractere cru é indistinguível a olho da versão corrompida por
 * um copy-paste, e `tsc`/`eslint` dão verde nas duas — só a semântica muda
 * (4.582 divergências em 37.449).
 *
 * Por que era caro: o motor reinicia a tentativa a partir de CADA `@`, e quando há
 * um terminador de linha no meio todas falham — O(n²). O `endsWith("@lid")` acima
 * NÃO protege: `"@".repeat(n) + "\n@lid"` passa por ele. Medido nesta função,
 * `String.replace` sendo síncrono (trava o event loop do processo inteiro, todos
 * os tenants): 64 KB de `from` custam ~2,9 s; 256 KB, ~48 s. A entrada é externa —
 * `payload.from` vem do corpo do webhook, e `WAHA_WEBHOOK_REQUIRE_SIGNATURE` é
 * `false` por padrão. Esta varredura é linear: 1 MB em 0,7 ms.
 *
 * O que MUDOU desde que isto foi escrito: o corpo chegava por
 * `JSON.parse(rawBody) as WahaEnvelope` — cast, sem validação —, então `from`
 * podia nem ser string e o `.endsWith` acima lançava. Hoje o contrato é um
 * schema (`lib/waha/envelope.ts`) e a rota recusa antes de chegar aqui. O
 * TAMANHO continua livre, que é por isso que esta função segue linear.
 */
function semSufixoDeChat(chatId: string): string {
  const aposQuebra =
    Math.max(
      chatId.lastIndexOf("\n"),
      chatId.lastIndexOf("\r"),
      chatId.lastIndexOf("\u2028"),
      chatId.lastIndexOf("\u2029"),
    ) + 1;
  const arroba = chatId.indexOf("@", aposQuebra);
  return arroba === -1 ? chatId : chatId.slice(0, arroba);
}

/**
 * Resolve um chatId WAHA em identidade canônica:
 *  - `{number}@c.us` | `@s.whatsapp.net` -> phone E.164 ("+55...")
 *  - `{lid}@lid` -> lid (somente dígitos; número protegido pelo WhatsApp)
 *  - `@g.us` -> group (skip binding CRM — descarte ESPERADO, por doutrina)
 *  - qualquer outra coisa -> unknown (descarte que DEIXA RASTRO)
 *
 * A quarta variante existe porque este `return` final classificava tudo o que
 * não reconhecia como "grupo", e o ingest descarta grupo: "não sei ler isto"
 * virava "descarta calado" — a mesma família do defeito que sumia com a mensagem
 * digitada no celular (PR #108), inclusive o mesmo sintoma de webhook devolvendo
 * 200 sem erro. `@newsletter` e `@broadcast` já existem em produção e caíam
 * aqui; o próximo formato do WhatsApp reproduziria o caso inteiro.
 *
 * Grupo e desconhecido têm o MESMO desfecho (não viram contato) e naturezas
 * opostas: um é decisão de produto, o outro é buraco de conhecimento. Só o
 * segundo é anomalia, então só ele emite evento.
 */

export function parseChatId(chatId: string): ChatIdentity {
  if (chatId.endsWith("@g.us")) return { kind: "group", phone: null, lid: null };
  if (chatId.endsWith("@lid")) {
    return { kind: "lid", phone: null, lid: semSufixoDeChat(chatId) };
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@s.whatsapp.net")) {
    // `replace(/^\+/, "")` fica: é ancorado em `^`, casa 1 caractere, O(1) — não é
    // o que o CodeQL apontou.
    const digits = semSufixoDeChat(chatId).replace(/^\+/, "");
    return { kind: "phone", phone: "+" + digits, lid: null };
  }
  return { kind: "unknown", phone: null, lid: null };
}

/** Só estes dois viram contato no CRM — ver a guarda de `upsertContact`. */
function ehEnderecavel(parsed: ChatIdentity): boolean {
  return parsed.kind === "phone" || parsed.kind === "lid";
}

/**
 * O SUFIXO responde "que formato é este?"; o resto identifica uma pessoa.
 *
 * Registro operacional não é cópia de dado de contato — mesma linha de
 * `markConversation`, que deliberadamente não copia o texto da mensagem. Sem
 * isso, o log de diagnóstico vira depósito de número de telefone.
 */
function sufixoDeChatId(chatId: string): string {
  const at = chatId.lastIndexOf("@");
  if (at !== -1) return chatId.slice(at);
  return chatId === "" ? "(vazio)" : "(sem @)";
}

/**
 * Um chatId que não sabemos endereçar é ANOMALIA — tem que ser contável.
 *
 * `select count(*) from event_log where event_type = 'whatsapp.chat_id_not_recognized'`
 * responde "o WhatsApp mudou de formato e estamos perdendo mensagem?", que antes
 * não tinha como ser respondido: o descarte não deixava nada para trás.
 */
async function avisarChatNaoReconhecido(
  admin: Admin,
  organizationId: string,
  sessionId: string,
  chatId: string,
  direction: "inbound" | "outbound",
): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "whatsapp.chat_id_not_recognized",
    p_entity_kind: "channel_session",
    p_entity_id: sessionId,
    p_payload: { sufixo: sufixoDeChatId(chatId), direction },
    p_metadata: { severity: "warn" },
    p_organization_id: organizationId,
  } as never);
  if (error) {
    console.error("[waha.ingest] o aviso de chat não reconhecido também falhou", error.message);
  }
}


export function verifyHmacSha512(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  const got = signatureHeader.replace(/^sha512=/i, "").trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function previewFromMessage(p: WahaPayload): string {
  if (p.body) return p.body.slice(0, 280);
  const t = resolveMessageType(p);
  return t !== "text" ? `[${t}]` : "";
}

/** URL da mídia: WAHA novo (payload.media.url) com fallback legado (payload.mediaUrl). */
export function mediaUrlOf(p: WahaPayload): string | null {
  return p.mediaUrl ?? p.media?.url ?? null;
}

/** MIME da mídia: idem (payload.media.mimetype é o campo do NOWEB atual). */
export function mediaMimeOf(p: WahaPayload): string | null {
  return p.mimetype ?? p.media?.mimetype ?? null;
}

/**
 * Mapeia o `type` cru do WAHA NOWEB para o vocabulário de messages.type do CRM
 * (check constraint messages_type_check). WAHA usa `chat` p/ texto, `ptt` p/
 * áudio de voz, `vcard` p/ contato, etc. Sem esse mapa o INSERT viola a
 * constraint e a mensagem some. O type cru fica em metadata.raw_type.
 */
const WA_TYPE_MAP: Record<string, string> = {
  chat: "text",
  text: "text",
  ptt: "audio",
  audio: "audio",
  image: "image",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  vcard: "contact",
  contact: "contact",
  multi_vcard: "contact",
  reaction: "reaction",
};

function mapWahaMessageType(raw: string | undefined): string {
  if (!raw) return "text";
  // Fallback "text": só chegamos ao insert com body/mídia presente (guarda acima),
  // então tratar tipo desconhecido como texto não perde a mensagem.
  return WA_TYPE_MAP[raw.toLowerCase()] ?? "text";
}

/**
 * NOWEB (WAHA 2026.x) não envia `type` no payload — o tipo real está nas
 * chaves de `_data.message` (imageMessage, stickerMessage, …). Ordem de
 * resolução: `type` explícito → chave do message → prefixo do MIME → text.
 */
const NOWEB_MESSAGE_KEY_TYPE: Record<string, string> = {
  stickerMessage: "sticker",
  imageMessage: "image",
  videoMessage: "video",
  ptvMessage: "video", // video note (bolinha)
  audioMessage: "audio",
  documentMessage: "document",
  documentWithCaptionMessage: "document",
  contactMessage: "contact",
};

export function resolveMessageType(p: WahaPayload): string {
  if (p.type) return mapWahaMessageType(p.type);
  const msg = p._data?.message;
  if (msg && typeof msg === "object") {
    for (const [key, mapped] of Object.entries(NOWEB_MESSAGE_KEY_TYPE)) {
      if (key in msg) return mapped;
    }
  }
  const mime = mediaMimeOf(p);
  if (mime) {
    if (mime === "image/webp") return "sticker";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
  }
  return "text";
}

function notifyNameOf(p: WahaPayload): string | null {
  return p._data?.notifyName ?? p._data?.pushName ?? null;
}

/** Corpo textual: WAHA nem sempre preenche `body` em cartões de contato NOWEB. */
function bodyOf(p: WahaPayload): string | null {
  if (p.body) return p.body;
  const msg = p._data?.message;
  if (!msg || typeof msg !== "object") return null;
  // `_data.message` é `unknown` no schema Zod (`lib/waha/envelope.ts`), de
  // propósito: a forma NOWEB varia por tipo de mensagem e exigi-la aqui só
  // criaria uma porta nova de descartar a mensagem inteira. O estreitamento é
  // explícito, no mesmo estilo do `cm as {…}` logo abaixo.
  const cm = (msg as { contactMessage?: unknown }).contactMessage;
  if (cm && typeof cm === "object") {
    const o = cm as { vcard?: string; displayName?: string };
    if (o.vcard) return o.vcard;
    if (o.displayName) return o.displayName;
  }
  return null;
}

/**
 * O telefone REAL de quem escreveu, quando o chat chega como `@lid`.
 *
 * `from` vem opaco (`70192801575156@lid`), mas `_data.key.remoteJidAlt` traz
 * `558183647258@s.whatsapp.net`. Em grupo, o equivalente é `participantAlt`.
 *
 * Devolve E.164 (`+55…`) ou null. **Só aceita o que parece telefone**: o campo é
 * de fora, e um valor estranho aqui viraria `phone_number` — que é chave de
 * reencontro de contato e endereço de envio. Na dúvida, nulo: contato sem
 * telefone é incômodo, contato com telefone ERRADO manda mensagem para
 * estranho.
 */
export function telefoneAlternativoDe(p: WahaPayload): string | null {
  const bruto = p._data?.key?.remoteJidAlt ?? p._data?.key?.participantAlt ?? null;
  if (!bruto) return null;
  // ⚠️ `endsWith`/`indexOf` e NÃO regex — este valor vem de FORA (é campo de
  // webhook) e a versão com `/@(s\.whatsapp\.net|c\.us)$/` foi apontada pelo
  // CodeQL como ReDoS de severidade alta: o motor tenta casar a partir de CADA
  // `@` da string, então um payload com milhares deles faz o tempo explodir e
  // trava o processo que ingere as mensagens de todo mundo.
  //
  // Comparação de sufixo literal é linear e diz exatamente a mesma coisa. Um
  // teto de tamanho vem antes, porque nem trabalho linear sobre entrada
  // arbitrária é de graça.
  //
  // Só sufixos de NÚMERO: `@lid` significaria que o campo repetiu a identidade
  // opaca, e `@g.us` é grupo — nenhum dos dois é telefone de pessoa.
  if (bruto.length > 128) return null;
  if (!bruto.endsWith("@s.whatsapp.net") && !bruto.endsWith("@c.us")) return null;
  const semSufixo = bruto.slice(0, bruto.indexOf("@"));
  let digitos = "";
  for (const ch of semSufixo) {
    if (ch >= "0" && ch <= "9") digitos += ch;
  }
  // Faixa E.164: 8 a 15 dígitos. Fora disso não é número discável, e o CHECK
  // `contacts_phone_e164_format` recusaria — falhar aqui é melhor que abortar a
  // ingestão inteira da mensagem lá na frente.
  if (digitos.length < 8 || digitos.length > 15) return null;
  return `+${digitos}`;
}

/**
 * Upsert atômico de contato pela identidade canônica. Retorna null se a
 * identidade for de grupo ou a RPC falhar.
 */
async function upsertContact(
  admin: Admin,
  orgId: string,
  parsed: ChatIdentity,
  chatId: string,
  notifyName: string | null,
  telefoneAlt: string | null = null,
): Promise<string | null> {
  // ALLOWLIST, não denylist — e a diferença aqui não é estilo.
  //
  // `fn_upsert_wa_contact` NÃO valida `p_kind`, e `contacts.wa_identity` é coluna
  // GERADA que só produz `phone:`/`lid:`; qualquer outro kind a deixa NULL. Como
  // o `on conflict` da RPC é `(organization_id, wa_identity) where wa_identity is
  // not null`, uma linha NULL nunca conflita — nasceria UM CONTATO NOVO A CADA
  // WEBHOOK, que é exatamente o anti-pattern que a migration 0027 veio matar.
  //
  // Com `kind === "group"` (a forma antiga), acrescentar uma variante à união
  // abria esse buraco em silêncio: o TS não reclama de um `===` que deixou de
  // cobrir todos os casos. Perguntar quem PODE passar falha fechado sozinho.
  //
  // ⚠️ SEGUNDA CAMADA, SEM COBERTURA POSSÍVEL — e isto está escrito porque medi:
  // trocar esta linha de volta pela denylist deixa a suíte inteira VERDE (35/35,
  // typecheck 0). Os dois chamadores já barram o não-endereçável antes de chegar
  // aqui, então nenhum teste consegue alcançá-la; é defesa em profundidade na
  // fronteira com uma RPC que não valida nada. Quem mexer aqui não vai ser
  // avisado por teste nenhum — só por este comentário.
  if (!ehEnderecavel(parsed)) return null;
  const { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: orgId,
    p_kind: parsed.kind,
    // O telefone vem de dois lugares e é UM parâmetro: do próprio chatId quando
    // ele já é um número, ou de `_data.key.remoteJidAlt` quando o chat é `@lid`.
    // Resolver aqui, e não no SQL, foi o que permitiu manter a assinatura da
    // função (e portanto os grants e os invariantes de hardening) intacta.
    p_phone: parsed.kind === "phone"
      ? canonicalPhoneBR(parsed.phone)
      : telefoneAlt
        ? canonicalPhoneBR(telefoneAlt)
        : null,
    p_lid: parsed.kind === "lid" ? parsed.lid : null,
    p_chat_id: chatId,
    p_notify: notifyName,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_contact failed", error.message);
    return null;
  }
  return (data as string) ?? null;
}

async function upsertConversation(
  admin: Admin,
  orgId: string,
  contactId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: orgId,
    p_contact: contactId,
    p_session: sessionId,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_conversation failed", error.message);
    return null;
  }
  return (data as string) ?? null;
}

/**
 * Carimba a conversa com a mensagem que acabou de entrar.
 *
 * ⚠️ FALHA BAIXO, MAS CONTA — e a diferença entre as duas coisas é o motivo
 * desta função existir com corpo próprio. A mensagem JÁ foi inserida quando
 * chegamos aqui; bloquear a ingestão porque o carimbo falhou deixaria o
 * histórico refém de uma coluna derivada. Então não se bloqueia.
 *
 * Mas `console.error` sozinho não é "falhar baixo": ele **não bloqueia e também
 * não conta** (anti-pattern nº 14 do CLAUDE.md, e a mesma doutrina já escrita em
 * `lib/leads/activity-write-failure.ts`). Log de servidor sem destino não vira
 * alerta de ninguém — e o efeito prático é que "a RPC falha às vezes" nunca sai
 * de OPINIÃO para NÚMERO. Em 25/07 isso custou caro: a suspeita de que esta
 * chamada falhava foi levada a sério por horas, e não havia como medi-la porque
 * cada falha tinha sumido no log de um processo que já não existia.
 *
 * O evento é o que torna a pergunta respondível: `select count(*) from event_log
 * where event_type = 'whatsapp.conversation_mark_failed'`.
 */
async function markConversation(
  admin: Admin,
  organizationId: string,
  convId: string,
  direction: "inbound" | "outbound",
  preview: string,
  at: string,
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: convId,
    p_direction: direction,
    p_preview: preview,
    p_at: at,
  } as never);
  if (!error) return;

  const { error: erroAviso } = await admin.rpc("emit_event" as never, {
    p_event_type: "whatsapp.conversation_mark_failed",
    p_entity_kind: "conversation",
    p_entity_id: convId,
    // O preview NÃO entra no payload: ele é o texto da mensagem do cliente, e
    // isto é registro operacional, não cópia de conteúdo. O que se precisa
    // saber para agir é qual conversa, que sentido, e o erro.
    p_payload: { direction, erro: error.message },
    p_metadata: { severity: "warn" },
    p_organization_id: organizationId,
  } as never);

  if (erroAviso) {
    // Segunda linha de defesa: o próprio canal de aviso caiu. Aqui o log do
    // processo é o que sobra — é para ESTE caso que ele existe, não como rotina.
    console.error("[waha.ingest] o carimbo falhou E o aviso também", {
      conversa: convId,
      erro: error.message,
      aviso: erroAviso.message,
    });
  }
}

/**
 * Mensagem recebida (fromMe=false). Contato = remetente (`from`).
 */
async function mensagemIngeridaPorExternalId(
  admin: Admin,
  orgId: string,
  externalId: string,
): Promise<{ id: string; contact_id: string; body: string | null } | null> {
  const { data, error } = await admin
    .from("messages")
    .select("id, contact_id, body")
    .eq("organization_id", orgId)
    .eq("external_id", externalId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (error) {
    logger.warn("waha.ingest: dedup sem ler mensagem existente", { detail: error.message });
    return null;
  }
  return data ?? null;
}

async function handleInbound(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return; // grupos não fazem binding CRM
  if (!p.id) return;
  // WAHA emite eventos vazios p/ status/read-receipt/presence — não viram mensagem.
  const texto = bodyOf(p);
  if (!texto && !mediaUrlOf(p) && !p.hasMedia) return;
  // Daqui para baixo era para ser uma mensagem de verdade: se o chat não é
  // endereçável, PERDEMOS uma — e isso precisa ser contável. O aviso fica depois
  // das guardas acima de propósito; antes delas, todo evento de presença viraria
  // um registro, e log que enche sozinho é log que ninguém lê.
  if (!ehEnderecavel(parsed)) {
    await avisarChatNaoReconhecido(admin, session.organization_id, session.id, chatId, "inbound");
    return;
  }

  const contactId = await upsertContact(
    admin,
    session.organization_id,
    parsed,
    chatId,
    notifyNameOf(p),
    telefoneAlternativoDe(p),
  );
  if (!contactId) return;

  // Best-effort: o dado do anúncio (se houver) vai embutido na PRÓPRIA
  // mensagem que o app do cliente manda ao clicar num anúncio "Clique para o
  // WhatsApp" — não é exclusivo da API oficial. NUNCA verificado contra um
  // clique real nesta instalação (ver cabeçalho de `atribuicao-de-anuncio.ts`);
  // por isso é silencioso quando não reconhece a forma, nunca derruba o
  // inbound. `estamparAtribuicaoDoContato` só grava na primeira vez — se o
  // contato já tem atribuição, o UPDATE casa zero linhas.
  const atribuicao = extrairAtribuicaoWaha(p._data?.message);
  if (atribuicao) await estamparAtribuicaoDoContato(admin, contactId, atribuicao);

  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedMessage, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: resolveMessageType(p),
      direction: "inbound",
      status: "delivered",
      ack: p.ack ?? null,
      body: texto,
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      delivered_at: now,
      metadata: { raw_type: p.type, ack_name: p.ackName },
    })
    .select("id")
    .maybeSingle();

  // Idempotência: 23505 = unique (organization_id, external_id) já ingerido.
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] message insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") {
    // O `return` está certo — reingerir duplicaria a mensagem do cliente. Mas
    // sair MUDO era o defeito: "5 mensagens, 4 jobs" fica indistinguível entre
    // dedup legítimo e mensagem perdida por outro caminho, e a pergunta "cadê o
    // turno dessa?" passa a não ter resposta no log.
    //
    // Não é erro, é evento esperado — por isso `info` e não `error`. O que ele
    // paga é a CONTAGEM: sem a linha, o silêncio de um dedup normal e o de uma
    // perda têm a mesma cara.
    logger.info("waha.ingest: inbound ja ingerido, dedup por external_id", {
      organization_id: session.organization_id,
      conversation_id: conversationId,
      external_id: p.id,
      direcao: "inbound",
    });
    // A 1ª entrega pode ter gravado a mensagem e estourado o tempo ANTES de
    // `aplicarEfeitosPosEntrada` — a reentrega cai aqui. Reacelerar só o
    // pipeline (sem re-despachar o agente) destrava o match_reply.
    const existente = await mensagemIngeridaPorExternalId(admin, session.organization_id, p.id);
    if (existente) {
      try {
        await acelerarPipelineDeEventos(admin, {
          organizationId: session.organization_id,
          contactId: existente.contact_id,
          messageId: existente.id,
          texto: existente.body,
        });
      } catch (err) {
        logger.warn("waha.ingest: dedup nao reacelerou pipeline", {
          organization_id: session.organization_id,
          external_id: p.id,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return;
  }

  await markConversation(admin, session.organization_id, conversationId, "inbound", previewFromMessage(p), now);

  await audit({
    action: "message.received",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id },
  });

  // ── OS EFEITOS DE NEGÓCIO, agora ATRÁS DO SEAM ──────────────────────────────
  //
  // Opt-out, nascimento do lead e despacho do agente moravam AQUI DENTRO, em
  // linha. Enquanto este era o único canal isso não incomodava; quando entrou o
  // número oficial, ele passou a gravar a mensagem e não fazer nenhum dos três —
  // sem erro e sem log. Medido: 806 despachos deste lado, 0 do outro.
  //
  // A ordem dos três é regra de negócio e está documentada em
  // `lib/channels/pos-entrada.ts`, junto com o motivo de cada posição. O
  // comportamento aqui é o MESMO de antes, campo a campo — o que mudou é quem o
  // executa.
  await aplicarEfeitosPosEntrada(admin, {
    organizationId: session.organization_id,
    contactId,
    conversationId,
    messageId: insertedMessage?.id ?? null,
    channelSessionId: session.id,
    texto,
    nomeDoContato: notifyNameOf(p),
    requestId,
    origem: "waha_webhook",
  });

  // ── POR QUE NÃO SE EMITE `message.received` AQUI ────────────────────────────
  //
  // Porque o BANCO já emite. O gatilho `trg_messages_emit_event` roda AFTER
  // INSERT em `messages`, sem filtrar canal, e chama `fn_emit_message_event`.
  // Esta função emitia a SEGUNDA cópia — só neste canal.
  //
  // Medido em produção antes de sair: 805 mensagens com DOIS eventos deste lado
  // e 30 com UM do outro. Os quatro consumidores registrados rodavam nas duas
  // linhas, então cada mensagem daqui era classificada duas vezes pelo modelo de
  // sentimento (duas chamadas pagas), a automação do usuário disparava duas
  // vezes, e a chave de idempotência do follow-up não protegia porque inclui o
  // id da LINHA de evento — que é diferente nas duas.
  //
  // O critério de aceite escrito em `docs/stories/epics/EPIC-03-inbox-messaging.md`
  // já dizia "2 events 'message.received'? NÃO — só 1". O duplicado gêmeo, o de
  // leads, foi aposentado na migration 0043; este passou despercebido porque a
  // guarda de `entity_kind` não separa os dois emissores (ambos usam "message").
  //
  // Quem precisar do preview do corpo: ele está na própria linha de `messages`,
  // alcançável pelo `message_id` que o gatilho manda.
  if (insertedMessage?.id) {
    const inboundMessageId = insertedMessage.id;
    if (mediaUrlOf(p)) {
      admin
        .rpc("emit_event" as never, {
          p_event_type: "media.persist_requested",
          p_entity_kind: "message",
          p_entity_id: inboundMessageId,
          p_payload: { message_id: inboundMessageId, conversation_id: conversationId },
          p_metadata: { source: "waha_webhook", request_id: requestId },
          p_organization_id: session.organization_id,
        } as never)
        .then(({ error }) => {
          if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
        });
    }
  }
}

/**
 * fromMe=true: operador respondeu direto do WhatsApp dele (não pelo composer).
 * Contato = destinatário (`to`). `from` é o próprio número do operador — nunca
 * vira contato. Registrado como outbound p/ o operador ver o histórico completo.
 */
async function handleOutboundFromUserPhone(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  // De onde sai o chat, em ordem de confiança:
  //   1. `to`  — o WEBJS manda; é o destinatário explícito.
  //   2. o id  — `{fromMe}_{chatId}_{bareId}` carrega o chat em qualquer engine.
  //   3. `from`— no NOWEB, mensagem fromMe traz o CHAT em `from` (não o número
  //              do operador, como acontece no WEBJS).
  //
  // O NOWEB (engine padrão do kit) **não manda `to`** aqui. Com `p.to ?? ""` o
  // chatId ficava vazio e a guarda abaixo descartava a mensagem em silêncio —
  // toda mensagem que o dono digitava no celular sumia do CRM, enquanto as
  // enviadas pelo composer e pela IA apareciam (essas nascem no banco antes do
  // webhook, então não dependiam deste caminho). O sintoma era "respondi pelo
  // celular e o CRM não mostra", sem nenhum erro em log: o webhook devolvia 200.
  const chatId = p.to ?? chatIdFromWaMessageId(p.id ?? "") ?? p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return;
  if (!p.id) return;
  if (!p.body && !mediaUrlOf(p) && !p.hasMedia) return;
  // Idem inbound. Aqui o caso que mais dói é o chatId vazio: é literalmente o
  // defeito do #108 — mensagem que o dono digitou no celular sem `to`, sem id
  // composto e sem `from`. Se voltar a acontecer por um formato novo, agora sai
  // um evento em vez de silêncio.
  //
  // A metade `!chatId` da guarda anterior sai daqui junto: ela era condição
  // MORTA (varri 12 valores de `to` e nenhum a disparava, porque o único falsy
  // já era classificado como grupo uma linha acima) e voltaria a viver como
  // duplicata desta guarda, descartando calado justamente o caso que se quer ver.
  if (!ehEnderecavel(parsed)) {
    await avisarChatNaoReconhecido(admin, session.organization_id, session.id, chatId, "outbound");
    return;
  }

  // ECO DO PRÓPRIO ENVIO — não duplicar.
  //
  // Toda mensagem que o CRM manda (composer ou IA) volta pelo webhook como
  // `fromMe=true`. O dedup por `external_id` NÃO pega esse caso, porque os dois
  // lados gravam formas diferentes do mesmo id: o envio grava o id "bare"
  // (`3EB0…`) e o webhook chega com o composto (`true_<chat>_3EB0…`). São
  // strings distintas, então o unique não dispara e nasce uma segunda linha —
  // a mesma frase aparecendo duas vezes na conversa.
  //
  // Antes isto não aparecia por acidente: sem `to`, esta função voltava cedo e
  // o eco era descartado junto com as mensagens legítimas do celular. Ao
  // consertar aquele caminho, a duplicação ficou exposta.
  //
  // Mesmo par de candidatos que o `handleAck` usa — cobre NOWEB (bare) e WEBJS
  // (full) sem depender do engine.
  const bare = bareWaMessageId(p.id);
  const idCandidates = bare === p.id ? [p.id] : [p.id, bare];
  const { data: jaRegistrada } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", session.organization_id)
    .in("external_id", idCandidates)
    .limit(1)
    .maybeSingle();
  if (jaRegistrada) return; // nasceu no envio; quem atualiza o status é o ack

  // fromMe: o pushName do payload é o do OPERADOR, não do destinatário —
  // repassá-lo batizaria o contato do cliente com o nome da loja (e o
  // `coalesce` do fn_upsert_wa_contact congelaria o nome errado).
  //
  // O TELEFONE, ao contrário, vai: aqui `_data.key.remoteJid` é o chat do
  // DESTINATÁRIO, então `remoteJidAlt` é o número do cliente, não o da loja.
  // Medido na produção — inbound 56/56 e outbound 20/20 trazem o campo, e as
  // amostras de outbound mostram o número do cliente. Nome e telefone vêm de
  // lugares diferentes do mesmo payload, e só um deles inverte no envio.
  const contactId = await upsertContact(
    admin,
    session.organization_id,
    parsed,
    chatId,
    null,
    telefoneAlternativoDe(p),
  );
  if (!contactId) return;
  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedOutbound, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: resolveMessageType(p),
      direction: "outbound",
      status: "sent",
      ack: p.ack ?? null,
      body: bodyOf(p),
      media_url: mediaUrlOf(p),
      media_mime: mediaMimeOf(p),
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      metadata: { raw_type: p.type, fromMe: true },
    })
    .select("id")
    .maybeSingle();
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] outbound insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") {
    // Mesma razão do inbound: dedup é esperado, invisível não.
    logger.info("waha.ingest: outbound ja ingerido, dedup por external_id", {
      organization_id: session.organization_id,
      external_id: p.id,
      direcao: "outbound",
    });
    return;
  }

  await markConversation(admin, session.organization_id, conversationId, "outbound", previewFromMessage(p), now);

  // Uma PESSOA respondeu este cliente pelo celular, fora do composer/IA — a IA
  // para NESTA conversa para não responder junto, por uma janela que expira
  // sozinha (ver `PRAZO_DO_SILENCIO_MS`). NÃO mexe em `contacts.ai_authorized_at`
  // — a origem do lead é outro estado.
  //
  // ⚠️ MAS ANTES: isto é MESMO um humano, ou é o eco do nosso próprio envio?
  //
  // ⚠️ NÃO basta o `jaRegistrada` acima. Este comentário já afirmou que bastava
  // ("o eco do nosso próprio envio já saiu no dedup") e a afirmação é FALSA,
  // medida na fonte: `jaRegistrada` casa por `.in("external_id", …)`, e todo
  // envio do CRM grava a linha ANTES de falar com o canal (`status='queued'`,
  // `external_id` NULL) — o id só existe depois que o WAHA responde. Nessa
  // janela o dedup não casa nada, o eco chega com `fromMe`, e esta função
  // concluía "humano assumiu". A tela mostrava "Automático pausado", um estado
  // legítimo que ninguém investiga. (issue #519, consertada no #521)
  //
  // Aqui isso é PIOR do que era: o silêncio deste caminho é um estado que dura
  // até vencer o prazo ou até alguém clicar — a IA passaria a se calar porque
  // ela mesma falou.
  //
  // As DUAS decisões que eram uma só se separam aqui, e em direções OPOSTAS de
  // propósito:
  //   gravar a linha  -> tolerante  (na dúvida grava; perder mensagem é pior que
  //                                  duplicar — é o #108, que já custou caro)
  //   silenciar o bot -> ESTRITO    (na dúvida NÃO cala; calar a IA por engano é
  //                                  pior que não calar)
  // Quem reaproveitar esta condição para pular o INSERT reabre o #108.
  if (!(await ehEcoDeEnvioNosso(admin, session.organization_id, conversationId, p))) {
    await pausarIaPorAtendimentoManual(admin, {
      organizationId: session.organization_id,
      conversationId,
      canal: "waha",
    });
  }

  await audit({
    action: "message.sent",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id, from_user_phone: true },
  });

  if (insertedOutbound?.id && mediaUrlOf(p)) {
    admin
      .rpc("emit_event" as never, {
        p_event_type: "media.persist_requested",
        p_entity_kind: "message",
        p_entity_id: insertedOutbound.id,
        p_payload: { message_id: insertedOutbound.id, conversation_id: conversationId },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit media.persist_requested failed", error.message);
      });
  }
}

async function handleAck(admin: Admin, session: Session, p: WahaPayload): Promise<void> {
  if (!p.id) return;
  const ack = p.ack ?? 0;
  const status = ackToStatus(ack);
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { ack, status };
  if (ack >= 2) update.delivered_at = now;
  if (ack >= 3) update.read_at = now;

  // O ack do WAHA 2026.x vem como `{fromMe}_{chatId}_{bareId}`. O NOWEB grava
  // `external_id` = bareId (id interno), o WEBJS grava o `_serialized` completo.
  // Casar as duas formas cobre ambos os engines sem tocar no external_id de
  // inbound (que é full e sustenta o dedup 23505).
  const bare = bareWaMessageId(p.id);
  const candidates = bare === p.id ? [p.id] : [p.id, bare];
  await admin
    .from("messages")
    .update(update)
    .eq("organization_id", session.organization_id)
    .in("external_id", candidates);
}

interface SessionStatusRow extends Session {
  is_warmup_complete: boolean | null;
  warmup_started_at: string | null;
}

async function handleSessionStatus(
  admin: Admin,
  session: SessionStatusRow,
  p: WahaPayload,
): Promise<void> {
  const status = (p.status ?? "").toUpperCase() || null;
  if (!status) return;
  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  if (!allowed.has(status)) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { status, last_status_change_at: now };
  if (status === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    // Só `warmup_completed_at`: `is_warmup_complete` é `GENERATED ALWAYS AS
    // (warmup_completed_at IS NOT NULL)`, e atribuir a ela abortava o UPDATE
    // INTEIRO — inclusive o `status`, que nada tem a ver com warm-up. Ou seja: a
    // sessão que terminava o aquecimento parava de atualizar o próprio estado, e
    // o espelho do canal congelava sem erro visível.
    update.warmup_completed_at = now;
  }
  await admin.from("channel_sessions").update(update).eq("id", session.id);

  // ─── E agora alguém precisa SABER ────────────────────────────────────────
  //
  // Até aqui esta função gravava o estado numa coluna e não contava a ninguém.
  // Foi assim que uma desconexão real passou horas despercebida: o evento
  // chegou, a coluna atualizou, e o dono só descobriu ao estranhar que ninguém
  // escrevia. O estado certo no lugar que ninguém olha não vale nada.
  //
  // O apelido é buscado aqui, e não recebido: com dois números ligados, um aviso
  // que não diz QUAL conexão caiu obriga o operador a adivinhar. É uma consulta
  // a mais num evento raro — status muda algumas vezes por dia, não por minuto.
  const { data: apelidoRow } = await admin
    .from("channel_sessions")
    .select("display_name, phone_number")
    .eq("id", session.id)
    .maybeSingle();

  await sincronizarSaudeDaConexao(
    admin,
    { id: session.id, organization_id: session.organization_id, status },
    // Veio do próprio transporte: se ele conseguiu nos contar, está alcançável.
    { reachable: true, status, detail: null },
    (apelidoRow?.display_name as string | null) ??
      (apelidoRow?.phone_number as string | null) ??
      "sem nome",
  );
}

/**
 * O autor editou a mensagem no aplicativo.
 *
 * O corpo é SOBRESCRITO, e não versionado: o que o CRM mostra tem que ser o que
 * o cliente vê agora. Guardar as versões anteriores é outra feature (histórico
 * de edição), com tela e retenção próprias — fazê-la pela metade acumularia
 * dado pessoal num campo que ninguém mostra e que a anonimização não conhece.
 *
 * `editedMessageId` é o id da mensagem ORIGINAL; o `id` do payload é o do
 * evento de edição. Casar pelo `id` não acharia nada — e o silêncio pareceria
 * "funcionou", que é exatamente o modo de falha que este arquivo já pagou caro
 * em outros lugares.
 */
async function handleMessageEdited(
  admin: Admin,
  session: Session,
  p: WahaPayload,
): Promise<void> {
  const alvo = bareWaMessageId(p.editedMessageId ?? "");
  const corpo = typeof p.body === "string" ? p.body : null;
  if (!alvo || corpo === null) return;

  await admin
    .from("messages")
    .update({ body: corpo, edited_at: new Date().toISOString() })
    .eq("organization_id", session.organization_id)
    .eq("external_id", alvo);
}

/**
 * O autor apagou a mensagem ("apagar para todos").
 *
 * A linha NÃO é removida: sumir com ela apagaria o contexto das vizinhas — uma
 * resposta passaria a responder ao nada — e o histórico de quem atendeu. O
 * corpo também não é limpo aqui: quem decide o que mostrar é a tela, e apagar o
 * texto no banco impediria o próprio atendente de entender, depois, o que tinha
 * sido combinado antes do arrependimento.
 */
async function handleMessageRevoked(
  admin: Admin,
  session: Session,
  p: WahaPayload,
): Promise<void> {
  const alvo = bareWaMessageId(p.revokedMessageId ?? "");
  if (!alvo) return;

  await admin
    .from("messages")
    .update({ revoked_at: new Date().toISOString() })
    .eq("organization_id", session.organization_id)
    .eq("external_id", alvo);
}

/**
 * Roteador único de eventos WAHA. Os dois route handlers convergem aqui após
 * resolver a sessão e validar HMAC.
 */
export async function dispatchWahaEvent(
  admin: Admin,
  session: SessionStatusRow,
  envelope: WahaEnvelope,
  requestId: string,
): Promise<void> {
  const eventType = envelope.event ?? "unknown";
  const payload: WahaPayload = envelope.payload ?? {};

  if (eventType === "message" || eventType === "message.any") {
    if (payload.fromMe) {
      await handleOutboundFromUserPhone(admin, session, payload, requestId);
    } else {
      await handleInbound(admin, session, payload, requestId);
    }
  } else if (eventType === "message.ack") {
    await handleAck(admin, session, payload);
  } else if (eventType === "message.edited") {
    await handleMessageEdited(admin, session, payload);
  } else if (eventType === "message.revoked") {
    await handleMessageRevoked(admin, session, payload);
  } else if (eventType === "session.status" || eventType === "state.change") {
    await handleSessionStatus(admin, session, payload);
  }
}
