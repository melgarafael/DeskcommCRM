import { createHash, randomBytes } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

/** Normaliza o nome da empresa para um slug candidato (citext unique no DB). */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "org";
}

type ProvisionUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

/**
 * De onde veio o provisionamento. A organização nasce igual nos dois casos — o
 * que muda é a linha de auditoria, e ela precisa distinguir "primeiro acesso
 * normal" de "primeiro acesso que precisou ser recuperado": a segunda é um
 * sintoma de que o caminho do signup falhou, e some no meio da primeira.
 */
type ProvisionOptions = {
  source?: "signup" | "recovery";
};

/**
 * De qual organização esta pessoa é, se é de alguma — ou `null`.
 *
 * Existe separado de `ensureTenantForUser` porque há um caller que precisa
 * PERGUNTAR sem AGIR: a volta da entrada com Google (`app/auth/callback/route.ts`)
 * chega sem saber se aquilo é um primeiro acesso ou alguém voltando, e a
 * resposta muda tudo o que vem depois — travas de cadastro, convite,
 * provisionamento. Chamar `ensureTenantForUser` para descobrir seria agir antes
 * de decidir: quem entrasse sem convite numa instalação `so_convite` já teria
 * ganhado empresa antes de a política ser lida.
 *
 * Service role, como o resto do provisionamento: quem ainda não pertence a
 * organização nenhuma não enxerga `user_organizations` por RLS. O `user_id`
 * vem sempre do JWT já validado, nunca do corpo de uma requisição.
 */
export async function vinculoAtivo(userId: string): Promise<string | null> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  // Erro NÃO vira `null`, pela mesma razão escrita em `vinculoVivo`, ~300 linhas
  // abaixo: `null` já quer dizer "não pertence a organização nenhuma", e uma
  // leitura que falhou não é a mesma coisa que um vínculo que não existe. Lido
  // como equivalente, o soluço de leitura expulsa um membro de casa numa
  // instalação `so_convite` e, numa instalação aberta, entrega organização nova
  // a quem já tinha uma. Quem decide o que fazer com a falha é quem chama
  // (`app/auth/callback/route.ts` degrada para falha FECHADA); aqui ela sobe alto.
  if (error) {
    throw new Error(`provisioning: leitura do vínculo ativo falhou: ${error.message}`);
  }

  return data?.organization_id ?? null;
}

/**
 * Provisiona o tenant de um usuário recém-confirmado via signup self-service:
 * cria a organização (status `active`, `onboarded_at` null → cai no onboarding)
 * e a membership `admin` do usuário.
 *
 * Idempotente: se o usuário já tem membership ativa (link de confirmação
 * clicado duas vezes, ou usuário que entrou antes por convite), não faz nada.
 *
 * Service role é intencional aqui — o usuário ainda não pertence a nenhuma org,
 * então RLS bloquearia os INSERTs. A fonte confiável é o JWT já validado por
 * `verifyOtp` no caller (nunca o body).
 */
export async function ensureTenantForUser(
  user: ProvisionUser,
  options: ProvisionOptions = {},
): Promise<{ provisioned: boolean; organizationId?: string }> {
  const admin = createAdminClient();

  const organizationId = await vinculoAtivo(user.id);
  if (organizationId) return { provisioned: false, organizationId };

  const orgName =
    (user.user_metadata?.org_name as string | undefined)?.trim() ||
    user.email?.split("@")[0] ||
    "Minha empresa";
  const base = slugify(orgName);

  // ponytail: check-then-insert tem janela de corrida se o mesmo link for
  // confirmado 2x em paralelo (pior caso: org duplicada órfã). Advisory lock
  // por user_id se isso aparecer na prática.
  let org: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 3 && !org; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin
      .from("organizations")
      .insert({
        slug,
        display_name: orgName,
        legal_name: orgName,
        status: "active",
        created_by: user.id,
      })
      .select("id, slug")
      .single();
    if (data) {
      org = data;
    } else if (error && error.code !== "23505") {
      throw new Error(`signup provisioning: org insert failed: ${error.message}`);
    }
  }
  if (!org) throw new Error("signup provisioning: slug exhausted after 3 attempts");

  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: user.id,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError && memberError.code !== "23505") {
    throw new Error(`signup provisioning: membership insert failed: ${memberError.message}`);
  }

  void audit({
    action:
      options.source === "recovery" ? "tenant.created_by_recovery" : "tenant.created_by_signup",
    actorUserId: user.id,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    bypassedRls: true,
    metadata: { slug: org.slug },
  });

  return { provisioned: true, organizationId: org.id };
}

type ExternalProvisionInput = {
  /** Quem está provisionando (ex.: `clinicfx`). Entra no slug, no marcador e no escopo da chave. */
  integration: string;
  /** Id da empresa no sistema externo. É a chave de idempotência. */
  externalId: string;
  organizationName: string;
  ownerEmail: string;
  ownerName: string;
  /** O `X-Request-Id` da rota — é ele que liga esta linha de auditoria à resposta. */
  requestId?: string;
};

/**
 * O marcador que prova que a organização nasceu DESTE provisionamento.
 *
 * O slug é determinístico, mas slug é um espaço compartilhado com o cadastro
 * pela tela: uma organização criada à mão com o mesmo slug não é "replay" — é
 * outra empresa, e devolver uma chave dela seria entregar os dados de alguém a
 * um sistema de fora. Por isso o reencontro exige o marcador, e sem ele a
 * resposta é conflito.
 */
type MarcadorDeProvisionamento = { integration: string; external_id: string };

export class ProvisionConflictError extends Error {
  constructor() {
    super("provisioning_slug_conflict");
  }
}

/**
 * Slug determinístico por (integração, id externo). O id externo entra por
 * HASH e não por `slugify`: `slugify` corta em 32 caracteres e junta
 * pontuação, então dois ids diferentes podiam cair no mesmo slug e um virar
 * "replay" do outro.
 */
export function slugDoProvisionamento(integration: string, externalId: string): string {
  const hash = createHash("sha256").update(externalId).digest("hex").slice(0, 16);
  return `${integration}-${hash}`;
}

/**
 * Lê o marcador de onde ele estiver gravado — `organizations.settings` ou o
 * `app_metadata` da conta do dono. É o MESMO formato nos dois lugares de
 * propósito: são as duas provas de "nasceu deste provisionamento", e duas
 * formas seriam duas verdades para manter em dia.
 */
function marcadorDe(fonte: unknown): MarcadorDeProvisionamento | null {
  const m = (fonte as { provisioning?: unknown } | null)?.provisioning as
    | Partial<MarcadorDeProvisionamento>
    | undefined;
  return typeof m?.integration === "string" && typeof m?.external_id === "string"
    ? { integration: m.integration, external_id: m.external_id }
    : null;
}

/**
 * Provisiona uma organização a partir de um sistema externo, via
 * `POST /api/v1/tenants/provision` — rota que só existe quando o DONO DA
 * INSTALAÇÃO define `TENANT_PROVISIONING_SECRET` (decisão do dono, doc 38 b).
 *
 * Diferente de `ensureTenantForUser` (signup self-service) e do fluxo de
 * `POST /api/v1/admin/tenants` (que convida o dono por e-mail): aqui o dono é
 * criado JÁ ATIVO, com senha aleatória e sem convite — quem opera usa o
 * sistema de fora, que fala com esta organização pela chave de API. O usuário
 * existe para `user_organizations`/`api_tokens.created_by` e para dar a um
 * humano um caminho de acesso por "esqueci minha senha".
 *
 * Idempotente por (integração, id externo), inclusive sob corrida: `23505` no
 * insert é relido e conferido pelo marcador. E inclusive depois de uma falha
 * TRANSITÓRIA no meio: a conta do dono nasce antes da organização, então um
 * INSERT que morre por timeout do pooler deixa a conta sozinha — a repetição a
 * reaproveita pelo marcador em `app_metadata` (ver `ensureExternalOwnerUser`)
 * em vez de bater num 409 permanente.
 */
export async function provisionExternalTenant(
  input: ExternalProvisionInput,
): Promise<{ organizationId: string; ownerId: string; replay: boolean }> {
  const admin = createAdminClient();
  const slug = slugDoProvisionamento(input.integration, input.externalId);
  const email = input.ownerEmail.trim().toLowerCase();
  const marcador: MarcadorDeProvisionamento = {
    integration: input.integration,
    external_id: input.externalId,
  };

  /**
   * Reencontra o provisionamento anterior — e SÓ conclui por replay sobre um
   * estado completo, completando o que faltar.
   *
   * ⚠️ O "e completar" não é zelo: era a MESMA falha do 409 eterno, com o
   * desfecho pior. O INSERT do vínculo (logo abaixo) morrendo por timeout
   * deixava a organização criada e sem admin nenhum; na repetição, este
   * caminho achava a organização, devolvia `replay: true` e a rota respondia
   * **200 afirmando que estava tudo certo**. Existia uma empresa, ela
   * aparecia, e ninguém entrava nela — para sempre, porque o próprio caminho
   * de recuperação era o que carimbava sucesso sobre o estado incompleto. No
   * 409 pelo menos havia erro visível.
   */
  const reencontrarECompletar = async (): Promise<{
    organizationId: string;
    ownerId: string;
  } | null> => {
    // O erro do SELECT NÃO some: falha transitória do PostgREST lida como "não
    // existe" manda o fluxo para o INSERT e o operador recebe `org insert
    // failed` no lugar da causa real.
    const { data, error } = await admin
      .from("organizations")
      .select("id, created_by, settings")
      .eq("slug", slug)
      .maybeSingle();
    if (error) {
      throw new Error(`provisioning: busca da organização falhou: ${error.message}`);
    }
    if (!data) return null;
    const achado = marcadorDe(data.settings);
    if (achado?.integration !== marcador.integration || achado.external_id !== marcador.external_id) {
      throw new ProvisionConflictError();
    }
    const ownerId = data.created_by ?? (await findAdminMember(admin, data.id));
    if (!ownerId) {
      throw new Error(`provisioning: replay sem admin encontrado para org ${data.id}`);
    }
    await garantirAdminDaOrganizacao(admin, {
      organizationId: data.id,
      ownerId,
      slug,
      marcador,
      requestId: input.requestId,
    });
    return { organizationId: data.id, ownerId };
  };

  const existente = await reencontrarECompletar();
  if (existente) return { ...existente, replay: true };

  const ownerId = await ensureExternalOwnerUser(admin, email, input.ownerName, marcador);

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .insert({
      slug,
      display_name: input.organizationName,
      legal_name: input.organizationName,
      status: "active",
      created_by: ownerId,
      settings: { provisioning: marcador },
    })
    .select("id")
    .single();

  if (orgError) {
    if (orgError.code === "23505") {
      const corrida = await reencontrarECompletar();
      if (corrida) return { ...corrida, replay: true };
    }
    throw new Error(`provisioning: org insert failed: ${orgError.message}`);
  }

  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: ownerId,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError && memberError.code !== "23505") {
    throw new Error(`provisioning: membership insert failed: ${memberError.message}`);
  }

  // Ator NULO: quem criou foi um sistema de fora, com o segredo da instalação
  // (decisão do dono, doc 40, 19/09). O dono é dado da linha, não o autor da
  // ação — creditá-lo afirmaria que uma pessoa fez o que uma máquina fez.
  void audit({
    action: "tenant.created_by_provisioning",
    actorUserId: null,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    requestId: input.requestId,
    bypassedRls: true,
    metadata: {
      slug,
      integration: input.integration,
      external_id: input.externalId,
      owner_user_id: ownerId,
    },
  });

  return { organizationId: org.id, ownerId, replay: false };
}

/**
 * "Este vínculo está VIVO?" — a ÚNICA régua da pergunta, com ou sem
 * organização escolhida.
 *
 * Duas perguntas do provisionamento dependem dela: se a conta que o GoTrue
 * recusou é órfã (nenhum vínculo vivo com organização NENHUMA) e se o replay
 * está completo (vínculo vivo de admin com ESTA organização). Escrever o
 * predicado duas vezes é como as duas divergem — uma ganharia o filtro de
 * `revoked_at` que a outra perdeu, e o lado sem o filtro passaria a chamar de
 * vivo o que alguém revogou.
 *
 * Erro NÃO vira `null`: "não consegui ler" lido como "não há vínculo" faria a
 * órfã ser reaproveitada e o replay reinserir por cima de estado que ele não
 * enxergou.
 */
async function vinculoVivo(
  admin: ReturnType<typeof createAdminClient>,
  filtro: { userId: string; organizationId?: string },
): Promise<{ organizationId: string; role: string } | null> {
  let consulta = admin
    .from("user_organizations")
    .select("organization_id, role")
    .eq("user_id", filtro.userId)
    .is("revoked_at", null);
  if (filtro.organizationId) {
    consulta = consulta.eq("organization_id", filtro.organizationId);
  }
  const { data, error } = await consulta.limit(1).maybeSingle();
  if (error) {
    throw new Error(`provisioning: busca do vínculo do dono falhou: ${error.message}`);
  }
  return data ? { organizationId: data.organization_id, role: data.role } : null;
}

/**
 * Completa o vínculo de admin que uma tentativa anterior não chegou a gravar.
 *
 * ⚠️ NÃO RESSUSCITA ACESSO QUE UMA PESSOA TIROU, e isso é decisão, não
 * acidente do INSERT. `user_organizations` tem `unique (user_id,
 * organization_id)` (baseline.sql:2441), então, quando existe linha revogada
 * — ou quando um humano rebaixou o dono para `viewer` —, o INSERT volta
 * `23505` e não muda nada. É o desfecho desejado: um sistema de FORA
 * devolvendo acesso que o administrador da empresa removeu seria porta nova.
 * Por isso o `23505` sai daqui em silêncio (nada mudou, nada a auditar) em vez
 * de virar `update`.
 *
 * O caso que ele conserta é o outro: linha nenhuma, porque o INSERT original
 * morreu no meio.
 */
async function garantirAdminDaOrganizacao(
  admin: ReturnType<typeof createAdminClient>,
  p: {
    organizationId: string;
    ownerId: string;
    slug: string;
    marcador: MarcadorDeProvisionamento;
    requestId?: string;
  },
): Promise<void> {
  const vivo = await vinculoVivo(admin, {
    userId: p.ownerId,
    organizationId: p.organizationId,
  });
  if (vivo?.role === "admin") return;

  const { error } = await admin.from("user_organizations").insert({
    user_id: p.ownerId,
    organization_id: p.organizationId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") {
    throw new Error(`provisioning: completar o vínculo do dono falhou: ${error.message}`);
  }
  // Sobrou só `23505`: já havia linha (revogada, rebaixada, ou corrida com
  // outra chamada). Nada mudou — e o que não teve efeito não audita.
  if (error) return;

  // O conserto DEIXA RASTRO. Sem esta linha, a organização que nasceu de uma
  // tentativa partida não tem registro nenhum do que a completou: a
  // `tenant.created_by_provisioning` nunca saiu (a primeira tentativa morreu
  // antes dela) e o replay é mudo por natureza.
  void audit({
    action: "tenant.provisioning_completed",
    actorUserId: null,
    organizationId: p.organizationId,
    resourceType: "organization",
    resourceId: p.organizationId,
    requestId: p.requestId,
    bypassedRls: true,
    metadata: {
      slug: p.slug,
      integration: p.marcador.integration,
      external_id: p.marcador.external_id,
      owner_user_id: p.ownerId,
      completou: "user_organizations",
    },
  });
}

/**
 * O admin mais antigo da organização — e admin MESMO.
 *
 * Sem o filtro de papel, o nome prometia admin e a consulta devolvia o primeiro
 * vínculo qualquer, `viewer` inclusive: o replay emitiria a chave com
 * `created_by` de quem não administra nada.
 */
async function findAdminMember(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .is("revoked_at", null)
    .order("accepted_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`provisioning: busca do admin da organização falhou: ${error.message}`);
  }
  return data?.user_id ?? null;
}

/**
 * O e-mail já tem conta nesta instalação — decisão do dono (doc 40, item 8,
 * 19/09): recusar, e não reaproveitar.
 *
 * Reaproveitar fazia de uma pessoa que já usa a instalação admin de uma
 * empresa nova, com um aceite que ela nunca deu, e com o NOME dessa empresa
 * escolhido por um sistema de fora. Quem quer essa pessoa numa empresa a
 * convida pela tela da empresa, e ela aceita.
 *
 * A ÚNICA conta existente que não cai aqui é a que este mesmo provisionamento
 * criou e abandonou — marcador próprio em `app_metadata` e nenhum vínculo vivo.
 * Não é pessoa que usa a instalação: é lixo da tentativa anterior, e o critério
 * está no dado (ver `ensureExternalOwnerUser`).
 */
export class EmailJaTemContaError extends Error {
  constructor() {
    super("provisioning_email_ja_tem_conta");
  }
}

/**
 * Cria a pessoa dona — ou REAPROVEITA a conta que uma tentativa anterior DESTE
 * mesmo provisionamento deixou para trás.
 *
 * ⚠️ POR QUE O REAPROVEITAMENTO PRECISOU EXISTIR. A conta nasce ANTES da
 * organização, e as duas escritas não são uma transação: o INSERT da
 * organização falhando com qualquer coisa que não seja `23505` (timeout do
 * pooler, rede) devolvia 500 com a conta já criada e organização nenhuma. Na
 * repetição do parceiro — o caminho NORMAL depois de um 500 — `reencontrar()`
 * não achava nada, `createUser` batia em `email_exists`, e a resposta virava
 * 409 `owner_email_ja_tem_conta` PARA SEMPRE, mandando "convide a pessoa pela
 * tela da empresa" sobre uma empresa que não existe. Só saía com cirurgia no
 * banco — o oposto do que o cabeçalho de `provisionExternalTenant` promete.
 *
 * ⚠️ E POR QUE ELE NÃO AFROUXA A RECUSA DO ITEM 8. Reaproveitar exige as DUAS
 * provas, no dado e não na presunção:
 *
 *  1. a conta carrega o marcador DESTE par (integração, id externo) em
 *     `app_metadata` — e `app_metadata` é escrita SÓ por service role
 *     (`AdminUserAttributes`); o que a própria pessoa pode mudar pelo
 *     `updateUser` é `data` → `raw_user_meta_data` (`UserAttributes`, que não
 *     tem o campo). Gravar o marcador em `user_metadata` deixaria qualquer
 *     usuário logado forjar a própria elegibilidade;
 *  2. a conta não tem vínculo vivo com organização nenhuma — é órfã de
 *     verdade, não alguém que já usa a instalação.
 *
 * Conta de pessoa real não tem o marcador, e continua recusada com o mesmo
 * `EmailJaTemContaError`. Conta de OUTRO provisionamento tem marcador de outro
 * par, e também é recusada.
 */
async function ensureExternalOwnerUser(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
  fullName: string,
  marcador: MarcadorDeProvisionamento,
): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: randomBytes(24).toString("base64url"),
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: { provisioning: marcador },
  });
  if (data?.user) return data.user.id;
  // `email_exists` é o código do GoTrue atual; versões anteriores só diziam
  // 422 com "already been registered" na mensagem.
  const jaExiste =
    error?.code === "email_exists" ||
    (error?.status === 422 && /already (been )?registered/i.test(error.message));
  if (jaExiste) {
    const orfa = await donoOrfaoDesteProvisionamento(admin, email, marcador);
    if (orfa) return orfa;
    throw new EmailJaTemContaError();
  }
  throw new Error(`provisioning: criar dono falhou: ${error?.message ?? "sem usuário"}`);
}

/** Contas por página na varredura do diretório. O servidor pode reduzir. */
const CONTAS_POR_PAGINA = 200;
/**
 * Teto de páginas. Sem achar a conta dentro dele, a recusa do item 8 vale (é o
 * comportamento de antes deste conserto) — nunca o reaproveitamento.
 */
const PAGINAS_DO_DIRETORIO = 50;

/**
 * A conta que ESTE provisionamento deixou órfã, ou `null` quando não há uma.
 *
 * Varre o diretório paginado porque `listUsers` NÃO filtra por e-mail
 * (`@supabase/auth-js` 2.116.0 tipa só `page`/`perPage`; o repo já paga esse
 * preço em `app/api/v1/admin/users/route.ts` e em `useRecoveryCode`). O custo
 * fica no galho RARO: só roda quando o GoTrue já disse que o e-mail existe, e
 * nunca no caminho feliz.
 *
 * A varredura para na página vazia, e não usa `nextPage`: o auth-js o deriva do
 * header Link com `.substring(0, 1)`, então da página 10 em diante ele lê "1" e
 * a varredura andaria para trás.
 *
 * Erro do GoTrue ou do Postgres NÃO vira "não é órfã": seria trocar "não
 * consegui verificar" por uma recusa terminal de 409. Falha alto — o parceiro
 * recebe 500 e a repetição ainda tem conserto.
 */
async function donoOrfaoDesteProvisionamento(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
  marcador: MarcadorDeProvisionamento,
): Promise<string | null> {
  let conta: { id: string; app_metadata: unknown } | null = null;

  for (let pagina = 1; pagina <= PAGINAS_DO_DIRETORIO && !conta; pagina++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page: pagina,
      perPage: CONTAS_POR_PAGINA,
    });
    if (error) {
      throw new Error(`provisioning: busca da conta do dono falhou: ${error.message}`);
    }
    if (data.users.length === 0) break;
    const achada = data.users.find((u) => u.email?.toLowerCase() === email);
    if (achada) conta = { id: achada.id, app_metadata: achada.app_metadata };
  }

  if (!conta) return null;

  const dela = marcadorDe(conta.app_metadata);
  if (dela?.integration !== marcador.integration || dela.external_id !== marcador.external_id) {
    return null;
  }

  // MESMA régua que o replay usa para decidir se está completo (`vinculoVivo`):
  // a pergunta "este vínculo está vivo?" tem um dono só no arquivo.
  const vinculo = await vinculoVivo(admin, { userId: conta.id });
  return vinculo ? null : conta.id;
}
