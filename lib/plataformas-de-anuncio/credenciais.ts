/**
 * A credencial de conversões da organização — lida e decifrada.
 *
 * Mora na fronteira, não no transporte, porque a TABELA é agnóstica: a mesma
 * linha serve qualquer plataforma, mudando só o slug. Fosse dentro de `meta/`, a
 * segunda plataforma copiaria a leitura — e cópia de leitura de credencial é
 * onde nasce o bug de ler a linha da organização errada.
 *
 * ⚠️ SEMPRE COM `organization_id` NO FILTRO. É a lição da #236, que custou caro
 * em `channel_sessions`: identificador de provider não é único por instalação, e
 * uma busca sem a organização casava duas linhas, o `maybeSingle()` devolvia
 * `null` com erro `PGRST116` descartado, e as duas organizações passavam a
 * operar pela conta de outra. Aqui o índice único é `(organization_id, platform)`
 * e o filtro repete a organização — banco e código dizendo a mesma coisa.
 *
 * ⚠️ EXIGE O ADMIN CLIENT. `ad_platform_connections` tem RLS ligada e ZERO
 * policies, com grants revogados de anon/authenticated (migration 0213). Pelo
 * client de sessão isto não devolve nada — nem erro, só vazio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import type { CredencialDeConversao, PlataformaDeAnuncio } from "./types";

/**
 * Por que cada ausência tem um nome próprio: elas pedem coisas diferentes de
 * quem lê a tela. "Nunca conectou" é um convite a conectar; "desligou" é
 * lembrete de que a pausa foi decisão de alguém; "cifra indisponível" é problema
 * de INSTALAÇÃO (a chave mestra não está no ambiente) e nenhum clique na tela da
 * organização resolve. Colapsar os três em "não configurado" mandaria o operador
 * refazer um cadastro que já está certo.
 */
export type MotivoSemCredencial =
  | "sem_conexao"
  | "conexao_desabilitada"
  | "credencial_incompleta"
  | "cifra_indisponivel";

export type LeituraDeCredencial =
  | { ok: true; credencial: CredencialDeConversao }
  | { ok: false; motivo: MotivoSemCredencial };

export async function lerCredencial(
  admin: SupabaseClient,
  organizationId: string,
  plataforma: PlataformaDeAnuncio,
): Promise<LeituraDeCredencial> {
  const { data, error } = await admin
    .from("ad_platform_connections")
    .select("dataset_id, access_token_encrypted, test_event_code, enabled")
    .eq("organization_id", organizationId)
    .eq("platform", plataforma)
    .maybeSingle();

  // O erro NÃO é descartado — foi exatamente o descarte que a #236 mediu.
  if (error) {
    logger.error("[conversoes.credencial] leitura falhou", {
      organizationId,
      plataforma,
      error: error.message,
    });
    return { ok: false, motivo: "sem_conexao" };
  }
  if (!data) return { ok: false, motivo: "sem_conexao" };

  const linha = data as {
    dataset_id: string | null;
    access_token_encrypted: string | null;
    test_event_code: string | null;
    enabled: boolean;
  };

  if (!linha.enabled) return { ok: false, motivo: "conexao_desabilitada" };
  if (!linha.dataset_id || !linha.access_token_encrypted) {
    return { ok: false, motivo: "credencial_incompleta" };
  }

  const token = await decryptWebhookSecret(admin, linha.access_token_encrypted);
  // Decifrar falha quando a GUC da chave mestra não está no ambiente. Devolver
  // "sem conexão" aqui faria a tela pedir para reconectar — e o novo cadastro
  // falharia igual, porque o problema é da instalação e não do cadastro.
  if (!token) return { ok: false, motivo: "cifra_indisponivel" };

  return {
    ok: true,
    credencial: {
      datasetId: linha.dataset_id,
      accessToken: token,
      testEventCode: linha.test_event_code,
    },
  };
}
