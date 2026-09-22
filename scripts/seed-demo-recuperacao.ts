/**
 * Seed de demonstração — IA RECUPERANDO CLIENTES PELO RADAR.
 *
 * Cada cenário tem HISTÓRICO REAL de compras (commercial_orders antigas) para
 * o radar classificar de verdade (`lib/comercial/radar-compras.ts`), mais a
 * conversa onde a IA retoma o cliente:
 *
 *   1. Seu Zé         — recompra_atrasada  → compra: boleto 14, entregue.
 *   2. Dona Cida      — em_risco           → não compra: encerra com elegância.
 *   3. Paulo          — oportunidade_aberta → adia: orçamento segue valendo.
 *   4. Roberto        — cancelado_sem_nova → recompra: pedido remontado.
 *   5. Lúcia          — em_voo             → entrega: carga + agradecimento.
 *
 * Todo arco termina em agradecimento, comprou ou não. Efeito colateral
 * HONESTO: quem comprou sai do radar (recuperado não é mais risco) — Cida e
 * Paulo seguem lá como exemplos vivos.
 *
 * A primeira mensagem da IA é `type='template'` (fora da janela de 24h só
 * template sai — `JanelaFechadaAviso`). Sem pedido em aberto nos cenários
 * 1/2/4 de propósito: pedido aberto muda a classificação do radar.
 *
 * Idempotente via `.demo-recuperacao.json`. Não toca em dado real.
 *
 * Run: npx tsx scripts/seed-demo-recuperacao.ts [--org <uuid>]
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  anunciarDestino,
  credenciaisSupabaseDeTeste,
} from "./lib/env-de-teste";

const cred = credenciaisSupabaseDeTeste();
anunciarDestino("seed-demo-recuperacao", cred);

const admin = createClient(cred.url, cred.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const STATE_PATH = path.join(process.cwd(), ".demo-recuperacao.json");

interface DemoState {
  orgId: string;
  contactIds: string[];
  conversationIds: string[];
  orderIds: string[];
  shipmentIds: string[];
}

function lerEstado(): DemoState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as DemoState;
  } catch {
    return null;
  }
}

function isoHaHorasAtras(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

type Fala = {
  haHoras: number;
  dir: "in" | "out";
  texto: string;
  template?: { nome: string; idioma: string };
};

interface Cenario {
  telefone: string;
  nome: string;
  fantasia: string;
  unread: number;
  /** vendas antigas (dias atrás, total em cents) que alimentam o radar. */
  historico: { diasAtras: number; total: number; produto: string }[];
  falas: Fala[];
}

const TPL = { nome: "recuperacao_recompra", idioma: "pt_BR" };

const CENARIOS: Cenario[] = [
  {
    telefone: "+5511933311122",
    nome: "Seu Zé",
    fantasia: "Bar do Zé",
    unread: 0,
    historico: [
      { diasAtras: 95, total: 15000, produto: "Desinfetante lavanda 5L" },
      { diasAtras: 65, total: 17500, produto: "Desinfetante lavanda 5L" },
      { diasAtras: 35, total: 15000, produto: "Desinfetante lavanda 5L" },
    ],
    falas: [
      { haHoras: 100, dir: "out", texto: "Oi Seu Zé! Aqui é da limpeza 🧼 Faz 35 dias do seu último pedido de desinfetante — bora repor o estoque do bar? Tenho uma condição especial pra você!", template: TPL },
      { haHoras: 99, dir: "in", texto: "Opa! Manda 12 desinfetantes então!" },
      { haHoras: 98.95, dir: "out", texto: "O lavanda 5L de sempre?" },
      { haHoras: 98.9, dir: "in", texto: "Isso, esse mesmo!" },
      { haHoras: 98.85, dir: "out", texto: "Fechado: 12x desinfetante lavanda 5L = R$ 300,00! Gero no boleto 14 dias?" },
      { haHoras: 98, dir: "in", texto: "Pode gerar, boleto 14!" },
      { haHoras: 97.9, dir: "out", texto: "Pedido gerado! ✅ 12x desinfetante lavanda 5L = R$ 300,00 no boleto 14 dias. Te aviso quando sair pra entrega. Obrigado!" },
      { haHoras: 30, dir: "out", texto: "Seu Zé, sua compra saiu pra entrega e chega ainda hoje! 🚚 O boleto segue no e-mail." },
      { haHoras: 29.5, dir: "in", texto: "Chegou aqui, tudo certo. Valeu!" },
      { haHoras: 29.4, dir: "out", texto: "Que bom! Obrigado pela preferência! 🙏 Até a próxima!" },
    ],
  },
  {
    telefone: "+5511933322233",
    nome: "Dona Cida",
    fantasia: "Mercearia Cida",
    unread: 0,
    historico: [
      { diasAtras: 150, total: 8900, produto: "AGUA SANITARIA BILL 5 L" },
      { diasAtras: 115, total: 19900, produto: "SACO DE LIXO PRETO 100L" },
      { diasAtras: 80, total: 14900, produto: "ESTOPA 1 KG" },
    ],
    falas: [
      { haHoras: 74, dir: "out", texto: "Dona Cida, sentimos sua falta! Faz 80 dias que não pede com a gente 😟 O que houve? Consigo 5% off + boleto em 30 dias pra reativar sua conta. Topa conversar?", template: TPL },
      { haHoras: 30, dir: "out", texto: "Dona Cida, passando pra lembrar: os 5% off + boleto em 30 dias valem até sexta! Quer aproveitar? 🙂", template: TPL },
      { haHoras: 2, dir: "in", texto: "Obrigada, mas agora não dá. Me chama mês que vem?" },
      { haHoras: 1.9, dir: "out", texto: "Sem problemas! Fico no aguardo e te chamo mês que vem. Obrigado! 🙏" },
    ],
  },
  {
    telefone: "+5511933333344",
    nome: "Paulo",
    fantasia: "Padaria Pão Dourado",
    unread: 0,
    historico: [
      { diasAtras: 60, total: 7560, produto: "DETERGENTE 500 ML" },
      { diasAtras: 30, total: 9360, produto: "DETERGENTE 500 ML" },
    ],
    falas: [
      { haHoras: 50, dir: "out", texto: "Paulo, aquele orçamento de 30 estopas (R$ 240,00) ainda tá valendo! Quer que eu feche pra você? 🤝", template: TPL },
      { haHoras: 49, dir: "in", texto: "Quanto que ficava mesmo?" },
      { haHoras: 48.9, dir: "out", texto: "R$ 240,00 (R$ 8,00 cada)! E no PIX te faço R$ 225,00 👀" },
      { haHoras: 5, dir: "in", texto: "Vou deixar pro mês que vem, sem fluxo agora" },
      { haHoras: 4.9, dir: "out", texto: "Tranquilo, Paulo! O orçamento segue valendo. Me chama quando precisar. Obrigado! 🤝" },
    ],
  },
  {
    telefone: "+5511933344455",
    nome: "Roberto",
    fantasia: "Auto Posto Lima",
    unread: 0,
    historico: [
      { diasAtras: 65, total: 14400, produto: "Sabão em pó girando sol 800g" },
      { diasAtras: 30, total: 17280, produto: "Sabão em pó girando sol 800g" },
    ],
    falas: [
      { haHoras: 76, dir: "out", texto: "Roberto, vimos que seu último pedido foi cancelado. O que aconteceu? Quer que eu remonte ele pra você?", template: TPL },
      { haHoras: 52, dir: "in", texto: "Chegou atrasado da outra vez, por isso cancelei" },
      { haHoras: 51.9, dir: "out", texto: "Entendo, e peço desculpas! 🙏 Remonto aquele de 12 sabões Girando Sol (R$ 144,00) no dinheiro como da última vez?" },
      { haHoras: 51, dir: "in", texto: "Remonta então. Mas se atrasar de novo eu cancelo" },
      { haHoras: 50.9, dir: "out", texto: "Pedido remontado! ✅ 12x sabão Girando Sol 800g = R$ 144,00 no dinheiro. Vai na carga de amanhã de manhã e te aviso quando sair. Obrigado pela confiança!" },
      { haHoras: 50, dir: "in", texto: "Combinado, obrigado!" },
    ],
  },
  {
    telefone: "+5511933355566",
    nome: "Lúcia",
    fantasia: "Salão Bela",
    unread: 0,
    historico: [
      { diasAtras: 75, total: 25000, produto: "DESINFETANTE LAVANDA 5L" },
      { diasAtras: 42, total: 30000, produto: "DESINFETANTE LAVANDA 5L" },
    ],
    falas: [
      { haHoras: 55, dir: "out", texto: "Lúcia, seu pedido está em separação e sai na próxima carga! 🚚 Chega ainda essa semana.", template: TPL },
      { haHoras: 54.5, dir: "in", texto: "Oba! Manda junto 6 solubill?" },
      { haHoras: 54.45, dir: "out", texto: "O de 2L?" },
      { haHoras: 54.42, dir: "in", texto: "Isso!" },
      { haHoras: 54.4, dir: "out", texto: "Anotado! Adiciono os 6 Solubill 2L (R$ 179,40) no mesmo pedido. Te aviso quando sair pra entrega! ✅" },
      { haHoras: 26, dir: "out", texto: "Lúcia, saiu pra entrega! 🚚 Chega ainda hoje. O boleto 7 dias segue no e-mail!" },
      { haHoras: 25.5, dir: "in", texto: "Chegou tudo certo por aqui. Obrigada!" },
      { haHoras: 25.4, dir: "out", texto: "Que ótimo! Obrigado pela preferência! 🙏" },
    ],
  },
];

async function resolverOrg(): Promise<{ id: string; nome: string }> {
  const flag = process.argv.indexOf("--org");
  const porArg = flag >= 0 ? process.argv[flag + 1] : undefined;
  const orgId = porArg ?? process.env.SEED_ORG_ID ?? null;
  if (orgId) {
    const { data, error } = await admin
      .from("organizations")
      .select("id, display_name")
      .eq("id", orgId)
      .maybeSingle();
    if (error || !data) throw new Error(`org ${orgId} não encontrada: ${error?.message}`);
    const row = data as { id: string; display_name: string };
    return { id: row.id, nome: row.display_name };
  }
  const { data, error } = await admin
    .from("organizations")
    .select("id, display_name")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(`nenhuma organização no banco: ${error?.message}`);
  const row = data as { id: string; display_name: string };
  return { id: row.id, nome: row.display_name };
}

async function resolverSessao(orgId: string): Promise<string> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, status")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`lendo channel_sessions: ${error.message}`);
  const linhas = (data ?? []) as { id: string; status: string }[];
  const viva = linhas.find((s) => s.status === "WORKING") ?? linhas[0];
  if (!viva) throw new Error("Nenhuma sessão de canal nesta org.");
  return viva.id;
}

/** Vincula aos produtos REAIS do catálogo (a demo fala o preço da loja). */
async function buscarProdutos(orgId: string, codigos: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const codigo of codigos) {
    const { data, error } = await admin
      .from("catalog_products")
      .select("id")
      .eq("organization_id", orgId)
      .eq("codigo", codigo)
      .maybeSingle();
    if (error || !data) throw new Error(`produto real ${codigo} sumiu do catálogo: ${error?.message}`);
    ids.set(codigo, (data as { id: string }).id);
  }
  return ids;
}

async function limparDemoAnterior(estado: DemoState): Promise<void> {
  for (const sid of estado.shipmentIds ?? []) {
    const { data: vinc } = await admin
      .from("shipment_orders")
      .select("id")
      .eq("shipment_id", sid);
    for (const v of (vinc ?? []) as { id: string }[]) {
      await admin.from("shipment_orders").delete().eq("id", v.id);
    }
    await admin.from("shipments").delete().eq("id", sid);
  }
  for (const id of estado.orderIds) {
    await admin.from("commercial_orders").delete().eq("id", id);
  }
  for (const id of estado.conversationIds) {
    await admin.from("conversations").delete().eq("id", id);
  }
  console.log("[seed] demo anterior apagada");
}

async function criarCargaConcluida(args: {
  orgId: string;
  motorista: string;
  placa: string;
  pedidoId: string;
}): Promise<string> {
  const { data: numero, error: numErr } = await admin.rpc(
    "fn_proximo_numero_carga" as never,
    { p_org: args.orgId } as never,
  );
  if (numErr || typeof numero !== "number") throw new Error(`contador carga: ${numErr?.message}`);
  const { data: carga, error: cargaErr } = await admin
    .from("shipments")
    .insert({
      organization_id: args.orgId,
      numero,
      placa: args.placa,
      veiculo_tipo: "Van",
      motorista_nome: args.motorista,
      status: "concluida",
    })
    .select("id")
    .single();
  if (cargaErr || !carga) throw new Error(`carga: ${cargaErr?.message}`);
  const cargaId = (carga as { id: string }).id;
  const { error: vincErr } = await admin.from("shipment_orders").insert({
    organization_id: args.orgId,
    shipment_id: cargaId,
    order_id: args.pedidoId,
    sequencia: 1,
    status: "entregue",
  });
  if (vincErr) throw new Error(`vínculo carga: ${vincErr.message}`);
  console.log(`[seed] carga ${numero} (concluida, ${args.motorista})`);
  return cargaId;
}

async function proximoNumeroPedido(orgId: string): Promise<number> {
  const { data, error } = await admin.rpc("fn_proximo_numero_pedido" as never, {
    p_org: orgId,
  } as never);
  if (error || typeof data !== "number") throw new Error(`contador: ${error?.message}`);
  return data;
}

async function garantirContato(orgId: string, c: Cenario): Promise<string> {
  const { data: existe } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("phone_number", c.telefone)
    .maybeSingle();
  if (existe) return (existe as { id: string }).id;
  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: orgId,
      name: c.nome,
      display_name: c.nome,
      fantasia: c.fantasia,
      phone_number: c.telefone,
      cidade: "São Paulo",
      uf: "SP",
      source: "manual",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`contato ${c.nome}: ${error?.message}`);
  return (data as { id: string }).id;
}

/** Venda antiga (já entregue) — é o que o radar lê. */
async function criarVendaAntiga(args: {
  orgId: string;
  contactId: string;
  clienteNome: string;
  diasAtras: number;
  total: number;
  produto: string;
}): Promise<string> {
  const numero = await proximoNumeroPedido(args.orgId);
  const iso = isoHaHorasAtras(args.diasAtras * 24);
  const { data: ped, error: pedErr } = await admin
    .from("commercial_orders")
    .insert({
      organization_id: args.orgId,
      numero,
      contact_id: args.contactId,
      cliente_nome: args.clienteNome,
      status: "entregue",
      origem: "vendedor",
      moeda: "BRL",
      subtotal_cents: args.total,
      total_cents: args.total,
      condicao_pagamento: "Boleto 14 dias",
      observacoes: "Venda histórica da demo de recuperação via radar.",
      created_at: iso,
      updated_at: iso,
    })
    .select("id")
    .single();
  if (pedErr || !ped) throw new Error(`venda antiga: ${pedErr?.message}`);
  const pedId = (ped as { id: string }).id;
  const { error: itemErr } = await admin.from("commercial_order_items").insert({
    organization_id: args.orgId,
    order_id: pedId,
    product_id: null,
    produto_codigo: "HIST",
    produto_nome: args.produto,
    quantidade: 1,
    preco_unit_cents: args.total,
    desconto_pct: 0,
    subtotal_cents: args.total,
    posicao: 1,
  });
  if (itemErr) throw new Error(`item histórico: ${itemErr.message}`);
  return pedId;
}

async function criarConversa(
  orgId: string,
  sessionId: string,
  contactId: string,
  c: Cenario,
): Promise<string> {
  const { data: antigas } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId);
  for (const a of (antigas ?? []) as { id: string }[]) {
    await admin.from("conversations").delete().eq("id", a.id);
  }

  const ordenadas = [...c.falas].sort((a, b) => b.haHoras - a.haHoras);
  const ultima = ordenadas[ordenadas.length - 1]!;
  const ultimoIso = isoHaHorasAtras(ultima.haHoras);
  const ultimoInbound = [...ordenadas].reverse().find((f) => f.dir === "in");
  const ultimoOutbound = [...ordenadas].reverse().find((f) => f.dir === "out");

  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .insert({
      organization_id: orgId,
      contact_id: contactId,
      channel_session_id: sessionId,
      channel: "whatsapp",
      status: "ai_handling",
      last_inbound_at: ultimoInbound ? isoHaHorasAtras(ultimoInbound.haHoras) : null,
      last_outbound_at: ultimoOutbound ? isoHaHorasAtras(ultimoOutbound.haHoras) : null,
      last_message_at: ultimoIso,
      last_message_preview: ultima.texto.slice(0, 120),
      unread_count_for_assignee: c.unread,
      metadata: { demo: "recuperacao", cenario: c.nome },
    })
    .select("id")
    .single();
  if (convErr || !conv) throw new Error(`conversa ${c.nome}: ${convErr?.message}`);
  const convId = (conv as { id: string }).id;

  for (const f of ordenadas) {
    const iso = isoHaHorasAtras(f.haHoras);
    const { error: msgErr } = await admin.from("messages").insert({
      organization_id: orgId,
      conversation_id: convId,
      channel_session_id: sessionId,
      contact_id: contactId,
      type: f.template ? "template" : "text",
      template_name: f.template?.nome ?? null,
      template_language: f.template?.idioma ?? null,
      direction: f.dir === "in" ? "inbound" : "outbound",
      status: f.dir === "in" ? "received" : "sent",
      body: f.texto,
      sent_via: f.dir === "in" ? "crm" : "ai",
      sent_at: iso,
      delivered_at: f.dir === "out" ? iso : null,
      read_at: f.dir === "out" && f.haHoras > 1 ? iso : null,
      created_at: iso,
      updated_at: iso,
      metadata: { demo: "recuperacao" },
    });
    if (msgErr) throw new Error(`mensagem ${c.nome}: ${msgErr.message}`);
  }
  const { error: fixErr } = await admin
    .from("conversations")
    .update({
      last_inbound_at: ultimoInbound ? isoHaHorasAtras(ultimoInbound.haHoras) : null,
      last_outbound_at: ultimoOutbound ? isoHaHorasAtras(ultimoOutbound.haHoras) : null,
      last_message_at: ultimoIso,
      last_message_preview: ultima.texto.slice(0, 120),
      unread_count_for_assignee: c.unread,
    })
    .eq("id", convId);
  if (fixErr) throw new Error(`recalque ${c.nome}: ${fixErr.message}`);
  console.log(`[seed] conversa ${c.nome}: ${ordenadas.length} mensagens`);
  return convId;
}

async function main(): Promise<void> {
  const org = await resolverOrg();
  console.log(`[seed] org: ${org.nome} (${org.id})`);
  const sessionId = await resolverSessao(org.id);

  const anterior = lerEstado();
  if (anterior && anterior.orgId === org.id) await limparDemoAnterior(anterior);

  const idsProdutos = await buscarProdutos(org.id, ["73", "758", "466", "385"]);

  const contactIds: string[] = [];
  const conversationIds: string[] = [];
  const orderIds: string[] = [];

  for (const c of CENARIOS) {
    const contactId = await garantirContato(org.id, c);
    contactIds.push(contactId);
    for (const v of c.historico) {
      orderIds.push(
        await criarVendaAntiga({
          orgId: org.id,
          contactId,
          clienteNome: `${c.nome} — ${c.fantasia}`,
          diasAtras: v.diasAtras,
          total: v.total,
          produto: v.produto,
        }),
      );
    }
    conversationIds.push(await criarConversa(org.id, sessionId, contactId, c));
  }

  // Paulo: orçamento parado (rascunho) — é o que o radar lê como oportunidade.
  const pauloId = contactIds[2]!;
  const numero = await proximoNumeroPedido(org.id);
  const { data: orc, error: orcErr } = await admin
    .from("commercial_orders")
    .insert({
      organization_id: org.id,
      numero,
      contact_id: pauloId,
      cliente_nome: "Paulo — Padaria Pão Dourado",
      status: "rascunho",
      origem: "ia",
      moeda: "BRL",
      subtotal_cents: 24000,
      total_cents: 24000,
      condicao_pagamento: "PIX",
      observacoes: "Orçamento demo: 30x estopa, aguardando aceite.",
      created_at: isoHaHorasAtras(5 * 24),
      updated_at: isoHaHorasAtras(5 * 24),
    })
    .select("id")
    .single();
  if (orcErr || !orc) throw new Error(`orçamento Paulo: ${orcErr?.message}`);
  const orcId = (orc as { id: string }).id;
  orderIds.push(orcId);
  await admin.from("commercial_order_items").insert({
    organization_id: org.id,
    order_id: orcId,
    product_id: idsProdutos.get("466") ?? null,
    produto_codigo: "466",
    produto_nome: "ESTOPA 1 KG",
    quantidade: 30,
    preco_unit_cents: 800,
    desconto_pct: 0,
    subtotal_cents: 24000,
    posicao: 1,
  });

  // Roberto: o cancelado após a última compra — é o que o radar lê.
  const robertoId = contactIds[3]!;
  const numeroCanc = await proximoNumeroPedido(org.id);
  const { data: canc, error: cancErr } = await admin
    .from("commercial_orders")
    .insert({
      organization_id: org.id,
      numero: numeroCanc,
      contact_id: robertoId,
      cliente_nome: "Roberto — Auto Posto Lima",
      status: "cancelado",
      origem: "vendedor",
      moeda: "BRL",
      subtotal_cents: 14400,
      total_cents: 14400,
      condicao_pagamento: "Dinheiro",
      observacoes: "Cancelado demo: chegou atrasado.",
      created_at: isoHaHorasAtras(20 * 24),
      updated_at: isoHaHorasAtras(20 * 24),
    })
    .select("id")
    .single();
  if (cancErr || !canc) throw new Error(`cancelado Roberto: ${cancErr?.message}`);
  orderIds.push((canc as { id: string }).id);

  // Zé: recuperado de verdade — boleto 14, entregue. Sai do radar (é o
  // sinal de que a recuperação funcionou).
  const zeId = contactIds[0]!;
  const numeroZe = await proximoNumeroPedido(org.id);
  const { data: pedZe, error: pedZeErr } = await admin
    .from("commercial_orders")
    .insert({
      organization_id: org.id,
      numero: numeroZe,
      contact_id: zeId,
      cliente_nome: "Seu Zé — Bar do Zé",
      status: "entregue",
      origem: "ia",
      moeda: "BRL",
      subtotal_cents: 30000,
      total_cents: 30000,
      condicao_pagamento: "Boleto 14 dias",
      endereco_entrega: "Rua do Bar, 100 — São Paulo/SP",
      observacoes: "Recuperado pelo radar: recompra atrasada.",
      created_at: isoHaHorasAtras(4 * 24),
      updated_at: isoHaHorasAtras(30),
    })
    .select("id")
    .single();
  if (pedZeErr || !pedZe) throw new Error(`pedido Zé: ${pedZeErr?.message}`);
  const pedZeId = (pedZe as { id: string }).id;
  orderIds.push(pedZeId);
  await admin.from("commercial_order_items").insert({
    organization_id: org.id,
    order_id: pedZeId,
    product_id: idsProdutos.get("73") ?? null,
    produto_codigo: "73",
    produto_nome: "DESINFETANTE LAVANDA 5L",
    quantidade: 12,
    preco_unit_cents: 2500,
    desconto_pct: 0,
    subtotal_cents: 30000,
    posicao: 1,
  });

  // Roberto: pedido remontado no dinheiro, aprovado, entrando na próxima carga.
  const numeroRob = await proximoNumeroPedido(org.id);
  const { data: pedRob, error: pedRobErr } = await admin
    .from("commercial_orders")
    .insert({
      organization_id: org.id,
      numero: numeroRob,
      contact_id: robertoId,
      cliente_nome: "Roberto — Auto Posto Lima",
      status: "aprovado",
      origem: "ia",
      moeda: "BRL",
      subtotal_cents: 14400,
      total_cents: 14400,
      condicao_pagamento: "Dinheiro",
      endereco_entrega: "Rodovia, km 12 — São Paulo/SP",
      observacoes: "Recuperado pelo radar: remontado após cancelamento.",
      created_at: isoHaHorasAtras(2 * 24),
      updated_at: isoHaHorasAtras(2 * 24),
    })
    .select("id")
    .single();
  if (pedRobErr || !pedRob) throw new Error(`pedido Roberto: ${pedRobErr?.message}`);
  const pedRobId = (pedRob as { id: string }).id;
  orderIds.push(pedRobId);
  await admin.from("commercial_order_items").insert({
    organization_id: org.id,
    order_id: pedRobId,
    product_id: idsProdutos.get("758") ?? null,
    produto_codigo: "758",
    produto_nome: "SABÃO EM PÓ GIRANDO SOL 800G",
    quantidade: 12,
    preco_unit_cents: 1200,
    desconto_pct: 0,
    subtotal_cents: 14400,
    posicao: 1,
  });

  // Lúcia: pedido PARADO em aberto (aprovado há 42 dias) — é o que o radar
  // lê como "em voo". Pedido aberto recente contaria como venda e zeraria o
  // relógio (contaComoVenda): em voo de verdade é intenção que não anda.
  // Agora entregue (o arco fecha): sai do radar como recuperada.
  const luciaId = contactIds[4]!;
  const numeroLucia = await proximoNumeroPedido(org.id);
  const { data: aberto, error: abertoErr } = await admin
    .from("commercial_orders")
    .insert({
      organization_id: org.id,
      numero: numeroLucia,
      contact_id: luciaId,
      cliente_nome: "Lúcia — Salão Bela",
      status: "entregue",
      origem: "ia",
      moeda: "BRL",
      subtotal_cents: 47940,
      total_cents: 47940,
      condicao_pagamento: "Boleto 7 dias",
      endereco_entrega: "Rua das Flores, 45 — São Paulo/SP",
      observacoes: "Recuperado pelo radar: estava em voo, entregue.",
      created_at: isoHaHorasAtras(42 * 24),
      updated_at: isoHaHorasAtras(26),
    })
    .select("id")
    .single();
  if (abertoErr || !aberto) throw new Error(`pedido Lúcia: ${abertoErr?.message}`);
  const abertoId = (aberto as { id: string }).id;
  orderIds.push(abertoId);
  await admin.from("commercial_order_items").insert([
    {
      organization_id: org.id,
      order_id: abertoId,
      product_id: idsProdutos.get("73") ?? null,
      produto_codigo: "73",
      produto_nome: "DESINFETANTE LAVANDA 5L",
      quantidade: 12,
      preco_unit_cents: 2500,
      desconto_pct: 0,
      subtotal_cents: 30000,
      posicao: 1,
    },
    {
      organization_id: org.id,
      order_id: abertoId,
      product_id: idsProdutos.get("385") ?? null,
      produto_codigo: "385",
      produto_nome: "SOLUBILL 2L",
      quantidade: 6,
      preco_unit_cents: 2990,
      desconto_pct: 0,
      subtotal_cents: 17940,
      posicao: 2,
    },
  ]);

  // Cargas concluídas dos dois recuperados que receberam.
  const shipmentIds = [
    await criarCargaConcluida({
      orgId: org.id,
      motorista: "Carlos Silva (demo)",
      placa: "ABC1D23",
      pedidoId: pedZeId,
    }),
    await criarCargaConcluida({
      orgId: org.id,
      motorista: "João Pereira (demo)",
      placa: "XYZ9K88",
      pedidoId: abertoId,
    }),
  ];

  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      { orgId: org.id, contactIds, conversationIds, orderIds, shipmentIds } as DemoState,
      null,
      2,
    ),
  );

  console.log(
    `\n✅ Recuperação pronta: 5 conversas, ${orderIds.length} pedidos, ${shipmentIds.length} cargas.` +
      `\n   Inbox: /app/inbox · Radar: /app/radar · Expedição: /app/expedicao`,
  );
}

main().catch((err) => {
  console.error("❌ Seed recuperação falhou:", err);
  process.exit(1);
});
