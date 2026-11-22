/**
 * GET /api/v1/contacts/campos-de-contato — as definições de campo do CONTATO de
 * TODOS os funis da organização, unidas por chave (issue #4929).
 *
 * POR QUE EXISTE: o lápis da lista de contatos abre o MESMO `EditContactDialog`
 * da ficha, e a ficha passa `customFieldDefs` (os campos de escopo `contato` do
 * funil). A lista não tem funil: sem esta rota ela abriria o diálogo sem a
 * seção, e quem edita pela lista não veria o campo personalizado que vê na
 * ficha.
 *
 * POR QUE UMA ROTA, E NÃO O CLIENTE JUNTANDO OS FUNIS: o conjunto exibido tem de
 * ser o MESMO que o PATCH julga, e o PATCH pergunta a todos os funis
 * (`defsDoPadraoDaOrg`). Uma leitura só, na mesma função que o handler usa,
 * evita duas réguas — e evita N chamadas de definição por funil.
 *
 * POR QUE `agent` E NÃO `manager`: `GET /api/v1/pipelines` exige `manager`,
 * enquanto a ficha de contato já mostra esses campos para um `agent` (a rota
 * dela é `GET /api/v1/pipelines/default`, que aceita `agent`). Gate maior aqui
 * deixaria o defeito de pé justamente para quem atende.
 *
 * Fail-open como o resto: falha de leitura devolve lista vazia, e a gravação
 * segue pelo caminho de sempre.
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { defsDeContatoDaOrg } from "@/lib/leads/padrao-do-campo";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const definicoes = await defsDeContatoDaOrg(supabase, authz.org.orgId);
  return ok({ definicoes }, { requestId });
}
