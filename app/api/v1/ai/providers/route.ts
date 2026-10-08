import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  MENSAGEM_PROVEDOR_DESLIGADO,
  provedorDesligadoNaInstalacao,
  provedorOferecido,
} from "@/lib/ai/pontos/provedores-oferecidos";
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
  escolherModeloEconomico,
  EXPLICACAO_DA_ORIGEM,
  PONTOS_DO_AGENTE_PUBLICADO,
  PONTOS_QUE_HERDAM_DO_AGENTE,
  type LinhaDeBinding,
} from "@/lib/ai/pontos/resolver";
import { PAPEIS, PONTOS_DE_IA, PONTO_POR_ID } from "@/lib/ai/pontos/registro";
import { PROVEDORES, ehProvedorSuportado, PROVEDOR_POR_ASSINATURA } from "@/lib/ai/pontos/provedores";
import { listarModelosDaAssinatura } from "@/lib/ai/catalogo/modelos-da-assinatura";
import { validarBinding } from "@/lib/ai/pontos/validar-binding";
import { lerAmbiente } from "@/lib/instalacao/ambiente";
import { decidirTranscricao } from "@/lib/messaging/media/escada-de-transcricao";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { temPrecoNoMotor } from "@/lib/agent-engine/edge/llm/pricing";

export const dynamic = "force-dynamic";

interface ModeloDoCatalogo {
  provider: string;
  model_id: string;
  display_name: string;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_embedding: boolean;
  input_price_per_million_cents: number | null;
  output_price_per_million_cents: number | null;
  context_window: number | null;
}

/** O knob de ambiente dos pontos do degrau econômico — o mesmo que `lib/agent-engine/env.ts` lê no worker. */
function knobDoPontoEconomico(pontoId: string): string | undefined {
  const nome =
    pontoId === "stage_classifier"
      ? "STAGE_CLASSIFIER_MODEL"
      : pontoId === "jailbreak_detect"
        ? "JAILBREAK_CLASSIFIER_MODEL"
        : undefined;
  const valor = nome === undefined ? undefined : process.env[nome]?.trim();
  return valor ? valor : undefined;
}

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
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
        "provider, model_id, display_name, supports_tools, supports_vision, supports_embedding, input_price_per_million_cents, output_price_per_million_cents, context_window",
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
    {}) as { provider?: string; default_model?: string | null; enabled_models?: unknown };
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
  const modelosGlobais = ((modelosRes.data ?? []) as ModeloDoCatalogo[]).map((m) => ({
    ...m,
    supports_vision: enxergaImagem({
      provider: m.provider,
      modelId: m.model_id,
      doCatalogo: m.supports_vision,
    }),
  }));
  const temAssinatura = (credsRes.data ?? []).some(
    (credential) => credential.provider === PROVEDOR_POR_ASSINATURA,
  );
  const modelosDaAssinatura = temAssinatura
    ? await listarModelosDaAssinatura(org.orgId)
    : null;
  const modelos = [
    ...modelosGlobais,
    ...(modelosDaAssinatura ?? []).map((m) => ({
      ...m,
      supports_vision: enxergaImagem({
        provider: "openai",
        modelId: m.model_id,
        doCatalogo: m.supports_vision,
      }),
    })),
  ];
  const capacidadePorModelo = new Map(modelos.map((m) => [`${m.provider}|${m.model_id}`, m]));

  // ─── QUEM OUVE O ÁUDIO: a MESMA escada do worker (#2189/#2190) ────────────
  //
  // A tela não decide sozinha o que o worker decide lá longe: ela roda a
  // escada com os MESMOS dados que já estão nesta requisição — credenciais
  // ativas da organização e knobs do `.env` do processo — e entrega a decisão
  // ao resolvedor. Um lugar decide; os dois lados leem o mesmo lugar; a régua
  // `tests/unit/a-tela-e-o-motor-concordam-sobre-imagem.test.ts` compara.
  //
  // A aproximação é sobre EXISTIR chave, nunca sobre qual é: o anúncio só
  // precisa saber em qual degrau o áudio cai. "Existe" aqui é o mesmo critério
  // de `resolveOrgLlmConfig` — credencial ATIVA e VALIDADA da organização, ou
  // a chave da instalação em `.env` (o Google não tem chave de instalação, e
  // `lerAmbiente` devolve `false` para ele, como o runtime recusa).
  const ambienteDaInstalacao = lerAmbiente();
  const credenciais = (credsRes.data ?? []) as { provider: string; validated_at: string | null }[];
  const chaveExiste = (provider: string): string | null =>
    credenciais.some((c) => c.provider === provider && c.validated_at) ||
    ambienteDaInstalacao.chavesDeProvedor[provider] === true
      ? "chave-existente"
      : null;
  const transcricao = await decidirTranscricao({
    conversa:
      padraoDaOrganizacao.defaultModel !== null
        ? {
            provider: padraoDaOrganizacao.provider,
            apiKey: chaveExiste(padraoDaOrganizacao.provider),
            modelId: padraoDaOrganizacao.defaultModel,
            // A base do provedor custom não é selecionada aqui; ela só muda
            // PARA ONDE a chamada vai, e este lado pergunta QUAL degrau roda.
            baseUrl: null,
          }
        : null,
    chaveOpenai: async () => chaveExiste("openai"),
  });

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
      // Os dois pontos do degrau econômico leem o knob: com ele preenchido, o
      // motor roda o knob e a tela anunciaria o econômico. Os demais seguem a
      // dívida descrita acima.
      modeloDeAmbiente: knobDoPontoEconomico(ponto.id),
      padraoDaOrganizacao,
      // A MESMA escolha econômica do seam (`binding-do-ponto.ts`), sobre o mesmo
      // catálogo e a mesma restrição de modelos habilitados — senão a tela
      // anunciaria o modelo do agente num classificador que roda no econômico.
      economicoDoProvedor: (provider, modeloAtual) =>
        escolherModeloEconomico(
          modelosRes.data ?? [],
          provider,
          modeloAtual,
          Array.isArray(llm.enabled_models)
            ? llm.enabled_models.filter((m): m is string => typeof m === "string")
            : [],
          temPrecoNoMotor,
        ),
      // A escada só muda a resposta do ponto que ela governa; o resolvedor a
      // lê apenas em `fixo.escada`.
      transcricao,
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
        // O modelo de transcrição vem DA ESCADA, e não de um literal no
        // registro nem de um override aqui (#2190): a mesma
        // `decidirTranscricao` do worker escolhe o degrau, e o resolvedor
        // devolve o anúncio daquele degrau. Um override seria um segundo
        // lugar decidindo o mesmo assunto — a forma como o defeito nasceu.
        modelId: decisao.modelId,
        credentialId: decisao.credentialId,
        baseUrl: decisao.baseUrl,
        origem: decisao.origem,
        // O motivo ESCOLHIDO, quando a origem tem um (a escada devolve o do
        // degrau escolhido): "por que este áudio vai para aquele lugar", que a
        // frase genérica da origem não sabe dizer.
        porQue: decisao.motivo ?? EXPLICACAO_DA_ORIGEM[decisao.origem],
      },
      avisos: [
        ...decisao.avisos,
        // O aviso de capacidade é recalculado aqui porque só o servidor tem o
        // catálogo; o resolvedor puro não consulta banco.
        ...(capacidade && ponto.exige.tools === true && !capacidade.supports_tools
          ? [
              t(`O modelo em uso não sabe usar as ferramentas do CRM — o agente conversa, mas não registra nada no funil.`),
            ]
          : []),
      ],
    };
  });

  // O módulo `login_codex` desligado tira a assinatura da lista E a linha do
  // login das credenciais — a mesma regra da tela de Credenciais.
  const oferece = await provedorOferecido(createAdminClient());

  return ok({
    papeis: PAPEIS,
    pontos,
    // O padrão decide o modelo de TODO ponto sem binding explícito — numa
    // instalação nova, 24 dos 25. Ele já era usado aqui para resolver cada
    // ponto; o que faltava era CHEGAR À TELA, e sem isso não havia como
    // mostrá-lo nem trocá-lo (invariante 6: toda configuração tem superfície).
    padrao: padraoDaOrganizacao,
    provedores: PROVEDORES.filter((p) => oferece(p.id)),
    // Só chave de quem CONVERSA. A do Jev contada aqui apagaria o aviso "você
    // ainda não cadastrou nenhuma chave" com a empresa sem IA para atender, e
    // nenhum ponto desta tela sabe usá-la.
    credenciais: (credsRes.data ?? []).filter((c) => oferece(c.provider)),
    // Sem chave cadastrada, o aviso só pode dizer "o atendimento usa a chave que
    // veio na instalação" quando ela existe. A mesma conta de
    // `app/app/ai/credentials/page.tsx`.
    instalacaoTemChave: instalacaoTemChaveDeIa(),
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
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { details: parsed.error.issues });
  }
  const corpo = parsed.data;
  const desligado = await provedorDesligado(corpo.provider);
  if (desligado) return desligado;

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
    if (!cred) return fail("credencial_invalida", t("chave não encontrada nesta organização"), 422);
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
    return fail("save_failed", t("nada foi gravado — verifique as permissões da organização"), 500);
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


const corpoDoPatch = z.object({
  provider: z
    .string()
    .min(1)
    .refine(ehProvedorSuportado, {
      message:
        "provedor não suportado por esta instalação — escolha um da lista em Agente de IA → Provedores",
    }),
  default_model: z.string().min(1),
});

/**
 * Troca o PADRÃO da organização — o modelo que vale em todo ponto sem binding
 * explícito.
 *
 * Uma escrita aqui muda o comportamento de dezenas de pontos de uma vez, e é
 * por isso que exige `admin` como o PUT: quem pode mudar um ponto pode mudar
 * todos, mas quem não pode mudar nenhum não muda o padrão pela porta dos fundos.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = corpoDoPatch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { details: parsed.error.issues });
  }
  const corpo = parsed.data;
  const desligado = await provedorDesligado(corpo.provider);
  if (desligado) return desligado;

  const db = await createClient();

  // O modelo tem de existir no catálogo DAQUELE provedor. Sem esta conferência,
  // um erro de digitação vira padrão da organização e derruba todo ponto
  // herdado — o mesmo modo de falha que o `PUT` já evita ponto a ponto.
  const { data: modelo } = await db
    .from("ai_models")
    .select("model_id")
    .eq("provider", corpo.provider)
    .eq("model_id", corpo.default_model)
    .maybeSingle();

  // MAS A CONFERÊNCIA SÓ VALE SE HOUVER CATÁLOGO PARA CONFERIR. `ai_models` é
  // populada pela sincronização do catálogo; numa instalação recém-feita, ou
  // numa que não roda scheduler, ela está VAZIA para o provedor escolhido — e o
  // `404` abaixo recusava todo modelo, inclusive o certo, digitado de dentro da
  // tela, que é o único caminho que sobra quando o combo está vazio. Era a
  // segunda porta do mesmo defeito que o `PUT` já tinha resolvido: lá o
  // `validar-binding.ts` aceita modelo fora do catálogo e devolve
  // `conhecido: false` como aviso (é o que o `CartaoDoPonto` mostra).
  //
  // Então a pergunta muda de "conheço ESTE modelo?" para "conheço algum modelo
  // deste provedor?": com catálogo presente o `404` continua e segue pegando o
  // erro de digitação; sem catálogo nenhum, não há o que conferir — a escrita
  // passa e sai com aviso. Recusar aqui seria inventar uma verificação que esta
  // instalação não tem como fazer, e travar a tela que existe justamente para
  // configurar isso.
  let avisos: string[] = [];
  if (!modelo) {
    const { data: algumDoProvedor } = await db
      .from("ai_models")
      .select("model_id")
      .eq("provider", corpo.provider)
      .limit(1)
      .maybeSingle();
    if (algumDoProvedor) {
      return fail(
        "modelo_desconhecido",
        t(`"${corpo.default_model}" não está no catálogo de ${corpo.provider}`),
        404,
      );
    }
    avisos = [
      t(
        `o catálogo de ${corpo.provider} ainda não foi sincronizado nesta instalação, então não deu para conferir "${corpo.default_model}" — se o identificador estiver errado, todo ponto que herda o padrão vai falhar.`,
      ),
    ];
  }

  // ⚠️ CLIENTE ADMIN, E NÃO É ATALHO: a RLS de `organizations` só deixa
  // ESCREVER quem é platform admin. Com o cliente de sessão, o `update` abaixo
  // casa ZERO linhas para o `admin` do próprio tenant — e o PostgREST devolve
  // SUCESSO, sem erro. Medido: `admin` da org → 0 linhas afetadas; mesmo
  // comando com o cliente admin → 1. É a pior forma de falhar, porque a tela
  // diria "salvo".
  //
  // Como o `install.sh` cria o dono da instalação COMO platform admin, o
  // caminho funcionaria na máquina de quem testa e quebraria para o segundo
  // administrador do time — o tipo de defeito que só aparece no cliente.
  //
  // É o que fazem os oito escritores de `organizations` deste repo, com o
  // gêmeo exato em `app/actions/auth/politicaDeMfa.ts:62`, que escreve o MESMO
  // jsonb. O `.eq("id", org.orgId)` abaixo é obrigatório e não decorativo: o
  // service role passa por cima da RLS, então o filtro de tenant vira
  // responsabilidade deste arquivo. `org.orgId` vem do `requireRole` (cookie/
  // JWT), nunca do corpo.
  const admin = createAdminClient();

  // MERGE, nunca sobrescrita. `organizations.settings` é um jsonb compartilhado
  // — `branding` (a marca da instalação) e `security` (a política de MFA) moram
  // nele. Um `update({ settings: { llm } })` ingênuo apaga os dois em silêncio, e
  // o sintoma aparece dias depois, longe daqui.
  const { data: orgAtual } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();

  const settingsAtuais = ((orgAtual?.settings ?? {}) as Record<string, unknown>) || {};
  const settings = {
    ...settingsAtuais,
    llm: { provider: corpo.provider, default_model: corpo.default_model },
  };

  const { data: gravado, error } = await admin
    .from("organizations")
    .update({ settings })
    .eq("id", org.orgId)
    .select("settings")
    .maybeSingle();

  if (error) return fail("save_failed", error.message, 500);
  if (!gravado) {
    // Mesma armadilha do PUT: no PostgREST, update que casa zero linhas volta
    // como sucesso, e a tela diria "salvo" sem nada ter sido gravado.
    return fail("save_failed", t("nada foi gravado — verifique as permissões da organização"), 500);
  }

  void audit({
    action: "ai.org_default_updated",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { provider: corpo.provider, default_model: corpo.default_model },
  });

  return ok({
    padrao: { provider: corpo.provider, defaultModel: corpo.default_model },
    avisos,
  });
}

/**
 * O Zod já recusou o provedor que o sistema não conhece; aqui cai o que ele
 * conhece mas esta instalação desligou (a assinatura do ChatGPT, com o módulo
 * `login_codex` fora). Sem isto, um PUT/PATCH direto gravava a assinatura num
 * ponto ou no padrão que a tela nem oferece.
 */
async function provedorDesligado(provider: string): Promise<Response | null> {
  if (!(await provedorDesligadoNaInstalacao(createAdminClient(), provider))) return null;
  return fail("provedor_desligado", MENSAGEM_PROVEDOR_DESLIGADO, 422);
}

function instalacaoTemChaveDeIa(): boolean {
  const ambiente = lerAmbiente();
  return ambiente.gateway || Object.values(ambiente.chavesDeProvedor).some(Boolean);
}
