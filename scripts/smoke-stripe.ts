/**
 * Smoke da Stripe, FORA do CI: prova o adaptador contra a conta de TESTE real,
 * na STRIPE_VERSION fixada. Recusa chave de produção — sempre.
 *
 * Uso: STRIPE_TEST_SECRET_KEY="$(cat ~/.config/deskcomm/stripe-teste.key)" pnpm exec tsx scripts/smoke-stripe.ts
 *
 * Efeito na conta de teste: cria e apaga um cliente e uma assinatura, arquiva
 * dois produtos, e cria um endpoint de webhook de example.com com uma marca
 * PRÓPRIA do smoke (smoke-<uuid>), apagado no fim. Os endpoints de qualquer
 * instalação que use a mesma conta de teste ficam intocados.
 */
import { randomUUID } from "node:crypto";

import { criarAdaptadorStripe, emFormulario, modoDaChaveStripe, STRIPE_API_BASE, STRIPE_VERSION } from "@/lib/cobranca/provedores/stripe";

const chave = process.env.STRIPE_TEST_SECRET_KEY ?? "";
if (!chave) {
  console.error("✗ falta STRIPE_TEST_SECRET_KEY");
  process.exit(2);
}
if (modoDaChaveStripe(chave) !== "teste") {
  console.error("✗ RECUSADO: o smoke só roda com chave de TESTE (sk_test_ ou rk_test_). Chave de produção nunca.");
  process.exit(3);
}

// Lança em vez de sair: `process.exit` não roda o `finally`, e a conta de teste
// ficava com cliente, assinatura e endpoint a cada checagem vermelha.
function falha(msg: string): never {
  throw new Error(`SMOKE STRIPE FAIL: ${msg}`);
}
function ok(msg: string): void {
  console.info(`✓ ${msg}`);
}

/** Chamada crua, só para o que o adaptador não faz (montar a assinatura paga). Nunca imprime a chave. */
async function stripe(metodo: "GET" | "POST" | "DELETE", caminho: string, corpo?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${STRIPE_API_BASE}${caminho}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${chave}`,
      "stripe-version": STRIPE_VERSION,
      ...(corpo ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: corpo ? emFormulario(corpo) : undefined,
  });
  const json = (await r.json()) as Record<string, unknown>;
  if (!r.ok) falha(`${metodo} ${caminho.split("?")[0]} → ${r.status} ${JSON.stringify((json.error as { code?: string } | undefined)?.code ?? "")}`);
  return json;
}

async function main(): Promise<void> {
  const orgId = randomUUID();
  const adaptador = criarAdaptadorStripe({ lerChave: async () => chave, marca: `smoke-${orgId.slice(0, 8)}` });
  const plano = { id: randomUUID(), nome: "Smoke mensal", precoCents: 4990, intervalo: "mes" as const };
  const novo = { id: randomUUID(), nome: "Smoke maior", precoCents: 9990, intervalo: "mes" as const };
  const urlDoWebhook = `https://example.com/api/v1/webhooks/cobranca/stripe-smoke-${orgId}`;
  let cliente: string | null = null;
  let assinatura: string | null = null;
  let endpoint: string | null = null;

  try {
    const t = await adaptador.testarChave({ modoExigido: "teste" });
    if (!t.ok || t.modo !== "teste") falha(`testarChave: ${JSON.stringify(t)}`);
    const recusa = await adaptador.testarChave({ modoExigido: "producao" });
    if (recusa.ok || recusa.motivo !== "modo_divergente") falha("modoExigido=producao aceitou chave de teste");
    ok(`chave de teste aceita na versão ${STRIPE_VERSION}; produção exigida recusa`);

    cliente = await adaptador.garantirCliente({ id: orgId, nome: "Smoke", email: `smoke+${orgId.slice(0, 8)}@example.com`, documento: null });
    ok(`cliente ${cliente.slice(0, 8)}…`);
    if (!(await adaptador.clienteExiste(cliente)) || (await adaptador.clienteExiste("cus_NaoExisteNestaConta0"))) falha("clienteExiste");
    ok("clienteExiste: o da conta sim, o inexistente não (a guarda da troca de chave)");

    const checkout = await adaptador.iniciarAssinatura({
      clienteRef: cliente, orgId, plano, trialAte: null,
      urlDeVolta: "https://example.com/app/settings/billing", chaveIdempotencia: randomUUID(),
    });
    if (!checkout.url.startsWith("https://checkout.stripe.com/")) falha("checkout sem URL da Stripe");
    ok("Checkout em modo assinatura criado");

    const pm = await stripe("POST", "/payment_methods/pm_card_visa/attach", { customer: cliente });
    await stripe("POST", `/customers/${cliente}`, { invoice_settings: { default_payment_method: pm.id } });
    const criada = await stripe("POST", "/subscriptions", {
      customer: cliente,
      items: [{ price_data: { currency: "brl", unit_amount: plano.precoCents, recurring: { interval: "month" }, product: `dc_plano_${plano.id}` } }],
      metadata: { organization_id: orgId, plano_id: plano.id },
    });
    assinatura = String(criada.id);

    const s = await adaptador.lerSituacao({ clienteRef: cliente });
    const dias = s.proximoVencimento ? (s.proximoVencimento.getTime() - Date.now()) / 86_400_000 : -1;
    if (!s.existe || s.emAtraso || !s.jaPagou || s.assinaturasVivas !== 1) falha(`lerSituacao: ${s.statusBruto}`);
    if (dias < 27 || dias > 32) falha(`current_period_end do item não é o fim do mês pago (dias=${dias.toFixed(1)})`);
    ok(`lerSituacao: ativa, paga, fim do período em ${dias.toFixed(1)} dias (current_period_end do item)`);

    await adaptador.trocarPlano({ assinaturaRef: assinatura, plano: novo });
    const trocada = await stripe("GET", `/subscriptions/${assinatura}`);
    const preco = (trocada.items as { data: Array<{ price: { unit_amount: number } }> }).data[0]?.price.unit_amount;
    const faturas = (await stripe("GET", `/invoices?subscription=${assinatura}&limit=10`)).data as unknown[];
    if (preco !== novo.precoCents || faturas.length !== 1) falha(`trocarPlano: preço=${preco} faturas=${faturas.length}`);
    ok("trocarPlano: preço novo no item, nenhuma fatura de proração");

    await adaptador.cancelarNoFim(assinatura);
    const c = await adaptador.lerSituacao({ clienteRef: cliente });
    if (!c.cancelaNoFim || !c.existe) falha("cancelarNoFim não aparece na leitura");
    ok("cancelarNoFim: segue ativa até o fim do período");

    const portal = await adaptador.urlDeGerenciar({ clienteRef: cliente, urlDeVolta: "https://example.com/app" });
    if (!portal?.startsWith("https://billing.stripe.com/")) falha("portal sem URL da Stripe");
    ok("portal do cliente aberto com a configuração da instalação");

    const w = await adaptador.prepararWebhook(urlDoWebhook, "smoke@example.com");
    if (!("segredo" in w) || !w.segredo.startsWith("whsec_")) falha("prepararWebhook sem segredo");
    await w.confirmar();
    const lista = (await stripe("GET", "/webhook_endpoints?limit=100")).data as Array<{ id: string; url: string }>;
    const nossos = lista.filter((e) => e.url === urlDoWebhook);
    if (nossos.length !== 1) falha(`endpoints com a URL do smoke: ${nossos.length}`);
    endpoint = nossos[0]?.id ?? null;
    ok("prepararWebhook + confirmar: um endpoint, segredo whsec_ devolvido (não impresso)");
  } finally {
    // Cada passo isolado: uma limpeza que falha não pode deixar as outras para trás.
    const limpar = async (o: string, f: () => Promise<unknown>) => {
      try {
        await f();
      } catch (e) {
        console.error(`✗ limpeza (${o}) falhou: ${e instanceof Error ? e.message : "desconhecido"}`);
      }
    };
    if (endpoint) await limpar("endpoint", () => stripe("DELETE", `/webhook_endpoints/${endpoint}`));
    if (assinatura) await limpar("assinatura", () => stripe("DELETE", `/subscriptions/${assinatura}`));
    if (cliente) await limpar("cliente", () => stripe("DELETE", `/customers/${cliente}`));
    for (const p of [plano, novo]) await limpar(`produto ${p.id}`, () => stripe("POST", `/products/dc_plano_${p.id}`, { active: false }));
  }
  console.info(`✓ SMOKE STRIPE OK (versão ${STRIPE_VERSION})`);
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : "SMOKE STRIPE ERRO desconhecido"}`);
  process.exitCode = 1;
});
