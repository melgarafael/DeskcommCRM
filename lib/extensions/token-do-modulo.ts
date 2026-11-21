/**
 * A busca do token de um módulo `connected` (spec 33, F2, tarefa 5).
 *
 * O módulo prova que tem o segredo da instalação assinando `${organização}.${carimbo}.${nonce}` e troca
 * a prova por um token curto (`dsk_…`, 1 hora). O banco só guarda o hash: a ativação reservou a vaga
 * (tarefa 2) e `fn_extensions_module_token_rotate` troca o hash dela pelo do token novo.
 *
 * ── Regras que não mudam ────────────────────────────────────────────────────
 *
 * - A ORDEM das conferências é fixa: formato → carimbo → segredo → assinatura → nonce → rotação. O
 *   nonce só é gravado DEPOIS da assinatura válida, para quem não conhece o segredo não encher a tabela.
 * - Toda recusa de autenticação (formato, carimbo, instalação sem segredo, segredo ilegível, assinatura,
 *   repetição, ativação/instalação desligada) devolve o MESMO resultado `recusado`, e a rota responde
 *   com o mesmo corpo: quem erra não aprende se a instalação, a organização ou a ativação existem. O
 *   motivo real só vai ao log, sem segredo, sem assinatura e sem texto de token.
 * - Falha NOSSA (banco, chave de cifra) é `indisponivel` (5xx), nunca disfarçada de recusa.
 * - O texto do token existe só em memória, neste arquivo e na resposta. O banco recebe o hash.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  carimboDentroDaJanela,
  decifrarSegredo,
  verificarAssinatura,
} from "./segredo-do-modulo";

/** A única mensagem de recusa de autenticação. Não varia com o motivo. */
export const MENSAGEM_DE_RECUSA = "Não foi possível autenticar o módulo.";

export const VALIDADE_DO_TOKEN_MS = 60 * 60 * 1000;
/** Nonces mais velhos que isto são apagados na própria busca (a janela do carimbo é de 5 min). */
export const RETENCAO_DOS_NONCES_MS = 10 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cabeçalhos da busca. O nonce não tem ponto: o texto assinado usa `.` como separador e um nonce com
 * ponto o tornaria ambíguo. O carimbo é só dígitos (milissegundos), do jeito que será assinado.
 */
const cabecalhosSchema = z.object({
  installation: z.string().regex(UUID),
  organization: z.string().regex(UUID),
  timestamp: z.string().regex(/^[0-9]{1,15}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  signature: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

export interface CabecalhosDaBusca {
  installationId: string;
  organizationId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/** `null` quando qualquer cabeçalho falta ou tem formato errado. */
export function lerCabecalhosDaBusca(headers: Headers): CabecalhosDaBusca | null {
  const lido = cabecalhosSchema.safeParse({
    installation: headers.get("x-module-installation") ?? "",
    organization: headers.get("x-module-organization") ?? "",
    timestamp: headers.get("x-module-timestamp") ?? "",
    nonce: headers.get("x-module-nonce") ?? "",
    signature: headers.get("x-module-signature") ?? "",
  });
  if (!lido.success) return null;
  return {
    installationId: lido.data.installation.toLowerCase(),
    organizationId: lido.data.organization.toLowerCase(),
    timestamp: lido.data.timestamp,
    nonce: lido.data.nonce,
    signature: lido.data.signature,
  };
}

/**
 * Mesma forma do token da tela de tokens (`app/api/v1/settings/api-tokens/route.ts`):
 * `dsk_<8 hex>_<32 bytes em base64url>`, hash SHA256 do texto inteiro.
 */
export function gerarTokenDoModulo(): { plaintext: string; prefix: string; hashHex: string } {
  const prefix = `dsk_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const hashHex = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, prefix, hashHex };
}

export type ResultadoDaBusca =
  | { ok: true; token: string; expires_at: string }
  | { ok: false; motivo: "recusado" | "indisponivel" };

function recusado(motivo: string, installationId: string): ResultadoDaBusca {
  // Só o motivo e a instalação: nunca assinatura, nonce, segredo nem token.
  logger.warn("[extensions] busca de token recusada", { motivo, installation_id: installationId });
  return { ok: false, motivo: "recusado" };
}

function indisponivel(motivo: string, installationId: string, dbCode?: string | null): ResultadoDaBusca {
  logger.warn("[extensions] busca de token não concluída", {
    motivo,
    installation_id: installationId,
    db_code: dbCode ?? null,
  });
  return { ok: false, motivo: "indisponivel" };
}

/**
 * Passos 3 a 8 da busca (o formato e o rate limit são da rota). `agoraMs` existe para o teste fixar o
 * relógio.
 */
export async function emitirTokenDoModulo(
  entrada: CabecalhosDaBusca,
  requestId: string,
  agoraMs: number = Date.now(),
): Promise<ResultadoDaBusca> {
  const { installationId, organizationId } = entrada;

  // 3. carimbo dentro da janela (borda inclusiva).
  if (!carimboDentroDaJanela(Number(entrada.timestamp), agoraMs)) {
    return recusado("carimbo_fora_da_janela", installationId);
  }

  const admin = createAdminClient();

  // 4. o segredo cifrado da instalação.
  const lido = await admin
    .from("extension_installation_secrets")
    .select("ciphertext")
    .eq("installation_id", installationId)
    .maybeSingle();
  if (lido.error) return indisponivel("segredo_nao_lido", installationId, lido.error.code);
  const cifrado = (lido.data as { ciphertext: string } | null)?.ciphertext;
  if (!cifrado) return recusado("sem_segredo", installationId);

  let segredo: string;
  try {
    segredo = decifrarSegredo(cifrado);
  } catch {
    // Chave ausente ou valor ilegível: falha nossa, não do módulo.
    return indisponivel("segredo_nao_aberto", installationId);
  }

  // 5. assinatura.
  const assinaturaOk = verificarAssinatura(
    segredo,
    { organizationId, timestamp: entrada.timestamp, nonce: entrada.nonce },
    entrada.signature,
  );
  if (!assinaturaOk) return recusado("assinatura_invalida", installationId);

  // 6. nonce: repetição é recusa; a limpeza dos velhos é oportunista e não falha a busca.
  const gravado = await admin
    .from("extension_token_nonces")
    .insert({ installation_id: installationId, nonce: entrada.nonce });
  if (gravado.error) {
    if (gravado.error.code === "23505") return recusado("nonce_repetido", installationId);
    return indisponivel("nonce_nao_gravado", installationId, gravado.error.code);
  }
  const limpeza = await admin
    .from("extension_token_nonces")
    .delete()
    .eq("installation_id", installationId)
    .lt("seen_at", new Date(agoraMs - RETENCAO_DOS_NONCES_MS).toISOString());
  if (limpeza.error) {
    logger.warn("[extensions] nonces velhos não apagados", {
      installation_id: installationId,
      db_code: limpeza.error.code ?? null,
    });
  }

  // 7. token novo; o banco troca o hash da vaga do par.
  const novo = gerarTokenDoModulo();
  const expiresAt = new Date(agoraMs + VALIDADE_DO_TOKEN_MS).toISOString();
  const rotacao = await admin.rpc("fn_extensions_module_token_rotate", {
    p_organization: organizationId,
    p_installation: installationId,
    p_prefix: novo.prefix,
    p_hash: `\\x${novo.hashHex}`,
    p_expires_at: expiresAt,
  });
  if (rotacao.error) {
    // PT409: ativação desativada/inexistente, instalação desligada/removida ou teto cheio. Na resposta é
    // a mesma recusa de qualquer outra; no log, o motivo.
    if (rotacao.error.code === "PT409") return recusado("ativacao_indisponivel", installationId);
    return indisponivel("rotacao_falhou", installationId, rotacao.error.code);
  }

  // 8. audit: o slug vem da instalação; se a leitura falhar, a busca já valeu e o audit leva só o id.
  let slug: string | null = null;
  const instalacao = await admin
    .from("extension_installations")
    .select("publisher,name")
    .eq("id", installationId)
    .maybeSingle();
  const linha = instalacao.data as { publisher: string; name: string } | null;
  if (linha) slug = `${linha.publisher}/${linha.name}`;

  await audit({
    action: "extension.token_issued",
    organizationId,
    resourceType: "extension_installation",
    resourceId: installationId,
    requestId,
    metadata: { installation_id: installationId, module: slug },
  });

  return { ok: true, token: novo.plaintext, expires_at: expiresAt };
}
