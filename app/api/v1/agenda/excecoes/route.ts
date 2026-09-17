/**
 * BLOQUEAR UM DIA — a porta que faltava para uma tabela que já era respeitada.
 *
 * `calendar_availability_exceptions` existe desde a migration 0177, com RLS,
 * índices e comentários, e `lib/agenda/consulta.ts` a lê em toda consulta de
 * horários livres. Só que **nenhuma rota, tela ou action jamais escreveu nela**:
 * a capacidade estava pronta no motor e era inalcançável por quem usa o produto.
 *
 * O efeito prático é o oposto do anti-pattern nº 3 do CLAUDE.md (evento sem
 * consumidor): aqui havia consumidor sem produtor. Quem precisasse fechar a
 * agenda num feriado não tinha como — a alternativa era marcar um compromisso
 * falso de dia inteiro, que polui a agenda, conta como atendimento e aparece na
 * timeline do lead.
 *
 * ═══ O QUE ESTA ROTA DECIDE ═══
 *
 * **Autorização é da RLS, não daqui.** Usa o client de SESSÃO (`createClient`),
 * nunca o admin: a policy `calendar_availability_exceptions_write` já diz que
 * escreve quem é dono da agenda (`user_id = auth.uid()`) ou manager+. Repetir
 * essa regra em TypeScript criaria uma segunda fonte da mesma verdade, e a que
 * roda aqui seria a pior das duas. `requireRole("agent")` é só a borda de
 * autenticação.
 *
 * **`user_id` não vem do corpo quando é o próprio.** Ele existe como campo
 * opcional para o manager fechar a agenda de outra pessoa; ausente, é `auth.uid()`.
 * Aceitá-lo cru do body sem a RLS atrás seria escrever na agenda alheia — e é a
 * RLS que barra, não uma checagem nossa.
 *
 * **Dia inteiro é `0..1440`, não `null`.** O schema explica por quê: numa UNIQUE,
 * `NULL` não colide com `NULL`, então dois "dia 12 bloqueado" passariam os dois.
 *
 * **`is_unavailable` tem os DOIS sentidos.** `true` fecha (feriado, férias);
 * `false` ABRE uma faixa que a jornada semanal não tem — o sábado excepcional.
 * A tabela foi desenhada para os dois, e expor só o fechar desperdiçaria metade.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS = "id, user_id, exception_date, is_unavailable, start_minute, end_minute, reason";

const criarSchema = z
  .object({
    exception_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use uma data em AAAA-MM-DD"),
    /** Ausente = a própria pessoa. Manager+ pode informar outra (a RLS decide). */
    user_id: z.string().uuid().optional(),
    is_unavailable: z.boolean().default(true),
    start_minute: z.number().int().min(0).max(1440).default(0),
    end_minute: z.number().int().min(0).max(1440).default(1440),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.end_minute > v.start_minute, {
    message: "O fim precisa ser depois do começo.",
    path: ["end_minute"],
  });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const de = url.searchParams.get("de");
  const ate = url.searchParams.get("ate");

  const supabase = await createClient();
  let q = supabase
    .from("calendar_availability_exceptions")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("exception_date", { ascending: true })
    .limit(500);
  // Sem janela, devolve do dia de hoje em diante: a lista serve para conferir o
  // que vem, e feriado do ano passado só faz a tela crescer.
  if (de) q = q.gte("exception_date", de);
  else q = q.gte("exception_date", new Date().toISOString().slice(0, 10));
  if (ate) q = q.lte("exception_date", ate);

  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", t(lido.error.issues[0]?.message ?? "corpo inválido"), 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("calendar_availability_exceptions")
    .insert({
      organization_id: authz.org.orgId,
      user_id: lido.data.user_id ?? authz.user.id,
      exception_date: lido.data.exception_date,
      is_unavailable: lido.data.is_unavailable,
      start_minute: lido.data.start_minute,
      end_minute: lido.data.end_minute,
      reason: lido.data.reason ?? null,
    })
    .select(COLUNAS)
    .single();

  if (error) {
    // 23505 é a UNIQUE (mesma pessoa, mesmo dia, mesma faixa): recusa esperada,
    // não erro de sistema. 42501 é a RLS dizendo que esta pessoa não escreve na
    // agenda daquela outra.
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um bloqueio para este dia e horário."), 409, {
        requestId,
      });
    }
    if (error.code === "42501") {
      return fail("forbidden", t("Você só pode alterar a sua própria agenda."), 403, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: lido.data.is_unavailable ? "agenda.dia_bloqueado" : "agenda.dia_aberto",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "calendar_availability_exception",
    resourceId: data.id,
    requestId,
    metadata: {
      exception_date: lido.data.exception_date,
      dono: lido.data.user_id ?? authz.user.id,
      dia_inteiro: lido.data.start_minute === 0 && lido.data.end_minute === 1440,
    },
  });

  return ok(data, { requestId, status: 201 });
}

const apagarSchema = z.object({ id: z.string().uuid() });

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = apagarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("id inválido."), 422, { requestId });

  // ⚠️ DELETE de verdade, e é a exceção consciente à regra "nada é apagado" do
  // CLAUDE.md. Um bloqueio não é fato histórico: é uma regra que vale enquanto
  // está lá. Guardá-lo desativado só criaria a pergunta "este feriado valeu ou
  // não?" para sempre — e o audit log acima já registra que existiu e por quem.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("calendar_availability_exceptions")
    .delete()
    .eq("id", lido.data.id)
    .eq("organization_id", authz.org.orgId)
    .select("id, exception_date")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  // Sem linha: ou não existe, ou a RLS não deixou ver. Os dois viram 404 — dizer
  // "existe, mas não é sua" já é contar algo sobre a agenda alheia.
  if (!data) return fail("not_found", t("Bloqueio não encontrado."), 404, { requestId });

  void audit({
    action: "agenda.bloqueio_removido",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "calendar_availability_exception",
    resourceId: data.id,
    requestId,
    metadata: { exception_date: data.exception_date },
  });

  return ok({ id: data.id }, { requestId });
}
