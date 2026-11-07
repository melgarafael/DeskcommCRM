import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createBrasilApiClient } from "@/lib/brasil-api/client";
import { formatarCep, normalizarCep, type CepConsultado } from "@/lib/contacts/endereco-por-cep";

import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/contacts/cep?cep=01310100
 *
 * CEP → logradouro, bairro, cidade e UF para a tela PREENCHER os campos do
 * endereço da pessoa física (#3494). Não grava nada, não toca no banco e não
 * devolve dado de contato: é a mesma consulta pública de CEP que a BrasilAPI
 * serve, feita pelo servidor por causa do `User-Agent` que a borda dela exige
 * (`lib/brasil-api/client.ts`) e para não expor a origem do navegador.
 *
 * ─── Papel ──────────────────────────────────────────────────────────────────
 *
 * `agent`, o MESMO piso de quem cria e edita contato (`POST /api/v1/contacts`,
 * `PATCH /api/v1/contacts/[id]`). O lookup de CNPJ pede `manager` porque lá
 * quem cria empresa é manager; aqui o cadastro de pessoa é rotina de
 * atendimento, e exigir mais fecharia o recurso justamente para quem cadastra.
 *
 * ─── CEP inválido não é erro de servidor ────────────────────────────────────
 *
 * 7 dígitos, letras ou campo vazio saem como 422 `validation_failed` ANTES de
 * qualquer chamada externa. Mas a tela não trata isso como impedimento para
 * salvar: o CEP é texto livre no schema (o produto atende fora do Brasil), e o
 * que a pessoa digitou é gravado como está. Este 422 é só a resposta da
 * CONSULTA — nunca a da gravação.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma ?? "pt-BR");

  const cep = normalizarCep(req.nextUrl.searchParams.get("cep"));
  if (!cep) {
    return fail("validation_failed", t("CEP deve ter 8 dígitos."), 422, {
      details: { cep: [t("CEP deve ter 8 dígitos.")] },
      requestId,
    });
  }

  try {
    const resultado = await createBrasilApiClient().lookupCep(cep);
    if (!resultado.ok) {
      if (resultado.code === "not_found") {
        return fail("cep_nao_encontrado", t("CEP não encontrado."), 404, { requestId });
      }
      if (resultado.code === "invalid_cep") {
        return fail("validation_failed", t("CEP deve ter 8 dígitos."), 422, { requestId });
      }
      return fail(
        "upstream_unavailable",
        t("Não foi possível consultar o CEP agora. Preencha o endereço à mão."),
        502,
        { requestId },
      );
    }

    const endereco: CepConsultado = {
      cep: formatarCep(cep),
      street: resultado.data.street ?? null,
      district: resultado.data.neighborhood ?? null,
      city: resultado.data.city ?? null,
      state: resultado.data.state ?? null,
    };
    return ok(endereco, { requestId });
  } catch {
    return fail(
      "upstream_unavailable",
      t("Não foi possível consultar o CEP agora. Preencha o endereço à mão."),
      502,
      { requestId },
    );
  }
}
