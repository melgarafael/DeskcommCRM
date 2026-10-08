// @vitest-environment node
/**
 * O dublê do e2e (tests/e2e/fixtures/provedor-de-cobranca.ts) e o adaptador
 * Stripe de produção falam a MESMA língua. Sem este arquivo, a spec P0 poderia
 * ficar verde com um dublê que aceita o que a Stripe recusa, ou vermelha por uma
 * forma inventada, e o vermelho se leria como defeito da tela.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { subirProvedorDeCobranca, type ProvedorDeCobrancaFalso } from "../e2e/fixtures/provedor-de-cobranca";

const estado = vi.hoisted(() => ({ base: "", chave: ["rk", "test", "contratoDoDuble0123"].join("_") }));

vi.mock("@/lib/instalacao/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instalacao/config")>()),
  valorDaInstalacao: async (chave: string) =>
    chave === "STRIPE_SECRET_KEY" ? { valor: estado.chave, fonte: "banco" as const } : { valor: null, fonte: "ausente" as const },
}));
vi.mock("@/lib/cobranca/provedores/base-de-teste", () => ({
  baseDeTesteDaCobranca: () => estado.base,
  resolverBaseDeTeste: () => estado.base,
}));

const recebidos: Array<{ corpo: string; assinatura: string }> = [];
let receptor: Server;
let urlDoReceptor = "";
let duble: ProvedorDeCobrancaFalso;

beforeAll(async () => {
  duble = await subirProvedorDeCobranca({ porta: 0 });
  estado.base = duble.base;
  receptor = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on("data", (p: Buffer) => partes.push(p));
    req.on("end", () => {
      recebidos.push({ corpo: Buffer.concat(partes).toString("utf8"), assinatura: String(req.headers["stripe-signature"] ?? "") });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((ok) => receptor.listen(0, "127.0.0.1", () => ok()));
  urlDoReceptor = `http://127.0.0.1:${(receptor.address() as AddressInfo).port}/api/v1/webhooks/cobranca/stripe`;
});
afterAll(async () => {
  await duble.fechar();
  await new Promise<void>((ok) => receptor.close(() => ok()));
});

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_EM_TESTE = "22222222-2222-4222-8222-222222222222";
const ESSENCIAL = { id: "33333333-3333-4333-8333-333333333333", nome: "Essencial", precoCents: 4990, intervalo: "mes" as const };
const PROFISSIONAL = { id: "44444444-4444-4444-8444-444444444444", nome: "Profissional", precoCents: 9990, intervalo: "mes" as const };
const VOLTA = "http://localhost:3001/app/settings/billing?voltou=1";

async function stripe() {
  const { adaptador } = await import("@/lib/cobranca/provedores");
  return adaptador("stripe");
}

describe("dublê do e2e × adaptador Stripe", () => {
  it("do teste da chave ao cancelamento, cada resposta do dublê é lida como a spec manda", async () => {
    const s = await stripe();
    expect(await s.testarChave()).toEqual({ ok: true, modo: "teste" });

    const preparo = await s.prepararWebhook(urlDoReceptor, "dono@contrato.test");
    if (!("segredo" in preparo)) throw new Error("a Stripe registra o webhook por API; o modo manual é só do Asaas");
    await preparo.confirmar();
    expect(preparo.segredo).toBe(duble.segredoDoWebhook());
    expect(duble.urlDoWebhook()).toBe(urlDoReceptor);

    const cliente = await s.garantirCliente({ id: ORG, nome: "Loja Contrato", email: "admin@contrato.test", documento: null });
    expect(duble.clienteDaOrg(ORG)).toBe(cliente);
    expect(await s.clienteExiste(cliente)).toBe(true);
    expect(await s.clienteExiste("cus_de_outra_conta")).toBe(false);
    expect(await s.lerSituacao({ clienteRef: cliente })).toMatchObject({ existe: false, assinaturasVivas: 0, jaPagou: false, cancelada: false, emAtraso: false });

    const inicio = await s.iniciarAssinatura({ clienteRef: cliente, orgId: ORG, plano: ESSENCIAL, trialAte: null, urlDeVolta: VOLTA, chaveIdempotencia: "contrato-1" });
    expect(inicio.url.startsWith(`${duble.base}/checkout/`)).toBe(true);
    const pago = await fetch(`${inicio.url}/pagar`, { method: "POST", redirect: "manual" });
    expect(pago.status).toBe(303);
    expect(pago.headers.get("location")).toContain("/app/settings/billing");

    const vivo = await s.lerSituacao({ clienteRef: cliente });
    expect(vivo).toMatchObject({ existe: true, assinaturasVivas: 1, jaPagou: true, emAtraso: false, cancelada: false, cancelaNoFim: false, linkDePagamento: null, emTesteNoProvedorAte: null });
    const dias = ((vivo.proximoVencimento?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(29);
    expect(dias).toBeLessThan(31);

    // Os três avisos que o dublê assinou passam na verificação do adaptador…
    expect(recebidos).toHaveLength(3);
    for (const aviso of recebidos) {
      const sinal = s.verificarWebhook(aviso.corpo, new Headers({ "stripe-signature": aviso.assinatura }), preparo.segredo, new Date());
      expect(sinal?.clienteRef).toBe(cliente);
    }
    // …e um corpo alterado não passa. Controle negativo: o verde acima não é "aceita tudo".
    const primeiro = recebidos[0]!;
    expect(s.verificarWebhook(`${primeiro.corpo} `, new Headers({ "stripe-signature": primeiro.assinatura }), preparo.segredo, new Date())).toBeNull();

    const link = await duble.atrasar(cliente);
    expect(await s.lerSituacao({ clienteRef: cliente })).toMatchObject({ existe: true, emAtraso: true, linkDePagamento: link });
    expect((await fetch(`${link}/pagar`, { method: "POST", redirect: "manual" })).status).toBe(303);
    const quitado = await s.lerSituacao({ clienteRef: cliente });
    expect(quitado).toMatchObject({ existe: true, emAtraso: false, linkDePagamento: null });

    await s.trocarPlano({ assinaturaRef: quitado.assinaturaRef!, plano: PROFISSIONAL });
    expect(duble.assinaturaPrincipal(cliente)).toMatchObject({ unit_amount: 9990, proration_behavior: "none" });

    expect((await s.urlDeGerenciar({ clienteRef: cliente, urlDeVolta: VOLTA }))?.startsWith(`${duble.base}/portal/`)).toBe(true);

    await s.cancelarNoFim(quitado.assinaturaRef!);
    expect(await s.lerSituacao({ clienteRef: cliente })).toMatchObject({ existe: true, cancelaNoFim: true, cancelada: false });
  });

  it("teste grátis de 3 dias vira trial_end no provedor: em teste lá, sem existir ainda, e o produto repetido é aceito", async () => {
    const s = await stripe();
    const cliente = await s.garantirCliente({ id: ORG_EM_TESTE, nome: "Loja em Teste", email: "admin@teste.test", documento: null });
    const fim = new Date(Date.now() + 3 * 86_400_000);
    const inicio = await s.iniciarAssinatura({ clienteRef: cliente, orgId: ORG_EM_TESTE, plano: ESSENCIAL, trialAte: fim, urlDeVolta: VOLTA, chaveIdempotencia: "contrato-2" });
    expect((await fetch(`${inicio.url}/pagar`, { method: "POST", redirect: "manual" })).status).toBe(303);
    const situacao = await s.lerSituacao({ clienteRef: cliente });
    expect(situacao).toMatchObject({ existe: false, assinaturasVivas: 1, jaPagou: false });
    expect(Math.abs((situacao.emTesteNoProvedorAte?.getTime() ?? 0) - fim.getTime())).toBeLessThan(2_000);
  });

  it("todo pedido leva a chave só no cabeçalho, a versão fixada e, se POST, a chave de idempotência", () => {
    expect(duble.chamadas.length).toBeGreaterThan(10);
    for (const c of duble.chamadas) {
      const rotulo = `${c.metodo} ${c.caminho}`;
      expect(c.autorizacao, rotulo).toBe(`Bearer ${estado.chave}`);
      expect(c.versao, rotulo).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(JSON.stringify(c.query), rotulo).not.toContain(estado.chave);
      if (c.metodo === "POST") expect(c.idempotencia, rotulo).toBeTruthy();
    }
    expect(duble.falhas).toEqual([]);
  });
});
