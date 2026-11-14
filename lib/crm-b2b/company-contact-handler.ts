/**
 * Cadastro seguido pela página da empresa: pessoa + contato + vínculos numa
 * chamada só (fluxo "Adicionar pessoa com contato").
 *
 * Antes eram três passos em três telas: criar a pessoa ligada à empresa, criar
 * o contato (telefone/e-mail) e ligar o contato à pessoa. Aqui o servidor faz
 * os três e, se qualquer um falhar DEPOIS de a pessoa existir, desfaz o que
 * gravou — senão o "tentar de novo" da tela deixaria pessoa duplicada (mesma
 * doutrina de `createPersonHandler`, issue #3198).
 *
 * Reaproveita os handlers que já existem (pessoa, contato, vínculo): nenhuma
 * regra de negócio nova mora aqui, só a ORDEM e o DESFAZER.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { createPersonHandler, linkContactToPersonHandler } from "@/lib/crm-b2b/people-handler";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

type SB = SupabaseClient;

/** Corpo da chamada. O telefone é validado pela régua do país na ROTA (veja `corpoDoContatoDaEmpresa`). */
export function corpoDoContatoDaEmpresa(telefone: z.ZodTypeAny) {
  return z.object({
    full_name: z.string().trim().min(1).max(300),
    job_title: z.string().trim().max(200).optional().nullable(),
    is_decision_maker: z.boolean().optional(),
    email: z.string().trim().email().optional().nullable().or(z.literal("")),
    phone_number: telefone.optional(),
  });
}

export interface ContatoDaEmpresaInput {
  full_name: string;
  job_title?: string | null;
  is_decision_maker?: boolean;
  email?: string | null;
  phone_number?: string;
}

function err(ctx: HandlerCtx, status: number, code: string, message: string): never {
  throw new ApiError(status, code, undefined, ctx.requestId, message);
}

/**
 * Desfaz com a chave de serviço: o atendente que cadastrou pode não ter
 * permissão de apagar (RLS de delete é de gerente). Os ids são os que ESTA
 * chamada acabou de criar e o filtro de organização vem de `ctx`.
 */
async function desfazer(
  ctx: HandlerCtx,
  criados: { personId?: string; contactId?: string },
): Promise<void> {
  const admin = createAdminClient();
  if (criados.contactId) {
    const { error } = await admin
      .from("contacts")
      .delete()
      .eq("organization_id", ctx.organization_id)
      .eq("id", criados.contactId);
    if (error) {
      logger.error("company_contact.rollback_contact_failed", {
        organization_id: ctx.organization_id,
        contact_id: criados.contactId,
        request_id: ctx.requestId,
        code: error.code,
      });
    }
  }
  if (criados.personId) {
    // company_people é ON DELETE CASCADE: o vínculo cai junto com a pessoa.
    const { error } = await admin
      .from("people")
      .delete()
      .eq("organization_id", ctx.organization_id)
      .eq("id", criados.personId);
    if (error) {
      logger.error("company_contact.rollback_person_failed", {
        organization_id: ctx.organization_id,
        person_id: criados.personId,
        request_id: ctx.requestId,
        code: error.code,
      });
    }
  }
}

export async function createCompanyContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  companyId: string,
  input: ContatoDaEmpresaInput,
) {
  const { data: empresa, error: empresaErr } = await supabase
    .from("companies")
    .select("id")
    .eq("organization_id", ctx.organization_id)
    .eq("id", companyId)
    .maybeSingle();
  if (empresaErr) err(ctx, 500, "internal_error", empresaErr.message);
  if (!empresa) err(ctx, 404, "not_found", "Empresa não encontrada.");

  // 1. Pessoa já ligada à empresa (o handler desfaz a si mesmo se o vínculo falhar).
  const person = await createPersonHandler(supabase, ctx, actorUserId, {
    full_name: input.full_name,
    email: input.email || null,
    company_id: companyId,
    job_title: input.job_title || null,
    is_decision_maker: input.is_decision_maker ?? false,
  });

  // Sem telefone nem e-mail não há contato a criar: fica só a pessoa.
  const temContato = Boolean(input.phone_number || input.email);
  if (!temContato) return { person, contact: null, company_id: companyId };

  const criados: { personId?: string; contactId?: string } = { personId: person.id as string };
  try {
    // 2. Contato com o telefone/e-mail informado.
    const { contact } = await createContactHandler(supabase, ctx, {
      name: input.full_name,
      ...(input.phone_number ? { phone_number: input.phone_number } : {}),
      ...(input.email ? { email: input.email } : {}),
      source: "manual",
    });
    criados.contactId = contact.id;

    // 3. Liga o contato à pessoa.
    await linkContactToPersonHandler(supabase, ctx, actorUserId, contact.id, person.id as string);

    return { person, contact, company_id: companyId };
  } catch (e) {
    await desfazer(ctx, criados);
    throw e;
  }
}
