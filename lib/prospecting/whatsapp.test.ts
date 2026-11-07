import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A empresa tem WhatsApp? (`whatsapp.ts`)
 *
 * O caso que produziu a regra (02/11/2026, uma busca real de 14 empresas): 8 com
 * WhatsApp, 2 sem — e um dos 8 era um FIXO com WhatsApp Business. Daqui saem os
 * três compromissos que estes casos fixam:
 *   1. a resposta vem do WhatsApp, número por número — nunca do prefixo;
 *   2. "sem WhatsApp" tira a empresa da abordagem; "não deu para saber" (servidor
 *      fora) não tira ninguém — a rodada para e tenta de novo;
 *   3. as consultas saem espaçadas e com teto: quem consulta é o número do cliente.
 */
const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  numeroTemConta: vi.fn<(i: { organizationId: string; sessionRef: string; phone: string }) => Promise<boolean | null>>(),
  provedores: ["canal-pareado"] as string[],
  temMetodo: true,
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// O canal é pedido pela porta do seam (`@/lib/channels`), nunca pelo nome do provider.
vi.mock("@/lib/channels", () => ({
  provedoresQueConferemNumero: () => mocks.provedores,
  getAdapter: () => (mocks.temMetodo ? { numeroTemConta: mocks.numeroTemConta } : {}),
  resolveSessionRef: (c: { ref: string }) => c.ref,
}));

import {
  consultaPelaConexao,
  MOTIVO_SEM_WHATSAPP,
  motivoSemWhatsapp,
  PAUSA_ENTRE_CONSULTAS_MS,
  verificarWhatsappPendentes,
  type ConsultaWhatsapp,
} from "./whatsapp";

const ORG = "99999999-9999-4999-8999-999999999999";
const CAMP = "11111111-1111-4111-8111-111111111111";

function banco(pendentes: Array<{ id: string; phone: string }>) {
  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      sqls.push({ sql, params });
      if (sql.startsWith("select id, data->>'phone'")) return { rows: pendentes.slice(0, Number(params[2])) };
      return { rows: [], rowCount: 1 };
    }),
  };
  return { db, sqls, gravacoes: () => sqls.filter((s) => s.sql.startsWith("update prospecting_candidates")) };
}

const semPausa = vi.fn(async (_ms: number) => {});
const rodar = (db: unknown, consultar: ConsultaWhatsapp, teto = 15, deadline = Date.now() + 60_000) =>
  verificarWhatsappPendentes(db as never, ORG, "req-1", deadline, CAMP, teto, consultar, semPausa);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.provedores = ["canal-pareado"];
  mocks.temMetodo = true;
});

describe("verificarWhatsappPendentes", () => {
  it("grava o veredito de cada número e tira da seleção só quem NÃO tem WhatsApp", async () => {
    const { db, gravacoes } = banco([
      { id: "a", phone: "+5511987650001" },
      { id: "b", phone: "+551130000002" },
      { id: "c", phone: "+551132000003" },
    ]);
    // O fixo `c` TEM WhatsApp Business: o prefixo não decide nada.
    const respostas: Record<string, boolean> = { "+5511987650001": true, "+551130000002": false, "+551132000003": true };
    const r = await rodar(db, async (tel) => respostas[tel]!);

    expect(r).toEqual({ verificados: 3, semWhatsapp: 1, interrompida: false });
    const g = gravacoes();
    expect(g.map((x) => [x.params[1], JSON.parse(String(x.params[2])).existe, x.params[3]])).toEqual([
      ["a", true, true],
      ["b", false, false],
      ["c", true, true],
    ]);
    // O UPDATE só tira da seleção quando `existe` é false, e na fila vira "Não abordado" com o motivo.
    expect(g[0]!.sql).toContain("selected = case when $4 then selected else false end");
    expect(g[0]!.sql).toContain("status = case when not $4 and status = 'queued' then 'skipped'");
    expect(g[1]!.params[4]).toBe(MOTIVO_SEM_WHATSAPP);
    // Não reescreve veredito de outra rodada nem mexe em quem já foi tentado.
    expect(g[0]!.sql).toContain("data->'whatsapp' is null");
    expect(g[0]!.sql).toContain("status in ('new','queued')");
  });

  it("servidor fora ('não deu para saber') não descarta ninguém: para a rodada sem gravar", async () => {
    const { db, gravacoes } = banco([
      { id: "a", phone: "+5511987650001" },
      { id: "b", phone: "+5511987650002" },
      { id: "c", phone: "+5511987650003" },
    ]);
    const consultar = vi.fn<ConsultaWhatsapp>().mockResolvedValueOnce(true).mockResolvedValueOnce(null);
    const r = await rodar(db, consultar);
    expect(r).toEqual({ verificados: 1, semWhatsapp: 0, interrompida: true });
    expect(consultar).toHaveBeenCalledTimes(2);
    expect(gravacoes().map((x) => x.params[1])).toEqual(["a"]);
  });

  it("respeita o teto da rodada e espaça as consultas (nada de rajada pelo número do cliente)", async () => {
    const lista = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, phone: `+55119876500${String(i).padStart(2, "0")}` }));
    const { db, sqls } = banco(lista);
    const consultar = vi.fn<ConsultaWhatsapp>().mockResolvedValue(true);
    await rodar(db, consultar, 5);
    expect(sqls[0]!.params[2]).toBe(5);
    expect(consultar).toHaveBeenCalledTimes(5);
    // Pausa ENTRE consultas: 5 números, 4 pausas, todas do tamanho da constante.
    expect(semPausa).toHaveBeenCalledTimes(4);
    expect(semPausa.mock.calls.every(([ms]) => ms === PAUSA_ENTRE_CONSULTAS_MS)).toBe(true);
  });

  it("prazo vencido não consulta; teto zero nem lê o banco", async () => {
    const { db } = banco([{ id: "a", phone: "+5511987650001" }]);
    const consultar = vi.fn<ConsultaWhatsapp>().mockResolvedValue(true);
    expect(await rodar(db, consultar, 15, Date.now() - 1)).toMatchObject({ verificados: 0 });
    expect(consultar).not.toHaveBeenCalled();
    expect(await rodar(db, consultar, 0)).toMatchObject({ verificados: 0 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("audita só quando houve efeito, com contagens e nunca o telefone", async () => {
    const vazio = banco([]);
    await rodar(vazio.db, async () => true);
    expect(mocks.audit).not.toHaveBeenCalled();

    const { db } = banco([{ id: "a", phone: "+5511987650001" }, { id: "b", phone: "+551130000002" }]);
    await rodar(db, async (tel) => tel.startsWith("+55119"));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const arg = mocks.audit.mock.calls[0]![0];
    expect(arg).toMatchObject({
      action: "prospecting.whatsapp_checked",
      resourceId: CAMP,
      metadata: { verificados: 2, sem_whatsapp: 1 },
    });
    expect(JSON.stringify(arg)).not.toContain("+5511");
  });
});

describe("consultaPelaConexao", () => {
  const canal = { id: "c1", provider: "canal-pareado", ref: "sessao-1" };
  const dbCom = (rows: unknown[]) => ({ query: vi.fn(async (_sql: string, _params: unknown[]) => ({ rows })) });

  it("nenhum canal sabe perguntar, ou nenhuma conexão capaz conectada: não há consulta (nada muda)", async () => {
    mocks.provedores = [];
    const db = dbCom([canal]);
    expect(await consultaPelaConexao(db as never, ORG, null)).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    mocks.provedores = ["canal-pareado"];
    expect(await consultaPelaConexao(dbCom([]) as never, ORG, null)).toBeNull();
    mocks.temMetodo = false;
    expect(await consultaPelaConexao(dbCom([canal]) as never, ORG, null)).toBeNull();
  });

  it("prefere a conexão da campanha, filtra pelos canais capazes e pergunta pela sessão dela", async () => {
    mocks.numeroTemConta.mockResolvedValue(true);
    const db = dbCom([canal]);
    const consultar = await consultaPelaConexao(db as never, ORG, "c1");
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toContain("provider = any($2::text[])");
    expect(sql).toContain("status='WORKING'");
    expect(params).toEqual([ORG, ["canal-pareado"]]);
    expect(await consultar!("+5511987650001")).toBe(true);
    expect(mocks.numeroTemConta).toHaveBeenCalledWith({
      organizationId: ORG,
      sessionRef: "sessao-1",
      phone: "+5511987650001",
    });
  });

  it("campanha que escolheu uma conexão que não sabe perguntar (o canal oficial) não consulta por outro número", async () => {
    // A consulta só devolve as capazes conectadas — a da campanha (oficial) não está entre elas.
    const outraPorQr = { id: "qr-1", provider: "canal-pareado", ref: "sessao-qr" };
    expect(await consultaPelaConexao(dbCom([outraPorQr]) as never, ORG, "oficial-1")).toBeNull();
    expect(mocks.numeroTemConta).not.toHaveBeenCalled();
    // Controle: sem conexão escolhida, a mesma conexão por QR serve.
    expect(await consultaPelaConexao(dbCom([outraPorQr]) as never, ORG, null)).not.toBeNull();
  });

  it("repassa o 'não' e o 'não deu para saber' do canal; exceção do canal também é 'não deu para saber'", async () => {
    const consultar = (await consultaPelaConexao(dbCom([canal]) as never, ORG, null))!;
    mocks.numeroTemConta.mockResolvedValueOnce(false).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("http_502"));
    expect(await consultar("+5511987650001")).toBe(false);
    expect(await consultar("+5511987650001")).toBeNull();
    expect(await consultar("+5511987650001")).toBeNull();
  });
});

describe("motivoSemWhatsapp", () => {
  it("só o 'não' do WhatsApp vira motivo; sem veredito, nada muda", () => {
    expect(motivoSemWhatsapp({ whatsapp: { existe: false, verificado_em: "x" } })).toBe(MOTIVO_SEM_WHATSAPP);
    expect(motivoSemWhatsapp({ whatsapp: { existe: true, verificado_em: "x" } })).toBeNull();
    expect(motivoSemWhatsapp({ whatsapp: null })).toBeNull();
    expect(motivoSemWhatsapp({})).toBeNull();
    expect(motivoSemWhatsapp(null)).toBeNull();
  });
});
