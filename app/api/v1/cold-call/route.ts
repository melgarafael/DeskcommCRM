import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/cold-call — o funil de cold call da organização, o roteiro e a fila.
 * POST  /api/v1/cold-call — cria esse funil, uma vez só.
 * PATCH /api/v1/cold-call — troca o roteiro.
 *
 * A régua está em `lib/cold-call/regras.ts`. O funil é um funil comum, marcado em `settings`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  configDoFunil,
  ETAPAS_DO_COLD_CALL,
  MOTIVOS_DE_PERDA_DO_COLD_CALL,
  motivoParaNaoLigar,
  roteiroPadrao,
  roteiroSchema,
} from "@/lib/cold-call/regras";
import { seColdCallDesligado } from "@/lib/cold-call/modulo";
import { lotesDeIds } from "@/lib/kanban/selecao";
import { traduzir } from "@/lib/i18n/dicionario";
import { posicaoEntre, slugDeFunil } from "@/lib/pipelines/pipeline-editing";
import { createClient } from "@/lib/supabase/server";
import { lerFunis } from "../pipelines/_funis";

export const dynamic = "force-dynamic";

const NOME_DO_FUNIL = "Cold Call";
const LIMITE_DA_FILA = 1000;

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** `.in()` em lotes que cabem na URL; o erro de qualquer lote sobe. */
async function emLotes<T>(
  ids: readonly string[],
  consulta: (lote: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  // ponytail: lotes em paralelo (até 20 com a fila de 1000); sequencial se o pool reclamar.
  const respostas = await Promise.all(lotesDeIds(ids).map(consulta));
  const linhas: T[] = [];
  for (const { data, error } of respostas) {
    if (error) throw new Error(error.message);
    linhas.push(...(data ?? []));
  }
  return linhas;
}

async function funilDoColdCall(supabase: Supabase, orgId: string) {
  const { data, error } = await supabase
    .from("crm_pipelines")
    .select("id, name, slug, description, position, is_default, settings")
    .eq("organization_id", orgId)
    .eq("is_archived", false);
  if (error) throw new Error(error.message);
  for (const funil of data ?? []) {
    const config = configDoFunil(funil.settings);
    if (config) return { funil, config };
  }
  return null;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const desligado = await seColdCallDesligado(requestId);
  if (desligado) return desligado;
  const orgId = authz.org.orgId;
  const supabase = await createClient();

  try {
    const achado = await funilDoColdCall(supabase, orgId);
    if (!achado) return ok({ funil: null, roteiro: "", leads: [] }, { requestId });

    const [{ data: etapas, error: erroEtapas }, { data: leads, error: erroLeads }] = await Promise.all([
      supabase
        .from("crm_stages")
        .select("id, slug, name")
        .eq("organization_id", orgId)
        .eq("pipeline_id", achado.funil.id),
      supabase
        .from("crm_leads")
        .select("id, title, description, tags, stage_id, contact_id, owner_user_id, created_at")
        .eq("organization_id", orgId)
        .eq("pipeline_id", achado.funil.id)
        .eq("status", "open")
        .order("created_at")
        .limit(LIMITE_DA_FILA),
    ]);
    if (erroEtapas) throw new Error(erroEtapas.message);
    if (erroLeads) throw new Error(erroLeads.message);

    const ids = (leads ?? []).map((l) => l.id);
    const idsDeContato = [...new Set((leads ?? []).map((l) => l.contact_id).filter((c): c is string => !!c))];
    // A lista de ids viaja na URL do PostgREST, e o Kong recusa a partir de ~187 ids (414, ver
    // app/api/v1/conversations/_handler.ts). Em lotes, e erro de qualquer lote derruba a fila:
    // fila sem nome e sem telefone, sem aviso, é pior que a tela de erro.
    const [contatos, tentativas, conversas] = await Promise.all([
      emLotes(idsDeContato, (lote) =>
        supabase
          .from("contacts")
          .select("id, name, display_name, phone_number, email, street, number, district, city, state, avatar_storage_path, is_anonymized, is_blocked, is_personal")
          .eq("organization_id", orgId)
          .in("id", lote),
      ),
      emLotes(ids, (lote) =>
        supabase
          .from("crm_lead_activities")
          .select("lead_id, performed_at, payload")
          .eq("organization_id", orgId)
          .eq("type", "cold_call_result")
          .in("lead_id", lote),
      ),
      // A conversa mais recente de cada contato: é ela que abre no meio da tela de ligação.
      emLotes(idsDeContato, (lote) =>
        supabase
          .from("conversations")
          .select("id, contact_id, last_message_at")
          .eq("organization_id", orgId)
          .in("contact_id", lote),
      ),
    ]);
    // A ordem vale entre lotes, então ordena aqui e não no banco.
    tentativas.sort((a, b) => a.performed_at.localeCompare(b.performed_at));
    conversas.sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));

    const conversaPorContato = new Map<string, string>();
    for (const c of conversas) {
      if (!conversaPorContato.has(c.contact_id)) conversaPorContato.set(c.contact_id, c.id);
    }

    const etapaPorId = new Map((etapas ?? []).map((e) => [e.id, e]));
    const contatoPorId = new Map(contatos.map((c) => [c.id, c]));
    const historico = new Map<string, { em: string; resultado: string | null }[]>();
    for (const linha of tentativas) {
      const lista = historico.get(linha.lead_id) ?? [];
      lista.push({
        em: linha.performed_at,
        resultado: (linha.payload as { resultado?: string } | null)?.resultado ?? null,
      });
      historico.set(linha.lead_id, lista);
    }

    return ok(
      {
        funil: { id: achado.funil.id, name: achado.funil.name, slug: achado.funil.slug, description: achado.funil.description, position: achado.funil.position, is_default: achado.funil.is_default },
        roteiro: achado.config.roteiro,
        leads: (leads ?? []).map((l) => {
          const contato = l.contact_id ? contatoPorId.get(l.contact_id) : undefined;
          const naoLigar = motivoParaNaoLigar(contato);
          // Quem não pode receber ligação não precisa ter telefone, e-mail, endereço nem conversa
          // na fila: a tela só mostra o nome e o motivo, e o dado não vai para o navegador.
          const contatoLigavel = naoLigar ? undefined : contato;
          const feito = historico.get(l.id) ?? [];
          const ultima = feito[feito.length - 1];
          const rua = contatoLigavel ? [contatoLigavel.street, contatoLigavel.number].filter(Boolean).join(", ") : "";
          const cidade = contatoLigavel ? [contatoLigavel.city, contatoLigavel.state].filter(Boolean).join(" - ") : "";
          return {
            id: l.id,
            titulo: l.title,
            descricao: l.description,
            tags: l.tags ?? [],
            contato_id: l.contact_id,
            contato_nome: nomeDoContato(contato),
            tem_foto: Boolean(contato?.avatar_storage_path && !contato.is_anonymized),
            nao_ligar: naoLigar,
            telefone: contatoLigavel?.phone_number ?? null,
            email: contatoLigavel?.email ?? null,
            endereco: [rua, contatoLigavel?.district, cidade].filter(Boolean).join(" - ") || null,
            conversa_id: l.contact_id && !naoLigar ? (conversaPorContato.get(l.contact_id) ?? null) : null,
            responsavel_id: l.owner_user_id,
            etapa: etapaPorId.get(l.stage_id)?.slug ?? "",
            etapa_nome: etapaPorId.get(l.stage_id)?.name ?? "",
            tentativas: feito.length,
            ultima_tentativa_em: ultima?.em ?? null,
            ultimo_resultado: ultima?.resultado ?? null,
            historico: feito,
            criado_em: l.created_at,
          };
        }),
      },
      { requestId },
    );
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const desligado = await seColdCallDesligado(requestId);
  if (desligado) return desligado;
  const orgId = authz.org.orgId;
  const supabase = await createClient();

  try {
    // Clicar duas vezes não cria dois funis: o que já existe é a resposta.
    const existente = await funilDoColdCall(supabase, orgId);
    if (existente) return ok({ id: existente.funil.id }, { requestId });

    const funis = await lerFunis(supabase, orgId);
    const usados = funis.map((f) => f.name.toLowerCase());
    const nome = usados.includes(NOME_DO_FUNIL.toLowerCase()) ? `${NOME_DO_FUNIL} (ligações)` : NOME_DO_FUNIL;
    const { data: criado, error } = await supabase
      .from("crm_pipelines")
      .insert({
        organization_id: orgId,
        name: nome,
        description: traduzir("Leads para ligar, um por um.", authz.user.idioma),
        slug: slugDeFunil(nome, funis.map((f) => f.slug)),
        position: posicaoEntre(funis[funis.length - 1]?.position ?? null, null),
        is_default: false,
        settings: {
          cold_call: { ativo: true, roteiro: roteiroPadrao(authz.user.idioma) },
          lost_reasons: [...MOTIVOS_DE_PERDA_DO_COLD_CALL],
        },
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const { error: erroEtapas } = await supabase.from("crm_stages").insert(
      ETAPAS_DO_COLD_CALL.map((etapa, i) => ({
        organization_id: orgId,
        pipeline_id: criado.id,
        name: etapa.name,
        slug: etapa.slug,
        position: (i + 1) * 1000,
        is_won: etapa.is_won,
        is_lost: etapa.is_lost,
      })),
    );
    if (erroEtapas) {
      // Duas escritas sem transação: funil sem etapa é quadro morto, então ele não fica.
      await supabase.from("crm_pipelines").delete().eq("id", criado.id).eq("organization_id", orgId);
      throw new Error(erroEtapas.message);
    }

    void audit({
      action: "pipeline.created",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_pipeline",
      resourceId: criado.id,
      requestId,
      metadata: { name: nome, cold_call: true },
    });
    return ok({ id: criado.id }, { status: 201, requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const desligado = await seColdCallDesligado(requestId);
  if (desligado) return desligado;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const lido = roteiroSchema.safeParse(await req.json().catch(() => null));
  if (!lido.success) return fail("unprocessable_entity", t("Escreva o roteiro antes de salvar."), 422, { requestId });

  const supabase = await createClient();
  try {
    const achado = await funilDoColdCall(supabase, orgId);
    if (!achado) return fail("not_found", t("O funil de cold call ainda não foi criado."), 404, { requestId });
    const settings = {
      ...(achado.funil.settings as Record<string, unknown>),
      cold_call: { ativo: true, roteiro: lido.data.roteiro },
    };
    const { error } = await supabase
      .from("crm_pipelines")
      .update({ settings: settings as never })
      .eq("id", achado.funil.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);

    void audit({
      action: "cold_call.script_updated",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_pipeline",
      resourceId: achado.funil.id,
      requestId,
    });
    return ok({ roteiro: lido.data.roteiro }, { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}
