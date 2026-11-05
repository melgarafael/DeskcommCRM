import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/message-templates — lista os templates visíveis (pessoais + compartilhados
 *      da org ativa; a RLS `message_templates_select` já filtra).
 * POST /api/v1/message-templates — cria um template. `shared=true` grava owner_user_id
 *      null (compartilhado) e exige role manager+; `shared=false` (default) grava
 *      owner_user_id = user.id (pessoal, role agent+ já garantido pelo requireRole).
 *
 * GET e POST aceitam sessão de navegador OU Bearer `dsk_…` (`config:read` no GET,
 * `config:write` no POST; papel admin via `tokenRole`). Token não tem pessoa: no
 * POST ele só cria o template COMPARTILHADO (`shared: true` explícito; o padrão
 * `false` do schema é recusado, porque não há dono para o pessoal), grava
 * `created_by_user_id` nulo e lê só o compartilhado (`owner_user_id` nulo). A
 * sessão segue pelo `requireRole` de sempre, byte a byte.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { extractBearer } from "@/lib/mcp/auth";
import { createTemplateSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import type { SupabaseClient } from "@supabase/supabase-js";
import { grupoDaOrganizacao } from "@/lib/templates/grupo-da-resposta";
import { posicaoEntre } from "@/lib/templates/ordem";

export const dynamic = "force-dynamic";
const COLS =
  "id, organization_id, owner_user_id, title, body, shortcut, midias, mostrar_na_barra, grupo_id, created_by_user_id, created_at, updated_at, ordem";
/** Tag do endpoint no recibo de idempotência. Muda de rota muda de recibo. */
const ENDPOINT = "/api/v1/message-templates";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "message_templates",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "message_templates.lista", requestId);
  if (teto) return teto;

  const supabase = authz.supabase;
  // Na sessão, a RLS limita a lista a compartilhados + próprios da org ativa.
  // No token, o cliente é o admin (service role), que IGNORA a RLS: quem protege
  // a lista é o filtro explícito de organização acima e, no ramo do token, o
  // `owner_user_id` nulo abaixo. Token não tem pessoa, então só o compartilhado.
  //
  // A ordem é a que o OPERADOR escolheu (`ordem`, #3244), não a de edição: era
  // `updated_at desc`, então editar o corpo de uma resposta a empurrava para o
  // topo desta lista e do slash-menu do Inbox. Virou `ordem asc` + dois
  // desempates (a resposta nova nasce ACIMA da primeira, ver o POST; duas que
  // empatem — criadas ao mesmo tempo — saem mais recente primeiro).
  let consulta = supabase
    .from("message_templates")
    .select(COLS)
    .eq("organization_id", authz.organizationId);
  if (authz.via === "token") consulta = consulta.is("owner_user_id", null);
  const { data, error } = await consulta
    .order("ordem", { ascending: true })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar templates.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Dois portões, um corpo. A sessão segue pelo `requireRole` (é ele quem traz o
  // papel efetivo que a regra "compartilhado exige manager+" lê). O Bearer entra
  // por `resolveAuthDual`, e o cliente é o admin: a RLS não existe, então cada
  // consulta abaixo filtra a organização à mão, e no token só o compartilhado.
  let orgId: string;
  let userId: string | null;
  let apiTokenId: string | null;
  let papel: Role | null;
  let idioma: Idioma;
  let supabase: SupabaseClient;
  const viaToken = extractBearer(req.headers.get("authorization")) !== null;
  if (viaToken) {
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "message_templates",
      role: "agent",
      scope: "config:write",
      tokenRole: "admin",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "message_templates.criar", requestId);
    if (teto) return teto;
    orgId = authz.organizationId;
    userId = authz.actor.type === "user" ? authz.actor.id : null;
    apiTokenId = authz.apiTokenId ?? null;
    papel = null; // o `tokenRole: "admin"` já barrou quem está abaixo
    idioma = authz.idioma ?? IDIOMA_PADRAO;
    supabase = authz.supabase;
  } else {
    const authz = await requireRole("agent", { requestId, resource: "message_templates" });
    if (!authz.ok) return authz.response;
    orgId = authz.org.orgId;
    userId = authz.user.id;
    apiTokenId = null;
    papel = authz.org.role;
    idioma = authz.user.idioma;
    supabase = await createClient();
  }
  const t = (texto: string) => traduzir(texto, idioma);

  const raw = await req.json().catch(() => null);
  const parsed = createTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { title, body, shortcut, shared, mostrar_na_barra, grupo_id } = parsed.data;
  // Compartilhado exige manager+. requireRole já resolveu o role efetivo do
  // banco em org.role — reusar em vez de uma 2ª chamada/RPC. A RLS with_check
  // barra de qualquer forma; isto só dá um erro claro antes do insert.
  if (shared && papel !== null && !roleAtLeast(papel, "manager")) {
    return fail("forbidden", t("Só manager+ cria template compartilhado."), 403, { requestId });
  }
  // Token não tem pessoa para ser dona: só nasce compartilhado. O padrão `false`
  // do schema vale para a sessão; para o token ele é recusado com a frase certa.
  if (viaToken && !shared) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: { shared: [t("Token só cria resposta rápida compartilhada: envie shared: true.")] },
    });
  }
  // Idempotency-Key, quando vem, tem de ser UUID — mesma régua de
  // `admin/tenants` e do contrato (spec 01 §7.3). Chave malformada não vira
  // recibo: recusar cedo é mais honesto que gravar lixo e devolver 201.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  // O GRUPO (#3245) tem de ser da organização ativa. `null` é sempre válido —
  // é "sem grupo". A FK composta do banco é a segunda barreira; esta é a que
  // devolve 422 dizendo QUAL campo está errado.
  try {
    if (!(await grupoDaOrganizacao(supabase, orgId, grupo_id))) {
      return fail("validation_failed", t("Dados inválidos."), 422, {
        requestId,
        details: { grupo_id: [t("Grupo que não pertence a esta organização.")] },
      });
    }
  } catch {
    return fail("internal_error", "Erro ao criar template.", 500, { requestId });
  }

  /**
   * O efeito. Lança em falha de propósito: assim o helper propaga sem gravar
   * recibo. Recibo de operação que falhou seria pior que não ter idempotência
   * — o cliente retentaria e receberia o replay de uma criação inexistente.
   */
  async function criar() {
    // A resposta nova nasce no TOPO e sem empate: um passo acima da primeira da
    // lista visível. Com todas nascendo na mesma posição, o desempate passava a
    // ser `updated_at` — e editar uma resposta nova voltava a reordenar a lista
    // (o defeito da #3244 pela porta da criação).
    let primeiraDaLista = supabase
      .from("message_templates")
      .select("ordem")
      .eq("organization_id", orgId);
    // Na sessão a RLS limita a lista a compartilhados + próprios; o token (admin)
    // enxerga a organização inteira, então fica só no compartilhado, que é o que
    // a lista dele mostra.
    if (viaToken) primeiraDaLista = primeiraDaLista.is("owner_user_id", null);
    const { data: primeira, error: erroPrimeira } = await primeiraDaLista
      .order("ordem", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (erroPrimeira) throw new Error("Erro ao criar template.");
    const menor = (primeira as { ordem: number } | null)?.ordem ?? null;
    // `posicaoEntre(null, x)` nunca é `null`: só o empate entre DUAS vizinhas é.
    const ordem = posicaoEntre(null, menor)!;

    const { data, error } = await supabase
      .from("message_templates")
      .insert({
        organization_id: orgId,
        owner_user_id: shared ? null : userId,
        title,
        body,
        shortcut: shortcut ?? null,
        // O grupo (#3245): ausente na tela = `null` = lista plana, que é o
        // estado de toda resposta anterior à 0808.
        grupo_id: grupo_id ?? null,
        // "Mostrar na barra do Inbox" (#3282): só vai quando a tela escolheu.
        // Ausente, a coluna assume o default dela (`true`) — a resposta nasce
        // aparecendo na barra, que é o comportamento de sempre.
        ...(mostrar_na_barra === undefined ? {} : { mostrar_na_barra }),
        // `midias` nasce vazia: a mídia nova (a imagem da #2526 ou o áudio do
        // recurso, #2833) é gravada pela rota de upload, que gera o caminho
        // sabendo o id do template. Aceitar caminho aqui seria aceitar um
        // arquivo que ninguém conferiu.
        midias: [],
        // Token não tem pessoa: o autor fica nulo (a FK é para pessoa).
        created_by_user_id: userId,
        ordem,
      })
      .select(COLS)
      .single();
    if (error || !data) throw new Error("Erro ao criar template.");

    void audit({
      action: "template.created",
      actorUserId: userId,
      actorApiTokenId: apiTokenId,
      organizationId: orgId,
      resourceType: "message_template",
      resourceId: data.id,
      requestId,
      metadata: { shared, title },
    });
    return data;
  }

  // Sem a chave, o caminho é o de sempre: uma chave só existe quando quem
  // chama quer retentativa segura.
  if (chave === null) {
    try {
      return ok(await criar(), { requestId, status: 201 });
    } catch {
      return fail("internal_error", "Erro ao criar template.", 500, { requestId });
    }
  }

  try {
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: parsed.data,
      executar: async () => ({ resposta: await criar(), status: 201 }),
    });

    if (desfecho.tipo === "conflito")
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );

    // Mesma chave, MESMO corpo, e a primeira execução ainda está em curso: a
    // chave está reservada (migration 0321) e a resposta ainda não existe —
    // não há o que devolver, e reexecutar duplicaria a criação. Código próprio
    // e não `idempotency_conflict`: aqui a chave está CERTA, o pedido é o
    // mesmo, e retentar depois resolve.
    if (desfecho.tipo === "em_curso")
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );

    // 201, e não `desfecho.status`: o efeito desta rota termina sempre em 201
    // (a criação do template) e é esse o número que o recibo guarda, então o
    // replay responde 201 também. `ok()` só aceita os códigos de sucesso que
    // declara — repassar o `number` do desfecho afrouxaria o tipo de TODAS as
    // rotas por causa de uma.
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch {
    return fail("internal_error", "Erro ao criar template.", 500, { requestId });
  }
}
