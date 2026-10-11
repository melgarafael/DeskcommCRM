/**
 * GET|POST /api/v1/pol-surveys/public/[token]
 *
 * Rota PUBLICA de pesquisa politica — War Room 2.0 Fase 3.
 * Nao requer autenticacao. Resolve a pesquisa pelo public_token.
 *
 * GET  — retorna pesquisa + perguntas (ordenadas por `order`) para o token dado.
 *        Apenas pesquisas ativas.
 * POST — submete uma resposta. Cria uma linha em pol_survey_responses.
 *        Token da resposta gerado server-side.
 *
 * Seguranca: sem auth — rota publica por design (formulario de pesquisa).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// -- Validacao ----------------------------------------------------------------

const submeterRespostaSchema = z.object({
  answers: z.record(z.unknown()),
  contact_id: z.string().uuid().nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  duration_seconds: z.number().int().min(0).nullable().optional(),
});

// -- GET — pesquisa publica por token -----------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await params;

  const db = createAdminClient();

  // Buscar pesquisa ativa pelo public_token
  const { data: survey, error: errSurvey } = await db
    .from("pol_surveys")
    .select("id, title, description, type, status, start_date, end_date")
    .eq("public_token", token)
    .eq("status", "active")
    .single();

  if (errSurvey || !survey) {
    return fail("not_found", "Pesquisa nao encontrada ou nao esta ativa", 404, { requestId });
  }

  // Buscar perguntas ordenadas
  const { data: questions, error: errQuestions } = await db
    .from("pol_survey_questions")
    .select("id, question, response_type, options, required, \"order\"")
    .eq("survey_id", survey.id)
    .order("order", { ascending: true });

  if (errQuestions) {
    return fail("internal_error", "Erro ao buscar perguntas", 500, { requestId });
  }

  return ok(
    { survey, questions: questions ?? [] },
    { headers: { "x-request-id": requestId } },
  );
}

// -- POST — submeter resposta -------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = submeterRespostaSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  // Buscar pesquisa ativa pelo public_token
  const { data: survey, error: errSurvey } = await db
    .from("pol_surveys")
    .select("id, organization_id")
    .eq("public_token", token)
    .eq("status", "active")
    .single();

  if (errSurvey || !survey) {
    return fail("not_found", "Pesquisa nao encontrada ou nao esta ativa", 404, { requestId });
  }

  // Token da resposta gerado server-side
  const responseToken = randomUUID().replace(/-/g, "");

  const { data: response, error } = await db
    .from("pol_survey_responses")
    .insert({
      organization_id: survey.organization_id,
      survey_id: survey.id,
      token: responseToken,
      answers: parsed.data.answers,
      contact_id: parsed.data.contact_id ?? null,
      city: parsed.data.city ?? null,
      state: parsed.data.state ?? null,
      duration_seconds: parsed.data.duration_seconds ?? null,
    })
    .select()
    .single();

  if (error) {
    return fail("internal_error", "Erro ao registrar resposta", 500, { requestId });
  }

  return ok({ response }, { status: 201, headers: { "x-request-id": requestId } });
}
