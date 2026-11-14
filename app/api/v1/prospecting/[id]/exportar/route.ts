/**
 * GET /api/v1/prospecting/:id/exportar — a LISTA DA CAMPANHA de volta para quem
 * opera, em CSV (issue #4360).
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * A prospecção só importava: a busca no Maps e a planilha entram, a tela mostra
 * os candidatos, e não havia porta de saída. Quem buscou 80 empresas, iniciou a
 * campanha e quis a MESMA lista com outra estratégia (outro agente, outro
 * número, outra instrução) ficava sem caminho — nem para reusar aqui, nem para
 * levar a lista embora.
 *
 * ─── As duas listas (`?quem=`) ──────────────────────────────────────────────
 *
 * `nao_abordadas` (o padrão, e o único modo até esta versão): só quem ainda
 * pode ser abordado — o arquivo para reimportar aqui, porque quem já recebeu
 * mensagem é recusado pela triagem com "Contato já existe no CRM".
 *
 * `todas`: a lista INTEIRA da campanha, com a coluna `situacao` (não abordada,
 * abordada ou respondeu). A #4360 entregou só o primeiro modo e o botão sumia
 * quando todo mundo já tinha sido abordado: a campanha CONCLUÍDA, justamente a
 * que a pessoa quer reaproveitar para outra oferta, não tinha saída nenhuma. A
 * coluna `situacao` é o que tira do arquivo a promessa falsa que fez a #4360
 * cortar as abordadas: ela diz o que aconteceu com cada empresa.
 *
 * Nos DOIS modos não sai quem pediu para parar, ficha pessoal nem quem teve os
 * dados apagados (decisão D13; régua em `lib/prospecting/exportar.ts`,
 * `motivoForaDaLista`). O contato é achado pelo vínculo da linha e pelo
 * telefone, nas duas grafias do nono dígito, na ficha ou como telefone extra.
 *
 * `?resumo=1` devolve a CONTAGEM em JSON, com a mesma leitura e a mesma régua
 * do arquivo: é o que a tela mostra no menu, e por isso o número do menu e o
 * arquivo não divergem. Contar não é exportar e não vai para a auditoria.
 *
 * ─── Por que CSV e não "duplicar campanha" ──────────────────────────────────
 *
 * MEDIDO: `prospecting_candidates` tem `unique (organization_id, place_id)` e o
 * índice `prospecting_phone_once_org on (organization_id, phone)`
 * (`supabase/baseline.sql:35628`). A mesma empresa só pode estar em UMA campanha
 * por organização: copiar as linhas para uma campanha nova passa pelo
 * `insert ... on conflict do nothing` de `gravarCandidatos` e grava zero linha,
 * sem erro. Duplicar exige decisão de produto sobre essa unicidade — e sobre o
 * contato/negócio que o modo `on_start` cria para a fila inteira ao iniciar. O
 * PR da fatia declara a medição; esta rota entrega a saída que não depende dela.
 *
 * ─── É LEITURA ──────────────────────────────────────────────────────────────
 *
 * Só `select`: nenhum contato, campanha ou candidato é criado. Exportar é
 * devolver o que a tela mostra — o registro de que a lista saiu fica na
 * auditoria (`prospecting.exported`), com CONTAGEM, nunca com o conteúdo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { comIdDaRequisicao, fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { idiomaDaOrganizacao } from "@/lib/prospecting/idioma";
import {
  LISTAS,
  csvDaLista,
  entraNaLista,
  ligarContatos,
  nomeDoArquivoDaLista,
  resumoDaLista,
  telefonesDaEmpresa,
  type CandidatoDaLista,
  type ContatoDaLista,
  type QualLista,
} from "@/lib/prospecting/exportar";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mesmo teto da tela (o GET de candidatos lê 5.000 linhas): o arquivo não é maior que a lista. */
const TETO_DA_LEITURA = 5_000;
const headers = { "Cache-Control": "no-store" };

type RouteCtx = { params: Promise<{ id: string }> };

/** Recusa por lista: cada uma diz o que a pessoa vê no arquivo que pediu. */
const SEM_EMPRESA: Record<QualLista, string> = {
  nao_abordadas:
    "Nenhuma empresa desta campanha ainda pode ser abordada — não há lista para baixar. Quem já recebeu mensagem fica de fora do arquivo.",
  todas:
    "Nenhuma empresa desta campanha pode sair no arquivo: quem pediu para parar, ficha pessoal e quem teve os dados apagados ficam de fora.",
};

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  // A MESMA porta do resto da prospecção (sessão de admin ou token com leitura):
  // a lista de empresas é a base da área, e a saída dela não pode ser mais
  // aberta que a entrada.
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:read",
  });
  if (!auth.ok) return auth.response;

  // TETO DO TOKEN (#1999). Exportar é leitura e o teto se chama "de escrita",
  // mas o que ele conta é a chamada feita com Bearer — e a cerca
  // `rotas-bearer-aplicam-teto-de-escrita` cobra o par chamada+return em TODA
  // rota que chama `resolveAuthDual`, sem distinguir método: quando o proxy
  // não decide (a porta abaixo), nada a montante conta a chamada. Mesmo
  // recurso de `prospecting/route.ts`: a cota é da área, não da rota.
  const teto = await tetoDeEscritaDoToken(auth, "prospecting", requestId);
  if (teto) return teto;

  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "Campanha inválida.", 400, { requestId, headers });

  const pedida = req.nextUrl.searchParams.get("quem") ?? "nao_abordadas";
  if (!(LISTAS as readonly string[]).includes(pedida))
    return fail("validation_failed", "Lista inválida: use 'nao_abordadas' ou 'todas'.", 422, {
      requestId,
      headers,
    });
  const quem = pedida as QualLista;
  const soResumo = req.nextUrl.searchParams.get("resumo") === "1";

  const org = auth.organizationId;
  const db = getRequestPool();

  // Organização vem da AUTENTICAÇÃO, nunca da URL: campanha de outra conta é
  // "não encontrada", e não 403 (que já diria que ela existe).
  const campanha = (
    await db.query<{ id: string; name: string }>(
      "select id,name from prospecting_campaigns where organization_id=$1 and id=$2",
      [org, id],
    )
  ).rows[0];
  if (!campanha)
    return fail("not_found", "Campanha não encontrada.", 404, { requestId, headers });

  // `suppression_*` são tokens só do servidor (migration 0370): sai daqui só o
  // booleano "esta linha foi apagada", nunca o token. `respondeu` é a mesma
  // régua do "Responderam" da tela (`prospecting/route.ts`, `progress`).
  const linhas = (
    await db.query<CandidatoDaLista>(
      `select p.status,p.attempted_at,p.phone,p.data,p.contact_id,
              (p.suppression_salt is not null) as suprimida,
              (v.last_inbound_at is not null) as respondeu
         from prospecting_candidates p
         left join conversations v on v.organization_id=p.organization_id and v.id=p.conversation_id
        where p.organization_id=$1 and p.campaign_id=$2
        order by p.created_at,p.id limit $3`,
      [org, campanha.id, TETO_DA_LEITURA],
    )
  ).rows;

  // Os contatos do CRM destas empresas numa consulta só: pelo vínculo da linha,
  // pelo telefone da ficha e pelo telefone extra. As duas pontas filtram a
  // organização — o `join` do extra inclusive.
  const ids = [...new Set(linhas.map((c) => c.contact_id).filter((x): x is string => !!x))];
  const telefones = [...new Set(linhas.flatMap(telefonesDaEmpresa))];
  const contatos =
    ids.length === 0 && telefones.length === 0
      ? []
      : (
          await db.query<ContatoDaLista>(
            `select c.id,c.phone_number as telefone,c.is_blocked,c.is_personal,c.is_anonymized,c.consent
               from contacts c
              where c.organization_id=$1 and (c.id=any($2::uuid[]) or c.phone_number=any($3::text[]))
             union all
             select c.id,cp.phone_number as telefone,c.is_blocked,c.is_personal,c.is_anonymized,c.consent
               from contact_phones cp
               join contacts c on c.organization_id=cp.organization_id and c.id=cp.contact_id
              where cp.organization_id=$1 and c.organization_id=$1 and cp.phone_number=any($3::text[])`,
            [org, ids, telefones],
          )
        ).rows;

  const candidatos = ligarContatos(linhas, contatos);
  const resumo = resumoDaLista(candidatos);
  const truncada = resumo.total >= TETO_DA_LEITURA;

  if (soResumo) return ok({ ...resumo, truncada }, { requestId, headers });

  const saem = candidatos.filter((c) => entraNaLista(c, quem));
  if (saem.length === 0)
    // Arquivo só com cabeçalho não explica nada a quem abriu a planilha; a tela
    // também não oferece a lista vazia. O estado é que não tem o que exportar,
    // não o pedido.
    return fail("validation_failed", SEM_EMPRESA[quem], 422, { requestId, headers });

  await audit({
    action: "prospecting.exported",
    organizationId: org,
    actorUserId: auth.actor.type === "user" ? auth.actor.id : null,
    actorApiTokenId: auth.apiTokenId ?? null,
    resourceType: "prospecting",
    resourceId: campanha.id,
    requestId,
    metadata: {
      campaign_id: campanha.id,
      quem,
      total: resumo.total,
      nao_abordadas: resumo.nao_abordadas,
      todas: resumo.todas,
      fora_da_lista: resumo.fora_da_lista,
    },
  });

  // A situação sai no idioma da ORGANIZAÇÃO, a mesma régua do que a prospecção
  // manda para fora (`lib/prospecting/idioma.ts`); os nomes das colunas ficam
  // como o importador os reconhece.
  const idioma: Idioma = quem === "todas" ? await idiomaDaOrganizacao(db, org) : "pt-BR";
  const csv = csvDaLista(saem, {
    comSituacao: quem === "todas",
    rotuloDaSituacao: (s) => traduzir(s, idioma),
  });

  return comIdDaRequisicao(
    new Response(csv, {
      status: 200,
      headers: {
        // `;` + BOM + CRLF: o que o Excel em português abre em colunas e o que a
        // importação de planilha lê de volta (mesmo formato do "Baixar modelo").
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nomeDoArquivoDaLista(campanha.name, new Date(), quem)}"`,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        ...(truncada ? { "X-Lista-Truncada": "true" } : {}),
      },
    }),
    requestId,
  );
}
