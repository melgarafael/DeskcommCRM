import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * TIPOS DE AGENDAMENTO — criar, alterar e desativar pela API.
 *
 * ─── O buraco que esta rota fecha ────────────────────────────────────────
 *
 * A tabela `calendar_event_types` tem dez categorias no CHECK
 * (`consulta`, `procedimento`, `retorno`, `visita`, `vistoria`, `reuniao`,
 * `call`, `orcamento`, `demonstracao`, `outro`), duração, buffers, antecedência
 * mínima, janela de agendamento e local — e **não havia como criar ou editar um
 * tipo por lugar nenhum**: nem rota, nem tela. Uma organização recebia três
 * tipos semeados e ficava com eles para sempre.
 *
 * ─── A REGRA DE ALTERAR/DESATIVAR NÃO MORA MAIS AQUI ─────────────────────
 *
 * `PATCH` e `DELETE` são borda: `requireSupportWrite`, `resolveAuthDual`,
 * `tetoDeEscritaDoToken`, o Zod e a resposta. A regra — o filtro de campo
 * `undefined`, a conferência do canal e do modelo do lembrete, o `update` com
 * `organization_id` no filtro, o 404 e a auditoria — está em
 * `lib/agenda/tipos-de-agendamento.ts`, ao lado de `consulta.ts`. Motivo: quem
 * não é rota (servidor MCP, automação) precisava do MESMO comportamento e só
 * tinha dois caminhos ruins, chamar esta API por HTTP ou copiar a regra. Ver a
 * issue #4688.
 *
 * O `POST` continua com a regra aqui: ele repete a conferência do canal e do
 * modelo, e agora usa os MESMOS ajudantes exportados do módulo — mas o fluxo de
 * criação fica fora deste pedido para o PR continuar pequeno.
 *
 * ─── Desativar, nunca apagar ─────────────────────────────────────────────
 *
 * `calendar_appointments.event_type_id` aponta para cá. Apagar o tipo levaria
 * junto a história — que consulta foi feita, de que tipo, quanto durava. O
 * DELETE aqui grava `is_active = false`: some da tela de marcar e continua
 * respondendo pelo passado. É o mesmo raciocínio do anti-pattern 7 da doutrina
 * (cascade fantasma).
 *
 * ─── E a volta mora AO LADO, não aqui ────────────────────────────────────
 *
 * Reativar é `POST /api/v1/agenda/tipos/reativar`. `is_active` está fora de
 * `camposDoTipo` DE PROPÓSITO: aceitá-lo no PATCH deixaria o mesmo pedido que
 * muda a duração desligar o tipo, e a trilha registraria a religada como
 * `agenda.tipo_alterado { campos: ["is_active"] }` — indistinguível de uma
 * alteração de campo qualquer.
 *
 * ⚠️ Essa exclusão é silenciosa e já custou: Zod DESCARTA chave desconhecida sem
 * dizer nada, então o botão "Reativar" da tela mandou `is_active` para cá
 * durante toda a vida dele e recebeu 422 "Nenhum campo para alterar." — uma
 * recusa que não nomeia o que foi descartado. Quem vigia a travessia hoje é
 * `tests/unit/agenda-reativar-tipo.test.ts`.
 *
 * Auth: sessão de navegador OU Bearer `dsk_...` (api_tokens) via
 * `lib/api/auth-dual.ts` — a mesma dualidade das demais rotas de configuração
 * que aceitam token. No ramo do token, a org sai da linha do token.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { listaTiposDeAtendimento } from "@/lib/agenda/consulta";
import {
  alterarSchema,
  alterarTipoDeAgendamento,
  camposDoTipo,
  desativarSchema,
  desativarTipoDeAgendamento,
  recusaDoCanalDoLembrete,
  recusaDoModeloDoLembrete,
} from "@/lib/agenda/tipos-de-agendamento";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const criarSchema = z.object(camposDoTipo);
// Somente a criação pode nascer como serviço em rascunho. O PATCH legado não
// ganha uma porta de ativação: a programação é validada pelo núcleo de serviços.
const criarComRascunhoSchema = criarSchema.extend({ service_draft: z.boolean().optional() });

/**
 * O slug sai do NOME, e é estável depois de criado.
 *
 * A ferramenta MCP aceita `event_type_slug`, então o slug é endereço público: se
 * ele mudasse ao renomear o tipo, todo playbook e toda automação que o citam
 * parariam de achar — em silêncio, porque a busca por slug devolve "não existe"
 * e não "mudou de nome". Por isso o PATCH nunca o toca.
 */
function slugDe(nome: string): string {
  return (
    nome
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "tipo"
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "calendar_event_types",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;

  // A MESMA coleta que a ferramenta MCP usa. Esta query era inline aqui, e havia
  // outras três iguais no repo — a tela e a IA respondendo por recortes
  // diferentes sobre o que a organização atende. Ver `listaTiposDeAtendimento`.
  //
  // `incluirInativos: true` porque quem chama esta rota administra o cadastro:
  // esconder o tipo desativado tiraria dele a única porta para reativá-lo.
  const r = await listaTiposDeAtendimento(createAdminClient(), authz.organizationId, {
    incluirInativos: true,
  });
  if (!r.ok) return fail("internal_error", r.motivoParaOperador, 500, { requestId });
  // O wire desta rota é snake_case e a tela já o consome assim; o coletor fala a
  // língua do domínio. A tradução é aqui, na borda, e não no coletor — que
  // também serve a IA, cujo vocabulário é outro.
  return ok(
    r.tipos.map((t) => ({
      id: t.id,
      name: t.nome,
      slug: t.slug,
      description: t.descricao,
      category: t.categoria,
      duration_minutes: t.duracaoMin,
      location_kind: t.localKind,
      location_details: t.localDetalhes,
      default_owner_user_id: t.donoPadraoId,
      requires_confirmation: t.precisaConfirmacao,
      is_active: t.ativo,
      buffer_before_minutes: t.bufferAntesMin,
      buffer_after_minutes: t.bufferDepoisMin,
      minimum_notice_minutes: t.antecedenciaMinimaMin,
      booking_window_days: t.janelaDeAgendamentoDias,
      // Sem estes dois, quem chama a rota não tem como SABER se o lembrete está
      // ligado — só como pedir que ligue. Um PATCH cego sobre um estado que a
      // leitura não conta é o mesmo controle decorativo, do outro lado.
      reminder_enabled: t.lembreteLigado,
      levar_dados_do_negocio: t.levarDadosDoNegocio,
      reminder_channel_session_id: t.lembreteCanalId ?? null,
      reminder_meta_template_id: t.lembreteModeloId ?? null,
      reminder_minutes_before: t.lembreteAntecedenciaMin,
      reminder_extra_offsets_minutes: t.lembreteDegrausExtras,
      reminder_body: t.lembreteMensagem,
      reminder_bodies: t.lembreteMensagens,
      default_price_cents: t.precoPadraoCents,
      ...(t.servico ? { service_enabled: true, booking_mode: t.servico.booking_mode, service_capacity: t.servico.capacity,
        service_revision: t.servico.revision, service_publication_mode: t.servico.publication_mode } : {}),
    })),
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "calendar_event_types",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  const teto = await tetoDeEscritaDoToken(authz, "agenda_tipos", requestId ?? "");
  if (teto) return teto;

  const lido = criarComRascunhoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    // A mensagem do Zod passa pelo dicionário, e não direto ao corpo da resposta:
    // as recusas de `reminder_minutes_before` são escritas em português nesta
    // rota, e quem opera em espanhol as receberia cruas. Texto sem entrada
    // degrada para ele mesmo — que é o contrato de `traduzir`.
    return fail("validation_failed", t(lido.error.issues[0]?.message ?? "corpo inválido"), 422, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const recusaDoCanal = await recusaDoCanalDoLembrete(admin, authz.organizationId, lido.data, t);
  if (recusaDoCanal) {
    return fail(recusaDoCanal.code, recusaDoCanal.message, recusaDoCanal.status, { requestId });
  }
  const recusaDoModelo = await recusaDoModeloDoLembrete(admin, authz.organizationId, lido.data, t);
  if (recusaDoModelo) {
    return fail(recusaDoModelo.code, recusaDoModelo.message, recusaDoModelo.status, { requestId });
  }
  const { service_draft, ...fields } = lido.data;
  const { data, error } = await admin
    .from("calendar_event_types")
    .insert({ ...fields, ...(service_draft ? { service_enabled: true, is_active: false, default_owner_user_id: null } : {}), organization_id: authz.organizationId, slug: slugDe(lido.data.name) })
    .select("id, slug")
    .single();

  if (error) {
    // 23505 é o slug repetido — recusa esperada, não erro de sistema.
    if (error.code === "23505") {
      return fail("conflict", `Já existe um tipo com o nome "${lido.data.name}".`, 409, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    action: "agenda.tipo_criado",
    organizationId: authz.organizationId,
    resourceType: "calendar_event_types",
    resourceId: data.id,
    metadata: {
      nome: lido.data.name,
      categoria: lido.data.category,
      duracao: lido.data.duration_minutes,
    },
  });
  return ok(data, { requestId, status: 201 });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "calendar_event_types",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  const teto = await tetoDeEscritaDoToken(authz, "agenda_tipos", requestId ?? "");
  if (teto) return teto;

  const lido = alterarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    // Idem ao POST: o dicionário na borda, para a recusa do lembrete chegar
    // legível a quem opera em espanhol.
    return fail("validation_failed", t(lido.error.issues[0]?.message ?? "corpo inválido"), 422, {
      requestId,
    });
  }

  const r = await alterarTipoDeAgendamento(
    createAdminClient(),
    { organizationId: authz.organizationId, actor: authz.actor, apiTokenId: authz.apiTokenId ?? null, t },
    lido.data,
  );
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId });

  return ok(r.data, { requestId });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "calendar_event_types",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  const teto = await tetoDeEscritaDoToken(authz, "agenda_tipos", requestId ?? "");
  if (teto) return teto;

  const lido = desativarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("corpo inválido"), 422, { requestId });

  const r = await desativarTipoDeAgendamento(
    createAdminClient(),
    { organizationId: authz.organizationId, actor: authz.actor, apiTokenId: authz.apiTokenId ?? null, t },
    lido.data,
  );
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId });

  return ok(r.data, { requestId });
}
