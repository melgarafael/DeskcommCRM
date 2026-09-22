import { tool } from "ai";
import { z } from "zod";

import { listaAgendamentos } from "@/lib/agenda/consulta";
import { precoDeVitrine } from "@/lib/schemas/produtos";
import { STATUS_FATURAVEL } from "@/lib/schemas/fiscal";
import { responder } from "@/components/assistente/respostas";
import { reais, type AssistenteCtx } from "./contexto";

/**
 * As ferramentas do assistente interno — LEITURA executa na hora, ESCRITA só
 * propõe (o `propor_*` valida, resolve e devolve resumo; a execução mora em
 * `propostas.ts` e só acontece na `/executar`, depois do OK humano).
 *
 * Isolamento: TODA query filtra `organization_id = ctx.organizationId`, que
 * vem da sessão validada pela rota — nunca do argumento do modelo.
 */

const HOJE = () => new Date().toISOString().slice(0, 10);

function clienteResumido(c: {
  id: string;
  display_name?: string | null;
  name?: string | null;
  phone_number?: string | null;
  email?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cpf?: string | null;
  cnpj?: string | null;
}) {
  return {
    id: c.id,
    nome: c.display_name ?? c.name ?? "—",
    ...(c.phone_number ? { telefone: c.phone_number } : {}),
    ...(c.email ? { email: c.email } : {}),
    ...(c.cidade || c.uf ? { cidade_uf: [c.cidade, c.uf].filter(Boolean).join("/") } : {}),
    ...(c.cpf ? { cpf: c.cpf } : {}),
    ...(c.cnpj ? { cnpj: c.cnpj } : {}),
  };
}

const buscarCliente = (ctx: AssistenteCtx) =>
  tool({
    description:
      "Busca cliente por nome, telefone ou documento. Use antes de qualquer pedido, tarefa ou agendamento: sem o id, nada anda. Se voltar mais de um parecido, mostre as opções e pergunte qual.",
    inputSchema: z.object({
      busca: z.string().trim().min(2).describe("nome, telefone ou documento como a pessoa falou"),
    }),
    execute: async (args) => {
      const b = `%${args.busca}%`;
      const { data, error } = await ctx.supabase
        .from("contacts")
        .select("id, display_name, name, phone_number, email, cidade, uf, cpf, cnpj")
        .eq("organization_id", ctx.organizationId)
        .or(`display_name.ilike.${b},name.ilike.${b},phone_number.ilike.${b},cpf.ilike.${b},cnpj.ilike.${b}`)
        .order("display_name")
        .limit(6);
      if (error) return { erro: `não consegui buscar agora: ${error.message}` };
      const clientes = (data ?? []).map(clienteResumido);
      if (clientes.length === 0) {
        return {
          clientes: [],
          mensagem:
            "não achei ninguém com esse nome. Confira a grafia ou ofereça cadastrar com propor_contato.",
        };
      }
      return { clientes };
    },
  });

const buscarProduto = (ctx: AssistenteCtx) =>
  tool({
    description:
      "Busca produto no catálogo por nome, marca ou código, com preço de vitrine e estoque. Use SEMPRE antes de falar preço ou montar pedido. Se voltar mais de um parecido, pergunte qual — nunca escolha sozinho.",
    inputSchema: z.object({
      termo: z.string().trim().min(2).describe("o que a pessoa disse, do jeito que disse"),
    }),
    execute: async (args) => {
      const b = `%${args.termo}%`;
      const { data, error } = await ctx.supabase
        .from("catalog_products")
        .select(
          "id, codigo, nome, marca, categoria, preco_cents, preco_promocional_cents, promocao_ate, moeda, controla_estoque, quantidade, ativo",
        )
        .eq("organization_id", ctx.organizationId)
        .eq("ativo", true)
        .or(`nome.ilike.${b},codigo.ilike.${b},marca.ilike.${b}`)
        .order("nome")
        .limit(8);
      if (error) return { erro: `não consegui buscar agora: ${error.message}` };
      const produtos = (data ?? []).map((p) => {
        const vitrine = precoDeVitrine(
          {
            preco_cents: p.preco_cents,
            preco_promocional_cents: p.preco_promocional_cents,
            promocao_ate: p.promocao_ate,
          },
          HOJE(),
        );
        return {
          codigo: p.codigo,
          nome: p.nome,
          ...(p.marca ? { marca: p.marca } : {}),
          preco: reais(vitrine.cents),
          preco_cents: vitrine.cents,
          ...(vitrine.emPromocao ? { em_promocao: true as const } : {}),
          estoque: !p.controla_estoque ? "não controlado" : String(p.quantidade),
          ...(p.controla_estoque && p.quantidade <= 0 ? { sem_estoque: true as const } : {}),
        };
      });
      if (produtos.length === 0) {
        return {
          produtos: [],
          mensagem: "nada com esse nome no catálogo. Peça o código exato ou ofereça falar com a equipe.",
        };
      }
      return { produtos };
    },
  });

const verPedidos = (ctx: AssistenteCtx) =>
  tool({
    description: "Lista pedidos recentes, opcionalmente de um cliente (contact_id). Para ver itens de um pedido, use ver_pedido.",
    inputSchema: z.object({
      contact_id: z.string().uuid().optional().describe("filtre por este cliente quando souber quem é"),
      busca: z.string().trim().optional().describe("nome ou documento do cliente"),
      limite: z.number().int().min(1).max(20).optional().default(5),
    }),
    execute: async (args) => {
      let q = ctx.supabase
        .from("commercial_orders")
        .select("id, numero, cliente_nome, status, total_cents, condicao_pagamento, created_at")
        .eq("organization_id", ctx.organizationId);
      if (args.contact_id) q = q.eq("contact_id", args.contact_id);
      if (args.busca) {
        const b = `%${args.busca}%`;
        q = q.or(`cliente_nome.ilike.${b},cliente_documento.ilike.${b}`);
      }
      const { data, error } = await q.order("created_at", { ascending: false }).limit(args.limite);
      if (error) return { erro: `não consegui listar agora: ${error.message}` };
      return {
        pedidos: (data ?? []).map((p) => ({
          numero: `PED-${String(p.numero).padStart(4, "0")}`,
          id: p.id,
          cliente: p.cliente_nome,
          status: p.status,
          total: reais(p.total_cents),
          ...(p.condicao_pagamento ? { pagamento: p.condicao_pagamento } : {}),
          criado_em: String(p.created_at).slice(0, 10),
        })),
      };
    },
  });

const verPedido = (ctx: AssistenteCtx) =>
  tool({
    description: "Detalhe de um pedido com itens, valores e entrega. Aceita número (ex.: 42 ou PED-0042) ou id.",
    inputSchema: z.object({
      pedido: z.string().trim().min(1).describe("número ou id do pedido"),
    }),
    execute: async (args) => {
      const soDigitos = args.pedido.replace(/\D/g, "");
      let q = ctx.supabase
        .from("commercial_orders")
        .select(
          "id, numero, cliente_nome, cliente_documento, status, origem, total_cents, desconto_cents, frete_cents, condicao_pagamento, endereco_entrega, transportadora_nome, modalidade_frete, previsao_entrega, observacoes, created_at",
        )
        .eq("organization_id", ctx.organizationId);
      q = soDigitos && !args.pedido.includes("-") ? q.eq("numero", Number(soDigitos)) : q.eq("id", args.pedido);
      const { data: ped, error } = await q.maybeSingle();
      if (error) return { erro: `não consegui abrir agora: ${error.message}` };
      if (!ped) return { erro: "não achei esse pedido. Confira o número." };
      const { data: itens } = await ctx.supabase
        .from("commercial_order_items")
        .select("produto_codigo, produto_nome, quantidade, preco_unit_cents, desconto_pct, subtotal_cents")
        .eq("order_id", ped.id)
        .order("posicao");
      return {
        pedido: {
          numero: `PED-${String(ped.numero).padStart(4, "0")}`,
          id: ped.id,
          cliente: ped.cliente_nome,
          status: ped.status,
          total: reais(ped.total_cents),
          ...(ped.condicao_pagamento ? { pagamento: ped.condicao_pagamento } : {}),
          ...(ped.previsao_entrega ? { entrega_prevista: ped.previsao_entrega } : {}),
          ...(ped.transportadora_nome ? { transportadora: ped.transportadora_nome } : {}),
        },
        itens: (itens ?? []).map((i) => ({
          codigo: i.produto_codigo,
          nome: i.produto_nome,
          qtd: i.quantidade,
          unitario: reais(i.preco_unit_cents),
          subtotal: reais(i.subtotal_cents),
        })),
      };
    },
  });

const diagnosticarNota = (ctx: AssistenteCtx) =>
  tool({
    description:
      "Diagnostica por que uma nota fiscal não sai (ou se pode sair): confere status do pedido, configuração fiscal, nota já existente e fila de emissão. Use quando a pessoa diz 'não consigo gerar a nota'.",
    inputSchema: z.object({
      pedido: z.string().trim().min(1).describe("número ou id do pedido"),
    }),
    execute: async (args) => {
      const soDigitos = args.pedido.replace(/\D/g, "");
      let q = ctx.supabase
        .from("commercial_orders")
        .select("id, numero, cliente_nome, status, total_cents")
        .eq("organization_id", ctx.organizationId);
      q = soDigitos && !args.pedido.includes("-") ? q.eq("numero", Number(soDigitos)) : q.eq("id", args.pedido);
      const { data: ped, error: erroPed } = await q.maybeSingle();
      if (erroPed) return { erro: `não consegui consultar agora: ${erroPed.message}` };
      if (!ped) return { erro: "não achei esse pedido. Confira o número." };

      const checklist: { item: string; ok: boolean; detalhe: string }[] = [];
      const faturavel = (STATUS_FATURAVEL as readonly string[]).includes(ped.status);
      checklist.push({
        item: "pedido faturado",
        ok: faturavel,
        detalhe: faturavel
          ? `está "${ped.status}"`
          : `está "${ped.status}" — só pedido faturado vira nota; aprove/fature na tela do pedido`,
      });

      const { data: config } = await ctx.supabase
        .from("fiscal_settings")
        .select("serie, provedor, ambiente")
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();
      checklist.push({
        item: "configuração fiscal",
        ok: Boolean(config),
        detalhe: config
          ? `série ${config.serie}, via ${config.provedor} (${config.ambiente})`
          : "ausente — configure em Notas → Configuração fiscal",
      });

      const { data: existente } = await ctx.supabase
        .from("invoices")
        .select("id, status, numero, serie, erro")
        .eq("organization_id", ctx.organizationId)
        .eq("order_id", ped.id)
        .neq("status", "cancelada")
        .maybeSingle();
      checklist.push({
        item: "sem nota viva",
        ok: !existente,
        detalhe: existente
          ? `já existe nota ${existente.status}${existente.numero ? ` nº ${existente.numero}/${existente.serie}` : ""}${existente.erro ? ` (erro: ${existente.erro})` : ""}`
          : "nenhuma nota para este pedido",
      });

      const podeEmitir = checklist.every((c) => c.ok);
      return {
        pedido: `PED-${String(ped.numero).padStart(4, "0")}`,
        order_id: ped.id,
        total: reais(ped.total_cents),
        pode_emitir: podeEmitir,
        checklist,
        ...(podeEmitir
          ? { proximo_passo: "tudo certo — chame propor_nota com este order_id para montar a proposta de emissão" }
          : {}),
      };
    },
  });

const verTarefas = (ctx: AssistenteCtx) =>
  tool({
    description: "Lista tarefas (visitas, ligações, retornos) — opcionalmente de um cliente ou só pendentes.",
    inputSchema: z.object({
      contact_id: z.string().uuid().optional(),
      so_pendentes: z.boolean().optional().default(true),
      limite: z.number().int().min(1).max(20).optional().default(8),
    }),
    execute: async (args) => {
      let q = ctx.supabase
        .from("commercial_tasks")
        .select("id, titulo, tipo, status, contato_nome, agendada_para")
        .eq("organization_id", ctx.organizationId);
      if (args.contact_id) q = q.eq("contact_id", args.contact_id);
      if (args.so_pendentes) q = q.eq("status", "pendente");
      const { data, error } = await q.order("agendada_para", { ascending: true, nullsFirst: false }).limit(args.limite);
      if (error) return { erro: `não consegui listar agora: ${error.message}` };
      return {
        tarefas: (data ?? []).map((t) => ({
          titulo: t.titulo,
          tipo: t.tipo,
          status: t.status,
          ...(t.contato_nome ? { cliente: t.contato_nome } : {}),
          ...(t.agendada_para ? { para: t.agendada_para } : {}),
        })),
      };
    },
  });

const verAgenda = (ctx: AssistenteCtx) =>
  tool({
    description: "Vê compromissos: informe contato, dia (AAAA-MM-DD) ou período (de/ate em ISO). Sem recorte a consulta é recusada — pergunte de quem ou de quando.",
    inputSchema: z.object({
      contact_id: z.string().uuid().optional(),
      dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      de: z.string().optional(),
      ate: z.string().optional(),
      limite: z.number().int().min(1).max(50).optional().default(10),
    }),
    execute: async (args) => {
      const r = await listaAgendamentos(ctx.supabase, ctx.organizationId, {
        contactId: args.contact_id ?? null,
        dia: args.dia ?? null,
        de: args.de ?? null,
        ate: args.ate ?? null,
        limite: args.limite,
      });
      if (!r.ok) return { erro: r.motivoParaCliente };
      return {
        compromissos: r.agendamentos.map((a) => ({
          titulo: a.titulo,
          inicio: a.iniciaEm,
          situacao: a.situacao,
          ...(a.contatoNome ? { cliente: a.contatoNome } : {}),
        })),
      };
    },
  });

const listarTiposAgenda = (ctx: AssistenteCtx) =>
  tool({
    description: "Lista os tipos de compromisso ativos (ex.: visita, entrega) com duração — use antes de propor_agendamento para saber o event_type_id.",
    inputSchema: z.object({}),
    execute: async () => {
      const { data, error } = await ctx.supabase
        .from("calendar_event_types")
        .select("id, name, duration_minutes")
        .eq("organization_id", ctx.organizationId)
        .eq("is_active", true)
        .order("name")
        .limit(20);
      if (error) return { erro: `não consegui listar agora: ${error.message}` };
      return { tipos: (data ?? []).map((t) => ({ id: t.id, nome: t.name, duracao_min: t.duration_minutes })) };
    },
  });

const verFunis = (ctx: AssistenteCtx) =>
  tool({
    description: "Lista funis e etapas — use antes de propor_lead para descobrir pipeline_id e stage_id.",
    inputSchema: z.object({}),
    execute: async () => {
      const { data: funis, error } = await ctx.supabase
        .from("crm_pipelines")
        .select("id, name")
        .eq("organization_id", ctx.organizationId)
        .order("name")
        .limit(10);
      if (error) return { erro: `não consegui listar agora: ${error.message}` };
      const ids = (funis ?? []).map((f) => f.id);
      const { data: etapas } = ids.length
        ? await ctx.supabase
            .from("crm_stages")
            .select("id, pipeline_id, name, slug")
            .eq("organization_id", ctx.organizationId)
            .in("pipeline_id", ids)
            .order("position")
            .limit(60)
        : { data: [] };
      return {
        funis: (funis ?? []).map((f) => ({
          id: f.id,
          nome: f.name,
          etapas: (etapas ?? [])
            .filter((e) => e.pipeline_id === f.id)
            .map((e) => ({ id: e.id, nome: e.name })),
        })),
      };
    },
  });

const guia = () =>
  tool({
    description: "Guia de uso do sistema: telas, atalhos e onde resolver cada coisa. Use quando a pergunta é 'como faço X' em vez de dado da operação.",
    inputSchema: z.object({
      tema: z.string().trim().min(2).describe("o que a pessoa quer saber fazer"),
    }),
    execute: async (args) => {
      const r = responder(args.tema);
      return { texto: r.texto, links: r.links };
    },
  });

// ── propostas (montam, NÃO executam) ─────────────────────────────────────────

export interface PropostaMontada {
  acao: string;
  titulo: string;
  resumo: string;
  payload: Record<string, unknown>;
}

const proporPedido = (ctx: AssistenteCtx) =>
  tool({
    description:
      "MONTA (não cria) o rascunho de um pedido: resolve cada item a um código do catálogo com preço real e devolve o resumo + total para a pessoa confirmar no botão. Item ambíguo ou inexistente volta como pergunta, nunca como chute.",
    inputSchema: z.object({
      contact_id: z.string().uuid().optional().describe("id vindo de buscar_cliente"),
      cliente_nome: z.string().trim().min(2).max(200),
      itens: z
        .array(
          z.object({
            termo: z.string().trim().min(2).describe("produto como a pessoa falou (nome, marca, código, peso…)"),
            quantidade: z.number().int().min(1).max(1000),
          }),
        )
        .min(1)
        .max(20),
      condicao_pagamento: z.string().trim().max(200).optional(),
      observacoes: z.string().trim().max(2000).optional(),
    }),
    execute: async (args) => {
      const resolvidos: { codigo: string; nome: string; quantidade: number; unitario_cents: number; aviso?: string }[] = [];
      for (const item of args.itens) {
        const termo = item.termo.trim();
        const { data: exato } = await ctx.supabase
          .from("catalog_products")
          .select("id, codigo, nome, preco_cents, preco_promocional_cents, promocao_ate, controla_estoque, quantidade")
          .eq("organization_id", ctx.organizationId)
          .eq("ativo", true)
          .eq("codigo", termo)
          .maybeSingle();
        let prod = exato ?? null;
        if (!prod) {
          const b = `%${termo}%`;
          const { data: cand } = await ctx.supabase
            .from("catalog_products")
            .select("id, codigo, nome, marca, preco_cents, preco_promocional_cents, promocao_ate, controla_estoque, quantidade")
            .eq("organization_id", ctx.organizationId)
            .eq("ativo", true)
            .or(`nome.ilike.${b},codigo.ilike.${b},marca.ilike.${b}`)
            .limit(4);
          const lista = cand ?? [];
          if (lista.length === 0) {
            return {
              erro: `não achei "${termo}" no catálogo. Pergunte o código exato ou ofereça falar com a equipe — não troque por parecido.`,
            };
          }
          if (lista.length > 1) {
            return {
              erro: `"${termo}" casa ${lista.length} produtos. Pergunte qual, mostrando nome e preço de cada: ${lista
                .map((c) => `${c.nome} (${c.codigo})`)
                .join(" · ")}.`,
              opcoes: lista.map((c) => ({ codigo: c.codigo, nome: c.nome })),
            };
          }
          prod = lista[0]!;
        }
        const vitrine = precoDeVitrine(
          {
            preco_cents: prod.preco_cents,
            preco_promocional_cents: prod.preco_promocional_cents,
            promocao_ate: prod.promocao_ate,
          },
          HOJE(),
        );
        resolvidos.push({
          codigo: prod.codigo,
          nome: prod.nome,
          quantidade: item.quantidade,
          unitario_cents: vitrine.cents,
          ...(prod.controla_estoque && prod.quantidade < item.quantidade
            ? { aviso: `estoque atual ${prod.quantidade} — pode travar na confirmação` }
            : {}),
        });
      }
      const total = resolvidos.reduce((s, r) => s + r.quantidade * r.unitario_cents, 0);
      const linhas = resolvidos
        .map((r) => `${r.quantidade}× ${r.nome} (${r.codigo}) — ${reais(r.quantidade * r.unitario_cents)}`)
        .join("\n");
      const proposta: PropostaMontada = {
        acao: "criar_pedido",
        titulo: `Pedido para ${args.cliente_nome} — ${reais(total)}`,
        resumo:
          `Cliente: ${args.cliente_nome}\n${linhas}\nTotal: ${reais(total)}` +
          (args.condicao_pagamento ? `\nPagamento: ${args.condicao_pagamento}` : "") +
          `\nNasce como RASCUNHO (origem assistente).`,
        payload: {
          contact_id: args.contact_id ?? null,
          cliente_nome: args.cliente_nome,
          status: "rascunho",
          origem: "assistente",
          moeda: "BRL",
          desconto_cents: 0,
          frete_cents: 0,
          modalidade_frete: "retirada",
          ...(args.condicao_pagamento ? { condicao_pagamento: args.condicao_pagamento } : {}),
          ...(args.observacoes ? { observacoes: args.observacoes } : {}),
          itens: resolvidos.map((r) => ({
            codigo: r.codigo,
            quantidade: r.quantidade,
            preco_unit_cents: r.unitario_cents,
          })),
        },
      };
      return { proposta };
    },
  });

const proporNota = (ctx: AssistenteCtx) =>
  tool({
    description: "MONTA (não emite) a proposta de nota fiscal de um pedido. Rode diagnosticar_nota antes: se algo trava, explique em vez de propor.",
    inputSchema: z.object({
      order_id: z.string().uuid().describe("id do pedido (vem de diagnosticar_nota ou ver_pedido)"),
    }),
    execute: async (args) => {
      const { data: ped } = await ctx.supabase
        .from("commercial_orders")
        .select("id, numero, cliente_nome, total_cents")
        .eq("organization_id", ctx.organizationId)
        .eq("id", args.order_id)
        .maybeSingle();
      if (!ped) return { erro: "pedido não encontrado." };
      const proposta: PropostaMontada = {
        acao: "emitir_nota",
        titulo: `Emitir nota do PED-${String(ped.numero).padStart(4, "0")} — ${reais(ped.total_cents)}`,
        resumo: `Pedido PED-${String(ped.numero).padStart(4, "0")} de ${ped.cliente_nome}, total ${reais(ped.total_cents)}.\nA nota entra em emissão e a SEFAZ responde na fila (acompanhe em Notas).`,
        payload: { order_id: ped.id },
      };
      return { proposta };
    },
  });

const proporTarefa = () =>
  tool({
    description: "MONTA (não cria) proposta de tarefa: visita, ligação ou retorno, com cliente e data opcional.",
    inputSchema: z.object({
      titulo: z.string().trim().min(2).max(200),
      tipo: z.enum(["visita", "ligacao", "retorno", "outro"]).optional().default("visita"),
      contact_id: z.string().uuid().optional(),
      agendada_para: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("AAAA-MM-DD"),
      descricao: z.string().trim().max(2000).optional(),
    }),
    execute: async (args) => {
      const proposta: PropostaMontada = {
        acao: "criar_tarefa",
        titulo: `Tarefa: ${args.titulo}`,
        resumo: `${args.tipo}${args.agendada_para ? ` para ${args.agendada_para}` : " sem data"}.`,
        payload: {
          titulo: args.titulo,
          tipo: args.tipo,
          ...(args.contact_id ? { contact_id: args.contact_id } : {}),
          ...(args.agendada_para ? { agendada_para: args.agendada_para } : {}),
          ...(args.descricao ? { descricao: args.descricao } : {}),
        },
      };
      return { proposta };
    },
  });

const proporLead = () =>
  tool({
    description: "MONTA (não cria) proposta de negócio no funil. Descubra pipeline_id e stage_id com ver_funis antes.",
    inputSchema: z.object({
      pipeline_id: z.string().uuid(),
      stage_id: z.string().uuid(),
      titulo: z.string().min(2).max(200),
      contact_id: z.string().uuid().optional(),
      valor_reais: z.number().min(0).optional().describe("valor em R$ (vira centavos na execução)"),
    }),
    execute: async (args) => {
      const proposta: PropostaMontada = {
        acao: "criar_lead",
        titulo: `Negócio: ${args.titulo}`,
        resumo: `No funil, etapa escolhida${args.valor_reais ? `, valor ${reais(Math.round(args.valor_reais * 100))}` : ""}.`,
        payload: {
          pipeline_id: args.pipeline_id,
          stage_id: args.stage_id,
          title: args.titulo,
          ...(args.contact_id ? { contact_id: args.contact_id } : {}),
          ...(args.valor_reais !== undefined ? { value_cents: Math.round(args.valor_reais * 100) } : {}),
          source: "assistente",
        },
      };
      return { proposta };
    },
  });

const proporContato = () =>
  tool({
    description: "MONTA (não cadastra) proposta de cliente novo. Use quando buscar_cliente não achou e a pessoa topou cadastrar.",
    inputSchema: z.object({
      nome: z.string().trim().min(2).max(200),
      telefone: z.string().trim().max(30).optional().describe("com DDD; a execução normaliza"),
      email: z.string().trim().max(200).optional(),
      cidade: z.string().trim().max(100).optional(),
      uf: z.string().trim().max(2).optional(),
    }),
    execute: async (args) => {
      const proposta: PropostaMontada = {
        acao: "criar_contato",
        titulo: `Cadastrar cliente: ${args.nome}`,
        resumo: [args.telefone && `tel ${args.telefone}`, args.email, [args.cidade, args.uf].filter(Boolean).join("/")].filter(Boolean).join(" · ") || "sem dados extras",
        payload: {
          display_name: args.nome,
          name: args.nome,
          ...(args.telefone ? { phone_number: args.telefone } : {}),
          ...(args.email ? { email: args.email } : {}),
          ...(args.cidade ? { cidade: args.cidade } : {}),
          ...(args.uf ? { uf: args.uf.toUpperCase() } : {}),
          source: "assistente",
        },
      };
      return { proposta };
    },
  });

const proporAgendamento = () =>
  tool({
    description: "MONTA (não marca) proposta de compromisso. Descubra event_type_id com listar_tipos_agenda antes. Data AAAA-MM-DD + hora HH:MM.",
    inputSchema: z.object({
      event_type_id: z.string().uuid(),
      data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      hora: z.string().regex(/^\d{2}:\d{2}$/),
      contact_id: z.string().uuid().optional(),
      titulo: z.string().min(1).max(200).optional(),
    }),
    execute: async (args) => {
      const proposta: PropostaMontada = {
        acao: "agendar",
        titulo: `Compromisso ${args.data} às ${args.hora}`,
        resumo: `${args.data} às ${args.hora}${args.titulo ? ` — ${args.titulo}` : ""} (horário de Brasília).`,
        payload: {
          event_type_id: args.event_type_id,
          starts_at: `${args.data}T${args.hora}:00-03:00`,
          ...(args.contact_id ? { contact_id: args.contact_id } : {}),
          ...(args.titulo ? { title: args.titulo } : {}),
        },
      };
      return { proposta };
    },
  });

/** O kit completo do turno do assistente. */
export function montarFerramentas(ctx: AssistenteCtx) {
  return {
    buscar_cliente: buscarCliente(ctx),
    buscar_produto: buscarProduto(ctx),
    ver_pedidos: verPedidos(ctx),
    ver_pedido: verPedido(ctx),
    diagnosticar_nota: diagnosticarNota(ctx),
    ver_tarefas: verTarefas(ctx),
    ver_agenda: verAgenda(ctx),
    listar_tipos_agenda: listarTiposAgenda(ctx),
    ver_funis: verFunis(ctx),
    guia: guia(),
    propor_pedido: proporPedido(ctx),
    propor_nota: proporNota(ctx),
    propor_tarefa: proporTarefa(),
    propor_lead: proporLead(),
    propor_contato: proporContato(),
    propor_agendamento: proporAgendamento(),
  };
}
