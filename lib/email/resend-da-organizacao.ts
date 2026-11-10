/**
 * A CONTA RESEND DA ORGANIZAÇÃO (#3287, fatia da conta própria).
 *
 * ─── O que esta peça resolve ─────────────────────────────────────────────────
 *
 * A organização conecta a CONTA Resend DELA (a chave que ela paga e o domínio
 * que ela verificou). Com a conta conectada, o e-mail que a AUTOMAÇÃO manda ao
 * cliente final sai pela conta da organização — o domínio no `From:` é o DELA,
 * e os eventos de entrega (volta, spam, supressão) caem na conta dele, que é o
 * que alimenta a lista de supressão da #3441 e o recebimento do #1121 (o motivo
 * do mantidor SPYDeEp1 propor esta fatia na issue). Sem conta, o envio continua
 * exatamente como hoje: o roteador da plataforma entrega.
 *
 * ─── O que fica FORA, e por quê ──────────────────────────────────────────────
 *
 * O e-mail de SISTEMA — convite, recuperação de senha, LGPD — NÃO passa por
 * aqui: ele segue pelo `lib/email/roteador.ts` com o remetente da plataforma.
 * Só o caminho da automação (`lib/automation/actions/send-email.ts`) escolhe a
 * conta da organização quando existe. A invariância "sistema = plataforma" é
 * medida, não presumida.
 *
 * ─── Segredo: a chave NUNCA sai daqui em claro ───────────────────────────────
 *
 * A chave mora CIFRADA (`organization_resend_accounts.api_key_*`, AES-256-GCM
 * pela instalação). `carregarContaResend` decifra em MEMÓRIA só para o envio e
 * devolve o objeto com a chave em claro PARA O CHAMADOR DIRETO — que é o worker
 * de envio, e nada mais. A tela NUNCA vê a chave: quem lê o estado para a tela
 * é `estadoDaContaResend`, que seleciona só `from_email` + `api_key_last4`.
 *
 * ─── Ausência e falha têm consequências diferentes ──────────────────────────
 *
 * Só a ausência de linha autoriza usar o transporte da plataforma. Se a conta
 * não puder ser lida/decifrada, recusar torna o defeito visível sem enviar com
 * outra identidade nem consumir a conta da instalação em silêncio.
 */
import { Resend, type Domain, type GetDomainResponseSuccess } from "resend";
import type { SupabaseClient } from "@supabase/supabase-js";

import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { classificarErroResend, fromAddress } from "@/lib/email/resend";

/** O que basta para enviar pela conta da organização — a chave já decifrada. */
export interface ContaResendDaOrganizacao {
  readonly apiKey: string;
  /** O endereço de remetente no DOMÍNIO VERIFICADO da organização. */
  readonly fromEmail: string;
}

interface SendArgsDaConta {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  fromName?: string;
  tags?: { name: string; value: string }[];
}

/** Mesmo vocabulário de `SendResult` da Resend da plataforma — o da ação lê os dois. */
export interface ResultadoDaContaDaOrganizacao {
  ok: boolean;
  id?: string;
  error?: "not_configured" | "send_failed" | "rate_limited" | "dominio_nao_verificado";
  details?: string;
}

/** O que a TELA pode ver da conta — NUNCA a chave nem o ciphertext. */
export interface EstadoDaContaResend {
  readonly from_email: string;
  readonly api_key_last4: string;
}

/** O desfecho da verificação de DOMÍNIO ao conectar a conta (critério E). */
export type VerificacaoDeDominio =
  | { ok: true }
  /** O endereço não tem cara de endereço — recusa antes de chamar a Resend. */
  | { ok: false; motivo: "sem_endereco" }
  /** A chave foi recusada pela Resend (ou a chamada falhou) — não é culpa do domínio. */
  | { ok: false; motivo: "chave_recusada" }
  | { ok: false; motivo: "permissao_insuficiente" | "consulta_indisponivel" }
  | { ok: false; motivo: "envio_desabilitado" }
  /** O domínio do endereço NÃO está verificado na conta da Resend. */
  | { ok: false; motivo: "dominio_nao_verificado"; dominio: string };

/** O domínio de um endereço — a parte depois do último `@`. */
function dominioDe(endereco: string): string | null {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(endereco)) return null;
  const corte = endereco.lastIndexOf("@");
  if (corte <= 0 || corte === endereco.length - 1) return null;
  return (
    endereco
      .slice(corte + 1)
      .trim()
      .toLowerCase() || null
  );
}

/** Códigos oficiais; mensagem do provedor não atravessa para a tela. */
function motivoDaConsulta(error: {
  name: string;
  statusCode?: number | null;
}): "chave_recusada" | "permissao_insuficiente" | "consulta_indisponivel" {
  if (
    error.name === "invalid_permission" ||
    (error.name === "restricted_api_key" && error.statusCode === 401)
  ) {
    return "permissao_insuficiente";
  }
  if (
    ["validation_error", "missing_api_key", "restricted_api_key", "suspended_api_key"].includes(
      error.name,
    )
  ) {
    return "chave_recusada";
  }
  return "consulta_indisponivel";
}

/**
 * Confere, pela API de DOMÍNIOS da Resend, se o domínio do endereço de remetente
 * está VERIFICADO na conta cuja `apiKey` a organização acabou de colar.
 *
 * ─── Por que confere AGORA, no conectar ──────────────────────────────────────
 *
 * Uma conta com domínio não verificado "conecta" e todo envio falha depois, no
 * meio de uma automação para um cliente real, com o erro cru da Resend. Recusar
 * na conexão troca esse defeito por uma mensagem própria na tela — e é o que o
 * critério (E) pede: "domínio não verificado recusa com mensagem própria, não
 * erro cru da API". `classificarErroResend` cobre o mesmo caso no ENVIO (quem
 * verificou e depois o domínio caiu), mas a porta de conexão é a primeira.
 *
 * `partially_verified` NÃO conta como verificado: a Resend ainda não envia por
 * um domínio com só parte dos registros prontos, e aceitar aqui seria prometer
 * envio que falharia.
 */
async function localizarDominioNaResend(
  apiKey: string,
  fromEmail: string,
): Promise<
  Exclude<VerificacaoDeDominio, { ok: true }> | { ok: true; client: Resend; dominio: Domain }
> {
  const endereco = (fromEmail ?? "").trim();
  const dominio = dominioDe(endereco);
  // A mesma régua que montará o From no envio. Um domínio verificável não
  // torna válido um endereço com caracteres de cabeçalho.
  if (!dominio || !fromAddress(endereco)) return { ok: false, motivo: "sem_endereco" };
  const client = new Resend(apiKey);
  let resposta: Awaited<ReturnType<Resend["domains"]["list"]>>;
  try {
    resposta = await client.domains.list();
  } catch {
    return { ok: false, motivo: "consulta_indisponivel" };
  }
  if (resposta.error) return { ok: false, motivo: motivoDaConsulta(resposta.error) };
  if (!resposta.data) return { ok: false, motivo: "consulta_indisponivel" };
  const dominios = resposta.data.data;
  if (!Array.isArray(dominios)) return { ok: false, motivo: "consulta_indisponivel" };
  const achado = dominios.find(
    (d) => typeof d?.name === "string" && d.name.toLowerCase() === dominio,
  );
  if (!achado) return { ok: false, motivo: "dominio_nao_verificado", dominio };
  return { ok: true, client, dominio: achado };
}

export async function verificarDominioNaResend(
  apiKey: string,
  fromEmail: string,
): Promise<VerificacaoDeDominio> {
  const consulta = await localizarDominioNaResend(apiKey, fromEmail);
  if (!consulta.ok) return consulta;
  if (consulta.dominio.status !== "verified") {
    return {
      ok: false,
      motivo: "dominio_nao_verificado",
      dominio: consulta.dominio.name.toLowerCase(),
    };
  }
  if (consulta.dominio.capabilities?.sending === "disabled") {
    return { ok: false, motivo: "envio_desabilitado" };
  }
  return { ok: true };
}

/** Dados públicos de DNS/estado; nunca inclui cliente SDK, chave ou envelope. */
export type DominioOficialDaContaResend = Pick<
  GetDomainResponseSuccess,
  "name" | "status" | "capabilities" | "records"
>;

/** Lê os nomes/valores da conta; Return-Path e tipo do registro pertencem ao provedor. */
export async function dominioOficialDaContaResend(
  conta: ContaResendDaOrganizacao,
): Promise<
  Exclude<VerificacaoDeDominio, { ok: true }> | { ok: true; dominio: DominioOficialDaContaResend }
> {
  const consulta = await localizarDominioNaResend(conta.apiKey, conta.fromEmail);
  if (!consulta.ok) return consulta;
  if (!consulta.dominio.id) return { ok: false, motivo: "consulta_indisponivel" };
  try {
    const { data, error } = await consulta.client.domains.get(consulta.dominio.id);
    if (error) return { ok: false, motivo: motivoDaConsulta(error) };
    if (
      !data ||
      data.name?.toLowerCase() !== consulta.dominio.name.toLowerCase() ||
      !Array.isArray(data.records) ||
      !["enabled", "disabled"].includes(data.capabilities?.sending)
    ) {
      return { ok: false, motivo: "consulta_indisponivel" };
    }
    return {
      ok: true,
      dominio: {
        name: data.name,
        status: data.status,
        capabilities: data.capabilities,
        records: data.records,
      },
    };
  } catch {
    return { ok: false, motivo: "consulta_indisponivel" };
  }
}

/**
 * A linha de `organization_resend_accounts` → a conta decifrada, ou `null`.
 *
 * Função PURA sobre a linha (sem rede) para o teste poder montar a linha que
 * quiser. Coluna ausente/cifra torta devolve `null` como resultado do parser;
 * o carregador recusa essa linha, sem confundi-la com a ausência de conta.
 */
export function contaResendDaLinha(linha: unknown): ContaResendDaOrganizacao | null {
  if (typeof linha !== "object" || linha === null) return null;
  const r = linha as Record<string, unknown>;
  if (typeof r.from_email !== "string") return null;
  const fromEmail = r.from_email.trim();
  if (!dominioDe(fromEmail) || !fromAddress(fromEmail)) return null;
  try {
    if (
      r.api_key_ciphertext === undefined ||
      r.api_key_iv === undefined ||
      r.api_key_tag === undefined
    ) {
      return null;
    }
    const apiKey = decryptKey({
      ciphertext: byteaToBuffer(r.api_key_ciphertext),
      iv: byteaToBuffer(r.api_key_iv),
      tag: byteaToBuffer(r.api_key_tag),
    });
    if (apiKey.length < 10) return null;
    return { apiKey, fromEmail };
  } catch {
    // Cifra fechada com outra chave da instalação, bytea torto, tag inválida:
    // não é conta utilizável. O carregador distingue isto de ausência de linha.
    return null;
  }
}

/**
 * Lê a conta conectada desta organização. `null` = não há linha. Erro de
 * leitura ou linha ilegível recusa; o chamador transforma-o em falha visível.
 *
 * O `select` pede SÓ as colunas que a decifragem precisa: nem `api_key_last4`
 * (irrelevante aqui) nem nada além. Quem nunca deve receber a chave em claro é
 * a tela, e a tela nem passa por esta função (usa `estadoDaContaResend`).
 */
export async function carregarContaResend(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ContaResendDaOrganizacao | null> {
  const { data, error } = await admin
    .from("organization_resend_accounts")
    .select("api_key_ciphertext, api_key_iv, api_key_tag, from_email")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    logger.warn("conta Resend da organização: leitura indisponível; envio recusado", {
      codigo: error.code,
    });
    throw new Error("conta_resend_indisponivel");
  }
  if (data === null) return null;
  const conta = contaResendDaLinha(data);
  if (!conta) throw new Error("conta_resend_indisponivel");
  return conta;
}

/**
 * O estado que a TELA pode ver: endereço de remetente e os 4 últimos da chave.
 *
 * É a resposta ao critério (D) — "chave cifrada por organização e nunca vazando
 * em log ou payload de tela". A chave e o ciphertext NUNCA saem desta tabela
 * para o navegador; o `last4` só serve para a pessoa reconhecer qual chave está
 * conectada.
 */
export async function estadoDaContaResend(
  admin: SupabaseClient,
  organizationId: string,
): Promise<EstadoDaContaResend | null> {
  const { data, error } = await admin
    .from("organization_resend_accounts")
    .select("from_email, api_key_last4")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error("conta_resend_indisponivel");
  if (data === null) return null;
  if (!data || typeof data.from_email !== "string" || typeof data.api_key_last4 !== "string")
    throw new Error("conta_resend_indisponivel");
  return { from_email: data.from_email, api_key_last4: data.api_key_last4 };
}

/**
 * Envia UM e-mail pela conta da organização — o mesmo formato de `sendEmail` da
 * Resend da plataforma, só que com a chave E o remetente da ORGANIZAÇÃO.
 *
 * O `fromName` (nome de exibição) continua vindo de quem chama — é o mesmo da
 * fatia 1 (`email_from_name`); aqui só se escolhe o ENDEREÇO, que passa a ser o
 * da organização em vez do da plataforma.
 */
export async function enviarPelaContaDaOrganizacao(
  conta: ContaResendDaOrganizacao,
  args: SendArgsDaConta,
): Promise<ResultadoDaContaDaOrganizacao> {
  // O MESMO `fromAddress` da Resend da plataforma: valida o endereço (recusa
  // cabeçalho injetável) e monta `nome <endereço>`. Só muda de ONDE vem o
  // endereço — o da organização, não o de `RESEND_FROM_EMAIL`.
  const from = fromAddress(conta.fromEmail, args.fromName);
  if (!from) return { ok: false, error: "not_configured" };
  const client = new Resend(conta.apiKey);
  try {
    const { data, error } = await client.emails.send({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo,
      tags: args.tags,
    });
    if (error) {
      return {
        ok: false,
        // O MESMO vocabulário da plataforma: domínio não verificado continua
        // sendo `dominio_nao_verificado` e não um `send_failed` opaco.
        error: classificarErroResend(String(error.name || ""), error.message ?? ""),
        details: error.message,
      };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    return {
      ok: false,
      error: "send_failed",
      details: err instanceof Error ? err.message : String(err),
    };
  }
}
