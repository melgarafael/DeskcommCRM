import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

/**
 * "CONFIAR NESTE DISPOSITIVO" — 30 dias sem pedir o código de 6 dígitos.
 *
 * O JWT de quem entra por um dispositivo confiável continua `aal1`: só o GoTrue
 * emite `aal2`, e só depois de um código. Por isso a confiança NÃO vive no app:
 * ela é uma linha de `mfa_trusted_devices` amarrada ao `session_id` do JWT, e
 * `fn_session_mfa_proven` (a mesma função que agenda, resposta, roteamento e
 * anonimização já chamam dentro do banco) passa a aceitá-la. O app pergunta a
 * essa função em `mfaEmDivida`, então banco e app não têm como discordar.
 *
 * O cookie carrega só um token aleatório; o banco guarda o SHA-256 dele, como
 * todo bearer desta casa. Sozinho ele não autentica ninguém — a senha (ou o
 * Google) continua obrigatória —, e é por isso que ele é `Lax` e não `Strict`:
 * a volta da entrada com Google é uma navegação iniciada em accounts.google.com,
 * e um cookie `Strict` não chegaria a `/auth/callback`.
 *
 * O que continua pedindo o código mesmo num dispositivo confiável: desligar a
 * própria verificação, gerar códigos de recuperação novos (eles desligam o fator
 * pela porta da recuperação), trocar a senha (o GoTrue exige `aal2`) e o poder de
 * PLATAFORMA — `/admin/**` e as telas da instalação (`mfaEmDividaEstrita`), e
 * o admin da plataforma agindo numa empresa onde não é admin (`mfaEmDivida`).
 *
 * A confiança é do FATOR, não só da pessoa: remover o fator por qualquer caminho
 * (desligar, código de recuperação, script de suporte) a invalida no banco.
 */

export const COOKIE_DISPOSITIVO_CONFIAVEL = "mfa_dispositivo_confiavel";
export const DIAS_DE_CONFIANCA = 30;
const UM_DIA_MS = 86_400_000;

function hashDoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * O `session_id` de um access token que o GoTrue ACABOU de devolver a este
 * servidor (`signInWithPassword`, `exchangeCodeForSession`). Não é para token
 * vindo de cookie: aqui ele não é verificado, só lido.
 */
function sessionIdDoAccessToken(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload?.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

/**
 * Emite a confiança: grava o hash e põe o token no cookie. Só pode ser chamada
 * logo depois de um código PROVADO (`verifyMfa`) — é isso que a autoriza.
 * Aproveita para apagar as confianças vencidas da pessoa, que é o único lugar
 * onde elas nasceriam e se acumulariam.
 */
export async function confiarNesteDispositivo(
  userId: string,
  factorId: string,
  userAgent: string | null,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const admin = createAdminClient();
  await admin.from("mfa_trusted_devices").delete().eq("user_id", userId).lt("expires_at", new Date().toISOString());
  const { error } = await admin.from("mfa_trusted_devices").insert({
    user_id: userId,
    factor_id: factorId,
    token_hash: hashDoToken(token),
    user_agent: userAgent?.slice(0, 300) ?? null,
    expires_at: new Date(Date.now() + DIAS_DE_CONFIANCA * UM_DIA_MS).toISOString(),
  });
  if (error) throw error;
  (await cookies()).set(COOKIE_DISPOSITIVO_CONFIAVEL, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    maxAge: DIAS_DE_CONFIANCA * 86_400,
    path: "/",
  });
}

/**
 * Na entrada (senha ou Google): este navegador tem uma confiança válida DESTA
 * pessoa, emitida para o fator que ela tem HOJE? Se tem, amarra a sessão
 * recém-criada a ela e devolve `true` — e o banco passa a tratar a sessão como
 * provada. Sem cookie, cookie de outra pessoa, fator trocado ou confiança
 * vencida: `false`, e a entrada segue para o código.
 */
export async function reconhecerDispositivoConfiavel(
  userId: string,
  factorId: string,
  accessToken: string,
): Promise<boolean> {
  const token = (await cookies()).get(COOKIE_DISPOSITIVO_CONFIAVEL)?.value;
  if (!token) return false;
  const sessionId = sessionIdDoAccessToken(accessToken);
  if (!sessionId) return false;
  const { data, error } = await createAdminClient()
    .from("mfa_trusted_devices")
    .update({ session_id: sessionId, last_used_at: new Date().toISOString() })
    .eq("token_hash", hashDoToken(token))
    .eq("user_id", userId)
    .eq("factor_id", factorId)
    .gt("expires_at", new Date().toISOString())
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export interface DispositivoConfiavel {
  id: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

export async function listarDispositivosConfiaveis(userId: string): Promise<DispositivoConfiavel[]> {
  const { data, error } = await createAdminClient()
    .from("mfa_trusted_devices")
    .select("id, user_agent, created_at, last_used_at, expires_at")
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Apaga TODAS as confianças da pessoa — e, com elas, a sessão que cada uma provava. */
export async function esquecerDispositivosConfiaveis(userId: string): Promise<void> {
  const { error } = await createAdminClient().from("mfa_trusted_devices").delete().eq("user_id", userId);
  if (error) throw error;
}
