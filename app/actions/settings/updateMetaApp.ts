"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";

import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export type UpdateMetaAppResult =
  /** `verifyToken` SÓ vem quando o token acabou de ser gerado — é a única vez que ele sai do servidor. */
  | { ok: true; verifyToken?: string }
  | { ok: false; error: string; details?: unknown };

/**
 * O app da Meta DESTA INSTALAÇÃO: App Secret gravado pelo dono, verify token
 * gerado pelo SERVIDOR.
 *
 * ── O defeito que isto fecha ─────────────────────────────────────────────────
 *
 * Conectar a API oficial exigia SSH na VPS e quatro variáveis no `.env`, e só
 * funcionava para UM número por instalação (issue #850). O produto é self-host
 * para quem NÃO programa: nomear variáveis de ambiente para essa pessoa é o
 * mesmo que dizer que a funcionalidade não existe.
 *
 * ── Por que o gate é `is_platform_admin`, e não `admin` do tenant ────────────
 *
 * O objeto é a INSTALAÇÃO, não a organização: um app da Meta atende as WABAs de
 * todos os clientes daquela VPS. Num revendedor que hospeda várias empresas,
 * deixar o admin de um tenant trocar essa credencial derrubaria a entrada de
 * mensagens de TODOS — mesmo argumento de `updateGoogleOAuth.ts`, que este
 * arquivo espelha.
 *
 * ── Por que a escrita vai pelo admin client ──────────────────────────────────
 *
 * `platform_meta_app` tem RLS LIGADA e ZERO POLICIES, com os privilégios de
 * `anon` e `authenticated` revogados (migration 0257). Pelo client de sessão
 * nada acontece — nem leitura. É deliberado: a anon key vai para o browser, e
 * quem tem o App Secret assina uma entrega de webhook VÁLIDA com dados que ele
 * inventar.
 *
 * ── Por que o verify token é gerado AQUI ─────────────────────────────────────
 *
 * O operador não inventa nada: ele cola o que a Meta exige no painel, e um token
 * escolhido à mão ("deskcomm", o nome da empresa) é adivinhável — quem o acerta
 * responde ao handshake e passa a receber o tráfego do webhook. 32 bytes de
 * aleatório do CSPRNG do sistema, em `base64url` porque o valor viaja como query
 * string (`?hub.verify_token=...`), e `+`/`/` de base64 comum virariam `%2B`/`%2F`
 * em qualquer cópia manual.
 *
 * Ele é EXIBIDO UMA VEZ: depois de gravado, nenhuma leitura o devolve em claro
 * (a coluna é `bytea` cifrado por `fn_encrypt_oauth`, e não há policy nem grant
 * que a sirva). Por isso existe `rotacionarVerifyTokenDaMeta()` — sem ela, quem
 * perdesse o valor ficaria sem caminho nenhum, e a tela viraria um beco sem saída.
 *
 * ── NUNCA em claro ───────────────────────────────────────────────────────────
 *
 * Se `fn_encrypt_oauth` não puder cifrar (chave mestra ausente na instalação), o
 * save RECUSA. Cair para texto puro aqui seria pior que o defeito original:
 * trocaria "não dá para configurar" por "está configurado e desprotegido", e o
 * segundo não tem sintoma. Mesma decisão de `updateGoogleOAuth.ts` e de
 * `app/api/v1/channels/official/route.ts`.
 */
const entradaSchema = z.object({
  /**
   * OPCIONAL de propósito: permite salvar de novo sem redigitar o segredo, que a
   * tela nunca mostra de volta. Vazio significa "mantenha o que está gravado" —
   * apagar é outro caminho, e confundir os dois derrubaria a entrada de mensagens
   * de todo mundo num salvamento distraído.
   *
   * 32 hexadecimais é o formato real do App Secret da Meta; o piso de 16 dá
   * folga para quem colou de um gerenciador de segredos sem espaços sobrando.
   */
  app_secret: z.string().trim().min(16).max(300).optional(),
});

export type MetaAppInput = z.infer<typeof entradaSchema>;

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** O verify token novo: aleatório forte, e seguro para colar em query string. */
function gerarVerifyToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Grava o que foi pedido e devolve o verify token quando ele NASEU agora.
 *
 * Uma função só para os dois caminhos (primeiro save e rotação) porque a
 * diferença é apenas QUANDO gerar: tudo o mais — cifra, upsert, invalidação do
 * memo, trilha — tem de ser idêntico, e duplicar isso é como os dois divergem.
 */
async function gravar(
  authUser: { id: string },
  valores: Record<string, unknown>,
  acao: "platform_meta_app.updated" | "platform_meta_app.verify_token_rotated",
  metadata: Record<string, unknown>,
): Promise<UpdateMetaAppResult> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("platform_meta_app")
    // `upsert` e não `update`: a linha não existe numa instalação que nunca
    // configurou o app, e um `update` casaria zero linhas devolvendo SUCESSO — a
    // tela diria "salvo" e nada seria gravado. É o modo de falha que a issue #144
    // mediu em `organizations`, e a defesa é não escrever a query que o permite.
    .upsert({ id: 1, ...valores }, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };

  // No MESMO processo que renderiza (na VPS há um processo de app só), então a
  // credencial nova vale na próxima entrega sem esperar o TTL de 30s.
  invalidarAppDaMeta();

  const cabecalhos = await headers();
  await audit({
    action: acao,
    actorUserId: authUser.id,
    // Sem `organizationId`: a credencial da instalação não pertence a tenant
    // nenhum, e carimbar a organização ativa faria a trilha sugerir que a mudança
    // foi de um cliente, quando ela afeta todos.
    resourceType: "platform_meta_app",
    // `null`, e NÃO `"1"`: `api_audit_log.resource_id` é `uuid`, e a chave natural
    // do singleton faria o INSERT do audit estourar com 22P02. Como audit é
    // fire-and-forget, a credencial seria gravada, a tela diria "salvo", e a
    // trilha ficaria sem a linha — sem sintoma em tela nenhuma.
    resourceId: null,
    requestId: cabecalhos.get("x-request-id") ?? undefined,
    ip: cabecalhos.get("x-forwarded-for") ?? undefined,
    userAgent: cabecalhos.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    // O QUE mudou, jamais o valor — nem o verify token recém-gerado.
    metadata,
  });

  return { ok: true };
}

/**
 * O que já está gravado — SE existe, nunca QUAL. (A leitura é das colunas cifradas.)
 *
 * ⚠️ LEITURA QUE FALHOU NÃO É "NADA GRAVADO". Esta função ignorava o `error`, e
 * as duas respostas chegavam iguais a quem decide: sem linha. Com a leitura
 * falhando numa instalação já configurada, salvar uma chave nova caía no ramo do
 * primeiro save, gerava um verify token NOVO e o gravava por cima do que o dono
 * já tinha colado no painel da Meta. A tela mostrava o token novo como se fosse
 * o primeiro, sem dizer que o antigo deixou de valer — e a próxima verificação do
 * webhook no painel da Meta falharia. Por isso o erro vira recusa
 * (`leitura_do_app_falhou`), e nada é gravado.
 *
 * Na rotação o desfecho era outro e também errado: nada gravado, mas a recusa
 * dizia `app_secret_obrigatorio` — "cadastre a chave" para quem já cadastrou.
 */
async function oQueEstaGravado(): Promise<
  { ok: true; temSegredo: boolean; temToken: boolean } | { ok: false; recusa: UpdateMetaAppResult }
> {
  const { data, error } = await createAdminClient()
    .from("platform_meta_app")
    .select("app_secret_encrypted, verify_token_encrypted")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    logger.warn("[meta.app] não deu para ler o que está gravado; nada foi alterado", { codigo: error.code });
    return { ok: false, recusa: { ok: false, error: "leitura_do_app_falhou", details: { codigo: error.code } } };
  }
  const linha = data as { app_secret_encrypted?: string | null; verify_token_encrypted?: string | null } | null;
  return {
    ok: true,
    temSegredo: texto(linha?.app_secret_encrypted) !== "",
    temToken: texto(linha?.verify_token_encrypted) !== "",
  };
}

/**
 * Sem chave secreta — nem gravada, nem chegando agora — não se gera token.
 *
 * O resolvedor (`lib/channels/meta/app.ts`) serve o par INTEIRO ou cai para o
 * `.env`. Um token gravado sozinho seria exibido para copiar sem nunca valer: o
 * dono o colaria no painel da Meta e o "Verificar e salvar" de lá receberia 403,
 * sem nada nesta tela que explicasse. Vale para o primeiro save e para a rotação.
 */
const SEM_SEGREDO: UpdateMetaAppResult = { ok: false, error: "app_secret_obrigatorio" };

/**
 * Salva o App Secret e, na PRIMEIRA vez, gera o verify token.
 *
 * Devolve `verifyToken` apenas quando ele acabou de nascer — é a única leitura
 * que o produto oferece desse valor.
 */
export async function updateMetaApp(input: MetaAppInput): Promise<UpdateMetaAppResult> {
  const { user: authUser } = await requirePlatformAdmin();

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_input", details: parsed.error.flatten() };
  }

  const gravado = await oQueEstaGravado();
  if (!gravado.ok) return gravado.recusa;
  const { temSegredo, temToken: jaTemToken } = gravado;
  const segredoNovo = parsed.data.app_secret;

  if (!segredoNovo && !temSegredo) return SEM_SEGREDO;

  if (!segredoNovo && jaTemToken) {
    // Nada a fazer, e dizer isso é melhor que gravar uma trilha de "atualizou"
    // que não atualizou nada.
    return { ok: false, error: "nada_para_salvar" };
  }

  const valores: Record<string, unknown> = { updated_by: authUser.id };
  const campos: string[] = [];

  if (segredoNovo) {
    const cifrado = await encryptWebhookSecret(createAdminClient(), segredoNovo);
    if (!cifrado) {
      return {
        ok: false,
        error:
          "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o segredo não foi gravado",
      };
    }
    valores.app_secret_encrypted = cifrado;
    campos.push("app_secret_encrypted");
  }

  let verifyToken: string | undefined;
  if (!jaTemToken) {
    verifyToken = gerarVerifyToken();
    const cifrado = await encryptWebhookSecret(createAdminClient(), verifyToken);
    if (!cifrado) {
      return {
        ok: false,
        error:
          "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o verify token não foi gravado",
      };
    }
    valores.verify_token_encrypted = cifrado;
    valores.verify_token_created_at = new Date().toISOString();
    campos.push("verify_token_encrypted");
  }

  const r = await gravar(authUser, valores, "platform_meta_app.updated", {
    campos,
    segredo_trocado: Boolean(segredoNovo),
    verify_token_gerado: Boolean(verifyToken),
  });
  if (!r.ok) return r;

  return verifyToken ? { ok: true, verifyToken } : { ok: true };
}

/**
 * Gera um verify token NOVO, substituindo o que estava gravado.
 *
 * Existe porque o valor é exibido uma vez só: sem rotação, quem perdeu o token
 * (ou o colou no painel de outro app) não teria caminho nenhum. Quem roda isto
 * precisa colar o valor novo no painel da Meta logo em seguida — até lá, a
 * verificação de URL da Meta continua usando o antigo, e é por isso que a tela
 * avisa em vez de trocar sozinha.
 */
export async function rotacionarVerifyTokenDaMeta(): Promise<UpdateMetaAppResult> {
  const { user: authUser } = await requirePlatformAdmin();

  const gravado = await oQueEstaGravado();
  if (!gravado.ok) return gravado.recusa;
  if (!gravado.temSegredo) return SEM_SEGREDO;

  const verifyToken = gerarVerifyToken();
  const cifrado = await encryptWebhookSecret(createAdminClient(), verifyToken);
  if (!cifrado) {
    return {
      ok: false,
      error:
        "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o verify token não foi gravado",
    };
  }

  const r = await gravar(
    authUser,
    {
      verify_token_encrypted: cifrado,
      verify_token_created_at: new Date().toISOString(),
      updated_by: authUser.id,
    },
    "platform_meta_app.verify_token_rotated",
    { campos: ["verify_token_encrypted"] },
  );
  if (!r.ok) return r;

  return { ok: true, verifyToken };
}
