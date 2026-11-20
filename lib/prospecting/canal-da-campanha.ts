import type pg from "pg";
import { ProspectingError } from "./provider";

/**
 * O NÚMERO DE WHATSAPP DE UMA CAMPANHA DE PROSPECÇÃO (issue #3896).
 *
 * Mora num módulo sem banco de propósito: quem precisa desta resposta são o
 * worker (que já está no meio de um cliente `pg`) e a loja (que valida a
 * conexão) — e ambos só precisam da REGRA, não da consulta. O teste do worker
 * dubla `@/lib/prospecting/store` inteiro; manter a função aqui evita que o
 * dublê tenha de reimplementá-la, que é como um teste passa a medir a si
 * mesmo.
 *
 * A COLUNA é a fonte da verdade desde a migration 9221. O jsonb `config` é a
 * rede de segurança para a campanha que já estava `running` quando a coluna
 * foi criada e cujo `config` existia (o backfill da migration copia justamente
 * esse valor). `config` nulo é rascunho nunca iniciado: aí não há número, e
 * quem inicia grava os dois juntos.
 */
export function canalDaCampanha(c: {
  channel_session_id?: string | null;
  config?: unknown;
}): string | null {
  if (c.channel_session_id) return c.channel_session_id;
  const bruto = (c.config as { channel_session_id?: unknown } | null)?.channel_session_id;
  return typeof bruto === "string" && bruto ? bruto : null;
}

/**
 * UMA CAMPANHA EM ANDAMENTO POR NÚMERO (issue #3896).
 *
 * A régua anterior era por ORGANIZAÇÃO: três conexões conectadas dividiam uma
 * campanha só, e o volume diário ficava o de um número. A troca de chave não é
 * cosmética — cada número tem agente publicado, região e aquecimento próprios,
 * e é o AQUECIMENTO que proíbe duas campanhas no MESMO número: as duas
 * somariam no mesmo teto de primeiras abordagens, que é o que a plataforma
 * pune com banimento. Por isso a trava continua existindo, agora com o número
 * como sujeito.
 *
 * Quem chama: `start` (`activateCampaign`) e `resume` (rota). As duas pelo
 * MESMO caminho, senão a retomada continua travando o que o início liberou —
 * e era exatamente esse o segundo ponto que segurava a prospecção por
 * organização.
 */
export async function assertCanalLivre(
  db: pg.PoolClient,
  org: string,
  campaignId: string,
  channelSessionId: string | null,
) {
  // Sem número não há o que comparar: rascunho nunca iniciado tem `config`
  // nulo, e é o `validateConfig` do `start` que exige o número de quem vai
  // rodar. `resume` só chega aqui com campanha pausada, que já tem número.
  if (!channelSessionId) return;
  const ocupada = (
    await db.query<{ id: string; name: string }>(
      "select id,name from prospecting_campaigns where organization_id=$1 and channel_session_id=$2 and status='running' and id<>$3 order by created_at,id limit 1",
      [org, channelSessionId, campaignId],
    )
  ).rows[0];
  if (!ocupada) return;
  throw new ProspectingError(
    `A conexão escolhida já tem uma campanha em andamento ("${ocupada.name}"). Pause essa campanha para usar o mesmo número em outra.`,
    409,
    "campanha",
    "prospecting_channel_busy",
    { campaign_id: ocupada.id, campaign_name: ocupada.name },
  );
}
