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
 * ─── Desativar, nunca apagar ─────────────────────────────────────────────
 *
 * `calendar_appointments.event_type_id` aponta para cá. Apagar o tipo levaria
 * junto a história — que consulta foi feita, de que tipo, quanto durava. O
 * DELETE aqui grava `is_active = false`: some da tela de marcar e continua
 * respondendo pelo passado. É o mesmo raciocínio do anti-pattern 7 da doutrina
 * (cascade fantasma).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { listaTiposDeAtendimento } from "@/lib/agenda/consulta";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/** As dez do CHECK da tabela. Fora daqui o Postgres recusa — melhor recusar antes. */
const CATEGORIAS = [
  "consulta", "procedimento", "retorno", "visita", "vistoria",
  "reuniao", "call", "orcamento", "demonstracao", "outro",
] as const;

const LOCAIS = ["in_person", "phone", "whatsapp", "video_link", "google_meet"] as const;

/**
 * Os limites são os MESMOS do CHECK do banco, e isso é deliberado.
 *
 * Zod aqui não substitui a constraint: ela é a verdade e continua valendo para
 * quem escrever por SQL. O que a validação faz é transformar um 500 de constraint
 * — que aparece como "erro interno" para quem está usando — numa recusa 422 que
 * diz o que está fora.
 */
const camposDoTipo = {
  name: z.string().trim().min(2).max(80),
  category: z.enum(CATEGORIAS),
  duration_minutes: z.number().int().min(5).max(1440),
  location_kind: z.enum(LOCAIS),
  description: z.string().trim().max(500).nullish(),
  location_details: z.string().trim().max(300).nullish(),
  default_owner_user_id: z.string().uuid().nullish(),
  requires_confirmation: z.boolean().optional(),
  buffer_before_minutes: z.number().int().min(0).max(720).optional(),
  buffer_after_minutes: z.number().int().min(0).max(720).optional(),
  minimum_notice_minutes: z.number().int().min(0).max(43_200).optional(),
  booking_window_days: z.number().int().min(1).max(365).optional(),
};

const criarSchema = z.object(camposDoTipo);
// `.partial()` em vez de repetir os doze campos como opcionais: repetir criaria
// duas listas para manter em sincronia, e a segunda envelhece calada.
const alterarSchema = criarSchema.partial().extend({ id: z.string().uuid() });
const desativarSchema = z.object({ id: z.string().uuid() });

/**
 * O slug sai do NOME, e é estável depois de criado.
 *
 * A ferramenta MCP aceita `event_type_slug`, então o slug é endereço público: se
 * ele mudasse ao renomear o tipo, todo playbook e toda automação que o citam
 * parariam de achar — em silêncio, porque a busca por slug devolve "não existe"
 * e não "mudou de nome". Por isso o PATCH nunca o toca.
 */
function slugDe(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "tipo";
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("viewer", { requestId, resource: "calendar_event_types" });
  if (!autorizado.ok) return autorizado.response;

  // A MESMA coleta que a ferramenta MCP usa. Esta query era inline aqui, e havia
  // outras três iguais no repo — a tela e a IA respondendo por recortes
  // diferentes sobre o que a organização atende. Ver `listaTiposDeAtendimento`.
  //
  // `incluirInativos: true` porque quem chama esta rota administra o cadastro:
  // esconder o tipo desativado tiraria dele a única porta para reativá-lo.
  const r = await listaTiposDeAtendimento(createAdminClient(), autorizado.org.orgId, {
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
    })),
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!autorizado.ok) return autorizado.response;
  const t = (texto: string) => traduzir(texto, autorizado.user.idioma);

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? t("corpo inválido"), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_event_types")
    .insert({ ...lido.data, organization_id: autorizado.org.orgId, slug: slugDe(lido.data.name) })
    .select("id, slug")
    .single();

  if (error) {
    // 23505 é o slug repetido — recusa esperada, não erro de sistema.
    if (error.code === "23505") {
      return fail("conflict", `Já existe um tipo com o nome "${lido.data.name}".`, 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    actorUserId: autorizado.user.id,
    action: "agenda.tipo_criado",
    organizationId: autorizado.org.orgId,
    resourceType: "calendar_event_types",
    resourceId: data.id,
    metadata: { nome: lido.data.name, categoria: lido.data.category, duracao: lido.data.duration_minutes },
  });
  return ok(data, { requestId, status: 201 });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!autorizado.ok) return autorizado.response;
  const t = (texto: string) => traduzir(texto, autorizado.user.idioma);

  const lido = alterarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? t("corpo inválido"), 422, { requestId });
  }
  const { id, ...campos } = lido.data;
  if (Object.keys(campos).length === 0) {
    // Recusa em vez de UPDATE vazio: "alterei" sobre nada é a mesma família de
    // mentira que o "Marcado ✓" sem linha no banco.
    return fail("validation_failed", t("Nenhum campo para alterar."), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_event_types")
    .update(campos)
    .eq("id", id)
    .eq("organization_id", autorizado.org.orgId)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Tipo de agendamento não encontrado."), 404, { requestId });

  await audit({
    actorUserId: autorizado.user.id,
    action: "agenda.tipo_alterado",
    organizationId: autorizado.org.orgId,
    resourceType: "calendar_event_types",
    resourceId: id,
    metadata: { campos: Object.keys(campos) },
  });
  return ok(data, { requestId });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const autorizado = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!autorizado.ok) return autorizado.response;
  const t = (texto: string) => traduzir(texto, autorizado.user.idioma);

  const lido = desativarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("corpo inválido"), 422, { requestId });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("calendar_event_types")
    .update({ is_active: false })
    .eq("id", lido.data.id)
    .eq("organization_id", autorizado.org.orgId)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Tipo de agendamento não encontrado."), 404, { requestId });

  await audit({
    actorUserId: autorizado.user.id,
    action: "agenda.tipo_desativado",
    organizationId: autorizado.org.orgId,
    resourceType: "calendar_event_types",
    resourceId: lido.data.id,
    metadata: {},
  });
  return ok(data, { requestId });
}
