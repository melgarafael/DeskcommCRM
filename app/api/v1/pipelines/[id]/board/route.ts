/**
 * GET /api/v1/pipelines/[id]/board
 *
 * Returns the full board snapshot for the Kanban: pipeline metadata + active
 * stages (ordered by position) + open leads (excluding archived). All RLS-
 * filtered to the caller's org via cookie session.
 *
 * Why this exists: previously useBoard hit supabase-js directly from the
 * browser. The auth cookie is httpOnly, which the browser Supabase client
 * cannot read — auth.uid() came back null and RLS dropped the pipeline row,
 * surfacing as PostgREST "Cannot coerce result to a single JSON object"
 * (PGRST116). Routing through the API ensures the server-side cookie reader
 * runs, same as every other authed query.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import type { BoardData, Pipeline, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: pipelineId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const [
    { data: pipeline, error: pipelineErr },
    { data: stages, error: stagesErr },
    { data: leads, error: leadsErr },
  ] = await Promise.all([
    supabase.from("crm_pipelines").select("*").eq("id", pipelineId).maybeSingle(),
    supabase
      .from("crm_stages")
      .select("*")
      .eq("pipeline_id", pipelineId)
      .eq("is_archived", false)
      .order("position"),
    supabase
      .from("crm_leads")
      .select("*")
      .eq("pipeline_id", pipelineId)
      .neq("status", "archived")
      .order("position_in_stage"),
  ]);

  if (pipelineErr) return fail("internal_error", pipelineErr.message, 500, { requestId });
  if (stagesErr) return fail("internal_error", stagesErr.message, 500, { requestId });
  if (leadsErr) return fail("internal_error", leadsErr.message, 500, { requestId });
  if (!pipeline) return fail("resource_not_found", "Pipeline não encontrado.", 404, { requestId });

  const board: BoardData = {
    pipeline: pipeline as Pipeline,
    stages: (stages ?? []) as Stage[],
    leads: (leads ?? []) as Lead[],
  };

  return ok(board, { requestId });
}
