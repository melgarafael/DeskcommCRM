/**
 * A tradução de uma falha de leitura para uma resposta HTTP.
 *
 * Compartilhada pelas duas rotas de anúncios porque a MESMA falha tem de
 * produzir o MESMO código nas duas — o cliente escolhe a frase da tela pelo
 * `error.code`, e duas rotas discordando sobre o que é "token expirado" faria a
 * mesma causa aparecer com dois textos diferentes.
 *
 * ─── Por que NENHUMA delas devolve 401 ──────────────────────────────────────
 *
 * O token que falhou é o da PLATAFORMA, não a sessão de quem está olhando a
 * tela. Um 401 aqui seria lido pelo interceptor do `apiClient` como "sua sessão
 * caiu" e expulsaria para o login um usuário perfeitamente autenticado, cujo
 * problema real é uma credencial de terceiro guardada em Configurações. O
 * estado errado é do RECURSO, e 422 é o que diz isso.
 */
import { fail, type ApiError } from "@/lib/api/wrappers";
import type { NextResponse } from "next/server";
import type { FalhaDeLeitura } from "@/lib/plataformas-de-anuncio/types";

interface Opcoes {
  requestId?: string;
}

export function respostaDeFalha(
  falha: FalhaDeLeitura,
  detalhe: string,
  { requestId }: Opcoes = {},
): NextResponse<ApiError> {
  switch (falha) {
    case "token_invalido":
      return fail(
        "ads_token_invalido",
        "A plataforma recusou o token de acesso. Gere um novo em Configurações › Meta Ads.",
        422,
        { requestId, details: detalhe },
      );

    case "permissao_insuficiente":
      // Distinto do anterior de propósito: quem cair aqui e gerar um token novo
      // com o mesmo escopo volta ao mesmo erro. A frase precisa citar `ads_read`.
      return fail(
        "ads_permissao_insuficiente",
        "O token não tem permissão de leitura de anúncios (ads_read) ou não alcança esta conta.",
        422,
        { requestId, details: detalhe },
      );

    case "limite_de_chamadas":
      // ⚠️ 422, e NÃO o 429 que a semântica pediria. A razão é local e concreta:
      // `RETRYABLE_STATUSES` em `lib/api/client.ts` é `{429, 503}`, e o retry
      // acontece DENTRO do `request()` — antes do react-query, fora do alcance
      // de qualquer opção do hook. Devolver 429 faria o cliente repetir 3 vezes
      // com backoff, e cada tentativa gasta 2 chamadas na plataforma (campanhas
      // + insights). Um rate limit viraria 6 chamadas a mais numa conta que a
      // sondagem mostrou estar em `development_access` — ou seja, o status
      // "correto" fundo o próprio problema que ele descreve.
      //
      // O significado não se perde: `ApiError` expõe `code`, e é por ele que a
      // tela escolhe a frase. Se um dia o cliente parar de re-tentar 429 por
      // conta própria, este é o lugar de voltar atrás.
      return fail(
        "ads_limite_de_chamadas",
        "A plataforma limitou as chamadas. Espere alguns minutos e atualize de novo.",
        422,
        { requestId, details: detalhe },
      );

    case "campo_invalido":
      // 502 porque a culpa não é de quem pediu: ou é bug nosso, ou a plataforma
      // removeu um campo da versão que fixamos. Foi o que aconteceu com
      // `video_3_sec_watched_actions` entre a v21 e a v22.
      return fail(
        "ads_campo_invalido",
        "A plataforma recusou um campo desta consulta. Isso é um problema do sistema, não da sua conta — avise quem mantém a instalação.",
        502,
        { requestId, details: detalhe },
      );

    case "transitorio":
      return fail(
        "upstream_unavailable",
        "Não consegui falar com a plataforma agora. Tente atualizar em instantes.",
        502,
        { requestId, details: detalhe },
      );
  }
}

/** A ausência de credencial, que não é falha de leitura e sim de configuração. */
export function respostaSemConexao(
  motivo: "sem_conexao" | "cifra_indisponivel",
  { requestId }: Opcoes = {},
): NextResponse<ApiError> {
  if (motivo === "cifra_indisponivel") {
    // Problema de INSTALAÇÃO (a chave mestra não está no ambiente). Mandar
    // reconectar aqui faria o novo cadastro falhar igual — mesma lição que
    // `credenciais.ts` documenta para o eixo de conversões.
    return fail(
      "ads_cifra_indisponivel",
      "A chave de criptografia da instalação não está disponível, então o token guardado não pode ser lido. Isso é configuração do servidor.",
      503,
      { requestId },
    );
  }
  return fail(
    "ads_sem_conexao",
    "Nenhuma conta de anúncios conectada. Conecte em Configurações › Meta Ads.",
    422,
    { requestId },
  );
}
