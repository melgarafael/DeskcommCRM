/**
 * A LINHA DA INSTALAÇÃO (`platform_settings`, `id = 1`) — a régua ÚNICA de quem
 * grava nela.
 *
 * ─── Por que isto existe (issue #4244) ──────────────────────────────────────
 *
 * A linha é SINGLETON e guarda escolhas independentes: `signup_mode` (a
 * política de cadastro) e o resto da configuração da instalação (comportamento,
 * molde de IA, destinos internos). A leitura de cada escolha obedece à mesma
 * precedência, escrita em `lib/auth/politica-de-cadastro.ts`:
 *
 *     linha salva  >  `.env`  >  default do produto
 *
 * Ou seja: **sem linha, quem responde é o `.env`** — é assim que uma instalação
 * nasce fechada só com `SIGNUP_MODE=so_convite`, sem nunca ter aberto
 * `/admin/cadastro`.
 *
 * O defeito: um `upsert` que fala de OUTRA configuração, quando a linha ainda
 * não existe, a CRIA — e `signup_mode` nasce com o DEFAULT da coluna,
 * `'aberto'` (`supabase/baseline.sql`). A linha passa a existir, vence o `.env`,
 * e o cadastro de uma instalação fechada reabre sozinho. Medido nos três
 * gravadores de `/admin/sistema` e `/admin/destinos-internos`.
 *
 * ─── A regra, em duas frases ────────────────────────────────────────────────
 *
 *   1. Quem escreve na linha SEM falar de `signup_mode` passa por
 *      `gravarNaLinhaDaInstalacao()`. Ela SEMEIA a linha com o modo em vigor
 *      antes do upsert, e a semente não toca linha existente
 *      (`on conflict (id) do nothing`) — linha salva continua vencendo tudo.
 *   2. Quem escreve FALANDO de `signup_mode` (a tela `/admin/cadastro`) passa o
 *      campo no corpo, e é ele que vale: a semente é pulada.
 *
 * A sobrescrita do campo por um gravador alheio não existe do lado do banco:
 * `upsert` no PostgREST faz `update` só das colunas citadas no corpo. O que
 * existia era a CRIAÇÃO com o default — e é ela que esta régua fecha.
 *
 * ─── Sem migration, por decisão ─────────────────────────────────────────────
 *
 * A alternativa "coluna anulável" (`null` = a instalação não opinou) exigiria
 * migration e mudaria o `not null` de uma coluna de segurança. A semente resolve
 * o mesmo problema sem tocar no schema, e o custo é declarado: a primeira
 * gravação de outra configuração CONGELA no banco o modo que valia — que é
 * exatamente o que "linha salva vence o `.env`" já significa. Depois disso,
 * mudar o modo é `/admin/cadastro`, não o `.env`.
 *
 * ─── Por que a régua mora em `lib/instalacao/` ──────────────────────────────
 *
 * Porque a regra é da LINHA, não do cadastro: comportamento, molde e destinos
 * esbarram nela pelo mesmo motivo. Fica um arquivo só para que a semente não
 * vire três cópias — três cópias divergem no primeiro gravador novo, e o defeito
 * volta pela porta que ninguém lembrou de fechar. `lib/auth/politica-de-cadastro.ts`
 * continua dono do VOCABULÁRIO e da precedência (`padraoDaInstalacao()`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { padraoDaInstalacao, type ModoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { logger } from "@/lib/logger";

/**
 * Cria a linha com o modo de cadastro EM VIGOR, se ela ainda não existir.
 * `on conflict (id) do nothing`: linha existente não é tocada — nem o modo, nem
 * `updated_at`, nem `updated_by`.
 *
 * Devolve `false` quando o banco recusou. Quem chama NÃO segue adiante: tentar
 * o upsert depois de uma semente recusada é recriar o defeito do #4244.
 */
export async function semearLinhaDaInstalacao(
  db: SupabaseClient,
  modo: ModoDeCadastro = padraoDaInstalacao(),
): Promise<boolean> {
  try {
    const { error } = await db
      .from("platform_settings")
      // `ignoreDuplicates` é o `on conflict (id) do nothing` do PostgREST
      // (`Prefer: resolution=ignore-duplicates`). Sem ele, este upsert seria um
      // segundo gravador de `signup_mode` — e sobrescreveria a escolha da tela.
      .upsert({ id: 1, signup_mode: modo }, { onConflict: "id", ignoreDuplicates: true });

    if (error) {
      logger.error("linha da instalação: não deu para semear o modo de cadastro", {
        codigo: error.code,
        detalhe: error.message,
      });
      return false;
    }
    return true;
  } catch (erro) {
    logger.error("linha da instalação: a semente do modo de cadastro falhou", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}

/**
 * Grava colunas da linha da instalação. É o caminho de TODO gravador que não é
 * `/admin/cadastro`.
 *
 * `valores` são as colunas da configuração que a tela está salvando. Se
 * `signup_mode` NÃO estiver entre elas, a linha é semeada antes com o modo em
 * vigor — sem isso, o INSERT cria `signup_mode = 'aberto'` e reabre o cadastro
 * de uma instalação fechada pelo `.env`.
 *
 * Devolve `false` quando o banco recusou (semente ou gravação) — quem chama
 * transforma isso em mensagem na tela, nunca em silêncio.
 */
export async function gravarNaLinhaDaInstalacao(
  db: SupabaseClient,
  valores: Record<string, unknown>,
  atorUserId: string,
): Promise<boolean> {
  if (!("signup_mode" in valores)) {
    if (!(await semearLinhaDaInstalacao(db))) return false;
  }

  try {
    const { error } = await db
      .from("platform_settings")
      .upsert({ id: 1, ...valores, updated_by: atorUserId }, { onConflict: "id" });

    if (error) {
      logger.error("linha da instalação: não deu para gravar", {
        codigo: error.code,
        detalhe: error.message,
      });
      return false;
    }
    return true;
  } catch (erro) {
    logger.error("linha da instalação: gravação falhou", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}
