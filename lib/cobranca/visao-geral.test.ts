import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, valorDoFiltro, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ provedor: "stripe" as string | null, lidas: [] as string[] }));
vi.mock("@/lib/cobranca/configuracao", () => ({ provedorDaInstalacao: async () => h.provedor }));
vi.mock("@/lib/cobranca/provedores", () => ({ modoDoProvedor: async () => "teste" }));
vi.mock("@/lib/cobranca/provedores/base-de-teste", () => ({ baseDeTesteDaCobranca: () => null }));
vi.mock("@/lib/instalacao/config", () => ({
  estadoParaTela: async (chave: string) => {
    h.lidas.push(chave);
    return { last4: "4242" };
  },
}));
vi.mock("@/lib/email/roteador", () => ({ emailConfigurado: async () => false }));

import { leituraAtrasada, lerVisaoGeral, montarChecklist, type DadosDaVisaoGeral } from "./visao-geral";

const VAZIA: DadosDaVisaoGeral = {
  provedor: null, modo: null, chaveLast4: null, urlDoWebhook: "https://crm.exemplo.com/api/v1/webhooks/cobranca/stripe",
  ultimoAvisoEm: null, ultimaLeituraEm: null, compraConcluida: false, emailPronto: false, planoDoCadastro: false,
  problemas: { credencialInvalida: 0, cobrancaDupla: 0, pagouCancelada: 0, avisosComErro: 0, avisosRecusados: 0 },
};
const passo = (d: DadosDaVisaoGeral, id: string) => montarChecklist(d).find((p) => p.id === id);

beforeEach(() => {
  h.provedor = "stripe";
  h.lidas = [];
});

describe("montarChecklist", () => {
  it("instalação nova: nada feito, na ordem que leva até cobrar de verdade, e o primeiro passo é conectar a chave", () => {
    const passos = montarChecklist(VAZIA);
    expect(passos.map((p) => [p.id, p.feito])).toEqual([
      ["chave", false], ["plano", false], ["aviso", false], ["compra", false], ["email", false], ["publicar", false],
    ]);
    expect(passos[0]?.href).toBe("/admin/cobranca?aba=conexao");
  });

  it("⭐ o aviso conta pelo último aviso OU por uma assinatura paga com provedor (sobrevive à poda de 90 dias)", () => {
    const conectada = { ...VAZIA, provedor: "stripe" as const, chaveLast4: "4242" };
    expect(passo({ ...conectada, ultimoAvisoEm: "2026-09-30T10:00:00Z" }, "aviso")?.feito).toBe(true);
    expect(passo({ ...conectada, compraConcluida: true }, "aviso")?.feito).toBe(true);
    expect(passo(conectada, "aviso")?.feito).toBe(false);
  });

  it("e-mail não configurado aponta para /admin/email", () => {
    expect(passo(VAZIA, "email")).toMatchObject({ feito: false, href: "/admin/email" });
  });

  it("⭐ o checklist não termina em modo de teste: o plano do cadastro e a publicação são passos, e o de publicar diz que clientes reais não pagam", () => {
    const emTeste = { ...VAZIA, provedor: "stripe" as const, modo: "teste" as const, chaveLast4: "4242", planoDoCadastro: true, compraConcluida: true, emailPronto: true };
    expect(passo(emTeste, "plano")).toMatchObject({ feito: true, href: "/admin/cobranca?aba=planos" });
    expect(passo(emTeste, "publicar")).toMatchObject({ feito: false, href: "/admin/cobranca?aba=conexao" });
    expect(passo(emTeste, "publicar")?.comoFazer).toContain("NÃO conseguem pagar");
    expect(passo({ ...emTeste, modo: "producao" }, "publicar")?.feito).toBe(true);
  });

  it("sem endereço https público, o passo da chave diz o pré-requisito antes de pedir a chave", () => {
    expect(passo({ ...VAZIA, urlDoWebhook: null }, "chave")?.comoFazer).toContain("https público");
  });
});

describe("leituraAtrasada", () => {
  const AGORA = new Date("2026-10-10T12:00:00Z");
  it.each([
    ["2026-10-10T04:00:00Z", true],
    ["2026-10-10T06:00:00Z", false],
    [null, false],
  ] as const)("última leitura %s → atrasada? %s (limite 7 h)", (ultima, atrasada) => {
    expect(leituraAtrasada(ultima, AGORA, 7)).toBe(atrasada);
  });
});

describe("lerVisaoGeral", () => {
  const leitor = (linhas: Array<Record<string, unknown>>) => (c: Cadeia): Resposta => {
    if (c.tabela === "webhook_events_log") {
      if (valorDoFiltro(c, "eq", "valid_signature") === false) return { count: 5 };
      return c.passos.some((p) => p.metodo === "in") ? { count: 3 } : { data: { received_at: "2026-10-09T12:00:00Z" } };
    }
    if (c.tabela === "cobranca_planos") return { data: { id: "plano-do-cadastro" } };
    return { data: linhas };
  };

  it("⭐ a última leitura é o max(relida_em) do conjunto da reconciliação; os problemas saem do estado e as recusas de assinatura aparecem", async () => {
    const responder = leitor([
      { estado: "ativa", ultimo_erro: null, assinaturas_vivas: 2 },
      { estado: "em_atraso", ultimo_erro: "credencial_invalida", assinaturas_vivas: 1 },
      { estado: "cancelada", ultimo_erro: "pagamento_de_assinatura_cancelada", assinaturas_vivas: 0 },
    ]);
    const rpc = (): Resposta => ({
      data: [
        { organization_id: "a", relida_em: "2026-10-10T08:00:00Z", precisa_reler: false },
        { organization_id: "b", relida_em: null, precisa_reler: true },
        { organization_id: "c", relida_em: "2026-10-10T11:00:00Z", precisa_reler: false },
      ],
    });
    const v = await lerVisaoGeral(bancoFalso(responder, rpc).cliente as never);
    expect(v).toMatchObject({
      provedor: "stripe", modo: "teste", chaveLast4: "4242", ultimoAvisoEm: "2026-10-09T12:00:00Z",
      ultimaLeituraEm: "2026-10-10T11:00:00Z", compraConcluida: true, emailPronto: false, planoDoCadastro: true,
      problemas: { credencialInvalida: 1, cobrancaDupla: 1, pagouCancelada: 1, avisosComErro: 3, avisosRecusados: 5 },
    });
  });

  it("⭐ checkout concluído em teste grátis conta como compra (a 1ª cobrança só sai quando o teste acaba)", async () => {
    const v = await lerVisaoGeral(bancoFalso(leitor([{ estado: "trial", ultimo_erro: null, assinaturas_vivas: 1 }]), () => ({ data: [] })).cliente as never);
    expect(v.compraConcluida).toBe(true);
    const sem = await lerVisaoGeral(bancoFalso(leitor([{ estado: "trial", ultimo_erro: null, assinaturas_vivas: 0 }]), () => ({ data: [] })).cliente as never);
    expect(sem.compraConcluida).toBe(false);
  });

  it("⭐ com o Asaas conectado, os 4 últimos saem da chave do Asaas (sem isso o passo da chave nunca marca)", async () => {
    h.provedor = "asaas";
    const v = await lerVisaoGeral(bancoFalso(leitor([]), () => ({ data: [] })).cliente as never);
    expect(h.lidas).toEqual(["ASAAS_API_KEY"]);
    expect(v.chaveLast4).toBe("4242");
  });

  it("⭐ Asaas em teste grátis com a assinatura criada e NADA pago não é compra concluída (o Assinar do Asaas cria a assinatura sem pagamento)", async () => {
    const clicou = await lerVisaoGeral(
      bancoFalso(leitor([{ estado: "trial", ultimo_erro: null, assinaturas_vivas: 1, provedor: "asaas" }]), () => ({ data: [] })).cliente as never,
    );
    expect(clicou.compraConcluida).toBe(false);
    const pagou = await lerVisaoGeral(
      bancoFalso(leitor([{ estado: "ativa", ultimo_erro: null, assinaturas_vivas: 1, provedor: "asaas" }]), () => ({ data: [] })).cliente as never,
    );
    expect(pagou.compraConcluida).toBe(true);
  });
});

describe("checklist com o Asaas (PR 3b)", () => {
  it("⭐ o aviso ensina conferir URL e token do cadastro manual e aponta a Conexão; só marca com o primeiro aviso válido", () => {
    const asaas = { ...VAZIA, provedor: "asaas" as const, modo: "teste" as const, chaveLast4: "0001" };
    expect(passo(asaas, "aviso")).toMatchObject({ feito: false, href: "/admin/cobranca?aba=conexao" });
    expect(passo(asaas, "aviso")?.comoFazer).toContain("token");
    expect(passo({ ...asaas, ultimoAvisoEm: "2026-10-06T10:00:00Z" }, "aviso")?.feito).toBe(true);
    // A releitura do cron ativa sem aviso nenhum: com o aviso manual quebrado, compra feita NÃO prova o aviso.
    expect(passo({ ...asaas, compraConcluida: true }, "aviso")?.feito).toBe(false);
    expect(passo(asaas, "compra")?.comoFazer).toContain("sandbox do Asaas");
    expect(passo(asaas, "compra")?.comoFazer).not.toContain("4242");
    expect(passo(asaas, "publicar")?.comoFazer).toContain("$aact_prod_");
    expect(passo(asaas, "publicar")?.comoFazer).toContain("NÃO conseguem pagar");
  });

  it("controle: a Stripe segue com o texto de sempre", () => {
    const stripe = { ...VAZIA, provedor: "stripe" as const, modo: "teste" as const, chaveLast4: "4242" };
    expect(passo(stripe, "aviso")?.href).toBeNull();
    expect(passo(stripe, "compra")?.comoFazer).toContain("4242 4242 4242 4242");
    expect(passo(stripe, "publicar")?.comoFazer).toContain("sk_live_");
  });
});
