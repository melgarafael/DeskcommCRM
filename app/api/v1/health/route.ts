/**
 * GET /api/v1/health — Supabase, Redis e WAHA respondem?
 *
 * ─── Por que cada check diz a CAUSA, e não só "down" ─────────────────────────
 * A versão anterior devolvia `error: "fetch failed"` — a mensagem que o `fetch`
 * dá para causas opostas. Com ela, produção passou semanas indistinguível entre
 * "o endereço configurado não existe" e "o serviço caiu", e a leitura que
 * prevaleceu foi a segunda: o dono reiniciava, toda vez, um container que nunca
 * havia caído (medido: `restarts=0`). Um diagnóstico que não separa configuração
 * de disponibilidade manda metade das pessoas para o lugar errado — e sempre a
 * mesma metade, porque "o serviço caiu" é a hipótese que não acusa quem
 * configurou.
 *
 * `reason` é a classificação (ver `lib/net/alcance`), e é o que basta para saber
 * ONDE mexer.
 *
 * ─── Por que o check do banco recusa o 3xx e o 200 que não é JSON ────────────
 * "O endereço respondeu" não é "o BANCO respondeu". Numa instalação em que o
 * endereço configurado cai num proxy, o `fetch` seguia o `307` para a tela de
 * login, tomava o `200` do HTML dela e o check saía `ok` — com o PostgREST
 * inalcançável. Um `ok` assim é pior que um `down`: ele desliga a pergunta. Por
 * isso o ping não segue redirect (`redirect: "manual"`), o `3xx` vira `down` com
 * o destino do `Location` no detalhe, e um `200` só conta quando o corpo é do
 * PostgREST (`corpoDoPostgrest`, abaixo). O `401/403` legítimo continua `ok`:
 * ali quem respondeu foi o banco, recusando a credencial.
 *
 * ─── Por que o ENDEREÇO só sai autenticado ───────────────────────────────────
 * Esta rota é pública — é o que permite um monitor externo bater nela. O endereço
 * do Redis e do WAHA é superfície de ataque: publicá-lo entrega a quem varre a
 * internet o alvo exato de dois serviços que falam com o WhatsApp do cliente.
 * Então `target` só sai com `?verbose=1` mais o mesmo segredo interno dos crons:
 * quem opera o sistema vê para onde ele tentou ir; quem só passa na frente, não.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { alvoDe, classificarFalhaDeAlcance, type FalhaDeAlcance } from "@/lib/net/alcance";
import { validarConfigRedisRest } from "@/lib/redis-config";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CheckStatus = "ok" | "degraded" | "down";

/** Por que o check não passou. `credencial_recusada` é o 401/403 — chegamos lá, e fomos barrados. */
type MotivoDeFalha =
  | FalhaDeAlcance
  | "credencial_recusada"
  | "resposta_inesperada"
  | "projeto_indisponivel"
  | "nao_configurado"
  | "configuracao_invalida";

type Check = {
  status: CheckStatus;
  latency_ms: number;
  error?: string;
  reason?: MotivoDeFalha;
  /** Protocolo + host + porta que tentamos. Só com `?verbose=1` autenticado. */
  target?: string;
};

const TIMEOUT_MS = 3_000;

async function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

/** Chegamos ao serviço, ele respondeu, e a resposta não serve. */
function motivoDoStatusHttp(status: number): MotivoDeFalha {
  return status === 401 || status === 403 ? "credencial_recusada" : "resposta_inesperada";
}

/**
 * O que respondeu no `200` é do PostgREST?
 *
 * ─── O defeito que este predicado separa ─────────────────────────────────────
 * O `200` de uma leitura do PostgREST é JSON. Um `200` que NÃO é JSON é OUTRA
 * COISA respondendo no endereço do banco — tipicamente a tela de login que um
 * proxy serve no lugar da API. Contá-lo como banco de pé é o mesmo defeito do
 * `307` seguido pelo `fetch`, só que pela porta do corpo: o `/health` diria `ok`
 * com o PostgREST fora do ar, e `wait_app_healthy` liberaria (ou reverteria)
 * uma atualização por causa de uma página de HTML.
 *
 * ─── Por que a régua é o CORPO, e não o `content-type` ───────────────────────
 * Porque o cabeçalho não separa os dois. Medido no Node desta instalação (v22):
 * `new Response("[]")` sai com `content-type: text/plain;charset=UTF-8`, e o
 * mesmo carimbo vai num `new Response("<html>…")`. Ou seja, exigir
 * `content-type: application/json` reprovaria o JSON do PostgREST que passou por
 * um cliente sem cabeçalho, e aceitar `text/plain` aceitaria a tela de login.
 * Quem distingue é o que veio no corpo.
 *
 * ─── Por que o corpo vazio conta como ok ─────────────────────────────────────
 * Um `200` sem corpo não contradiz o banco — não afirma ser outra coisa. O que
 * este check reprova é uma resposta que se declara NÃO sendo do PostgREST, e é
 * o que o contrato antigo desta sonda já aceitava (`200/401/empty body`).
 *
 * O corpo chega aqui já lido, e lido UMA vez: quem chama precisa dele também
 * para reconhecer o PGRST002, e a leitura passa pelo mesmo teto de tempo do
 * `fetch` — um `200` cujo corpo nunca chega é um serviço que não respondeu, e
 * cai no `catch` de quem chama, `down` com o motivo de alcance.
 */
function corpoDoPostgrest(corpo: string): boolean {
  if (!corpo) return true;
  try {
    JSON.parse(corpo);
    return true;
  } catch {
    return false;
  }
}

async function checkSupabase(): Promise<Check> {
  const t0 = Date.now();
  // A sonda pergunta ao MESMO endereço que o app usa para falar com o banco, e
  // não ao público: com `SUPABASE_SERVER_URL` (#1082) preenchida, uma instalação
  // com Kong privado não tem REST publicado — a URL pública daria `down` com o
  // CRM inteiro funcionando ao lado. Sem a variável, é a pública, como sempre.
  const url = urlDoSupabaseNoServidor(env.SUPABASE_SERVER_URL, env.NEXT_PUBLIC_SUPABASE_URL);
  try {
    // Ping leve via REST com anon key — não precisa de service_role pra health check.
    // Se chegar 200 (JSON) ou 401/403, conexão e API key estão OK.
    const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const res = await withTimeout(
      fetch(`${url}/rest/v1/organizations?select=id&limit=1`, {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          // O SCHEMA VAI EXPLÍCITO, como o resto do app faz.
          //
          // Este `fetch` é cru, então ele cai no schema DEFAULT do PostgREST —
          // o primeiro da lista "Exposed schemas" do projeto. Que esse default
          // seja `public` é costume de projeto novo, não garantia do Supabase:
          // num projeto que já servia outra aplicação (schema próprio primeiro
          // na lista), o ping procurava `<outro>.organizations`, levava
          // `404 PGRST205` e o check declarava o banco `down` — com o CRM
          // atendendo normalmente ao lado.
          //
          // Não é falso alarme de menos importância: `update.sh` termina em
          // `wait_app_healthy`, e sair diferente de zero é o sinal que o
          // `agent.sh` usa para REVERTER a imagem. Uma atualização boa era
          // desfeita por uma configuração de painel que o CRM não controla.
          //
          // Nenhum client do CRM declara `db.schema` (`lib/supabase/*.ts`), e o
          // default do supabase-js é `public` — então é `public` que o app
          // usa de verdade, e é o que esta sonda tem de perguntar para estar
          // medindo o mesmo banco que o app enxerga.
          "Accept-Profile": "public",
        },
        cache: "no-store",
        // O REDIRECT NÃO É SEGUIDO, e é o que separa "o banco respondeu" de
        // "quem respondeu foi outra coisa".
        //
        // Medido numa instalação real: o endereço que o servidor usava para
        // falar com o Supabase respondia `307` para `/login`. O `fetch`, sozinho,
        // SEGUE o redirect — chegava na tela de login, recebia o `200` do HTML
        // dela, e o check declarava o banco `ok`. O `/health` dizia `ok` com o
        // PostgREST inalcançável, e `wait_app_healthy` (que decide se uma
        // atualização é mantida ou revertida) lia esse `ok` como banco de pé.
        // Com `redirect: "manual"` o `3xx` chega cru, com o `Location` que diz
        // para onde fomos mandados, e o ramo abaixo o trata como `down`.
        redirect: "manual",
      }),
    );
    // 3xx: quem respondeu no endereço do banco não foi o PostgREST — foi um
    // proxy que nos manda para outro lugar (a tela de login, no caso medido).
    // O DESTINO vai no `error`, que é onde quem opera lê o "para onde"; como todo
    // texto desta rota pública, ele é redigido para quem não tem o segredo.
    if (res.status >= 300 && res.status < 400) {
      const destino = res.headers.get("location");
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: destino ? `redirect_${res.status}: ${destino}` : `redirect_${res.status}`,
        reason: "resposta_inesperada",
        target: alvoDe(url),
      };
    }
    // 401/403 (auth ok mas RLS bloqueia anon) → chegamos ao PostgREST, conexão OK
    if (res.status === 401 || res.status === 403) {
      return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(url) };
    }
    // Lê o corpo UMA vez: ele é o que distingue "o projeto Supabase caiu" de
    // "lentidão genérica". Sem abrir conexão nova nem retry: só classificar o que
    // já veio na resposta. Projeto indisponível: HTTP 522 (Cloudflare não
    // alcança a origem) ou corpo com PGRST002 / schema cache (PostgREST não
    // conseguiu carregar o cache de schema, típico de compute insuficiente no
    // free). Não confundir com PGRST205 (tabela ausente num projeto de pé).
    //
    // A falha ao LER o corpo tem dois destinos. No `200` o corpo é a prova
    // (`corpoDoPostgrest`): a falha propaga crua para o `catch`, que dá o
    // motivo de alcance dela — timeout é `tempo_esgotado`, conexão cortada no
    // meio continua sendo conexão cortada. Fora do `200` o status já chegou e o
    // corpo só refina o motivo: uma leitura que falha não pode rebatizar a
    // resposta, e ela cai no ramo `http_${status}`, como antes de o corpo ser lido.
    const leitura = withTimeout(res.text());
    const corpo = (res.status === 200 ? await leitura : await leitura.catch(() => "")).trim();
    const projetoIndisponivel =
      res.status === 522 ||
      /PGRST002/i.test(corpo) ||
      (res.status >= 500 && /schema cache/i.test(corpo));
    if (projetoIndisponivel) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: "projeto_indisponivel (PGRST002/522/schema cache): reinicie o projeto no Supabase (Restart project) — ver docs/runbooks/supabase-compute-insuficiente-free.md",
        reason: "projeto_indisponivel",
        target: alvoDe(url),
      };
    }
    // 200 (lista vazia por RLS) → conexão OK, mas só se o que voltou FOR do
    // PostgREST. Um `200` com HTML no corpo é a tela de login respondendo no
    // lugar da API: antes do conserto, ele vinha com `status: ok`.
    if (res.status === 200) {
      if (corpoDoPostgrest(corpo)) {
        return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(url) };
      }
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: `resposta_nao_json (content-type: ${res.headers.get("content-type") ?? "ausente"})`,
        reason: "resposta_inesperada",
        target: alvoDe(url),
      };
    }
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: `http_${res.status}`,
      reason: motivoDoStatusHttp(res.status),
      target: alvoDe(url),
    };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(url),
    };
  }
}

async function checkRedis(): Promise<Check> {
  const t0 = Date.now();
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  /**
   * A FORMA do valor vem antes da ida à rede, e o motivo é o que quem opera faz
   * a seguir.
   *
   * Um `.env` com as aspas sobrando (`URL="https://srh:80"`) hoje chega até o
   * `fetch`, falha, e o `reason` que sai é o de alcance — indistinguível do
   * contêiner do Redis realmente parado. As duas leituras mandam o operador
   * para lugares opostos: uma para reiniciar um serviço que está de pé, a outra
   * para o editor. `configuracao_invalida` separa as duas SEM ida à rede.
   *
   * Só "não configurado" segue `degraded`: é integração que ninguém contratou.
   * Configurado errado é `down` — o produto conta com o Redis e não o tem.
   *
   * O texto continua carregando o endereço de propósito: `semAlvo()` o redige
   * para quem não tem o segredo interno, e quem tem precisa ver QUAL valor está
   * malformado — dizer só "inválido" sem dizer qual não conserta nada.
   */
  const config = validarConfigRedisRest(url, token);
  if (!config.ok) {
    if (config.reason === "nao_configurado") {
      return { status: "degraded", latency_ms: 0, error: "not_configured", reason: "nao_configurado" };
    }
    return {
      status: "down",
      latency_ms: 0,
      error: `configuracao_invalida: UPSTASH_REDIS_REST_URL=${url}`,
      reason: "configuracao_invalida",
      target: alvoDe(url),
    };
  }
  try {
    // Protocolo REST do Upstash (compatível com serverless-redis-http): comando no
    // corpo via POST na raiz. NÃO existe GET /ping — daria 404 no SRH self-host.
    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["PING"]),
        cache: "no-store",
      }),
    );
    if (!res.ok) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: `http_${res.status}`,
        reason: motivoDoStatusHttp(res.status),
        target: alvoDe(url),
      };
    }
    return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(url) };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(url),
    };
  }
}

async function checkWaha(): Promise<Check> {
  const t0 = Date.now();
  const base = env.WAHA_API_BASE_URL;
  if (!base) {
    return { status: "degraded", latency_ms: 0, error: "not_configured", reason: "nao_configurado" };
  }
  try {
    // /api/sessions valida conectividade E autenticação num tiro só. O WAHA Core não
    // expõe /api/health (daria 404 mesmo autenticado).
    const res = await withTimeout(
      fetch(`${base.replace(/\/$/, "")}/api/sessions`, {
        headers: env.WAHA_API_KEY ? { "X-Api-Key": env.WAHA_API_KEY } : {},
        cache: "no-store",
      }),
    );
    if (!res.ok) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: `http_${res.status}`,
        reason: motivoDoStatusHttp(res.status),
        target: alvoDe(base),
      };
    }
    return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(base) };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(base),
    };
  }
}

/**
 * O segredo interno dos crons também abre o modo verboso. Mesmo contrato de
 * `/api/v1/system/agent`: Bearer, comparação em tempo constante, e segredo vazio
 * nunca vira credencial válida.
 */
function segredoInternoConfere(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const fornecido = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  if (!fornecido) return false;
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return aceitos.some((esperado) => {
    const a = Buffer.from(fornecido);
    const b = Buffer.from(esperado);
    // timingSafeEqual LANÇA se os tamanhos diferirem.
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Sem o segredo, o endereço não sai — nem pelo `target`, nem pelo `error`.
 *
 * O `target` sempre foi escondido de propósito: esta rota é PÚBLICA (o `GET` não
 * exige nada; o segredo interno só destrava o `?verbose=1`), e o cabeçalho deste
 * arquivo chama o endereço de WAHA e Redis do cliente de superfície de ataque.
 * Mas o `error` saía cru ao lado dele, e ele carrega o mesmo endereço numa das
 * formas mais comuns de configuração errada.
 *
 * Medido, com valores que passam pelo Zod de `lib/env.ts` — porque só
 * `NEXT_PUBLIC_SUPABASE_URL` é `.url()` (linha 69); `WAHA_API_BASE_URL` (140) e
 * `UPSTASH_REDIS_REST_URL` (155) são `required()` puro, sem validação de forma:
 *
 *   "redis-interno.hostgator-vps.com"
 *     -> e.message = "Failed to parse URL from redis-interno.hostgator-vps.com"
 *   `"https://redis-interno.hostgator-vps.com"`  (aspas sobrando no .env)
 *     -> e.message = "Failed to parse URL from \"https://redis-interno...\""
 *
 * Ou seja: exatamente os dois serviços cujo endereço a rota esconde por decisão
 * escrita, e exatamente a instalação self-host que erra o `.env` — o caso já
 * catalogado nesta casa como ".env sem aspas". O `error` publicava pela porta
 * que a redação do `target` fechou.
 *
 * Contra-exemplo medido, para o escopo ficar honesto: um endereço com esquema
 * válido e host inalcançável devolve `"fetch failed"`, e o host mora em
 * `e.cause`, que esta rota nunca devolveu. O vazamento é da forma MALFORMADA,
 * não de toda falha — e é por isso que a troca é de redação, não de remoção.
 *
 * O que NÃO se perde: `reason` (`classificarFalhaDeAlcance`) continua saindo
 * inteiro, então quem monitora de fora segue distinguindo dns, recusa, tempo
 * esgotado e credencial recusada. E quem tem o segredo continua vendo o texto
 * original, porque `verbose=1` não passa por aqui.
 */
function semAlvo(check: Check): Check {
  const { target: _oculto, error, ...resto } = check;
  return error === undefined ? resto : { ...resto, error: "erro_ao_consultar" };
}

export async function GET(req: NextRequest) {
  const [supabase, redis, waha] = await Promise.all([
    checkSupabase(),
    checkRedis(),
    checkWaha(),
  ]);

  const verboso = req.nextUrl.searchParams.get("verbose") === "1" && segredoInternoConfere(req);
  const filtrar = verboso ? (c: Check) => c : semAlvo;
  const checks = { supabase: filtrar(supabase), redis: filtrar(redis), waha: filtrar(waha) };

  const anyDown = Object.values(checks).some((c) => c.status === "down");
  const anyDegraded = Object.values(checks).some((c) => c.status === "degraded");
  const status: "healthy" | "degraded" | "unhealthy" = anyDown
    ? "unhealthy"
    : anyDegraded
      ? "degraded"
      : "healthy";

  const httpStatus = status === "unhealthy" ? 503 : 200;

  return NextResponse.json(
    {
      data: {
        status,
        // APP_VERSION é injetada no build da imagem (ARG no Dockerfile) e vale
        // "1.2.3" numa release, ou o SHA curto fora de tag.
        //
        // Antes isto era `process.env.npm_package_version ?? "0.1.0"`, e a
        // variável só existe quando o processo nasce de um `npm`/`pnpm run`. O
        // CMD da imagem é `node server.js`: TODA instalação do mundo reportava
        // "0.1.0". Um campo que responde o valor errado com confiança é pior que
        // um campo ausente — ele desliga a pergunta em vez de deixá-la aberta.
        // Por isso o fallback agora é "desconhecido", e não um número plausível.
        version: process.env.APP_VERSION || "desconhecido",
        timestamp: new Date().toISOString(),
        checks,
      },
    },
    { status: httpStatus },
  );
}
