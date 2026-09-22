/**
 * Importador Mercos → DeskcommCRM (fase 7).
 *
 * Lê a extração em %TEMP%/opencode/mercos e grava com service role:
 *   produtos-pag-*.json → catalog_products (upsert por organization_id+codigo)
 *   clientes-final.json  → contacts (match por CNPJ/CPF/telefone/nome)
 *   pedido-*.json        → commercial_orders + commercial_order_items,
 *                          SEMPRE com contact_id resolvido (cria stub quando o
 *                          cliente do pedido não existe na base).
 *
 * Vínculo pedido→cliente (exigência do dono):
 *   1. dígitos do documento do cabeçalho (CNPJ da tela "CLIENTE ... - doc")
 *   2. nome normalizado forte (sem LTDA/ME/pontuação)
 *   3. fallback: cria contato stub `mercos:pedido-sem-cadastro` — todo pedido
 *      sai linkado, nenhum órfão.
 *
 * Uso:
 *   pnpm exec tsx scripts/mercos-scrape/importar-mercos.ts --org <uuid> [--fase tudo|produtos|contatos|pedidos] [--apply] [--limite N] [--vendedores map.json]
 * Sem --apply é DRY-RUN (só conta e valida, não grava).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalPhoneBR } from "../../lib/channels/phone-variants";
import { hashCpf } from "../../lib/contacts/cpf";
import { precoParaCentavos } from "../../lib/schemas/produtos";
import { carregarEnvLocal } from "../lib/env-de-teste";

const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

/* ── normalização ─────────────────────────────────────────────── */

function digitos(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

function nomeForte(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(LTDA|ME|EPP|EIRELI|CIA|COMERCIO|COM|E|DE|DA|DO|DOS|DAS|SA|S)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function foneCanonico(raw: string | null | undefined): string | null {
  const d = digitos(raw);
  if (!d) return null;
  const comDDI = d.length === 10 || d.length === 11 ? `55${d}` : d;
  try {
    return canonicalPhoneBR(`+${comDDI}`);
  } catch {
    return `+${comDDI}`;
  }
}

function reaisParaCents(txt: string | null | undefined): number {
  if (!txt) return 0;
  const v = precoParaCentavos(txt);
  return v ?? 0;
}

function parseDataBR(txt: string | null | undefined): string | null {
  const m = (txt ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T12:00:00Z`;
}

/* ── parsing do pedido Mercos ─────────────────────────────────── */

interface ItemMercos {
  codigo: string;
  nome: string;
  qtd: number;
  precoTabCents: number;
  descontoPct: number;
  precoLiqCents: number;
  subtotalCents: number;
}

interface PedidoMercos {
  numero: number;
  status: string;
  statusOriginal: string;
  dataEmissao: string | null;
  clienteNome: string;
  clienteDoc: string;
  vendedor: string | null;
  condicao: string | null;
  totalCents: number;
  observacoes: string | null;
  nf: string | null;
  itens: ItemMercos[];
}

function parsePedido(j: { id: string; cabecalho: string; tabelas: { cab: string[]; linhas: Record<string, string>[] }[] }): PedidoMercos | null {
  const cab = j.cabecalho;
  const num = cab.match(/#(\d+)/)?.[1];
  if (!num) return null;
  const statusOriginal = /em orçamento/i.test(cab)
    ? "Em orçamento"
    : /cancelad/i.test(cab)
      ? "Cancelado"
      : /faturado/i.test(cab)
        ? "Faturado"
        : /concluído|concluido/i.test(cab)
          ? "Concluído"
          : "Outro";
  // Fluxo normal de importação: Concluído entra como aprovado (ainda pode
  // faturar) e o ciclo segue na tela. O estoque antigo foi encerrado em
  // massa à parte (script encerrar-estoque-antigo), uma vez só.
  const status =
    statusOriginal === "Em orçamento" ? "rascunho" : statusOriginal === "Cancelado" ? "cancelado" : statusOriginal === "Faturado" ? "faturado" : "aprovado";
  const cliente = cab.match(/CLIENTE\s*\n(.+?)\s*-\s*([\d./-]{11,})/);
  const vendedor = cab.match(/Vendedor\s*\n(\S[^\n]{0,40})/)?.[1]?.trim() ?? null;
  const condicao = cab.match(/Cond\. de pagamento\s*\n([^\n]+)/)?.[1]?.trim() ?? null;
  const total = cab.match(/Valor total\s*\nR\$ ([\d.,]+)/)?.[1] ?? null;
  const nf = cab.match(/\bNF[:\s]+(\d{2,10})\b/)?.[1] ?? (cab.includes("NOTA FISCAL") ? "emitida" : null);
  const dataEmissao = parseDataBR(cab.match(/Data da emiss[aã]o\s*\n([^\n]+)/)?.[1]);

  // Grade de itens: a tabela com mais linhas cujo col_2 parece descrição.
  const candidatas = j.tabelas.filter((t) => t.linhas.some((l) => (l.col_2 ?? "").length > 3));
  candidatas.sort((a, b) => b.linhas.length - a.linhas.length);
  const itens: ItemMercos[] = [];
  for (const l of (candidatas[0]?.linhas ?? [])) {
    const nome = (l.col_2 ?? "").trim();
    if (!nome || /^observa/i.test(nome)) continue;
    const qtdM = (l.col_3 ?? "").match(/(\d+)/);
    const descM = (l.col_5 ?? "").match(/([\d.,]+)\s*%/);
    itens.push({
      codigo: (l.col_1 ?? "").trim(),
      nome: nome.slice(0, 200),
      qtd: qtdM ? Number(qtdM[1]) : 1,
      precoTabCents: reaisParaCents(l.col_4),
      descontoPct: descM ? Number(descM[1].replace(".", "").replace(",", ".")) : 0,
      precoLiqCents: reaisParaCents(l.col_6),
      subtotalCents: reaisParaCents(l.col_7),
    });
  }
  const obs: string[] = [`Status Mercos: ${statusOriginal}`];
  if (nf) obs.push(`NF: ${nf}`);
  if (vendedor) obs.push(`Vendedor Mercos: ${vendedor}`);

  return {
    numero: Number(num),
    status,
    statusOriginal,
    dataEmissao,
    clienteNome: (cliente?.[1] ?? "SEM NOME").trim().slice(0, 200),
    clienteDoc: digitos(cliente?.[2]),
    vendedor,
    condicao,
    totalCents: total ? reaisParaCents(`R$ ${total}`) : itens.reduce((a, i) => a + i.subtotalCents, 0),
    observacoes: obs.join(" | "),
    nf,
    itens,
  };
}

/* ── importador ───────────────────────────────────────────────── */

function arg(nome: string): string | null {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const orgId = arg("org");
  if (!orgId) throw new Error("Passe --org <uuid da organização>.");
  const fase = arg("fase") ?? "tudo";
  const apply = process.argv.includes("--apply");
  const limite = Number(arg("limite") ?? "1000000");
  const mapaVendedores: Record<string, string> = existsSync(arg("vendedores") ?? "")
    ? JSON.parse(readFileSync(arg("vendedores") as string, "utf8"))
    : {};

  const env = carregarEnvLocal();
  const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const relatorio: Record<string, unknown> = { org: orgId, dryRun: !apply, fases: {} };
  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(msg);
  };

  // CHECK contacts_cpf_consistency: cpf_hash e cpf_encrypted andam juntos.
  // Mesma doutrina da rota oficial (app/api/v1/contacts/_handler.ts:355).
  // O RPC encrypt_cpf não existe neste banco — sonda UMA vez e, se ausente,
  // pula silenciosamente (doc segue no metadata). Sem isso, cada CPF distinto
  // gerava um warn + roundtrip falho (parecia loop, mas era progresso barulhento).
  let cpfRpcOk: boolean | null = null;
  const encCache = new Map<string, Uint8Array | null>();
  const cpfFields = async (
    doc: string,
  ): Promise<{ cpf_hash?: string; cpf_encrypted?: Uint8Array }> => {
    if (doc.length !== 11) return {};
    if (cpfRpcOk === null) {
      const { error } = await admin.rpc("encrypt_cpf", { p_plaintext: "00000000000" });
      cpfRpcOk = !error;
    }
    if (!cpfRpcOk) return {};
    if (!encCache.has(doc)) {
      const { data, error } = await admin.rpc("encrypt_cpf", { p_plaintext: doc });
      encCache.set(doc, error ? null : (data as Uint8Array));
    }
    const enc = encCache.get(doc);
    if (!enc) return {};
    return { cpf_hash: hashCpf(doc), cpf_encrypted: enc };
  };

  /* Catálogos em memória (identidade para vínculo). */
  // Supabase JS devolve no máximo 1000 linhas por select — pagina TUDO, senão
  // os mapas saem incompletos e o importador reinsere o que já existe.
  async function todasLinhas(tabela: string, colunas: string): Promise<Record<string, unknown>[]> {
    const todas: Record<string, unknown>[] = [];
    const PASSO = 1000;
    for (;;) {
      const { data, error } = await admin
        .from(tabela)
        .select(colunas)
        .eq("organization_id", orgId)
        .range(todas.length, todas.length + PASSO - 1);
      if (error) throw new Error(`preload ${tabela}: ${error.message}`);
      todas.push(...((data ?? []) as Record<string, unknown>[]));
      if (!data || data.length < PASSO) break;
    }
    return todas;
  }
  const prods = await todasLinhas("catalog_products", "id, codigo, preco_cents, nome");
  const prodPorCodigo = new Map((prods ?? []).map((p) => [(p as { codigo: string }).codigo, p as { id: string; codigo: string; preco_cents: number; nome: string }]));
  const conts = await todasLinhas(
    "contacts",
    "id, cnpj, cpf_hash, phone_number, name, display_name, email, source_metadata",
  );
  const contPorDoc = new Map<string, string>();
  const contPorFone = new Map<string, string>();
  const contPorNome = new Map<string, string>();
  const contMeta = new Map<string, { email: string | null; temMercos: boolean }>();
  for (const c of (conts ?? []) as { id: string; cnpj: string | null; cpf_hash: string | null; phone_number: string | null; name: string | null; display_name: string | null; email: string | null; source_metadata: { mercos?: unknown } | null }[]) {
    if (c.cnpj && digitos(c.cnpj)) contPorDoc.set(digitos(c.cnpj), c.id);
    if (c.cpf_hash) contPorDoc.set(`h:${c.cpf_hash}`, c.id);
    if (c.phone_number) contPorFone.set(digitos(c.phone_number), c.id);
    const n = nomeForte(c.display_name ?? c.name);
    if (n) contPorNome.set(n, c.id);
    contMeta.set(c.id, { email: c.email, temMercos: !!(c.source_metadata && (c.source_metadata as { mercos?: unknown }).mercos) });
  }

  const resolverContato = async (
    nome: string,
    doc: string,
    fone: string | null,
    extra: Record<string, unknown>,
    contadores: { criados: number; vinculados: number; stubs: number },
  ): Promise<string | null> => {
    let id: string | undefined;
    if (doc) id = contPorDoc.get(doc) ?? (doc.length === 11 ? contPorDoc.get(`h:${hashCpf(doc)}`) : undefined);
    if (!id && fone) id = contPorFone.get(digitos(fone));
    if (!id) id = contPorNome.get(nomeForte(nome));
    if (id) {
      // Em dry-run o id pode ser fictício (começa com dryrun-) — conta como
      // vinculado do mesmo jeito, pois a resolução funcionou.
      contadores.vinculados++;
      return id;
    }
    // Stub: todo pedido sai linkado — sem órfão.
    const cpf = await cpfFields(doc);
    const payload = {
      organization_id: orgId,
      name: nome.slice(0, 200),
      display_name: nome.slice(0, 200),
      phone_number: fone,
      cnpj: doc.length === 14 ? doc : null,
      ...cpf,
      source: "mercos",
      source_metadata: { mercos: { stub: true, documento: doc || null, ...extra } },
      tags: ["mercos", "mercos:pedido-sem-cadastro"],
    };
    if (!apply) {
      contadores.stubs++;
      return `dryrun-stub-${nomeForte(nome).slice(0, 20)}`;
    }
    try {
      const { data, error } = await admin.from("contacts").insert(payload).select("id").single();
      if (error) throw new Error(error.message);
      const novo = (data as { id: string }).id;
      if (doc) contPorDoc.set(doc, novo);
      if (fone) contPorFone.set(digitos(fone), novo);
      contPorNome.set(nomeForte(nome), novo);
      contadores.stubs++;
      return novo;
    } catch (e) {
      // Stub falhou (ex: outra constraint): NÃO derruba o run e NÃO polui os
      // mapas — o pedido fica para a próxima passada.
      relatorio.erro_stub = `${nome.slice(0, 60)}: ${e instanceof Error ? e.message.slice(0, 120) : e}`;
      return null;
    }
  };

  /* Fase produtos */
  if (fase === "tudo" || fase === "produtos") {
    const arquivos = readdirSync(SAIDA).filter((f) => /^produtos-pag-\d+\.json$/.test(f));
    let criados = 0;
    let atualizados = 0;
    let n = 0;
    for (const arq of arquivos) {
      const dados = (JSON.parse(readFileSync(join(SAIDA, arq), "utf8")) as { dados: { linhas: { codigo: string; nome: string; unidade: string; comissao: string; preco_tabela: string }[] } }).dados;
      for (const l of dados.linhas) {
        if (!l.nome || n++ >= limite) continue;
        const codigo = l.codigo || l.nome.slice(0, 60);
        const row = {
          organization_id: orgId,
          codigo,
          nome: l.nome.slice(0, 200),
          preco_cents: reaisParaCents(l.preco_tabela),
          origem: "mercos",
        };
        if (prodPorCodigo.has(codigo)) {
          // Só UPDATE quando mudou algo — rerun sem mudança não encosta no banco.
          const atual = prodPorCodigo.get(codigo) as unknown as { id: string; preco_cents: number; nome: string } | string;
          const mudou =
            typeof atual === "string" ||
            (atual as { preco_cents: number; nome: string }).preco_cents !== row.preco_cents ||
            (atual as { preco_cents: number; nome: string }).nome !== row.nome;
          if (mudou) {
            atualizados++;
            if (apply) await admin.from("catalog_products").update(row).eq("organization_id", orgId).eq("codigo", codigo);
          }
        } else {
          criados++;
          if (apply) {
            const { data, error } = await admin.from("catalog_products").insert(row).select("id").single();
            if (!error) prodPorCodigo.set(codigo, { ...(data as { id: string }), preco_cents: row.preco_cents, nome: row.nome });
          } else {
            prodPorCodigo.set(codigo, `dryrun-${codigo}` as unknown as { id: string; preco_cents: number; nome: string });
          }
        }
      }
    }
    relatorio.fases = { ...relatorio.fases as object, produtos: { criados, atualizados } };
    log(`produtos: ${criados} novos, ${atualizados} atualizados${apply ? "" : " (dry-run)"}`);
  }

  /* Fase contatos — escrita em LOTE (500/lote; lote que falha cai no 1-a-1). */
  const contadores = { criados: 0, vinculados: 0, stubs: 0 };
  const LOTE_CONTATOS = 500;
  if (fase === "tudo" || fase === "contatos") {
    const base = JSON.parse(readFileSync(join(SAIDA, "clientes-final.json"), "utf8")) as {
      nome: string; fones: string; endereco: string | null; cidade: string | null; uf: string | null;
      documento: string | null; email: string | null; fantasia: string; tipo: string; status: string;
      wp_id: number; ie: string; num: string; bairro: string; cep: string;
    }[];
    const novos: { chave: string; doc: string; fone: string | null; nomeForte: string; row: Record<string, unknown> }[] = [];
    let n = 0;
    for (const c of base) {
      if (n++ >= limite) break;
      const doc = digitos(c.documento);
      const fone = foneCanonico((c.fones ?? "").split("/")[0]);
      const email = (c.email ?? "").trim().toLowerCase() || null;
      let id: string | undefined;
      if (doc) id = contPorDoc.get(doc) ?? (doc.length === 11 ? contPorDoc.get(`h:${hashCpf(doc)}`) : undefined);
      if (!id && fone) id = contPorFone.get(digitos(fone));
      if (!id) id = contPorNome.get(nomeForte(c.nome));
      const meta = {
        mercos: {
          wp_id: c.wp_id ?? null, documento: doc || null, fantasia: c.fantasia || null, tipo: c.tipo || null,
          status_wp: c.status || null, ie: c.ie || null, endereco: c.endereco, numero: c.num || null,
          bairro: c.bairro || null, cep: (c.cep ?? "").trim() || null, cidade: c.cidade, uf: c.uf,
        },
      };
      if (id) {
        contadores.vinculados++;
        if (apply) {
          // UPDATE só quando agrega algo (e-mail novo ou metadata ainda sem
          // bloco mercos) — rerun sem mudança não encosta no banco.
          const atual = contMeta.get(id);
          if (!atual?.temMercos || (email && email !== (atual.email ?? "").toLowerCase())) {
            // email_normalized é coluna gerada: nunca entra no payload.
            await admin.from("contacts").update({
              email: email ?? undefined,
              source_metadata: meta, tags: ["mercos"],
            }).eq("id", id);
            contMeta.set(id, { email: email ?? atual?.email ?? null, temMercos: true });
          }
        }
        continue;
      }
      contadores.criados++;
      const nf = nomeForte(c.nome);
      const row = {
        organization_id: orgId,
        name: c.nome.slice(0, 200),
        display_name: c.nome.slice(0, 200),
        phone_number: fone,
        email,
        cnpj: doc.length === 14 ? doc : null,
        source: "mercos",
        source_metadata: meta,
        tags: ["mercos"],
      };
      if (!apply) {
        // Dry-run alimenta os mapas com id fictício: a fase de pedidos mede o
        // vínculo real sem gravar nada. No apply, só id real entra nos mapas.
        const pseudo = `dryrun-contato-${nf.slice(0, 24)}`;
        if (doc) contPorDoc.set(doc, pseudo);
        if (fone) contPorFone.set(digitos(fone), pseudo);
        contPorNome.set(nf, pseudo);
        continue;
      }
      novos.push({ chave: `${doc}|${fone}|${nf}`, doc, fone, nomeForte: nf, row });
    }
    // Grava em lotes; o lote com erro é refeito 1-a-1 para isolar a linha ruim.
    for (let i = 0; i < novos.length; i += LOTE_CONTATOS) {
      const lote = novos.slice(i, i + LOTE_CONTATOS);
      const { data, error } = await admin.from("contacts").insert(lote.map((l) => l.row)).select("id");
      if (!error && data) {
        const ids = data as { id: string }[];
        lote.forEach((l, idx) => {
          const novo = ids[idx]?.id;
          if (!novo) return;
          if (l.doc) contPorDoc.set(l.doc, novo);
          if (l.fone) contPorFone.set(digitos(l.fone), novo);
          contPorNome.set(l.nomeForte, novo);
        });
        log(`contatos: lote ${i / LOTE_CONTATOS + 1} (${lote.length})`);
        continue;
      }
      for (const l of lote) {
        const { data: um, error: eUm } = await admin.from("contacts").insert(l.row).select("id").single();
        if (eUm) {
          relatorio.erro_contato = `${(l.row.name as string).slice(0, 60)}: ${eUm.message}`;
          continue;
        }
        const novo = (um as { id: string }).id;
        if (l.doc) contPorDoc.set(l.doc, novo);
        if (l.fone) contPorFone.set(digitos(l.fone), novo);
        contPorNome.set(l.nomeForte, novo);
      }
    }
    relatorio.fases = { ...relatorio.fases as object, contatos: contadores };
    log(`contatos: ${contadores.criados} novos, ${contadores.vinculados} já existiam${apply ? "" : " (dry-run)"}`);
  }

  /* Fase pedidos (sempre com contact_id resolvido). */
  if (fase === "tudo" || fase === "pedidos") {
    const tPed = Date.now();
    const existentes = await todasLinhas("commercial_orders", "numero");
    const numeros = new Set((existentes ?? []).map((r) => (r as { numero: number }).numero));
    log(`pedidos: ${numeros.size} já no banco`);
    // Cache numero→arquivo: parse dos 10k JSONs (~50s) acontece uma vez só.
    const CACHE_NUMS = join(SAIDA, "pedido-numero-por-arquivo.json");
    let numPorArq: Record<string, number> = {};
    if (existsSync(CACHE_NUMS)) {
      numPorArq = JSON.parse(readFileSync(CACHE_NUMS, "utf8"));
    } else {
      const todos = readdirSync(SAIDA).filter((f) => /^pedido-\d+\.json$/.test(f));
      let i = 0;
      for (const arq of todos) {
        try {
          const j = JSON.parse(readFileSync(join(SAIDA, arq), "utf8")) as { cabecalho: string };
          const m = j.cabecalho.match(/#(\d+)/);
          if (m) numPorArq[arq] = Number(m[1]);
        } catch {
          /* arquivo ilegível: será tratado no parse completo */
        }
        if (++i % 2000 === 0) log(`pedidos: índice ${i}/${todos.length}`);
      }
      writeFileSync(CACHE_NUMS, JSON.stringify(numPorArq), "utf8");
    }
    const arquivos = Object.keys(numPorArq).filter((a) => existsSync(join(SAIDA, a)));
    // Arquivos novos desde o índice entram pelo caminho completo.
    for (const a of readdirSync(SAIDA).filter((f) => /^pedido-\d+\.json$/.test(f))) {
      if (!(a in numPorArq)) arquivos.push(a);
    }
    const vendedores = new Set<string>();
    let criados = 0;
    let pulados = 0;
    let adiados = 0;
    let semItens = 0;
    let n = 0;
    const pendentes: { p: PedidoMercos; orderRow: Record<string, unknown> }[] = [];
    for (const arq of arquivos) {
      if (n++ >= limite) break;
      if (n % 2000 === 0) log(`pedidos: ${n}/${arquivos.length} lidos (${Math.round((Date.now() - tPed) / 1000)}s)`);
      // Atalho pelo índice: numero já importado dispensa até o parse.
      const numIdx = numPorArq[arq];
      if (numIdx && numeros.has(numIdx)) {
        pulados++;
        continue;
      }
      const j = JSON.parse(readFileSync(join(SAIDA, arq), "utf8")) as { id: string; cabecalho: string; tabelas: { cab: string[]; linhas: Record<string, string>[] }[] };
      const p = parsePedido(j);
      if (!p || numeros.has(p.numero)) {
        pulados++;
        continue;
      }
      if (p.vendedor) vendedores.add(p.vendedor);
      const fonePedido: string | null = null;
      const contactId = await resolverContato(p.clienteNome, p.clienteDoc, fonePedido, { pedido: p.numero }, contadores);
      if (apply && !contactId) {
        adiados++;
        continue; // stub falhou: tenta na próxima passada, sem contar como criado
      }
      const subtotal = p.itens.reduce((a, i) => a + i.subtotalCents, 0);
      const orderRow = {
        organization_id: orgId,
        numero: p.numero,
        contact_id: apply ? contactId : null,
        cliente_nome: p.clienteNome,
        cliente_documento: p.clienteDoc || null,
        vendedor_user_id: p.vendedor && mapaVendedores[p.vendedor] ? mapaVendedores[p.vendedor] : null,
        status: p.status,
        origem: "mercos",
        subtotal_cents: subtotal,
        total_cents: p.totalCents || subtotal,
        condicao_pagamento: p.condicao,
        observacoes: p.observacoes,
        created_at: p.dataEmissao ?? undefined,
      };
      if (!apply) {
        criados++;
        if (p.itens.length === 0) semItens++;
        continue;
      }
      pendentes.push({ p, orderRow });
    }
    // Grava pedidos em lotes (200/lote) e resolve id por numero para os itens.
    const LOTE_PEDIDOS = 200;
    const LOTE_ITENS = 500;
    const idDoProduto = (codigo: string): string | null => {
      if (!codigo) return null;
      const e = prodPorCodigo.get(codigo) as unknown as string | { id: string } | undefined;
      if (!e) return null;
      if (typeof e === "string") return e.startsWith("dryrun") ? null : e;
      return e.id ?? null;
    };
    const montarItens = (orderId: string, p: PedidoMercos): Record<string, unknown>[] =>
      p.itens.map((it, idx) => ({
        organization_id: orgId,
        order_id: orderId,
        product_id: idDoProduto(it.codigo),
        produto_codigo: it.codigo || it.nome.slice(0, 60),
        produto_nome: it.nome,
        quantidade: Math.max(1, Math.round(it.qtd)),
        preco_unit_cents: it.precoLiqCents || it.precoTabCents,
        desconto_pct: Math.min(100, Math.max(0, it.descontoPct)),
        subtotal_cents: it.subtotalCents || it.qtd * (it.precoLiqCents || it.precoTabCents),
        posicao: idx,
      }));
    const gravarItens = async (todos: Record<string, unknown>[], numero: number): Promise<void> => {
      for (let i = 0; i < todos.length; i += LOTE_ITENS) {
        const lote = todos.slice(i, i + LOTE_ITENS);
        const { error: eIt } = await admin.from("commercial_order_items").insert(lote);
        if (!eIt) continue;
        for (const um of lote) {
          const { error: eUm } = await admin.from("commercial_order_items").insert(um);
          if (eUm) relatorio.erro_itens = `#${numero}: ${eUm.message}`;
        }
      }
    };
    for (let i = 0; i < pendentes.length; i += LOTE_PEDIDOS) {
      const lote = pendentes.slice(i, i + LOTE_PEDIDOS);
      const { data, error } = await admin
        .from("commercial_orders")
        .insert(lote.map((l) => l.orderRow))
        .select("id, numero");
      if (!error && data) {
        const porNumero = new Map((data as { id: string; numero: number }[]).map((r) => [r.numero, r.id]));
        for (const l of lote) {
          const orderId = porNumero.get(l.p.numero);
          if (!orderId) {
            relatorio.erro_pedido = `#${l.p.numero}: sem id no retorno`;
            continue;
          }
          const itens = montarItens(orderId, l.p);
          if (itens.length > 0) await gravarItens(itens, l.p.numero);
          else semItens++;
          numeros.add(l.p.numero);
          criados++;
        }
        log(`pedidos: lote ${i / LOTE_PEDIDOS + 1} (${lote.length})`);
        continue;
      }
      // Lote com erro: cai no 1-a-1 para isolar a linha ruim. Falha aqui
      // significa "já existe ou inválido" — conta como pulado, nunca some.
      for (const l of lote) {
        const { data: ord, error: eUm } = await admin.from("commercial_orders").insert(l.orderRow).select("id").single();
        if (eUm || !ord) {
          relatorio.erro_pedido = `#${l.p.numero}: ${(eUm as { message?: string } | null)?.message ?? "sem id"}`;
          pulados++;
          continue;
        }
        const orderId = (ord as { id: string }).id;
        const itens = montarItens(orderId, l.p);
        if (itens.length > 0) await gravarItens(itens, l.p.numero);
        else semItens++;
        numeros.add(l.p.numero);
        criados++;
      }
    }
    mkdirSync(SAIDA, { recursive: true });
    writeFileSync(join(SAIDA, "vendedores-mercos.json"), JSON.stringify([...vendedores].sort(), null, 2), "utf8");
    relatorio.fases = { ...relatorio.fases as object, pedidos: { criados, pulados, adiados, semItens, vendedores: [...vendedores].sort() } };
    log(`pedidos: ${criados} novos, ${pulados} pulados, ${adiados} adiados, ${semItens} sem itens${apply ? "" : " (dry-run)"}`);
    log(`vendedores Mercos p/ mapear (--vendedores): ${[...vendedores].sort().join(", ")}`);
  }

  mkdirSync(SAIDA, { recursive: true });
  writeFileSync(join(SAIDA, "importacao-resumo.json"), JSON.stringify(relatorio, null, 2), "utf8");
  log(`resumo em importacao-resumo.json (dryRun=${!apply})`);
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
