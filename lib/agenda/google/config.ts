/**
 * O app OAuth do Google desta INSTALAÇÃO — e o único lugar que monta o
 * endereço de retorno.
 *
 * ─── Por que "opcional" aqui é requisito, e não descuido ──────────────────
 *
 * DECISÃO 3.1: sem `GOOGLE_CALENDAR_CLIENT_ID` e `GOOGLE_CALENDAR_CLIENT_SECRET`
 * o módulo de Agenda funciona INTEIRO — some o botão "Conectar Google" e a tela
 * explica em uma linha o que falta e onde obter. Esse é o estado real de um
 * primeiro deploy self-host, e é onde moram os piores defeitos de primeira
 * impressão: um módulo que se recusa a abrir porque falta uma chave que o
 * operador nem sabia que existia.
 *
 * Por isso `configuracaoDoGoogle()` devolve `null` em vez de lançar. Quem chama
 * decide: a tela mostra o cartão de "não configurado", a rota responde
 * `not_configured`. É o mesmo contrato do `getConfig()` da Nuvemshop, que é o
 * precedente desta casa.
 *
 * ─── UMA fonte para o `redirect_uri`, e a razão é medida ──────────────────
 *
 * O Google compara o `redirect_uri` do consentimento com o da troca do código
 * **byte a byte**. No cal.com esse valor sai de DOIS lugares — `redirect_uris[0]`
 * das chaves do app na renovação, e a URL da aplicação em `add`/`callback` — e
 * quando os dois divergem o fluxo quebra com `redirect_uri_mismatch`, que é um
 * erro que aponta para o Google e não para a divergência.
 *
 * Aqui existe **um** `enderecoDeRetorno()`, e tanto a URL de consentimento
 * quanto a troca do código usam ele. Se um dia precisar mudar, muda num lugar
 * só — que é o que impede a classe inteira.
 */

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

/** O caminho da rota de callback. Tem de estar registrado no console do Google. */
export const CAMINHO_DO_CALLBACK = "/api/v1/agenda/google/callback";

/** Os nomes das variáveis, para a tela poder dizer exatamente o que falta. */
export const VARIAVEIS_DO_GOOGLE = ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET"] as const;

export interface AppDoGoogleConfigurado {
  clientId: string;
  clientSecret: string;
  /** Absoluto, e idêntico nos dois lados do fluxo. */
  redirectUri: string;
}

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * O endereço de retorno, derivado da URL pública da instalação.
 *
 * Sem barra dupla e sem barra final: o Google compara a string exata, e
 * `https://crm.exemplo//api/...` é um endereço diferente de
 * `https://crm.exemplo/api/...` para ele.
 */
export function enderecoDeRetorno(urlDaAplicacao: string = env.NEXT_PUBLIC_APP_URL): string {
  const base = texto(urlDaAplicacao).replace(/\/+$/, "");
  return `${base}${CAMINHO_DO_CALLBACK}`;
}

/**
 * A URL canônica continua sendo a do ambiente, mas uma pessoa desenvolvendo
 * no próprio computador pode abrir o mesmo processo por `localhost` enquanto
 * o instalador local guardou o IP da rede. OAuth compara o redirect byte a
 * byte; nesse caso, usar o IP exibido pela configuração manda o navegador para
 * outra origem e a conexão não termina.
 *
 * Só aceitamos loopback como exceção. Host arbitrário nunca vence a URL
 * canônica da instalação, para que um cabeçalho Host forjado não troque o
 * endereço a que o Google devolverá o código de autorização.
 */
export function origemLocalDoNavegador(origem: string | null | undefined): string | null {
  if (!origem) return null;
  try {
    const url = new URL(origem);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return url.origin;
  } catch {
    // Cabeçalho ausente ou inválido: a URL canônica segue sendo o piso seguro.
  }
  return null;
}

/**
 * A URL montada pelo runtime pode refletir a URL canônica da instalação mesmo
 * quando o navegador abriu o Docker por localhost. Para OAuth local, a fonte
 * correta é o Host que chegou na requisição; é ele que a página já exibe e é a
 * origem para a qual o navegador conseguirá voltar depois do consentimento.
 */
export function origemLocalDosCabecalhos(cabecalhos: Pick<Headers, "get">): string | null {
  const host = cabecalhos.get("x-forwarded-host") ?? cabecalhos.get("host");
  const protocolo = (cabecalhos.get("x-forwarded-proto") ?? "http").split(",")[0]?.trim() || "http";
  return origemLocalDoNavegador(host ? `${protocolo}://${host}` : null);
}

/**
 * O que o AMBIENTE traz — puro, síncrono, sem banco.
 *
 * Continua existindo separado de propósito. Ele é o PISO DE ROLLBACK: o
 * `agent.sh` do kit, em falha de update, reverte só a IMAGEM — não o schema.
 * Ou seja, o rollback põe código antigo sobre banco novo por construção, e
 * código antigo não conhece `platform_google_oauth`. Com o `.env` intacto, a
 * conexão do Google degrada em vez de sumir no pior momento possível. É o mesmo
 * argumento, palavra por palavra, que sustenta o `.env` da marca própria.
 *
 * E ser síncrono e sem banco mantém testável o que é regra pura.
 */
export function configuracaoDoAmbiente(urlDaAplicacao?: string): AppDoGoogleConfigurado | null {
  const clientId = texto(env.GOOGLE_CALENDAR_CLIENT_ID);
  const clientSecret = texto(env.GOOGLE_CALENDAR_CLIENT_SECRET);
  if (!clientId || !clientSecret) return null;

  // ⚠️ NÃO há guarda para `NEXT_PUBLIC_APP_URL` vazia aqui, e a ausência é
  // deliberada: `lib/env.ts:308-311` a declara `.url()` com default
  // `http://localhost:3000`, então ela nunca chega vazia — string vazia reprova
  // no `.url()` e o processo nem sobe. A guarda que eu tinha escrito era código
  // morto, e o teste que a exercitava não conseguia sequer montar o cenário: o
  // próprio `env.ts` lançava antes. Guarda inalcançável é pior que guarda
  // ausente — ela dá a sensação de defesa e não pode ser testada.
  return { clientId, clientSecret, redirectUri: enderecoDeRetorno(urlDaAplicacao) };
}

/**
 * Memo de processo com TTL, cópia declarada de `lib/branding/instalacao.ts`.
 *
 * Mora no `globalThis` e não num `let` deste módulo — a diferença não é estilo:
 * o Turbopack instancia o mesmo módulo DUAS vezes no mesmo processo (entrada de
 * rota e entrada de página carregam runtimes diferentes), e um `let` daria dois
 * memos que não se invalidam. Já medido neste repo.
 *
 * 30s é abaixo do que uma pessoa espera antes de concluir "não salvou", e acima
 * do intervalo entre dois renders.
 */
const TTL_MS = 30_000;

declare global {
  var __memoDoAppDoGoogle: { readonly valor: LinhaDoApp | null; readonly expiraEm: number } | null | undefined;
}

interface LinhaDoApp {
  client_id: string | null;
  client_secret_encrypted: string | null;
}

/** Chamada por quem ESCREVE a credencial — a server action do /admin. */
export function invalidarCredencialDoGoogle(): void {
  globalThis.__memoDoAppDoGoogle = null;
}

async function linhaDoBanco(): Promise<LinhaDoApp | null> {
  const memo = globalThis.__memoDoAppDoGoogle;
  if (memo && memo.expiraEm > Date.now()) return memo.valor;

  let valor: LinhaDoApp | null = null;
  try {
    const { data, error } = await createAdminClient()
      .from("platform_google_oauth")
      .select("client_id, client_secret_encrypted")
      .eq("id", 1)
      .maybeSingle();
    // Clone que ainda não aplicou a 0201 devolve 42P01 aqui. Isso NÃO é erro
    // desta instalação — é o piso de rollback funcionando, e o `.env` assume.
    if (error) {
      logger.info("[agenda.google.config] sem credencial no banco; vale o .env", {
        codigo: error.code,
      });
    } else {
      valor = (data as LinhaDoApp | null) ?? null;
    }
  } catch (err) {
    // NUNCA LANÇA: esta função é chamada no render da Agenda, e um throw aqui é
    // 500 na tela inteira. Mesma disciplina do resolvedor de marca.
    logger.warn("[agenda.google.config] leitura falhou; vale o .env", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  globalThis.__memoDoAppDoGoogle = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}

/**
 * A configuração em vigor, ou `null` quando a instalação não tem app OAuth.
 *
 * BANCO PRIMEIRO, `.env` COMO FALLBACK. A ordem é a que os adapters de canal
 * já usam em `lib/channels/<provider>/credentials.ts`, e o argumento é o mesmo:
 * no contrário, um env esquecido silenciaria a configuração feita pela tela e o
 * operador não entenderia por que nada mudou.
 *
 * O provider não é nomeado aqui de propósito. `lint:channels` proíbe o nome
 * fora de `lib/channels/`, e lê comentário como lê código — corretamente: a
 * prosa que nomeia um provider é a que ensina o próximo a acoplar a ele.
 *
 * Nunca lança — ver o cabeçalho.
 */
export async function configuracaoDoGoogle(urlDaAplicacao?: string): Promise<AppDoGoogleConfigurado | null> {
  const linha = await linhaDoBanco();
  const clientId = texto(linha?.client_id);
  const cifrado = texto(linha?.client_secret_encrypted);

  if (clientId && cifrado) {
    const segredo = await decryptWebhookSecret(createAdminClient(), cifrado);
    // Decifra falhou (chave mestra trocada, linha corrompida): NÃO usa o
    // client_id do banco com o secret do .env — misturar as duas fontes daria um
    // par que não existe em app OAuth nenhum, e o erro do Google apontaria para
    // o lugar errado. Cai inteiro para o ambiente.
    if (segredo) {
      return { clientId, clientSecret: segredo, redirectUri: enderecoDeRetorno(urlDaAplicacao) };
    }
    logger.warn("[agenda.google.config] segredo do banco não decifrou; vale o .env inteiro");
  }

  return configuracaoDoAmbiente(urlDaAplicacao);
}

/** Conectar o Google está disponível nesta instalação? */
export async function googleEstaConfigurado(): Promise<boolean> {
  return (await configuracaoDoGoogle()) !== null;
}

/**
 * O que falta, pelo nome — para a tela dizer em vez de só desabilitar o botão.
 *
 * Controle desabilitado sem explicação é o mesmo defeito que controle
 * decorativo, virado do avesso: o operador vê que não pode e não descobre por
 * quê.
 *
 * ⚠️ Só devolve algo quando as DUAS fontes estão vazias. Antes ele lia só o
 * ambiente, e depois da 0201 isso mandaria o dono editar o `.env` de uma
 * instalação que já tem a credencial gravada pela tela.
 */
export async function faltaParaConectarOGoogle(): Promise<string[]> {
  if (await configuracaoDoGoogle()) return [];
  const faltando: string[] = [];
  if (!texto(env.GOOGLE_CALENDAR_CLIENT_ID)) faltando.push("GOOGLE_CALENDAR_CLIENT_ID");
  if (!texto(env.GOOGLE_CALENDAR_CLIENT_SECRET)) faltando.push("GOOGLE_CALENDAR_CLIENT_SECRET");
  // `NEXT_PUBLIC_APP_URL` não entra: ela tem default e validação de URL em
  // `lib/env.ts`, então nunca falta. Listá-la mandaria o operador procurar algo
  // que está lá.
  return faltando;
}
