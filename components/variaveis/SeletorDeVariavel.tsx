"use client";

import * as React from "react";
import { ChevronDown, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import { termoSemAcento } from "@/lib/inbox/termo-de-busca";
import {
  DICA_DO_CURINGA,
  GRUPOS_DE_VARIAVEL,
  ROTULO_DO_GRUPO,
  entradasDe,
  raizDoCuringa,
  type GrupoDeVariavel,
  type Resolvedor,
} from "@/lib/variaveis/catalogo";

/**
 * Um item que a tela conhece e o catálogo não enumera: campo criado pela
 * organização no funil (vocabulário aberto — a chave nasce em runtime).
 */
export interface AtalhoDeVariavel {
  /** A chave como ela entra no texto, sem `{{` nem `}}`. */
  chave: string;
  /** O rótulo que o formulário do funil deu ao campo. */
  rotulo: string;
  /** Em que grupo da lista ele aparece (padrão: campo do negócio). */
  grupo?: GrupoDeVariavel;
}

/**
 * O SELETOR ÚNICO DE VARIÁVEL (#3687).
 *
 * Botão "Inserir variável" com busca e grupos, que devolve o token para quem
 * chama inserir na posição do cursor. A LISTA NÃO MORA AQUI: sai do catálogo
 * (`entradasDe(fonte)`) mais os `extras` que a tela conhece (campos do funil).
 *
 * Antes desta fatia cada tela tinha a sua lista — três botões fixos na
 * automação, outra no follow-up, outra na campanha — e a mesma variável existia
 * em uma e faltava na outra sem ninguém saber. Uma tela nova agora importa este
 * componente e escolhe a fonte; não inventa vocabulário.
 */
export function SeletorDeVariavel({
  fonte,
  onInserir,
  extras = [],
  rotulo,
}: {
  fonte: Resolvedor;
  onInserir: (token: string) => void;
  extras?: readonly AtalhoDeVariavel[];
  /** Texto do botão; o padrão é "Inserir variável". */
  rotulo?: string;
}) {
  const t = useT();
  const [aberto, setAberto] = React.useState(false);
  const [busca, setBusca] = React.useState("");
  const idDoSeletor = React.useId();

  const grupos = React.useMemo(() => {
    // O curinga (`lead.*`) NÃO é item de inserir: `{{lead.*}}` não casa com a
    // marcação e iria literal para o cliente. Ele aparece como dica de como
    // escrever o caminho; o caminho concreto que a tela quer oferecer (o
    // `{{lead.title}}` da automação) vem em `extras`.
    const doCatalogo = entradasDe(fonte).map((v) => {
      const raiz = raizDoCuringa(v.nome);
      return {
        chave: v.nome,
        rotulo: t(v.descricao),
        grupo: v.grupo,
        dica: raiz === null ? null : t(DICA_DO_CURINGA[raiz]),
      };
    });
    // O extra sem grupo é campo do negócio (o padrão declarado em
    // `AtalhoDeVariavel`): sem ele, nenhum grupo o casava e os campos do funil
    // sumiam da lista. Extra com a MESMA chave de uma variável do catálogo fica
    // de fora, como a lista antiga da automação fazia: o resolvedor dá ao
    // catálogo a vez, e o item mostraria o rótulo do campo com o valor da
    // variável.
    const chavesDoCatalogo = new Set(doCatalogo.map((v) => v.chave));
    const dosExtras = extras
      .filter((item) => !chavesDoCatalogo.has(item.chave.toLowerCase()))
      .map((item) => ({
        ...item,
        grupo: item.grupo ?? ("campo-do-negocio" as const),
        dica: null,
      }));
    const todos = [...doCatalogo, ...dosExtras];
    // A busca ignora ACENTO (#4481), não só a caixa: `lower('Á')` continua
    // `'á'`, então comparar `.toLowerCase()` com `.toLowerCase()` só casava com
    // acento e grafia idênticos. A chave nasce sem acento (`saudacao`) e o
    // rótulo com ele (« como está no cadastro »); quem digita qualquer uma das
    // duas formas tem de achar o item. A regra é a do repo inteiro
    // (`termoSemAcento`), aplicada aos DOIS lados.
    const termo = termoSemAcento(busca.trim());
    const filtrados = termo
      ? todos.filter(
          (item) =>
            termoSemAcento(item.chave).includes(termo) ||
            termoSemAcento(item.rotulo).includes(termo),
        )
      : todos;
    return GRUPOS_DE_VARIAVEL.map((grupo) => ({
      grupo,
      itens: filtrados.filter((item) => item.grupo === grupo),
    })).filter((g) => g.itens.length > 0);
  }, [fonte, extras, busca, t]);

  const inserir = (chave: string) => {
    onInserir(`{{${chave}}}`);
    setAberto(false);
    setBusca("");
  };

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button type="button" variant="secondary" size="sm">
          {rotulo ?? t("Inserir variável")}
          <ChevronDown className="ml-1 h-3 w-3" aria-hidden />
        </Button>
      </PopoverTrigger>
      {/* A lista abre num diálogo (Radix): sem nome, o leitor de tela anuncia só
          "diálogo". Cada grupo vira `group` com o título que já está na tela. */}
      <PopoverContent align="start" className="w-80 p-2" aria-label={t("Inserir variável")}>
        <div className="relative mb-2">
          <Search className="absolute top-2.5 left-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("Buscar variável")}
            aria-label={t("Buscar variável")}
            className="h-8 pl-7"
          />
        </div>
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {grupos.map(({ grupo, itens }) => (
            <div
              key={grupo}
              role="group"
              aria-labelledby={`${idDoSeletor}-${grupo}`}
              className="space-y-0.5"
            >
              <p
                id={`${idDoSeletor}-${grupo}`}
                className="px-2 pt-1 text-xs font-medium text-muted-foreground"
              >
                {t(ROTULO_DO_GRUPO[grupo])}
              </p>
              {itens.map((item) =>
                item.dica !== null ? (
                  <div key={item.chave} className="px-2 py-1 text-xs text-muted-foreground">
                    <p>{item.dica}</p>
                    <p className="truncate">{item.rotulo}</p>
                  </div>
                ) : (
                  <button
                    key={item.chave}
                    type="button"
                    onClick={() => inserir(item.chave)}
                    className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-elevated"
                  >
                    <span className="font-mono text-xs">{`{{${item.chave}}}`}</span>
                    <span className="truncate text-xs text-muted-foreground">{item.rotulo}</span>
                  </button>
                ),
              )}
            </div>
          ))}
          {grupos.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {t("Nenhuma variável encontrada")}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
