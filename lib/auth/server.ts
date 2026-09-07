import { lerInterface } from "@/lib/navigation/interface";
/**
 * Server-side auth helpers — load AuthUser, resolve active org, gate routes.
 *
 * Uses the service-role admin client to read tenant-scoped tables
 * (`user_organizations`, `platform_admins`, `organizations`) — RLS bypass is
 * intentional here because we resolve the user from the validated JWT first
 * and then filter by `user_id` (a trusted source).
 */
import { readSupportContext } from "@/lib/impersonate/support";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { empresaExigeMfa, exigeCadastroDeMfa } from "@/lib/auth/politica-mfa";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import type { AuthUser, Role, UserOrgMembership, ActiveOrg } from "./types";

const ACTIVE_ORG_COOKIE = "active_org";

interface RawMembershipRow {
  interface_settings?: unknown;
  organization_id: string;
  role: string;
  /** Só para ORDENAR — a lista decide qual organização fica ativa sem cookie. */
  accepted_at?: string | null;
  organizations: OrgJoin | OrgJoin[] | null;
}

interface OrgJoin {
  display_name: string;
  locale: string | null;
}

/**
 * O idioma padrão da organização ativa — `null` se não há organização.
 */
async function localeDaOrgAtiva(memberships: UserOrgMembership[]): Promise<string | null> {
  if (memberships.length === 0) return null;
  const store = await cookies();
  return escolherMembroAtivo(memberships, store.get(ACTIVE_ORG_COOKIE)?.value)?.locale ?? null;
}

/**
 * Qual organização está ativa, dado o cookie.
 *
 * Extraída porque DUAS coisas precisam da mesma resposta e não podem divergir:
 * `resolveActiveOrg`, que decide o escopo dos dados, e a resolução do idioma
 * dentro de `loadAuthUser`. Se cada uma escolhesse por conta, dava para ver os
 * dados de uma empresa com a interface no idioma de outra.
 *
 * ⚠️ O `memberships[0]` do fim só é uma ESCOLHA porque quem monta `memberships`
 * ordena a consulta (`accepted_at`, depois `organization_id`). Sem aquele
 * `ORDER BY`, isto aqui é um sorteio — e desde que o idioma passou a vir junto
 * da organização ativa, o sorteio decide TAMBÉM em que língua o sistema abre.
 * As duas coisas andam juntas: não tire a ordenação de lá sem resolver isto.
 */
function escolherMembroAtivo(
  memberships: UserOrgMembership[],
  cookieOrg: string | undefined,
): UserOrgMembership | null {
  if (memberships.length === 0) return null;
  if (cookieOrg) {
    const achado = memberships.find((o) => o.organization_id === cookieOrg);
    if (achado) return achado;
  }
  return memberships[0] ?? null;
}

/**
 * Loads the AuthUser for the current request. Returns null if unauthenticated.
 * Use only in Server Components / Route Handlers / Server Actions.
 *
 * Uses the user-scoped server client (cookie session). RLS policies allow:
 * - user_organizations: user_id = auth.uid() (user_orgs_select)
 * - organizations: id IN fn_user_org_ids()  (orgs_select)
 * - platform_admins: only platform admins read (so non-admins get null — correct)
 */
/**
 * "Não havia sessão nenhuma" — o estado NORMAL, não um incidente.
 *
 * `getUser()` não devolve `error: null` para quem não está logado. Sem cookie de
 * sessão, `GoTrueClient._getUser` corta antes de falar com o GoTrue e devolve
 * `{ data: { user: null }, error: new AuthSessionMissingError() }` (status 400).
 * Medido em `@supabase/auth-js` 2.112.1, com um cookie store vazio:
 *
 *     user  = null
 *     error = AuthSessionMissingError: Auth session missing! (status=400)
 *
 * Isso importa porque **não há `middleware.ts` neste projeto**: o gate de
 * `/app/*` é o próprio `app/app/layout.tsx`, que chama `loadAuthUser()` e só
 * então redireciona. Ou seja, todo visitante deslogado — e todo crawler — passa
 * por aqui sem sessão. Logar esse caso como erro reintroduziria, do lado do log,
 * exatamente a ambiguidade que o bloco acima existe para desfazer: o estado
 * normal e a falha transitória voltariam a ser a mesma linha, agora afogadas em
 * volume de tráfego anônimo.
 *
 * Compara por `name` e não por `instanceof`: há DUAS cópias de `@supabase/auth-js`
 * na árvore (2.111.0 e 2.112.1 em `node_modules/.pnpm`), e `instanceof` só acerta
 * quando o erro vem da mesma cópia que o teste importou.
 */
export function ehSessaoAusente(error: { name?: string } | null | undefined): boolean {
  return error?.name === "AuthSessionMissingError";
}

export async function loadAuthUser(): Promise<AuthUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  // ⚠️ O `error` era DESCARTADO — nem chegava a ser desestruturado —, e aqui
  // `user: null` é tão ambíguo quanto o `data: null` que a query logo abaixo
  // trata com todo o cuidado: significa "não está logado" (estado normal) E
  // "não deu para perguntar" (rede, GoTrue fora do ar, token ilegível).
  //
  // A ação não muda, e isso é deliberado: sem usuário confirmado, devolver
  // `null` — e portanto redirecionar para o login — é o desfecho seguro.
  // Falhar FECHADO na ação continua certo. O que estava errado era falhar
  // fechado também na INFORMAÇÃO: quem investigasse depois via só uma pessoa
  // "deslogada", sem nada distinguindo isso de uma falha transitória.
  //
  // Custou caro uma vez: um vermelho de e2e em que a barra lateral "perdeu o
  // logo" foi, por eliminação, uma casca de app que não era a casca do app —
  // e a hipótese nº 1 é justamente um redirect nascido aqui. Com este log, a
  // próxima ocorrência se explica sozinha em vez de custar uma investigação.
  //
  // ⚠️ MAS NEM TODO `error` AQUI É INCIDENTE — e é por isso que `ehSessaoAusente`
  // existe. Ver o comentário dela: sem esse filtro, este log dispara em todo
  // visitante deslogado e refaz, do lado do log, a mesma fusão que este bloco
  // existe para desfazer.
  if (error && !ehSessaoAusente(error)) {
    // As chaves são as MESMAS do outro `logger.error` desta função (linha ~134):
    // `code` e `message`. Dois nomes para o mesmo conceito, dentro da mesma
    // função, obrigariam quem consulta o agregador a escrever duas buscas — num
    // conserto cujo objeto é diagnóstico.
    //
    // `name` viaja junto porque é o que separa as CLASSES: `AuthRetryableFetchError`
    // (rede, GoTrue fora do ar) de `AuthApiError` (token ilegível). Ambas podem
    // chegar com o mesmo `status`, e a mensagem vem em inglês do upstream — sem o
    // nome, distinguir as duas viraria regex sobre texto que muda entre versões.
    logger.error("[auth] getUser falhou — tratando como não autenticado", {
      name: error.name,
      code: error.code ?? null,
      status: error.status ?? null,
      message: error.message,
    });
  }
  if (!user) return null;

  // Platform admin? (active = no revoked_at). RLS returns null for non-admins.
  //
  // ⚠️ O erro é capturado de propósito: aqui `data: null` é AMBÍGUO — significa tanto
  // "não é platform admin" (RLS filtrou, estado normal) quanto "a query falhou".
  // Sem separar os dois, um banco instável rebaixa silenciosamente um super-admin.
  const { data: paRow, error: paErro } = await supabase
    .from("platform_admins")
    .select("user_id, revoked_at")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();

  // Org memberships (only active = not revoked, accepted)
  // ⚠️ `ORDER BY` NÃO É ENFEITE AQUI: esta lista decide QUAL ORGANIZAÇÃO FICA
  // ATIVA para quem não tem o cookie `active_org` — `resolveActiveOrg` pega
  // `organizations[0]`. Sem ordenação, "a primeira" é o que o Postgres devolver,
  // e isso não é estável por especificação: muda com plano de execução, com a
  // ordem física das linhas e com qualquer reescrita delas.
  //
  // O efeito para quem administra DUAS empresas na mesma instalação: entrar sem
  // cookie (primeiro acesso, sessão nova, cookie expirado) podia cair numa ou na
  // outra sem critério nenhum — e o produto não dava sinal de que escolheu.
  //
  // `accepted_at` primeiro porque a organização mais ANTIGA é a que a pessoa
  // reconhece como "a minha"; `organization_id` como desempate, para o resultado
  // ser determinístico mesmo quando as duas entraram no mesmo instante (é o caso
  // de quem foi convidado para várias no mesmo lote).
  const { data: rawMemberships, error: membErro } = await supabase
    .from("user_organizations")
    .select(
      "organization_id, role, interface_settings, accepted_at, organizations(display_name, locale)",
    )
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .order("accepted_at", { ascending: true, nullsFirst: true })
    .order("organization_id", { ascending: true });

  /**
   * FALHA ALTO, não baixo.
   *
   * Antes, o erro destas duas queries era descartado e `rawMemberships` nulo virava
   * `[]` — ou seja, "usuário sem organização". O resultado é que uma instabilidade do
   * banco chega ao operador como **"você não pertence a nenhuma organização"**: as
   * telas de admin somem, as rotas devolvem 403, e nada indica que a causa é
   * infraestrutura.
   *
   * Medido em 2026-07-30: com o PostgREST devolvendo `name resolution failed` depois
   * de um restart do Docker, TODOS os cards de admin sumiram do hub de configurações.
   * Custou seis diagnósticos errados — build velho, processo velho, cache, filtro de
   * papel — antes de alguém olhar a causa real.
   *
   * Degradar permissão em silêncio é o pior desfecho possível num caminho de auth:
   * parece uma decisão de autorização e é um defeito de infra. Melhor estourar e
   * mostrar erro do que renderizar uma UI mentirosa.
   */
  if (paErro || membErro) {
    const detalhe = (paErro ?? membErro)!;
    logger.error("[auth] não foi possível resolver permissões do usuário", {
      user_id: user.id,
      onde: paErro ? "platform_admins" : "user_organizations",
      code: detalhe.code,
      message: detalhe.message,
    });
    throw new Error(
      `auth_permissions_unavailable: ${detalhe.message} — permissões não puderam ser ` +
        `resolvidas; a sessão NÃO foi rebaixada por decisão de autorização.`,
    );
  }

  const rows = (rawMemberships ?? []) as RawMembershipRow[];
  const memberships: UserOrgMembership[] = rows.map((row) => {
    const orgs = row.organizations;
    const org = Array.isArray(orgs) ? (orgs[0] ?? null) : orgs;
    return {
      organization_id: row.organization_id,
      organization_name: org?.display_name ?? "—",
      role: row.role as Role,
      interface_settings: lerInterface(row.interface_settings).settings,
      locale: org?.locale ?? null,
    };
  });

  const support = await readSupportContext(supabase);
  const fullName = (user.user_metadata?.full_name as string | undefined) ?? null;
  const avatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null;
  const locale = (user.user_metadata?.locale as string | undefined) ?? null;
  // A cadeia inteira num lugar só: pessoa → organização ativa → padrão. Quem
  // consome pede `idioma` e não precisa saber que existe uma ordem.
  //
  // O cookie só é lido quando a resposta DEPENDE dele: quem já tem preferência
  // própria, e quem não pertence a organização nenhuma, não têm o que resolver.
  // Ler assim mesmo faria toda tela do produto tocar o cookie para descartar o
  // valor em seguida.
  const idioma = normalizarIdioma(
    locale ?? support?.locale ?? (await localeDaOrgAtiva(memberships)),
  );
  const timezone = (user.user_metadata?.timezone as string | undefined) ?? null;

  return {
    id: user.id,
    email: user.email ?? "",
    full_name: fullName,
    avatar_url: avatarUrl,
    is_platform_admin: !!paRow,
    locale,
    idioma,
    timezone,
    organizations: memberships,
    support,
  };
}

/**
 * Resolves the active organization for the current request.
 * Priority: cookie `active_org` (if member of) → first membership.
 * Returns null if user has zero memberships.
 */
export async function resolveActiveOrg(authUser: AuthUser): Promise<ActiveOrg | null> {
  if (authUser.support) {
    if (authUser.support.status !== "active") redirect("/support-ended");
    return {
      orgId: authUser.support.organization_id,
      name: authUser.support.name,
      role: authUser.support.access_mode === "full" ? "admin" : "viewer",
    };
  }
  const store = await cookies();
  const ativo = escolherMembroAtivo(authUser.organizations, store.get(ACTIVE_ORG_COOKIE)?.value);
  if (!ativo) return null;
  return {
    orgId: ativo.organization_id,
    name: ativo.organization_name,
    role: ativo.role,
    interface_settings: ativo.interface_settings,
  };
}

/**
 * For Server Components / Server Actions in /app/(app)/* routes — guarantees
 * an authenticated user. Redirects to /login if not.
 */
export async function requireAuth(): Promise<AuthUser> {
  const user = await loadAuthUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Returns true if the current session has at least one verified TOTP factor.
 * Use only in Server Components / Server Actions (cookie session).
 */
export async function isMfaEnrolled(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.auth.mfa.listFactors();
  return !!data?.totp?.some((f) => f.status === "verified");
}

/**
 * Quem é OBRIGADO a cadastrar a verificação em duas etapas.
 *
 * ⚠️ ISTO DEIXOU DE SER UMA CONSTANTE. A regra era
 * `isPlatformAdmin || role === "admin"` — sem opção —, e como o `install.sh`
 * cria o dono da instalação como platform admin, TODA instalação self-host
 * forçava TOTP antes de a pessoa usar o produto. Medido percorrendo o wizard: o
 * botão "Começar a usar" entregava o dono num bloqueador de tela cheia, um
 * sétimo passo que a barra de progresso nunca anunciou.
 *
 * Agora a resposta vem da POLÍTICA — `platform_admins.mfa_required` para o
 * platform admin, `organizations.settings.security.mfa_required` para o admin do
 * tenant —, e o padrão de ambos é não exigir. A regra pura, com o porquê de cada
 * ramo, vive em `lib/auth/politica-mfa.ts`.
 *
 * Carrega as duas leituras porque o layout precisa delas de qualquer forma; quem
 * já tem a política em mãos deve chamar `exigeCadastroDeMfa` direto.
 */
export async function requiresMfa(
  role: Role | undefined,
  isPlatformAdmin: boolean,
  userId?: string,
  orgId?: string,
): Promise<boolean> {
  const admin = createAdminClient();

  let plataformaExige: boolean | null = null;
  if (isPlatformAdmin && userId) {
    const { data } = await admin
      .from("platform_admins")
      .select("mfa_required")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .maybeSingle();
    plataformaExige = (data?.mfa_required as boolean | undefined) ?? null;
  }

  let empresaExige = false;
  if (orgId) {
    const { data } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", orgId)
      .maybeSingle();
    empresaExige = empresaExigeMfa(data?.settings);
  }

  return exigeCadastroDeMfa({ role, isPlatformAdmin, plataformaExige, empresaExige });
}

/**
 * Nível de garantia da SESSÃO atual: `aal2` = o segundo fator foi provado nesta
 * sessão; `aal1` = só a senha.
 *
 * Isto responde uma pergunta diferente de `isMfaEnrolled()`, e a diferença é o
 * achado que motivou este helper: "tem fator cadastrado" é política de
 * CADASTRO; "provou o fator agora" é política de SESSÃO. O produto só tinha a
 * primeira, então uma sessão `aal1` de um admin com TOTP cadastrado era
 * plenamente funcional — o cenário exato que a MFA existe para conter (senha
 * vazada/phishing).
 */
export async function sessionAal(): Promise<"aal1" | "aal2" | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  // O tipo do SDK é `"aal1" | "aal2" | (string & {})` — aberto de propósito, para
  // aceitar níveis futuros. Estreitar aqui mantém a decisão em quem chama.
  const nivel: string | null | undefined = data?.currentLevel;
  return nivel === "aal1" || nivel === "aal2" ? nivel : null;
}

/**
 * A sessão está em dívida com a MFA? Verdadeiro só quando as TRÊS valem:
 * o papel exige MFA, o usuário JÁ cadastrou um fator, e a sessão é `aal1`.
 *
 * A condição do meio não é detalhe: sem ela, o admin que ainda não cadastrou
 * ficaria trancado do lado de fora — inclusive das rotas necessárias para
 * cadastrar. Quem ainda não tem fator continua sendo tratado pelo gate de
 * cadastro do `app/app/layout.tsx`.
 */
export async function mfaEmDivida(): Promise<boolean> {
  // ⚠️ NÃO PERGUNTA MAIS A POLÍTICA, e a mudança é o que impede o cadastro
  // opcional de virar um buraco: começava por `requiresMfa(...)`, então, com a
  // exigência desligada, quem ativasse a verificação POR VONTADE PRÓPRIA teria o
  // fator ignorado na sessão — o mesmo que não ter.
  //
  // Cadastrar e provar são perguntas diferentes. Quem TEM fator prova, sempre.
  if (!(await isMfaEnrolled())) return false;
  return (await sessionAal()) !== "aal2";
}
