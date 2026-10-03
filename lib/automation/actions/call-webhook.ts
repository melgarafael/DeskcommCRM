/**
 * Ação `call_webhook` — POST outbound com envelope
 * {event, occurred_at, happened_at, delivery_id, data}, assinatura HMAC-sha256 opcional
 * (config.secret) e retry 3x (1s/5s) em falha de rede ou status não-2xx.
 * Anti-SSRF via assertSafeOutboundUrl antes de qualquer fetch (pulável só via
 * opts.skipUrlCheck, usado nos testes).
 *
 * Cabeçalhos de toda entrega (#1529) — o guia de quem recebe é
 * docs/integracao/webhooks-de-saida.md:
 *  - X-Deskcomm-Event: o tipo do evento;
 *  - X-Webhook-Delivery: id da ENTREGA (uuid v5 de evento + regra + posição da ação +
 *    lista de ações). É o mesmo nas retentativas e no botão Reenviar — é a
 *    chave de deduplicação;
 *  - X-Webhook-Attempt: número da tentativa (1..n), que continua contando no Reenviar;
 *  - X-Webhook-Timestamp: hora do envio em segundos unix, recalculada a cada tentativa;
 *  - X-Webhook-Signature (só com segredo): `t=<ts>,v1=<hex>`, HMAC de
 *    "<ts>.<delivery>.<corpo>" — cobre a hora e o id, então uma requisição
 *    capturada e repetida fora da janela do receptor é recusável;
 *  - X-Deskcomm-Signature (só com segredo): o HMAC só do corpo, LEGADO. Continua saindo
 *    byte a byte igual durante a convivência (contrato de fio, white-label.md);
 *    a saída dele vai ser anunciada com `exige_acao`.
 */
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

const TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 5_000]; // total 3 tentativas

/**
 * Nomes dos cabeçalhos num lugar só: o receptor casa cada um por igualdade.
 * Os de #1529 nascem com nome neutro (X-Webhook-*): nome de protocolo não se
 * renomeia depois do release, e a instalação de marca própria não pode mandar a
 * marca de origem ao sistema do cliente. Event e a assinatura legada já eram
 * contrato publicado e ficam — são as entradas PROTOCOLO de
 * tests/unit/branding.test.ts, lista que só encolhe.
 */
const CABECALHOS = {
  evento: "X-Deskcomm-Event",
  entrega: "X-Webhook-Delivery",
  tentativa: "X-Webhook-Attempt",
  carimbo: "X-Webhook-Timestamp",
  assinaturaComCarimbo: "X-Webhook-Signature",
  assinaturaLegada: "X-Deskcomm-Signature",
} as const;

/**
 * Namespace do uuid v5 da entrega. NUNCA TROCAR: ele entra no id de toda
 * entrega, e trocá-lo muda o id das entregas futuras de um evento que já saiu —
 * o receptor que guardou o id para deduplicar passaria a processar o reenvio
 * como coisa nova.
 */
const NAMESPACE_DA_ENTREGA = "ce410f0a-ca5e-4a06-89a0-bfe57222d74f";

/**
 * uuid v5 (RFC 9562 §5.5): SHA-1 de namespace + nome, com os bits de versão e
 * de variante. Sem dependência nova — o projeto não tem `uuid` instalado, e o
 * algoritmo cabe aqui (o teste confere contra o vetor do próprio RFC).
 */
export function uuidV5(nome: string, namespace: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(nome, "utf8")
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Uma ação como está gravada em `rule.actions`. */
export type AcaoDaRegra = { type: string; config?: Record<string, unknown> };

/** Fora da impressão da lista: trocar o segredo não muda qual entrega é qual. */
const CHAVES_DE_SEGREDO = new Set(["secret", "secret_enc"]);

/**
 * Impressão digital da lista de ações: tipo e config de cada uma, sem os
 * segredos, com as chaves da config em ordem. A lista vem do jsonb nos dois
 * caminhos (motor e Reenviar), então a ordem do que está aninhado já é estável.
 */
function impressaoDasAcoes(acoes: ReadonlyArray<AcaoDaRegra>): string {
  return JSON.stringify(
    acoes.map((acao) => [
      acao.type,
      Object.entries(acao.config ?? {})
        .filter(([chave]) => !CHAVES_DE_SEGREDO.has(chave))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]),
  );
}

/**
 * O id da entrega: um por (evento, regra, posição da ação em `rule.actions`,
 * lista de ações da regra). Determinístico de propósito — retentativa e
 * Reenviar recalculam o mesmo id sem precisar guardá-lo antes de enviar.
 *
 * A posição é a da lista INTEIRA de ações da regra (a mesma do motor e de
 * `actions_result`), nunca a de uma lista filtrada. A lista entra no id porque
 * a posição sozinha não identifica a ação: se o operador remover ou reordenar
 * ações entre o disparo e o Reenviar, outra ação passaria a ocupar a posição e
 * sairia com o id de uma entrega que o receptor JÁ processou — e ele a
 * descartaria como duplicata, em silêncio. Com a lista no id, qualquer mudança
 * nas ações (fora o segredo) dá um id novo: na dúvida, o receptor recebe de
 * novo, nunca deixa de receber.
 */
export function idDaEntrega(
  eventId: string,
  ruleId: string,
  indiceDaAcao: number,
  acoesDaRegra: ReadonlyArray<AcaoDaRegra>,
): string {
  return uuidV5(`${eventId}:${ruleId}:${indiceDaAcao}:${impressaoDasAcoes(acoesDaRegra)}`, NAMESPACE_DA_ENTREGA);
}

/** `t=<ts>,v1=<hex HMAC-SHA256(segredo, "<ts>.<entrega>.<corpo>")>`. */
export function assinaturaComCarimbo(segredo: string, carimbo: number, entrega: string, corpo: string): string {
  const v1 = createHmac("sha256", segredo).update(`${carimbo}.${entrega}.${corpo}`).digest("hex");
  return `t=${carimbo},v1=${v1}`;
}

/**
 * A forma que este arquivo grava em `actions_result[]` — o schema central da
 * leitura do jsonb, para o Reenviar não interpretar a coluna "de olho".
 */
const resultadoGravado = z.object({
  type: z.string(),
  detail: z
    .object({
      delivery_id: z.string().optional(),
      attempt: z.number().int().optional(),
      attempts: z.number().int().optional(),
    })
    .optional(),
});

/**
 * Maior número de tentativa já registrado para uma entrega, somando todos os
 * runs recebidos (o original e os Reenviar anteriores). O Reenviar começa no
 * seguinte, para o Attempt nunca repetir numeração dentro da mesma entrega.
 *
 * `attempt` é o número absoluto da última tentativa; resultado de falha antigo
 * só tinha `attempts` (quantas nesta execução), que vale o mesmo quando a
 * execução começou em 1.
 *
 * ponytail: resultado gravado antes do #1529 não tem `delivery_id`, então não
 * dá para saber de qual ação ele era — conta para QUALQUER entrega da regra.
 * O teto é a numeração poder pular números (nunca repetir), o que é inofensivo:
 * Attempt é informativo e a chave de deduplicação é o Delivery. Some sozinho
 * quando não houver mais run legado a reenviar.
 */
export function tentativasRegistradas(runs: ReadonlyArray<{ actions_result?: unknown }>, entrega: string): number {
  let maior = 0;
  for (const run of runs) {
    if (!Array.isArray(run.actions_result)) continue;
    for (const bruto of run.actions_result) {
      const lido = resultadoGravado.safeParse(bruto);
      if (!lido.success || lido.data.type !== "call_webhook" || !lido.data.detail) continue;
      const { delivery_id: deQualEntrega, attempt, attempts } = lido.data.detail;
      if (deQualEntrega !== undefined && deQualEntrega !== entrega) continue;
      maior = Math.max(maior, attempt ?? attempts ?? 0);
    }
  }
  return maior;
}

/**
 * `happened_at` é a hora do FATO (`event_log.created_at`): o receptor passa a
 * saber quando a coisa aconteceu, e o valor é o mesmo no Reenviar. Normalizado
 * em ISO-8601 UTC com milissegundos, o formato do `occurred_at` (o Postgres
 * manda microssegundos e `+00:00`).
 *
 * O `occurred_at` NÃO mudou: segue sendo a hora em que esta execução montou a
 * entrega, como sempre foi. É contrato público — receptor que recusa
 * requisição velha por ele passaria a recusar o Reenviar e a automação adiada
 * se ele virasse a hora do fato (ajuste sobre o #1830).
 *
 * `created_at` é opcional no `EventRow` (fixtures); o motor e o Reenviar sempre
 * o trazem. Faltando ou inválido, volta para a hora do envio, o comportamento
 * antigo — melhor um carimbo impreciso que uma entrega a menos.
 */
function horaDoFato(criadoEm: string | undefined): string {
  const ms = criadoEm ? Date.parse(criadoEm) : Number.NaN;
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

// Projeções públicas do envelope — NUNCA repassar a row inteira do DB (vaza
// organization_id, cpf_*, consent, source_metadata, owner_user_id etc. pra
// endpoint externo do tenant). Só inclui as chaves presentes na row.
const LEAD_PUBLIC_FIELDS = [
  "id",
  "title",
  "status",
  "pipeline_id",
  "stage_id",
  "value_cents",
  "currency",
  "tags",
  "custom_fields",
  // O motivo de ganho (issue #1536) — o critério de aceite é ele aparecer no
  // envelope de webhook junto do resto do lead; `lost_reason` já saía por ser
  // dado antigo, e o ganho nasce com a mesma exposição para a métrica do lado
  // de fora não nascer vazia.
  "won_reason",
  "source",
  "created_at",
] as const;

const CONTACT_PUBLIC_FIELDS = [
  "id",
  "name",
  "display_name",
  "email",
  "phone_number",
  "tags",
  "created_at",
] as const;

function projectPublicFields(
  row: unknown,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  if (!row || typeof row !== "object") return undefined;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * O endereço escrito e o link da reunião do compromisso (#1612), lidos da
 * linha ATUAL (`context.appointment`, que o motor carrega filtrada por
 * organização) e nunca do payload do evento.
 *
 * Eles não moram no `event_log`: nenhuma anonimização nem retenção o alcança,
 * e o redact do contato anula justamente estas duas colunas no compromisso
 * (0184). Lidos daqui, uma regra adiada que dispare depois do redact ou do
 * cancelamento manda o que o banco tem agora — `null` inclusive.
 */
function localDoCompromisso(appointment: unknown): Record<string, unknown> | undefined {
  if (!appointment || typeof appointment !== "object") return undefined;
  const linha = appointment as Record<string, unknown>;
  const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  // Mesma régua de quem mostra o link (consulta.ts, a tool MCP, o agente): só
  // o link PRONTO sai — um Meet cancelado ou falho não vai para fora.
  const meetingUrl = linha.meeting_state === "ready" ? texto(linha.meeting_url) : null;
  return {
    local: { tipo: texto(linha.location_kind), descricao: texto(linha.location_details) },
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
  };
}

/**
 * O RESPONSÁVEL no corpo, e só por opt-in (#1612, mesma régua de #1528).
 *
 * `config.include_owner !== true` → a chave nem nasce: "sem opt-in, o
 * responsável não aparece no corpo" é asserção de teste, não comentário, e a
 * forma segura de garanti-la é a de não construir o objeto.
 *
 * O id vem do COMPROMISSO já hidratado pelo motor (`context.appointment`) —
 * nenhuma consulta nova no caminho padrão. O NOME é que não viaja no payload:
 * ele mora em `auth.users.user_metadata`, então só é buscado aqui, dentro de
 * `try` — sem service role (ou num teste sem rede) o corpo sai com o id, que
 * já responde "de quem era", em vez da entrega inteira falhar por causa de um
 * apelido.
 */
async function responsavelPublico(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  if (config.include_owner !== true) return undefined;
  const compromisso = ctx.context.appointment as Record<string, unknown> | undefined;
  const ownerId = compromisso && typeof compromisso.owner_user_id === "string" ? compromisso.owner_user_id : null;
  if (!ownerId) return undefined;
  let nome: string | null = null;
  try {
    const { data } = await ctx.admin.auth.admin.getUserById(ownerId);
    const metadata = data?.user?.user_metadata as { full_name?: unknown } | undefined;
    nome = typeof metadata?.full_name === "string" && metadata.full_name ? metadata.full_name : null;
  } catch {
    nome = null;
  }
  return nome ? { id: ownerId, name: nome } : { id: ownerId };
}

export async function executeCallWebhook(
  ctx: ActionCtx,
  config: Record<string, unknown>,
  opts: {
    skipUrlCheck?: boolean;
    retryDelaysMs?: number[];
    /**
     * Número da primeira tentativa desta execução. O motor começa em 1; o
     * Reenviar passa o seguinte ao maior já registrado para a mesma entrega.
     */
    primeiraTentativa?: number;
  } = {},
): Promise<ActionResultDetail> {
  const url = typeof config.url === "string" ? config.url : null;
  if (!url) return { type: "call_webhook", status: "failed", error: "missing_url" };
  if (!opts.skipUrlCheck) {
    try {
      assertSafeOutboundUrl(url);
      // Guard textual não resolve nome: um hostname público apontando para
      // 169.254.169.254 (metadata da nuvem) ou para os serviços internos da rede do
      // compose passava por ele. Este segundo resolve e julga o IP.
      await assertDestinoResolvidoSeguro(new URL(url).hostname);
    } catch (err) {
      return { type: "call_webhook", status: "failed", error: (err as Error).message };
    }
  }

  const leadPublic = projectPublicFields(ctx.context.lead, LEAD_PUBLIC_FIELDS);
  const contactPublic = projectPublicFields(ctx.context.contact, CONTACT_PUBLIC_FIELDS);
  const ownerPublic = await responsavelPublico(ctx, config);
  const compromissoPublic = localDoCompromisso(ctx.context.appointment);
  const entrega = idDaEntrega(ctx.event.id, ctx.ruleId, ctx.actionIndex ?? 0, ctx.ruleActions ?? []);
  const body = JSON.stringify({
    event: ctx.event.event_type,
    occurred_at: new Date().toISOString(),
    happened_at: horaDoFato(ctx.event.created_at),
    delivery_id: entrega,
    data: {
      ...ctx.event.payload,
      ...(leadPublic ? { lead: leadPublic } : {}),
      ...(contactPublic ? { contact: contactPublic } : {}),
      ...(compromissoPublic ?? {}),
      // Só com `include_owner: true` (#1612) — ver `responsavelPublico`.
      ...(ownerPublic ? { owner: ownerPublic } : {}),
    },
  });
  // Fixos dentro da execução: o corpo e o id da entrega não mudam entre as
  // tentativas. Tentativa, carimbo e assinatura com carimbo mudam — ver o laço.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [CABECALHOS.evento]: ctx.event.event_type,
    [CABECALHOS.entrega]: entrega,
  };
  // secret_enc (cifrado at-rest, migration 0041) tem precedência; config.secret
  // plaintext fica só como legado pré-retrofit. Decrypt indisponível (chave da
  // GUC ausente) → envia SEM assinatura em vez de falhar a entrega; quem recebe
  // e exige assinatura recusa do lado de lá.
  let secret: string | null = typeof config.secret === "string" && config.secret ? config.secret : null;
  if (typeof config.secret_enc === "string" && config.secret_enc) {
    secret = await decryptWebhookSecret(ctx.admin, config.secret_enc);
  }
  if (secret) {
    headers[CABECALHOS.assinaturaLegada] = createHmac("sha256", secret).update(body).digest("hex");
  }

  const retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const primeiraTentativa = opts.primeiraTentativa ?? 1;
  const tentativasNestaExecucao = retryDelaysMs.length + 1;
  let lastError = "";
  let lastStatus: number | null = null;
  let tentativa = primeiraTentativa;
  for (let i = 0; i < tentativasNestaExecucao; i++) {
    tentativa = primeiraTentativa + i;
    // Carimbo por TENTATIVA: uma retentativa 5 s depois leva a própria hora, e
    // a janela do receptor mede a idade desta requisição, não a da primeira.
    const carimbo = Math.floor(Date.now() / 1000);
    const headersDaTentativa: Record<string, string> = {
      ...headers,
      [CABECALHOS.tentativa]: String(tentativa),
      [CABECALHOS.carimbo]: String(carimbo),
    };
    if (secret) {
      headersDaTentativa[CABECALHOS.assinaturaComCarimbo] = assinaturaComCarimbo(secret, carimbo, entrega, body);
    }
    try {
      // redirect: "manual" — nunca seguir 3xx automaticamente. fetch por padrão
      // segue redirect, e uma URL de tenant que passou no guard anti-SSRF pode
      // 302 pra um endpoint interno (ex.: http://169.254.169.254/...). Um 3xx
      // vira falha comum (conta pro retry), nunca é seguido.
      const res = await fetch(url, {
        method: "POST",
        headers: headersDaTentativa,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      lastStatus = res.status;
      if (res.ok) {
        return {
          type: "call_webhook",
          status: "success",
          detail: { response_status: res.status, attempt: tentativa, delivery_id: entrega },
        };
      }
      lastError = res.status >= 300 && res.status < 400 ? "redirect_not_followed" : `http_${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    const delay = retryDelaysMs[i];
    if (delay !== undefined) await sleep(delay);
  }
  // `attempts` (quantas nesta execução) fica como sempre foi; `attempt` é o
  // número absoluto da última — é o que o próximo Reenviar lê para continuar.
  return {
    type: "call_webhook",
    status: "failed",
    error: lastError,
    detail: {
      response_status: lastStatus,
      attempts: tentativasNestaExecucao,
      attempt: tentativa,
      delivery_id: entrega,
    },
  };
}

registerAction({
  type: "call_webhook",
  execute: (ctx, config) => executeCallWebhook(ctx, config),
});
