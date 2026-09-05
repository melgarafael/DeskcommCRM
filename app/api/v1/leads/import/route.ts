/**
 * POST /api/v1/leads/import — o funil a partir da planilha que a empresa já tem.
 * GET  /api/v1/leads/import — a planilha modelo, para quem não sabe por onde começar.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code). A capacidade é dele; o
 * que muda é ONDE ela roda e com o quê — o racional está em
 * `lib/leads/planilha.ts`.
 *
 * ─── Desfecho POR LINHA, nunca do lote inteiro ─────────────────────────────
 *
 * Uma planilha de 400 nomes não pode morrer inteira pelo valor malformado da
 * linha 7. Linha inválida é pulada com o motivo nominal, que volta no response
 * e fica NA TELA — um toast que some em quatro segundos não serve para quem
 * precisa saber quais linhas corrigir.
 *
 * ─── Reusa `createLeadHandler`, e paga o preço disso ───────────────────────
 *
 * Cada linha passa pelo MESMO caminho de um negócio criado à mão: mesma
 * validação de etapa contra a organização, mesma `position_in_stage`, mesmo
 * `emit_event` e mesmo audit `lead.created`. Custa consultas a mais por linha, e
 * o teto de `CSV_MAX_DATA_ROWS` é o que torna o preço aceitável. A alternativa —
 * um insert em lote com a regra reescrita aqui — criaria a segunda verdade sobre
 * "como um negócio nasce", e é ela que envelhece sozinha.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { CSV_MAX_BYTES, CSV_MAX_DATA_ROWS, decodificarCsv } from "@/lib/contacts/csv";
import { lerPlanilhaDeLeads, type ErroDaLinha } from "@/lib/leads/planilha";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface ResumoDaImportacao {
  total_linhas: number;
  criados: number;
  contatos_criados: number;
  erros: ErroDaLinha[];
  colunas_ignoradas: string[];
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // Mesma régua do POST unitário de lead: escrita é `agent` para cima.
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("validation_failed", "Envie o arquivo como multipart/form-data.", 422, {
      requestId,
    });
  }

  const arquivo = form.get("file");
  // ⚠️ POR FORMA, e não `instanceof File`, que é o que as duas rotas de
  // importação mais antigas usam.
  //
  // `instanceof` compara contra o construtor do REALM em que o código roda, e
  // aqui há três: undici (o runtime do Next), jsdom (o ambiente da suíte) e o
  // browser. O objeto que o `formData()` devolve é um File legítimo em todos, e
  // mesmo assim o `instanceof` é falso quando o construtor global vem de outro
  // realm. Consequência prática: a guarda de entrada daquelas rotas NUNCA foi
  // exercitada por teste — o único teste que as menciona lê o código-fonte
  // delas, não o comportamento. Guarda que ninguém consegue exercitar é guarda
  // que ninguém sabe se funciona.
  //
  // O que interessa é o que a rota vai FAZER com o valor: ler os bytes e o
  // tamanho. É isso que a forma abaixo exige, e é isso que um campo de texto
  // solto no multipart não tem.
  const pareceArquivo =
    typeof arquivo === "object" &&
    arquivo !== null &&
    typeof (arquivo as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    typeof (arquivo as { size?: unknown }).size === "number";
  if (!pareceArquivo) {
    return fail("validation_failed", "Envie o arquivo no campo 'file'.", 422, { requestId });
  }
  const enviado = arquivo as unknown as File;
  // ⚠️ O funil vem do FORM, e é conferido contra a organização ativa logo
  // abaixo por `createLeadHandler` — que já responde 404 para etapa de outra
  // org e 422 para etapa que não é do funil informado. É o mesmo gate do POST
  // unitário; reescrevê-lo aqui seria a segunda verdade.
  const pipelineId = String(form.get("pipeline_id") ?? "");
  // `stage_id` é OPCIONAL de propósito: o `ImportarLeads.tsx` nunca manda esse
  // campo (comentário no próprio componente — planilha traz gente NOVA, e
  // gente nova entra na primeira etapa do funil). Resolvida logo abaixo,
  // depois que o Supabase client existir.
  let stageId = String(form.get("stage_id") ?? "");
  if (!pipelineId) {
    return fail("validation_failed", "Escolha o funil de destino.", 422, { requestId });
  }

  if (enviado.size > CSV_MAX_BYTES) {
    return fail(
      "validation_failed",
      `Arquivo maior que ${Math.floor(CSV_MAX_BYTES / 1024 / 1024)}MB.`,
      413,
      { requestId },
    );
  }

  const decodificado = decodificarCsv(await enviado.arrayBuffer());
  if ("erro" in decodificado) {
    return fail("validation_failed", decodificado.erro, 422, { requestId });
  }

  const lido = lerPlanilhaDeLeads(decodificado.texto);
  if ("erro" in lido) {
    return fail("validation_failed", lido.erro, 422, { requestId });
  }
  if (lido.leads.length > CSV_MAX_DATA_ROWS) {
    return fail(
      "validation_failed",
      `A planilha tem ${lido.leads.length} linhas; o limite é ${CSV_MAX_DATA_ROWS} por importação.`,
      422,
      { requestId },
    );
  }

  const supabase = await createClient();

  if (!stageId) {
    // Primeira etapa do funil, por posição, dentro da organização ativa —
    // nunca confia em `pipeline_id` sozinho (poderia ser de outro tenant).
    const { data: primeiraEtapa, error: erroEtapa } = await supabase
      .from("crm_stages")
      .select("id")
      .eq("pipeline_id", pipelineId)
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (erroEtapa) {
      return fail("internal_error", erroEtapa.message, 500, { requestId });
    }
    if (!primeiraEtapa) {
      return fail("validation_failed", "Este funil não tem etapas.", 422, { requestId });
    }
    stageId = (primeiraEtapa as { id: string }).id;
  }

  const resumo: ResumoDaImportacao = {
    total_linhas: lido.leads.length + lido.erros.length,
    criados: 0,
    contatos_criados: 0,
    erros: [...lido.erros],
    colunas_ignoradas: lido.colunasIgnoradas,
  };

  // O mesmo telefone repetido na planilha vira UM contato, não N. Sem isto, uma
  // lista com três negócios do mesmo cliente criaria três contatos idênticos —
  // e o produto passaria a ter duplicata que ele mesmo fabricou.
  const contatoPorTelefone = new Map<string, string>();

  for (const linha of lido.leads) {
    try {
      let contactId: string | null = null;
      if (linha.telefone) {
        contactId = contatoPorTelefone.get(linha.telefone) ?? null;
        if (!contactId) {
          const { data: existente } = await supabase
            .from("contacts")
            .select("id")
            .eq("organization_id", orgId)
            .in("phone_number", phoneLookupVariants(linha.telefone))
            .limit(1)
            .maybeSingle();

          if (existente) {
            contactId = (existente as { id: string }).id;
          } else {
            const { data: criado, error: erroContato } = await supabase
              .from("contacts")
              .insert({
                organization_id: orgId,
                display_name: linha.nome_do_contato ?? linha.title,
                phone_number: linha.telefone,
                email: linha.email,
                source: linha.source,
              })
              .select("id")
              .single();
            if (erroContato) {
              // Contato que não entra NÃO derruba o negócio: o card entra sem
              // contato e a pessoa liga o telefone depois, corrigindo um card em
              // vez de reimportar a planilha inteira.
              resumo.erros.push({
                linha: linha.linha,
                motivo: "o contato não pôde ser criado — o negócio entrou sem ele",
              });
            } else {
              contactId = (criado as { id: string }).id;
              resumo.contatos_criados += 1;
            }
          }
          if (contactId) contatoPorTelefone.set(linha.telefone, contactId);
        }
      }

      await createLeadHandler(
        supabase,
        { organization_id: orgId, actor: { type: "user", id: authz.user.id }, requestId },
        {
          pipeline_id: pipelineId,
          stage_id: stageId,
          title: linha.title,
          description: linha.description,
          contact_id: contactId,
          value_cents: linha.value_cents,
          currency: "BRL",
          tags: linha.tags,
          source: linha.source,
        },
      );
      resumo.criados += 1;
    } catch (err) {
      // A ETAPA ERRADA DERRUBA A IMPORTAÇÃO INTEIRA, e de propósito: se a etapa
      // não é desta organização, ela não será na linha 2 nem na 300. Seguir
      // gastaria 300 tentativas para dar o mesmo erro 300 vezes.
      if (err instanceof ApiError && (err.status === 404 || err.status === 422)) {
        return fail(err.code, err.message, err.status, { requestId });
      }
      resumo.erros.push({
        linha: linha.linha,
        motivo: err instanceof Error ? err.message : "linha recusada pelo banco",
      });
    }
  }

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "lead.imported",
    resourceType: "crm_leads",
    requestId,
    metadata: {
      pipeline_id: pipelineId,
      stage_id: stageId,
      total_linhas: resumo.total_linhas,
      criados: resumo.criados,
      recusadas: resumo.erros.length,
    },
  });

  return ok(resumo, { requestId });
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;

  // ⚠️ VALOR E TAGS ENTRE ASPAS, e não é estilo: "12.500,00" tem uma vírgula
  // dentro, e o delimitador desta planilha É a vírgula. Sem as aspas o modelo
  // que a gente entrega seria lido errado pelo importador que a gente escreveu —
  // e a primeira coisa que a pessoa faz é mandar o modelo de volta.
  const modelo = [
    "nome,nome do contato,telefone,email,valor,origem,tags,observacao",
    'Reforma do apartamento 402,Ana Souza,11988887777,ana@exemplo.com,"12.500,00",indicacao,"quente;retorno",Pediu orcamento para junho',
    'Plano anual,Bruno Lima,(21) 97777-6666,,"1.200,00",site,,Veio pelo formulario',
  ].join("\n");

  return new Response(`﻿${modelo}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="modelo-leads.csv"',
      "x-request-id": requestId,
    },
  });
}
