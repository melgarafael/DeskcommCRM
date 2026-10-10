"use server";

import { headers } from "next/headers";

import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { invalidarMarcaDaInstalacao } from "@/lib/branding/instalacao";
import { normalizarHex } from "@/lib/branding/rampa";
import { platformBrandingSchema, type PlatformBrandingInput } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdateBrandingResult =
  | { ok: true }
  | { ok: false; error: string; details?: unknown };

/**
 * Troca a marca da INSTALAÇÃO — nome, logo, cor e o selo — sem SSH e sem
 * reiniciar a stack.
 *
 * ── Por que o gate é `is_platform_admin`, e não `admin` do tenant ─────────────
 *
 * Esta é a marca que pinta o LOGIN, o e-mail de recuperação e a tela de erro —
 * superfícies anteriores a qualquer organização. Num revendedor que hospeda
 * várias empresas, deixar o admin de um tenant repintar o login de todos seria
 * dar a um cliente o controle da fachada dos outros. `updateTenant.ts` usa
 * `admin` do tenant porque o que ele edita é a organização de quem chama; aqui o
 * objeto é a instalação inteira, então o papel é o transversal.
 *
 * A marca POR organização (a que o admin de tenant edita) é outra coisa, mora em
 * `organizations.settings.branding`, e é a fase seguinte.
 *
 * ── Por que a escrita vai pelo admin client ─────────────────────────────────
 *
 * Mesma razão do bloco de 20 linhas em `updateTenant.ts`, levada ao limite:
 * `platform_branding` tem RLS LIGADA e ZERO POLICIES, e os privilégios de `anon`
 * e `authenticated` foram REVOGADOS na migration 0155. Pelo client de sessão
 * nada acontece — nem leitura. É deliberado: a tabela é server-side only, e o
 * `service_role` (que é `bypassrls`) é o único caminho.
 *
 * O gate continua sendo o de cima, resolvido de fonte confiável (o JWT validado
 * no backend), NUNCA do body. E não há `organization_id` a filtrar porque a
 * tabela não é tenant-aware — o filtro equivalente é `id = 1`, que a constraint
 * `platform_branding_singleton` torna o único valor possível.
 *
 * ── Por que `requirePlatformAdminEscrita()` e não `loadAuthUser()` + a flag ─────────
 *
 * Server Action NÃO é rota: não passa por `requireRole` (cujo `mfaEmDivida` tem
 * um call site só, `lib/auth/require-role.ts`, que serve apenas `/api/v1`) e não
 * passa pelo layout de `/admin` — e não existe `middleware.ts` neste repo para
 * cobrir a diferença. Um POST direto na action, com uma sessão `aal1` de um
 * platform admin, entrava: `is_platform_admin` responde "esta pessoa TEM o
 * papel", que é política de CADASTRO, não de SESSÃO. E, ao contrário da marca
 * por organização, aqui o banco NÃO tem como fechar o buraco — a escrita vai
 * pelo `service_role`, e o Postgres não enxerga o AAL de uma sessão do GoTrue.
 *
 * `requirePlatformAdminEscrita()` já checa as três coisas (JWT, linha ativa em
 * `platform_admins`, e `aal2` quando `mfa_required`) e é o MESMO gate do layout
 * de `/admin` — então, para quem chega pela tela, nada muda: essa pessoa já
 * passou por ele para ver o formulário. O que muda é o caminho que não passa
 * pela tela. Quem não é platform admin é redirecionado, e o formulário não
 * embrulha a chamada em `try/catch`, então o `NEXT_REDIRECT` sobe para o runtime
 * como deve. Só-leitura e MFA pendente voltam como `{ ok: false, error }` pelo
 * `escritaDeAdminOuRecusa()`, para a tela dizer o motivo em vez de cair no
 * error boundary.
 *
 * ── Por que NÃO emite `event_log` ───────────────────────────────────────────
 *
 * `lib/event-log/register-handlers.ts` registra 12 handlers e nenhum cobriria um
 * tipo `platform_branding.*`. O drain deixa evento sem handler INTOCADO, então a
 * linha nasceria `pending` para sempre em todo clone — evento sem consumer é o
 * anti-pattern nº 3 do CLAUDE.md. O registro desta mutação é o `audit()` abaixo,
 * que tem consumidor real (`/admin/audit`).
 */
export async function updateBranding(
  input: PlatformBrandingInput,
): Promise<UpdateBrandingResult> {
  const parsed = platformBrandingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user: authUser } = escrita.ctx;

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const valores = {
    app_name: parsed.data.app_name,
    logo_url: parsed.data.logo_url,
    // Normaliza porque o CHECK do banco é `^#[0-9a-f]{6}$`: `#FFF` e `#FFFFFF`
    // passam pelo Zod (o validador do domínio aceita as duas formas) e só um dos
    // dois passa pelo banco. Normalizar aqui é o que faz "mudou?" ser uma
    // pergunta com resposta — duas grafias da mesma cor mentiriam.
    accent_hex: parsed.data.accent_hex === null ? null : normalizarHex(parsed.data.accent_hex),
    // Mesma normalização e MESMO CHECK da irmã (#2482): `#FFF` passa pelo
    // domínio e não passa pelo banco, e normalizar aqui é o que faz "mudou?"
    // ser uma pergunta com resposta.
    accent_dark_hex:
      parsed.data.accent_dark_hex === null ? null : normalizarHex(parsed.data.accent_dark_hex),
    show_powered_by: parsed.data.show_powered_by,
    // A linha passa a ser HUMANA. É o que impede a semeadura do `.env` de
    // reescrever a escolha no render seguinte — inclusive quando a escolha foi
    // apagar tudo para voltar ao padrão do produto. Ver `precisaSemear`.
    seeded_from_env: false,
    updated_by: authUser.id,
    // Uma configuração nova apaga o alarme da anterior. Se a cor gravada agora
    // também for recusada, `EstiloDaMarca` reacende no primeiro render — o que
    // não pode acontecer é o operador corrigir o valor e continuar vendo a
    // recusa de ontem.
    fallback_at: null,
    fallback_reason: null,
  };

  const { error } = await createAdminClient()
    .from("platform_branding")
    // `upsert` e não `update`: numa instalação com o `.env` sem marca nenhuma a
    // linha ainda não existe (a semeadura só corre quando há o que promover), e
    // um `update` casaria zero linhas devolvendo sucesso — a tela diria "salvo"
    // e nada seria gravado. É o mesmo modo de falha que a issue #144 mediu em
    // `organizations`, e a única defesa é não escrever a query que o permite.
    .upsert({ id: 1, ...valores }, { onConflict: "id" });
  if (error) return { ok: false, error: error.message };

  // No MESMO processo que renderiza (na VPS há um processo de app só), então a
  // troca aparece no próximo render sem esperar o TTL.
  invalidarMarcaDaInstalacao();

  await audit({
    action: "platform_branding.updated",
    actorUserId: authUser.id,
    // Sem `organizationId`: a marca da instalação não pertence a tenant nenhum.
    // Carimbar a organização ativa de quem chamou faria a auditoria sugerir que
    // a mudança foi daquele cliente, quando ela afeta todos.
    resourceType: "platform_branding",
    // `null`, e NÃO `"1"`. `api_audit_log.resource_id` é `uuid`: a chave natural
    // do singleton faria o INSERT do audit estourar com 22P02 — e como audit é
    // fire-and-forget por doutrina, a marca seria gravada, a tela diria "salvo"
    // e a trilha ficaria sem a linha, sem sintoma em tela nenhuma. Pego por
    // `tests/unit/audit-resource-id-e-uuid.test.ts` antes de sair daqui; o
    // docstring dele registra que esta classe já reincidiu três vezes.
    //
    // Nada se perde: a tabela tem UMA linha, então `resourceType` já a
    // identifica por completo — o `id` não carregava informação nenhuma.
    resourceId: null,
    requestId,
    ip,
    userAgent,
    actingAsPlatformAdmin: true,
    metadata: {
      // Quais campos foram DECLARADOS, nunca os valores. O hex da marca é
      // identidade, e a auditoria é lida por quem opera a plataforma — mesma
      // disciplina de `resolve.ts` ("emite FORMA, nunca IDENTIDADE").
      fields_changed: Object.keys(parsed.data),
      accent_definido: parsed.data.accent_hex !== null,
      logo_definido: parsed.data.logo_url !== null,
    },
  });

  return { ok: true };
}
