/**
 * PATCH /api/v1/contacts/[id]/carteira — põe/tira o cliente na carteira de um
 * vendedor (issue #2591, regra 1/5).
 *
 * ─── Por que existe uma rota em vez de um PATCH em `/contacts/[id]` ─────────
 *
 * Gravar `contacts.carteira_user_id` direto é o defeito, não o fix: a policy de
 * UPDATE de `contacts` não olha papel (medido pelo autor da issue), então
 * qualquer autenticado se põe como dono pela REST e leva o negócio seguinte.
 * O gatilho `trg_contacts_carteira_so_pelo_servidor` recusa a SESSÃO (42501),
 * e esta porta é a única que passa — e ela só passa para `manager`+ chamando a
 * `fn_definir_carteira_do_cliente` (só do service_role, com o ator passado
 * depois do `requireRole`), que revalida o ator, valida o dono
 * candidato (membro ativo da MESMA org, papel que conta) e adota os negócios
 * abertos sem dono na mesma transação.
 *
 * `viewer` não entra: enxerga sem poder. Os dois `.eq` com o `organization_id`
 * da sessão são obrigatórios — o usuário não lê contato de outra org nem por
 * acidente.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { donoQualificado } from "@/lib/carteira/dono";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  /** `null` tira o cliente da carteira (volta ao fluxo normal, sem dono). */
  dono_user_id: z.string().uuid().nullable(),
  origem: z.enum(["manual", "importacao", "atribuicao_automatica"]).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

interface Recusa {
  status: number;
  code: string;
  /** Mensagem canônica em pt-BR; `traduzir` cuida do idioma da sessão. */
  mensagem: string;
}

/** Mensagens em pt-BR fixas, traduzidas na resposta — nunca em inglês. */
function recusaDaFuncao(erro: { code?: string; message?: string } | null): Recusa {
  const bruto = erro?.message ?? "";
  if (bruto.includes("carteira_permissao_negada")) {
    return {
      status: 403,
      code: "carteira_permissao_negada",
      mensagem: "Só gerente e administrador podem mudar a carteira do cliente.",
    };
  }
  if (bruto.includes("carteira_dono_invalido")) {
    return {
      status: 422,
      code: "carteira_dono_invalido",
      mensagem:
        "O dono precisa ser membro ativo desta empresa, com papel de atendente, gerente ou administrador. Quem só lê, e quem saiu da equipe, não é dono de carteira.",
    };
  }
  if (bruto.includes("carteira_contato_nao_encontrado") || bruto.includes("carteira_contato_de_outra")) {
    return {
      status: 404,
      code: "contact_not_found",
      mensagem: "Contato não encontrado nesta empresa.",
    };
  }
  if (bruto.includes("carteira_origem_invalida") || bruto.includes("carteira_parametro_invalido")) {
    return {
      status: 422,
      code: "validation_failed",
      mensagem: "A origem da carteira não é válida.",
    };
  }
  return {
    status: 500,
    code: "carteira_nao_salva",
    mensagem: "Não foi possível salvar a carteira do cliente.",
  };
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const { id: contactId } = await ctx.params;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }
  const dono = lido.data.dono_user_id;
  const origem = lido.data.origem ?? "manual";

  const supabase = await createClient();

  // Antes/para o audit (e para dizer se mudou): lido com a sessão, org junto.
  const { data: contato, error: erroDeLeitura } = await supabase
    .from("contacts")
    .select("id, carteira_user_id")
    .eq("id", contactId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroDeLeitura) {
    return fail("contact_not_found", t("Contato não encontrado nesta empresa."), 404, { requestId });
  }
  const antes = (contato as { carteira_user_id?: string | null } | null)?.carteira_user_id ?? null;

  const { error } = await createAdminClient().rpc("fn_definir_carteira_do_cliente", {
    p_org: orgId,
    p_actor: authz.user.id,
    p_contact: contactId,
    p_dono: dono,
    p_origem: origem,
  });
  if (error) {
    const recusa = recusaDaFuncao(error);
    return fail(recusa.code, t(recusa.mensagem), recusa.status, { requestId });
  }

  await audit({
    action: "contact.carteira_changed",
    resourceType: "contact",
    resourceId: contactId,
    requestId,
    metadata: {
      antes: antes ?? null,
      depois: dono ?? null,
      origem: dono === null ? null : origem,
      adotados: dono !== null, // a RPC adota, na mesma transação, os negócios abertos sem dono
    },
  });

  return ok({ contact_id: contactId, carteira_user_id: dono ?? null }, { requestId });
}

/**
 * GET /api/v1/contacts/[id]/carteira — quem é o dono HOJE, para a TELA (#2591).
 *
 * ─── Por que isto vive na mesma porta do PATCH, e não numa rota nova ────────
 *
 * A tela da carteira é uma feature, um recurso, um caminho: quem grava e quem lê
 * o mesmo dado moram no mesmo arquivo. Uma rota `.../carteira/leitura` só
 * duplicaria o `requireRole` e o filtro de organização para dizer a mesma coisa.
 *
 * ─── O que ela devolve, e o que ela NÃO devolve ─────────────────────────────
 *
 * Devolve `dono_user_id` e `qualificado` — a MESMA régua do motor
 * (`lib/carteira/dono.ts`), aplicada aqui sobre o vínculo de hoje: dono que saiu
 * da equipe ou que só lê NÃO conta (regra 5), e a tela precisa saber disso para
 * não prometer o que o motor não honra.
 *
 * NÃO devolve o NOME do dono: quem tem os nomes é a lista de membros
 * (`/team/assignable`), que a tela já carrega para trocar o dono. Resolver o nome
 * aqui criaria uma segunda fonte de nomes para o mesmo id.
 *
 * `agent`+ lê (a regra 2 é para quem atende). O recorte de `viewer` — "vê só se
 * for da própria carteira, sem o nome dos outros" — fica FORA deste PR, como o
 * #2667 já declarou: exigiria visão por coluna, que o Postgres/RLS não faz.
 */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const { id: contactId } = await ctx.params;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  // Os dois `.eq` (id + organization_id da sessão) são obrigatórios: a RLS de
  // contacts deixa passar as orgs do usuário, e um membro de duas leria a
  // carteira do contato da org que não está selecionada.
  const { data: contato, error } = await supabase
    .from("contacts")
    .select("carteira_user_id")
    .eq("id", contactId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error || !contato) {
    return fail("contact_not_found", t("Contato não encontrado nesta empresa."), 404, { requestId });
  }

  const dono = (contato as { carteira_user_id?: string | null }).carteira_user_id ?? null;
  // Falha de leitura do vínculo degrada para "não conta" (a faixa/cartão trata
  // como dono inativo): nunca é a leitura de tela que estoura a ficha inteira.
  let qualificado = false;
  if (dono) {
    try {
      qualificado = await donoQualificado(createAdminClient(), orgId, dono);
    } catch {
      qualificado = false;
    }
  }

  return ok({ contact_id: contactId, dono_user_id: dono, qualificado }, { requestId });
}
