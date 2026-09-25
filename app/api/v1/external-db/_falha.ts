/**
 * A tradução de uma falha de acesso ao banco externo para uma resposta HTTP.
 *
 * Compartilhada pelas rotas de leitura porque a MESMA causa tem de produzir o
 * MESMO código nas duas — a tela escolhe a frase pelo `error.code`, e duas rotas
 * discordando sobre o que é "destino bloqueado" fariam a mesma causa aparecer com
 * dois textos diferentes.
 *
 * ─── Por que `cifra_indisponivel` NÃO é 401 ─────────────────────────────────
 *
 * A chave que falta é a da INSTALAÇÃO (`AI_CRED_AES_KEY`), não a sessão de quem
 * está olhando. Um 401 expulsaria para o login um usuário autenticado cujo
 * problema real é configuração do servidor. O estado errado é do recurso; 500 é
 * o que diz isso.
 */
import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";
import type { MotivoAcesso } from "@/lib/external-db/acesso";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O banco externo é MÓDULO OPCIONAL da instalação, desligado por padrão (doc 37,
 * `lib/instalacao/modulos.ts`). Desligado, nenhuma rota dele existe: 404, a
 * mesma resposta de uma rota que nunca foi instalada — e a mesma de
 * `notFound()` na tela. Toda rota de `/api/v1/external-db` chama isto primeiro.
 */
export async function seModuloDesligado(requestId: string): Promise<NextResponse<ApiError> | null> {
  if (await moduloLigado(createAdminClient(), "banco_externo")) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}

export function respostaDeAcesso(
  motivo: MotivoAcesso,
  { requestId, idioma }: { requestId: string; idioma?: Idioma },
): NextResponse<ApiError> {
  const t = (texto: string) => (idioma ? traduzir(texto, idioma) : texto);

  switch (motivo) {
    case "modulo_desligado":
      return fail("not_found", "Not found.", 404, { requestId });
    case "nao_encontrada":
      return fail("not_found", t("Conexão não encontrada."), 404, { requestId });
    case "desativada":
      return fail(
        "external_db_desativada",
        t("Esta conexão está desativada. Ative-a para consultar os dados."),
        409,
        { requestId },
      );
    case "host_bloqueado":
      return fail(
        "external_db_destino_bloqueado",
        t("O endereço desta conexão não é um destino permitido pela política de rede."),
        422,
        { requestId },
      );
    case "dns_falhou":
      return fail(
        "validation_failed",
        t("Não foi possível resolver o endereço desta conexão. Confira o host."),
        422,
        { requestId },
      );
    case "cifra_indisponivel":
      return fail(
        "external_db_sem_chave",
        t(
          "A chave de criptografia da instalação não está disponível, então a senha guardada não pode ser lida. Isso é configuração do servidor.",
        ),
        500,
        { requestId },
      );
    case "banco":
      return fail("internal_error", t("Erro ao carregar a conexão."), 500, { requestId });
  }
}
