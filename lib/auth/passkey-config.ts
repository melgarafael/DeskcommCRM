/**
 * PASSKEY (WebAuthn via GoTrue) — a configuração self-host e a cerâmica binária.
 *
 * A issue #1164 propõe passkey como segundo fator ao lado do TOTP. O GoTrue
 * (v2.186+) já traz o fator `webauthn` desligado por configuração, e a RP
 * (Relying Party) de uma instalação self-host é DOMÍNIO PRÓPRIO — não pode ser
 * hardcode. Este módulo é a única fonte da verdade para:
 *
 *   1. `configPasskeyDoAmbiente` — se a instalação ligou o provider (gate). É
 *      EXATAMENTE o "não registrar provider que só sabe falhar": se o operador
 *      não ligou as chaves, a UI não oferece passkey e as server actions falham
 *      FECHADO. O que as flags NÃO protegem é o lado do GoTrue — ele precisa de
 *      `GOTRUE_MFA_WEB_AUTHN_ENROLL_ENABLED`/`_VERIFY_ENABLED` e do RP vindo
 *      desse mesmo env. As duas pontas têm que bater; esta ponta decide a UI.
 *
 *   2. `temSegundoFatorVerificado` — o conceito de "MFA cadastrado" do app já
 *      viu só TOTP (`isMfaEnrolled`). Um fator webauthn verificado ELEVA aal2
 *      como o TOTP (é um fator real), então a mesma pergunta precisa contar os
 *      dois. Extrair para função pura é o que permite testar isso sem rede.
 *
 *   3. Transporte binário servidor↔navegador. A cerimônia WebAuthn roda só no
 *      navegador (`navigator.credentials`), mas os fatores vivem na sessão do
 *      servidor (cookie httpOnly — ver `lib/supabase/browser.ts`). As server
 *      actions recebem do browser as opções com `challenge`/`user.id`/id de
 *      credencial como `Uint8Array`, e o browser devolve a credencial já em
 *      JSON (`toJSON()`). O meio é JSON — então os bytes viram base64url aqui.
 *
 * Os helpers de transporte são puros e testados (round-trip), para o caminho
 * não depender de "funcionou na minha máquina".
 */

// ─── Configuração da Relying Party, vinda de env ───────────────────────────

export interface ConfigPasskey {
  /** Se a instalação ligou o provider. Falso = UI não oferece, actions falham. */
  disponivel: boolean;
  /** RP ID (hostname da instalação, sem scheme). Presente quando `disponivel`. */
  rpId?: string;
  /** Origens permitidas (opcional). Vazio = o app usa a origem da requisição. */
  rpOrigins?: string[];
}

export const ENV_PASSKEY_LIGADO = "DESKCOMM_MFA_WEBAUTHN_ENROLL_ENABLED";
export const ENV_RP_ID = "DESKCOMM_MFA_WEBAUTHN_RP_ID";
export const ENV_RP_ORIGINS = "DESKCOMM_MFA_WEBAUTHN_RP_ORIGINS";

function parseOrigins(bruto: string | undefined): string[] {
  if (!bruto) return [];
  return bruto
    .split(/[,;\s]+/)
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Decide se o provider passkey pode ser oferecido nesta instalação.
 *
 * Duas portas fecham o provider (retorno `{ disponivel: false }`):
 *   1. O operador não ligou `DESKCOMM_MFA_WEBAUTHN_ENROLL_ENABLED` (= `"true"`).
 *   2. Ligou, mas não definiu `DESKCOMM_MFA_WEBAUTHN_RP_ID` — sem RP, o GoTrue
 *      responde "webAuthn RP ID cannot be empty" em TODO challenge; seria um
 *      provider que só sabe falhar, então nem aparece.
 *
 * `rpOrigins` é opcional: ausente, o app envia só o `rpId` e o GoTrue usa a
 * origem da própria requisição (o comportamento default da verificação). Presente
 * mas com entradas inválidas, as entradas válidas seguem; a validação de origem
 * é feita pelo navegador/GoTrue, não aqui.
 */
export function configPasskeyDoAmbiente(
  env: Record<string, string | undefined>,
): ConfigPasskey {
  const ligado = env[ENV_PASSKEY_LIGADO]?.trim() === "true";
  if (!ligado) return { disponivel: false };
  const rpId = env[ENV_RP_ID]?.trim();
  if (!rpId) return { disponivel: false };
  return { disponivel: true, rpId, rpOrigins: parseOrigins(env[ENV_RP_ORIGINS]) };
}

// ─── "Tem MFA cadastrado?", contando TOTP E webauthn ───────────────────────

export interface FatorVerificavel {
  factor_type?: string;
  status?: string;
}

/**
 * Verdadeiro quando há ao menos UM fator TOTP ou webauthn verificado.
 *
 * Esta é a pergunta de CADASTRO de MFA (`isMfaEnrolled`). Um fator webauthn
 * verificado é um segundo fator tão real quanto um TOTP verificado — a sessão
 * dele SAI em `aal2` do mesmo `mfa.verify`. Tratar só TOTP faria o app ignorar
 * o passkey na hora de decidir "essa conta tem proteção de segundo fator?", o
 * que é o mesmo que não tê-lo.
 */
export function temSegundoFatorVerificado(
  fatores?: FatorVerificavel[] | null,
): boolean {
  if (!fatores) return false;
  return fatores.some(
    (f) =>
      (f.factor_type === "totp" || f.factor_type === "webauthn") &&
      f.status === "verified",
  );
}

// ─── Transporte binário (base64url) ────────────────────────────────────────

function bytesParaBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(u8).toString("base64url");
}

/** base64url → Uint8Array (para o navegador montar o `ArrayBuffer`). */
export function base64urlParaBytes(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}

export interface OpcoesCriacaoTransportaveis {
  /** Todos os campos da creation options, com os binários em base64url. */
  publicKey: Record<string, unknown> & {
    challenge: string;
    user: { id: string; name?: string; displayName?: string };
    excludeCredentials?: { type?: string; id: string; transports?: string[] }[];
  };
}

/**
 * Serializa as creation options do servidor para JSON (base64url nos campos
 * binários) — pronto para atravessar o limite da server action.
 */
export function serializarOpcoesCriacao(
  publicKey: Record<string, unknown> & {
    challenge: Uint8Array;
    user: { id: ArrayBuffer | Uint8Array; name?: string; displayName?: string };
    excludeCredentials?: { id: ArrayBuffer | Uint8Array; type?: string }[];
  },
): OpcoesCriacaoTransportaveis["publicKey"] {
  return {
    ...publicKey,
    challenge: bytesParaBase64url(publicKey.challenge),
    user: {
      ...publicKey.user,
      id: bytesParaBase64url(publicKey.user.id),
    },
    excludeCredentials: publicKey.excludeCredentials?.map((c) => ({
      ...c,
      id: bytesParaBase64url(c.id),
    })),
  };
}

/**
 * Desserializa as creation options (base64url → ArrayBuffer) para o navegador
 * poder entregar à `navigator.credentials.create`.
 */
export function desserializarOpcoesCriacao(
  publicKey: OpcoesCriacaoTransportaveis["publicKey"],
): Record<string, unknown> & {
  challenge: Uint8Array;
  user: { id: Uint8Array; name?: string; displayName?: string };
} {
  return {
    ...publicKey,
    challenge: base64urlParaBytes(publicKey.challenge),
    user: {
      ...publicKey.user,
      id: base64urlParaBytes(publicKey.user.id),
    },
    excludeCredentials: publicKey.excludeCredentials?.map((c) => ({
      ...c,
      id: base64urlParaBytes(c.id),
    })),
  };
}

/**
 * Formato de `PublicKeyCredential.toJSON()` (RegistrationResponseJSON) — o que
 * navega do browser para a server action de confirmação depois da cerimônia.
 * Todos os binários já vêm em base64url do próprio navegador.
 */
export interface CredencialDeRegistroJSON {
  id: string;
  rawId?: string;
  type: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
  };
  clientExtensionResults?: Record<string, unknown>;
  authenticatorAttachment?: string | null;
}

/**
 * Reconstrói a credencial bruta (com `Uint8Array`) a partir do JSON do browser,
 * no formato que a `mfa.verify` do auth-js re-serializa identicamente antes de
 * mandar ao GoTrue. Round-trip preservado: `serialize(raw).toJSON() === json`.
 */
export function reconstruirCredencialDeRegistro(
  json: CredencialDeRegistroJSON,
): {
  id: string;
  rawId: Uint8Array;
  type: string;
  response: { clientDataJSON: Uint8Array; attestationObject: Uint8Array };
  getClientExtensionResults: () => Record<string, unknown>;
  authenticatorAttachment?: string | null;
} {
  return {
    id: json.id,
    rawId: base64urlParaBytes(json.rawId ?? json.id),
    type: json.type,
    response: {
      clientDataJSON: base64urlParaBytes(json.response.clientDataJSON),
      attestationObject: base64urlParaBytes(json.response.attestationObject),
    },
    getClientExtensionResults: () => json.clientExtensionResults ?? {},
    authenticatorAttachment: json.authenticatorAttachment,
  };
}