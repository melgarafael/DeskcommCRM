/**
 * A PROVA de que quem chama é o módulo `connected` daquela instalação (spec 33, F2 e F5).
 *
 * Extraída de `emitirTokenDoModulo` para que a busca do token e a leitura dos eventos provem a identidade
 * pelo MESMO caminho, sem cópia: o módulo assina `${organização}.${carimbo}.${nonce}` com o segredo da
 * instalação, e esta unidade confere carimbo → segredo → assinatura → nonce.
 *
 * ── Regras que não mudam ────────────────────────────────────────────────────
 *
 * - A ORDEM das conferências é fixa. O nonce só é gravado DEPOIS da assinatura válida, para quem não
 *   conhece o segredo não encher a tabela.
 * - Toda recusa (carimbo, instalação sem segredo, assinatura, repetição) é `recusado`; a rota responde
 *   igual para todas. Falha NOSSA (banco, chave de cifra) é `indisponivel` (5xx), nunca disfarçada.
 * - Esta unidade NÃO decide se a instalação ou a organização estão ativas: quem a usa confere isso depois
 *   (a busca de token pelo `fn_extensions_module_token_rotate`; a leitura de eventos por
 *   `fn_extensions_events_allowed`). Prova de identidade não é autorização.
 * - O motivo e o código do banco (`detalhe`, `dbCode`) existem só para o log de quem chama: nunca vão à
 *   resposta, e nada aqui carrega segredo, assinatura ou nonce.
 */
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  carimboDentroDaJanela,
  decifrarSegredo,
  verificarAssinatura,
} from "./segredo-do-modulo";

/** Os cabeçalhos `X-Module-*` já lidos e com formato conferido (ver `lerCabecalhosDaBusca`). */
export interface CabecalhosDaBusca {
  installationId: string;
  organizationId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/** Nonces mais velhos que isto são apagados na própria prova (a janela do carimbo é de 5 min). */
export const RETENCAO_DOS_NONCES_MS = 10 * 60 * 1000;

export type ResultadoDaProva =
  | { ok: true }
  | {
      ok: false;
      motivo: "recusado" | "indisponivel";
      /** Para o log de quem chama. Nunca vai à resposta. */
      detalhe: string;
      dbCode?: string | null;
    };

/** Carimbo → segredo → assinatura → nonce. `agoraMs` existe para o teste fixar o relógio. */
export async function provarModulo(
  entrada: CabecalhosDaBusca,
  agoraMs: number = Date.now(),
): Promise<ResultadoDaProva> {
  const { installationId, organizationId } = entrada;

  // carimbo dentro da janela (borda inclusiva).
  if (!carimboDentroDaJanela(Number(entrada.timestamp), agoraMs)) {
    return { ok: false, motivo: "recusado", detalhe: "carimbo_fora_da_janela" };
  }

  const admin = createAdminClient();

  // o segredo cifrado da instalação.
  const lido = await admin
    .from("extension_installation_secrets")
    .select("ciphertext")
    .eq("installation_id", installationId)
    .maybeSingle();
  if (lido.error) {
    return { ok: false, motivo: "indisponivel", detalhe: "segredo_nao_lido", dbCode: lido.error.code };
  }
  const cifrado = (lido.data as { ciphertext: string } | null)?.ciphertext;
  if (!cifrado) return { ok: false, motivo: "recusado", detalhe: "sem_segredo" };

  let segredo: string;
  try {
    segredo = decifrarSegredo(cifrado);
  } catch {
    // Chave ausente ou valor ilegível: falha nossa, não do módulo.
    return { ok: false, motivo: "indisponivel", detalhe: "segredo_nao_aberto" };
  }

  // assinatura.
  const assinaturaOk = verificarAssinatura(
    segredo,
    { organizationId, timestamp: entrada.timestamp, nonce: entrada.nonce },
    entrada.signature,
  );
  if (!assinaturaOk) return { ok: false, motivo: "recusado", detalhe: "assinatura_invalida" };

  // nonce: repetição é recusa; a limpeza dos velhos é oportunista e não falha a prova.
  const gravado = await admin
    .from("extension_token_nonces")
    .insert({ installation_id: installationId, nonce: entrada.nonce });
  if (gravado.error) {
    if (gravado.error.code === "23505") {
      return { ok: false, motivo: "recusado", detalhe: "nonce_repetido" };
    }
    return { ok: false, motivo: "indisponivel", detalhe: "nonce_nao_gravado", dbCode: gravado.error.code };
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

  return { ok: true };
}
