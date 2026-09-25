/**
 * GET /api/v1/ai/runs — as execuções de IA, com o que deu errado.
 *
 * A tela de uso (`/app/ai/usage`) responde "quanto gastei". Esta responde "o que
 * aconteceu, e por que falhou" — que é outra pergunta e não tinha lugar nenhum.
 *
 * Filtros: ponto (`purpose`), status, provedor. O eixo principal é o ponto,
 * porque é assim que o operador pensa depois de configurar o painel: "troquei o
 * modelo do classificador de estágio, está funcionando?".
 */
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";
import { JEV_FALHOU_SEM_RESERVA, O_QUE_FAZER_DO_JEV } from "@/lib/ai/decisao/textos";
import { rotuloDoProvedor } from "@/lib/ai/pontos/provedores";
import { PONTO_POR_ID } from "@/lib/ai/pontos/registro";
import { EXPLICACAO_DA_ORIGEM, type OrigemDaEscolha } from "@/lib/ai/pontos/resolver";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * O que fazer a respeito, por código de erro.
 *
 * O `error_code` já é normalizado no seam pela AÇÃO que o problema exige. Aqui
 * essa ação vira frase — porque um painel que mostra `credencial_recusada` e
 * para por aí devolve ao operador o mesmo trabalho de adivinhação que ele tinha
 * antes de a tela existir.
 */
const O_QUE_FAZER: Record<string, string> = {
  credencial_recusada:
    "O provedor não aceitou a chave. Confira se ela ainda é válida em Credenciais — chaves são revogadas ou expiram.",
  modelo_inexistente:
    "O modelo escolhido não existe mais nesse provedor. Escolha outro no painel de Provedores.",
  limite_ou_saldo:
    "O provedor recusou por limite de uso ou saldo. Verifique o faturamento na conta do provedor.",
  provedor_indisponivel:
    "O provedor está fora do ar ou demorou demais. Costuma se resolver sozinho; se persistir, troque de provedor nesse ponto.",
  modelo_sem_ferramentas:
    "O modelo escolhido não sabe usar as ferramentas do CRM. Troque por um que saiba, no painel de Provedores.",
  // A única linha desta tabela em que o produto parou de propósito. Ela existe
  // porque o `throw` do gate de orçamento caía FORA do `try` que grava a falha:
  // a tela que nasceu para explicar o silêncio da IA nunca mostrava o único
  // caso em que o silêncio é intencional.
  orcamento_esgotado:
    "A IA parou porque o gasto do mês atingiu o limite que você definiu. Ajuste o limite (ou desligue a parada) em Uso de IA › Orçamento.",
  // A outra recusa deliberada: o ponto aponta para um endereço escolhido pela
  // empresa, e a chave que ia junto era a da instalação (decisão 22-a).
  endereco_exige_chave_da_empresa:
    "A chamada foi recusada porque este ponto usa um endereço próprio e a empresa não tem chave cadastrada para ele — a chave da instalação não vai para endereço escolhido pela empresa. Cadastre a chave da empresa em Agente de IA › Provedores, ou tire o endereço próprio do ponto.",
  erro_desconhecido:
    "Não conseguimos classificar esta falha. A mensagem original do provedor está abaixo.",
  // As falhas do Jev (`jev_*`), escritas junto do cliente dele.
  ...O_QUE_FAZER_DO_JEV,
};

interface LinhaDeExecucao {
  id: string;
  purpose: string;
  provider: string;
  model: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  http_status: number | null;
  origem_da_escolha: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number | null;
  latency_ms: number | null;
  created_at: string;
}

const filtrosDaQuery = z.object({
  purpose: z.string().min(1).max(64).optional(),
  status: z.enum(["ok", "erro"]).optional(),
  // O cabeçalho desta rota prometia o filtro por provedor desde o primeiro dia,
  // e ele não existia: `?provider=` era descartado e a lista vinha inteira.
  provider: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await requireRole("manager", { resource: "ai_runs" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  // Zod na query string, como a rota irmã de uso já faz. `Math.min(Number(…))`
  // não valida nada: `?limit=abc` virava `NaN` e `?limit=-5` passava direto,
  // o PostgREST recusava, e o erro dele voltava como **500** com a mensagem
  // crua no corpo — resposta de servidor para um erro do cliente.
  const filtros = filtrosDaQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!filtros.success) {
    return fail("invalid_query", t("filtros inválidos"), 422, { details: filtros.error.issues });
  }
  const { purpose, status, provider, limit: limite } = filtros.data;

  const db = await createClient();
  let q = db
    .from("llm_calls")
    .select(
      "id, purpose, provider, model, status, error_code, error_message, http_status, origem_da_escolha, input_tokens, output_tokens, cost_cents, latency_ms, created_at",
    )
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .limit(limite);

  if (purpose) q = q.eq("purpose", purpose);
  if (status) q = q.eq("status", status);
  // "Só o Jev" inclui as linhas da reserva que o cobriu: são as que o cartão
  // conta em "Vezes que a IA de sempre cobriu o Jev", e o link do cartão traz
  // para cá. Filtrar só pelo provedor escondia justamente elas.
  if (provider === PROVEDOR_DO_JEV) {
    q = q.or(`provider.eq.${PROVEDOR_DO_JEV},origem_da_escolha.eq.reserva_do_jev`);
  } else if (provider) {
    q = q.eq("provider", provider);
  }

  const { data, error } = await q;
  if (error) return fail("query_failed", error.message, 500);

  const execucoes = ((data ?? []) as LinhaDeExecucao[]).map((l) => {
    const ponto = PONTO_POR_ID.get(l.purpose);
    return {
      ...l,
      // O nome de gente do ponto. Sem isto a tela mostraria `flywheel_judge`, e
      // o operador não tem por que saber o que é isso.
      pontoRotulo: ponto?.rotulo ?? l.purpose,
      // "typesafe" na coluna, "Jev (TypeSafe AI)" na tela.
      provedorRotulo: rotuloDoProvedor(l.provider) ?? l.provider,
      // A consequência daquele ponto falhar, que é o que liga uma linha de log
      // a algo que a pessoa já viu acontecer no negócio dela. Só em `erro`: a
      // linha da reserva que cobriu o Jev sai `ok` (nada se perdeu), e a do Jev
      // só sai `erro` quando ninguém mediu — aí a consequência é real.
      // `jev_cobriu` é a exceção do `erro`: a IA de sempre caiu em observação,
      // mas a nota do Jev já estava na mão e decidiu — nada se perdeu.
      consequencia:
        l.status === "erro" && l.origem_da_escolha !== "jev_cobriu"
          ? (ponto?.sintomaDeFalha ?? null)
          : null,
      oQueFazer: l.status === "erro" ? (O_QUE_FAZER[l.error_code ?? ""] ?? null) : null,
      // A linha de falha do Jev só existe quando ninguém mediu: "O Jev decidiu"
      // seria falso justamente nela.
      porQueEsteModelo:
        l.origem_da_escolha === "jev" && l.status === "erro"
          ? JEV_FALHOU_SEM_RESERVA
          : l.origem_da_escolha
            ? (EXPLICACAO_DA_ORIGEM[l.origem_da_escolha as OrigemDaEscolha] ?? null)
            : null,
    };
  });

  // O resumo existe para a tela abrir respondendo "está tudo bem?" antes de
  // obrigar a ler cem linhas.
  const erros = execucoes.filter((e) => e.status === "erro");
  const porCodigo = new Map<string, number>();
  for (const e of erros) porCodigo.set(e.error_code ?? "?", (porCodigo.get(e.error_code ?? "?") ?? 0) + 1);

  return ok({
    execucoes,
    resumo: {
      total: execucoes.length,
      erros: erros.length,
      porCodigo: [...porCodigo.entries()].map(([codigo, quantas]) => ({
        codigo,
        quantas,
        oQueFazer: O_QUE_FAZER[codigo] ?? null,
      })),
    },
  });
}
