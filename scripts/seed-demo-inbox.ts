/**
 * Seed de demonstração do INBOX — 5 conversas com jornada completa de venda.
 *
 * Do primeiro contato ao fechamento: a IA responde com preço do catálogo,
 * negocia, fecha o pedido (PIX / boleto / cartão), e dias depois avisa que a
 * carga saiu para entrega (aba Expedição). As 5 cobrem as abas da tela:
 *
 *   1. Juliana Prado  — jornada COMPLETA, pedido entregue, conversa fechada.
 *   2. Carlos Menezes — pedido expedido, carga EM ROTA, aviso enviado hoje.
 *   3. Ana Ferreira   — negociação aberta, escolhendo pagamento agora.
 *   4. Marcos Tavares — pediu humano, IA escalou, AGUARDANDO atendente (Fila).
 *   5. Patrícia Souza — primeiro contato hoje, início de funil.
 *
 * Idempotente: guarda os ids em `.demo-inbox.json`; re-rodar apaga a demo
 * anterior (na ordem de dependência) e recria. Não toca em dado real — tudo
 * é achado por telefone +55 11 9xxxx com prefixo de demo.
 *
 * Run: npx tsx scripts/seed-demo-inbox.ts [--org <uuid>]
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  anunciarDestino,
  credenciaisSupabaseDeTeste,
} from "./lib/env-de-teste";

const cred = credenciaisSupabaseDeTeste();
anunciarDestino("seed-demo-inbox", cred);

const admin = createClient(cred.url, cred.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const STATE_PATH = path.join(process.cwd(), ".demo-inbox.json");
// Silêncio "durável" do handoff sem depender do literal 'infinity' do PostgREST.
const SILENCIO_LONGO = "2999-01-01T00:00:00.000Z";

interface DemoState {
  orgId: string;
  sessionId: string;
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

// ---------------------------------------------------------------------------
// produtos do catálogo (o preço que a IA "responde" nas mensagens)
// ---------------------------------------------------------------------------

/**
 * Produtos REAIS do catálogo da org (não inventar: a IA da demo tem de falar
 * o preço que a loja pratica). `preco` é o esperado pelo roteiro — se a loja
 * reprecificar, o seed avisa e usa o real.
 */
const PRODUTOS_REAIS = [
  { codigo: "758", nome: "SABÃO EM PÓ GIRANDO SOL 800G", preco: 1200 },
  { codigo: "2", nome: "AGUA SANITARIA BILL 5 L", preco: 1600 },
  { codigo: "73", nome: "DESINFETANTE LAVANDA 5L", preco: 2500 },
  { codigo: "78", nome: "DETERGENTE 500 ML", preco: 320 },
  { codigo: "466", nome: "ESTOPA 1 KG", preco: 800 },
  { codigo: "385", nome: "SOLUBILL 2L", preco: 2990 },
] as const;

// Códigos inventados pela primeira versão deste seed — removidos em favor
// dos reais acima (a loja tem 600+ itens; demo não duplica catálogo).
const CODIGOS_INVENTADOS = [
  "SABAO-PO-1KG", "AGUA-SAN-2L", "DETERG-500", "DESINF-2L", "ESTOPA-1KG",
  "SULUBILL-500", "RODO-40", "SACO-LIXO-100", "ALCOOL-70-1L", "PANO-CHAO",
];

// ---------------------------------------------------------------------------
// roteiros (horas atrás → direção → texto). `out` = IA (sent_via='ai').
// ---------------------------------------------------------------------------

type Fala = { haHoras: number; dir: "in" | "out"; texto: string };

interface Cenario {
  telefone: string;
  nome: string;
  fantasia: string;
  status: string;
  unread: number;
  silencio?: boolean;
  handoff?: string;
  falas: Fala[];
}

const CENARIOS: Cenario[] = [
  {
    telefone: "+5511982214470",
    nome: "Juliana Prado",
    fantasia: "Mercadinho Prado",
    status: "closed",
    unread: 0,
    falas: [
      { haHoras: 9 * 24 + 4, dir: "in", texto: "Oi bom dia! Vocês têm sabão em pó? Qual o valor?" },
      { haHoras: 9 * 24 + 3.9, dir: "out", texto: "Bom dia, Juliana! 😊 Temos o Girando Sol em 800g (R$ 12,00) e 1,6kg (R$ 24,00) — qual te atende?" },
      { haHoras: 9 * 24 + 3.5, dir: "in", texto: "O de 800g. Quero 20 unidades. Faz um precinho?" },
      { haHoras: 9 * 24 + 3.4, dir: "out", texto: "Para 20 unidades consigo R$ 11,00 cada, total R$ 220,00! Fechamos? 🤝" },
      { haHoras: 9 * 24 + 3, dir: "in", texto: "Fechado! Quais as formas de pagamento de vocês?" },
      { haHoras: 9 * 24 + 2.9, dir: "out", texto: "Aceitamos PIX, dinheiro e boleto em 7, 14 ou 30 dias! Qual fica melhor pra você?" },
      { haHoras: 9 * 24 + 2.5, dir: "in", texto: "PIX. E a entrega, chega quando?" },
      { haHoras: 9 * 24 + 2.4, dir: "out", texto: "Aqui pra região entregamos em até 2 dias úteis! Me confirma o endereço de entrega?" },
      { haHoras: 9 * 24 + 2, dir: "in", texto: "Rua das Palmeiras, 210" },
      { haHoras: 9 * 24 + 1.9, dir: "out", texto: "Pedido gerado: 20x Sabão Girando Sol 800g — R$ 220,00 no PIX. Entrega: Rua das Palmeiras, 210. Tá certinho?" },
      { haHoras: 9 * 24 + 1.8, dir: "in", texto: "Tá certo, pode fechar!" },
      { haHoras: 9 * 24 + 1.7, dir: "out", texto: "Fechado! ✅ Pagamento no PIX confirmado. Assim que a carga sair pra entrega te aviso por aqui. Obrigado pela preferência!" },
      { haHoras: 2 * 24 + 9, dir: "out", texto: "Bom dia, Juliana! 🚚 Sua compra saiu pra entrega hoje e chega até às 17h. Qualquer coisa me chama por aqui!" },
      { haHoras: 2 * 24 + 8.5, dir: "in", texto: "Oba, fico no aguardo. Obrigada!" },
      { haHoras: 1 * 24 + 1, dir: "out", texto: "Pedido entregue! ✅ Obrigado pela preferência, e conte com a gente pra reposição!" },
    ],
  },
  {
    telefone: "+5511977712233",
    nome: "Carlos Menezes",
    fantasia: "Hotel Bela Vista",
    status: "ai_handling",
    unread: 0,
    falas: [
      { haHoras: 4 * 24 + 6, dir: "in", texto: "Olá, preciso de água sanitária e desinfetante pro hotel. Quais os valores?" },
      { haHoras: 4 * 24 + 5.9, dir: "out", texto: "Olá, Carlos! Água sanitária Bill 5L R$ 16,00, essa é única! Desinfetante temos lavanda, eucalipto, pinho e blue (5L, R$ 25,00) — qual prefere?" },
      { haHoras: 4 * 24 + 5.5, dir: "in", texto: "Lavanda. 30 de cada. Tem tudo a pronta entrega?" },
      { haHoras: 4 * 24 + 5.4, dir: "out", texto: "Temos sim, estoque cheio dos dois! 🙌 Dá R$ 480,00 + R$ 750,00 = R$ 1.230,00. Posso fechar?" },
      { haHoras: 4 * 24 + 5, dir: "in", texto: "Fecha. Como funciona o pagamento aí?" },
      { haHoras: 4 * 24 + 4.9, dir: "out", texto: "Trabalhamos com PIX, dinheiro e boleto em 7, 14 ou 30 dias. O que prefere?" },
      { haHoras: 4 * 24 + 4.5, dir: "in", texto: "Boleto pra 14 dias, pode ser?" },
      { haHoras: 4 * 24 + 4.4, dir: "out", texto: "Pode sim! Pedido gerado no boleto 14 dias — R$ 1.230,00. Qual o endereço de entrega?" },
      { haHoras: 4 * 24 + 4, dir: "in", texto: "Av. Bela Vista, 1500" },
      { haHoras: 4 * 24 + 3.9, dir: "out", texto: "Anotado! ✅ Assim que sair pra entrega te aviso por aqui. Obrigado, Carlos!" },
      { haHoras: 3, dir: "out", texto: "Bom dia, Carlos! 🚚 Sua compra saiu pra entrega e chega ainda hoje. O boleto segue no e-mail. Obrigado!" },
    ],
  },
  {
    telefone: "+5511966655544",
    nome: "Ana Ferreira",
    fantasia: "Distribuidora Ferreira",
    status: "ai_handling",
    unread: 1,
    falas: [
      { haHoras: 26, dir: "in", texto: "Consegue mandar a tabela de preços atualizada?" },
      { haHoras: 25.9, dir: "out", texto: "Claro, Ana! De quais produtos você precisa do preço? Me fala os itens que já te passo todos! 📋" },
      { haHoras: 25.7, dir: "in", texto: "Detergente, água sanitária e desinfetante" },
      { haHoras: 25.6, dir: "out", texto: "Água Bill 5L R$ 16,00, essa é única! Mas detergente temos 500ml (R$ 3,20) e 5L (R$ 25,00), e desinfetante tem lavanda, eucalipto e pinho (5L, R$ 25,00). Quais você quer?" },
      { haHoras: 25.5, dir: "in", texto: "Detergente 500ml, 50 unidades. Tem desconto acima de 40?" },
      { haHoras: 25.4, dir: "out", texto: "Tem! Acima de 40 unidades o detergente sai R$ 2,90 cada: 50x = R$ 145,00. Quer fechar?" },
      { haHoras: 5, dir: "in", texto: "Quero. E o pagamento, como fica?" },
      { haHoras: 4.9, dir: "out", texto: "PIX, dinheiro ou boleto em 7, 14 ou 30 dias — você escolhe! Qual prefere?" },
      { haHoras: 4.5, dir: "in", texto: "Boleto de 7 dias. Preciso passar o endereço?" },
      { haHoras: 4.4, dir: "out", texto: "Isso! Me passa o endereço de entrega que já gero seu pedido no boleto 7 dias: 50x detergente = R$ 145,00 📝" },
      { haHoras: 0.3, dir: "in", texto: "Rua do Comércio, 88, centro. Pode gerar!" },
    ],
  },
  {
    telefone: "+5511955544433",
    nome: "Marcos Tavares",
    fantasia: "Supermercado Boa Vista",
    status: "open",
    unread: 1,
    silencio: true,
    handoff: "pediu_vendedor",
    falas: [
      { haHoras: 3.5, dir: "in", texto: "Preciso de cotação pra 200 águas sanitárias. Qual o valor?" },
      { haHoras: 3.4, dir: "out", texto: "Oi, Marcos! A água sanitária Bill 5L sai R$ 16,00 — em 200 unidades faço R$ 15,00 cada, total R$ 3.000,00! Fechamos?" },
      { haHoras: 3, dir: "in", texto: "Quero falar com um vendedor antes de fechar" },
      { haHoras: 2.9, dir: "out", texto: "Claro! Já chamei um vendedor pra te atender aqui mesmo. Só um instante! 👨‍💼" },
    ],
  },
  {
    telefone: "+5511944433322",
    nome: "Patrícia Souza",
    fantasia: "Rede Higienize",
    status: "ai_handling",
    unread: 0,
    falas: [
      { haHoras: 1.2, dir: "in", texto: "Oi! Vocês entregam aos sábados?" },
      { haHoras: 1.1, dir: "out", texto: "Oi, Patrícia! Sim, entregamos aos sábados na região até às 12h! 😊 Quer fazer um pedido pra aproveitar a rota de amanhã?" },
      { haHoras: 0.8, dir: "in", texto: "Que bom! Me passa o valor da estopa?" },
      { haHoras: 0.7, dir: "out", texto: "Temos vários tipos! Estopa 1kg R$ 8,00 · 2kg R$ 20,00 · 5kg R$ 35,00 · branca 5kg R$ 65,00 · 10kg R$ 70,00. Qual te atende?" },
      { haHoras: 0.6, dir: "in", texto: "A de 1kg mesmo. E o solubill, qual o valor?" },
      { haHoras: 0.55, dir: "out", texto: "Estopa 1kg R$ 8,00 anotada! O Solubill 2L sai R$ 29,90 — a dupla queridinha da limpeza 😄 Quantos separo de cada?" },
      { haHoras: 0.4, dir: "in", texto: "E o pagamento, aceitam dinheiro na entrega?" },
      { haHoras: 0.35, dir: "out", texto: "Aceitamos sim! Dinheiro, PIX e boleto em 7, 14 ou 30 dias — como preferir! 💰" },
      { haHoras: 0.1, dir: "in", texto: "Vou ver aqui com meu sócio e te chamo amanhã, tá?" },
      { haHoras: 0.08, dir: "out", texto: "Combinado! Fico no aguardo — qualquer dúvida é só chamar! 😉" },
    ],
  },
];

// ---------------------------------------------------------------------------
// apoio
// ---------------------------------------------------------------------------

function isoHaHorasAtras(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

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

async function resolverSessao(orgId: string): Promise<{ id: string; nome: string }> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, waha_session_name, status")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`lendo channel_sessions: ${error.message}`);
  const linhas = (data ?? []) as { id: string; waha_session_name: string; status: string }[];
  const viva = linhas.find((s) => s.status === "WORKING") ?? linhas[0];
  if (!viva) {
    throw new Error(
      "Nenhuma sessão de canal nesta org — conecte um número (Conexões) antes de semear o inbox.",
    );
  }
  return { id: viva.id, nome: viva.waha_session_name };
}

async function limparDemoAnterior(estado: DemoState): Promise<void> {
  // Ordem de dependência: carga→pedidos→itens (cascade)→conversas→mensagens (cascade).
  if (estado.shipmentIds.length > 0) {
    const { data: vinc } = await admin
      .from("shipment_orders")
      .select("id")
      .in("shipment_id", estado.shipmentIds);
    for (const v of (vinc ?? []) as { id: string }[]) {
      await admin.from("shipment_orders").delete().eq("id", v.id);
    }
    for (const id of estado.shipmentIds) {
      await admin.from("shipments").delete().eq("id", id);
    }
  }
  for (const id of estado.orderIds) {
    await admin.from("commercial_orders").delete().eq("id", id);
  }
  for (const id of estado.conversationIds) {
    await admin.from("conversations").delete().eq("id", id);
  }
  console.log("[seed] demo anterior apagada");
}

async function garantirProdutos(orgId: string): Promise<Map<string, string>> {
  // Remove os códigos inventados pela 1ª versão do seed (a loja tem catálogo
  // real; demo não duplica). Só os manuais com esses códigos — nunca os dela.
  for (const codigo of CODIGOS_INVENTADOS) {
    const { error } = await admin
      .from("catalog_products")
      .delete()
      .eq("organization_id", orgId)
      .eq("codigo", codigo)
      .eq("origem", "manual");
    if (error) throw new Error(`limpando ${codigo}: ${error.message}`);
  }
  // Vincula aos REAIS. Se a loja reprecificar, avisa (o roteiro fala o preço
  // em texto) mas usa o real no pedido.
  const ids = new Map<string, string>();
  for (const p of PRODUTOS_REAIS) {
    const { data, error } = await admin
      .from("catalog_products")
      .select("id, nome, preco_cents")
      .eq("organization_id", orgId)
      .eq("codigo", p.codigo)
      .maybeSingle();
    if (error || !data) throw new Error(`produto real ${p.codigo} sumiu do catálogo: ${error?.message}`);
    const row = data as { id: string; nome: string; preco_cents: number };
    if (row.preco_cents !== p.preco) {
      console.warn(
        `[seed] ⚠ ${p.codigo} reprecificado na loja (roteiro diz R$ ${(p.preco / 100).toFixed(2)}, catálogo R$ ${(row.preco_cents / 100).toFixed(2)}) — diálogo pode estar mentindo`,
      );
    }
    ids.set(p.codigo, row.id);
  }
  console.log(`[seed] ${ids.size} produtos reais vinculados`);
  return ids;
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

async function criarConversa(
  orgId: string,
  sessionId: string,
  contactId: string,
  c: Cenario,
): Promise<{ id: string; ultima: Fala }> {
  // Apaga conversa anterior deste contato (mensagens caem em cascade).
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
      status: c.status,
      last_inbound_at: ultimoInbound ? isoHaHorasAtras(ultimoInbound.haHoras) : null,
      last_outbound_at: ultimoOutbound ? isoHaHorasAtras(ultimoOutbound.haHoras) : null,
      last_message_at: ultimoIso,
      last_message_preview: ultima.texto.slice(0, 120),
      unread_count_for_assignee: c.unread,
      bot_silenced_until: c.silencio ? SILENCIO_LONGO : null,
      last_handoff_at: c.handoff ? isoHaHorasAtras(2.9) : null,
      last_handoff_reason: c.handoff ?? null,
      metadata: { demo: "inbox-5", cenario: c.nome },
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
      type: "text",
      direction: f.dir === "in" ? "inbound" : "outbound",
      status: f.dir === "in" ? "received" : "sent",
      body: f.texto,
      sent_via: f.dir === "in" ? "crm" : "ai",
      sent_at: iso,
      delivered_at: f.dir === "out" ? iso : null,
      read_at: f.dir === "out" && f.haHoras > 1 ? iso : null,
      created_at: iso,
      updated_at: iso,
      metadata: { demo: "inbox-5" },
    });
    if (msgErr) throw new Error(`mensagem ${c.nome}: ${msgErr.message}`);
  }
  // Recalque final: os triggers de mensagem (0161/0162) mexem nos contadores
  // durante os inserts — o roteiro é quem manda no estado final da demo.
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
  console.log(`[seed] conversa ${c.nome}: ${ordenadas.length} mensagens (${c.status})`);
  return { id: convId, ultima };
}

async function proximoNumero(fn: "fn_proximo_numero_pedido" | "fn_proximo_numero_carga", orgId: string): Promise<number> {
  const { data, error } = await admin.rpc(fn as never, { p_org: orgId } as never);
  if (error || typeof data !== "number") throw new Error(`${fn}: ${error?.message}`);
  return data;
}

async function criarPedido(args: {
  orgId: string;
  contactId: string;
  clienteNome: string;
  status: string;
  pagamento: string;
  endereco: string;
  itens: { codigo: string; qtd: number; preco: number }[];
  produtos: Map<string, string>;
  haHoras: number;
}): Promise<string> {
  const numero = await proximoNumero("fn_proximo_numero_pedido", args.orgId);
  const subtotal = args.itens.reduce((s, i) => s + i.qtd * i.preco, 0);
  const iso = isoHaHorasAtras(args.haHoras);
  const { data: ped, error: pedErr } = await admin
    .from("commercial_orders")
    .insert({
      organization_id: args.orgId,
      numero,
      contact_id: args.contactId,
      cliente_nome: args.clienteNome,
      status: args.status,
      origem: "ia",
      moeda: "BRL",
      subtotal_cents: subtotal,
      total_cents: subtotal,
      condicao_pagamento: args.pagamento,
      endereco_entrega: args.endereco,
      observacoes: "Pedido demo do seed de inbox (jornada Juliana/Carlos).",
      created_at: iso,
      updated_at: iso,
    })
    .select("id")
    .single();
  if (pedErr || !ped) throw new Error(`pedido ${numero}: ${pedErr?.message}`);
  const pedId = (ped as { id: string }).id;
  let pos = 1;
  for (const item of args.itens) {
    const prodId = args.produtos.get(item.codigo);
    const nome = PRODUTOS_REAIS.find((p) => p.codigo === item.codigo)!.nome;
    const { error: itemErr } = await admin.from("commercial_order_items").insert({
      organization_id: args.orgId,
      order_id: pedId,
      product_id: prodId ?? null,
      produto_codigo: item.codigo,
      produto_nome: nome,
      quantidade: item.qtd,
      preco_unit_cents: item.preco,
      desconto_pct: 0,
      subtotal_cents: item.qtd * item.preco,
      posicao: pos++,
    });
    if (itemErr) throw new Error(`item ${item.codigo}: ${itemErr.message}`);
  }
  console.log(`[seed] pedido PED-${String(numero).padStart(4, "0")} (${args.status}, ${args.pagamento})`);
  return pedId;
}

async function criarCarga(args: {
  orgId: string;
  status: string;
  motorista: string;
  placa: string;
  pedidos: { id: string; status: string }[];
}): Promise<string> {
  const numero = await proximoNumero("fn_proximo_numero_carga", args.orgId);
  const { data: carga, error: cargaErr } = await admin
    .from("shipments")
    .insert({
      organization_id: args.orgId,
      numero,
      placa: args.placa,
      veiculo_tipo: "Van",
      motorista_nome: args.motorista,
      status: args.status,
    })
    .select("id")
    .single();
  if (cargaErr || !carga) throw new Error(`carga ${numero}: ${cargaErr?.message}`);
  const cargaId = (carga as { id: string }).id;
  let seq = 1;
  for (const p of args.pedidos) {
    const { error: vincErr } = await admin.from("shipment_orders").insert({
      organization_id: args.orgId,
      shipment_id: cargaId,
      order_id: p.id,
      sequencia: seq++,
      status: p.status,
    });
    if (vincErr) throw new Error(`vínculo carga: ${vincErr.message}`);
  }
  console.log(`[seed] carga ${numero} (${args.status}, ${args.motorista})`);
  return cargaId;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const org = await resolverOrg();
  console.log(`[seed] org: ${org.nome} (${org.id})`);
  const sessao = await resolverSessao(org.id);
  console.log(`[seed] sessão: ${sessao.nome}`);

  const anterior = lerEstado();
  if (anterior && anterior.orgId === org.id) await limparDemoAnterior(anterior);

  const produtos = await garantirProdutos(org.id);

  const conversationIds: string[] = [];
  const contatos = new Map<string, string>();
  for (const c of CENARIOS) {
    const contactId = await garantirContato(org.id, c);
    contatos.set(c.telefone, contactId);
    const { id } = await criarConversa(org.id, sessao.id, contactId, c);
    conversationIds.push(id);
  }

  // Pedido 1 — Juliana: 20x Girando Sol 800g a 11,00 = 220,00, PIX, ENTREGUE.
  const pedJuliana = await criarPedido({
    orgId: org.id,
    contactId: contatos.get("+5511982214470")!,
    clienteNome: "Juliana Prado — Mercadinho Prado",
    status: "entregue",
    pagamento: "PIX",
    endereco: "Rua das Palmeiras, 210 — São Paulo/SP",
    itens: [{ codigo: "758", qtd: 20, preco: 1100 }],
    produtos,
    haHoras: 9 * 24 + 1.9,
  });

  // Pedido 2 — Carlos: 30x1600 + 30x2500 = 1.230,00, boleto 14d, EXPEDIDO.
  const pedCarlos = await criarPedido({
    orgId: org.id,
    contactId: contatos.get("+5511977712233")!,
    clienteNome: "Carlos Menezes — Hotel Bela Vista",
    status: "expedido",
    pagamento: "Boleto 14 dias",
    endereco: "Av. Bela Vista, 1500 — São Paulo/SP",
    itens: [
      { codigo: "2", qtd: 30, preco: 1600 },
      { codigo: "73", qtd: 30, preco: 2500 },
    ],
    produtos,
    haHoras: 4 * 24 + 3.9,
  });

  // Pedido 3 — Ana: acabou de mandar o endereço; em operação real o pedido
  // nasce como RASCUNHO aguardando a confirmação final. 50x290 = 145,00.
  const pedAna = await criarPedido({
    orgId: org.id,
    contactId: contatos.get("+5511966655544")!,
    clienteNome: "Ana Ferreira — Distribuidora Ferreira",
    status: "rascunho",
    pagamento: "Boleto 7 dias",
    endereco: "Rua do Comércio, 88, centro — São Paulo/SP",
    itens: [{ codigo: "78", qtd: 50, preco: 290 }],
    produtos,
    haHoras: 0.3,
  });

  // Cargas: uma concluída (Juliana) e uma em rota (Carlos).
  const carga1 = await criarCarga({
    orgId: org.id,
    status: "concluida",
    motorista: "Carlos Silva (demo)",
    placa: "ABC1D23",
    pedidos: [{ id: pedJuliana, status: "entregue" }],
  });
  const carga2 = await criarCarga({
    orgId: org.id,
    status: "em_rota",
    motorista: "João Pereira (demo)",
    placa: "XYZ9K88",
    pedidos: [{ id: pedCarlos, status: "em_rota" }],
  });

  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        orgId: org.id,
        sessionId: sessao.id,
        conversationIds,
        orderIds: [pedJuliana, pedCarlos, pedAna],
        shipmentIds: [carga1, carga2],
      } as DemoState,
      null,
      2,
    ),
  );

  console.log(
    `\n✅ Demo pronta: 5 conversas, 3 pedidos, 2 cargas.` +
      `\n   Inbox: /app/inbox · Pedidos: /app/pedidos · Expedição: /app/expedicao`,
  );
}

main().catch((err) => {
  console.error("❌ Seed demo inbox falhou:", err);
  process.exit(1);
});
