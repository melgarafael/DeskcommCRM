/**
 * Por que o Supabase está fora — e qual runbook cada causa pede.
 *
 * ─── O defeito que este arquivo existe para matar ────────────────────────────
 * `/api/v1/health` já acertava o STATUS (`down`) e errava a CAUSA: uma instalação
 * no plano free passou ~6 h com 100% das chamadas `/rest/v1` em 522 e o health
 * dizendo só `tempo_esgotado`. Quem lia ia procurar lentidão de rede enquanto o
 * projeto estava sem memória; o runbook de PGRST002 que já existia aponta para
 * OUTRA causa (o gateway do Supabase reexecutando requisições antigas), com uma
 * proteção que já estava instalada e não resolve este caso.
 *
 * ─── O que o corpo do PostgREST distingue, medido ────────────────────────────
 * O PostgREST, quando NÃO conseguiu carregar o schema cache dentro do
 * `statement_timeout` do papel `authenticator`, responde **503** com corpo JSON:
 *
 *   {"code":"PGRST002","message":"Could not query the database for the schema cache. Retrying."}
 *
 * (o mesmo texto que `app/api/v1/health/route.test.ts` já usa como medida).
 * Sobrecarga que NÃO chega a produzir resposta não deixa corpo nenhum: o
 * Cloudflare devolve o **522** dele, sem `code`, sem mensagem — é o que se mediu
 * na instalação. Ou seja: **não existe uma string de "sobrecarga"**; o que separa
 * os dois ramos é a COMBINAÇÃO `status` + `corpo`:
 *
 *   503 + `PGRST002` (ou 5xx + "schema cache")  -> o PostgREST respondeu, e o
 *                                                  cache de schema é o problema;
 *   522 sem corpo                               -> nada respondeu na origem;
 *   timeout do nosso `fetch`, sem status        -> não sabemos, e dizemos isso.
 *
 * O último caso é o que a issue viu: o health não pode inventar schema cache
 * onde não houve resposta. Ele diz "lentidão genérica" e manda conferir o painel
 * — que é o primeiro passo do runbook de qualquer um dos dois ramos.
 *
 * ─── Por que o ponteiro é CAMPO, e não texto no `error` ──────────────────────
 * O caminho do runbook morava dentro da frase de `error`, que a rota redige para
 * quem não tem o segredo interno (esta rota é pública). Resultado: o dado mais
 * acionável da resposta era justamente o que sumia para quem mais precisa dele.
 * `runbook` sai como campo próprio, com o caminho relativo ao repositório, e o
 * teste `app/api/v1/health/route.test.ts` confere que o arquivo EXISTE — renomear
 * o doc sem mexer aqui reprova o gate.
 */
import type { FalhaDeAlcance } from "./alcance";

/** O que está acontecendo com o Supabase, no nível que muda a AÇÃO de quem lê. */
export type CausaDoSupabase =
  /** PostgREST respondeu 503 `PGRST002` (ou 5xx citando o schema cache). */
  | "postgrest_sem_schema_cache"
  /** HTTP 522: o Cloudflare não alcançou a origem — o projeto não está no ar. */
  | "projeto_sem_resposta_na_origem"
  /** Nunca chegamos ao PostgREST: DNS, porta fechada, rota inexistente, TLS. */
  | "banco_inacessivel"
  /** Tentamos e o tempo acabou, sem status e sem corpo: não dá para separar. */
  | "lentidao_generica";

/** Os runbooks que este check aponta. Caminho relativo à raiz do repositório. */
export const RUNBOOKS = {
  /** Sintoma 522/PGRST002 com zero uso: compute insuficiente no plano free. */
  semMemoriaNoFree: "docs/runbooks/supabase-sem-memoria-no-free.md",
  /** Como provar que o banco é alcançável a partir da VPS (pasta, psql, URL). */
  testarOBancoNaVps: "docs/runbooks/rodar-sql-na-vps.md",
} as const;

/**
 * O ponteiro de cada causa. `banco_inacessivel` é o único que NÃO é o runbook do
 * compute: lá o projeto está no ar e o problema é chegar nele. Mandar esse caso
 * para o runbook de memória é o erro que este mapa existe para impedir.
 */
export const RUNBOOK_DA_CAUSA: Record<CausaDoSupabase, string> = {
  postgrest_sem_schema_cache: RUNBOOKS.semMemoriaNoFree,
  projeto_sem_resposta_na_origem: RUNBOOKS.semMemoriaNoFree,
  banco_inacessivel: RUNBOOKS.testarOBancoNaVps,
  lentidao_generica: RUNBOOKS.semMemoriaNoFree,
};

/**
 * A causa que a RESPOSTA denuncia, se ela denunciar alguma.
 *
 * `undefined` é resposta legítima: 4xx de credencial, 200 bom, 500 sem menção ao
 * schema cache. Quem chama segue com o ramo antigo (`http_${status}`).
 */
export function causaDaResposta(status: number, corpo: string): CausaDoSupabase | undefined {
  // PGRST002 é o código do PostgREST para "não consegui o schema cache"; o texto
  // aparece junto, e versões que só mandam a mensagem também são reconhecidas.
  const semSchemaCache = /PGRST002/i.test(corpo) || (status >= 500 && /schema cache/i.test(corpo));
  if (semSchemaCache) return "postgrest_sem_schema_cache";
  // 522 é do Cloudflare, não do PostgREST: chegou resposta, mas não da origem.
  if (status === 522) return "projeto_sem_resposta_na_origem";
  return undefined;
}

/**
 * A causa que a FALHA DE ALCANCE denuncia.
 *
 * A distinção reaproveita `classificarFalhaDeAlcance` (uma régua só, já testada):
 * aqui só se decide quais daquelas falhas são "não cheguei no banco" e qual é o
 * caso honesto de "não sei". `indeterminada` continua sem causa — inventar uma
 * seria trocar um campo vazio por uma frase errada.
 */
export function causaDaFalhaDeAlcance(falha: FalhaDeAlcance): CausaDoSupabase | undefined {
  switch (falha) {
    case "endereco_nao_resolve":
    case "conexao_recusada":
    case "host_inalcancavel":
    case "tls_recusado":
      return "banco_inacessivel";
    case "tempo_esgotado":
      return "lentidao_generica";
    case "indeterminada":
      return undefined;
  }
}

/**
 * A frase que diz o que FAZER. `detalhe` é o pedaço medido (o `HTTP 522`, o
 * `ECONNREFUSED`, os 3000 ms): sem ele a mensagem vira genérica de novo.
 */
export function mensagemDaCausa(causa: CausaDoSupabase, detalhe: string, timeoutMs: number): string {
  switch (causa) {
    case "postgrest_sem_schema_cache":
      return `postgrest_sem_schema_cache: o PostgREST não carregou o schema cache (${detalhe}) — compute insuficiente no plano free. Reinicie o projeto no Supabase (Restart project).`;
    case "projeto_sem_resposta_na_origem":
      return `projeto_sem_resposta_na_origem (${detalhe}): o Cloudflare não alcançou a origem — o projeto Supabase está fora, não é a VPS. Reinicie o projeto (Restart project).`;
    case "banco_inacessivel": {
      // Caso medido (13/11): o `<ref>.supabase.co` parou de resolver com o
      // projeto pausado/apagado. Reiniciar não existe para projeto pausado.
      const projetoSumiu =
        detalhe === "endereco_nao_resolve"
          ? " Se o endereço é *.supabase.co, o projeto pode estar pausado ou apagado — confira no painel (Restore project)."
          : "";
      return `banco_inacessivel (${detalhe}): não chegamos ao PostgREST — confira endereço, DNS e rede ANTES de reiniciar o projeto.${projetoSumiu}`;
    }
    case "lentidao_generica":
      return `lentidao_generica: o banco não respondeu em ${timeoutMs} ms e não houve erro do PostgREST no corpo — não dá para separar schema cache de sobrecarga sem resposta; comece pelo painel do Supabase (o projeto está no ar?).`;
  }
}
