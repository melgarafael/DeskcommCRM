/**
 * Zod de toda entrada do OAuth do MCP — registro, pedido de autorização,
 * consentimento, token e revogação. Tudo que chega de fora passa por aqui.
 */
import { z } from "zod";

/** Hosts de loopback: o único caso em que `http:` vale (RFC 8252 §7.3). */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Endereço de volta aceitável. `https` sempre; `http` só em loopback, para
 * clientes que rodam na máquina de quem conecta. Esquema próprio de app
 * (`meuapp://`) e fragmento ficam de fora: o código de autorização vai na query
 * desse endereço, e um esquema que qualquer app instalado pode registrar é um
 * jeito de entregar o código a quem não devia.
 */
export function redirectUriAceitavel(valor: string): boolean {
  let u: URL;
  try {
    u = new URL(valor);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

const redirectUri = z
  .string()
  .max(2000)
  .refine(redirectUriAceitavel, "redirect_uri precisa ser https (ou http em localhost), sem fragmento");

/**
 * O que o registro GRAVA tem teto curto: o registro é aberto, e cada campo
 * guardado é espaço de banco que qualquer um ocupa. Endereço de volta real de
 * cliente de MCP tem algumas dezenas de caracteres.
 */
const redirectUriRegistravel = z
  .string()
  .max(512)
  .refine(redirectUriAceitavel, "redirect_uri precisa ser https (ou http em localhost), sem fragmento");

/** Tamanho máximo do nome do cliente depois de limpo, em caracteres. */
export const TETO_DO_NOME_DO_CLIENTE = 60;

/**
 * O nome que o cliente DECLARA no registro aberto vira texto nosso: título da
 * tela de consentimento e nome do token em API Tokens. Sai o que não é texto
 * visível — formato (`Cf`: direção bidi U+202A–U+202E e U+2066–U+2069, marcas
 * U+200E/U+200F, larguras zero) e controle (`Cc`) —, quebras de linha e
 * espaços viram um espaço só, e o resto é cortado. Vazio depois disso
 * = sem nome (o registro usa o padrão).
 */
export function nomeDeClienteLimpo(bruto: string): string {
  const visivel = bruto
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ") // quebra de linha, tab e separadores viram espaço
    .replace(/\p{Cc}/gu, "")
    .trim();
  return Array.from(visivel).slice(0, TETO_DO_NOME_DO_CLIENTE).join("").trimEnd();
}

/** Teto do corpo do registro, em caracteres — os campos aceitos cabem com folga. */
export const TETO_DO_CORPO_DE_REGISTRO = 8_000;

export const pedidoDeRegistroSchema = z.object({
  redirect_uris: z.array(redirectUriRegistravel).min(1).max(5),
  client_name: z
    .string()
    .max(1000)
    .transform((v) => nomeDeClienteLimpo(v) || undefined)
    .optional(),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_post", "client_secret_basic"])
    .optional(),
  grant_types: z.array(z.string().max(100)).max(10).optional(),
  response_types: z.array(z.string().max(100)).max(10).optional(),
  scope: z.string().max(500).optional(),
});
export type PedidoDeRegistro = z.infer<typeof pedidoDeRegistroSchema>;

export const CLIENT_ID = /^dcc_[A-Za-z0-9_-]{32}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * O pedido de autorização (query do `authorize`). Usado três vezes com a MESMA
 * régua: na ponte pública, na tela de consentimento e na rota que emite o
 * código — nenhuma das três confia que a anterior conferiu.
 */
export const pedidoDeAutorizacaoSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().regex(CLIENT_ID),
  redirect_uri: redirectUri,
  code_challenge: z.string().regex(PKCE_CHALLENGE),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2000).optional(),
});
export type PedidoDeAutorizacao = z.infer<typeof pedidoDeAutorizacaoSchema>;

/** Só os campos que IDENTIFICAM o cliente — o mínimo para decidir para onde devolver erro. */
export const identidadeDoPedidoSchema = z.object({
  client_id: z.string().regex(CLIENT_ID),
  redirect_uri: redirectUri,
  state: z.string().max(2000).optional(),
});

export const consentimentoSchema = pedidoDeAutorizacaoSchema.extend({
  organization_id: z.string().uuid(),
  acesso: z.enum(["leitura", "leitura_e_escrita"]),
  decisao: z.enum(["permitir", "negar"]),
});
export type Consentimento = z.infer<typeof consentimentoSchema>;

const credenciaisDoCorpo = {
  client_id: z.string().max(200).optional(),
  client_secret: z.string().max(200).optional(),
};

export const pedidoDeTokenSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1).max(200),
    redirect_uri: z.string().max(2000),
    code_verifier: z.string().min(43).max(128),
    resource: z.string().max(2000).optional(),
    ...credenciaisDoCorpo,
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1).max(200),
    scope: z.string().max(500).optional(),
    resource: z.string().max(2000).optional(),
    ...credenciaisDoCorpo,
  }),
]);
export type PedidoDeToken = z.infer<typeof pedidoDeTokenSchema>;

export const pedidoDeRevogacaoSchema = z.object({
  token: z.string().min(1).max(300),
  token_type_hint: z.string().max(50).optional(),
  ...credenciaisDoCorpo,
});

/** Corpo de formulário (`application/x-www-form-urlencoded`, o do OAuth) ou JSON → objeto. */
export async function lerCorpoOAuth(req: Request): Promise<Record<string, string> | null> {
  const tipo = req.headers.get("content-type") ?? "";
  try {
    if (tipo.includes("application/json")) {
      const bruto: unknown = await req.json();
      if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
      const saida: Record<string, string> = {};
      for (const [k, v] of Object.entries(bruto)) if (typeof v === "string") saida[k] = v;
      return saida;
    }
    const texto = await req.text();
    if (texto.length > 16_000) return null;
    return Object.fromEntries(new URLSearchParams(texto));
  } catch {
    return null;
  }
}
