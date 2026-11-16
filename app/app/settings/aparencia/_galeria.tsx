"use client";

/**
 * A galeria de templates e a personalização da tela Aparência.
 *
 * ── A prévia ao vivo é só de quem está olhando ─────────────────────────────
 *
 * Visualizar (e qualquer ajuste) troca os atributos do marcador `[data-marca-org]`
 * NESTE navegador — o mesmo marcador que o layout de `/app` escreve a partir do
 * banco —, então o sistema inteiro em volta (menu, topo, fundo, cartões) já
 * aparece como ficaria. Nada é gravado até "Salvar"; sair da tela devolve o
 * marcador ao que está salvo. O CSS dos dez templates está na página
 * (`page.tsx`), escopado pelo id, e só pinta o id que o marcador carregar.
 *
 * ── O modo claro/escuro é de cada pessoa ───────────────────────────────────
 *
 * Ele continua sendo a preferência que já existia (`lib/theme.tsx`, guardada no
 * navegador). O template é da empresa; o modo, de quem usa.
 */

import { useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  definirAparenciaDaOrganizacao,
  type ErroDaAparencia,
} from "@/app/actions/settings/definirAparenciaDaOrganizacao";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import {
  AJUSTES_PADRAO,
  atributosDaAparencia,
  type Aparencia,
  type Densidade,
  type Efeitos,
  type Raio,
} from "@/lib/aparencia/ajustes";
import { TEMPLATES, templatePorId, type Template } from "@/lib/aparencia/catalogo";
import { CHAVES_DE_FONTE, FONTES, type ChaveDeFonte } from "@/lib/aparencia/fontes";
import { ehHexValido, normalizarHex } from "@/lib/branding/rampa";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const ATRIBUTOS = [
  "data-aparencia",
  "data-aparencia-fonte",
  "data-aparencia-raio",
  "data-aparencia-densidade",
  "data-aparencia-efeitos",
] as const;

/** Aplica uma aparência ao marcador de `/app`, só neste navegador. */
function pintarMarcador(a: Aparencia) {
  const marcador = document.querySelector<HTMLElement>("[data-marca-org]");
  if (!marcador) return;
  const attrs = atributosDaAparencia(a);
  for (const nome of ATRIBUTOS) {
    const valor = attrs[nome];
    if (valor) marcador.setAttribute(nome, valor);
    else marcador.removeAttribute(nome);
  }
  // A segunda cor é lida pelos tokens do template, que são declarados no
  // `<body>` — por isso a prévia dela vai no `<body>`, e não no marcador.
  if (a.cor_secundaria) document.body.style.setProperty("--aparencia-secundaria", a.cor_secundaria);
  else document.body.style.removeProperty("--aparencia-secundaria");
}

function iguais(a: Aparencia, b: Aparencia): boolean {
  return (Object.keys(AJUSTES_PADRAO) as (keyof Aparencia)[]).every((k) => a[k] === b[k]);
}

const MENSAGEM_DO_ERRO: Record<ErroDaAparencia, string> = {
  invalido: "Algum valor não está no formato esperado. Recarregue a página e tente de novo.",
  sessao: "Sua sessão expirou. Entre de novo para salvar.",
  somente_leitura: "No modo suporte a aparência não pode ser alterada.",
  sem_empresa: "Escolha uma empresa antes de salvar.",
  sem_permissao: "Só quem administra a empresa pode trocar a aparência.",
  mfa: "Confirme a verificação em duas etapas para salvar esta mudança.",
  falha: "Não consegui salvar a aparência agora. Tente de novo em instantes.",
};

const RAIOS: { valor: Raio | null; rotulo: string }[] = [
  { valor: null, rotulo: "Do template" },
  { valor: "compacto", rotulo: "Compacto" },
  { valor: "medio", rotulo: "Médio" },
  { valor: "arredondado", rotulo: "Arredondado" },
];
const DENSIDADES: { valor: Densidade; rotulo: string }[] = [
  { valor: "confortavel", rotulo: "Confortável" },
  { valor: "compacta", rotulo: "Compacta" },
];
const EFEITOS: { valor: Efeitos; rotulo: string }[] = [
  { valor: "completo", rotulo: "Completo" },
  { valor: "sutil", rotulo: "Sutil" },
  { valor: "desligado", rotulo: "Desligado" },
];
const MODOS: { valor: Theme; rotulo: string }[] = [
  { valor: "light", rotulo: "Claro" },
  { valor: "dark", rotulo: "Escuro" },
  { valor: "system", rotulo: "Automático" },
];

export function GaleriaDeAparencia({
  gravada,
  corDaMarca,
}: {
  gravada: Aparencia;
  /** A cor que a empresa definiu na Marca, ou `null` (usa a do template). */
  corDaMarca: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [salva, setSalva] = useState<Aparencia>(gravada);
  const [rascunho, setRascunho] = useState<Aparencia>(gravada);
  const [salvando, startTransition] = useTransition();
  const topo = useRef<HTMLDivElement>(null);
  const emPrevia = !iguais(rascunho, salva);

  // A prévia acompanha o rascunho; sair da tela devolve o que está salvo.
  useEffect(() => {
    pintarMarcador(rascunho);
  }, [rascunho]);
  const salvaRef = useRef(salva);
  useEffect(() => {
    salvaRef.current = salva;
  }, [salva]);
  useEffect(() => () => pintarMarcador(salvaRef.current), []);

  const templateDoRascunho = useMemo(() => templatePorId(rascunho.template), [rascunho.template]);

  function ajustar(parcial: Partial<Aparencia>) {
    setRascunho((r) => ({ ...r, ...parcial }));
  }

  function visualizar(id: string | null) {
    ajustar({ template: id });
    topo.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function salvar(proxima: Aparencia) {
    startTransition(async () => {
      const r = await definirAparenciaDaOrganizacao(proxima);
      if (!r.ok) {
        toast.error(t(MENSAGEM_DO_ERRO[r.erro]));
        return;
      }
      setSalva(proxima);
      setRascunho(proxima);
      toast.success(t("Aparência salva para toda a equipe."));
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <div ref={topo} className="scroll-mt-20" />
      {emPrevia ? (
        <div
          role="status"
          // `fixed`, e não `sticky`: quem rola é o documento, e o `<main>` da casca
          // (`overflow-auto`, sem altura própria) prenderia o sticky no lugar.
          // Logo abaixo da barra do topo (h-14) e das faixas, em qualquer largura.
          className="fixed top-[calc(var(--faixas-de-cima,0px)+4rem)] left-1/2 z-40 flex w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-accent bg-surface p-3 shadow-lg"
        >
          <p className="min-w-0 flex-1 text-sm">
            <strong className="font-semibold">{t("Prévia")}</strong>{" "}
            {templateDoRascunho
              ? `${t("do template")} ${t(templateDoRascunho.nome)}. `
              : `${t("da aparência padrão do sistema")}. `}
            <span className="text-muted-foreground">
              {t("Só você está vendo. Nada foi salvo ainda.")}
            </span>
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setRascunho(salva)} disabled={salvando}>
              {t("Descartar")}
            </Button>
            <Button size="sm" onClick={() => salvar(rascunho)} disabled={salvando}>
              {salvando ? t("Salvando…") : t("Salvar para a equipe")}
            </Button>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="titulo-templates" className="flex flex-col gap-4">
        <div>
          <h2 id="titulo-templates" className="text-lg font-semibold">
            {t("Templates")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("Cada template muda o fundo, o menu, a tipografia, as cores, os cantos e as sombras, no modo claro e no escuro.")}
          </p>
        </div>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          <CartaoDoTemplate
            template={null}
            emUso={salva.template === null}
            emPrevia={emPrevia && rascunho.template === null}
            ocupado={salvando}
            onVisualizar={() => visualizar(null)}
            onAplicar={() => salvar({ ...rascunho, template: null })}
          />
          {TEMPLATES.map((tpl) => (
            <CartaoDoTemplate
              key={tpl.id}
              template={tpl}
              emUso={salva.template === tpl.id}
              emPrevia={emPrevia && rascunho.template === tpl.id}
              ocupado={salvando}
              onVisualizar={() => visualizar(tpl.id)}
              onAplicar={() => salvar({ ...rascunho, template: tpl.id })}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="titulo-personalizar" className="flex flex-col gap-4">
        <div>
          <h2 id="titulo-personalizar" className="text-lg font-semibold">
            {t("Personalizar")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("Os ajustes passam por cima do template e continuam valendo se você trocar de template.")}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 rounded-lg border bg-card p-5 lg:grid-cols-2">
          <Campo rotulo={t("Modo")} ajuda={t("Claro, escuro ou automático é escolha de cada pessoa, neste navegador.")}>
            <Segmentos
              rotulo={t("Modo")}
              opcoes={MODOS.map((m) => ({ valor: m.valor, rotulo: t(m.rotulo) }))}
              valor={theme}
              onChange={setTheme}
            />
          </Campo>

          <Campo
            rotulo={t("Cor principal e logotipo")}
            ajuda={
              corDaMarca
                ? t("Vêm da tela Marca e valem em qualquer template.")
                : t("Sem cor definida na Marca, vale a cor do template.")
            }
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="size-9 shrink-0 rounded-md border"
                style={{ background: corDaMarca ?? "var(--color-accent)" }}
              />
              <Button asChild variant="outline" size="sm">
                <Link href="/app/settings/marca">{t("Alterar na Marca")}</Link>
              </Button>
            </div>
          </Campo>

          <Campo rotulo={t("Cor secundária")} ajuda={t("Aparece no fundo e nos detalhes do menu, nunca em texto.")}>
            <div className="flex items-center gap-3">
              <input
                id="aparencia-cor-secundaria"
                type="color"
                aria-label={t("Cor secundária")}
                className="h-9 w-12 cursor-pointer rounded-md border bg-surface p-1"
                value={rascunho.cor_secundaria ?? "#888888"}
                onChange={(e) => {
                  const hex = e.target.value;
                  if (ehHexValido(hex)) ajustar({ cor_secundaria: normalizarHex(hex) });
                }}
              />
              {rascunho.cor_secundaria ? (
                <Button variant="ghost" size="sm" onClick={() => ajustar({ cor_secundaria: null })}>
                  {t("Usar a do template")}
                </Button>
              ) : (
                <span className="text-sm text-muted-foreground">{t("A do template")}</span>
              )}
            </div>
          </Campo>

          <Campo rotulo={t("Fonte")} ajuda={t("Vale para textos e títulos. Todas são livres e já vêm com o sistema.")}>
            <select
              id="aparencia-fonte"
              aria-label={t("Fonte")}
              className="h-11 w-full max-w-xs rounded-md border bg-surface px-3 text-sm lg:h-9"
              value={rascunho.fonte ?? ""}
              onChange={(e) => ajustar({ fonte: (e.target.value || null) as ChaveDeFonte | null })}
            >
              <option value="">{t("A do template")}</option>
              {CHAVES_DE_FONTE.map((chave) => (
                <option key={chave} value={chave}>
                  {FONTES[chave].nome}
                </option>
              ))}
            </select>
          </Campo>

          <Campo rotulo={t("Arredondamento")}>
            <Segmentos
              rotulo={t("Arredondamento")}
              opcoes={RAIOS.map((r) => ({ valor: r.valor, rotulo: t(r.rotulo) }))}
              valor={rascunho.raio}
              onChange={(raio) => ajustar({ raio })}
            />
          </Campo>

          <Campo rotulo={t("Densidade")} ajuda={t("Compacta mostra mais informação por tela.")}>
            <Segmentos
              rotulo={t("Densidade")}
              opcoes={DENSIDADES.map((d) => ({ valor: d.valor, rotulo: t(d.rotulo) }))}
              valor={rascunho.densidade}
              onChange={(densidade) => ajustar({ densidade })}
            />
          </Campo>

          <Campo
            rotulo={t("Intensidade dos efeitos")}
            ajuda={t("Sutil suaviza o fundo e o brilho. Desligado usa cores sólidas, bom para computadores mais simples.")}
          >
            <Segmentos
              rotulo={t("Intensidade dos efeitos")}
              opcoes={EFEITOS.map((e) => ({ valor: e.valor, rotulo: t(e.rotulo) }))}
              valor={rascunho.efeitos}
              onChange={(efeitos) => ajustar({ efeitos })}
            />
          </Campo>

          <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
            <Button onClick={() => salvar(rascunho)} disabled={!emPrevia || salvando}>
              {salvando ? t("Salvando…") : t("Salvar para a equipe")}
            </Button>
            <Button
              variant="outline"
              onClick={() => ajustar({ ...AJUSTES_PADRAO, template: rascunho.template })}
              disabled={salvando}
            >
              {t("Voltar ao padrão do template")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function Campo({ rotulo, ajuda, children }: { rotulo: string; ajuda?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{rotulo}</span>
      {children}
      {ajuda ? <span className="text-xs text-muted-foreground">{ajuda}</span> : null}
    </div>
  );
}

function Segmentos<V extends string | null>({
  rotulo,
  opcoes,
  valor,
  onChange,
}: {
  rotulo: string;
  opcoes: { valor: V; rotulo: string }[];
  valor: V;
  onChange: (v: V) => void;
}) {
  return (
    <div role="group" aria-label={rotulo} className="flex w-fit flex-wrap gap-1 rounded-lg border bg-surface-elevated p-1">
      {opcoes.map((o) => (
        <button
          key={o.valor ?? "padrao"}
          type="button"
          aria-pressed={o.valor === valor}
          onClick={() => onChange(o.valor)}
          className={cn(
            "min-h-9 rounded-md px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            o.valor === valor ? "bg-surface font-medium text-text shadow-xs" : "text-muted-foreground hover:text-text",
          )}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}

function CartaoDoTemplate({
  template,
  emUso,
  emPrevia,
  ocupado,
  onVisualizar,
  onAplicar,
}: {
  template: Template | null;
  emUso: boolean;
  emPrevia: boolean;
  ocupado: boolean;
  onVisualizar: () => void;
  onAplicar: () => void;
}) {
  const t = useT();
  const nome = template ? t(template.nome) : t("Padrão do sistema");
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-xs",
        emUso && "border-accent ring-1 ring-accent",
      )}
    >
      <div className="grid grid-cols-2 gap-2">
        <Miniatura template={template} modo="claro" />
        <Miniatura template={template} modo="escuro" />
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">{nome}</h3>
          {emUso ? (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
              {t("Em uso")}
            </span>
          ) : null}
          {emPrevia ? (
            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{t("Em prévia")}</span>
          ) : null}
        </div>
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {template ? t(template.categoria) : t("Original")}
        </p>
        <p className="text-sm text-muted-foreground">
          {template
            ? t(template.descricao)
            : t("O visual de fábrica do sistema, sem template. Os ajustes de personalização continuam valendo.")}
        </p>
        {template ? (
          <p className="text-xs text-muted-foreground">
            {FONTES[template.fonteTitulo].nome}
            {template.fonteTitulo !== template.fonteTexto ? ` + ${FONTES[template.fonteTexto].nome}` : ""}
          </p>
        ) : null}
      </div>
      <div className="mt-auto flex gap-2">
        <Button variant="outline" size="sm" onClick={onVisualizar} disabled={ocupado} aria-label={`${t("Visualizar")} ${nome}`}>
          {t("Visualizar")}
        </Button>
        <Button size="sm" onClick={onAplicar} disabled={ocupado || emUso} aria-label={`${t("Aplicar")} ${nome}`}>
          {emUso ? t("Aplicado") : t("Aplicar")}
        </Button>
      </div>
    </li>
  );
}

/**
 * A miniatura REAL: pintada pelos mesmos tokens que o template declara para o
 * sistema (escopo `data-aparencia-amostra`, emitido por `page.tsx`). O modo vem
 * do atributo, não do `<html>`, para claro e escuro aparecerem lado a lado.
 *
 * A do "Padrão do sistema" anula os tokens de template herdados da página
 * (`initial` faz o `var()` cair no fallback) e usa o tema de fábrica pelo
 * `data-theme` da subárvore (`app/globals.css`).
 */
const SEM_TEMPLATE: CSSProperties = Object.fromEntries(
  [
    "--aparencia-casca",
    "--aparencia-menu-fundo",
    "--aparencia-menu-borda",
    "--aparencia-menu-ativo-fundo",
    "--aparencia-menu-ativo-texto",
    "--aparencia-menu-texto-suave",
    "--aparencia-menu-raio",
    "--aparencia-menu-recuo-y",
    "--aparencia-menu-recuo-x",
    "--aparencia-menu-desfoque",
    "--aparencia-conteudo",
    "--aparencia-conteudo-respiro",
    "--aparencia-conteudo-raio",
    "--aparencia-fonte-texto",
    "--aparencia-fonte-titulo",
    "--aparencia-titulo-peso",
  ].map((k) => [k, "initial"]),
) as CSSProperties;

function Miniatura({ template, modo }: { template: Template | null; modo: "claro" | "escuro" }) {
  const t = useT();
  const atributos = template
    ? { "data-aparencia-amostra": template.id, "data-aparencia-modo": modo }
    : { "data-theme": modo === "claro" ? "light" : "dark", style: SEM_TEMPLATE };
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      <div
        {...atributos}
        aria-hidden
        className="flex h-32 overflow-hidden rounded-md border text-[8px] leading-tight"
        style={{
          ...(template ? {} : SEM_TEMPLATE),
          background: "var(--aparencia-casca, var(--color-bg))",
          color: "var(--color-text)",
          fontFamily: "var(--aparencia-fonte-texto, inherit)",
        }}
      >
        <div
          className="flex w-[32%] shrink-0 flex-col gap-1 p-1.5"
          style={{
            margin: "var(--aparencia-menu-recuo-y, 0px) 0 var(--aparencia-menu-recuo-y, 0px) var(--aparencia-menu-recuo-x, 0px)",
            background: "var(--aparencia-menu-fundo, var(--color-surface))",
            borderRight: "1px solid var(--aparencia-menu-borda, var(--color-border))",
            borderRadius: "var(--aparencia-menu-raio, 0px)",
            backdropFilter: "blur(var(--aparencia-menu-desfoque, 0px))",
          }}
        >
          <span className="mb-1 block size-2.5 rounded-sm" style={{ background: "var(--color-accent)" }} />
          <span
            className="block h-2.5 rounded-sm"
            style={{
              background: "var(--aparencia-menu-ativo-fundo, var(--color-accent))",
              boxShadow: "var(--aparencia-menu-brilho, none)",
            }}
          />
          {[70, 55, 80, 60].map((w) => (
            <span
              key={w}
              className="block h-1 rounded-full opacity-70"
              style={{ width: `${w}%`, background: "var(--aparencia-menu-texto-suave, var(--color-text-muted))" }}
            />
          ))}
        </div>
        <div
          className="flex min-w-0 flex-1 flex-col gap-1.5 p-2"
          style={{
            marginLeft: "var(--aparencia-conteudo-respiro, 0px)",
            background: "var(--aparencia-conteudo, transparent)",
            borderRadius: "var(--aparencia-conteudo-raio, 0px) 0 0 var(--aparencia-conteudo-raio, 0px)",
          }}
        >
          <span
            className="block truncate text-[10px]"
            style={{
              fontFamily: "var(--aparencia-fonte-titulo, inherit)",
              fontWeight: "var(--aparencia-titulo-peso, 600)" as CSSProperties["fontWeight"],
            }}
          >
            {t("Funil de vendas")}
          </span>
          <div className="grid grid-cols-2 gap-1">
            {["R$ 9.800", "R$ 3.720"].map((v) => (
              <div
                key={v}
                className="flex flex-col gap-0.5 p-1"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  boxShadow: "var(--shadow-sm)",
                }}
              >
                <span className="block h-1 w-3/4 rounded-full" style={{ background: "var(--color-text-muted)" }} />
                <span className="tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          <span
            className="mt-auto w-fit px-1.5 py-0.5"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-fg)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {t("Novo negócio")}
          </span>
        </div>
      </div>
      <figcaption className="text-xs text-muted-foreground">{modo === "claro" ? t("Claro") : t("Escuro")}</figcaption>
    </figure>
  );
}
