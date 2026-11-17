/**
 * SERVER ACTION NÃO CRIA ACESSO PERMANENTE DURANTE O ACOMPANHAMENTO.
 *
 * Convite, token de API, vínculo e papel sobrevivem ao fim da sessão de
 * acompanhamento. A regra é UMA (`permanentAccessError`, em
 * `lib/impersonate/support.ts`) e vale para toda sessão, inclusive `full`.
 * Server Action não tem caminho de rota, então a recusa tem de estar na
 * própria action — ou num contexto que ela chama e que comprovadamente aplica
 * a regra (`requireOnboardingCtx`).
 *
 * Duas partes:
 *   1. COMPORTAMENTO — `sendOnboardingInvites` com acompanhamento ativo é
 *      recusada antes de emitir o convite; sem acompanhamento, emite (controle).
 *   2. CERCA — varre `app/actions/**` e reprova a função que grava em tabela de
 *      credencial, ou chama um emissor de convite, sem passar pela regra.
 *
 * NÃO MEDE: escrita feita por um helper de `lib/` que não esteja na lista de
 * emissores abaixo, nem `.from(<variável>)` — a cerca só reconhece nome de
 * tabela literal. Rotas de `app/api/v1` têm a própria cerca
 * (`suporte-cobertura-de-efeitos.test.ts`).
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";
import {
  PERMANENT_ACCESS_MESSAGE,
  permanentAccessError,
  type SupportContext,
} from "@/lib/impersonate/support";

const ORG = "f3300000-0000-4000-8000-000000000001";
const SUPORTE: SupportContext = {
  id: "f3300000-0000-4000-8000-000000000002",
  organization_id: ORG,
  actor_user_id: "f3300000-0000-4000-8000-000000000003",
  auth_session_id: "f3300000-0000-4000-8000-000000000004",
  previous_organization_id: null,
  expires_at: "2099-01-01T00:00:00Z",
  name: "Empresa",
  locale: null,
  access_mode: "full",
  status: "active",
};

const estado = vi.hoisted(() => ({ support: null as unknown, emitidos: 0 }));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT:${destino}`);
  },
}));
vi.mock("@/lib/auth/cache-curto", () => ({ invalidarOrg: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { onboarding_state: {}, onboarded_at: null }, error: null }) }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: SUPORTE.actor_user_id,
    email: "dono@exemplo.invalid",
    full_name: "Dono",
    organizations: [],
    support: estado.support,
  }),
  resolveActiveOrg: async () => ({ orgId: ORG, name: "Empresa", role: "admin" }),
}));
vi.mock("@/lib/team/convites", () => ({
  emitirConvite: async () => {
    estado.emitidos += 1;
    return { email_dispatched: true, accept_url: "https://exemplo.invalid/aceite" };
  },
}));
vi.mock("@/lib/auth/issue-invite", () => ({
  issueInvite: async () => {
    estado.emitidos += 1;
    return { email_dispatched: true, accept_url: "https://exemplo.invalid/aceite" };
  },
}));

const CONVITE = { invitations: [{ email: "novo@exemplo.invalid", role: "admin" as const }] };

describe("a regra", () => {
  it("recusa toda sessão de acompanhamento, de qualquer modo e estado, e só ela", () => {
    expect(permanentAccessError(null)).toBeNull();
    expect(permanentAccessError(undefined)).toBeNull();
    expect(permanentAccessError(SUPORTE)).toBe(PERMANENT_ACCESS_MESSAGE);
    expect(permanentAccessError({ ...SUPORTE, access_mode: "support_readonly" })).toBe(PERMANENT_ACCESS_MESSAGE);
    expect(permanentAccessError({ ...SUPORTE, status: "expired" })).toBe(PERMANENT_ACCESS_MESSAGE);
  });
});

describe("convite pela action do onboarding", () => {
  beforeEach(() => {
    estado.emitidos = 0;
  });

  it("acompanhamento ativo com acesso total: recusa antes de emitir", async () => {
    estado.support = SUPORTE;
    const { sendOnboardingInvites } = await import("@/app/actions/onboarding/sendOnboardingInvites");
    expect(await sendOnboardingInvites(CONVITE)).toEqual({ ok: false, error: "forbidden" });
    expect(estado.emitidos).toBe(0);
  });

  it("a recusa carrega a mensagem única da regra", async () => {
    estado.support = SUPORTE;
    const { requireOnboardingCtx } = await import("@/app/actions/onboarding/_shared");
    await expect(requireOnboardingCtx()).rejects.toThrow(PERMANENT_ACCESS_MESSAGE);
  });

  it("controle: sem acompanhamento, o convite é emitido", async () => {
    estado.support = null;
    const { sendOnboardingInvites } = await import("@/app/actions/onboarding/sendOnboardingInvites");
    await expect(sendOnboardingInvites(CONVITE)).rejects.toThrow("REDIRECT:/onboarding");
    expect(estado.emitidos).toBe(1);
  });
});

// ─── A cerca ────────────────────────────────────────────────────────────────

/** Tabela de credencial → escritas que CRIAM ou AMPLIAM acesso. Revogar (update
 * de `revoked_at` em convite/token) reduz acesso e fica de fora. */
const ESCRITAS_DE_CREDENCIAL: Record<string, readonly string[]> = {
  team_invites: ["insert", "upsert"],
  api_tokens: ["insert", "upsert"],
  user_organizations: ["insert", "upsert", "update"], // update = troca de papel
  platform_admins: ["insert", "upsert"],
  contato_mcp_credenciais: ["insert", "upsert"],
};
/** Helpers de `lib/` que emitem ou aplicam convite. */
const EMISSORES = new Set(["emitirConvite", "reenviarConvite", "issueInvite", "aplicarConvite"]);
/** A regra, e os contextos que comprovadamente a aplicam (conferidos abaixo). */
const REGRA = "permanentAccessError";
const CONTEXTOS_QUE_APLICAM_A_REGRA: Record<string, string> = {
  requireOnboardingCtx: "app/actions/onboarding/_shared.ts",
};
const GUARDAS = new Set([REGRA, ...Object.keys(CONTEXTOS_QUE_APLICAM_A_REGRA)]);

function nomeChamado(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** `x.from("tabela").insert(...)` → "tabela.insert"; o resto → null. */
function escritaDeCredencial(call: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const escrita = call.expression.name.text;
  const origem = call.expression.expression;
  if (!ts.isCallExpression(origem) || nomeChamado(origem) !== "from") return null;
  const tabela = origem.arguments[0];
  if (!tabela || !ts.isStringLiteralLike(tabela)) return null;
  return ESCRITAS_DE_CREDENCIAL[tabela.text]?.includes(escrita) ? `${tabela.text}.${escrita}` : null;
}

function chamadas(no: ts.Node): ts.CallExpression[] {
  const achadas: ts.CallExpression[] = [];
  const visitar = (n: ts.Node) => {
    if (ts.isCallExpression(n)) achadas.push(n);
    ts.forEachChild(n, visitar);
  };
  visitar(no);
  return achadas;
}

/** Por declaração de topo: efeitos de credencial que ela faz sem chamar a regra. */
function semGuarda(caminho: string, fonte: string): string[] {
  const sf = ts.createSourceFile(caminho, fonte, ts.ScriptTarget.Latest, true);
  const achados: string[] = [];
  for (const stmt of sf.statements) {
    const calls = chamadas(stmt);
    if (calls.some((c) => GUARDAS.has(nomeChamado(c) ?? ""))) continue;
    for (const c of calls) {
      const nome = nomeChamado(c);
      const efeito = escritaDeCredencial(c) ?? (nome && EMISSORES.has(nome) ? `${nome}()` : null);
      if (efeito) achados.push(`${caminho}:${sf.getLineAndCharacterOfPosition(c.getStart()).line + 1} ${efeito}`);
    }
  }
  return achados;
}

const ACOES = arquivosDeCodigo(["app/actions"]).map((abs) => ({
  caminho: caminhoRelativo(abs),
  fonte: readFileSync(abs, "utf8"),
}));

describe("cerca: action que cria acesso permanente passa pela regra", () => {
  it("controle positivo: a varredura enxerga as actions que emitem convite", () => {
    const comEfeito = ACOES.filter(({ caminho, fonte }) => {
      const sf = ts.createSourceFile(caminho, fonte, ts.ScriptTarget.Latest, true);
      return chamadas(sf).some((c) => escritaDeCredencial(c) || EMISSORES.has(nomeChamado(c) ?? ""));
    }).map((a) => a.caminho);
    expect(comEfeito).toEqual(
      expect.arrayContaining([
        "app/actions/onboarding/sendOnboardingInvites.ts",
        "app/actions/team/acceptInvite.ts",
      ]),
    );
  });

  it("reprova uma action falsa sem a regra, e aceita a mesma com ela", () => {
    const falsa = `"use server";
export async function plantar() {
  const admin = createAdminClient();
  await admin
    .from("api_tokens")
    .insert({ organization_id: "x" });
  await admin.from("user_organizations").update({ role: "admin" }).eq("user_id", "y");
  await emitirConvite(admin, {});
}
export async function revogar() {
  await createAdminClient().from("api_tokens").update({ revoked_at: "agora" });
}`;
    expect(semGuarda("app/actions/falsa.ts", falsa)).toEqual([
      "app/actions/falsa.ts:4 api_tokens.insert",
      "app/actions/falsa.ts:7 user_organizations.update",
      "app/actions/falsa.ts:8 emitirConvite()",
    ]);
    const guardada = falsa.replace(
      "const admin = createAdminClient();",
      "if (permanentAccessError((await loadAuthUser())?.support)) return;\n  const admin = createAdminClient();",
    );
    expect(semGuarda("app/actions/falsa.ts", guardada)).toEqual([]);
  });

  it("o contexto aceito como guarda aplica a regra de fato", () => {
    for (const [funcao, caminho] of Object.entries(CONTEXTOS_QUE_APLICAM_A_REGRA)) {
      const sf = ts.createSourceFile(caminho, readFileSync(caminho, "utf8"), ts.ScriptTarget.Latest, true);
      const decl = sf.statements.find(
        (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === funcao,
      );
      expect(decl, `${funcao} não está mais em ${caminho}`).toBeDefined();
      expect(
        chamadas(decl!).some((c) => nomeChamado(c) === REGRA),
        `${funcao} deixou de chamar ${REGRA}(): as actions que confiam nele ficaram sem guarda`,
      ).toBe(true);
    }
  });

  it("nenhuma action grava credencial ou emite convite sem a regra", () => {
    const achados = ACOES.flatMap(({ caminho, fonte }) => semGuarda(caminho, fonte));
    expect(
      achados,
      [
        "Server Action criando acesso permanente sem permanentAccessError():",
        ...achados.map((a) => `  - ${a}`),
        "Chame permanentAccessError(user.support) (lib/impersonate/support.ts) antes do efeito,",
        "na mesma função, e recuse quando ela devolver mensagem.",
      ].join("\n"),
    ).toEqual([]);
  });
});
