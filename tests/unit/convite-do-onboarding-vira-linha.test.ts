/**
 * O CONVITE DO ONBOARDING VIRA LINHA EM `team_invites` — E APARECE NA ABA MEMBROS.
 *
 * ─── O DEFEITO (#4055) ───────────────────────────────────────────────────────
 * Passo 6 do onboarding ("Quem trabalha com ele") → convidar
 * `atendente@exemplo.invalid` → a tela mostra o link `/team/accept-invite/…`
 * (certo: a instalação não envia e-mail) e, ao concluir, a aba **Membros** diz
 * "Nenhum convite enviado". O convite não existia para a tela de Equipe.
 *
 * A hipótese dupla da issue — escrita ou leitura — é resolvida aqui:
 *   - ESCRITA: `sendOnboardingInvites` assinava o token e mandava o e-mail, mas
 *     nunca gravava em `team_invites`. Nenhum INSERT acontecia.
 *   - LEITURA: `GET /api/v1/team/invites` filtra só por `organization_id` e
 *     deriva o status; não há filtro escondendo convite pendente.
 * Logo o defeito é de ESCRITA, e o conserto é a action usar o caminho canônico
 * (`emitirConvite`, o mesmo de `/app/team/invite`).
 *
 * ─── O QUE ESTE ARQUIVO MEDE ────────────────────────────────────────────────
 * Um dublê do PostgREST que modela `team_invites` como TABELA de verdade
 * (INSERT/UPDATE/SELECT com filtros, e o índice único parcial
 * `team_invites_um_pendente_por_email_idx` recusando dois pendentes para o mesmo
 * e-mail). A action roda com o token REAL (`lib/auth/invite-token.ts`), então o
 * `invite_id` do link é conferido contra o `id` da linha — é isso que faz
 * revogar e aceitar funcionarem depois.
 *
 * Os sete lados opostos da issue, em ordem: (a) convite pela aba Membros
 * (rota canônica) continua gravando; (b) o mesmo e-mail duas vezes RENOVA a
 * linha, sem duplicar; (c) revogar o convite do onboarding funciona; (d) aceitar
 * cria o membro (o token não é órfão); (e) outra organização não vê o convite;
 * (f) onboarding pulado não grava nada; (g) e-mail inválido continua recusado.
 *
 * ─── O QUE ESTE ARQUIVO NÃO MEDE ────────────────────────────────────────────
 * RLS de verdade (o dublê não tem policies): `tests/invariants/
 * convites-de-time-rls.test.ts` prova o isolamento por organização no Postgres.
 * E2E/browser: fica no CI (`tests/e2e/invite-lifecycle.spec.ts`).
 *
 * Comando: npx vitest run tests/unit/convite-do-onboarding-vira-linha.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";
const EMAIL = "atendente@exemplo.invalid";

type Linha = Record<string, unknown>;

/**
 * O banco de mentira. `estado` é `vi.hoisted` porque as fábricas de `vi.mock`
 * rodam antes do corpo deste módulo — a mesma razão pela qual as fábricas abaixo
 * não leem as consts ORG/EMAIL (TDZ); elas leem `estado`, já disponível.
 */
const estado = vi.hoisted(() => ({
  team_invites: [] as Linha[],
  organizations: [] as Linha[],
  inserts: 0,
  emailOk: false,
  serviceRole: true,
  orgDoOnboarding: { orgId: "", name: "Empresa do Onboarding", role: "admin" },
  orgDaLeitura: { orgId: "", name: "Empresa do Onboarding", role: "admin" },
  rpcs: [] as string[],
}));

const USUARIO_DO_DUBLÊ = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "dono@qa.local",
  full_name: "Dona",
  organizations: [],
  support: null,
  idioma: "pt-BR",
};

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({
  audit: async () => undefined,
  isServiceRoleConfigured: () => estado.serviceRole,
}));
vi.mock("@/lib/branding/saida", () => ({
  // `estruturaDeEmail` (a casca do e-mail) lê os neutros DESTE módulo; sem eles
  // o envio estoura e o caso "com e-mail configurado" mediria o dublê, não a
  // action.
  NEUTROS_DE_SAIDA: { texto: "#111111", suave: "#666666", fundo: "#f5f5f5", linha: "#dddddd" },
  marcaDaSaida: async () => ({
    nome: "Marca",
    logoUrl: null,
    accent: "#506d48",
    accentFg: "#ffffff",
    origens: { nome: "padrao", cor: "padrao" },
  }),
}));
vi.mock("@/lib/email/roteador", () => ({
  sendEmail: async () =>
    estado.emailOk ? { ok: true, via: "smtp" } : { ok: false, error: "not_configured" },
}));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: () => false }));
vi.mock("@/lib/auth/cache-curto", () => ({
  invalidarOrg: () => undefined,
  invalidarUsuario: () => undefined,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteFalso() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => USUARIO_DO_DUBLÊ,
  resolveActiveOrg: async () => estado.orgDoOnboarding,
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: USUARIO_DO_DUBLÊ, org: estado.orgDaLeitura }),
}));

interface Consulta {
  table: string;
  op: "select" | "insert" | "update" | "delete" | null;
  filtros: Array<[string, unknown]>;
  payload: Linha | null;
}

/**
 * Dublê do client supabase-js no formato do PostgREST: encadeável e thenable.
 * `insert` respeita o índice único PARCIAL de pendentes da migration 0238 — sem
 * isso, "sem duplicata" passaria sem medir nada.
 */
function clienteFalso() {
  const abrir = (table: string) => {
    const q: Consulta = { table, op: null, filtros: [], payload: null };
    const linhasDa = (): Linha[] => {
      if (table === "team_invites") return estado.team_invites;
      if (table === "organizations") return estado.organizations;
      return [];
    };
    const casa = (l: Linha) => q.filtros.every(([coluna, valor]) => l[coluna] === valor);

    const executar = (): { data: unknown; error: unknown } => {
      const linhas = linhasDa();
      if (q.op === "insert") {
        estado.inserts += 1;
        if (table === "team_invites") {
          const novo = q.payload as Linha;
          const pendenteIgual = linhas.some(
            (l) =>
              l.organization_id === novo.organization_id &&
              String(l.email).toLowerCase() === String(novo.email).toLowerCase() &&
              l.accepted_at == null &&
              l.revoked_at == null,
          );
          if (pendenteIgual) {
            throw new Error(
              'duplicate key value violates unique constraint "team_invites_um_pendente_por_email_idx"',
            );
          }
          const agora = new Date().toISOString();
          const linha: Linha = {
            created_at: agora,
            last_sent_at: agora,
            resend_count: 0,
            email_dispatched: false,
            accepted_at: null,
            accepted_by: null,
            revoked_at: null,
            revoked_by: null,
            ...novo,
          };
          linhas.push(linha);
          return { data: [linha], error: null };
        }
        const linha = { ...(q.payload as Linha) };
        linhas.push(linha);
        return { data: [linha], error: null };
      }
      if (q.op === "update") {
        const alvo = linhas.filter(casa);
        for (const l of alvo) Object.assign(l, q.payload);
        return { data: alvo, error: null };
      }
      if (q.op === "delete") {
        const alvo = linhas.filter(casa);
        for (const l of alvo) {
          const i = linhas.indexOf(l);
          if (i >= 0) linhas.splice(i, 1);
        }
        return { data: alvo, error: null };
      }
      return { data: linhas.filter(casa), error: null };
    };

    const b: Record<string, unknown> = {
      select: () => {
        if (q.op === null) q.op = "select";
        return b;
      },
      insert: (payload: Linha) => {
        q.op = "insert";
        q.payload = payload;
        return b;
      },
      update: (payload: Linha) => {
        q.op = "update";
        q.payload = payload;
        return b;
      },
      delete: () => {
        q.op = "delete";
        return b;
      },
      eq: (coluna: string, valor: unknown) => {
        q.filtros.push([coluna, valor]);
        return b;
      },
      is: (coluna: string, valor: unknown) => {
        q.filtros.push([coluna, valor]);
        return b;
      },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        const r = executar();
        return { data: (r.data as Linha[])[0] ?? null, error: r.error };
      },
      single: async () => {
        const r = executar();
        return { data: (r.data as Linha[])[0] ?? null, error: r.error };
      },
      then: (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
        Promise.resolve(executar()).then(ok, no),
    };
    return b;
  };

  return {
    from: abrir,
    rpc: async (nome: string) => {
      estado.rpcs.push(nome);
      if (nome === "fn_accept_team_invite") {
        return { data: { id: "membership-1", changed: true }, error: null };
      }
      // `fn_limite_do_plano` → null = sem limite de assentos nesta instalação.
      return { data: null, error: null };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({ data: { user: { email: `${id}@membro.test` } } }),
      },
    },
  } as never;
}

import { sendOnboardingInvites } from "@/app/actions/onboarding/sendOnboardingInvites";
import { GET as listarConvites } from "@/app/api/v1/team/invites/route";
import { POST as revogarConvite } from "@/app/api/v1/team/invites/[id]/revoke/route";
import { POST as convidarPelaAbaMembros } from "@/app/api/v1/team/invite/route";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { verifyInviteToken } from "@/lib/auth/invite-token";

/** O `redirect` terminal do sucesso é sinal, não falha: engole só ele. */
async function convidarNoOnboarding(payload: {
  invitations: { email: string; role: "viewer" | "agent" | "manager" | "admin" }[];
  skip?: boolean;
}) {
  try {
    return await sendOnboardingInvites(payload);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("REDIRECT:")) return undefined;
    throw err;
  }
}

/** Lê a aba Membros como o manager/admin da org ativa. */
async function abaMembros(): Promise<
  Array<{ id: string; email: string; role: string; status: string; accept_url: string | null }>
> {
  const res = await listarConvites(new NextRequest("http://localhost/api/v1/team/invites"));
  const body = (await res.json()) as { data: never[] };
  return body.data;
}

function tokenDoLink(acceptUrl: string): string {
  return acceptUrl.split("/team/accept-invite/")[1] ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.team_invites = [];
  estado.organizations = [{ id: ORG, onboarding_state: {}, onboarded_at: null }];
  estado.inserts = 0;
  estado.emailOk = false;
  estado.serviceRole = true;
  estado.orgDoOnboarding = { orgId: ORG, name: "Empresa do Onboarding", role: "admin" };
  estado.orgDaLeitura = { orgId: ORG, name: "Empresa do Onboarding", role: "admin" };
  estado.rpcs = [];
});

describe("convite do onboarding vira linha em team_invites", () => {
  it("⭐ convite do passo 6 grava a linha e aparece na aba Membros (o defeito da #4055)", async () => {
    // Instalação sem e-mail: é o caso da issue (v1.101.0 em VPS sem SMTP).
    const r = await convidarNoOnboarding({ invitations: [{ email: EMAIL, role: "agent" }] });

    expect(r).toEqual({
      ok: true,
      sent: 0,
      failed: 1,
      undelivered: [{ email: EMAIL, accept_url: expect.stringContaining("/team/accept-invite/") }],
    });

    // Sem o conserto, `estado.team_invites` fica VAZIO aqui — o RED literal.
    expect(estado.team_invites).toHaveLength(1);
    const linha = estado.team_invites[0]!;
    expect(linha).toMatchObject({
      organization_id: ORG,
      email: EMAIL,
      role: "agent",
      invited_by: USER,
      email_dispatched: false,
    });
    expect(Date.parse(String(linha.expires_at))).toBeGreaterThan(Date.now());

    // O link copiado na tela carrega o `id` DA LINHA — é o que torna revogar e
    // aceitar possíveis depois (token não é órfão).
    const payload = verifyInviteToken(
      tokenDoLink((r?.ok ? r.undelivered?.[0]?.accept_url : "") ?? ""),
    );
    expect(payload).not.toBeNull();
    expect(payload?.invite_id).toBe(linha.id);
    expect(payload?.email).toBe(EMAIL);
    expect(payload?.organization_id).toBe(ORG);
    expect(payload?.role).toBe("agent");

    // A aba Membros (leitura) mostra o convite pendente com link copiável.
    const membros = await abaMembros();
    expect(membros).toHaveLength(1);
    expect(membros[0]).toMatchObject({ id: linha.id, email: EMAIL, role: "agent", status: "pendente" });
    expect(membros[0]?.accept_url).toContain("/team/accept-invite/");
  });

  it("com e-mail configurado o convite sai e a linha nasce como enviada", async () => {
    estado.emailOk = true;

    await convidarNoOnboarding({ invitations: [{ email: EMAIL, role: "manager" }] });

    expect(estado.team_invites).toHaveLength(1);
    expect(estado.team_invites[0]).toMatchObject({
      email: EMAIL,
      role: "manager",
      email_dispatched: true,
    });
    const membros = await abaMembros();
    expect(membros[0]?.status).toBe("pendente");
  });
});

describe("lado oposto (a) — o convite pela aba Membros continua igual", () => {
  it("POST /api/v1/team/invite grava a linha pelo mesmo caminho canônico", async () => {
    const res = await convidarPelaAbaMembros(
      new NextRequest("http://localhost/api/v1/team/invite", {
        method: "POST",
        body: JSON.stringify({ invitations: [{ email: EMAIL, role: "agent" }] }),
      }),
    );

    expect(res.status).toBe(201);
    expect(estado.team_invites).toHaveLength(1);
    expect(estado.team_invites[0]).toMatchObject({ email: EMAIL, role: "agent", invited_by: USER });
    expect((await abaMembros())[0]?.email).toBe(EMAIL);
  });
});

describe("lado oposto (b) — o mesmo e-mail duas vezes não duplica", () => {
  it("o segundo convite RENOVA a linha pendente (mesmo id, resend_count 1)", async () => {
    await convidarNoOnboarding({ invitations: [{ email: EMAIL, role: "agent" }] });
    const primeiro = { ...estado.team_invites[0]! };

    await convidarNoOnboarding({ invitations: [{ email: EMAIL, role: "agent" }] });

    // O dublê recusa INSERT duplicado (índice único parcial): se a action
    // tentasse inserir de novo, este teste estouraria em vez de passar.
    expect(estado.team_invites).toHaveLength(1);
    expect(estado.team_invites[0]?.id).toBe(primeiro.id);
    expect(estado.team_invites[0]?.resend_count).toBe(1);
    expect(estado.inserts).toBe(1);
  });
});

describe("lado oposto (c) — revogar funciona para o convite do onboarding", () => {
  it("o admin revoga e o link deixa de valer", async () => {
    const r = await convidarNoOnboarding({ invitations: [{ email: EMAIL, role: "agent" }] });
    const link = r?.ok ? (r.undelivered?.[0]?.accept_url ?? "") : "";
    const payload = verifyInviteToken(tokenDoLink(link));
    const linha = estado.team_invites[0]!;

    const res = await revogarConvite(
      new NextRequest(`http://localhost/api/v1/team/invites/${String(linha.id)}/revoke`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(linha.id) }) },
    );

    expect(res.status).toBe(200);
    expect(estado.team_invites[0]?.revoked_at).not.toBeNull();

    // Revogado = o aceite recusa, apesar do token assinado e no prazo.
    if (!payload) throw new Error("o link do onboarding não decodificou");
    expect(await aplicarConvite({ userId: USER, payload })).toEqual({
      ok: false,
      motivo: "invalid_or_expired",
    });
    expect(estado.rpcs).not.toContain("fn_accept_team_invite");
  });
});

describe("lado oposto (d) — aceitar o convite do onboarding cria o membro", () => {
  it("o token do onboarding casa com a linha e fecha o convite como aceito", async () => {
    const r = await convidarNoOnboarding({ invitations: [{ email: EMAIL, role: "agent" }] });
    const payload = verifyInviteToken(
      tokenDoLink((r?.ok ? r.undelivered?.[0]?.accept_url : "") ?? ""),
    );
    if (!payload) throw new Error("o link do onboarding não decodificou");

    expect(await aplicarConvite({ userId: USER, payload })).toEqual({
      ok: true,
      membershipId: "membership-1",
      mudou: true,
    });

    expect(estado.rpcs).toContain("fn_accept_team_invite");
    expect(estado.team_invites[0]?.accepted_at).not.toBeNull();
    expect(estado.team_invites[0]?.accepted_by).toBe(USER);
    // Aceito sai da lista de pendentes da aba Membros (status derivado).
    expect((await abaMembros())[0]?.status).toBe("aceito");
  });
});

describe("lado oposto (e) — outra organização não vê o convite", () => {
  it("manager da org B lê zero convites da org A", async () => {
    await convidarNoOnboarding({ invitations: [{ email: EMAIL, role: "agent" }] });
    estado.orgDaLeitura = { orgId: OUTRA_ORG, name: "Outra Empresa", role: "manager" };

    expect(await abaMembros()).toEqual([]);
  });
});

describe("lado oposto (f) — onboarding pulado não grava nada", () => {
  it("pular o passo 6 não cria linha nem insere", async () => {
    await convidarNoOnboarding({ invitations: [], skip: true });

    expect(estado.team_invites).toEqual([]);
    expect(estado.inserts).toBe(0);
  });
});

describe("lado oposto (g) — e-mail inválido continua recusado", () => {
  it("endereço sem domínio volta invalid_input e não grava", async () => {
    const r = await convidarNoOnboarding({
      invitations: [{ email: "atendente@", role: "agent" }],
    });

    expect(r?.ok).toBe(false);
    expect(r && !r.ok && r.error).toBe("invalid_input");
    expect(estado.team_invites).toEqual([]);
    expect(estado.inserts).toBe(0);
  });
});

describe("sem service-role — degrada para só-token, como a rota canônica", () => {
  it("o link continua valendo e a aba Membros fica vazia (nada a listar)", async () => {
    estado.serviceRole = false;

    const r = await convidarNoOnboarding({ invitations: [{ email: EMAIL, role: "agent" }] });

    expect(r?.ok).toBe(true);
    expect(r?.ok && r.undelivered?.[0]?.accept_url).toContain("/team/accept-invite/");
    expect(estado.team_invites).toEqual([]);
  });
});
