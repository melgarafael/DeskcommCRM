/**
 * A credencial de LEITURA da organização — lida e decifrada.
 *
 * Irmã de `credenciais.ts`, que faz o mesmo para o eixo de conversões. As duas
 * existem separadas porque as tabelas são separadas, e as tabelas são separadas
 * pelas quatro razões no cabeçalho da migration 0214 — a primeira delas sendo
 * que o índice único da 0213 é `(organization_id, platform)` e os dois tokens
 * têm escopos diferentes na plataforma.
 *
 * ⚠️ SEMPRE COM `organization_id` NO FILTRO. Mesma lição da #236 que
 * `credenciais.ts` documenta: identificador de provider não é único por
 * instalação, e uma busca sem a organização casava duas linhas, o `maybeSingle()`
 * devolvia `null` com `PGRST116` descartado, e duas organizações passavam a
 * operar pela conta de outra. Aqui o índice é `(organization_id, platform)` e o
 * filtro repete a organização — banco e código dizendo a mesma coisa.
 *
 * ⚠️ EXIGE O ADMIN CLIENT. `ad_insights_connections` tem RLS ligada e ZERO
 * policies, com grants revogados de anon/authenticated (0214). Pelo client de
 * sessão isto não devolve nada — nem erro, só vazio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import type { CredencialDeLeitura, PlataformaDeAnuncio } from "./types";

/**
 * Três ausências, três significados, e nenhum deles é "não configurado".
 *
 * Uma a menos que em `credenciais.ts`: lá existe `conexao_desabilitada` porque
 * lá existe um switch de pausa. Aqui a 0205 não tem `enabled` — desconectar é
 * apagar a linha — então "desligado" não é um estado alcançável, e inventar o
 * motivo faria a tela oferecer um botão de religar que não liga nada.
 */
export type MotivoSemLeitura = "sem_conexao" | "cifra_indisponivel";

export type LeituraDeCredencialDeLeitura =
  | { ok: true; credencial: CredencialDeLeitura }
  | { ok: false; motivo: MotivoSemLeitura };

export async function lerCredencialDeLeitura(
  admin: SupabaseClient,
  organizationId: string,
  plataforma: PlataformaDeAnuncio,
): Promise<LeituraDeCredencialDeLeitura> {
  const { data, error } = await admin
    .from("ad_insights_connections")
    .select("access_token_encrypted, default_account_id")
    .eq("organization_id", organizationId)
    .eq("platform", plataforma)
    .maybeSingle();

  // O erro NÃO é descartado — foi exatamente o descarte que a #236 mediu.
  if (error) {
    logger.error("[ads.credencial-de-leitura] leitura falhou", {
      organizationId,
      plataforma,
      error: error.message,
    });
    return { ok: false, motivo: "sem_conexao" };
  }
  if (!data) return { ok: false, motivo: "sem_conexao" };

  const linha = data as {
    access_token_encrypted: string | null;
    default_account_id: string | null;
  };

  // A coluna é NOT NULL no schema, então isto não deveria acontecer. A guarda
  // fica porque o tipo do client não sabe disso, e um `!` aqui trocaria um
  // caminho tratado por um crash na rota.
  if (!linha.access_token_encrypted) return { ok: false, motivo: "sem_conexao" };

  const token = await decryptWebhookSecret(admin, linha.access_token_encrypted);
  // Decifrar falha quando a GUC da chave mestra não está no ambiente. Devolver
  // "sem conexão" aqui faria a tela pedir para reconectar — e o novo cadastro
  // falharia igual, porque o problema é da INSTALAÇÃO e não do cadastro.
  if (!token) return { ok: false, motivo: "cifra_indisponivel" };

  return {
    ok: true,
    credencial: { accessToken: token, contaPadrao: linha.default_account_id },
  };
}

/**
 * Existe conexão? — sem decifrar nada.
 *
 * A página server-side só precisa saber se mostra a tabela ou o convite a
 * conectar. Chamar `lerCredencialDeLeitura()` para isso traria o token em claro
 * para dentro de um componente que renderiza HTML, e a única forma de garantir
 * que um segredo não vaza para o browser é ele não entrar no componente.
 */
export async function existeConexaoDeLeitura(
  admin: SupabaseClient,
  organizationId: string,
  plataforma: PlataformaDeAnuncio,
): Promise<{ conectada: boolean; contaPadrao: string | null }> {
  const { data, error } = await admin
    .from("ad_insights_connections")
    .select("default_account_id")
    .eq("organization_id", organizationId)
    .eq("platform", plataforma)
    .maybeSingle();

  if (error) {
    logger.error("[ads.credencial-de-leitura] checagem falhou", {
      organizationId,
      plataforma,
      error: error.message,
    });
    return { conectada: false, contaPadrao: null };
  }

  const linha = data as { default_account_id: string | null } | null;
  return { conectada: Boolean(linha), contaPadrao: linha?.default_account_id ?? null };
}
