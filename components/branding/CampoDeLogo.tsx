"use client";

/**
 * O campo do logo — subir, ver nas DUAS superfícies, e remover.
 *
 * ── Por que a prévia mostra o logo sobre CLARO e ESCURO ──────────────────────
 *
 * O modo de falha campeão de logo em produto com dois temas é o arquivo escuro
 * com fundo transparente: fica perfeito na tela onde a pessoa subiu e some no
 * outro tema, que ela nunca abre. Descobrir isso pelo relato de um cliente é
 * caro; descobrir na hora do upload é grátis.
 *
 * E a prévia é a imagem REAL, renderizada pelo navegador sobre as duas
 * superfícies do produto. Foi a alternativa escolhida contra um analisador de
 * luminância no servidor: aquele exigiria decodificar PNG (bytes controlados por
 * quem sobe, mais guarda de bomba de descompressão), seria cego para PNG
 * entrelaçado e para JPEG, e terminaria escrevendo em português o que estas duas
 * caixas mostram com precisão total e zero linha de parser.
 *
 * As duas cores vêm da RÉGUA DO PRODUTO (`--color-surface` de cada tema), nunca
 * digitadas: são as mesmas superfícies onde o logo de fato aparece — a barra
 * lateral e o cartão do login. Um par de hexes escritos aqui viraria a quinta
 * cópia de uma cor que o produto já declara em um lugar só.
 *
 * ── Por que o upload é IMEDIATO, e não parte do "Salvar" do formulário ───────
 *
 * O arquivo tem rota própria (`/api/v1/marca/logo`) porque o que atravessa é
 * multipart, não JSON, e porque o ponteiro é gravado por um escritor próprio no
 * banco — a função da marca substitui o objeto inteiro e apagaria o logo. Juntar
 * os dois no mesmo botão significaria segurar bytes em memória do navegador até
 * alguém clicar em Salvar, e perder o arquivo em toda navegação acidental.
 */

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { melhorFrenteSobre } from "@/lib/branding/contraste";
import { TAMANHO_MAXIMO_DO_LOGO } from "@/lib/branding/logo";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { useT } from "@/hooks/i18n/useT";

/** A superfície onde o logo de fato aparece, em cada tema. Lida, nunca digitada. */
function superficie(tema: "claro" | "escuro"): string {
  const encontrada = REGUA_DO_PRODUTO[tema].base.find((b) => b.chave === "--color-surface");
  // O `??` não é zelo abstrato: `base` é `readonly {...}[]`, então o compilador
  // não garante que a chave exista. Cair no fundo do tema é o degrade certo —
  // a prévia continua contrastando, só não é exatamente a superfície do produto.
  return encontrada?.hex ?? REGUA_DO_PRODUTO[tema].base[0]?.hex ?? "#ffffff";
}

const SUPERFICIE_CLARA = superficie("claro");
const SUPERFICIE_ESCURA = superficie("escuro");

export type EscopoDoLogo = "instalacao" | "organizacao";

interface Props {
  readonly escopo: EscopoDoLogo;
  /**
   * O logo que ESTA camada gravou, já como URL pública. `url: null` = esta
   * camada não tem logo próprio — e aí quem aparece é `logoHerdado`.
   *
   * ⚠️ É um OBJETO, e não a string solta, e isso NÃO é enfeite: quem repõe o
   * estado local (lá embaixo) precisa distinguir "o servidor não falou" de "o
   * servidor falou e repetiu o mesmo valor". Com `string | null`, identidade é
   * igualdade — um render novo dizendo `null` para uma camada que já estava
   * `null` seria indistinguível de nenhum render, e a prévia ficaria grudada no
   * que o cliente escreveu. Com um objeto criado no call site, TODO render novo
   * do servidor traz identidade nova e volta ao comando.
   *
   * Consequência para quem mexe: passe um literal (`{ url: … }`) no JSX. Guardar
   * este objeto num `useMemo` ou num módulo devolveria o defeito em silêncio —
   * é o que `tests/unit/marca-previa-do-logo-sem-refresh.test.tsx` (3) vigia.
   */
  readonly logoDaCamada: { readonly url: string | null };
  /**
   * O que o produto mostra quando esta camada não tem nada. `null` = ninguém tem
   * logo, e a interface aparece com o NOME em texto.
   */
  readonly logoHerdado: string | null;
  /** Uma frase dizendo de quem é o logo herdado ("do sistema", "da instalação"). */
  readonly origemDoHerdado: string;
  /** O nome em vigor — vira o `alt` da prévia e o texto do caso sem logo. */
  readonly nomeEmVigor: string;
}

/** Mensagem por código de recusa da rota. */
const ERRO_EM_PORTUGUES: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo para trocar o logo.",
  forbidden_role: "Você não tem permissão para trocar este logo.",
  forbidden_tenant: "Nenhuma empresa ativa nesta sessão.",
  mfa_required: "Confirme o segundo fator nesta sessão e tente de novo.",
  rate_limited: "Muitas trocas seguidas. Tente de novo em alguns minutos.",
};

export function CampoDeLogo({
  escopo,
  logoDaCamada,
  logoHerdado,
  origemDoHerdado,
  nomeEmVigor,
}: Props) {
  const t = useT();
  const router = useRouter();
  const entrada = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);
  /**
   * Marcador de HIDRATAÇÃO, lido pelo e2e antes de `setInputFiles`.
   *
   * `setInputFiles` só espera o elemento estar ANEXADO — e o input existe no
   * HTML do SSR antes de o React atar o `onChange`. Um arquivo posto nessa
   * janela não dispara requisição nenhuma, e o teste espera 15s por um toast
   * que nunca teve emissor. Medido no run 32404132717 do CI: `load` às
   * 472156ms, `setInputFiles` 46ms depois, e ZERO POST para
   * `/api/v1/marca/logo` no trace inteiro (controle positivo: os POSTs de
   * `/login` e `/login/mfa` estão lá).
   *
   * Esperar o input "visível" NÃO resolve — visível é propriedade do SSR.
   *
   * `useSyncExternalStore` e não `useState`+`useEffect`: é o padrão canônico
   * para "estou no cliente?" e não dispara o aviso `react-hooks/set-state-in-effect`.
   * O `subscribe` devolve um no-op de propósito — o valor nunca muda depois de
   * hidratar.
   */
  const hidratado = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [, startTransition] = useTransition();

  /**
   * ⚠️ O LOGO DESTA CAMADA VEM DO SERVIDOR E É ATUALIZADO PELO CORPO DA RESPOSTA.
   *
   * `router.refresh()` NÃO é confiável para reexibir o resultado da própria ação
   * nesta base — a barra lateral dispara prefetch RSC de todos os links e o
   * refresh é descartado no meio da rajada. MEDIDO no trace do run 31888655412
   * (Playwright `trace: retain-on-failure`, o caso (1) de `marca-logo.spec.ts`):
   *
   *   POST /api/v1/marca/logo            14:18:45.983  200  {logo_url: "…/platform/4f9c…png"}
   *   GET  /admin/marca?_rsc=3gU9L6A6…   14:18:46.497  net::ERR_ABORTED  bodySize=-1
   *   …e mais NADA na rede pelos 14s seguintes, até a asserção estourar.
   *
   * O refresh saiu uma vez, morreu no meio, e ninguém tentou de novo: a tela
   * ficou com o render ANTERIOR (a prévia mostrando o nome em texto, a seção "De
   * onde vem cada coisa" dizendo "padrão do sistema") logo depois de o toast
   * dizer "Logo atualizado". Não é lentidão — subir o timeout de 5s para 15s já
   * tinha sido tentado, e o elemento nunca aparece. Para quem usa, é pior que um
   * erro: a confirmação diz que deu certo e a tela diz que não.
   *
   * O comentário que morava aqui defendia o contrário ("a prévia mostra a URL
   * RESOLVIDA pelo servidor, com a precedência entre camadas aplicada"). A
   * premissa era boa e a conclusão não seguia: a precedência entre camadas é
   * `logoDaCamada ?? logoHerdado` — ESTAS DUAS LINHAS, aqui no cliente —, e o
   * que a rota devolve é exatamente o primeiro operando dela (`logo_url` do
   * arquivo recém-gravado no POST, `null` no DELETE). Aplicar o corpo não
   * diverge do render seguinte: reproduz a mesma regra com o mesmo dado.
   *
   * O `router.refresh()` continua sendo disparado — é ele que reconcilia o resto
   * da página (a seção de origens) e o servidor na próxima navegação. O que
   * mudou é que a prévia não DEPENDE mais dele.
   *
   * Reposição pela prop DURANTE o render (não em efeito): é o padrão do React
   * para "a prop mudou, reponha o estado", e mantém o servidor no comando quando
   * é ele que traz novidade — navegação, refresh que chegou, outra aba. Mesmo
   * padrão de `app/app/kanban/_client.tsx:72-80`, pela mesma medição. Lá o
   * discriminador é a identidade do ARRAY de funis; aqui é a do objeto
   * `logoDaCamada`, e o tipo dele existe por essa razão (ver os Props).
   */
  const [logoGravado, setLogoGravado] = useState<string | null>(logoDaCamada.url);
  const [ultimoDoServidor, setUltimoDoServidor] = useState(logoDaCamada);
  if (logoDaCamada !== ultimoDoServidor) {
    setUltimoDoServidor(logoDaCamada);
    setLogoGravado(logoDaCamada.url);
  }

  const emVigor = logoGravado ?? logoHerdado;

  /**
   * O `logo_url` que a rota acabou de gravar para ESTA camada.
   *
   * Três respostas distintas, e a diferença entre as duas últimas é o que faz o
   * DELETE funcionar: `string` = esta camada passou a ter logo próprio; `null` =
   * esta camada ficou SEM logo próprio (e quem aparece é o herdado); `undefined`
   * = a resposta não trouxe o campo, e aí o corpo não manda em nada — a prop do
   * servidor segue no comando. Colapsar `null` e `undefined` num `??` faria o
   * DELETE não apagar a prévia.
   */
  async function logoDaResposta(resposta: Response): Promise<string | null | undefined> {
    const corpo = (await resposta.json().catch(() => null)) as
      | { data?: { logo_url?: string | null } }
      | null;
    return corpo?.data?.logo_url;
  }

  /**
   * A mensagem da rota, quando ela souber nomear a recusa.
   *
   * A rota devolve `{ error: { code, message } }` e a `message` dela já é escrita
   * para o operador — usá-la em vez de um dicionário local é o que faz a razão
   * exata ("SVG não é aceito porque…", "o logo precisa ter até 512 KB") chegar à
   * tela. O dicionário acima só cobre o que a rota responde em código de auth,
   * onde a mensagem certa depende de onde a pessoa está.
   */
  async function razaoDaFalha(resposta: Response): Promise<string> {
    const corpo = (await resposta.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    const codigo = corpo?.error?.code ?? "";
    return t(ERRO_EM_PORTUGUES[codigo] ?? corpo?.error?.message ?? "Não consegui trocar o logo agora.");
  }

  async function enviar(arquivo: File) {
    setEnviando(true);
    try {
      const corpo = new FormData();
      corpo.set("escopo", escopo);
      corpo.set("file", arquivo);
      const resposta = await fetch("/api/v1/marca/logo", { method: "POST", body: corpo });
      if (!resposta.ok) {
        toast.error(await razaoDaFalha(resposta));
        return;
      }
      toast.success(t("Logo atualizado."));
      const gravado = await logoDaResposta(resposta);
      if (gravado !== undefined) setLogoGravado(gravado);
      startTransition(() => router.refresh());
    } finally {
      setEnviando(false);
      // Sem isto, escolher o MESMO arquivo de novo (depois de uma falha) não
      // dispara `change` e a tela parece travada.
      if (entrada.current) entrada.current.value = "";
    }
  }

  async function remover() {
    setEnviando(true);
    try {
      const resposta = await fetch(`/api/v1/marca/logo?escopo=${escopo}`, { method: "DELETE" });
      if (!resposta.ok) {
        toast.error(await razaoDaFalha(resposta));
        return;
      }
      toast.success(t("Logo removido."));
      // A rota devolve `logo_url: null` — "esta camada ficou sem logo próprio" —,
      // e é isso que faz a prévia cair no herdado sem esperar o refresh.
      const gravado = await logoDaResposta(resposta);
      if (gravado !== undefined) setLogoGravado(gravado);
      startTransition(() => router.refresh());
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-4" data-campo-de-logo={escopo} data-hidratado={hidratado ? "" : undefined}>
      <div className="space-y-2">
        <Label htmlFor={`logo-${escopo}`}>{t("Logo")}</Label>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={entrada}
            id={`logo-${escopo}`}
            type="file"
            // `image/png,image/jpeg` FILTRA o seletor de arquivos, não decide
            // nada: quem decide é o farejador de bytes do servidor. O atributo
            // existe para a pessoa não navegar até um arquivo que será recusado.
            accept="image/png,image/jpeg"
            disabled={enviando}
            onChange={(e) => {
              const arquivo = e.target.files?.[0];
              if (arquivo) void enviar(arquivo);
            }}
            className="max-w-xs text-sm file:mr-3 file:cursor-pointer file:rounded-sm file:border file:border-border file:bg-surface-elevated file:px-3 file:py-1.5 file:text-sm"
          />
          {logoGravado ? (
            <Button type="button" variant="outline" onClick={() => void remover()} disabled={enviando}>
              {t("Remover")}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-text-muted">
          {t("PNG ou JPG, até")} {Math.round(TAMANHO_MAXIMO_DO_LOGO / 1024)}{" "}
          {t(
            "KB. Prefira fundo transparente. SVG não é aceito: ele pode executar código quando aberto direto pelo endereço da imagem.",
          )}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-text-muted">
          {/*
            `logoGravado`, e não a prop: com a prop, a tela diria "Sem logo
            próprio" LOGO ACIMA da prévia mostrando o logo que a pessoa acabou de
            subir, até o refresh chegar (ou para sempre, quando ele é abortado).
          */}
          {logoGravado
            ? t("Como o logo aparece nas duas aparências do sistema:")
            : `${t("Sem logo próprio, o sistema usa o logo")} ${t(origemDoHerdado)}. ${t("Assim ele aparece:")}`}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              { rotulo: t("Aparência clara"), fundo: SUPERFICIE_CLARA },
              { rotulo: t("Aparência escura"), fundo: SUPERFICIE_ESCURA },
            ] as const
          ).map(({ rotulo, fundo }) => (
            <div key={rotulo} className="space-y-1">
              <div
                data-previa-do-logo={rotulo === t("Aparência clara") ? "claro" : "escuro"}
                className="flex h-24 items-center justify-center rounded-sm border border-border px-4"
                style={{ backgroundColor: fundo }}
              >
                {emVigor ? (
                  // O chip claro na aparência escura é o MESMO que a barra
                  // lateral e a tela de entrada aplicam de verdade
                  // (`components/shell/Sidebar.tsx`, `app/(public)/layout.tsx`):
                  // esta prévia deixaria de ser prévia se mostrasse o logo cru
                  // onde o app real desenha um chip por baixo. Aqui não dá pra
                  // usar a variante `dark:` do Tailwind — as duas caixas
                  // renderizam lado a lado no MESMO tema real, simulando os
                  // dois via `style` — então a condição é o rótulo da caixa, não
                  // o tema da página.
                  <span
                    className={
                      rotulo === t("Aparência escura")
                        ? "rounded-md bg-white px-2 py-1 shadow-sm"
                        : undefined
                    }
                  >
                    {/* <img> e não next/image pelo mesmo motivo da barra lateral e da
                      tela de acesso: a URL é do projeto de quem hospeda, e
                      `next/image` exige allowlist de domínios fechada em BUILD — a
                      imagem pré-buildada do self-host recusaria o domínio do
                      operador. Altura fixa e largura livre para não distorcer arte
                      de proporção desconhecida. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={emVigor}
                      alt={nomeEmVigor}
                      className="max-h-12 w-auto max-w-full object-contain"
                    />
                  </span>
                ) : (
                  <span
                    className="text-sm font-semibold tracking-tight"
                    // O texto acompanha a SUPERFÍCIE, não o tema em que a pessoa
                    // está: um `text-*` do Tailwind sumiria no quadro oposto. E a
                    // cor sai de `melhorFrenteSobre` — a mesma função que decide
                    // a cor do texto sobre os botões da marca —, nunca de um hex
                    // digitado aqui.
                    style={{ color: melhorFrenteSobre(fundo) }}
                  >
                    {nomeEmVigor}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted">{t(rotulo)}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
