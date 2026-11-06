/**
 * O caso parado volta a pedir passagem — e para de pedir na hora certa.
 *
 * QUEM venceu é decidido no banco (`fn_casos_parados_para_lembrar`, migration
 * 0766), e o que a conta faz com a cadência e o relógio por espera é medido no
 * Postgres real em `tests/invariants/lembrete-de-caso-parado.test.ts`. Aqui
 * fica o que a ROTA faz com cada linha vencida: o aviso, os dois contadores e o
 * teto que vem da organização.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const hAtras = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

interface Capturado {
  rpc: Array<{ nome: string; args: unknown }>;
  avisos: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

function admin(casos: Array<Record<string, unknown>>, jaTemAviso: boolean, cap: Capturado) {
  return {
    rpc: async (nome: string, args: unknown) => {
      cap.rpc.push({ nome, args });
      return { data: casos, error: null };
    },
    from(tabela: string) {
      if (tabela === "agent_cases") {
        return {
          update: (patch: Record<string, unknown>) => {
            cap.updates.push(patch);
            const c: Record<string, unknown> = { eq: () => c, then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) };
            return c;
          },
        };
      }
      if (tabela === "passagens_de_atendimento") {
        // O SEGUNDO BRAÇO desta rota (onda 11) varre as passagens que ninguém
        // assumiu. Este dublê o deixa varrer NADA de propósito: o que os casos
        // abaixo medem é o braço dos CASOS, e uma fixture de passagens aqui
        // misturaria as duas contagens na mesma asserção. Quem mede o segundo
        // braço é `tests/unit/cobrador-de-passagem-nao-reconhecida.test.ts`,
        // que tem um caso próprio para "o braço dos CASOS continua de pé".
        const c: Record<string, unknown> = {
          select: () => c,
          is: () => c,
          lt: () => c,
          order: () => c,
          limit: async () => ({ data: [], error: null }),
          update: () => c,
          eq: () => c,
          then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
        };
        return c;
      }
      // agent_inbox_items
      return {
        select: () => {
          const c: Record<string, unknown> = {
            eq: () => c,
            order: () => c,
            limit: () => c,
            maybeSingle: async () => ({ data: jaTemAviso ? { id: "aviso-1" } : null }),
          };
          return c;
        },
        insert: async (linha: Record<string, unknown>) => {
          cap.avisos.push(linha);
          return { error: null };
        },
        update: (patch: Record<string, unknown>) => {
          cap.updates.push(patch);
          const c: Record<string, unknown> = {
            eq: () => c,
            then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
          };
          return c;
        },
      };
    },
  };
}

const vazio = (): Capturado => ({ rpc: [], avisos: [], updates: [] });

/** Uma linha como `fn_casos_parados_para_lembrar` a devolve. */
const vencido = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  organization_id: ORG,
  title: "x",
  opened_at: hAtras(50),
  followup_attempts: 0,
  cobrancas_na_espera: 0,
  teto: 3,
  ...over,
});
const req = () => new NextRequest("http://localhost/x", { headers: { authorization: "Bearer segredo" } });

beforeEach(() => vi.clearAllMocks());

describe("case-stale-watcher", () => {
  it("abre o aviso apontando para o caso, com o kind e a referência certos", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [vencido({ title: "Liberar acesso" })],
        false,
        cap,
      ) as never,
    );

    const { POST } = await import("./route");
    const body = (await (await POST(req())).json()) as { data: Record<string, number> };

    expect(body.data).toMatchObject({ examinados: 1, avisados: 1 });
    expect(cap.avisos[0]).toMatchObject({
      organization_id: ORG,
      kind: "case_stale",
      severity: "warn",
      ref_kind: "agent_case",
      ref_id: "c1",
    });
    // O título fala de quem espera, não da idade de uma linha.
    expect(String(cap.avisos[0]!.title)).toContain("espera decisão");
  });

  it("quem venceu vem da função do banco, com o limite da rodada", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(admin([], false, cap) as never);

    const { POST } = await import("./route");
    await POST(req());

    // A conta cruza o caso com a cadência da organização; um filtro montado
    // aqui não a alcança, e um `limit` sem ela esconderia os vencidos.
    expect(cap.rpc).toEqual([{ nome: "fn_casos_parados_para_lembrar", args: { p_limite: 200 } }]);
  });

  it("não abre um segundo aviso enquanto o primeiro está aberto", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [vencido({ followup_attempts: 1, cobrancas_na_espera: 1 })],
        true, // já existe aviso aberto
        cap,
      ) as never,
    );

    const { POST } = await import("./route");
    const body = (await (await POST(req())).json()) as { data: Record<string, number> };

    expect(body.data).toMatchObject({ avisados: 0, ja_avisados: 1 });
    expect(cap.avisos).toHaveLength(0);
    // E o contador NÃO sobe: senão o teto se esgotaria sem nunca ter avisado.
    expect(cap.updates).toHaveLength(0);
  });

  it("a cobrança sobe os DOIS contadores e não mexe no relógio nem no status", async () => {
    const cap = vazio();
    // Caso que já foi cobrado 3 vezes numa espera ANTERIOR (followup_attempts=3)
    // e voltou para a equipe: nesta espera ele ainda não recebeu nada.
    vi.mocked(createAdminClient).mockReturnValue(
      admin([vencido({ followup_attempts: 3, cobrancas_na_espera: 0 })], false, cap) as never,
    );

    const { POST } = await import("./route");
    const body = (await (await POST(req())).json()) as { data: Record<string, number> };

    expect(body.data).toMatchObject({ avisados: 1 });
    expect(cap.updates).toHaveLength(1);
    expect(cap.updates[0]).toEqual({ followup_attempts: 4, cobrancas_na_espera: 1 });
    // Mexer em `status` dispararia o gatilho da espera e zeraria o relógio.
    expect(Object.keys(cap.updates[0]!)).not.toContain("updated_at");
    expect(Object.keys(cap.updates[0]!)).not.toContain("status");
  });

  it("o último aviso diz que é o último", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [vencido({ opened_at: hAtras(80), followup_attempts: 2, cobrancas_na_espera: 2 })],
        false,
        cap,
      ) as never,
    );

    const { POST } = await import("./route");
    await POST(req());

    expect(String(cap.avisos[0]!.body)).toContain("último aviso");
    expect(cap.updates[0]).toEqual({ followup_attempts: 3, cobrancas_na_espera: 3 });
  });

  it("o último é o do teto da ORGANIZAÇÃO, não o três fixo", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [
          vencido({ id: "c1", cobrancas_na_espera: 2, teto: 5 }),
          vencido({ id: "c2", cobrancas_na_espera: 0, teto: 1 }),
        ],
        false,
        cap,
      ) as never,
    );

    const { POST } = await import("./route");
    await POST(req());

    expect(String(cap.avisos[0]!.body)).not.toContain("último aviso");
    expect(String(cap.avisos[1]!.body)).toContain("último aviso");
  });

  it("rodada sem ninguém a cobrar não audita", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin([], false, vazio()) as never);
    const { POST } = await import("./route");
    await POST(req());
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem o segredo, 403 e não lê nada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin([], false, vazio()) as never);
    const { POST } = await import("./route");
    expect((await POST(new NextRequest("http://localhost/x"))).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
