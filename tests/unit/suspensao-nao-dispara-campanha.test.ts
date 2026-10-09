/**
 * A linha "campanhas" da matriz de suspensão (§6a), agora que a superfície
 * EXISTE (migration 0375).
 *
 * Este arquivo substitui `suspensao-campanha-nao-existe.test.ts`, que era o
 * congelamento: ele ficava vermelho no dia em que alguém criasse disparo em
 * massa, justamente para obrigar esta decisão em vez de deixar a linha
 * "coberta" num documento. O dia chegou: organização suspensa não fala com
 * ninguém, e a régua é a de `lib/organizacao/operante.ts` — prospecção ativa é
 * a última coisa que ela deveria continuar fazendo.
 *
 * Mede pelo COMPORTAMENTO (a rodada não escolhe nem PROMOVE a campanha da org
 * suspensa), não pela presença do filtro no código: um teste que procurasse a
 * string `suspended` ficaria verde com o filtro aplicado à consulta errada.
 */
import { describe, expect, it, vi } from "vitest";

const avisos = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);
vi.mock("@/lib/logger", () => ({
  logger: {
    info: () => undefined,
    error: () => undefined,
    warn: (msg: string, meta: Record<string, unknown>) => avisos.push([msg, meta]),
  },
}));

import { registrarExcecaoDoEnvio, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

type Linha = Record<string, unknown>;

interface Chamada {
  tabela: string;
  operacao: "select" | "update";
  /** A consulta embutiu `organizations…!inner(status)` (o que faz `organizations.status` cortar)? */
  embuteOrgInner: boolean;
  /** A consulta filtrou `organizations.status`? */
  filtraStatusDaOrg: boolean;
  /** A URL antiga `not(organization_id, in, ...)` com a lista de paradas? */
  notIn: boolean;
}

/**
 * PostgREST em memória, só o que a rodada usa. Aplica `eq`/`in`/`lte` às colunas
 * da linha e o `limit`, nesta ordem — como o banco. `organizations.status` só
 * corta quando o `select` embute `organizations` com `!inner`: sem embed (um
 * `update`), o filtro não restringe nada, que é o pior dos dois resultados
 * possíveis do PostgREST real. Tabela desconhecida devolve vazio.
 */
function fakeAdmin(opts: { campanhas: Linha[]; erroNaBusca?: string }) {
  const chamadas: Chamada[] = [];
  const tabelas: Record<string, Linha[]> = { campaigns: opts.campanhas };
  const builder = (tabela: string) => {
    const c: Chamada = { tabela, operacao: "select", embuteOrgInner: false, filtraStatusDaOrg: false, notIn: false };
    const filtros: Array<(l: Linha) => boolean> = [];
    let limite = Infinity;
    let patch: Linha | null = null;
    const resolver = () => {
      chamadas.push(c);
      if (opts.erroNaBusca && tabela === "campaigns" && c.operacao === "select") {
        return { data: null, error: { message: opts.erroNaBusca } };
      }
      const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).slice(0, limite);
      if (patch) for (const l of linhas) Object.assign(l, patch);
      return { data: linhas, error: null };
    };
    const b: Record<string, unknown> = new Proxy(
      {},
      {
        get(_alvo, metodo) {
          switch (metodo) {
            case "then":
              return (ok: (v: unknown) => unknown) => Promise.resolve(resolver()).then(ok);
            case "maybeSingle":
            case "single":
              return async () => ({ data: resolver().data?.[0] ?? null, error: null });
            case "select":
              return (cols?: unknown) => {
                if (typeof cols === "string" && /organizations[^,(]*!inner\(/.test(cols)) c.embuteOrgInner = true;
                return b;
              };
            case "update":
              return (p: Linha) => {
                c.operacao = "update";
                patch = p;
                return b;
              };
            case "eq":
              return (coluna: string, valor: unknown) => {
                if (coluna === "organizations.status") {
                  c.filtraStatusDaOrg = true;
                  if (c.embuteOrgInner) filtros.push((l) => (l.organizations as { status?: string } | null)?.status === valor);
                } else {
                  filtros.push((l) => !(coluna in l) || l[coluna] === valor);
                }
                return b;
              };
            case "in":
              return (coluna: string, valores: unknown[]) => {
                filtros.push((l) => !(coluna in l) || valores.includes(l[coluna]));
                return b;
              };
            case "lte":
              return (coluna: string, valor: string) => {
                filtros.push((l) => !(coluna in l) || String(l[coluna]) <= valor);
                return b;
              };
            case "limit":
              return (n: number) => {
                limite = n;
                return b;
              };
            case "not":
              return (coluna: string, op: string) => {
                if (coluna === "organization_id" && op === "in") c.notIn = true;
                return b;
              };
            default:
              return () => b;
          }
        },
      },
    );
    return b;
  };
  return { admin: { from: (t: string) => builder(t) }, chamadas };
}

const ORG_PARADA = "11111111-1111-4111-8111-111111111111";
const ORG_ATIVA = "22222222-2222-4222-8222-222222222222";
const ONTEM = new Date(Date.now() - 86_400_000).toISOString();

function campanha(id: string, org: string, status: "running" | "scheduled", orgStatus: string, canal = `canal-${id}`): Linha {
  return {
    id,
    organization_id: org,
    channel_session_id: canal,
    status,
    scheduled_at: ONTEM,
    started_at: status === "running" ? ONTEM : null,
    organizations: { status: orgStatus },
  };
}

describe("suspensão × campanha", () => {
  it("a rodada não lê a lista de orgs paradas — o corte vem embutido na consulta", async () => {
    const { admin, chamadas } = fakeAdmin({ campanhas: [] });
    await rodarUmaRodadaDeCampanha(admin as never);
    expect(chamadas.some((c) => c.tabela === "organizations")).toBe(false);
    const escolha = chamadas.find((c) => c.tabela === "campaigns" && c.operacao === "select");
    expect(escolha).toMatchObject({ embuteOrgInner: true, filtraStatusDaOrg: true, notIn: false });
    for (const c of chamadas) expect(c.notIn, JSON.stringify(c)).toBe(false);
  });

  it("⭐ 30 campanhas de org parada à frente não tiram a vez da org operante (o corte é ANTES do limit)", async () => {
    const paradas = Array.from({ length: 30 }, (_, i) => campanha(`parada${String(i).padStart(2, "0")}`, ORG_PARADA, "running", "suspended"));
    const { admin } = fakeAdmin({ campanhas: [...paradas, campanha("ativa-01", ORG_ATIVA, "running", "active")] });
    const r = await rodarUmaRodadaDeCampanha(admin as never);
    expect(r.detalhe).toContain("ativa-01:");
    expect(r.detalhe).not.toContain("parada");
  });

  it("⭐ a PROMOÇÃO de agendadas não promove a da org parada e não deixa a operante sem vez", async () => {
    const paradas = Array.from({ length: 150 }, (_, i) => campanha(`agendada-parada-${i}`, ORG_PARADA, "scheduled", "suspended"));
    const ativa = campanha("agendada-ativa", ORG_ATIVA, "scheduled", "active");
    const { admin, chamadas } = fakeAdmin({ campanhas: [...paradas, ativa] });
    const r = await rodarUmaRodadaDeCampanha(admin as never);
    // Promovida (e, sem destinatário no fake, já concluída na mesma rodada).
    expect(ativa.status).not.toBe("scheduled");
    expect(paradas.filter((c) => c.status !== "scheduled")).toHaveLength(0);
    expect(r.promovidas).toBe(1);
    // O update não filtra pelo embutido (que ali não corta): promove por id.
    const promocao = chamadas.find((c) => c.tabela === "campaigns" && c.operacao === "update");
    expect(promocao?.filtraStatusDaOrg).toBe(false);
  });
});

describe("a busca das campanhas em andamento falhou", () => {
  it("⭐ registra o erro e não responde 'nada a fazer' — a falha não se disfarça de rodada vazia", async () => {
    avisos.length = 0;
    const { admin } = fakeAdmin({ campanhas: [], erroNaBusca: "timeout do PostgREST" });
    const r = await rodarUmaRodadaDeCampanha(admin as never);

    expect(r.detalhe).toBe("busca_falhou");
    expect(r.enviadas).toBe(0);
    expect(avisos).toContainEqual(["[campanha] busca das campanhas em andamento falhou", { motivo: "timeout do PostgREST" }]);
  });
});

describe("exceção do envio × organização parada", () => {
  /** Supabase falso que só registra o que o `update` gravaria. */
  function adminQueGrava() {
    const gravados: Array<Record<string, unknown>> = [];
    const b: Record<string, unknown> = {
      update: (payload: Record<string, unknown>) => {
        gravados.push(payload);
        return b;
      },
      eq: () => b,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return { admin: { from: () => b } as never, gravados };
  }

  it("org parada no meio do envio devolve o destinatário à fila, sem send_exception", async () => {
    const { admin, gravados } = adminQueGrava();
    await expect(registrarExcecaoDoEnvio(admin, "dest-1", new OrgNaoOperanteError("org"))).resolves.toBe("org_nao_operante");
    expect(gravados).toEqual([{ status: "pending", sending_at: null }]);
  });

  it("controle: outro erro segue marcando failed/send_exception com o motivo", async () => {
    const { admin, gravados } = adminQueGrava();
    await expect(registrarExcecaoDoEnvio(admin, "dest-1", new Error("rede"))).resolves.toBe("falhou");
    expect(gravados).toEqual([{ status: "failed", last_error_code: "send_exception", last_error_detail: "rede" }]);
  });
});

vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: async () => ({ rows: [] }) }),
}));
