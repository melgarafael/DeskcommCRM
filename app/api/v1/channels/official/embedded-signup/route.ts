/**
 * POST /api/v1/channels/official/embedded-signup — a outra porta do canal
 * oficial (#4074): a janela da Meta com o app da PRÓPRIA instalação.
 *
 * O navegador abre o `FB.login` com o Configuration ID e recebe de volta duas
 * coisas: o `code` (no callback do login) e o número + a conta escolhidos (na
 * mensagem `WA_EMBEDDED_SIGNUP` da janela). Esta rota:
 *
 * 1. troca o `code` pelo token da empresa (`/oauth/access_token`, com o App ID e o
 *    App Secret da instalação — o segredo nunca sai do servidor);
 * 2. sem `phone_number_id`, acha o número em `/{waba}/phone_numbers`;
 * 3. grava o canal pelo MESMO caminho do token colado à mão
 *    (`gravarCanalOficial`), com a origem `embedded_signup` — validação com a Meta
 *    antes de gravar, cifra, webhook do número apontado para esta instalação;
 * 4. só com a conexão aceita, registra o número na Cloud API
 *    (`/{phone}/register`), best-effort, e guarda o PIN cifrado no canal — exceto
 *    na coexistência (`modo`), onde o número já está registrado e o registro NÃO
 *    é chamado.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { appDaMeta, embeddedSignupDaInstalacao } from "@/lib/channels/meta/app";
import { graphBaseUrl } from "@/lib/channels/meta/graph-base";
import { gravarCanalOficial, mesclarNoMetadataDoCanalOficial } from "@/lib/channels/meta/gravar-canal-oficial";
import { ORIGEM_DO_EMBEDDED_SIGNUP } from "@/lib/channels/meta/origem-da-conexao";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const entradaSchema = z.object({
  code: z.string().min(10).max(2000),
  // Na coexistência a Meta pode mandar só a conta (`waba_id`); o número sai da
  // consulta à conta, depois da troca do código.
  phone_number_id: z.string().regex(/^\d{5,30}$/).optional(),
  waba_id: z.string().regex(/^\d{5,30}$/),
  modo: z.enum(["coexistencia", "padrao"]).default("padrao"),
});

const TEMPO_LIMITE_MS = 15_000;

/** O texto de erro que a Graph API devolve, sem ecoar o pedido (que leva o segredo). */
function motivoDaMeta(corpo: unknown): string | null {
  const erro = (corpo as { error?: { message?: unknown; error_user_msg?: unknown } } | null)?.error;
  const texto = erro?.error_user_msg ?? erro?.message;
  return typeof texto === "string" && texto.trim() ? texto.trim() : null;
}

async function trocarCodigoPorToken(input: {
  appId: string;
  appSecret: string;
  code: string;
}): Promise<{ ok: true; token: string } | { ok: false; motivo: string }> {
  const url = new URL(`${graphBaseUrl()}/oauth/access_token`);
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("client_secret", input.appSecret);
  url.searchParams.set("code", input.code);
  try {
    const resposta = await fetch(url, { signal: AbortSignal.timeout(TEMPO_LIMITE_MS) });
    const corpo = (await resposta.json().catch(() => null)) as { access_token?: unknown } | null;
    const token = typeof corpo?.access_token === "string" ? corpo.access_token : "";
    if (resposta.ok && token) return { ok: true, token };
    return { ok: false, motivo: motivoDaMeta(corpo) ?? `a Meta respondeu ${resposta.status}` };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * O número da conta, quando a janela da Meta não o mandou. Mais de um número é
 * recusado: escolher um por palpite conectaria a linha errada.
 */
async function numeroDaConta(input: {
  wabaId: string;
  token: string;
}): Promise<{ ok: true; phoneNumberId: string } | { ok: false; motivo: "nenhum" | "varios" | "falha"; detalhe?: string }> {
  try {
    const url = new URL(`${graphBaseUrl()}/${input.wabaId}/phone_numbers`);
    url.searchParams.set("fields", "id");
    const resposta = await fetch(url, {
      headers: { Authorization: `Bearer ${input.token}` },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
    const corpo = (await resposta.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    if (!resposta.ok) return { ok: false, motivo: "falha", detalhe: motivoDaMeta(corpo) ?? `a Meta respondeu ${resposta.status}` };
    const ids = (corpo?.data ?? []).map((n) => n?.id).filter((id): id is string => typeof id === "string" && /^\d{5,30}$/.test(id));
    const [unico, ...resto] = ids;
    if (unico === undefined) return { ok: false, motivo: "nenhum" };
    if (resto.length > 0) return { ok: false, motivo: "varios" };
    return { ok: true, phoneNumberId: unico };
  } catch (err) {
    return { ok: false, motivo: "falha", detalhe: err instanceof Error ? err.message : String(err) };
  }
}

async function registrarNumero(input: {
  phoneNumberId: string;
  token: string;
  pin: string;
}): Promise<{ ok: true } | { ok: false; motivo: string }> {
  try {
    const resposta = await fetch(`${graphBaseUrl()}/${input.phoneNumberId}/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin: input.pin }),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
    if (resposta.ok) return { ok: true };
    const corpo = await resposta.json().catch(() => null);
    return { ok: false, motivo: motivoDaMeta(corpo) ?? `a Meta respondeu ${resposta.status}` };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : String(err) };
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = entradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("A janela da Meta não devolveu o número e a conta. Tente de novo."), 422, {
      requestId,
    });
  }
  const { code, waba_id, modo } = parsed.data;
  const coexistencia = modo === "coexistencia";

  const embedded = await embeddedSignupDaInstalacao();
  const { appSecret } = await appDaMeta();
  if (!embedded || !appSecret) {
    return fail(
      "invalid_request",
      t("A conexão pelo Facebook não está configurada nesta instalação. Quem administra cadastra o App ID, o Configuration ID e a chave secreta em Admin › API Oficial (Meta)."),
      422,
      { requestId },
    );
  }

  const troca = await trocarCodigoPorToken({ appId: embedded.appId, appSecret, code });
  if (!troca.ok) {
    logger.warn("[meta.embedded] troca do código pelo token falhou", { requestId, motivo: troca.motivo });
    return fail("invalid_request", `${t("A Meta não aceitou a conexão:")} ${troca.motivo}`, 422, { requestId });
  }

  let phone_number_id = parsed.data.phone_number_id;
  if (!phone_number_id) {
    const achado = await numeroDaConta({ wabaId: waba_id, token: troca.token });
    if (!achado.ok) {
      logger.warn("[meta.embedded] número da conta não resolvido", { requestId, motivo: achado.motivo, detalhe: achado.detalhe });
      if (achado.motivo === "varios") {
        return fail(
          "invalid_request",
          t("A conta da Meta tem mais de um número. Conecte um número por vez, escolhendo só um na janela da Meta."),
          422,
          { requestId },
        );
      }
      if (achado.motivo === "nenhum") {
        return fail("invalid_request", t("A Meta não devolveu nenhum número para essa conta. Tente de novo."), 422, { requestId });
      }
      return fail("invalid_request", `${t("A Meta não aceitou a conexão:")} ${achado.detalhe ?? ""}`.trim(), 422, { requestId });
    }
    phone_number_id = achado.phoneNumberId;
  }

  const resposta = await gravarCanalOficial({
    req,
    requestId,
    orgId: authz.org.orgId,
    userId: authz.user.id,
    idioma: authz.user.idioma,
    phoneNumberId: phone_number_id,
    wabaId: waba_id,
    token: troca.token,
    origem: ORIGEM_DO_EMBEDDED_SIGNUP,
    // Explícito nos dois modos: um número que saiu da coexistência e voltou pela
    // Cloud API não pode carregar a marca antiga na reconexão.
    metadataExtra: { meta_coexistencia: coexistencia },
  });

  // Registro na Cloud API — DEPOIS de a conexão ser aceita, best-effort, e NUNCA
  // na coexistência: o número já está registrado (roda no app WhatsApp Business)
  // e o registro o tiraria de lá. O PIN vira o da verificação em duas etapas do
  // NÚMERO; registrar antes de gravar deixaria, numa gravação recusada (credencial,
  // cifra, limite do plano), um PIN aplicado que ninguém guardou.
  if (coexistencia || !resposta.ok) return resposta;
  const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const registro = await registrarNumero({ phoneNumberId: phone_number_id, token: troca.token, pin });
  if (!registro.ok) {
    logger.info("[meta.embedded] registro do número não aplicado (segue a conexão)", {
      requestId,
      motivo: registro.motivo,
    });
    return resposta;
  }
  const pinCifrado = await encryptWebhookSecret(createAdminClient(), pin);
  const guardado = pinCifrado
    ? await mesclarNoMetadataDoCanalOficial(authz.org.orgId, { meta_registro_pin_cifrado: pinCifrado })
    : false;
  if (!guardado) {
    logger.error("[meta.embedded] número registrado, mas o PIN do registro não foi guardado", { requestId });
  }
  return resposta;
}
