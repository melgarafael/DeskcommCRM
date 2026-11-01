"use client";
/**
 * ComparacaoDeFichas — as duas fichas lado a lado, linha a linha, para quem vai
 * juntar decidir com os dados na frente (spec 31, PR A).
 *
 * Em tela larga é uma grade de três colunas (rótulo + uma por ficha). Em tela
 * estreita a mesma grade vira uma coluna só, e cada valor leva o nome da ficha
 * na frente: nada rola na horizontal.
 *
 * O "Este fica" é o mesmo rádio do `MergeDialog`. Sem `onEscolherPrincipal` a
 * comparação é só leitura (o caso do gerente que não junta): não há controle
 * que não faça nada.
 */
import { format, type Locale } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { normalizarLink, TIPOS_DE_LINK } from "@/lib/leads/links-de-contato";
import { ORIGEM_AGENDA_DO_CELULAR } from "@/lib/leads/origem-do-contato";
import { useCompararFichas, type FichaParaComparar } from "@/hooks/contacts/useCompararFichas";

interface Props {
  ids: [string, string];
  principalId?: string | null;
  onEscolherPrincipal?: (id: string) => void;
}

/** Um valor da linha: texto, e link quando ele tem endereço seguro. */
interface Item {
  texto: string;
  href?: string | null;
}

interface Linha {
  rotulo: string;
  celulas: [Item[], Item[]];
}

/**
 * Os rótulos de `source` que a tela de contatos já conhece (o filtro de origem).
 * Cada ramo chama `t()` com o LITERAL: chave em variável não é achada pelo guarda
 * de espanhol e sairia em português (`i18n-espanhol-cobre-a-tela`).
 */
function rotuloDaOrigem(source: string, t: (texto: string) => string): string {
  switch (source) {
    case "manual":
      return t("Manual");
    case "whatsapp":
      return "WhatsApp";
    case "site":
      return t("Site (landing page)");
    case "nuvemshop":
      return "Nuvemshop";
    case "import_csv":
      return t("Importado (CSV)");
    case ORIGEM_AGENDA_DO_CELULAR:
      return t("Agenda do celular");
    case "meta_ads":
      return t("Anúncio da Meta");
    case "google_ads":
      return t("Anúncio do Google");
    default:
      return source;
  }
}

/** Rótulo do tipo de link, com o literal em cada ramo (mesma razão de `rotuloDaOrigem`). */
function rotuloDoLink(tipo: string, t: (texto: string) => string): string {
  switch (tipo) {
    case "site":
      return t("Site");
    case "google_meu_negocio":
      return t("Google Meu Negócio");
    case "outro":
      return t("Outro");
    default:
      // Instagram, Facebook, LinkedIn, TikTok, YouTube: nome de marca, igual em todo idioma.
      return TIPOS_DE_LINK.find((x) => x.id === tipo)?.rotulo ?? tipo;
  }
}

/** Sem repetir: a prospecção guarda o mesmo e-mail/telefone mais de uma vez. */
function unicos(valores: (string | null | undefined)[]): string[] {
  const vistos = new Set<string>();
  for (const v of valores) {
    const limpo = (v ?? "").trim();
    if (limpo) vistos.add(limpo);
  }
  return [...vistos];
}

function comLink(valores: string[]): Item[] {
  return valores.map((texto) => ({ texto, href: normalizarLink(texto) }));
}

function linhasDaComparacao(
  [a, b]: [FichaParaComparar, FichaParaComparar],
  t: (texto: string) => string,
  localeDaData: Locale,
): Linha[] {
  const porFicha = (f: FichaParaComparar): Record<string, Item[]> => {
    const telefone = unicos([
      f.phone_number ? phoneForDisplay(f.phone_number) : null,
      ...f.prospeccao.telefones,
    ]);
    const email = unicos([f.email, ...f.prospeccao.emails]);
    const maps = unicos([f.maps_url, ...f.prospeccao.maps]);
    return {
      agenda: f.address_book_name ? [{ texto: f.address_book_name }] : [],
      telefone: telefone.map((texto) => ({ texto })),
      email: email.map((texto) => ({ texto })),
      categoria: unicos(f.prospeccao.categorias).map((texto) => ({ texto })),
      endereco: unicos(f.prospeccao.enderecos).map((texto) => ({ texto })),
      site: comLink(unicos(f.prospeccao.sites)),
      redes: comLink(unicos(f.prospeccao.redes)),
      maps: maps.map((texto) => ({ texto, href: normalizarLink(texto) })),
      origem: f.source ? [{ texto: rotuloDaOrigem(f.source, t) }] : [],
      criada: [{ texto: format(new Date(f.created_at), "dd/MM/yyyy", { locale: localeDaData }) }],
      conversas: [{ texto: String(f.conversas) }],
      negocios: [{ texto: String(f.negocios) }],
      links: f.links.map((l) => {
        return { texto: `${rotuloDoLink(l.tipo, t)}: ${l.href}`, href: l.href };
      }),
    };
  };

  const da = porFicha(a);
  const db = porFicha(b);
  const definicoes: { chave: string; rotulo: string; sempreMostra: boolean }[] = [
    { chave: "nome", rotulo: t("Nome"), sempreMostra: true },
    { chave: "agenda", rotulo: t("Nome na agenda do celular"), sempreMostra: false },
    { chave: "telefone", rotulo: t("Telefone"), sempreMostra: true },
    { chave: "email", rotulo: t("E-mail"), sempreMostra: true },
    { chave: "categoria", rotulo: t("Categoria"), sempreMostra: true },
    { chave: "endereco", rotulo: t("Endereço"), sempreMostra: true },
    { chave: "site", rotulo: t("Site"), sempreMostra: true },
    { chave: "redes", rotulo: t("Redes sociais"), sempreMostra: true },
    { chave: "maps", rotulo: t("Link do Maps"), sempreMostra: true },
    { chave: "origem", rotulo: t("Origem da ficha"), sempreMostra: true },
    { chave: "criada", rotulo: t("Criada em"), sempreMostra: true },
    { chave: "conversas", rotulo: t("Conversas"), sempreMostra: true },
    { chave: "negocios", rotulo: t("Negócios"), sempreMostra: true },
    { chave: "links", rotulo: t("Links da ficha"), sempreMostra: true },
  ];

  const linhas: Linha[] = [];
  for (const d of definicoes) {
    const celulaA = d.chave === "nome" ? [{ texto: rotuloDoContato(a, t) }] : da[d.chave]!;
    const celulaB = d.chave === "nome" ? [{ texto: rotuloDoContato(b, t) }] : db[d.chave]!;
    // A linha da agenda só aparece quando alguma das fichas tem o nome salvo.
    if (!d.sempreMostra && celulaA.length === 0 && celulaB.length === 0) continue;
    linhas.push({ rotulo: d.rotulo, celulas: [celulaA, celulaB] });
  }
  return linhas;
}

/** Igual nas duas: os dois têm valor e o texto é o mesmo, item a item. */
function ehIgual(celulaA: Item[], celulaB: Item[]): boolean {
  if (celulaA.length === 0 || celulaB.length === 0) return false;
  const textoA = celulaA.map((i) => i.texto).join("\n");
  const textoB = celulaB.map((i) => i.texto).join("\n");
  return textoA === textoB;
}

function Valores({ itens }: { itens: Item[] }) {
  if (itens.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {itens.map((item, i) => (
        <span key={`${item.texto}-${i}`} className="block break-words">
          {item.href ? (
            <a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              {item.texto}
            </a>
          ) : (
            item.texto
          )}
        </span>
      ))}
    </>
  );
}

export function ComparacaoDeFichas({ ids, principalId, onEscolherPrincipal }: Props) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const q = useCompararFichas(ids);

  if (q.isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-error-fg">
        <span>{t("Não foi possível carregar as fichas.")}</span>
        <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  const fichas = q.data.data.contatos;
  if (fichas.length !== 2) return null;
  const [fa, fb] = fichas as [FichaParaComparar, FichaParaComparar];
  const nomes: [string, string] = [rotuloDoContato(fa, t), rotuloDoContato(fb, t)];
  const linhas = linhasDaComparacao([fa, fb], t, localeDaData);
  const escolhivel = Boolean(onEscolherPrincipal);
  const grupoDoRadio = `principal-comparacao-${fa.id}-${fb.id}`;

  return (
    <div
      className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,1fr)]"
      data-testid="comparacao-de-fichas"
    >
      <div className="hidden sm:block" />
      {[fa, fb].map((f, i) => {
        const escolhida = principalId === f.id;
        return (
          <div key={f.id} className="min-w-0 border-b border-border pb-2">
            {escolhivel ? (
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name={grupoDoRadio}
                  className="mt-1"
                  checked={escolhida}
                  onChange={() => onEscolherPrincipal?.(f.id)}
                  aria-label={t("Manter este cadastro")}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{nomes[i]}</span>
                  <span className="block text-xs font-medium text-primary">
                    {escolhida ? t("Este fica") : ""}
                  </span>
                </span>
              </label>
            ) : (
              <span className="block truncate font-medium">{nomes[i]}</span>
            )}
          </div>
        );
      })}

      {linhas.map((linha) => {
        const igual = ehIgual(linha.celulas[0], linha.celulas[1]);
        return (
          <div key={linha.rotulo} className="contents">
            <div className="pt-2 text-xs uppercase text-muted-foreground">
              {linha.rotulo}
              {igual ? <span className="block normal-case">{t("igual nas duas")}</span> : null}
            </div>
            {linha.celulas.map((celula, i) => (
              <div
                key={i}
                className={`min-w-0 rounded-md px-2 py-1.5 text-sm ${igual ? "bg-muted/60" : ""}`}
              >
                {/* Em tela estreita o valor perde a coluna: o nome da ficha volta na frente. */}
                <span className="mb-0.5 block truncate text-xs text-muted-foreground sm:hidden">
                  {nomes[i]}
                </span>
                <Valores itens={celula} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
