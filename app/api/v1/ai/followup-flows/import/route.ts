import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/import — cria um fluxo a partir de um ARQUIVO
 * exportado (manager+). Corpo: `{ file, name? }`, onde `file` é o que o
 * `GET /:id/export` devolveu em `data.file`.
 *
 * O fluxo nasce SEMPRE como rascunho (`draft`, sem `active_version_id`), como o
 * duplicar: importar não publica e não manda mensagem. A semântica (caminho até
 * o fim, ramos cobertos, etapa escolhida) é cobrada pelo `/publish`, como em
 * qualquer fluxo desenhado à mão.
 *
 * Cada id que o arquivo cita é conferido contra a organização ativa e, quando
 * não existe aqui, remapeado pelo nome ou esvaziado — a lista do que aconteceu
 * volta em `data.pendencias`. Regras em `lib/followup/portabilidade.ts`.
 *
 * `organization_id` vem da sessão (`requireRole`), nunca do arquivo: o arquivo
 * não carrega organização nenhuma.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { MAX_FOLLOWUP_FLOW_NAME } from "@/lib/followup/nome-da-copia";
import {
  TAMANHO_MAXIMO_DO_ARQUIVO,
  arquivoDeFluxoSchema,
  nomeDoImportado,
  problemasDoArquivo,
  reconciliarComAConta,
  zodNoIdioma,
} from "@/lib/followup/portabilidade";
import { contextoDaConta } from "@/lib/followup/portabilidade-db";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({
  file: z.unknown(),
  /** Renomear na hora de importar (o nome do arquivo vale quando ausente). */
  name: z.string().trim().min(1).max(MAX_FOLLOWUP_FLOW_NAME).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const declarado = Number(req.headers.get("content-length") ?? "0");
  if (declarado > TAMANHO_MAXIMO_DO_ARQUIVO) {
    return fail(
      "payload_too_large",
      t("Arquivo grande demais para um fluxo (máximo de 512 KB)."),
      413,
      {
        requestId,
      },
    );
  }

  let texto: string;
  try {
    texto = await req.text();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  if (texto.length > TAMANHO_MAXIMO_DO_ARQUIVO) {
    return fail(
      "payload_too_large",
      t("Arquivo grande demais para um fluxo (máximo de 512 KB)."),
      413,
      {
        requestId,
      },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(texto);
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const corpo = corpoSchema.safeParse(raw, zodNoIdioma(authz.user.idioma));
  if (!corpo.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: { problemas: problemasDoArquivo(corpo.error) },
    });
  }

  const arquivo = arquivoDeFluxoSchema.safeParse(corpo.data.file, zodNoIdioma(authz.user.idioma));
  if (!arquivo.success) {
    return fail(
      "invalid_flow_file",
      t("O arquivo não é um fluxo válido. Confira os itens abaixo e tente de novo."),
      422,
      { requestId, details: { problemas: problemasDoArquivo(arquivo.error) } },
    );
  }

  const surface = arquivo.data.flow.surface ?? "followup";
  // Roteiro de atendimento é módulo opcional da instalação: desligado, a porta
  // não existe — a mesma resposta do `POST /followup-flows`.
  if (
    surface === "atendimento" &&
    !(await moduloLigado(createAdminClient(), "fluxos_atendimento"))
  ) {
    return fail(
      "module_disabled",
      t(
        "Este arquivo é de um fluxo de atendimento, e os fluxos de atendimento estão desligados nesta instalação.",
      ),
      422,
      { requestId },
    );
  }

  const supabase = await createClient();

  let conta;
  try {
    conta = await contextoDaConta(supabase, createAdminClient(), activeOrg.orgId);
  } catch (err) {
    return fail(
      "internal_error",
      err instanceof Error ? err.message : "import_context_failed",
      500,
      {
        requestId,
      },
    );
  }

  const resultado = reconciliarComAConta(arquivo.data, conta);
  const nome = nomeDoImportado(corpo.data.name ?? arquivo.data.flow.name, conta.flows.values());

  const { data: criado, error: insErr } = await supabase
    .from("followup_flow_pointers")
    .insert({
      organization_id: activeOrg.orgId,
      name: nome,
      status: "draft",
      draft_graph: resultado.graph,
      trigger_config: resultado.trigger_config,
      handoff_policy: arquivo.data.flow.handoff_policy,
      surface,
    })
    .select("*")
    .single();

  if (insErr || !criado) {
    if (insErr?.code === "23505") {
      return fail("conflict", t("Já existe um fluxo com este nome."), 409, { requestId });
    }
    return fail("internal_error", insErr?.message ?? "followup_flow_import_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.imported",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: criado.id,
    requestId,
    // Contagens e códigos, nunca o texto das mensagens do fluxo.
    metadata: {
      name: nome,
      surface,
      nodes: resultado.graph.nodes.length,
      edges: resultado.graph.edges.length,
      trigger_kind: resultado.trigger_config.kind,
      pendencias: resultado.pendencias.map((p) => p.codigo),
    },
  });

  return ok({ flow: criado, pendencias: resultado.pendencias }, { requestId, status: 201 });
}
