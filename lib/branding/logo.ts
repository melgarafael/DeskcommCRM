/**
 * Onde o logo MORA — o bucket, o caminho e a URL pública derivada dele.
 *
 * ── Por que se grava o CAMINHO, e nunca a URL ────────────────────────────────
 *
 * Doutrina DIRC, letra C (Calcular): a URL pública de um objeto no Supabase
 * Storage é `<projeto>/storage/v1/object/public/<bucket>/<caminho>` — função
 * determinística do caminho e do host do projeto. Gravar a URL amarraria a marca
 * do cliente ao host do projeto Supabase de HOJE: migrar o banco (ou trocar do
 * Supabase gerenciado para o self-hosted, que é caminho previsto do kit) deixaria
 * todas as instalações apontando para um host que não é mais o delas, e o sintoma
 * seria "o logo sumiu" sem nada no log. O caminho sobrevive à migração; a URL não.
 *
 * ── Por que o bucket é PÚBLICO — e por que isso é contido ────────────────────
 *
 * `brand-logos` é o PRIMEIRO bucket público do repositório (os quatro que já
 * existiam — `ai-policy`, `lgpd-exports`, `skill-assets`, `whatsapp-media` —
 * nascem `public = false`). A exceção é deliberada e tem uma razão medida:
 *
 *   O logo é renderizado num `<img>` da tela de LOGIN (`app/(public)/layout.tsx`),
 *   servida a quem NÃO tem sessão. URL assinada exige um segredo por requisição, e
 *   o teto de validade do Storage é curto — o logo da instalação sumiria da
 *   fachada no dia em que a assinatura vencesse, sem ninguém tocar em nada. Uma
 *   marca que expira sozinha é pior que uma marca pública.
 *
 * O que torna a exceção contida, e o que o invariante `tests/invariants/
 * marca-logo.test.ts` mede:
 *   - bucket EXCLUSIVO de logos (nada de conversa, export ou base de conhecimento);
 *   - ZERO policy de escrita em `storage.objects` para ele — só o `service_role`
 *     escreve, pela rota, depois dos gates;
 *   - caminho NÃO-ENUMERÁVEL (`<prefixo>/<uuid v4>.<ext>`): saber o id da
 *     organização não dá o caminho do arquivo;
 *   - só entram bytes FAREJADOS (`lib/branding/logo-arquivo.ts`), nunca o
 *     `Content-Type` que o cliente escolheu.
 *
 * Está registrado em `docs/threat-model.md` ao lado da linha de `whatsapp-media`:
 * exceção documentada é exceção auditável; exceção escondida é buraco.
 *
 * ── Por que o teto é 512 KB ──────────────────────────────────────────────────
 *
 * `next.config.ts` roda com `images.unoptimized`, e os dois renders do logo usam
 * `<img>` cru (a URL é de quem hospeda; `next/image` exige allowlist fechada em
 * build). Ou seja: o arquivo vai INTEIRO para o navegador em toda página, sem
 * redimensionamento. E a cota do Supabase é do CLIENTE — 1 GB no plano gratuito,
 * compartilhado com `whatsapp-media`, que não tem poda. Meio megabyte é folgado
 * para um logo e barato para a primeira pintura da tela de login.
 */

/** O bucket. Nome sem a marca do produto de propósito — ver `tests/unit/branding.test.ts`. */
export const BUCKET_DE_LOGOS = "brand-logos";

/** 512 KB. O mesmo número vive no `file_size_limit` do bucket (migration 0158). */
export const TAMANHO_MAXIMO_DO_LOGO = 512 * 1024;

/**
 * O prefixo da camada da INSTALAÇÃO.
 *
 * `platform/` e não o id de nada: `platform_branding` é um singleton (`id = 1`
 * numa coluna `smallint`), então não há uuid de tenant para escopar. O mesmo
 * prefixo já é convenção do bucket `skill-assets` no baseline.
 */
export const PREFIXO_DA_INSTALACAO = "platform/";

/** O prefixo da camada da ORGANIZAÇÃO — o uuid do tenant, sempre de fonte confiável. */
export function prefixoDaOrganizacao(organizationId: string): string {
  return `${organizationId}/`;
}

/** As duas extensões que o farejador de bytes pode devolver. */
export type ExtensaoDeLogo = "png" | "jpg";

/**
 * A FORMA do NOME de um arquivo de logo — `<uuid>.<png|jpg>`, sem barra nenhuma.
 *
 * Ancorada nas duas pontas de propósito: é a ausência de `/` aqui, somada ao
 * prefixo asseverado por `caminhoBateComPrefixo`, que impede um escopo de
 * escrever dentro de outro (`<org>/../platform/x.png`). É a MESMA forma do CHECK
 * `platform_branding_logo_path` e da validação dentro de
 * `fn_definir_logo_da_organizacao` — três lugares porque são três fronteiras
 * (tipo, banco da instalação, banco da organização), não por redundância.
 */
export const FORMA_DO_NOME_DO_LOGO =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg)$/;

/**
 * O caminho está DENTRO do prefixo — e nada além disso.
 *
 * As duas metades são necessárias e nenhuma basta sozinha: `startsWith` sem a
 * forma do nome aceitaria `platform/../../qualquer-coisa`; a forma do nome sem
 * `startsWith` aceitaria o arquivo de OUTRO escopo. Esta é a asserção que decide
 * se o `service_role` pode apagar um objeto — ver `podeApagar` em
 * `lib/branding/logo-arquivo.ts`.
 */
export function caminhoBateComPrefixo(caminho: string, prefixo: string): boolean {
  if (prefixo.length === 0 || !prefixo.endsWith("/")) return false;
  if (!caminho.startsWith(prefixo)) return false;
  return FORMA_DO_NOME_DO_LOGO.test(caminho.slice(prefixo.length));
}

/**
 * Um caminho novo dentro de um prefixo. O nome é um uuid v4 — não-enumerável e
 * sem nenhum dado do cliente dentro.
 *
 * `crypto.randomUUID()` global (não `node:crypto`): este módulo é importado por
 * `lib/branding/resolve.ts`, que roda dos DOIS lados da fronteira. Um `import`
 * de `node:crypto` aqui arrastaria o módulo inteiro para o bundle do navegador.
 */
export function caminhoNovoDoLogo(prefixo: string, extensao: ExtensaoDeLogo): string {
  return `${prefixo}${crypto.randomUUID()}.${extensao}`;
}

/**
 * A URL pública de um caminho. PURA: recebe a base, não a procura.
 *
 * Base sem barra no fim e caminho sem barra no começo — as duas normalizações
 * aqui, e não em cada chamador, porque `NEXT_PUBLIC_SUPABASE_URL` com barra final
 * é grafia legítima que o operador escreve no `.env` e produziria `//storage`.
 */
export function urlPublicaDoLogo(caminho: string, base: string): string {
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${BUCKET_DE_LOGOS}/${caminho.replace(/^\/+/, "")}`;
}

/**
 * A base do Storage, lida do MESMO lugar que `branding()` lê a marca.
 *
 * Runtime, nunca o bundle: a imagem Docker é genérica e as `NEXT_PUBLIC_*` não
 * são queimadas em build (ver `app/public-env-script.tsx`). No navegador vem de
 * `window.__PUBLIC_ENV__`, injetado a cada requisição; no servidor, de
 * `process.env`, que o contêiner recebe do `.env` do operador.
 *
 * String vazia quando não dá para saber — e quem chama trata isso como "não há
 * logo", descendo para a camada de baixo. Montar uma URL relativa seria pior:
 * o `<img>` pediria `/storage/v1/...` ao próprio app e receberia HTML de 404.
 */
export function baseDoStorage(): string {
  if (typeof window !== "undefined") {
    return (window.__PUBLIC_ENV__?.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  }
  // ⚠️ O `process.env` INTEIRO, e NUNCA `process.env.NEXT_PUBLIC_SUPABASE_URL`.
  //
  // O Next substitui todo acesso ESTÁTICO a `process.env.NEXT_PUBLIC_*` pelo
  // valor do BUILD — inclusive no bundle do servidor. E o Dockerfile builda com
  // `ARG NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co`, porque a
  // imagem é genérica. Resultado, medido no contêiner de produção:
  //
  //   function n(){return"https://placeholder.supabase.co".trim()}
  //
  // A função inteira virou constante. Toda instalação que subisse um logo
  // recebia `https://placeholder.supabase.co/storage/...` no `<img>` — imagem
  // quebrada, com o arquivo intacto no Storage e o caminho certo no banco. O
  // comentário do Dockerfile ("no servidor via lib/env.ts, que parseia
  // process.env em runtime") descrevia o que DEVIA acontecer; este arquivo não
  // passava por lá.
  //
  // Ler pela variável derrota a substituição: o Next só reescreve o acesso
  // estático, e é exatamente por isso que `lib/env.ts` — que faz
  // `schema.safeParse(process.env)` — sempre teve o valor certo em runtime.
  // A chave é MONTADA em tempo de execução, e isso não é firula.
  //
  // A primeira tentativa foi ler por uma variável (`const ambiente =
  // process.env; ambiente.NEXT_PUBLIC_SUPABASE_URL`). Não bastou — o compilador
  // segue o alias. Medido no bundle da imagem publicada com o conserto dentro:
  //
  //   function d(a,b,c=(process.env,"https://placeholder.supabase.co".trim()))
  //
  // Ele avaliou `process.env` pelo efeito colateral e substituiu o acesso do
  // mesmo jeito. A substituição casa o NOME da propriedade, então a única forma
  // de escapar é o nome não existir no código: montado assim, não há literal
  // `NEXT_PUBLIC_SUPABASE_URL` para casar.
  //
  // Verificado do jeito que importa — buildando com o placeholder do Dockerfile
  // e procurando no `.next`, que é como o defeito foi encontrado.
  const chave = ["NEXT", "PUBLIC", "SUPABASE", "URL"].join("_");
  return ((process.env as Record<string, string | undefined>)[chave] ?? "").trim();
}

/**
 * O que uma camada de marca mostra como logo: o ARQUIVO SUBIDO vence a URL colada.
 *
 * A precedência é por CAMPO e dentro da mesma camada, e a ordem não é arbitrária:
 * `logo_url` é o campo herdado do `.env` (`APP_LOGO_URL`), que continua existindo
 * como rede de rollback — o `agent.sh` reverte a imagem, nunca o banco, então uma
 * instalação pode voltar a rodar código que não conhece `logo_path`. Quem subiu um
 * arquivo pela tela expressou a escolha mais recente; quem só tem a URL do `.env`
 * continua com ela.
 *
 * `base` com default para os dois chamadores reais não precisarem repeti-la, e
 * explícito para o teste poder exercer a função sem tocar em `process.env` — é a
 * mesma disciplina de `resolveBranding` e `camadaDoAmbiente`.
 */
export function logoDaCamada(
  caminho: string | null | undefined,
  url: string | null | undefined,
  base: string = baseDoStorage(),
): string | null {
  const limpo = (caminho ?? "").trim();
  if (limpo.length > 0 && base.length > 0) return urlPublicaDoLogo(limpo, base);
  const colada = (url ?? "").trim();
  return colada.length > 0 ? colada : null;
}
