/**
 * POST /api/v1/contacts/merge — junta dois cadastros da MESMA pessoa em um.
 *
 * A regra inteira mora em `fn_mesclar_contatos` (migration 0215), e de propósito:
 * a fusão trava as duas pontas, reponta TODA FK que aponta para o perdedor —
 * lista derivada de `pg_constraint`, não escrita à mão — e escreve a lápide na
 * MESMA transação. Fazer isso em TypeScript, com um `update` por tabela, daria
 * fusão pela metade a cada timeout, e fusão não tem desfazer.
 *
 * Esta rota é a porta: autoriza, valida, chama, audita. `manager` é o piso — o
 * mesmo das policies de `merge_queue` —, e o gate é `requireRole`, nunca uma
 * comparação de rank na mão.
 *
 * O cliente é o do USUÁRIO (cookie), não o admin: assim `auth.uid()` chega à
 * função, ela reconfere o papel na org e a atividade da timeline sai com
 * `performed_by_user_id` preenchido. Trocar por service role apagaria as três
 * coisas de uma vez.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { contactsMergeSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * O que a função levanta ↔ o que o operador precisa ler.
 *
 * `message` do `raise` chega em `error.message`; o código SQLSTATE chega em
 * `error.code`. Casar pela MENSAGEM (e não pelo código) é de propósito: três
 * desfechos distintos compartilham o `22023`/`P0002`, e é a mensagem que os
 * separa. Sem este mapa, todo desfecho previsto viraria 500 — e um 500 diz ao
 * operador "o sistema quebrou" quando o que houve foi "esse contato não serve".
 */
const DESFECHOS: Record<string, { code: string; status: number; message: string }> = {
  insufficient_role: {
    code: "forbidden_role",
    status: 403,
    message: "Juntar contatos exige papel de gerente ou acima.",
  },
  selecao_de_mesclagem_invalida: {
    code: "validation_failed",
    status: 422,
    message: "Seleção inválida: escolha um contato principal e ao menos um a ser absorvido.",
  },
  secundario_repetido: {
    code: "validation_failed",
    status: 422,
    message: "O mesmo contato aparece duas vezes na seleção.",
  },
  contato_principal_indisponivel: {
    code: "not_found",
    status: 404,
    message:
      "O contato principal não está disponível — ele pode ter sido anonimizado ou já mesclado em outro.",
  },
  contato_secundario_indisponivel: {
    code: "not_found",
    status: 404,
    message:
      "Um dos contatos selecionados não está disponível — ele pode ter sido anonimizado ou já mesclado em outro.",
  },
};

interface ResultadoDaFusao {
  contato_id: string;
  contatos_mesclados: string[];
  repontado: Record<string, number>;
  nao_repontado: Record<string, number>;
  atividades_emitidas: number;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "contact" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let input;
  try {
    input = await validateRequest(contactsMergeSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_mesclar_contatos", {
    p_organization_id: org.orgId,
    p_contato_principal: input.primary_contact_id,
    p_contatos_secundarios: input.secondary_contact_ids,
  });

  if (error) {
    // Casamento por CONTINÊNCIA, não por igualdade. O `message` que o PostgREST
    // devolve é o do `raise`, mas isso é contrato de uma camada que não é nossa:
    // basta ele passar a decorar a linha ("...: insufficient_role") para a
    // igualdade parar de casar — e o modo de falha seria 500 em TODO desfecho
    // previsto, ou seja, o operador lendo "o sistema quebrou" quando o que houve
    // foi "esse contato não serve". A continência sobrevive à decoração; os seis
    // rótulos não são prefixo um do outro, então não há ambiguidade.
    const bruto = error.message ?? "";
    const chave = Object.keys(DESFECHOS).find((k) => bruto.includes(k));
    const previsto = chave ? DESFECHOS[chave] : undefined;
    if (previsto) {
      return fail(previsto.code, previsto.message, previsto.status, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  const resultado = data as unknown as ResultadoDaFusao;

  // A auditoria é o rastro que EXISTE SEMPRE. A timeline do passo 7 da função
  // só tem onde escrever quando o vencedor tem negócio no funil
  // (`crm_lead_activities.lead_id` é NOT NULL); um contato sem negócio nenhum
  // sairia da fusão sem registro em lugar algum se esta linha não existisse.
  await audit({
    action: "contact.merged",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "contact",
    resourceId: input.primary_contact_id,
    requestId,
    metadata: {
      merged_contact_ids: input.secondary_contact_ids,
      repointed: resultado.repontado,
      // O que NÃO foi repontado vai junto, e não só o que deu certo: são linhas
      // que continuam apontando para a lápide (colisão com um índice único de
      // runtime). Auditar só o sucesso descreveria uma fusão completa que não foi.
      not_repointed: resultado.nao_repontado,
      timeline_activities: resultado.atividades_emitidas,
    },
  });

  return ok(resultado, { requestId });
}
