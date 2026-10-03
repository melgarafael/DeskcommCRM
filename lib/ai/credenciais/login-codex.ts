/**
 * GUARDAR O LOGIN DO CODEX — UMA função pequena e isolada, de propósito.
 *
 * Mesmo padrão de `./guardar.ts`: o plaintext (os tokens) nunca é persistido em
 * claro, nunca é logado e não sai desta função; a cifra é AES-GCM do
 * `lib/crypto/aes_gcm.ts`, com o envelope aberto só na leitura. A diferença é o
 * destino: `guardar.ts` escreve em `ai_provider_credentials` (que exige
 * `organization_id`), e aqui o token é gravado em `platform_config` como
 * SEGREDO, pela única porta que fala com aquela tabela (`lib/instalacao/config.ts`).
 *
 * ─── A ESCOPO ESTÁ COM O MANTENEDOR — e não foi escolhido aqui ─────────────
 *
 * Ainda está em aberto se este token é UM só da instalação (uma assinatura
 * pessoal atende todas as empresas hospedadas aqui) ou UM por empresa (cada
 * empresa conecta a própria conta). Isso foi declarado no PR #1672 e a decisão
 * é do mantenedor. Hoje a gravação é por INSTALAÇÃO — que é o que a tela de
 * `/admin/sistema` alcança sem escolher organização nenhuma — e é POR ISSO que
 * tudo que decide isso mora neste arquivo: trocar para token por empresa muda
 * aqui (destino e chave), e mais em lugar nenhum do fluxo de login.
 *
 * Enquanto a resposta não chegar, nenhum caminho do agente lê isto: o login
 * entra ligado, e a fiação vem na próxima fatia.
 */
import { gravarPelaTela, voltarAoAmbiente, valorDaInstalacao } from "@/lib/instalacao/config";
import type { TokensDoCodex } from "@/lib/ai/pontos/pkce-da-assinatura";

/**
 * A chave em `platform_config` — nomeada como variável de ambiente, como toda
 * a tabela (constraint `platform_config_chave_formato`).
 */
export const CHAVE_DO_LOGIN_CODEX = "OPENAI_CODEX_TOKENS";

export type ResultadoDeGuardarLogin =
  | { ok: true }
  /** `cifragem` = sem chave de cifra no ambiente; `banco` = o banco recusou. */
  | { ok: false; motivo: "cifragem" | "banco" };

/**
 * Grava o par de tokens, cifrados. Sem chave de cifra a escrita NÃO acontece —
 * gravar refresh_token em claro porque a chave sumiu seria o pior desfecho.
 */
export async function guardarLoginCodex(
  tokens: TokensDoCodex,
  ator: string,
): Promise<ResultadoDeGuardarLogin> {
  const resultado = await gravarPelaTela(CHAVE_DO_LOGIN_CODEX, JSON.stringify(tokens), {
    ehSegredo: true,
    ator,
  });
  if (resultado.ok) return { ok: true };
  return { ok: false, motivo: resultado.motivo === "sem_chave_de_cifra" ? "cifragem" : "banco" };
}

/**
 * Lê o par de tokens, decifrado. `null` quando não há linha, quando o envelope
 * não abre ou quando o JSON não é o formato que gravamos — nunca lança, porque
 * quem chama é caminho de chamada e falha aqui deve virar queda, não 500.
 */
export async function lerLoginCodex(): Promise<TokensDoCodex | null> {
  try {
    const { valor } = await valorDaInstalacao(CHAVE_DO_LOGIN_CODEX);
    if (typeof valor !== "string" || valor === "") return null;
    const bruto = JSON.parse(valor) as Partial<TokensDoCodex>;
    if (typeof bruto.access_token !== "string" || typeof bruto.refresh_token !== "string") {
      return null;
    }
    return {
      access_token: bruto.access_token,
      refresh_token: bruto.refresh_token,
      expires_at: typeof bruto.expires_at === "number" ? bruto.expires_at : null,
    };
  } catch {
    return null;
  }
}

/** Desconectar: apaga a linha e deixa o `.env` livre de responder de novo. */
export async function apagarLoginCodex(): Promise<boolean> {
  const resultado = await voltarAoAmbiente(CHAVE_DO_LOGIN_CODEX);
  return resultado.ok;
}
