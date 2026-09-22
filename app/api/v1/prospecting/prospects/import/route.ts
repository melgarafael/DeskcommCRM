/**
 * POST /api/v1/prospecting/prospects/import — leva prospects ao CRM (§16–17).
 *
 * Para cada prospect: procura cliente existente (telefone canônico, email).
 * Achou → vincula e marca `cliente` (SEM criar outro registro). Não achou →
 * cria contato (source prospeccao + metadados) e lead na primeira etapa do
 * primeiro funil, com dono opcional. `do_not_contact` e `bloqueado` barram.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { funilDeEntrada } from "@/lib/leads/nascimento-do-lead";
import { importBatchSchema } from "@/lib/schemas/prospeccao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "business_prospects" });
  if (!authz.ok) return authz.response;

  const parsed = importBatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  const { data: prospects } = await supabase
    .from("business_prospects")
    .select(
      "id, nome, categoria, cidade, estado, telefone, email, website, endereco, " +
        "contact_id, lead_id, do_not_contact, bloqueado, external_url",
    )
    .eq("organization_id", authz.org.orgId)
    .in("id", parsed.data.prospect_ids);

  const linhas = ((prospects ?? []) as unknown as {
    id: string;
    nome: string;
    categoria: string | null;
    cidade: string | null;
    estado: string | null;
    telefone: string | null;
    email: string | null;
    website: string | null;
    endereco: string | null;
    contact_id: string | null;
    lead_id: string | null;
    do_not_contact: boolean;
    bloqueado: boolean;
    external_url: string | null;
  }[]);

  if (linhas.length === 0) return fail("not_found", "Nenhum prospect encontrado.", 404, { requestId });

  // Destino no CRM: O MESMO funil de entrada que a conversa usa ao virar
  // lead (`funilDeEntrada` — `is_default` + primeira etapa útil). Reimplementar
  // a regra aqui ("primeiro funil por created_at") fez o import mandar leads
  // para um funil diferente do resto do produto — mesma decisão, um só lugar.
  const destino = await funilDeEntrada(supabase, authz.org.orgId);
  if ("erro" in destino) {
    return fail(
      "validation_failed",
      destino.erro === "sem_funil_de_entrada"
        ? "Sem funil configurado — crie um funil antes de importar."
        : "O funil padrão não tem etapa utilizável — revise as etapas antes de importar.",
      422,
      { requestId },
    );
  }
  const funilId = destino.pipelineId;
  const etapaId = destino.stageId;

  const resultado = { vinculados: 0, criados: 0, recusados: 0, detalhes: [] as string[] };

  for (const p of linhas) {
    if (p.do_not_contact || p.bloqueado) {
      resultado.recusados++;
      resultado.detalhes.push(`${p.nome}: marcado como não contatar/bloqueado.`);
      continue;
    }
    if (p.contact_id && p.lead_id) {
      resultado.recusados++;
      resultado.detalhes.push(`${p.nome}: já está no CRM.`);
      continue;
    }

    // Cliente existente? Telefone canônico ou email — nunca duplica.
    let contatoId: string | null = p.contact_id;
    if (!contatoId) {
      const conds: string[] = [];
      if (p.telefone) conds.push(`phone_number.eq.${canonicalPhoneBR(p.telefone)}`);
      if (p.email) conds.push(`email.eq.${p.email}`);
      if (conds.length > 0) {
        const { data: existente } = await supabase
          .from("contacts")
          .select("id")
          .eq("organization_id", authz.org.orgId)
          .or(conds.join(","))
          .limit(1)
          .maybeSingle();
        contatoId = (existente as unknown as { id: string } | null)?.id ?? null;
      }
    }

    if (contatoId && !p.lead_id) {
      // Já é cliente: vincula, marca, sem lead novo e sem contato novo.
      await supabase
        .from("business_prospects")
        .update({ contact_id: contatoId, status_comercial: "cliente" })
        .eq("id", p.id)
        .eq("organization_id", authz.org.orgId);
      resultado.vinculados++;
      continue;
    }

    if (!contatoId) {
      const { data: novoContato, error: erroContato } = await supabase
        .from("contacts")
        .insert({
          organization_id: authz.org.orgId,
          display_name: p.nome,
          name: p.nome,
          phone_number: p.telefone ? canonicalPhoneBR(p.telefone) : null,
          email: p.email,
          source: "prospeccao",
          source_metadata: {
            prospect_id: p.id,
            categoria: p.categoria,
            website: p.website,
            endereco: p.endereco,
            maps_url: p.external_url,
          },
          tags: [p.categoria, p.cidade].filter(Boolean) as string[],
          created_by_user_id: authz.user.id,
        })
        .select("id")
        .single();
      if (erroContato || !novoContato) {
        resultado.recusados++;
        resultado.detalhes.push(`${p.nome}: falhou ao criar contato.`);
        continue;
      }
      contatoId = (novoContato as unknown as { id: string }).id;
    }

    const { data: lead, error: erroLead } = await supabase
      .from("crm_leads")
      .insert({
        organization_id: authz.org.orgId,
        pipeline_id: funilId,
        stage_id: etapaId,
        contact_id: contatoId,
        title: p.nome,
        source: "prospeccao",
        source_metadata: { prospect_id: p.id, categoria: p.categoria, cidade: p.cidade },
        tags: [p.categoria].filter(Boolean) as string[],
        ...(parsed.data.owner_user_id ? { owner_user_id: parsed.data.owner_user_id } : {}),
        created_by_user_id: authz.user.id,
      })
      .select("id")
      .single();

    if (erroLead || !lead) {
      resultado.recusados++;
      resultado.detalhes.push(`${p.nome}: falhou ao criar lead.`);
      continue;
    }

    await supabase
      .from("business_prospects")
      .update({
        contact_id: contatoId,
        lead_id: (lead as unknown as { id: string }).id,
        status_comercial: "contato_pendente",
      })
      .eq("id", p.id)
      .eq("organization_id", authz.org.orgId);
    resultado.criados++;
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "prospect.imported_to_crm",
    resourceType: "business_prospects",
    resourceId: null,
    requestId,
  });

  return ok(resultado, { requestId });
}
