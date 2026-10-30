/**
 * Cache CURTO da cadeia de autorização — a peça que faltava ENTRE requisições
 * (issue #3696).
 *
 * ─── O que já existia, e por que não bastava ────────────────────────────────
 *
 * `lib/auth/server.ts` já deduplica tudo DENTRO da requisição (`cache()` do
 * React em `sessaoDaRequisicao`, `loadAuthUser`, `orgAtivaSemPortao`,
 * `resolveActiveOrg`, `isMfaEnrolled`). Entre requisições nada é reaproveitado:
 * cada navegação de `/app` — o documento, os prefetches do RSC e cada chamada
 * de `/api/v1` — refazia a cadeia inteira no Supabase. Medido pelo autor da
 * issue em ~17 h de uso intermitente: 18,6 mil `/auth/v1/user`, 7,8 mil
 * `user_organizations`, 6,4 mil `platform_admins`, 6,4 mil
 * `rpc/fn_support_context`, 3,3 mil `rpc/fn_user_role_in_org`.
 *
 * ─── Por que 30 s, e por que é um risco LIMITADO ────────────────────────────
 *
 * O preço de cachear autorização é a JANELA: o que foi revogado continua
 * valendo até a entrada cair. Duas coisas limitam essa janela aqui:
 *
 *  1. INVALIDAÇÃO, que não é opcional — ver `invalidarUsuario`/`invalidarOrg`
 *     abaixo. Todo caminho de escrita de vínculo, papel, org suspensa e
 *     acompanhamento chama a invalidação na mesma requisição da escrita. Para
 *     quem está no MESMO processo, o efeito é imediato (não "até 30 s": na
 *     próxima requisição já nega — é o teste
 *     `tests/unit/acesso-revogado-nao-espera-o-cache.test.ts`).
 *  2. O TTL, que é o teto para os casos SEM caminho de invalidação confiável:
 *     escrita direta no banco (o `platform_admins` é gerenciado só por DBA via
 *     SQL, Spec 01 §3.4 T-04) e outra instância do processo. Um cache em
 *     memória de processo não alcança o processo vizinho; a janela é o TTL.
 *
 * O que NÃO entra no cache, de propósito, está dito no ponto de uso
 * (`lib/auth/server.ts`): o poder de plataforma POSITIVO, cuja revogação só
 * acontece por SQL e, portanto, sem invalidação possível. Guardar a AUSÊNCIA
 * dele é seguro por construção — um "não é admin" obsoleto só pode NEGAR.
 *
 * ─── Por que memória do processo, e não Redis ───────────────────────────────
 *
 * O Redis (Upstash) é opcional na instalação self-host (`lib/auth/rate-limit.ts`
 * já degrada para memória quando ele não existe). Amarrar o caminho de
 * autorização a uma dependência que pode não estar configurada obrigaria a
 * manter dois caminhos e um teste para cada. Memória do processo não tem
 * configuração, não tem rede e não tem latência — e o pior caso dela (instância
 * vizinha com entrada velha) é exatamente o mesmo do Redis sem invalidação
 * distribuída: o TTL.
 *
 * ─── Regra de falha: cache quebrado volta ao caminho de hoje ────────────────
 *
 * Toda operação com o cache é `try`/`catch`. Se a estrutura interna falhar (ou
 * o relógio, ou a clonagem), o resultado é MISS — a função de carga roda e a
 * requisição segue como antes. Nunca o contrário: não existe "achei que estava
 * autorizado porque não havia dado". Erro da CARGA também não é cacheado: erro
 * é incidente, não estado (ver o `auth_permissions_unavailable` em `server.ts`).
 */

import { createHash } from "node:crypto";

/**
 * O TTL padrão. 30 s é o menor valor que ainda cobre uma navegação inteira
 * (documento + prefetch + as chamadas de `/api/v1` que a tela dispara em
 * seguida), e é a metade do maior valor que a issue admite (60 s).
 */
export const TTL_CURTO_MS = 30_000;

/**
 * Teto de entradas. Cada entrada é um snapshot pequeno (~1 KB no pior caso).
 * O bastante para uma instalação com muita gente ativa; o excedente é
 * descartado pelo mais antigo, e o efeito de errar aqui é só MISS.
 */
const MAXIMO_DE_ENTRADAS = 2_000;

/**
 * Margem para não servir uma sessão cujo token está a ponto de expirar: se o
 * `exp` do JWT cairia nos próximos segundos, o cliente do Supabase precisa
 * passar de novo pelo `getUser()` — que é quem renova o token. Sem isso, o
 * cache poderia devolver um usuário válido com o token vencido e as consultas
 * RLS seguintes levariam 401 até a próxima requisição.
 */
const MARGEM_DE_EXPIRACAO_MS = 5_000;

interface Entrada {
  valor: unknown;
  /** epoch ms em que a entrada deixa de valer. */
  expiraEm: number;
}

/**
 * O estado mora no `globalThis`, e não em `const` deste módulo — a diferença não
 * é estilo. O Next instancia este módulo DUAS vezes no mesmo processo: um
 * runtime para `route.js` (`chunks/`) e outro para `page.js` e server actions
 * (`chunks/ssr/`) — medido em `lib/branding/instalacao.ts`. Com `const`, a
 * invalidação feita por uma rota (`/api/v1/team/[user_id]/interface`,
 * `/api/v1/admin/tenants/[id]/reactivate`…) zerava o mapa da ROTA, e a tela
 * seguia lendo o mapa da PÁGINA por até um TTL inteiro (e2e do #3712).
 */
interface EstadoDoCacheCurto {
  entradas: Map<string, Entrada>;
  /** etiqueta → chaves, para invalidar por identidade sem varrer o mapa. */
  porEtiqueta: Map<string, Set<string>>;
  /** chave → etiquetas (índice reverso, para o esquecimento). */
  etiquetasPorChave: Map<string, Set<string>>;
  /**
   * Sobe a cada invalidação. Uma carga que começou ANTES de uma escrita volta
   * com o valor pré-escrita; se a geração mudou no meio, ela não grava — senão
   * reinstalaria o valor velho por um TTL inteiro, desfazendo a invalidação.
   */
  geracao: number;
}

declare global {
  var __cacheCurtoDaAutorizacao: EstadoDoCacheCurto | undefined;
}

const estado: EstadoDoCacheCurto = (globalThis.__cacheCurtoDaAutorizacao ??= {
  entradas: new Map(),
  porEtiqueta: new Map(),
  etiquetasPorChave: new Map(),
  geracao: 0,
});
const { entradas, porEtiqueta, etiquetasPorChave } = estado;

const relogio = () => Date.now();

// ---------------------------------------------------------------------------
// Etiquetas — o nome de cada coisa que pode ser revogada.
//
// Existem como funções, e não como template string espalhado nos call sites,
// porque um erro de digitação numa etiqueta é SILENCIOSO: a escrita invalida
// uma chave que ninguém lê, e a revogação passa a depender do TTL. Uma função
// não tem como errar o prefixo.
// ---------------------------------------------------------------------------

export function etiquetaDeUsuario(usuarioId: string): string {
  return `usuario:${usuarioId}`;
}

export function etiquetaDeOrg(orgId: string): string {
  return `org:${orgId}`;
}

export function etiquetaDeSessao(chaveDaSessao: string): string {
  return `sessao:${chaveDaSessao}`;
}

/** Quantas entradas vivas — só para diagnóstico e teste. */
export function tamanhoDoCacheCurto(): number {
  return entradas.size;
}

/**
 * Derruba tudo o que foi calculado para esta pessoa: permissões, papel em
 * qualquer organização e contexto de acompanhamento.
 *
 * É isto que quem REVOGA, REBAIXA, REATIVA ou DESATIVA precisa chamar — na
 * mesma requisição da escrita, logo depois dela. Idempotente e barato: sem
 * entrada, não faz nada.
 */
export function invalidarUsuario(...ids: string[]): void {
  for (const id of ids) esquecerEtiqueta(etiquetaDeUsuario(id));
}

/**
 * Derruba o que depende do estado da ORGANIZAÇÃO — o papel de qualquer pessoa
 * nela e o snapshot de vínculos de quem é membro (que carrega `org_status`).
 * Usado quando a org é suspensa, reativada ou apagada: sem isto, quem está
 * dentro de uma empresa recém-suspensa continuaria "operante" até o TTL.
 */
export function invalidarOrg(...ids: string[]): void {
  for (const id of ids) esquecerEtiqueta(etiquetaDeOrg(id));
}

/** Derruba o que foi validado para ESTA sessão (saída, fim de acompanhamento). */
export function invalidarSessao(chaveDaSessao: string): void {
  esquecerEtiqueta(etiquetaDeSessao(chaveDaSessao));
}

/** Derruba qualquer chave exata (o `sessao:<hash>` é o caso de uso). */
export function invalidarChave(chave: string): void {
  estado.geracao += 1;
  try {
    esquecerChave(chave);
  } catch {
    // Fail-open: um cache que não sabe se limpar ainda é melhor que uma
    // requisição quebrada. O TTL cobre.
    esquecerTudo();
  }
}

/**
 * Esvazia o cache. Para os testes (cada caso precisa de estado limpo) e para
 * um eventual `SIGUSR` de operação; nada em produção chama isto por rotina.
 */
export function esquecerTudo(): void {
  estado.geracao += 1;
  entradas.clear();
  porEtiqueta.clear();
  etiquetasPorChave.clear();
}

function esquecerChave(chave: string): void {
  const entrada = entradas.get(chave);
  if (!entrada) return;
  entradas.delete(chave);
  for (const etiqueta of etiquetasDe(chave)) desligarEtiqueta(etiqueta, chave);
}

function esquecerEtiqueta(etiqueta: string): void {
  estado.geracao += 1;
  const chaves = porEtiqueta.get(etiqueta);
  if (!chaves) return;
  // Cópia: apagar de `porEtiqueta` enquanto se percorre o Set é o tipo de
  // armadilha que só aparece em produção, com duas invalidações concorrentes.
  for (const chave of [...chaves]) esquecerChave(chave);
}


function etiquetasDe(chave: string): string[] {
  return [...(etiquetasPorChave.get(chave) ?? [])];
}

function desligarEtiqueta(etiqueta: string, chave: string): void {
  const chaves = porEtiqueta.get(etiqueta);
  if (!chaves) return;
  chaves.delete(chave);
  if (chaves.size === 0) porEtiqueta.delete(etiqueta);
  const minhas = etiquetasPorChave.get(chave);
  if (!minhas) return;
  minhas.delete(etiqueta);
  if (minhas.size === 0) etiquetasPorChave.delete(chave);
}

function limparExpiradas(agora: number): void {
  for (const [chave, entrada] of entradas) {
    if (entrada.expiraEm <= agora) esquecerChave(chave);
  }
}

function abrirEspaco(agora: number): void {
  if (entradas.size < MAXIMO_DE_ENTRADAS) return;
  limparExpiradas(agora);
  // Ainda cheio: o mais antigo da ordem de inserção do Map sai. Perder uma
  // entrada a mais é MISS, nunca resposta errada.
  while (entradas.size >= MAXIMO_DE_ENTRADAS) {
    const maisAntiga = entradas.keys().next().value;
    if (maisAntiga === undefined) break;
    esquecerChave(maisAntiga);
  }
}

/** Lê a entrada, descartando-a se venceu. `undefined` = MISS. */
function ler(chave: string, agora: number): { valor: unknown } | undefined {
  const entrada = entradas.get(chave);
  if (!entrada) return undefined;
  if (entrada.expiraEm <= agora) {
    esquecerChave(chave);
    return undefined;
  }
  return { valor: entrada.valor };
}

function gravar(
  chave: string,
  valor: unknown,
  etiquetas: string[],
  expiraEm: number,
  agora: number,
): void {
  if (expiraEm <= agora) return;
  abrirEspaco(agora);
  esquecerChave(chave); // regravação não pode deixar etiqueta velha pendurada
  entradas.set(chave, { valor, expiraEm });
  const conjunto = new Set(etiquetas.filter((e) => e.length > 0));
  etiquetasPorChave.set(chave, conjunto);
  for (const etiqueta of conjunto) {
    const chaves = porEtiqueta.get(etiqueta) ?? new Set<string>();
    chaves.add(chave);
    porEtiqueta.set(etiqueta, chaves);
  }
}

/** Cópia defensiva: quem lê o snapshot não pode alterar o que está guardado. */
function copiar<T>(valor: T): T {
  try {
    return structuredClone(valor);
  } catch {
    // Sem clone utilizável, a entrada não serve — melhor MISS do que um objeto
    // mutável compartilhado entre requisições.
    throw new Error("cache_curto_sem_clone");
  }
}

export interface OpcoesDoCacheCurto<T> {
  /** Identidade do dado. Mesma chave = mesma resposta dentro do TTL. */
  chave: string;
  /** Quem derruba esta entrada (`etiquetaDeUsuario`, `etiquetaDeOrg`…). */
  etiquetas?: string[];
  /** Etiquetas que só se conhecem DEPOIS da carga (as orgs de um vínculo). */
  etiquetasDoValor?: (valor: T) => string[];
  /** Sobrepõe o TTL. Usado pelos testes; produção usa o padrão. */
  ttlMs?: number;
  /**
   * Instante absoluto (epoch ms) a partir do qual a entrada NÃO serve mais,
   * mesmo dentro do TTL — a expiração do token, por exemplo.
   */
  ate?: number;
  /**
   * Só guarda quando isto devolver `true`. É a costura que permite cachear um
   * resultado NEGATIVO ("não é platform admin") e nunca o positivo, cuja
   * revogação pode vir de fora do processo.
   */
  guardar?: (valor: T) => boolean;
  /** A carga de verdade. Se ela lançar, nada é guardado e o erro sobe. */
  carregar: () => Promise<T>;
}

/**
 * Devolve o valor em cache, ou carrega — com TODAS as falhas do cache
 * resolvidas como "não havia": carga direta, sem exceção nova.
 */
export async function comCacheCurto<T>({
  chave,
  etiquetas = [],
  etiquetasDoValor,
  ttlMs = TTL_CURTO_MS,
  ate,
  guardar,
  carregar,
}: OpcoesDoCacheCurto<T>): Promise<T> {
  const agora = relogio();
  const expiraEm = Math.min(agora + ttlMs, ate ?? Number.POSITIVE_INFINITY) - (ate ? MARGEM_DE_EXPIRACAO_MS : 0);

  // --- caminho do acerto -------------------------------------------------
  if (ttlMs > 0 && expiraEm > agora) {
    try {
      const achado = ler(chave, agora);
      if (achado) return copiar(achado.valor as T);
    } catch {
      // Estrutura do cache indisponível: segue para a carga direta.
      try {
        esquecerTudo();
      } catch {
        /* nada a fazer — o TTL cobre */
      }
    }
  }

  // --- caminho da carga --------------------------------------------------
  // Fora do `try`: erro de carga é incidente de verdade (PostgREST fora do ar,
  // RPC recusando) e precisa subir para quem chamou, como antes do cache.
  const geracaoNaCarga = estado.geracao;
  const valor = await carregar();

  if (ttlMs > 0 && expiraEm > agora && estado.geracao === geracaoNaCarga && (!guardar || guardar(valor))) {
    try {
      const todas = [...etiquetas, ...(etiquetasDoValor?.(valor) ?? [])];
      gravar(chave, copiar(valor), todas, expiraEm, agora);
    } catch {
      // Guardar falhou: a resposta desta requisição já está correta; a próxima
      // simplesmente não reaproveita. Nada a declarar.
    }
  }

  return valor;
}

// ---------------------------------------------------------------------------
// Identidade da SESSÃO a partir dos cookies — a chave do cache de sessão.
// ---------------------------------------------------------------------------

/** `sb-<ref>-auth`, `sb-<ref>-auth.0`, `sb-<ref>-auth-token`… */
const COOKIE_DE_SESSAO = /^sb-[A-Za-z0-9._-]*auth(-token)?(\.\d+)?$/;

/** O prefixo que o `@supabase/ssr` usa para o valor em base64url. */
const PREFIXO_BASE64 = "base64-";

export interface SessaoDosCookies {
  /** Hash estável do valor dos cookies: muda quando o token é rotacionado. */
  chave: string;
  /** `exp` do JWT de acesso, em epoch ms. `null` = não deu para ler. */
  expiraEm: number | null;
}

/**
 * Identifica a sessão pelos cookies, SEM falar com o GoTrue e SEM confiar neles
 * para autorizar nada.
 *
 * ⚠️ O valor daqui é CHAVE DE CACHE, não permissão. Quem autoriza continua
 * sendo `supabase.auth.getUser()` (validado no servidor), como manda o
 * cabeçalho de `lib/supabase/server.ts` — `getSession()` segue proibido no
 * backend. Aqui só se responde "esta requisição trouxe o MESMO token da
 * anterior?", e o `exp` lido do próprio JWT é o teto do TTL.
 *
 * Devolve `null` quando não há cookie de sessão ou quando o formato não é
 * reconhecido (valor em base64url quebrado, JSON inválido). Para JWT sem `exp`
 * legível, devolve a chave com `expiraEm: null` — e quem chama não cacheia sem
 * teto. Nesses casos o cache de sessão simplesmente não é usado: a requisição
 * vai pelo caminho de sempre. Fail-open para o comportamento antigo — nunca
 * para "autorizado".
 */
export function sessaoDosCookies(
  cookies: { name: string; value: string }[],
): SessaoDosCookies | null {
  try {
    const pedacos = cookies
      .filter((c) => COOKIE_DE_SESSAO.test(c.name) && !c.name.includes("code-verifier"))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (pedacos.length === 0) return null;

    // Junta os pedaços na ordem dos nomes (`...auth`, `...auth.0`, `...auth.1`).
    const bruto = pedacos.map((c) => c.value).join("");
    if (!bruto) return null;

    const chave = createHash("sha256")
      .update(pedacos.map((c) => `${c.name}=${c.value}`).join("\n"))
      .digest("hex")
      .slice(0, 32);

    const sessao = decodificarSessao(bruto);
    // Valor que não decodifica não é "sessão sem expiração": é cookie que este
    // processo não sabe ler (formato novo do `@supabase/ssr`, escrita parcial
    // entre chunks). Sem identidade confiável, caminho direto.
    if (!sessao) return null;

    return { chave, expiraEm: instanteDeExpiracaoDoJwt(sessao) };
  } catch {
    return null;
  }
}

interface SessaoDoCookie {
  access_token?: string;
  expires_at?: number;
}

/** O JSON da sessão dentro do cookie — `null` quando não dá para ler. */
function decodificarSessao(bruto: string): SessaoDoCookie | null {
  try {
    const texto = bruto.startsWith(PREFIXO_BASE64)
      ? Buffer.from(bruto.slice(PREFIXO_BASE64.length), "base64url").toString("utf8")
      : bruto;
    const sessao = JSON.parse(texto) as unknown;
    if (!sessao || typeof sessao !== "object") return null;
    return sessao as SessaoDoCookie;
  } catch {
    return null;
  }
}

function instanteDeExpiracaoDoJwt(sessao: SessaoDoCookie): number | null {
  try {
    const token = sessao.access_token;
    if (typeof token === "string") {
      const partes = token.split(".");
      if (partes.length === 3 && partes[1]) {
        const carga = JSON.parse(
          Buffer.from(partes[1], "base64url").toString("utf8"),
        ) as { exp?: number };
        if (typeof carga.exp === "number") return carga.exp * 1000;
      }
    }
    if (typeof sessao.expires_at === "number") return sessao.expires_at * 1000;
    return null;
  } catch {
    return null;
  }
}
