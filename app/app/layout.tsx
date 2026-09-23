import { InterfaceRefresh } from "@/hooks/auth/InterfaceRefresh";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isMfaEnrolled, loadAuthUser, requiresMfa, resolveActiveOrg } from "@/lib/auth/server";
import { DEFAULT_VISIBILITY_MODE, roleAtLeast, type VisibilityMode } from "@/lib/auth/types";
import { clientePelaAgendaLigado } from "@/lib/schemas/settings";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import { ProvedorDeCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { AppShell } from "./_components/AppShell";
import { EstiloDaMarcaDaOrganizacao } from "./_components/EstiloDaMarcaDaOrganizacao";
import { MfaEnrollGate } from "@/components/auth/MfaEnrollGate";
import { cssDaMarca, ESCOPO_DA_ORGANIZACAO } from "@/lib/branding/css";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { resolverMarcaDaOrganizacao } from "@/lib/branding/organizacao";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { modulosLigados } from "@/lib/instalacao/modulos";
import {
  ImpersonateBanner,
} from "@/components/app/ImpersonateBanner";
import { ConexaoCaidaBanner } from "@/components/app/ConexaoCaidaBanner";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { listarConexoesCaidas, type ConexaoCaida } from "@/lib/channels/health";
import { VoiceCallProvider } from "@/components/voice/VoiceCallContext";
import { ProvedorDaOcupacaoDoRodape } from "@/lib/ui/rodape-ocupado";
import { acessoFoiRevogado } from "@/lib/auth/vinculo-revogado";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await loadAuthUser();
  if (!user) redirect("/login");

  let activeOrg = await resolveActiveOrg(user);

  // Sem organização ativa existem DOIS estados, e eles pedem telas opostas:
  //
  //  - nunca teve  → provisionamento que falhou no signup. `/get-started`
  //                  existe exatamente para isso e continua sendo o caminho.
  //  - teve e foi revogada → precisa SABER disso. Até 2026-09-10 essa pessoa
  //                  caía aqui mesmo, via a casca vazia e a oferta "Configure
  //                  sua organização" — uma revogação virando criação de
  //                  tenant. Medido numa instalação real.
  //
  // A consulta só roda neste ramo, que é o raro: quem tem organização não paga
  // nada por ela.
  if (!activeOrg && !user.support && (await acessoFoiRevogado(user.id))) {
    redirect("/acesso-revogado");
  }

  /**
   * A cor desta organização, serializada, ou `null` quando ela não tem uma.
   *
   * Resolvida no MESMO `settings` que o gate de onboarding logo abaixo já lê —
   * zero consulta nova. A ordem das camadas (organização acima, instalação no
   * meio, arquivo de instalação embaixo) mora em `lib/branding/organizacao.ts`,
   * e não aqui: a precedência é regra do produto, não detalhe deste layout.
   */
  let cssDaOrganizacao: string | null = null;

  // EPIC-02: gate /app/* on completed onboarding.
  // EPIC-11: gate /app/* on org not being suspended (S-11.08).
  let conexoesCaidas: ConexaoCaida[] = [];
  let enrolled = false;
  let needsMfaGate = false;

  if (activeOrg) {
    const admin = createAdminClient();
    /**
     * As cinco consultas que TODA página de `/app` paga, disparadas juntas.
     *
     * Elas eram sequenciais e independentes: cada uma esperava a anterior sem
     * precisar do resultado dela, e a soma aparecia como a tela que não reage ao
     * clique. Em paralelo, o custo passa a ser o da mais lenta.
     *
     * Duas consequências que valem estar escritas, porque não são acidente:
     *
     *  - `listarConexoesCaidas` e `requiresMfa` agora rodam ANTES dos `redirect`
     *    de onboarding e de suspensão. Quem vai ser redirecionado paga duas
     *    consultas a mais — um caminho raro, que termina numa navegação de
     *    qualquer forma. O caminho normal, que é todo render de todo usuário,
     *    deixa de pagar três esperas em fila.
     *  - A consulta das conexões continua morando no seam
     *    (`lib/channels/health`), não aqui: tela que monta o select de
     *    `channel_sessions` à mão foi o que deixou três seletores oferecendo
     *    canal arquivado (invariante `canais-selecionaveis`), e de quebra o
     *    filtro de estados fica LITERALMENTE o mesmo que decide o aviso da
     *    Central. Vigiado por
     *    `tests/unit/faixa-de-conexao-caida-vem-do-seam.test.tsx`, que EXECUTA
     *    este layout — a cerca anterior lia o texto-fonte e reprovava esta
     *    refatoração sem que nada tivesse quebrado.
     */
    const [orgRes, conexoes, isEnrolled, mfaRequired, modulos] = await Promise.all([
      admin
        .from("organizations")
        .select("onboarded_at, status, settings")
        .eq("id", activeOrg.orgId)
        .maybeSingle(),
      listarConexoesCaidas(admin, activeOrg.orgId),
      isMfaEnrolled(),
      requiresMfa(
        activeOrg.role,
        user.is_platform_admin,
        user.id,
        activeOrg.orgId,
      ),
      // Da INSTALAÇÃO: decide se a porta de um módulo opcional entra no menu.
      modulosLigados(admin),
    ]);

    const orgRow = orgRes.data;
    conexoesCaidas = conexoes;
    enrolled = isEnrolled;
    needsMfaGate = mfaRequired;

    if (orgRow && !orgRow.onboarded_at && !user.support) redirect("/onboarding");
    if (orgRow?.status === "suspended") redirect("/account-suspended");
    // G4-02: expõe visibility_mode ao client (inbox decide visões visíveis).
    // Fonte confiável (admin client, org do cookie validado) — nunca do body.
    const mode = (orgRow?.settings as { visibility_mode?: VisibilityMode } | null)
      ?.visibility_mode;
    activeOrg = {
      ...activeOrg,
      visibility_mode: mode ?? DEFAULT_VISIBILITY_MODE,
      // Mesma linha de `settings` já lida acima — nenhuma consulta a mais.
      cliente_pela_agenda: clientePelaAgendaLigado(orgRow?.settings),
      modulos_ligados: modulos,
    };

    // `marcaDaInstalacao()` é memoizada por TTL no PROCESSO (`lib/branding/
    // instalacao.ts`), e a derivação da cor é cacheada por régua+semente em
    // `resolve.ts` — a marca custa uma consulta a cada 30s e um lookup de Map
    // por render, não uma derivação de rampa por requisição.
    const marca = resolverMarcaDaOrganizacao(
      orgRow?.settings ?? null,
      await marcaDaInstalacao(),
      env,
    );

    // SÓ quando a cor veio mesmo da organização. Se ela não configurou nada, a
    // resolução devolve a cor da instalação — e reemiti-la aqui, escopada no
    // `<body>`, seria repetir no documento um bloco que já vale pela raiz. Além
    // de bytes, custaria a única pergunta que a presença do bloco responde.
    if (marca.origens.cor === "organizacao") {
      // Os `motivos` de uma cor recusada NÃO são registrados aqui de propósito:
      // este caminho roda para todo tenant a cada render, e um aviso por
      // organização no log da instalação é como um alarme deixa de ser lido. O
      // laço de retorno desta feature é a tela `/app/settings/marca`, que mostra
      // os motivos para quem pode consertá-los — o admin daquela organização.
      cssDaOrganizacao = cssDaMarca(marca.cor, ESCOPO_DA_ORGANIZACAO).css;
    }

    // Desce para o menu CAMPO A CAMPO, e só o campo que a organização definiu.
    // Sem a condição por campo, `marca.name` seria o nome da instalação (ou o
    // padrão do produto) e o menu passaria a ler um caminho novo para exibir
    // exatamente o que já exibia — trocando a fonte sem trocar o valor, que é
    // como se cria uma regressão invisível. E, com o logo no mesmo objeto, uma
    // condição só (a do nome) faria a organização que definiu apenas a cor
    // arrastar junto um `logoUrl` que ela não escolheu.
    //
    // `origens` é a resposta de `primeiroDefinido` (`lib/branding/resolve.ts`),
    // que ignora valor vazio e desce: quando ele diz "organizacao", o valor é
    // não-vazio e já veio trimado — por isso a barra lateral nunca recebe `""`
    // desta origem.
    //
    // `origens.logoUrl === "organizacao"` passou a ser ALCANÇÁVEL na onda do
    // upload: `camadaDaOrganizacao` declara o logo a partir de
    // `settings.branding.logo_path`. A condição foi escrita aqui uma onda ANTES
    // do produtor existir, de propósito — foi o que fez o upload por organização
    // ser só a camada, sem mais uma passada pela casca inteira.
    const marcaDoTenant = {
      ...(marca.origens.nome === "organizacao" ? { nome: marca.name } : {}),
      ...(marca.origens.logoUrl === "organizacao" && marca.logoUrl !== null
        ? { logoUrl: marca.logoUrl }
        : {}),
    };
    if (Object.keys(marcaDoTenant).length > 0) {
      activeOrg = { ...activeOrg, marca: marcaDoTenant };
    }
  } else {
    const [isEnrolled, mfaRequired] = await Promise.all([
      isMfaEnrolled(),
      requiresMfa(undefined, user.is_platform_admin, user.id, undefined),
    ]);
    enrolled = isEnrolled;
    needsMfaGate = mfaRequired;
  }

  // Read sidebar collapsed state SSR to avoid flash.
  const store = await cookies();
  const collapsed = store.get("sidebar_collapsed")?.value === "1";

  const impersonating = user.support ? {
    tenantId: user.support.organization_id, tenantName: user.support.name,
    expiresAt: user.support.expires_at, accessMode: user.support.access_mode,
  } : null;

  // O CONTRATO DE OCUPAÇÃO DO RODAPÉ (issue #1305) envolve a casca E as peças de
  // voz. O `VoiceCallProvider` desenha o painel de chamada DEPOIS dos children,
  // ou seja: o painel é IRMÃO do `AppShell`, não filho dele. Um provedor por
  // dentro do `VoiceCallProvider` deixaria o painel de fora — ele declararia o
  // que ocupa e ninguém descontaria, que é exatamente o defeito da #1305.
  const shell = (
    <ProvedorDaOcupacaoDoRodape>
      <VoiceCallProvider>
        <AppShell
          sidebarCollapsed={collapsed}
          podeAtender={Boolean(activeOrg && roleAtLeast(activeOrg.role, "agent"))}
        >
          {children}
        </AppShell>
      </VoiceCallProvider>
    </ProvedorDaOcupacaoDoRodape>
  );

  return (
    // O idioma envolve a árvore inteira e recebe o código PRONTO — ele não
    // pergunta quem está logado. Ver `lib/i18n/IdiomaProvider`: foi o
    // acoplamento com a autenticação que derrubou 32 casos.
    <IdiomaProvider locale={user.idioma}>
    <AuthProvider user={user} activeOrg={activeOrg}>
      {/*
        A COR DA ETIQUETA, uma leitura por tela.

        O chip aparece em LISTA — uma fila de duzentas conversas desenha quatro
        centenas deles — e todos consultam o mesmo mapa, montado uma vez aqui.
        Um `useQuery` por chip seria o mesmo cache (o react-query deduplica a
        rede), mas cada atualização acordaria todas as assinaturas.

        Dentro do `AuthProvider` porque a leitura é da organização ativa, e FORA
        do `AppShell` porque o gate de MFA substitui a casca: o mapa precisa
        sobreviver ao portão, e não ser relido quando ele sai.
      */}
      <ProvedorDeCoresDasEtiquetas>
      <InterfaceRefresh userId={user.id} org={activeOrg} support={!!user.support} />
      {/*
        O MARCADOR da marca da organização — o elemento cuja existência define o
        escopo `body:has([data-marca-org])` (lib/branding/css.ts).

        `contents` não gera caixa: no box tree os filhos continuam sendo filhos
        diretos do `<body>`, então nada de layout, `position` ou `flex` muda. O
        que este elemento existe para fazer é EXISTIR — e sumir junto com esta
        subárvore quando o logout navega para `/login`.

        Envolve TUDO, e não a div do `AppShell`, porque aquela div é irmã dos dois
        banners e é SUBSTITUÍDA quando o `MfaEnrollGate` bloqueia (ele renderiza
        um `fixed inset-0` no lugar dos children). O admin de tenant recém-criado
        veria a tela de cadastro de MFA — a PRIMEIRA tela dele — com a cor da
        instalação, e depois o resto do produto com a dele.
      */}
      <div data-marca-org="" className="contents">
        <EstiloDaMarcaDaOrganizacao css={cssDaOrganizacao} />
        <ImpersonateBanner impersonating={impersonating} />
        <ConexaoCaidaBanner caidas={conexoesCaidas} />
        {needsMfaGate ? (
          // Gate always mounted for MFA-required roles; it latches the blocking
          // decision client-side so the enroll Server Action's revalidation
          // can't tear down the recovery-codes screen mid-flow.
          <MfaEnrollGate enrolled={enrolled}>{shell}</MfaEnrollGate>
        ) : (
          shell
        )}
      </div>
      </ProvedorDeCoresDasEtiquetas>
    </AuthProvider>
    </IdiomaProvider>
  );
}
