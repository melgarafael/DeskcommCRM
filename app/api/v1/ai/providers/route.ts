/**
 * GET/PUT /api/v1/ai/providers — a configuração de IA de cada ponto do sistema.
 *
 * GET devolve, para a organização ativa: os pontos (de `lib/ai/pontos/registro`),
 * o que está valendo em cada um HOJE e POR QUÊ (a origem da escolha), as
 * credenciais cadastradas e os modelos que a organização consegue de fato usar.
 *
 * PUT grava a escolha de um ponto — e RECUSA a incompatível. A recusa acontece
 * aqui, na escrita, e não na hora da chamada: aqui existe alguém olhando a tela
 * para ler o motivo e corrigir; lá existe um cliente esperando resposta, e
 * recusar naquele instante trocaria uma configuração ruim por um atendimento
 * perdido.
 */
import { enxergaImagem } from "@/lib/ai/pontos/capacidade-em-vigor";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import {
  decidirBinding,
  EXPLICACAO_DA_ORIGEM,
  PONTOS_DO_AGENTE_PUBLICADO,
  PONTOS_QUE_HERDAM_DO_AGENTE,
  type LinhaDeBinding,
} from "@/lib/ai/pontos/resolver";
import { PAPEIS, PONTOS_DE_IA, PONTO_POR_ID } from "@/lib/ai/pontos/registro";
import { PROVEDORES, ehProvedorSuportado } from "@/lib/ai/pontos/provedores";
import { validarBinding } from "@/lib/ai/pontos/validar-binding";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface ModeloDoCatalogo {
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  supports_vision: boolean;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
  context_window: number | null;
}

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await createClient();

  const [bindingsRes, credsRes, modelosRes, orgRes, agenteRes] = await Promise.all([
    db
      .from("ai_purpose_bindings")
      .select("purpose, provider, credential_id, model_id, base_url, is_enabled")
      .eq("organization_id", org.orgId),
    db
      .from("ai_provider_credentials")
      .select("id, provider, label, api_key_last4, validated_at, is_active")
      .eq("organization_id", org.orgId)
      .eq("is_active", true),
    db
      .from("ai_models")
      .select(
        "provider, model_id, display_name, supports_tools, supports_vision, input_price_per_million_cents, output_price_per_million_cents, context_window",
      )
      .is("deprecated_at", null)
      .order("provider")
      .order("display_name"),
    db.from("organizations").select("settings").eq("id", org.orgId).maybeSingle(),
    db
      .from("ai_agents")
      .select(
        "id, name, published_version_id, versao:ai_agent_versions!ai_agents_published_version_id_fkey(provider, model, credential_id)",
      )
      .eq("organization_id", org.orgId)
      .is("archived_at", null)
      .not("published_version_id", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);

  const bindings = new Map<string, LinhaDeBinding>(
    ((bindingsRes.data ?? []) as LinhaDeBinding[]).map((b) => [b.purpose, b]),
  );

  const llm = ((orgRes.data?.settings as { llm?: Record<string, unknown> } | null)?.llm ??
    {}) as { provider?: string; default_model?: string | null };
  const padraoDaOrganizacao = {
    provider: typeof llm.provider === "string" ? llm.provider : "anthropic",
    defaultModel: typeof llm.default_model === "string" ? llm.default_model : null,
  };

  const versao = (agenteRes.data as { versao?: { provider: string; model: string; credential_id: string | null } } | null)
    ?.versao;
  const agentePublicado = versao
    ? { provider: versao.provider, credentialId: versao.credential_id, model: versao.model }
    : null;

  // ⚠️ A LISTA QUE A TELA DESENHA sai daqui, e `supports_vision` dela vinha da
  // coluna — a mesma que discordava do motor. Reconciliar aqui, uma vez, é o
  // que faz a lista, o aviso do binding e o motor darem a MESMA resposta.
  // Ver `lib/ai/pontos/capacidade-em-vigor.ts`.
  const modelos = ((modelosRes.data ?? []) as ModeloDoCatalogo[]).map((m) => ({
    ...m,
    supports_vision: enxergaImagem({
      provider: m.provider,
      modelId: m.model_id,
      doCatalogo: m.supports_vision,
    }),
  }));
  const capacidadePorModelo = new Map(modelos.map((m) => [`${m.provider}|${m.model_id}`, m]));

  const pontos = PONTOS_DE_IA.map((ponto) => {
    const decisao = decidirBinding({
      pontoId: ponto.id,
      binding: bindings.get(ponto.id) ?? null,
      // Só os pontos que de fato consomem o agente. Em runtime quem sinaliza a
      // herança é a PRESENÇA do `llmOverride`, e esta tela não tem esse sinal:
      // passar o agente para todo ponto faria a coluna "está usando" anunciar o
      // modelo do agente em ponto que nunca o herda — a mesma tela que mente,
      // virada do avesso.
      agentePublicado:
        PONTOS_DO_AGENTE_PUBLICADO.has(ponto.id) || PONTOS_QUE_HERDAM_DO_AGENTE.has(ponto.id)
          ? agentePublicado
          : null,
      // DÍVIDA, não impossibilidade. A justificativa aqui dizia "o servidor web
      // não enxerga o env do worker", e isso é falso: `docker-compose.prod.yml`
      // dá o MESMO `env_file: .env` ao serviço `app` e ao `worker`. O que de
      // fato só existe do lado do worker são os knobs de NOME DE MODELO
      // (STAGE_CLASSIFIER_MODEL e irmãos), declarados apenas no schema Zod de
      // `lib/agent-engine/env.ts` — `process.env` os lê normalmente aqui, como
      // `lib/instalacao/ambiente.ts` já faz para as chaves.
      // Enquanto ficar `undefined`, a origem "veio da instalação" nunca aparece
      // nesta tela, mesmo quando é ela que vale em runtime.
      modeloDeAmbiente: undefined,
      padraoDaOrganizacao,
    });
    const chave = `${decisao.provider}|${decisao.modelId ?? ""}`;
    const capacidade = capacidadePorModelo.get(chave);
    return {
      id: ponto.id,
      rotulo: ponto.rotulo,
      oQueFaz: ponto.oQueFaz,
      papel: ponto.papel,
      exige: ponto.exige,
      sintomaDeFalha: ponto.sintomaDeFalha,
      fixo: ponto.fixo ?? null,
      /**
       * Escolha do agente publicado — a tela mostra como leitura, com link.
       *
       * Depende de EXISTIR versão publicada: é a mesma condição que o resolvedor
       * usa (`resolver.ts` exige `agentePublicado !== null`). Sem o `&&`, uma
       * instalação recém-feita — nenhum agente publicado ainda — abria o painel
       * com os DOIS pontos que respondem o cliente sem seletor, dizendo que são
       * governados por uma versão publicada que não existe e mandando
       * configurar num lugar vazio. É a primeira tela da feature; travá-la no
       * primeiro uso é o pior lugar para esse defeito estar.
       */
      mandadoPeloAgente: agentePublicado !== null && PONTOS_DO_AGENTE_PUBLICADO.has(ponto.id),
      efetivo: {
        provider: decisao.provider,
        modelId: decisao.modelId,
        credentialId: decisao.credentialId,
        baseUrl: decisao.baseUrl,
        origem: decisao.origem,
        porQue: EXPLICACAO_DA_ORIGEM[decisao.origem],
      },
      avisos: [
        ...decisao.avisos,
        // O aviso de capacidade é recalculado aqui porque só o servidor tem o
        // catálogo; o resolvedor puro não consulta banco.
        ...(capacidade && ponto.exige.tools === true && !capacidade.supports_tools
          ? [
              `O modelo em uso não sabe usar as ferramentas do CRM — o agente conversa, mas não registra nada no funil.`,
            ]
          : []),
      ],
    };
  });

  return ok({
    papeis: PAPEIS,
    pontos,
    provedores: PROVEDORES,
    credenciais: credsRes.data ?? [],
    modelos,
    podeEditar: roleAtLeast(org.role, "admin"),
  });
}

const corpoDoPut = z.object({
  purpose: z.string().min(1),
  // A migration 0127 removeu os CHECKs do banco dizendo que "a garantia de que
  // a tela não oferece opção inválida passa a morar" na lista de provedores —
  // mas a lista não era aplicada em NENHUM ponto de escrita. Um PUT direto (e a
  // API é pública) gravava `provider: "foobar"`, a rota respondia 200, e todo
  // uso daquele ponto morria em produção com provedor desconhecido. Metade da
  // defesa transferida e nunca instalada.
  provider: z
    .string()
    .min(1)
    .refine(ehProvedorSuportado, {
      message:
        "provedor não suportado por esta instalação — escolha um da lista em Agente de IA → Provedores",
    }),
  model_id: z.string().min(1),
  credential_id: z.string().uuid().nullable().optional(),
  base_url: z.string().url().nullable().optional(),
  is_enabled: z.boolean().optional(),
});

export async function PUT(req: NextRequest): Promise<Response> {
  const authz = await requireRole("admin", { resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", "corpo inválido", 422, { details: parsed.error.issues });
  }
  const corpo = parsed.data;

  const ponto = PONTO_POR_ID.get(corpo.purpose);
  if (!ponto) return fail("ponto_desconhecido", `"${corpo.purpose}" não é um ponto do sistema`, 404);

  const db = await createClient();

  // A capacidade vem do catálogo (o que o FABRICANTE declara), nunca de
  // heurística sobre o nome do modelo.
  const { data: modelo } = await db
    .from("ai_models")
    .select("model_id, supports_tools, supports_vision")
    .eq("provider", corpo.provider)
    .eq("model_id", corpo.model_id)
    .is("deprecated_at", null)
    .maybeSingle();

  const validacao = validarBinding({
    pontoId: corpo.purpose,
    modelo: {
      model_id: corpo.model_id,
      supports_tools: modelo?.supports_tools ?? false,
      // A capacidade vem do MOTOR, não da coluna: os dois discordavam e a tela
      // avisava "não enxerga imagens" sobre modelo que enxerga. Ver
      // `lib/ai/pontos/capacidade-em-vigor.ts`.
      supports_vision: enxergaImagem({
        provider: corpo.provider,
        modelId: corpo.model_id,
        doCatalogo: modelo?.supports_vision ?? null,
      }),
      conhecido: modelo !== null,
    },
  });
  if (!validacao.ok) {
    return fail(validacao.codigo, validacao.mensagem, 422);
  }

  // A credencial precisa ser DESTA organização. O client de sessão já aplica
  // RLS, mas a checagem explícita devolve mensagem em vez de um silencioso
  // "0 linhas" que a tela leria como sucesso.
  if (corpo.credential_id) {
    const { data: cred } = await db
      .from("ai_provider_credentials")
      .select("id, provider")
      .eq("id", corpo.credential_id)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (!cred) return fail("credencial_invalida", "chave não encontrada nesta organização", 422);
    if (cred.provider !== corpo.provider) {
      return fail(
        "credencial_de_outro_provedor",
        `a chave escolhida é de ${cred.provider}, mas o ponto foi configurado para ${corpo.provider}. ` +
          `Modelo e chave precisam ser do mesmo provedor, senão a chamada é recusada pelo endpoint.`,
        422,
      );
    }
  }

  const { data: gravado, error } = await db
    .from("ai_purpose_bindings")
    .upsert(
      {
        organization_id: org.orgId,
        purpose: corpo.purpose,
        provider: corpo.provider,
        model_id: corpo.model_id,
        credential_id: corpo.credential_id ?? null,
        base_url: corpo.base_url ?? null,
        is_enabled: corpo.is_enabled ?? true,
      },
      { onConflict: "organization_id,purpose" },
    )
    .select("id, purpose, provider, model_id, credential_id, base_url, is_enabled")
    .maybeSingle();

  if (error) return fail("save_failed", error.message, 500);
  if (!gravado) {
    // Upsert que casa zero linhas devolve sucesso no PostgREST — a tela diria
    // "salvo" sem nada ter sido gravado.
    return fail("save_failed", "nada foi gravado — verifique as permissões da organização", 500);
  }

  void audit({
    action: "ai.purpose_binding_updated",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "ai_purpose_binding",
    // O ID DA LINHA, não o `purpose`. `api_audit_log.resource_id` é **uuid**, e
    // `purpose` é texto (`stage_classifier`): o INSERT falhava com 22P02
    // (`invalid input syntax for type uuid`) e — como o audit é
    // fire-and-forget — o erro ia só para o log do servidor. Resultado: NENHUMA
    // troca de modelo era auditada, num painel cujo efeito é justamente mudar
    // para onde o dinheiro e os dados do cliente vão. Achado dirigindo a tela;
    // nenhum gate via, porque nada assertava a linha de auditoria.
    resourceId: (gravado as { id?: string }).id ?? null,
    // O modelo entra no metadata, a credencial NÃO — só o id dela seria
    // inócuo, mas o hábito de mandar campo de credencial para o audit é o que
    // acaba vazando a chave quando alguém troca o campo de lugar.
    metadata: {
      purpose: corpo.purpose,
      provider: corpo.provider,
      model_id: corpo.model_id,
      tem_endpoint_proprio: Boolean(corpo.base_url),
    },
  });

  return ok({ binding: gravado, avisos: validacao.avisos });
}
