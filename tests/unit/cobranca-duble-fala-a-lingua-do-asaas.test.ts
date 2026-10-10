// @vitest-environment node
/**
 * O dialeto Asaas do dublê do e2e (tests/e2e/fixtures/provedor-de-cobranca-asaas.ts,
 * em /v3 do MESMO servidor do dublê da Stripe) e o adaptador Asaas de produção
 * falam a MESMA língua. Molde: cobranca-duble-fala-a-lingua-do-adaptador.test.ts.
 * Sem este arquivo, a spec do e2e poderia ficar verde com um dublê que aceita o
 * que o Asaas recusa, ou vermelha por uma forma inventada.
 *
 * Os eventos e as regras de data vêm da SPEC (§6.2), escritos aqui, e não do
 * adaptador: importar a lista dele faria a comparação passar sempre.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as ConfigDaInstalacao from "@/lib/instalacao/config";
import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";

import { subirProvedorDeCobranca, type ProvedorDeCobrancaFalso } from "../e2e/fixtures/provedor-de-cobranca";
import { gerarCpf, hojeEmSaoPaulo } from "../e2e/fixtures/provedor-de-cobranca-asaas";

const estado = vi.hoisted(() => ({
  base: "",
  // Montada em pedaços: a varredura de segredo do GitHub barra literal com cara de chave.
  chave: ["$aact", "hmlg", "000ContratoDoDubleAsaas0123456789"].join("_"),
}));

vi.mock("@/lib/instalacao/config", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigDaInstalacao>()),
  valorDaInstalacao: async (chave: string) =>
    chave === "ASAAS_API_KEY" ? { valor: estado.chave, fonte: "banco" as const } : { valor: null, fonte: "ausente" as const },
}));
vi.mock("@/lib/cobranca/provedores/base-de-teste", () => ({
  baseDeTesteDaCobranca: () => estado.base,
  resolverBaseDeTeste: () => estado.base,
}));

const EVENTOS_DA_SPEC = [
  "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_DELETED", "PAYMENT_RESTORED",
  "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED", "SUBSCRIPTION_CREATED", "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_INACTIVATED", "SUBSCRIPTION_DELETED",
];
/** '2026-10-05' → 2026-10-06T02:59:59.000Z (§6.2). ponytail: UTC−3 fixo; o Brasil não tem horário de verão desde 2019. */
const fimDoDiaEmSaoPaulo = (dia: string) => new Date(`${dia}T23:59:59-03:00`).toISOString();

const recebidos: Array<{ corpo: string; token: string }> = [];
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
      recebidos.push({ corpo: Buffer.concat(partes).toString("utf8"), token: String(req.headers["asaas-access-token"] ?? "") });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((ok) => receptor.listen(0, "127.0.0.1", () => ok()));
  urlDoReceptor = `http://127.0.0.1:${(receptor.address() as AddressInfo).port}/api/v1/webhooks/cobranca/asaas`;
});
afterAll(async () => {
  await duble.fechar();
  await new Promise<void>((ok) => receptor.close(() => ok()));
});

const ORG = "55555555-5555-4555-8555-555555555555";
const ESSENCIAL = { id: "66666666-6666-4666-8666-666666666666", nome: "Essencial", precoCents: 4990, intervalo: "mes" as const };
const PROFISSIONAL = { id: "77777777-7777-4777-8777-777777777777", nome: "Profissional", precoCents: 9990, intervalo: "mes" as const };
const VOLTA = "http://localhost:3001/app/settings/billing?voltou=1";

async function asaas() {
  const { adaptador } = await import("@/lib/cobranca/provedores");
  return adaptador("asaas");
}
const puts = () => duble.asaas.chamadas.filter((c) => c.metodo === "PUT");

describe("dialeto Asaas do dublê × adaptador Asaas", () => {
  it("do teste da chave ao cancelamento, cada resposta do dublê é lida como a §6.2 manda", async () => {
    const a = await asaas();
    expect(await a.testarChave()).toEqual({ ok: true, modo: "teste" });

    const preparo = await a.prepararWebhook(urlDoReceptor, "dono@contrato.test");
    if (!("segredo" in preparo)) throw new Error("com a API aceitando, o webhook do Asaas nasce pela API");
    await preparo.confirmar();
    expect(duble.asaas.urlDoWebhook()).toMatch(new RegExp(`^${urlDoReceptor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?conexao=[0-9a-f]{8}$`));
    expect(duble.asaas.tokenDoWebhook()).toBe(preparo.segredo);
    expect([...duble.asaas.eventosDoWebhook()].sort()).toEqual([...EVENTOS_DA_SPEC].sort());

    // CPF/CNPJ: dígito errado não vira cliente no provedor.
    const cpf = gerarCpf();
    const errado = cpf.slice(0, 10) + String((Number(cpf.slice(10)) + 1) % 10);
    await expect(a.garantirCliente({ id: ORG, nome: "Loja Contrato", email: "admin@contrato.test", documento: errado })).rejects.toBeInstanceOf(ErroDoProvedor);
    expect(duble.asaas.clienteDaOrg(ORG)).toBeNull();
    const cliente = await a.garantirCliente({ id: ORG, nome: "Loja Contrato", email: "admin@contrato.test", documento: cpf });
    expect(duble.asaas.clienteDaOrg(ORG)).toBe(cliente);
    // externalReference = org: a segunda chamada reaproveita, não duplica.
    expect(await a.garantirCliente({ id: ORG, nome: "Loja Contrato", email: "admin@contrato.test", documento: cpf })).toBe(cliente);
    expect(await a.clienteExiste(cliente)).toBe(true);
    expect(await a.clienteExiste("cus_000000000000")).toBe(false);
    expect(await a.lerSituacao({ clienteRef: cliente })).toMatchObject({ existe: false, assinaturasVivas: 0, jaPagou: false, cancelada: false, emAtraso: false, linkDePagamento: null, emTesteNoProvedorAte: null });

    // Sem teste grátis: a 1ª cobrança vence HOJE em São Paulo, em reais.
    const inicio = await a.iniciarAssinatura({ clienteRef: cliente, orgId: ORG, plano: ESSENCIAL, trialAte: null, urlDeVolta: VOLTA, chaveIdempotencia: "contrato-1" });
    const [primeira] = duble.asaas.cobrancasDe(cliente);
    expect(primeira).toMatchObject({ status: "PENDING", dueDate: hojeEmSaoPaulo(), value: 49.9 });
    expect(inicio.url).toBe(`${duble.base}/i/${primeira?.id}`);
    // Medido no sandbox (smoke): na criação nasce UMA cobrança só; a seguinte vem depois de pago.
    expect(duble.asaas.cobrancasDe(cliente).filter((c) => c.status === "PENDING")).toHaveLength(1);

    // A assinatura nasce ACTIVE só com PENDING: clicar em Assinar e não pagar NÃO é assinar (§6.2 passo 2).
    const pendente = await a.lerSituacao({ clienteRef: cliente });
    expect(pendente).toMatchObject({ existe: false, assinaturasVivas: 1, jaPagou: false, linkDePagamento: inicio.url });
    // Guarda do trocarPlano: o período em uso não foi pago → recusa sem tocar no provedor.
    const putsAntes = puts().length;
    await expect(a.trocarPlano({ assinaturaRef: pendente.assinaturaRef ?? "", plano: PROFISSIONAL })).rejects.toMatchObject({ codigo: "pagamento_do_periodo_pendente", transitorio: false });
    expect(puts().length).toBe(putsAntes);
    // Assinatura ACTIVE existente é reaproveitada.
    expect((await a.iniciarAssinatura({ clienteRef: cliente, orgId: ORG, plano: ESSENCIAL, trialAte: null, urlDeVolta: VOLTA, chaveIdempotencia: "contrato-2" })).url).toBe(inicio.url);
    expect(duble.asaas.assinaturasDe(cliente)).toHaveLength(1);

    // Cartão: CONFIRMED já conta como pago (§6.2 passo 4).
    expect((await fetch(`${inicio.url}/cartao`, { method: "POST", redirect: "manual" })).status).toBe(303);
    const paga = await a.lerSituacao({ clienteRef: cliente });
    const proxima = duble.asaas.cobrancasDe(cliente).find((c) => c.status === "PENDING");
    expect(paga).toMatchObject({ existe: true, assinaturasVivas: 1, jaPagou: true, emAtraso: false, cancelada: false });
    // Fim do período pago = vencimento pago + 1 ciclo, no fim do dia em SP; NUNCA o nextDueDate (§6.2 passo 5).
    expect(paga.proximoVencimento?.toISOString()).toBe(fimDoDiaEmSaoPaulo(proxima?.dueDate ?? ""));
    expect(duble.asaas.assinaturasDe(cliente)[0]?.nextDueDate).not.toBe(proxima?.dueDate);

    // Review Focus 4: pago o período, a troca passa com updatePendingPayments, e a pendente futura leva o valor novo.
    await a.trocarPlano({ assinaturaRef: paga.assinaturaRef ?? "", plano: PROFISSIONAL });
    expect(puts().at(-1)?.corpo).toMatchObject({ value: 99.9, updatePendingPayments: true });
    expect(duble.asaas.cobrancasDe(cliente).filter((c) => c.status === "PENDING").map((c) => c.value)).toEqual([99.9]);
    expect(await a.urlDeGerenciar({ clienteRef: cliente, urlDeVolta: VOLTA })).toBe(`${duble.base}/i/${proxima?.id}`);

    // Atraso: OVERDUE abre o atraso, com a data do provedor no fim do dia e o link da vencida.
    const link = await duble.asaas.vencer(cliente);
    const vencida = duble.asaas.cobrancasDe(cliente).find((c) => c.status === "OVERDUE");
    const devendo = await a.lerSituacao({ clienteRef: cliente });
    expect(devendo).toMatchObject({ existe: true, emAtraso: true, linkDePagamento: link });
    expect(devendo.vencidaDesde?.toISOString()).toBe(fimDoDiaEmSaoPaulo(vencida?.dueDate ?? ""));
    expect((await fetch(`${link}/pix`, { method: "POST", redirect: "manual" })).status).toBe(303);
    const quitada = await a.lerSituacao({ clienteRef: cliente });
    expect(quitada).toMatchObject({ existe: true, emAtraso: false });

    // Review Focus 3: cancelar = DELETE; só com includeDeleted a removida aparece, e o período pago fica.
    await a.cancelarNoFim(quitada.assinaturaRef ?? "");
    const cancelada = await a.lerSituacao({ clienteRef: cliente });
    expect(cancelada).toMatchObject({ cancelada: true, existe: false, assinaturasVivas: 0, jaPagou: true, linkDePagamento: null });
    expect(cancelada.proximoVencimento?.toISOString()).toBe(quitada.proximoVencimento?.toISOString());
    expect(duble.asaas.chamadas.some((c) => c.metodo === "GET" && c.caminho === "/v3/subscriptions" && c.query.includeDeleted === "true")).toBe(true);

    // Todo aviso que o dublê mandou passa no token; token errado não passa (controle negativo).
    expect(recebidos.length).toBeGreaterThan(3);
    for (const aviso of recebidos) {
      const sinal = a.verificarWebhook(aviso.corpo, new Headers({ "asaas-access-token": aviso.token }), preparo.segredo, new Date());
      expect(sinal?.clienteRef).toBe(cliente);
      expect(sinal?.eventoId).toBe((JSON.parse(aviso.corpo) as { id: string }).id);
    }
    const primeiro = recebidos[0];
    expect(a.verificarWebhook(primeiro?.corpo ?? "", new Headers({ "asaas-access-token": `${primeiro?.token}x` }), preparo.segredo, new Date())).toBeNull();
  });

  it("⭐ reconexão: o dublê recusa URL repetida como o sandbox; a URL com ?conexao= passa, confirmar deixa um, desfazer deixa o anterior", async () => {
    const a = await asaas();
    const um = await a.prepararWebhook(urlDoReceptor, "dono@contrato.test");
    const dois = await a.prepararWebhook(urlDoReceptor, "dono@contrato.test");
    if (!("segredo" in um) || !("segredo" in dois)) throw new Error("a reconexão não pode cair no ramo manual");
    await dois.confirmar();
    expect(duble.asaas.tokenDoWebhook()).toBe(dois.segredo);
    const tres = await a.prepararWebhook(urlDoReceptor, "dono@contrato.test");
    if (!("segredo" in tres)) throw new Error("a reconexão não pode cair no ramo manual");
    await tres.desfazer();
    expect(duble.asaas.tokenDoWebhook()).toBe(dois.segredo);
    expect(await a.removerWebhooks(urlDoReceptor)).toBe(1);
  });

  it("o dublê recusa um POST /webhooks com URL já cadastrada, como o sandbox (400 invalid_object)", async () => {
    const corpo = JSON.stringify({ name: "repetido", url: `${urlDoReceptor}?repetido=1`, email: "dono@contrato.test", enabled: true, interrupted: false, sendType: "SEQUENTIALLY", authToken: "t".repeat(32), events: ["PAYMENT_RECEIVED"] });
    const cabecalhos = { access_token: estado.chave, "content-type": "application/json", "user-agent": "contrato" };
    const primeiro = await fetch(`${duble.base}/v3/webhooks`, { method: "POST", headers: cabecalhos, body: corpo });
    expect(primeiro.status).toBe(200);
    const segundo = await fetch(`${duble.base}/v3/webhooks`, { method: "POST", headers: cabecalhos, body: corpo });
    expect(segundo.status).toBe(400);
    expect(JSON.stringify(await segundo.json())).toContain("invalid_object");
    await (await asaas()).removerWebhooks(`${urlDoReceptor}?repetido=1`);
  });

  it("conta que não deixa criar o webhook pela API: o adaptador devolve o passo a passo manual com os 11 eventos da spec", async () => {
    duble.asaas.recusarCriacaoDeWebhook(true);
    try {
      const preparo = await (await asaas()).prepararWebhook(urlDoReceptor, "dono@contrato.test");
      if (!("manual" in preparo)) throw new Error("a API recusou e o adaptador não caiu no ramo manual");
      expect(preparo.manual.url.startsWith(`${urlDoReceptor}?conexao=`)).toBe(true);
      expect(preparo.manual.segredo.length).toBeGreaterThanOrEqual(32);
      expect([...preparo.manual.eventos].sort()).toEqual([...EVENTOS_DA_SPEC].sort());
    } finally {
      duble.asaas.recusarCriacaoDeWebhook(false);
    }
  });

  it("todo pedido leva a chave só no cabeçalho access_token, um User-Agent próprio e JSON no corpo", () => {
    expect(duble.asaas.chamadas.length).toBeGreaterThan(10);
    for (const c of duble.asaas.chamadas) {
      const rotulo = `${c.metodo} ${c.caminho}`;
      expect(c.chave, rotulo).toBe(estado.chave);
      expect(c.userAgent ?? "", rotulo).not.toMatch(/^$|^(node|undici)\b/i);
      expect(JSON.stringify(c.query), rotulo).not.toContain("aact_");
      if (c.metodo === "POST" || c.metodo === "PUT") expect(c.contentType ?? "", rotulo).toMatch(/^application\/json/);
    }
    expect(duble.falhas).toEqual([]);
  });

  it("chave de produção nunca sai para o dublê: só a base oficial a recebe", async () => {
    const antes = duble.asaas.chamadas.length;
    const original = estado.chave;
    estado.chave = ["$aact", "prod", "000ChaveDeProducaoNuncaSai0123"].join("_");
    try {
      expect(await (await asaas()).testarChave()).toMatchObject({ ok: false });
    } finally {
      estado.chave = original;
    }
    expect(duble.asaas.chamadas.slice(antes).filter((c) => (c.chave ?? "").includes("_prod_"))).toEqual([]);
  });
});