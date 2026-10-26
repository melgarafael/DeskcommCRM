/**
 * ZapSign (assinatura) e InfinitePay (pagamento) — docs/agencia/SPEC-contratos.md, K3/K4.
 *
 * As duas são opcionais. O token da ZapSign e o segredo dos webhooks ficam
 * cifrados em `agencia_config`; a InfinitePay só precisa do InfiniteTag. Nada
 * aqui lança: falha vira `{ ok: false, erro }` em português.
 *
 * Contratos das APIs (lidos em 26/10/2026):
 *  - ZapSign: `POST /api/v1/docs/` (Bearer) com `name`, `base64_pdf`, `external_id`,
 *    `signers[]`; devolve `token` e `signers[].sign_url`. `GET /api/v1/docs/{token}/`
 *    traz `status` (`signed` quando todos assinaram). Webhook da conta em
 *    `POST /api/v1/user/company/webhook/`.
 *  - InfinitePay: `POST https://api.checkout.infinitepay.io/links` com `handle`,
 *    `items[{quantity, price (centavos), description}]`, `order_nsu`, `redirect_url`,
 *    `webhook_url`, `customer`; `POST .../payment_check` com `handle`, `order_nsu`,
 *    `transaction_nsu`, `slug` devolve `paid`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import type { Resultado } from "../acervo/drive";

const ZAPSIGN = "https://api.zapsign.com.br";
const ZAPSIGN_SANDBOX = "https://sandbox.api.zapsign.com.br";
const INFINITEPAY = "https://api.checkout.infinitepay.io";

interface LinhaDaConfig {
  zapsign_token_ct: unknown;
  zapsign_token_iv: unknown;
  zapsign_token_tag: unknown;
  zapsign_sandbox: boolean;
  infinitepay_handle: string | null;
  webhook_segredo_ct: unknown;
  webhook_segredo_iv: unknown;
  webhook_segredo_tag: unknown;
}

function decifrar(ct: unknown, iv: unknown, tag: unknown): string | null {
  if (!ct) return null;
  try {
    return decryptKey({ ciphertext: byteaToBuffer(ct), iv: byteaToBuffer(iv), tag: byteaToBuffer(tag) });
  } catch {
    logger.warn("agência: segredo das integrações não decifrou (chave trocada?)");
    return null;
  }
}

export interface ConfigDosContratos {
  zapsignToken: string | null;
  zapsignSandbox: boolean;
  infinitepayHandle: string | null;
  segredo: string | null;
}

export async function configDosContratos(): Promise<ConfigDosContratos> {
  const { data } = await createAdminClient()
    .from("agencia_config")
    .select("zapsign_token_ct, zapsign_token_iv, zapsign_token_tag, zapsign_sandbox, infinitepay_handle, webhook_segredo_ct, webhook_segredo_iv, webhook_segredo_tag")
    .eq("id", true)
    .maybeSingle();
  const c = data as LinhaDaConfig | null;
  return {
    zapsignToken: c ? decifrar(c.zapsign_token_ct, c.zapsign_token_iv, c.zapsign_token_tag) : null,
    zapsignSandbox: c?.zapsign_sandbox ?? false,
    infinitepayHandle: c?.infinitepay_handle ?? null,
    segredo: c ? decifrar(c.webhook_segredo_ct, c.webhook_segredo_iv, c.webhook_segredo_tag) : null,
  };
}

/** O segredo do caminho dos webhooks; nasce na primeira vez que alguém configura uma integração. */
export async function garantirSegredo(): Promise<string> {
  const atual = (await configDosContratos()).segredo;
  if (atual) return atual;
  const novo = randomBytes(24).toString("base64url");
  const c = encryptKey(novo);
  await createAdminClient()
    .from("agencia_config")
    .update({ webhook_segredo_ct: bufToBytea(c.ciphertext), webhook_segredo_iv: bufToBytea(c.iv), webhook_segredo_tag: bufToBytea(c.tag) })
    .eq("id", true);
  return novo;
}

export function segredoConfere(recebido: string, esperado: string | null): boolean {
  if (!esperado) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function urlsDosWebhooks(base: string, segredo: string): { zapsign: string; infinitepay: string } {
  const b = base.replace(/\/+$/, "");
  return {
    zapsign: `${b}/api/v1/webhooks/agencia/zapsign/${segredo}`,
    infinitepay: `${b}/api/v1/webhooks/agencia/infinitepay/${segredo}`,
  };
}

export async function salvarZapsign(token: string | null, sandbox: boolean): Promise<void> {
  const cifrado = token ? encryptKey(token) : null;
  await createAdminClient()
    .from("agencia_config")
    .update({
      zapsign_token_ct: cifrado ? bufToBytea(cifrado.ciphertext) : null,
      zapsign_token_iv: cifrado ? bufToBytea(cifrado.iv) : null,
      zapsign_token_tag: cifrado ? bufToBytea(cifrado.tag) : null,
      zapsign_sandbox: sandbox,
    })
    .eq("id", true);
}

export async function salvarInfinitepay(handle: string | null): Promise<void> {
  await createAdminClient().from("agencia_config").update({ infinitepay_handle: handle }).eq("id", true);
}

async function pedir<T>(url: string, init: RequestInit, rotulo: string): Promise<Resultado<T>> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const corpo = await r.text();
    if (!r.ok) {
      logger.warn(`agência: ${rotulo} recusou`, { status: r.status, corpo: corpo.slice(0, 200) });
      return { ok: false, erro: r.status === 401 || r.status === 403 ? `${rotulo}: credencial recusada.` : `${rotulo} recusou (${r.status}).` };
    }
    return { ok: true, valor: (corpo ? JSON.parse(corpo) : {}) as T };
  } catch {
    return { ok: false, erro: `${rotulo} não respondeu agora.` };
  }
}

// ── ZapSign ────────────────────────────────────────────────────────────────

function baseZapsign(c: ConfigDosContratos): string {
  return c.zapsignSandbox ? ZAPSIGN_SANDBOX : ZAPSIGN;
}

export async function enviarParaZapsign(p: {
  contratoId: string;
  titulo: string;
  pdf: Buffer;
  signatario: { nome: string; email: string | null; telefone: string | null };
}): Promise<Resultado<{ token: string; link: string | null }>> {
  const c = await configDosContratos();
  if (!c.zapsignToken) return { ok: false, erro: "A ZapSign não está configurada (Configurações › Contratos)." };
  const tel = p.signatario.telefone?.replace(/\D/g, "").replace(/^55/, "") ?? "";
  const r = await pedir<{ token?: string; signers?: Array<{ sign_url?: string; token?: string }> }>(
    `${baseZapsign(c)}/api/v1/docs/`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${c.zapsignToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: p.titulo.slice(0, 255),
        base64_pdf: p.pdf.toString("base64"),
        external_id: p.contratoId,
        lang: "pt-br",
        signers: [
          {
            name: p.signatario.nome,
            ...(p.signatario.email ? { email: p.signatario.email, send_automatic_email: true } : {}),
            ...(tel ? { phone_country: "55", phone_number: tel, send_automatic_whatsapp: !p.signatario.email } : {}),
          },
        ],
      }),
    },
    "A ZapSign",
  );
  if (!r.ok) return r;
  if (!r.valor.token) return { ok: false, erro: "A ZapSign não devolveu o documento." };
  const assinante = r.valor.signers?.[0];
  const link = assinante?.sign_url ?? (assinante?.token ? `https://app.zapsign.com.br/verificar/${assinante.token}` : null);
  return { ok: true, valor: { token: r.valor.token, link } };
}

/** Conferência ativa (K4): o documento está mesmo assinado por todos? */
export async function documentoAssinadoNaZapsign(token: string): Promise<{ assinado: boolean; recusado: boolean; quando: string | null }> {
  const c = await configDosContratos();
  if (!c.zapsignToken) return { assinado: false, recusado: false, quando: null };
  const r = await pedir<{ status?: string; signers?: Array<{ signed_at?: string | null; status?: string }> }>(
    `${baseZapsign(c)}/api/v1/docs/${encodeURIComponent(token)}/`,
    { headers: { Authorization: `Bearer ${c.zapsignToken}` } },
    "A ZapSign",
  );
  if (!r.ok) return { assinado: false, recusado: false, quando: null };
  const datas = (r.valor.signers ?? []).map((s) => s.signed_at).filter((x): x is string => !!x).sort();
  return { assinado: r.valor.status === "signed", recusado: r.valor.status === "refused", quando: datas.at(-1) ?? null };
}

/** Cadastra o webhook da conta na ZapSign (vale para todos os documentos). */
export async function registrarWebhookNaZapsign(url: string): Promise<Resultado<unknown>> {
  const c = await configDosContratos();
  if (!c.zapsignToken) return { ok: false, erro: "Sem token da ZapSign." };
  return pedir(
    `${baseZapsign(c)}/api/v1/user/company/webhook/`,
    { method: "POST", headers: { Authorization: `Bearer ${c.zapsignToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ url, type: "" }) },
    "A ZapSign",
  );
}

// ── InfinitePay ────────────────────────────────────────────────────────────

export async function criarLinkDePagamento(p: {
  orderNsu: string;
  descricao: string;
  valorCents: number;
  webhookUrl: string;
  redirectUrl: string;
  cliente: { nome: string; email: string | null; telefone: string | null };
}): Promise<Resultado<{ link: string }>> {
  const c = await configDosContratos();
  if (!c.infinitepayHandle) return { ok: false, erro: "A InfinitePay não está configurada (Configurações › Contratos)." };
  if (p.valorCents <= 0) return { ok: false, erro: "O contrato não tem valor." };
  const r = await pedir<Record<string, unknown>>(
    `${INFINITEPAY}/links`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: c.infinitepayHandle,
        items: [{ quantity: 1, price: p.valorCents, description: p.descricao.slice(0, 120) }],
        order_nsu: p.orderNsu,
        redirect_url: p.redirectUrl,
        webhook_url: p.webhookUrl,
        customer: {
          name: p.cliente.nome,
          ...(p.cliente.email ? { email: p.cliente.email } : {}),
          ...(p.cliente.telefone ? { phone_number: p.cliente.telefone } : {}),
        },
      }),
    },
    "A InfinitePay",
  );
  if (!r.ok) return r;
  // A documentação não descreve a resposta: aceita os nomes que o link costuma vir.
  const link = ["url", "link", "checkout_url", "payment_url"].map((k) => r.valor[k]).find((v): v is string => typeof v === "string" && /^https:\/\//.test(v));
  return link ? { ok: true, valor: { link } } : { ok: false, erro: "A InfinitePay não devolveu o link." };
}

/** Conferência ativa (K4): o pagamento foi mesmo feito? */
export async function pagamentoConfirmado(p: { orderNsu: string; transactionNsu: string; slug: string }): Promise<boolean> {
  const c = await configDosContratos();
  if (!c.infinitepayHandle) return false;
  const r = await pedir<{ success?: boolean; paid?: boolean }>(
    `${INFINITEPAY}/payment_check`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: c.infinitepayHandle, order_nsu: p.orderNsu, transaction_nsu: p.transactionNsu, slug: p.slug }),
    },
    "A InfinitePay",
  );
  return r.ok && r.valor.paid === true;
}
