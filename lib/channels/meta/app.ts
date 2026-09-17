/**
 * O app da Meta DESTA INSTALAÇÃO — o App Secret que assina a entrega e o verify
 * token que responde ao handshake do webhook.
 *
 * ─── Por que INSTALAÇÃO, e não organização ──────────────────────────────────
 *
 * Um App da Meta atende N WABAs de N organizações (modelo Tech Provider): o
 * segredo e o verify token são do APP, não do número. É o mesmo objeto de
 * `platform_google_oauth` (migration 0201) e de `platform_branding` (0155), e
 * este arquivo é um clone declarado do molde do primeiro.
 *
 * A organização continua vindo do TOKEN NO PATH, nunca do corpo — quem amarra o
 * payload a um tenant é a sessão do canal, como o cabeçalho da rota do webhook
 * estabelece desde a issue #236.
 *
 * ─── Por que o `.env` continua sendo lido ───────────────────────────────────
 *
 * O `.env` é o PISO DE ROLLBACK: o `agent.sh` do kit, em falha de update,
 * reverte só a IMAGEM — não o schema. Ou seja, o rollback põe código antigo
 * sobre banco novo por construção, e é o caminho inverso que dói aqui: código
 * NOVO sobre banco que ainda não tem a 0257 (clone que não atualizou, `db push`
 * que falhou). Com o `.env` intacto, a entrega continua sendo aceita em vez de
 * parar de existir no pior momento possível.
 *
 * BANCO PRIMEIRO, `.env` COMO FALLBACK — a mesma ordem de
 * `lib/channels/<provider>/credentials.ts`: no contrário, um env esquecido
 * silenciaria a configuração feita pela tela e o operador não entenderia por que
 * nada mudou.
 *
 * ─── As duas fontes NÃO se misturam ─────────────────────────────────────────
 *
 * O par só é servido inteiro, da mesma origem. Segredo do `.env` com verify
 * token do banco é um app que não existe: a Meta aceita o handshake (feito com
 * o token dela) e toda entrega passa a morrer em `401 invalid_signature` —
 * exatamente a falha SILENCIOSA que a issue #850 mediu, agora difícil de ver
 * porque metade da configuração parece certa.
 *
 * ─── Nunca lança ────────────────────────────────────────────────────────────
 *
 * Esta função é chamada a CADA entrega da Meta. Um throw aqui é 500 no webhook,
 * e a Meta reentrega em backoff um evento que nunca vai melhorar. Toda falha de
 * leitura degrada para o ambiente, e o motivo vai ao log.
 */

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

/** O que a instalação tem em vigor. Campo nulo = não configurado nessa fonte. */
export interface AppDaMetaEmVigor {
  readonly appSecret: string | null;
  readonly verifyToken: string | null;
}

/** Os nomes das variáveis, para a tela poder dizer exatamente o que falta. */
export const VARIAVEIS_DO_APP_DA_META = ["META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"] as const;

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * O que o AMBIENTE traz — puro, síncrono, sem banco.
 *
 * Separado de propósito: ser síncrono e sem banco mantém testável o que é regra
 * pura (precedência, vazio-como-ausente), e é este objeto que o aviso do
 * primeiro acesso consulta através de `fontesDoAppDaMeta()`.
 */
export function appDaMetaDoAmbiente(
  source: Record<string, string | undefined> = process.env,
): AppDaMetaEmVigor {
  // `.trim()` e não `Boolean()`: o contrato do `.env` deste projeto é que vazio é
  // ausente — o template gera `CHAVE=` —, e `Boolean("   ")` é TRUE. Mesma
  // decisão de `metaPodeReceber` (`lib/channels/meta/webhook.ts`).
  const appSecret = texto(source.META_APP_SECRET);
  const verifyToken = texto(source.META_WEBHOOK_VERIFY_TOKEN);
  return { appSecret: appSecret || null, verifyToken: verifyToken || null };
}

/**
 * Memo de processo com TTL, cópia declarada de `lib/agenda/google/config.ts`.
 *
 * Mora no `globalThis` e não num `let` deste módulo — a diferença não é estilo:
 * o Turbopack instancia o mesmo módulo DUAS vezes no mesmo processo (entrada de
 * rota e entrada de página carregam runtimes diferentes), e um `let` daria dois
 * memos que não se invalidam. Já medido neste repo.
 *
 * O que se memoriza é o PAR JÁ RESOLVIDO, e não a linha do banco: assim uma
 * rajada de entregas da Meta não paga uma ida ao banco por evento. 30s é abaixo
 * do que uma pessoa espera antes de concluir "não salvou", e acima do intervalo
 * entre dois eventos de um mesmo lote.
 */
const TTL_MS = 30_000;

declare global {
  // eslint-disable-next-line no-var
  var __memoDoAppDaMeta: { readonly valor: AppDaMetaEmVigor; readonly expiraEm: number } | null | undefined;
}

/** Chamada por quem ESCREVE a credencial — a server action do /admin. */
export function invalidarAppDaMeta(): void {
  globalThis.__memoDoAppDaMeta = null;
}

interface LinhaDoApp {
  app_secret_encrypted: string | null;
  verify_token_encrypted: string | null;
}

/** Nunca lança: devolve `null` quando não há linha utilizável. */
async function linhaDoBanco(): Promise<LinhaDoApp | null> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_meta_app")
      .select("app_secret_encrypted, verify_token_encrypted")
      .eq("id", 1)
      .maybeSingle();
    // Clone que ainda não aplicou a 0257 devolve 42P01 aqui. Isso NÃO é erro
    // desta instalação — é o piso de rollback funcionando, e o `.env` assume.
    if (error) {
      logger.info("[meta.app] sem credencial no banco; vale o .env", { codigo: error.code });
      return null;
    }
    return (data as LinhaDoApp | null) ?? null;
  } catch (err) {
    logger.warn("[meta.app] leitura do banco falhou; vale o .env", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * O par do banco, ou `null` — e `null` também quando só METADE dele serve.
 *
 * Meia credencial é indistinguível de nenhuma para quem entrega: com o verify
 * token e sem o segredo o handshake passa e TODA mensagem morre em 401; com o
 * segredo e sem o token o webhook nunca é aceito. Nos dois casos o desfecho
 * certo é o piso (o `.env` inteiro), não um par remendado.
 */
async function parDoBanco(linha: LinhaDoApp | null): Promise<AppDaMetaEmVigor | null> {
  const segredoCifrado = texto(linha?.app_secret_encrypted);
  const tokenCifrado = texto(linha?.verify_token_encrypted);
  if (!segredoCifrado || !tokenCifrado) return null;

  const admin = createAdminClient();
  const appSecret = texto(await decryptWebhookSecret(admin, segredoCifrado));
  const verifyToken = texto(await decryptWebhookSecret(admin, tokenCifrado));
  if (!appSecret || !verifyToken) {
    // Chave mestra trocada, linha corrompida, cifra indisponível. NÃO mistura
    // com o `.env`: cai inteiro para ele.
    logger.warn("[meta.app] credencial do banco não decifrou; vale o .env inteiro");
    return null;
  }
  return { appSecret, verifyToken };
}

/**
 * A configuração em vigor — banco primeiro, `.env` como piso. Nunca lança.
 *
 * Devolve os dois campos possivelmente nulos (instalação sem app configurado):
 * é o estado real de um deploy novo, e quem chama decide — a rota responde 403
 * no handshake e 401 na entrega, que é o desfecho de hoje.
 */
export async function appDaMeta(): Promise<AppDaMetaEmVigor> {
  const memo = globalThis.__memoDoAppDaMeta;
  if (memo && memo.expiraEm > Date.now()) return memo.valor;

  const valor = (await parDoBanco(await linhaDoBanco())) ?? appDaMetaDoAmbiente();
  globalThis.__memoDoAppDaMeta = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}

/**
 * As mesmas chaves do `.env`, com os VALORES em vigor — para quem lê por nome de
 * variável, como `metaPodeReceber`.
 *
 * ⚠️ Existe para o aviso do primeiro acesso parar de mentir: ele perguntava só
 * ao ambiente, e depois da 0257 isso diria "não dá para receber pelo canal
 * oficial" a quem acabou de configurar pela tela — mandando o dono editar um
 * arquivo que ele não precisa abrir.
 *
 * `undefined` para o que falta, e não string vazia: é o contrato de
 * `Record<string, string | undefined>` que o leitor espera.
 */
export async function fontesDoAppDaMeta(): Promise<Record<string, string | undefined>> {
  const { appSecret, verifyToken } = await appDaMeta();
  return {
    META_APP_SECRET: appSecret ?? undefined,
    META_WEBHOOK_VERIFY_TOKEN: verifyToken ?? undefined,
  };
}
