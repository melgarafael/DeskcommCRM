import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { CredentialRow } from "@/hooks/ai/useCredentials";
import { traduzir } from "@/lib/i18n/dicionario";
import { contarUsoQueBloqueia, type VersaoVinculada } from "@/lib/ai/credenciais/uso";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import {
  algumFluxoQueClassifica,
  algumRoteadorQuePergunta,
  estadoEfetivoDaTarefa,
  INSCRICAO_ENCERRADA,
  TAREFAS_DO_JEV,
  tarefaSemCamada,
  tarefaSemFluxo,
  tarefaSemRoteador,
} from "@/lib/ai/decisao/tarefas";
import { camadasEfetivas } from "@/lib/agent-engine/guardrails/camadas-da-org";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { lerAmbiente } from "@/lib/instalacao/ambiente";
import { logger } from "@/lib/logger";
import { criarSessaoPkce } from "@/lib/ai/pontos/pkce-da-assinatura";
import { emitirEstado } from "@/lib/agenda/google/estado";
import { env } from "@/lib/env";
import { PROVEDOR_POR_ASSINATURA, PROVEDORES } from "@/lib/ai/pontos/provedores";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { CredentialsList } from "./_components/CredentialsList";
import { PainelDeLoginCodex } from "./_components/PainelDeLoginCodex";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

export default async function CredentialsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("ai_provider_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  const todas = (data ?? []) as CredentialRow[];

  // O INTERRUPTOR DA INSTALAÇÃO (#1672, itens 6 e 9): desligado, a linha do
  // login por assinatura NÃO aparece aqui — nem no painel, nem na lista de
  // chaves. A leitura do banco continua acontecendo (a linha é da empresa,
  // cifrada e protegida por RLS), mas ninguém a enxerga: o leitor próprio
  // (`lib/ai/credenciais/login-codex.ts`) também recusa quando o módulo está
  // fora.
  const moduloLoginCodex = await moduloLigado(createAdminClient(), "login_codex");

  // A linha do login por assinatura não é uma CHAVE de API: ela guarda o par
  // de tokens da conta da empresa, e vai para o painel próprio. Fora da lista
  // de chaves, ela também não mentiria como "credencial" no agrupamento por
  // provedor (que só conhece quem cadastra chave).
  const linhaDeLogin = moduloLoginCodex
    ? (todas.find((c) => c.provider === PROVEDOR_POR_ASSINATURA) ?? null)
    : null;
  const credentials = todas.filter((c) => c.provider !== PROVEDOR_POR_ASSINATURA);
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  // O par PKCE DESTA renderização: o link mostrado e o verifier do campo de
  // colagem nascem juntos — e só JUNTOS valem: o `code` que o navegador deixa
  // não troca sem o verifier. Nenhum dos dois circula sozinho (o `code` só
  // existe no navegador de quem conecta, e a troca acontece no servidor), mas
  // isso não faz do verifier um valor público: é segredo de uso ÚNICO, que
  // existe para esta conexão e morre com ela. Não é chave da OpenAI — quem
  // tiver os dois, porém, troca o `code` por tokens.
  //
  // O `state` é ASSINADO com a empresa e a pessoa (o mesmo `emitirEstado` da
  // agenda do Google): a action só troca o código cujo retorno traz este
  // `state`. Sem segredo utilizável o painel não aparece — um login que
  // ninguém consegue conferir não deve ser oferecido.
  let sessaoPkce: ReturnType<typeof criarSessaoPkce> | null = null;
  if (moduloLoginCodex) {
    try {
      sessaoPkce = criarSessaoPkce(
        emitirEstado(
          { organizationId: activeOrg.orgId, userId: user.id },
          { segredo: env.INTERNAL_SECRET, agora: new Date() },
        ),
      );
    } catch (err) {
      logger.warn("[ai/credentials] login por assinatura sem state assinado (INTERNAL_SECRET?)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Mesma regra do DELETE — e a mesma da FK `ON DELETE RESTRICT`: TODA versão
  // que aponta para a credencial trava a exclusão, não só a publicada. O número
  // que a tela mostra é o que explica o bloqueio (ver `lib/ai/credenciais/uso.ts`).
  let usageMap: Record<string, number> = {};
  if (credentials.length > 0) {
    const { data: linked } = await supabase
      .from("ai_agent_versions")
      .select("id, credential_id, version_number, status")
      .eq("organization_id", activeOrg.orgId)
      .in("credential_id", credentials.map((c) => c.id));
    usageMap = contarUsoQueBloqueia((linked ?? []) as unknown as VersaoVinculada[]);
  }

  // "Usada em" e o aviso de exclusão da chave do Jev saem da LISTA VIVA, no
  // cliente (`CredentialsList`): calculados aqui, sobre a foto das linhas, uma
  // chave recém-trocada (ainda sem `validated_at`) perdia a linha e só a
  // recuperava recarregando a página, embora a lista já a mostrasse validada.
  // Daqui saem só o que o cliente não tem: o interruptor e a IA principal.
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const configDoJev = lerConfigDoJev(orgRow?.settings);
  const jevLigado = configDoJev.ligado;
  // A camada que a manipulação acompanha: desligada, a tarefa não roda. Leitura
  // que falha não cai no padrão do ambiente (que liga a camada): a tela deixa a
  // tarefa de fora em vez de afirmar que ela roda — falha fechada na afirmação.
  const { data: linhasDasCamadas, error: erroDasCamadas } = jevLigado
    ? await supabase.from("org_guardrail_layers").select("layer, enabled").eq("organization_id", activeOrg.orgId)
    : { data: null, error: null };
  const camadas = erroDasCamadas ? null : camadasEfetivas(linhasDasCamadas ?? []);
  // O roteador: sem um ativo que o Jev possa perguntar, ele não escolhe agente
  // nenhum. Leitura que falha: a tarefa sai da lista, pelo mesmo motivo.
  const { data: roteadoresAtivos, error: erroDosRoteadores } = jevLigado
    ? await supabase
        .from("ai_routers")
        .select("id, intencoes:ai_router_members(count)")
        .eq("organization_id", activeOrg.orgId)
        .eq("is_active", true)
    : { data: null, error: null };
  const temRoteadorQuePergunta = !erroDosRoteadores && algumRoteadorQuePergunta(roteadoresAtivos ?? []);
  // O follow-up: sem um publicado com o passo "Classificar (IA)", nem uma
  // inscrição andando numa versão com ele, ninguém lê a resposta do cliente — a
  // mesma leitura da rota do cartão. Leitura que falha: a tarefa sai da lista, idem.
  const [{ data: fluxosPublicados, error: erroDosPublicados }, { data: versoesEmCurso, error: erroDasEmCurso }] =
    jevLigado
      ? await Promise.all([
          supabase
            .from("followup_flow_pointers")
            .select("versao:followup_flow_versions!followup_flow_pointers_active_version_id_fkey(graph)")
            .eq("organization_id", activeOrg.orgId)
            .eq("status", "active"),
          supabase
            .from("followup_flow_versions")
            .select("graph, inscricoes:followup_enrollments!inner(id)")
            .eq("organization_id", activeOrg.orgId)
            .not("inscricoes.status", "in", INSCRICAO_ENCERRADA)
            .limit(1, { referencedTable: "inscricoes" }),
        ])
      : [{ data: null, error: null }, { data: null, error: null }];
  const erroDosFluxos = erroDosPublicados ?? erroDasEmCurso;
  const temFluxoQueClassifica =
    !erroDosFluxos &&
    algumFluxoQueClassifica([...(fluxosPublicados ?? []), ...(versoesEmCurso ?? []).map((versao) => ({ versao }))]);
  if (erroDasCamadas || erroDosRoteadores || erroDosFluxos) {
    logger.warn("credenciais: o \"Usada em\" do Jev saiu sem conferir a camada, o roteador ou os follow-ups", {
      organization_id: activeOrg.orgId,
      camadas: erroDasCamadas?.message ?? null,
      roteadores: erroDosRoteadores?.message ?? null,
      fluxos: erroDosFluxos?.message ?? null,
    });
  }
  // A mesma pergunta que o worker faz: sem a chave do Jev, há IA principal para medir?
  const jev = jevLigado
    ? {
        // Só as tarefas que a chave de fato serve agora.
        tarefas: TAREFAS_DO_JEV.filter(
          (t) =>
            estadoEfetivoDaTarefa(configDoJev, t) !== "desligada" &&
            (camadas === null ? t.camada === undefined : !tarefaSemCamada(t, camadas)) &&
            !tarefaSemRoteador(t, temRoteadorQuePergunta) &&
            !tarefaSemFluxo(t, temFluxoQueClassifica),
        ).map((t) => t.rotulo),
        temIaPrincipal:
          (await resolverModeloDoPonto("sentiment_classify", activeOrg.orgId, DEFAULT_CLASSIFIER_MODEL, {
            naFaltaUsarOPadraoDaOrganizacao: true,
          })) !== null,
      }
    : null;

  // A chave do `.env` também é "IA principal" — sem ela na conta, a lista
  // acusaria falta de IA a quem atende com a chave que veio na instalação.
  const ambiente = lerAmbiente();
  const instalacaoTemIa =
    ambiente.gateway || Object.values(ambiente.chavesDeProvedor).some(Boolean);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Chaves de acesso à IA", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {/* Os provedores saem da lista única: escritos à mão, a frase citava
              três quando já eram cinco. */}
          {traduzir(
            "A conta de inteligência artificial é sua: você contrata direto com {provedores} e cola a chave aqui. A chave fica guardada criptografada e nunca mais aparece na tela depois de salva — nem para você. O Jev (TypeSafe) não conversa com o cliente: a chave dele serve só para decisões rápidas.",
            idioma,
          ).replace(
            "{provedores}",
            new Intl.ListFormat(tagDeIdioma(idioma), { type: "disjunction" }).format(
              PROVEDORES.map((p) => p.rotulo),
            ),
          )}
        </p>
      </header>
      {moduloLoginCodex && sessaoPkce && (
        <PainelDeLoginCodex
          url={sessaoPkce.url}
          codeVerifier={sessaoPkce.codeVerifier}
          conectado={linhaDeLogin !== null}
          validada={linhaDeLogin?.validated_at != null}
        />
      )}
      <CredentialsList
        initialData={credentials}
        canWrite={canWrite}
        usageMap={usageMap}
        jev={jev}
        instalacaoTemIa={instalacaoTemIa}
      />
    </div>
  );
}
