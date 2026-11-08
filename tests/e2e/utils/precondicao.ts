/**
 * Precondições de identidade que uma spec E2E afirma ANTES de medir qualquer
 * coisa.
 *
 * ═══ O ESTADO ERRADO QUE ISTO VIGIA ═══
 *
 * `scripts/seed-e2e-system-update.ts` promovia `e2e-admin@deskcomm.test` — o
 * admin de tenant COMPARTILHADO por 10 specs — a `platform_admins`, e nenhum
 * seed revogava. As duas partes do job `e2e` compartilham banco SEM reset, então
 * a parte 2 inteira herdava um admin promovido. Medido em 2026-08-14, no banco
 * local: `e2e-admin` estava com `revoked_at is null`.
 *
 * ═══ O QUE A PROMOÇÃO MUDA, E O QUE NÃO MUDA (medido, 2026-08-14) ═══
 *
 * A versão forte desta frase — *"qualquer spec de admin de tenant passa a medir
 * o produto errado"* — é **falsa para este usuário**, e escrevê-la sem medir
 * seria trocar um defeito real por uma causa elegante:
 *
 *   - **NÃO muda a navegação.** `canSee` (`lib/navigation/registry.ts:503-507`)
 *     é `isPlatformAdmin || ROLE_RANK[role] >= ROLE_RANK[d.minRole ?? "viewer"]`.
 *     `ROLE_RANK.admin = 5` é o TETO (`lib/auth/types.ts:21-27`) e o maior
 *     `minRole` do registro é `"admin"` — logo os DESTINOS DO REGISTRO (sidebar,
 *     hub e ⌘K) de um admin de tenant são idênticos promovido ou não.
 *
 *     ⚠️ "destinos do registro" e não "a sidebar": o raciocínio de `canSee` só
 *     cobre o que passa por ele. A sidebar tem uma superfície que NÃO passa —
 *     ver o 5º item abaixo.
 *   - **NÃO muda os ~20 gates** `!user.is_platform_admin && ROLE_RANK[role] < X`
 *     de `app/app/**`: com rank 5, o segundo operando já é falso sozinho.
 *   - **MUDA as superfícies EXCLUSIVAS do dono:** `/app/settings/atualizacao`
 *     (`page.tsx:16` faz `notFound()` sem a flag, e a rota não está no registro
 *     de navegação — chega-se a ela por URL), `/admin/*`
 *     (`requirePlatformAdmin`), `app/actions/settings/updateBranding.ts`,
 *     `setActiveOrg` para uma org de que a pessoa não é membro, e — a que
 *     escapou da primeira enumeração — **o rodapé de versão da sidebar**
 *     (`components/shell/VersionFooter.tsx:22`, `is_owner && update_available`),
 *     que troca um `<p>` por um `<Link>` "Nova versão" e aparece em TODA tela de
 *     `/app/*`. Ele fica dentro do `<aside>` (`Sidebar.tsx:187`) mas FORA do
 *     `<nav>` (que fecha em `:168`), então nenhuma asserção escopada em
 *     `role=navigation` o vê — mas ele muda a ALTURA disponível para o `<nav>`,
 *     que é `flex-1`, e `navegacao.spec.ts` tem uma asserção geométrica
 *     (`m.rola`) sensível a isso. As duas metades do gatilho eram armadas pelo
 *     MESMO arquivo: `system-update.spec.ts` promovia o usuário E gravava
 *     `latest_version` no banco que ninguém reseta entre as partes do job.
 *
 * Conclusão honesta: hoje a contaminação é uma **mina**, não um falso-verde em
 * curso. Medido com
 * `grep -ln '"/admin\|/app/settings/atualizacao' tests/e2e/*.spec.ts` (que hoje
 * devolve 2 arquivos, porque o 2º hit é este próprio comentário — o comando
 * virou auto-poluído; confira o conteúdo, não a contagem): a ÚNICA
 * spec que abre superfície exclusiva do dono é `system-update.spec.ts` — e é
 * justamente a que passou a usar o `e2e-dono`. Nenhuma das 10 specs que usam o
 * admin compartilhado abre uma.
 *
 * O que a precondição impede é que a PRIMEIRA que abrir passe medindo o escape
 * (as specs novas do épico de marca abrem `/admin/marca`), e que uma asserção
 * acrescentada a um destes arquivos pegue carona sem ninguém notar.
 *
 * A causa foi removida na mesma onda (o dono agora é `e2e-dono`, dedicado). Esta
 * função é a SEGUNDA camada: a spec deixa de CONFIAR que ninguém promoveu o
 * usuário dela e passa a AFIRMAR isso, falhando alto e nomeando o conserto.
 *
 * Chame no `beforeAll`, antes de qualquer login ou medição.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../../scripts/lib/env-de-teste";

const CONSERTO = "pnpm exec tsx scripts/seed-e2e-system-update.ts";

let cliente: SupabaseClient | null = null;

function servico(): SupabaseClient {
  if (cliente) return cliente;
  const c = credenciaisSupabaseDeTeste();
  cliente = createClient(c.url, c.serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cliente;
}

/**
 * `auth.users` não é alcançável pelo PostgREST — a resolução email → id passa
 * pela Admin API, que só pagina. O teto de 5 páginas existe para o erro ser
 * "não achei o usuário" e não um laço infinito num banco grande.
 */
async function idPorEmail(email: string): Promise<string> {
  const svc = servico();
  for (let pagina = 1; pagina <= 5; pagina++) {
    const { data, error } = await svc.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (error) throw new Error(`precondição: listUsers falhou (${error.message})`);
    const achado = data.users.find((u) => u.email === email);
    if (achado) return achado.id;
    if (data.users.length < 200) break;
  }
  throw new Error(
    `precondição: usuário ${email} não existe neste banco. ` +
      `Rode: pnpm exec tsx scripts/seed-e2e-credentials.ts`,
  );
}

/**
 * Afirma que `email` é admin de TENANT e nada além disso — sem linha ativa em
 * `platform_admins`.
 *
 * Falha alto e nomeia o conserto. A mensagem diz o comando porque quem lê a
 * reprovação (às vezes meses depois, às vezes num fork) não tem como saber que
 * a cura é rodar o seed que revoga.
 */
export async function afirmarAdminDeTenantPuro(email: string): Promise<void> {
  const userId = await idPorEmail(email);
  const svc = servico();
  const { count, error } = await svc
    .from("platform_admins")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(`precondição: consulta a platform_admins falhou (${error.message})`);

  // `count` nulo é ambíguo (não veio contagem ≠ contagem zero): tratar como 0
  // deixaria a asserção passar sem ter medido nada. Falha fechada.
  if (count === null) {
    throw new Error(
      `precondição: platform_admins não devolveu contagem para ${email} — ` +
        `sem esse número a spec mediria a superfície errada sem saber.`,
    );
  }

  if (count !== 0) {
    throw new Error(
      `PRECONDIÇÃO VIOLADA: ${email} é dono do servidor (platform_admins, ${count} linha(s) ativa(s)).\n` +
        `Esta spec mede o produto de um ADMIN DE TENANT. Promovido, o usuário ganha as ` +
        `superfícies exclusivas do dono (/app/settings/atualizacao, /admin/*, updateBranding) ` +
        `e qualquer asserção que as toque passaria medindo o escape, não o papel.\n` +
        `Conserto: ${CONSERTO}`,
    );
  }
}

/**
 * Afirma que `email` É o dono do servidor — linha ATIVA em `platform_admins`.
 *
 * É o inverso de `afirmarAdminDeTenantPuro`, e existe pela mesma razão que ele:
 * as partes do job `e2e` compartilham banco SEM reset, e quem promove o
 * `e2e-dono` é `seed-e2e-system-update` — que o CI **não roda como passo**, só
 * é executado por quem precisa dele. Uma spec do painel de administração que
 * dependa de outra spec ter rodado antes mede a ordem de execução, não o
 * produto: passa numa parte e reprova noutra, sem nada ter mudado no código.
 *
 * PROMOVE quando falta, em vez de só reprovar. A diferença importa: reprovar
 * transferiria para quem lê a falha a tarefa de descobrir qual seed rodar — e
 * esta precondição é barata de satisfazer (uma linha), ao contrário da revogação,
 * que tem efeito colateral sobre 10 specs vizinhas e por isso continua sendo só
 * afirmada.
 */
export async function afirmarDonoDoServidor(email: string): Promise<void> {
  const userId = await idPorEmail(email);
  const svc = servico();
  const { count, error } = await svc
    .from("platform_admins")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(`precondição: consulta a platform_admins falhou (${error.message})`);

  // Mesma falha fechada da irmã: contagem nula é "não medi", nunca "é zero".
  if (count === null) {
    throw new Error(
      `precondição: platform_admins não devolveu contagem para ${email} — ` +
        `sem esse número a spec mediria a superfície errada sem saber.`,
    );
  }
  if (count > 0) return;

  // `granted_by` é NOT NULL — a tabela registra QUEM promoveu, e a primeira
  // versão desta função omitia a coluna. O CI reprovou com a mensagem do
  // Postgres inteira, que é o comportamento desejado: a precondição falhou alto
  // e nomeou a causa em vez de deixar a bateria medir a superfície errada.
  // Auto-concessão é o que `seed-e2e-system-update.ts:93-97` já faz — não há um
  // "quem promoveu" anterior num banco semeado do zero.
  const { error: erroInsert } = await svc.from("platform_admins").insert({
    user_id: userId,
    granted_by: userId,
    reason: "precondição e2e — dono do servidor para a bateria do painel da instalação",
  } as never);
  if (erroInsert) {
    throw new Error(
      `PRECONDIÇÃO NÃO SATISFEITA: ${email} não é dono do servidor e a promoção falhou ` +
        `(${erroInsert.message}). Esta spec mede o painel da INSTALAÇÃO, que só o dono ` +
        `alcança. Conserto manual: ${CONSERTO}`,
    );
  }
}

/**
 * `/app/agenda` bifurca no servidor: com `avaliacao` ativo na instalação a rota
 * monta a UI veicular; desligado, a agenda de compromissos. As specs da agenda
 * legada (`agenda-tela-do-produto` e irmãs) medem o segundo caso — e o banco do
 * CI não reseta entre arquivos, então uma instalação manual do módulo
 * contamina a partição inteira.
 */
export async function garantirAgendaDeCompromissosNoE2e(): Promise<void> {
  const svc = servico();
  const { data, error } = await svc
    .from("modulos_instalados")
    .select("estado")
    .eq("modulo", "avaliacao")
    .maybeSingle();
  if (error) {
    throw new Error(`precondição: leitura de modulos_instalados falhou (${error.message})`);
  }
  if (!data || data.estado !== "ativo") return;

  const { error: erroUpdate } = await svc
    .from("modulos_instalados")
    .update({
      estado: "suspenso",
      motivo_suspensao:
        "e2e: agenda de compromissos — módulo avaliacao suspenso para specs legadas compartilharem o banco",
    })
    .eq("modulo", "avaliacao");
  if (erroUpdate) {
    throw new Error(
      `precondição: não suspendeu o módulo avaliacao para a agenda legada (${erroUpdate.message})`,
    );
  }
}
