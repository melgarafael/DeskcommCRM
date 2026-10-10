/**
 * Smoke do Asaas, FORA do CI: prova o adaptador contra o SANDBOX real e confere,
 * no dia, o que a spec da cobrança manda conferir antes do merge (§6.2, risco 11
 * da §15 e §16 3.10): as duas bases, o User-Agent, o webhook por API (ou o ramo
 * manual) e a reconexão com a MESMA URL, o `includeDeleted`, as datas civis e o
 * `nextDueDate` além de TODA cobrança gerada, inclusive numa assinatura que nasce
 * a 35 dias do 1º vencimento. Também confere contra o Asaas de verdade o que o
 * dublê do e2e inventou: o `somarCiclo` e quantas cobranças nascem logo de saída.
 * Recusa chave de produção — sempre.
 *
 * Uso: ASAAS_SANDBOX_API_KEY="$(cat ~/.config/deskcomm/asaas-sandbox.key)" pnpm exec tsx scripts/smoke-asaas.ts
 *
 * Efeito no sandbox: cria e remove clientes, uma assinatura (e as cobranças dela)
 * e um webhook de example.com com uma URL própria do smoke, removido no fim.
 * Falha não pula a limpeza: `falha` lança, e o `finally` sempre roda.
 */
import { randomUUID } from "node:crypto";

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";
import { ASAAS_API_BASE, criarAdaptadorAsaas } from "@/lib/cobranca/provedores/asaas";

import { gerarCpf, hojeEmSaoPaulo, somarCiclo } from "../tests/e2e/fixtures/provedor-de-cobranca-asaas";

const chave = process.env.ASAAS_SANDBOX_API_KEY ?? "";
if (!chave) {
  console.error("✗ falta ASAAS_SANDBOX_API_KEY");
  process.exit(2);
}
if (!chave.startsWith("$aact_hmlg_")) {
  console.error("✗ RECUSADO: o smoke só roda com chave do SANDBOX ($aact_hmlg_). Chave de produção nunca.");
  process.exit(3);
}

class FalhaDoSmoke extends Error {}
function falha(msg: string): never {
  throw new FalhaDoSmoke(msg);
}
/** Divergência do Asaas real com o que a spec/dublê supõe: registra e SEGUE (as demais conferências precisam rodar), e o smoke reprova no fim. */
const divergencias: string[] = [];
function divergencia(msg: string): void {
  divergencias.push(msg);
  console.error(`✗ DIVERGÊNCIA: ${msg}`);
}
function ok(msg: string): void {
  console.info(`✓ ${msg}`);
}
const UA = "smoke-cobranca/1.0";
const codigoDoErro = (j: Record<string, unknown>) => JSON.stringify((j.errors as Array<{ code?: string }> | undefined)?.[0]?.code ?? "");

/** Chamada crua, só para o que o adaptador não faz (pagar, listar cru). Nunca imprime a chave. `ua: null` = o padrão do Node. */
async function cru(base: string, metodo: "GET" | "POST" | "PUT" | "DELETE", caminho: string, corpo?: unknown, ua: string | null = UA) {
  const headers: Record<string, string> = { access_token: chave };
  if (ua !== null) headers["user-agent"] = ua;
  if (corpo !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${base}${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}
async function sandbox(metodo: "GET" | "POST" | "PUT" | "DELETE", caminho: string, corpo?: unknown): Promise<Record<string, unknown>> {
  const r = await cru(ASAAS_API_BASE.teste, metodo, caminho, corpo);
  if (r.status >= 400) falha(`${metodo} ${caminho.split("?")[0]} → ${r.status} ${codigoDoErro(r.json)}`);
  return r.json;
}
type CobrancaCrua = { id: string; dueDate: string; status: string; value: number };
const cobrancasDaAssinatura = async (id: string) => ((await sandbox("GET", `/payments?subscription=${id}&limit=100`)).data ?? []) as CobrancaCrua[];
const fimDoDia = (d: string) => new Date(`${d}T23:59:59-03:00`).toISOString();
const diasDepois = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Os webhooks com a URL do smoke (a base, com ou sem `?conexao=`): é por ela que o adaptador reconhece os desta instalação. */
const webhooksDoSmoke = async (url: string) =>
  (((await sandbox("GET", "/webhooks?limit=100")).data ?? []) as Array<{ id: string; url: string | null; events?: string[] }>).filter((x) => ((x.url ?? "").split("?")[0] ?? "") === url);

const orgId = randomUUID();
const adaptador = criarAdaptadorAsaas({ lerChave: async () => chave, marca: `smoke-${orgId.slice(0, 8)}` });
const plano = { id: randomUUID(), nome: "Smoke mensal", precoCents: 4990, intervalo: "mes" as const };
const novo = { id: randomUUID(), nome: "Smoke maior", precoCents: 9990, intervalo: "mes" as const };
const urlDoWebhook = `https://example.com/api/v1/webhooks/cobranca/asaas-smoke-${orgId}`;
const documento = gerarCpf();
let cliente: string | null = null;
let assinatura: string | null = null;
let webhook: string | null = null;
let clienteAlfanumerico: string | null = null;
let clienteFuturo: string | null = null;
let assinaturaFutura: string | null = null;

// tsx compila este arquivo em CJS, sem await no topo: o corpo vai numa função.
async function principal(): Promise<void> {
try {
  // 1. As duas bases (§6.2): a chave do sandbox autentica no sandbox e é recusada na produção.
  const noSandbox = await cru(ASAAS_API_BASE.teste, "GET", "/customers?limit=1");
  const naProducao = await cru(ASAAS_API_BASE.producao, "GET", "/customers?limit=1");
  if (noSandbox.status !== 200) falha(`sandbox respondeu ${noSandbox.status} à chave do sandbox`);
  if (naProducao.status !== 401) falha(`produção respondeu ${naProducao.status} à chave do sandbox (esperado 401: é isso que sustenta modo e base pelo prefixo)`);
  ok(`bases: ${ASAAS_API_BASE.teste} → 200; ${ASAAS_API_BASE.producao} → 401`);
  const semUa = await cru(ASAAS_API_BASE.teste, "GET", "/customers?limit=1", undefined, null);
  ok(`User-Agent padrão do Node → ${semUa.status} (registre no PR; o adaptador manda o próprio)`);

  const t = await adaptador.testarChave({ modoExigido: "teste" });
  if (!t.ok || t.modo !== "teste") falha(`testarChave: ${JSON.stringify(t)}`);
  ok("testarChave: sandbox = teste");

  // 2. Cliente com CPF de teste (verificador certo, gerado agora; o nosso banco nunca o guarda).
  cliente = await adaptador.garantirCliente({ id: orgId, nome: "Smoke", email: `smoke+${orgId.slice(0, 8)}@example.com`, documento });
  if ((await adaptador.garantirCliente({ id: orgId, nome: "Smoke", email: `smoke+${orgId.slice(0, 8)}@example.com`, documento })) !== cliente) {
    falha("garantirCliente duplicou o cliente (externalReference)");
  }
  if (!(await adaptador.clienteExiste(cliente)) || (await adaptador.clienteExiste("cus_000000000000"))) falha("clienteExiste");
  ok("cliente: reaproveitado por externalReference; clienteExiste sim para o da conta, não para o inexistente");
  // Notificações do próprio Asaas ao pagador (o adaptador manda notificationDisabled): MEDIDA, não falha.
  const notificacoes = await cru(ASAAS_API_BASE.teste, "GET", `/customers/${cliente}/notifications`);
  const avisosDoAsaas = (notificacoes.json.data ?? []) as Array<Record<string, unknown>>;
  const ligados = avisosDoAsaas.filter((n) => Object.entries(n).some(([k, v]) => /EnabledForCustomer$/.test(k) && v === true)).length;
  ok(`notificações do Asaas ao pagador (cliente criado com notificationDisabled): HTTP ${notificacoes.status}; ${ligados} de ${avisosDoAsaas.length} configuradas com algum canal ligado; ENTREGA não medida (a configuração por notificação não prova se a flag do cliente barra o envio)`);

  // 2b. CNPJ alfanumérico (exemplo oficial da Receita, sem dono): MEDIDA, não falha.
  const alfa = await cru(ASAAS_API_BASE.teste, "POST", "/customers", { name: "Smoke alfanumérico", cpfCnpj: "12ABC34501DE35", externalReference: `${orgId}-alfa` });
  clienteAlfanumerico = alfa.status === 200 ? String(alfa.json.id) : null;
  ok(`CNPJ alfanumérico → ${alfa.status} ${alfa.status === 200 ? "aceito" : codigoDoErro(alfa.json)} (registre no PR)`);

  // 3. Assinatura sem teste grátis: a 1ª cobrança vence hoje (data civil de São Paulo).
  const inicio = await adaptador.iniciarAssinatura({ clienteRef: cliente, orgId, plano, trialAte: null, urlDeVolta: "https://example.com/app/settings/billing", chaveIdempotencia: randomUUID() });
  if (!/^https:\/\/[a-z.-]*asaas\.com\//.test(inicio.url)) falha("invoiceUrl fora de asaas.com, ou sem https");
  assinatura = inicio.assinaturaRef;
  if (!assinatura) falha("sem assinatura no sandbox depois de iniciarAssinatura");
  const sub = await sandbox("GET", `/subscriptions/${assinatura}`);
  ok(`dateCreated da assinatura = ${String(sub.dateCreated)} (a ordenação assume AAAA-MM-DD; registre no PR)`);
  const geradas = await cobrancasDaAssinatura(assinatura);
  const primeira = [...geradas].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  if (!primeira || primeira.dueDate !== hojeEmSaoPaulo()) falha(`1ª cobrança vence ${primeira?.dueDate}, esperado hoje em SP (${hojeEmSaoPaulo()})`);
  ok(`geração: ${geradas.length} cobranças logo de saída; 1ª vence ${primeira.dueDate}; nextDueDate da assinatura = ${String(sub.nextDueDate)}`);
  // §16 3.10: o nextDueDate é a próxima cobrança AINDA NÃO gerada. Se ele for o vencimento de QUALQUER
  // cobrança já gerada (não só da 1ª: o sandbox pode gerar duas), proximoVencimento e a guarda caem.
  if (geradas.some((c) => c.dueDate >= String(sub.nextDueDate))) {
    divergencia(`nextDueDate (${String(sub.nextDueDate)}) não está além de toda cobrança gerada: a §6.2 (proximoVencimento e a guarda do trocarPlano) parte do contrário — leve ao dono antes do merge (§16 3.10)`);
  }
  // O dublê do e2e gera só a 1ª na criação (alinhado a este sandbox), e o contrato da Task 20 espera 1.
  const doDuble = 1;
  // ATENÇÃO: isto mede "na criação". Se o Asaas gera a próxima cobrança depois (job diário), a régua é outra:
  // releia a MESMA assinatura no dia seguinte antes de mexer no dublê (ver a releitura no fim da corrida).
  if (geradas.length !== doDuble) {
    divergencia(`o sandbox gerou ${geradas.length} cobranças NA CRIAÇÃO e o dublê gera ${doDuble}: decida a régua (criação x geração assíncrona) antes de mexer no DUBLÊ (gerarDevidas) e no toHaveLength(1) da Task 20, não no smoke`);
  }

  // 3b. A geração observada na hora (§16 3.10): 1º vencimento daqui a 35 dias, dentro da antecedência.
  // Outro cliente, para a leitura do cliente principal seguir com uma assinatura viva só.
  const vence35 = diasDepois(hojeEmSaoPaulo(), 35);
  clienteFuturo = String(
    (await sandbox("POST", "/customers", { name: "Smoke futuro", cpfCnpj: gerarCpf(), externalReference: `${orgId}-futuro`, notificationDisabled: true })).id,
  );
  assinaturaFutura = String(
    (await sandbox("POST", "/subscriptions", { customer: clienteFuturo, billingType: "UNDEFINED", value: 49.9, cycle: "MONTHLY", nextDueDate: vence35, description: "Smoke futuro" })).id,
  );
  const subFutura = await sandbox("GET", `/subscriptions/${assinaturaFutura}`);
  const geradasFuturas = await cobrancasDaAssinatura(assinaturaFutura);
  ok(`1º vencimento em ${vence35}: geradas na criação = ${geradasFuturas.length}; nextDueDate = ${String(subFutura.nextDueDate)}`);
  if (geradasFuturas.length === 0) {
    divergencia("com o 1º vencimento a 35 dias, nenhuma cobrança nasceu na criação: no teste grátis, o Assinar daria cobranca_ainda_nao_gerada (§6.2). Leve ao dono antes do merge");
  }
  if (geradasFuturas.some((c) => c.dueDate >= String(subFutura.nextDueDate))) {
    divergencia(`a 35 dias, o nextDueDate (${String(subFutura.nextDueDate)}) não está além da cobrança gerada (§16 3.10)`);
  }

  // 4. Clicar em Assinar e não pagar não é assinar (§6.2 passo 2).
  const pendente = await adaptador.lerSituacao({ clienteRef: cliente });
  if (pendente.existe || pendente.assinaturasVivas !== 1 || pendente.jaPagou || pendente.linkDePagamento === null) falha(`lerSituacao com só PENDING: ${pendente.statusBruto}`);
  ok("só PENDING: existe=false, 1 viva, link de pagamento presente");

  // 5. Guarda do trocarPlano: período em uso pendente → recusa sem tocar no Asaas.
  try {
    await adaptador.trocarPlano({ assinaturaRef: assinatura, plano: novo });
    falha("trocarPlano aceitou com o período em uso pendente");
  } catch (e) {
    if (!(e instanceof ErroDoProvedor) || e.codigo !== "pagamento_do_periodo_pendente") throw e;
  }
  ok("trocarPlano recusa com o período em uso pendente (pagamento_do_periodo_pendente)");

  // 6. Paga a 1ª (receiveInCash: o pagamento que o sandbox aceita por API; RECEIVED_IN_CASH conta como pago).
  await sandbox("POST", `/payments/${primeira.id}/receiveInCash`, { paymentDate: hojeEmSaoPaulo(), value: primeira.value, notifyCustomer: false });
  const paga = await adaptador.lerSituacao({ clienteRef: cliente });
  const fimEsperado = fimDoDia(somarCiclo(primeira.dueDate, "MONTHLY"));
  if (!paga.existe || !paga.jaPagou || paga.emAtraso) falha(`lerSituacao depois do pagamento: ${paga.statusBruto}`);
  if (paga.proximoVencimento?.toISOString() !== fimEsperado) {
    falha(`proximoVencimento ${paga.proximoVencimento?.toISOString()} ≠ ${fimEsperado} (vencimento pago + 1 mês, 23:59:59 em São Paulo)`);
  }
  ok(`pago: existe, jaPagou; fim do período ${fimEsperado} (somarCiclo do dublê = calendário do Asaas)`);

  // 7. Troca depois de pago: PUT com updatePendingPayments; a paga fica com o valor antigo.
  await adaptador.trocarPlano({ assinaturaRef: assinatura, plano: novo });
  const depois = await cobrancasDaAssinatura(assinatura);
  const pendentes = depois.filter((c) => c.status === "PENDING");
  if (pendentes.some((c) => c.value !== 99.9) || (await sandbox("GET", `/subscriptions/${assinatura}`)).value !== 99.9) falha("trocarPlano não levou o valor novo às pendentes");
  if (depois.find((c) => c.id === primeira.id)?.value !== 49.9) falha("trocarPlano mudou a cobrança já paga");
  ok(`trocarPlano (PUT): assinatura e ${pendentes.length} pendentes com R$ 99,90; a paga segue com R$ 49,90`);

  // 8. Cancelar: DELETE; sem includeDeleted a removida SOME (por isso a spec o exige).
  await adaptador.cancelarNoFim(assinatura);
  const sem = ((await sandbox("GET", `/subscriptions?customer=${cliente}`)).data ?? []) as unknown[];
  const com = ((await sandbox("GET", `/subscriptions?customer=${cliente}&includeDeleted=true`)).data ?? []) as Array<{ id: string; deleted?: boolean }>;
  if (sem.length !== 0 || !com.some((s) => s.id === assinatura && s.deleted === true)) falha(`includeDeleted: sem=${sem.length} com=${com.length}`);
  const cancelada = await adaptador.lerSituacao({ clienteRef: cliente });
  if (!cancelada.cancelada || cancelada.proximoVencimento?.toISOString() !== fimEsperado) falha(`depois do DELETE: ${cancelada.statusBruto}`);
  const restantes = (await cobrancasDaAssinatura(assinatura)).filter((c) => c.status === "PENDING");
  ok(`cancelar: sem includeDeleted a assinatura some; com ele, deleted=true; cancelada e o período pago fica; pendentes que sobraram = ${restantes.length} (a §6.2 passo 8 supõe 0)`);
  assinatura = null;

  // 9. Webhook por API, ou o ramo manual (os dois são caminhos válidos da §6.2). O log do adaptador
  // (`cobranca.asaas.webhook_manual`) diz o code da recusa: se for o `apiVersion`, tire-o do corpo (Divergência 9).
  const w = await adaptador.prepararWebhook(urlDoWebhook, "smoke@example.com");
  if ("manual" in w) {
    ok(`WEBHOOK MANUAL: a API recusou criar; a tela mostra o passo a passo (${w.manual.eventos.length} eventos)`);
  } else {
    await w.confirmar();
    const primeiros = await webhooksDoSmoke(urlDoWebhook);
    webhook = primeiros[0]?.id ?? null;
    if (primeiros.length !== 1) falha(`webhooks com a URL do smoke: ${primeiros.length}`);
    ok(`webhook por API: 1 endpoint com ${primeiros[0]?.events?.length ?? 0} eventos; authToken de 43 caracteres aceito (não impresso)`);
    // Reconexão na MESMA conta (trocar ou rotacionar a chave): o adaptador cria o novo com a mesma URL
    // mais `?conexao=`, porque o Asaas recusa URL idêntica (400 invalid_object, medido).
    const deNovo = await adaptador.prepararWebhook(urlDoWebhook, "smoke@example.com");
    if ("manual" in deNovo) {
      falha("a 2ª conexão caiu no ramo manual: a URL com ?conexao= foi recusada, e toda reconexão quebraria o aviso. Leve ao dono");
    }
    await deNovo.confirmar();
    const depois = await webhooksDoSmoke(urlDoWebhook);
    webhook = depois[0]?.id ?? null;
    if (depois.length !== 1 || depois[0]?.id === primeiros[0]?.id) falha(`reconexão: ${depois.length} webhooks com a URL do smoke, e o que sobrou ${depois[0]?.id === primeiros[0]?.id ? "é o ANTIGO" : "é o novo"}`);
    ok("reconexão: criou de novo pela API (URL com ?conexao=), e o confirmar deixou só o novo");
    // desfazer: apaga só o novo e o aviso anterior fica de pé.
    const terceiro = await adaptador.prepararWebhook(urlDoWebhook, "smoke@example.com");
    if ("manual" in terceiro) falha("a 3ª conexão caiu no ramo manual");
    else await terceiro.desfazer();
    const aposDesfazer = await webhooksDoSmoke(urlDoWebhook);
    if (aposDesfazer.length !== 1 || aposDesfazer[0]?.id !== depois[0]?.id) falha(`desfazer: ${aposDesfazer.length} avisos, e o anterior ${aposDesfazer[0]?.id === depois[0]?.id ? "ficou" : "SUMIU"}`);
    ok("desfazer apagou só o novo; o aviso anterior continua");
  }
  // Releitura no fim da corrida: a geração ocorreu depois da criação? (só distingue "assíncrono em segundos"; "job diário" pede reler no dia seguinte)
  if (assinaturaFutura) {
    ok(`releitura final da assinatura a 35 dias: ${(await cobrancasDaAssinatura(assinaturaFutura)).length} cobranças`);
  }
  if (divergencias.length > 0) falha(`${divergencias.length} divergência(s) com o dublê/spec; leve ao dono (lista acima)`);
} catch (e) {
  console.error(`✗ SMOKE ASAAS FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  // pela URL do smoke (base, com e sem query), não só pelo id capturado
  for (const x of await webhooksDoSmoke(urlDoWebhook).catch(() => [])) await cru(ASAAS_API_BASE.teste, "DELETE", `/webhooks/${x.id}`).catch(() => null);
  if (webhook) await cru(ASAAS_API_BASE.teste, "DELETE", `/webhooks/${webhook}`).catch(() => null);
  if (assinatura) await cru(ASAAS_API_BASE.teste, "DELETE", `/subscriptions/${assinatura}`).catch(() => null);
  if (cliente) await cru(ASAAS_API_BASE.teste, "DELETE", `/customers/${cliente}`).catch(() => null);
  if (clienteAlfanumerico) await cru(ASAAS_API_BASE.teste, "DELETE", `/customers/${clienteAlfanumerico}`).catch(() => null);
  if (assinaturaFutura) await cru(ASAAS_API_BASE.teste, "DELETE", `/subscriptions/${assinaturaFutura}`).catch(() => null);
  if (clienteFuturo) await cru(ASAAS_API_BASE.teste, "DELETE", `/customers/${clienteFuturo}`).catch(() => null);
}
if (process.exitCode !== 1) console.info("✓ SMOKE ASAAS OK");
}
void principal();
