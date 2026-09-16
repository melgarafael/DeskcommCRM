/**
 * A marca da instalação, no BANCO — leitura, semeadura e o estado da falha.
 *
 * Este é o único módulo que fala com `platform_branding`. O resolvedor
 * (`resolve.ts`) continua puro: ele recebe camadas e não sabe de onde vieram.
 *
 * ── Por que sair do `.env` ────────────────────────────────────────────────────
 *
 * Trocar nome, logo ou cor exigia SSH na VPS, editar o `.env` e reiniciar a
 * stack. Para o público-alvo do kit — quem compra hospedagem e instala sozinho —
 * isso é o mesmo que não ser configurável.
 *
 * ── Por que o `.env` CONTINUA sendo escrito (não é redundância) ───────────────
 *
 * O `agent.sh` do kit, em falha de update, reverte só a IMAGEM (`APP_IMAGE`) —
 * não o schema, não o `git checkout`. E o `update.sh` aplica o baseline ANTES de
 * puxar a imagem. Ou seja: o rollback põe CÓDIGO ANTIGO sobre BANCO NOVO por
 * construção. Código antigo não conhece esta tabela; se a marca só existisse
 * aqui, ela SUMIRIA no meio de um rollback — o pior momento possível para o
 * cliente descobrir mais um problema. Com o `.env` intacto, a marca degrada para
 * o valor da instalação e a tela continua sendo a do cliente.
 *
 * ── O cache: memo do PROCESSO com TTL, invalidado pela escrita ────────────────
 *
 * NÃO é `unstable_cache`/`revalidateTag`, e a decisão é de ÂNCORA, não de gosto:
 *
 *   1. `unstable_cache` tem ZERO ocorrências neste repo (controle positivo:
 *      `revalidatePath` aparece em 9 arquivos). Seria primitiva nova num projeto
 *      que nunca a usou, para resolver um problema que o memo resolve.
 *
 *   2. Na VPS — que é o público-alvo, não a Vercel — há UM processo de app
 *      (`Dockerfile`, `node server.js`, sem cluster e sem réplicas), com os 16
 *      crons do `scheduler` batendo nele por HTTP.
 *
 * ⚠️ Este bloco dizia "memo de MÓDULO" e concluía, de (2), que "a invalidação da
 * escrita alcança o mesmo processo que renderiza". A premissa é verdadeira e a
 * conclusão era FALSA, porque um processo não é uma instância de módulo — ver o
 * comentário do memo lá embaixo, com a medição do build.
 *
 * O TTL existe para o que a invalidação NÃO alcança: edição direta no banco
 * (`psql`), e uma segunda réplica no dia em que existir. Curto o bastante para o
 * operador não achar que a mudança se perdeu; longo o bastante para o caminho de
 * render não bater no banco por requisição.
 *
 * ── O `worker` é um SEGUNDO processo e nunca vê a invalidação ─────────────────
 *
 * `Dockerfile.worker` sobe um processo próprio. Ele não renderiza marca hoje —
 * medido: nenhum dos 8 call sites de `lib/branding` está em `workers/`. Quando
 * renderizar (e-mail, PDF), a regra é LER DO BANCO NO ENVIO, sem memo: um envio
 * é raro comparado a um render, o custo de uma leitura é irrelevante ali, e um
 * memo naquele processo entregaria a marca velha por até um TTL inteiro sem
 * ninguém ter como perceber.
 *
 * ── Sem `event_log` ──────────────────────────────────────────────────────────
 *
 * Confirmado lendo `lib/event-log/register-handlers.ts`: os 12 handlers
 * registrados cobrem IA, RAG, LGPD, automações, follow-up e mídia. Nenhum
 * cobriria um tipo `platform_branding.*`, e o drain deixa evento sem handler
 * INTOCADO — a linha nasceria `pending` para sempre em todo clone. Evento sem
 * consumer é o anti-pattern nº 3 do CLAUDE.md. O registro desta mutação é
 * `audit()`, que tem consumidor real (a tela de auditoria).
 */

import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

import { ehHexValido, normalizarHex } from "./rampa";
import type { LinhaDaInstalacao } from "./resolve";

/** A linha inteira de `platform_branding`. O resolvedor só conhece três campos. */
export type LinhaDaMarca = LinhaDaInstalacao & {
  readonly show_powered_by: boolean;
  readonly seeded_from_env: boolean;
  readonly fallback_at: string | null;
  readonly fallback_reason: string | null;
};

/** O que o `.env` tem a promover. `null` = o ambiente não fala de marca. */
export type SementeDoAmbiente = {
  readonly app_name: string | null;
  readonly logo_url: string | null;
  readonly accent_hex: string | null;
};

/**
 * ⚠️ Coluna nova aqui é TUDO OU NADA por construção, e isso é escolha declarada.
 *
 * Código novo sobre schema velho (o rollback pela outra ponta, e o que acontece
 * num deploy que sobe a `main` sem ninguém aplicar o baseline) faz o PostgREST
 * devolver `42703` para a linha inteira — não uma linha com a coluna faltando.
 * `lerLinha` trata isso como "o banco não falou" e o resolvedor cai no `.env`,
 * com aviso no log. Ou seja: quem não aplicou a 0158 perde a marca DO BANCO,
 * não só o logo, até aplicar.
 *
 * A alternativa (um segundo `select` só para `logo_path`, tolerando o erro dele)
 * custaria uma ida ao banco por render para proteger um estado que o `install.sh`
 * e o `update.sh` já resolvem — os dois aplicam o `baseline.sql` antes de subir a
 * imagem. Mesma exposição que `fallback_at`/`fallback_reason` já tinham desde a
 * 0155; tratá-la diferente agora criaria duas regras para o mesmo caso.
 */
const COLUNAS =
  "app_name, logo_url, logo_path, accent_hex, show_powered_by, seeded_from_env, fallback_at, fallback_reason";

/**
 * Códigos de recusa — os que significam "a cor configurada NÃO pintou".
 *
 * Lista explícita, e não "qualquer motivo", porque a diferença entre as duas é
 * o que decide se `fallback_at` vira um alarme útil ou ruído:
 *
 *   - `semantica_deslocada` e `accent_deslocado` acontecem em quase toda marca:
 *     a cor PINTOU, só andou na rampa. Contá-los deixaria o alarme aceso sempre.
 *   - `accent_sem_contraste_possivel` também NÃO entra: o produto pinta a cor do
 *     cliente mesmo assim, fora do piso. É degradação, não fallback — e o nome
 *     da coluna é o contrato.
 *   - `token_nao_serializado` é dívida DECLARADA desta fase (as semânticas não
 *     saem no CSS), não recusa da cor de ninguém.
 *   - `algoritmo_desconhecido` é informativo: a cor pinta, derivada por este
 *     build. É justamente o caso que faz um rollback manter a marca no ar.
 *   - `cor_ausente` e `papel_nao_pinta` são configuração, não falha.
 *
 * Sobra o que de fato derruba a cor: envelope ilegível, hex inválido, formato de
 * outra versão, papel desconhecido, derivação que lançou, e as três recusas da
 * serialização.
 */
const CODIGOS_DE_RECUSA: ReadonlySet<string> = new Set([
  "envelope_malformado",
  "semente_invalida",
  "formato_desconhecido",
  "papel_desconhecido",
  "derivacao_falhou",
  "nome_de_token_invalido",
  "valor_fora_da_allowlist",
  "saida_suspeita",
]);

/**
 * O que o `.env` promove na primeira leitura.
 *
 * `accent_hex` é NORMALIZADO aqui (`#FFF` → `#ffffff`) porque o CHECK do banco é
 * `^#[0-9a-f]{6}$`: gravar duas grafias da mesma cor faria a comparação
 * "mudou?" mentir, e gravar `#FFF` cru derrubaria o INSERT com um 23514 que
 * ninguém saberia ler. Hex inválido NÃO é promovido — mas continua no `.env`, e
 * a camada do ambiente o recusa com motivo, que é onde o operador vê o erro.
 * Falhar fechado na AÇÃO, aberto na INFORMAÇÃO.
 */
export function sementeDoAmbiente(fonte: {
  APP_NAME?: string;
  APP_LOGO_URL?: string;
  APP_ACCENT_HEX?: string;
}): SementeDoAmbiente | null {
  const texto = (v: string | undefined) => {
    const t = (v ?? "").trim();
    return t.length > 0 ? t : null;
  };
  const hexCru = (fonte.APP_ACCENT_HEX ?? "").trim();
  const semente: SementeDoAmbiente = {
    app_name: texto(fonte.APP_NAME),
    logo_url: texto(fonte.APP_LOGO_URL),
    accent_hex: ehHexValido(hexCru) ? normalizarHex(hexCru) : null,
  };
  const temAlgo =
    semente.app_name !== null || semente.logo_url !== null || semente.accent_hex !== null;
  return temAlgo ? semente : null;
}

export type Semeadura = "inserir" | "completar" | "nao";

/**
 * Decide se o `.env` promove — e é aqui que mora a regra que protege o operador.
 *
 * `seeded_from_env` NÃO é enfeite de proveniência: é o que impede a semeadura de
 * desfazer uma escolha humana. A escrita pela server action zera o campo, então
 * uma linha `seeded_from_env = false` NUNCA é semeada de novo — inclusive quando
 * a pessoa apagou os três campos de propósito para voltar ao padrão do produto.
 * Sem essa condição, o `.env` reescreveria a decisão dela no render seguinte, e
 * o campo pareceria não funcionar.
 *
 * `completar` existe para o caso real do kit: instalação feita com o `.env` sem
 * marca (a pergunta `APP_NAME` é a ÚLTIMA da entrevista e pode ser pulada), e o
 * operador preenchendo o `.env` depois. Sem ele, a linha vazia semeada no
 * primeiro render travaria a promoção para sempre.
 */
export function precisaSemear(
  linha: LinhaDaMarca | null,
  semente: SementeDoAmbiente | null,
): Semeadura {
  if (!semente) return "nao";
  if (!linha) return "inserir";
  if (!linha.seeded_from_env) return "nao";
  const vazia =
    !(linha.app_name ?? "").trim() &&
    !(linha.logo_url ?? "").trim() &&
    !(linha.accent_hex ?? "").trim();
  return vazia ? "completar" : "nao";
}

/**
 * O motivo do fallback, ou `null` quando não houve recusa.
 *
 * Emite FORMA, nunca IDENTIDADE — mesma disciplina de `resolve.ts` e
 * `contraste.ts`. Aqui isso não é zelo abstrato: `fallback_reason` é uma coluna
 * que o suporte lê, e o hex da marca de um cliente não tem por que aparecer no
 * diagnóstico de outro quando a tabela por organização entrar.
 */
export function motivoDoFallback(
  motivos: readonly { readonly codigo: string; readonly alvo?: string | null }[],
): string | null {
  const recusas = motivos.filter((m) => CODIGOS_DE_RECUSA.has(m.codigo));
  if (recusas.length === 0) return null;
  const rotulos = [
    ...new Set(recusas.map((m) => (m.alvo ? `${m.codigo}@${m.alvo}` : m.codigo))),
  ].sort();
  // Corte defensivo: `fallback_reason` é `text` e não tem limite no banco, mas
  // uma string sem teto num campo que a tela vai mostrar é como se cria um
  // layout quebrado meses depois.
  const texto = rotulos.join(", ");
  return texto.length > 500 ? `${texto.slice(0, 497)}…` : texto;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/**
 * Curto de propósito. O que a invalidação da escrita já cobre (o processo do
 * app) não precisa de TTL nenhum; o TTL só existe para edição direta no banco e
 * para uma segunda réplica hipotética. 30s é abaixo do que uma pessoa espera
 * antes de concluir "não salvou", e acima do intervalo entre dois renders.
 */
const TTL_MS = 30_000;

type Memoria = { readonly linha: LinhaDaMarca | null; readonly expiraEm: number };

/**
 * O memo mora no PROCESSO, e não num `let` deste módulo. A diferença não é
 * estilo: um `let` aqui é por INSTÂNCIA DE MÓDULO, e este módulo é instanciado
 * DUAS vezes dentro do mesmo processo.
 *
 * MEDIDO em 2026-08-14 no `next build` deste repo (Next 16.3, Turbopack). Os
 * nomes de chunk e os ids são HASHES daquele build — o que se repete em qualquer
 * build é a FORMA: entrada de rota e entrada de página carregam runtimes
 * diferentes.
 *
 *   .next/server/app/api/v1/marca/logo/route.js
 *     → require("chunks/[turbopack]_runtime.js")      → chunks/lib_0oox3fh._.js     (id 545718)
 *   .next/server/app/admin/(protected)/marca/page.js
 *     → require("chunks/ssr/[turbopack]_runtime.js")  → chunks/ssr/lib_14h72ih._.js (id 301182)
 *
 * São dois ARQUIVOS de runtime, e a divisão é limpa: das entradas geradas,
 * 206/206 `route.js` carregam o primeiro e 98/98 `page.js` carregam o segundo —
 * zero exceção nos dois lados. Cada um tem o seu
 * `const moduleCache = Object.create(null)` e ZERO registro em `globalThis`
 * (conferido nos dois), e dois ids diferentes para este mesmo arquivo. Ou seja:
 * a rota que GRAVA e a tela que RENDERIZA nunca compartilharam este módulo.
 * `invalidarMarcaDaInstalacao()` chamada de `app/api/v1/marca/logo/route.ts`
 * zerava um memo que nenhuma tela lê, e a troca de logo só aparecia quando o TTL
 * de 30s expirasse sozinho — atrás de um toast que já dizia "Logo atualizado.".
 *
 * Para reproduzir a medição num build novo:
 *
 *   head -1 '.next/server/app/admin/(protected)/marca/page.js'
 *   head -1 .next/server/app/api/v1/marca/logo/route.js
 *   grep -rl 'não deu para ler do banco' .next/server/chunks
 *
 * O CONTROLE que separa "a invalidação não funciona" de "a invalidação não
 * ALCANÇA": a server action `app/actions/settings/updateBranding.ts` chama
 * exatamente a mesma função e sempre funcionou. Ela é compilada no runtime das
 * PÁGINAS (`chunks/ssr/…`, medido), então zera o memo que a tela lê. Mesma
 * função, mesmo processo, resultados opostos — a variável era o runtime.
 *
 * `globalThis` é o único endereço que as duas instâncias enxergam (mesmo
 * processo, mesmo realm), e por isso é ele, e não um módulo "compartilhado":
 * qualquer módulo novo seria duplicado pelo bundler exatamente como este.
 *
 * O que isto NÃO resolve, declarado: o dia em que houver mais de um processo de
 * app. Ali continua valendo o TTL acima — a mesma garantia que este arquivo
 * sempre declarou para a edição direta no banco.
 */
declare global {
  var __memoDaMarcaDaInstalacao: Memoria | null | undefined;
  /**
   * Contador de escritas. Mora em `globalThis` pelo MESMO motivo que o memo — e
   * o motivo está escrito acima: a rota que grava e a tela que renderiza são
   * duas instâncias do módulo, e um `let` de arquivo falharia calado.
   *
   * Ele existe porque zerar o memo não basta: uma leitura que já estava em voo
   * quando a escrita aconteceu volta com a linha PRÉ-ESCRITA e a reinstala por
   * um TTL inteiro, desfazendo a invalidação. Ver o comentário de
   * `marcaDaInstalacao`.
   */
  var __geracaoDaMarcaDaInstalacao: number | undefined;
}

function memoEmVigor(): Memoria | null {
  return globalThis.__memoDaMarcaDaInstalacao ?? null;
}

function guardarMemo(valor: Memoria | null): void {
  globalThis.__memoDaMarcaDaInstalacao = valor;
}

/** Chamada por quem ESCREVE a marca — server action ou rota. */
export function invalidarMarcaDaInstalacao(): void {
  // A geração sobe ANTES de zerar: quem estiver lendo agora fica marcado como
  // anterior a esta escrita e não poderá reinstalar o que leu.
  globalThis.__geracaoDaMarcaDaInstalacao = (globalThis.__geracaoDaMarcaDaInstalacao ?? 0) + 1;
  guardarMemo(null);
}

/**
 * Avisos já registrados neste processo, para o log não repetir a cada render.
 * Mesmo desenho do `motivosRegistrados` de `app/layout.tsx`.
 */
const avisosRegistrados = new Set<string>();

function avisarUmaVez(chave: string, mensagem: string, contexto: Record<string, unknown>): void {
  if (avisosRegistrados.has(chave)) return;
  avisosRegistrados.add(chave);
  logger.warn(mensagem, contexto);
}

/**
 * Lê (e, na primeira vez, semeia) a marca da instalação.
 *
 * NUNCA LANÇA. É chamada de `app/layout.tsx`, que embrulha o produto inteiro —
 * uma exceção aqui é 500 em todas as telas, inclusive na tela onde alguém
 * corrigiria o que quebrou. `null` significa "o banco não falou", e o resolvedor
 * cai na camada do `.env`, que é uma instalação funcionando.
 *
 * O caso `42P01` (relation does not exist) é o rollback pela OUTRA ponta: código
 * novo sobre schema velho — o que acontece na Vercel, onde a `main` sobe sem
 * ninguém aplicar migration. Ele degrada para o `.env` igual, com um aviso.
 */
export async function marcaDaInstalacao(): Promise<LinhaDaMarca | null> {
  const memoria = memoEmVigor();
  if (memoria && memoria.expiraEm > Date.now()) return memoria.linha;

  // A geração é lida ANTES do await, e conferida depois. Sem isso o memo sofre
  // lost-update: uma leitura que entrou em voo antes de `invalidarMarcaDaInstalacao()`
  // volta com a linha PRÉ-ESCRITA e a grava com TTL novo, desfazendo a
  // invalidação da rota — e a tela passa a negar o logo por até TTL_MS inteiros,
  // ATRÁS DE UM TOAST VERDE.
  //
  // Não é hipótese: medido no trace do CI em 2026-08-20. Um POST 200 em
  // `/api/v1/marca/logo` às 462851ms; 19,6s depois, num contexto NOVO com login
  // NOVO, a tela de marca ainda renderizava "Sem logo próprio, o sistema usa o
  // logo do arquivo de instalação do servidor" e o botão Remover da camada de
  // instalação não existia. A rajada de prefetch RSC que envenenou o memo tinha
  // começado 53ms ANTES do POST.
  //
  // O `Date.now()` do TTL também passa a ser lido DEPOIS da ida ao banco: antes
  // ele era capturado antes, e a espera do banco descontava do próprio TTL.
  const geracao = globalThis.__geracaoDaMarcaDaInstalacao ?? 0;
  const linha = await lerOuSemear();
  if ((globalThis.__geracaoDaMarcaDaInstalacao ?? 0) === geracao) {
    guardarMemo({ linha, expiraEm: Date.now() + TTL_MS });
  }
  return linha;
}

async function lerOuSemear(): Promise<LinhaDaMarca | null> {
  const atual = await lerLinha();
  if (atual === "erro") return null;

  // `env` e não `process.env` cru: é a mesma fonte que `app/layout.tsx` passa
  // para `camadaDoAmbiente`, já validada por Zod. Duas leituras do ambiente com
  // regras diferentes divergiriam justamente no caso de borda (chave declarada e
  // vazia), que é o estado que o `install.sh` deixa quando ninguém responde.
  const semente = sementeDoAmbiente(env);
  const acao = precisaSemear(atual, semente);
  if (acao === "nao" || !semente) return atual;

  const semeada = await semear(acao, semente);
  // A semeadura pode perder uma corrida com outro processo (dois renders
  // simultâneos no primeiro acesso). Perder é inócuo — os dois escreveriam o
  // MESMO `.env` —, e reler é mais honesto que devolver o que eu queria ter
  // gravado.
  if (semeada) return semeada;
  const relida = await lerLinha();
  return relida === "erro" ? null : relida;
}

async function lerLinha(): Promise<LinhaDaMarca | null | "erro"> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_branding")
      .select(COLUNAS)
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      avisarUmaVez(
        `leitura|${error.code ?? "?"}`,
        "marca da instalação: não deu para ler do banco; vale o .env",
        { codigo: error.code, detalhe: error.message },
      );
      return "erro";
    }
    return (data as LinhaDaMarca | null) ?? null;
  } catch (erro) {
    avisarUmaVez("leitura|excecao", "marca da instalação: leitura falhou; vale o .env", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return "erro";
  }
}

async function semear(
  acao: Exclude<Semeadura, "nao">,
  semente: SementeDoAmbiente,
): Promise<LinhaDaMarca | null> {
  const valores = { ...semente, seeded_from_env: true };
  try {
    const cliente = createAdminClient();
    const consulta =
      acao === "inserir"
        ? cliente.from("platform_branding").insert({ id: 1, ...valores })
        : // As três condições de `is null` vão no WHERE do UPDATE, e não num `if`
          // do TypeScript: entre o `select` e o `update` cabe outro processo, e o
          // banco é o único lugar onde a condição e a escrita são atômicas.
          cliente
            .from("platform_branding")
            .update(valores)
            .eq("id", 1)
            .eq("seeded_from_env", true)
            .is("app_name", null)
            .is("logo_url", null)
            .is("accent_hex", null);

    const { data, error } = await consulta.select(COLUNAS).maybeSingle();
    if (error) {
      // `23505` é a corrida do INSERT (outro render semeou primeiro) e não é
      // defeito: quem chama relê. Qualquer outro código é.
      if (error.code !== "23505") {
        avisarUmaVez(
          `semeadura|${error.code ?? "?"}`,
          "marca da instalação: não deu para semear do .env; vale o .env em runtime",
          { acao, codigo: error.code, detalhe: error.message },
        );
      }
      return null;
    }
    return (data as LinhaDaMarca | null) ?? null;
  } catch (erro) {
    avisarUmaVez("semeadura|excecao", "marca da instalação: semeadura falhou", {
      acao,
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}

/** O último estado que este processo gravou — evita reescrever o mesmo a cada render. */
let ultimoEstadoGravado: string | null | undefined = undefined;

/**
 * Grava (ou apaga) o estado de fallback.
 *
 * Sem isto, o degrade é INDISTINGUÍVEL de "a feature nunca foi instalada": o
 * operador vê a cor do produto e conclui que o campo não funciona. É o
 * invariante 6 da doutrina Sistema Vivo — informação com propósito — e o motivo
 * pelo qual `fallback_at`/`fallback_reason` são colunas e não um `logger.warn`
 * que ninguém abre.
 *
 * E LIMPA quando a resolução volta a passar. Alarme que não apaga sozinho ensina
 * a ignorar alarme — o operador corrigiria o hex e continuaria vendo "sua cor
 * foi recusada" para sempre.
 *
 * Fire-and-forget e sem `await` no caminho de render: um problema para gravar o
 * diagnóstico não pode derrubar a página que o diagnóstico descreve.
 */
export async function registrarEstadoDaMarca(
  linha: LinhaDaMarca | null,
  motivo: string | null,
): Promise<void> {
  // Sem linha não há onde gravar — e criar uma só para registrar fallback
  // inventaria configuração que ninguém pediu.
  if (!linha) return;
  // Nada a fazer quando o estado desejado já é o que está no banco. Cobre os
  // dois lados: sem recusa e sem alarme aceso, ou recusa idêntica à gravada.
  const jaGravado = linha.fallback_at === null ? null : linha.fallback_reason;
  if (motivo === jaGravado) return;
  // A linha veio do memo, que pode ser mais velha que a última escrita deste
  // processo (dois renders concorrentes entram aqui antes de qualquer releitura).
  // Sem esta guarda, os dois gravariam o mesmo estado.
  if (ultimoEstadoGravado === motivo) return;

  try {
    const { error } = await createAdminClient()
      .from("platform_branding")
      .update({
        fallback_at: motivo === null ? null : new Date().toISOString(),
        fallback_reason: motivo,
      })
      .eq("id", 1);
    if (error) {
      avisarUmaVez(`estado|${error.code ?? "?"}`, "marca da instalação: estado não gravado", {
        codigo: error.code,
        detalhe: error.message,
      });
      return;
    }
    ultimoEstadoGravado = motivo;
    // A linha em memória ficou velha (o trigger mexeu no `updated_at`, e os dois
    // campos de estado mudaram). Deixar o memo mentir sobre o próprio estado que
    // acabamos de gravar faria o render seguinte tentar gravar de novo.
    invalidarMarcaDaInstalacao();
  } catch (erro) {
    avisarUmaVez("estado|excecao", "marca da instalação: estado não gravado", {
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
  }
}
