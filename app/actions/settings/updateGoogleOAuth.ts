"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { invalidarCredencialDoGoogle } from "@/lib/agenda/google/config";
import { FORMATO_DO_CLIENT_SECRET } from "@/lib/agenda/google/oauth";
import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export type UpdateGoogleOAuthResult =
  | { ok: true }
  | { ok: false; error: string; details?: unknown };

/**
 * Cadastra o app OAuth do Google DESTA INSTALAÇÃO — sem SSH e sem editar `.env`.
 *
 * ── O defeito que isto fecha ─────────────────────────────────────────────────
 *
 * O cartão da Agenda dizia: "Esta instalação não tem as credenciais do Google
 * cadastradas — quem instalou o sistema precisa configurar
 * GOOGLE_CALENDAR_CLIENT_ID e GOOGLE_CALENDAR_CLIENT_SECRET." O produto é
 * self-host para quem NÃO programa. Nomear variáveis de ambiente para essa
 * pessoa é o mesmo que dizer que a funcionalidade não existe.
 *
 * ── Por que o gate é `is_platform_admin`, e não `admin` do tenant ────────────
 *
 * O objeto é a INSTALAÇÃO, não a organização: o `redirect_uri` sai de
 * `NEXT_PUBLIC_APP_URL`, e o app OAuth é registrado no console do Google por
 * quem instalou. Num revendedor que hospeda várias empresas, deixar o admin de
 * um tenant trocar essa credencial derrubaria a conexão do Google de TODOS —
 * exatamente o argumento de `updateBranding.ts`, que este arquivo espelha.
 *
 * ── Por que a escrita vai pelo admin client ──────────────────────────────────
 *
 * `platform_google_oauth` tem RLS LIGADA e ZERO POLICIES, com os privilégios de
 * `anon` e `authenticated` revogados (migration 0201). Pelo client de sessão
 * nada acontece — nem leitura. É deliberado: a anon key vai para o browser, e
 * este segredo permite trocar códigos e refresh tokens em nome da instalação,
 * isto é, ler a agenda de todos os atendentes que conectaram.
 *
 * ── NUNCA em claro ───────────────────────────────────────────────────────────
 *
 * Se `fn_encrypt_oauth` não puder cifrar (chave mestra ausente na instalação), o
 * save RECUSA. Cair para texto puro aqui seria pior que o defeito original:
 * trocaria "não dá para configurar" por "está configurado e desprotegido", e o
 * segundo não tem sintoma. Mesma decisão, mesma frase, de
 * `app/api/v1/channels/official/route.ts`.
 */
const entradaSchema = z.object({
  // Formato real de um client id do Google. Validar aqui evita que quem colou o
  // campo errado descubra só no `redirect_uri_mismatch`, que aponta para o
  // Google e não para o erro de digitação.
  client_id: z.string().trim().min(10).max(300),
  /**
   * OPCIONAL de propósito: permite corrigir só o client id sem redigitar o
   * segredo, que a tela nunca mostra de volta. Vazio significa "mantenha o que
   * está gravado", NÃO "apague" — apagar é outro botão, e confundir os dois
   * derrubaria a conexão de todo mundo num salvamento distraído.
   *
   * ── Por que o `regex`, e o defeito que ele fecha ───────────────────────────
   *
   * Um client secret do Google só contém `[A-Za-z0-9_-]`. Sem esta cerca, o
   * campo aceitava qualquer coisa de 10–300 chars, e o modo de falha medido em
   * produção foi colar o secret JUNTO com o resto da linha do arquivo JSON de
   * credenciais — `GOCSPX-xxxx","redirect_uris` — que tem aspa e vírgula. O save
   * gravava os caracteres a mais, e a única pista chegava lá na frente, na troca
   * do código, como `invalid_client` do Google: um erro que aponta para o Google
   * e não para a colagem. É o mesmo raciocínio do `min(10)` do `client_id` acima,
   * virado para o campo que a tela nunca mostra de volta e por isso ninguém
   * relê. A cerca é no CONJUNTO de caracteres, não no prefixo `GOCSPX-`: secrets
   * antigos do Google não o têm, e o Google pode mudar o formato — o que não
   * muda é que aspa, vírgula e espaço nunca pertencem a um secret. A regra mora
   * em `oauth.ts` (pura), para o formulário avisar na hora pela MESMA cerca.
   */
  client_secret: z
    .string()
    .trim()
    .min(10)
    .max(300)
    .regex(FORMATO_DO_CLIENT_SECRET, "client_secret_invalido")
    .optional(),
});

export type GoogleOAuthInput = z.infer<typeof entradaSchema>;

export async function updateGoogleOAuth(input: GoogleOAuthInput): Promise<UpdateGoogleOAuthResult> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user: authUser } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    // O formato do secret merece frase própria, e não o genérico `invalid_input`:
    // é a falha que a tela precisa explicar com uma AÇÃO ("copie só o GOCSPX-"),
    // não um código. O campo é `type="password"` e some ao salvar — quem errou a
    // colagem não tem como reler e descobrir sozinho. Mesma razão do `min(10)` do
    // `client_id`, virada para o campo que ninguém relê.
    const erroDoSecret = parsed.error.flatten().fieldErrors.client_secret;
    if (erroDoSecret?.includes("client_secret_invalido")) {
      return {
        ok: false,
        error:
          "A chave secreta tem caracteres que não existem numa chave do Google (como aspas, vírgula ou espaço). Copie só o valor que começa com GOCSPX-, sem nada colado depois.",
      };
    }
    return { ok: false, error: "invalid_input", details: parsed.error.flatten() };
  }

  const admin = createAdminClient();
  const valores: Record<string, unknown> = {
    client_id: parsed.data.client_id,
    updated_by: authUser.id,
  };

  if (parsed.data.client_secret) {
    const cifrado = await encryptWebhookSecret(admin, parsed.data.client_secret);
    if (!cifrado) {
      return {
        ok: false,
        error:
          "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o segredo não foi gravado",
      };
    }
    valores.client_secret_encrypted = cifrado;
  }

  const { error } = await admin
    .from("platform_google_oauth")
    // `upsert` e não `update`: a linha não existe numa instalação que nunca
    // configurou o Google, e um `update` casaria zero linhas devolvendo SUCESSO
    // — a tela diria "salvo" e nada seria gravado. É o modo de falha que a issue
    // #144 mediu em `organizations`, e a defesa é não escrever a query que o
    // permite.
    .upsert({ id: 1, ...valores }, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };

  // No MESMO processo que renderiza (na VPS há um processo de app só), então a
  // credencial nova vale no próximo render sem esperar o TTL de 30s.
  invalidarCredencialDoGoogle();

  const cabecalhos = await headers();
  await audit({
    action: "platform_google_oauth.updated",
    actorUserId: authUser.id,
    // Sem `organizationId`: a credencial da instalação não pertence a tenant
    // nenhum, e carimbar a organização ativa faria a trilha sugerir que a
    // mudança foi de um cliente, quando ela afeta todos.
    resourceType: "platform_google_oauth",
    // `null`, e NÃO `"1"`: `api_audit_log.resource_id` é `uuid`, e a chave
    // natural do singleton faria o INSERT do audit estourar com 22P02. Como
    // audit é fire-and-forget, a credencial seria gravada, a tela diria "salvo",
    // e a trilha ficaria sem a linha — sem sintoma em tela nenhuma.
    resourceId: null,
    requestId: cabecalhos.get("x-request-id") ?? undefined,
    ip: cabecalhos.get("x-forwarded-for") ?? undefined,
    userAgent: cabecalhos.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    metadata: {
      // O QUE mudou, jamais o valor. Registrar o client id numa trilha que quem
      // opera a plataforma lê é metade do par; o segredo, nem em metadata.
      campos: Object.keys(valores).filter((k) => k !== "updated_by"),
      segredo_trocado: Boolean(parsed.data.client_secret),
    },
  });

  return { ok: true };
}
