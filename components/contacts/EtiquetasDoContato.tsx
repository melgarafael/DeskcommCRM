"use client";
/**
 * AS ETIQUETAS DA FICHA DO CONTATO — seletor com autocompletar (issue #2732) e
 * com a cor do vocabulário da organização (issue #3235).
 *
 * ─── Por que o campo virou seletor ──────────────────────────────────────────
 *
 * Era um `<Input>` de texto livre separado por vírgula. Cada pessoa redigitava
 * a etiqueta à sua maneira e a organização acumulava variantes que quebram
 * filtro, segmento de campanha e condição de automação. Aqui o autocompletar
 * oferece o que JÁ existe — o vocabulário da organização mais as
 * `canonical_tags` do funil — e o clique grava a grafia existente.
 *
 * ─── Por que o componente é burro, e recebe o vocabulário por prop ──────────
 *
 * A leitura do vocabulário é um hook com react-query (`useContactTagVocabulary`
 * sobre `GET /api/v1/contact-tags`), e as `canonical_tags` saem do funil padrão
 * que a tela já carrega. Trazer os dois para cá acoplaria o componente a duas
 * consultas e o deixaria impossível de testar sem rede — então ele recebe as
 * duas listas prontas, como `ChipDeEtiqueta` recebe a cor.
 *
 * ─── Criar etiqueta nova ────────────────────────────────────────────────────
 *
 * Este componente não decide QUEM cria etiqueta nova: um texto que não casa com
 * nenhuma etiqueta conhecida vira uma etiqueta nova para quem estiver editando a
 * ficha — o mesmo comportamento de antes do #2732. A trava de papel (valendo nos
 * DOIS editores de `contacts.tags` e configurável) é o PR seguinte; mantê-la só
 * aqui deixaria o campo com duas regras e deixaria a variante entrar pelo
 * `ContactTagsEditor` do inbox.
 *
 * ─── A COR: lida do contexto, ESCRITA por prop (issue #3235) ────────────────
 *
 * A ficha era o único editor de `contacts.tags` que ficou fora da cor que a
 * #2718 trouxe ao Inbox: as sugestões saíam todas no mesmo cinza tracejado, a
 * etiqueta nova nascia sem tom e a que já estava no contato não tinha por onde
 * ser repintada. Mandar quem opera sair da ficha, achar a etiqueta em
 * Configurações → Tags e voltar é o caminho que faz a etiqueta nascer sem cor —
 * e cor que não se vê de relance na tela onde o contato é classificado não serve
 * para nada.
 *
 * A LEITURA vem do MESMO lugar que já pinta o `ChipDeEtiqueta`
 * (`useCoresDasEtiquetas`): é um contexto que degrada para o mapa vazio, não uma
 * consulta — fora do provider o chip sai cinza, que é o estado de quem nunca
 * escolheu cor. Nada aqui pergunta por etiqueta nem toca em rede.
 *
 * E a SUGESTÃO é o próprio `ChipDeEtiqueta`, com papel de botão e Enter/Espaço:
 * o produto tem um caminho único de pintura — a régua mora em
 * `lib/tags/cor-da-etiqueta` e só o chip a importa —, então pintar um botão por
 * fora seria a segunda cópia da regra que a cerca existe para impedir. O
 * tracejado segue dizendo "esta ainda não está no contato".
 *
 * A ESCRITA chega por `onDefinirCor`, e AUSENTE é o padrão: quem monta a ficha
 * só a passa quando a rota não vai recusar (`POST /api/v1/tags/vocabulario` exige
 * `manager` + MFA) — a mesma régua do `SeletorDeCorDaEtiqueta` e do
 * `DialogoDeNovaEtiqueta`, "a tela não oferece o que a escrita recusa". Sem a
 * prop, o campo é byte a byte o de antes: sugere, cria direto e não mostra
 * gatilho de cor. Com ela, a paleta abre ANTES de a etiqueta entrar na lista,
 * como no editor do Inbox (#2789), e cada chip do contato ganha o gatilho de
 * repintar (#2771).
 *
 * ─── A BUSCA: o MESMO vocabulário do Inbox (issue #3144) ────────────────────
 *
 * Faltava a outra metade da paridade: `GET /api/v1/contact-tags` SEM texto lê os
 * 1000 contatos atualizados mais recentemente e corta em 200 etiquetas
 * (`app/api/v1/contact-tags/route.ts`), então a etiqueta de Configurações → Tags
 * que nenhum contato usa ainda — ou a que só aparece em `crm_leads`/conversas, ou
 * a que só existe como `add_tag` de uma regra — nunca virava sugestão na ficha.
 * Quem digitava "diam" via "Criar etiqueta «diam»" e digitava o nome inteiro, ou
 * uma variante dele: exatamente o erro de digitação que a seleção de etiquetas
 * existentes veio evitar. O Inbox já perguntava com o texto digitado desde a
 * #2855 (`?busca=` → `fn_vocabulario_de_tags_pagina`), e é isso que a ficha passa
 * a fazer — pelo MESMO hook, pela MESMA rota: `onDigitar` sobe o texto, quem
 * monta consulta, e o que o servidor achou volta em `encontradas`.
 *
 * Este campo continua sem rede: o componente segue testável sem provider e sem
 * dublê (o mapa de cores degrada para vazio, e `encontradas` ausente é a lista de
 * antes). A falha da leitura, essa sim, passou a ser VISÍVEL (`erroNoVocabulario`):
 * silêncio ali lia como "não há etiquetas", que é o que empurra a pessoa a digitar
 * a variante. É a mesma frase que o Inbox mostra.
 *
 * ─── O texto digitado não pode sumir ao SALVAR ──────────────────────────────
 *
 * O texto em digitação mora num `useState` DESTE campo (`draft`): enquanto não
 * vira chip, ele não está no `value` que quem monta a ficha lê ao salvar. Quem
 * digitava "cliente diamante" (ou "cliente ouro", que já existia e já aparecia
 * como sugestão), clicava em Salvar SEM apertar Enter e via o diálogo fechar
 * com "Contato atualizado" — e a API gravava `tags: []`. O texto sumia em
 * silêncio, porque só o Enter, o clique na sugestão e o clique em "Criar"
 * chamavam `onChange`.
 *
 * A porta se fecha por `onPendente`, sincronizado no `onChange` do input: o
 * campo avisa quem o monta o que o texto digitado VIRARIA se o Enter fosse
 * apertado agora — a etiqueta existente, pela mesma grafia, ou a nova —, e
 * `null` quando não há o que gravar (vazio, já no contato, no teto ou
 * desabilitado). O `Salvar` do diálogo então inclui essa etiqueta no payload em
 * vez de descartá-la.
 *
 * A paleta não mexe nesse contrato: ela é aberta ANTES do `onChange`, e o
 * rascunho só é limpo quando a etiqueta entra na lista (`adicionar`). Fechar a
 * paleta sem confirmar deixa o texto onde estava — e o `Salvar` o leva sem cor,
 * exatamente como levava antes.
 */
import { Fragment, useMemo, useState } from "react";

import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { DialogoDeNovaEtiqueta } from "@/components/tags/DialogoDeNovaEtiqueta";
import { SeletorDeCorDaEtiqueta } from "@/components/tags/SeletorDeCorDaEtiqueta";
import { useCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";
import {
  chaveDeComparacaoDeEtiqueta,
  etiquetaExistentePara,
  etiquetaParaGravar,
  etiquetasConhecidas,
  sugestoesDeEtiqueta,
} from "@/lib/contacts/etiquetas";
import { chaveDaEtiqueta } from "@/lib/tags/cor-da-etiqueta";
import { cn } from "@/lib/utils";
import { Plus, X } from "@/lib/ui/icons";

interface Props {
  /** As etiquetas do contato, na grafia gravada. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Etiquetas já usadas na organização (`useContactTagVocabulary`). */
  vocabulario?: readonly string[] | null;
  /** `pipelines.settings.canonical_tags` do funil padrão. */
  canonicalTags?: readonly string[] | null;
  disabled?: boolean;
  /** `id` do `<input>`, para o `<Label htmlFor>` de quem monta a ficha. */
  inputId?: string;
  /**
   * A etiqueta que o texto AINDA digitado viraria se o Enter fosse apertado
   * agora, ou `null` quando não há o que gravar. Quem monta o diálogo guarda
   * este valor para o `Salvar` não descartar o texto em silêncio.
   */
  onPendente?: (tag: string | null) => void;
  /**
   * Grava a cor da etiqueta no vocabulário da organização. AUSENTE = quem monta
   * não pode escrever no vocabulário (a rota exige `manager` + MFA), e aí o
   * campo é o de sempre: sem paleta na sugestão, sem paleta ao criar e sem
   * gatilho nos chips.
   */
  onDefinirCor?: (tag: string, cor: string | null) => void;
  /**
   * Etiquetas que o SERVIDOR achou para o texto digitado — a leitura COM busca
   * (`GET /api/v1/contact-tags?busca=`), a mesma que o editor do Inbox faz desde
   * a #2855. Ela enxerga o vocabulário curado inteiro, e é o que a leitura sem
   * texto não vê (issue #3144): a etiqueta de Configurações → Tags que nenhum
   * contato usa ainda, a que só aparece em `crm_leads`/`conversations`, a que só
   * existe como `add_tag` de uma regra e a que passou do teto de 200 da lista
   * em uso.
   *
   * Entra DEPOIS do `vocabulario`, como no Inbox: a ordem por uso continua
   * mandando nas que já estavam na lista.
   */
  encontradas?: readonly string[] | null;
  /**
   * O texto digitado, avisado a quem monta — é ele quem pergunta ao servidor
   * (este campo não faz rede, pelo motivo no cabeçalho). Sem esta prop o campo é
   * o de antes: sugere só o `vocabulario` que recebeu.
   */
  onDigitar?: (texto: string) => void;
  /**
   * A leitura do vocabulário FALHOU. Sem isto a ficha ficava em silêncio: sem
   * sugestão nenhuma, quem atende conclui que a etiqueta não existe e digita
   * uma variante — o defeito que o seletor veio evitar. O Inbox já diz a frase.
   */
  erroNoVocabulario?: boolean;
}

/** O teto de etiquetas por contato — o MESMO dos editores do produto. */
const MAXIMO_DE_ETIQUETAS = 20;

/** A etiqueta na paleta aberta, e o tom que ela MOSTROU quando a paleta abriu. */
interface EscolhaDeCor {
  tag: string;
  corInicial: string | null;
}

export function EtiquetasDoContato({
  value,
  onChange,
  vocabulario,
  canonicalTags,
  disabled = false,
  inputId = "etiquetas-do-contato",
  onPendente,
  onDefinirCor,
  encontradas,
  onDigitar,
  erroNoVocabulario = false,
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const cores = useCoresDasEtiquetas();
  // `null` = paleta fechada. O tom mostrado fica CONGELADO em `corInicial`:
  // confirmar compara com ele, e não com o mapa ao vivo (que pode chegar depois
  // e não foi visto) — a mesma régua do editor do Inbox (#2789).
  const [escolhaDeCor, setEscolhaDeCor] = useState<EscolhaDeCor | null>(null);

  // O vocabulário que a tela já tinha MAIS o que o servidor achou para o texto
  // digitado — a mesma união (e a mesma ordem) do editor do Inbox (#2855): uma
  // fonte só, dois pontos de uso. Sem `encontradas` a lista é a de sempre.
  const conhecidas = useMemo(
    () =>
      etiquetasConhecidas({
        vocabulario: [...(vocabulario ?? []), ...(encontradas ?? [])],
        canonicalTags,
      }),
    [vocabulario, encontradas, canonicalTags],
  );
  const sugestoes = useMemo(
    () => sugestoesDeEtiqueta({ conhecidas, selecionadas: value, digitado: draft }),
    [conhecidas, value, draft],
  );

  const digitou = draft.trim() !== "";
  const existente = etiquetaExistentePara(conhecidas, draft);
  const jaSelecionada = value.some(
    (v) => chaveDeComparacaoDeEtiqueta(v) === chaveDeComparacaoDeEtiqueta(draft),
  );
  // O texto é NOVO quando não casa com nada conhecido nem com o que já está no
  // contato: é o único caso em que "criar" aparece (sem trava de papel neste PR).
  const textoNovo = digitou && !existente && !jaSelecionada;
  const noTeto = value.length >= MAXIMO_DE_ETIQUETAS;

  /** A cor da etiqueta na chave canônica do mapa (`lower(btrim(tag))` no banco). */
  const corDe = (tag: string): string | null => cores[chaveDaEtiqueta(tag)] ?? null;

  /**
   * A régua ÚNICA de quem digita: a etiqueta EXISTENTE vence (reusa a grafia,
   * nunca cria variante), o texto novo vira etiqueta, e nada acontece quando não
   * há o que gravar. É a mesma função que o Enter, o clique em "Criar" e o
   * `Salvar` do diálogo usam — e o teto e o `disabled` valem nos três.
   */
  function alvoDoDigitado(texto: string): string | null {
    if (disabled || noTeto) return null;
    return etiquetaParaGravar({ conhecidas, selecionadas: value, digitado: texto });
  }

  /**
   * Troca o texto digitado — e avisa o que ele viraria — no MESMO gesto. O texto
   * cru também sobe (`onDigitar`): é o que faz quem monta perguntar ao servidor
   * o que existe, como o Inbox faz a cada tecla.
   */
  function definirDraft(texto: string) {
    setDraft(texto);
    onDigitar?.(texto);
    onPendente?.(alvoDoDigitado(texto));
  }

  /** Devolve a etiqueta que ENTROU na lista, ou `null` quando o gesto é recusado. */
  function adicionar(tag: string): string | null {
    if (disabled || noTeto) return null;
    const k = chaveDeComparacaoDeEtiqueta(tag);
    if (k === "" || value.some((v) => chaveDeComparacaoDeEtiqueta(v) === k)) return null;
    onChange([...value, tag]);
    definirDraft("");
    return tag;
  }

  function remover(tag: string) {
    if (disabled) return;
    onChange(value.filter((v) => v !== tag));
  }

  /**
   * O clique numa sugestão. Com a paleta disponível ela abre com o tom que a
   * etiqueta JÁ tem marcado (#2789) — abrir como se ela não tivesse cor faria
   * "Confirmar" apagar o que estava lá (#2771).
   *
   * Desabilitado (salvando) ou no teto, o clique não faz nada: a peça existe
   * para o gesto que vai gravar, e o botão de antes também era inerte ali.
   */
  function escolherSugestao(tag: string) {
    if (disabled || noTeto) return;
    if (!onDefinirCor) {
      adicionar(tag);
      return;
    }
    setEscolhaDeCor({ tag, corInicial: corDe(tag) });
  }

  /**
   * O texto digitado VIRA etiqueta — é o que o Enter e o "Criar" fazem. Passa
   * pela paleta quando ela existe: é por este caminho que a etiqueta nova
   * nascia sem cor, e a ficha é justamente onde ela é criada.
   */
  function confirmarDigitado() {
    const alvo = alvoDoDigitado(draft);
    if (alvo === null) return;
    // `alvo` também é uma etiqueta EXISTENTE quando o texto casou com a grafia
    // gravada: aí o tom inicial é o dela, e confirmar sem trocar nada não regrava.
    if (onDefinirCor) setEscolhaDeCor({ tag: alvo, corInicial: corDe(alvo) });
    else adicionar(alvo);
  }

  /** O "Confirmar" da paleta: a etiqueta entra na lista e o tom vai ao vocabulário. */
  function confirmarCor(tom: string | null) {
    if (!escolhaDeCor) return;
    const gravada = adicionar(escolhaDeCor.tag);
    // `null` aqui é "Sem cor" escolhido de propósito — só não regrava o que já
    // estava lá. E nada se grava quando a etiqueta não entrou (teto/duplicada),
    // como no editor do Inbox.
    if (gravada !== null && tom !== escolhaDeCor.corInicial) onDefinirCor?.(gravada, tom);
    setEscolhaDeCor(null);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {value.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("Nenhuma etiqueta neste contato.")}
          </span>
        ) : (
          value.map((tag) => (
            <Fragment key={tag}>
              <ChipDeEtiqueta tag={tag}>
                <button
                  type="button"
                  onClick={() => remover(tag)}
                  disabled={disabled}
                  aria-label={`${t("Remover etiqueta")} ${tag}`}
                  className="ml-1 rounded-sm hover:text-destructive"
                >
                  <X size={10} weight="bold" aria-hidden />
                </button>
              </ChipDeEtiqueta>
              {/* O repintar de quem JÁ está no contato, com a MESMA peça que o
                  Inbox usa desde a #2771: nenhuma rota nova, nenhum seletor novo. */}
              {onDefinirCor ? (
                <SeletorDeCorDaEtiqueta
                  cor={corDe(tag)}
                  onChange={(tom) => onDefinirCor(tag, tom)}
                  tag={tag}
                  rotulo={`${t("Cor da etiqueta")} ${tag}`}
                  disabled={disabled}
                />
              ) : null}
            </Fragment>
          ))
        )}
      </div>

      <Input
        id={inputId}
        value={draft}
        onChange={(e) => definirDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            confirmarDigitado();
          }
          if (e.key === "Escape") definirDraft("");
        }}
        placeholder={t("Digite para buscar etiquetas…")}
        maxLength={TAMANHO_MAXIMO_DA_TAG}
        disabled={disabled || noTeto}
        autoComplete="off"
        aria-label={t("Adicionar etiqueta")}
      />

      {/* A MESMA frase do editor do Inbox: falha de leitura não pode passar por
          "não há etiquetas", senão quem atende digita a variante que o seletor
          existe para evitar. */}
      {erroNoVocabulario ? (
        <p role="alert" className="text-xs text-destructive">
          {t("Não foi possível carregar as tags.")}
        </p>
      ) : null}

      {(sugestoes.length > 0 || textoNovo) && (
        <div
          role="group"
          aria-label={t("Sugestões de etiquetas")}
          className="flex flex-wrap gap-1"
        >
          {sugestoes.map((tag) => (
            /* A sugestão É o chip (issue #3235). O produto tem UM caminho de
               pintura — a régua de cor só é importada pelo `ChipDeEtiqueta`,
               guardado por `tests/unit/chip-contraste-da-etiqueta.test.ts` —,
               então pintar um botão por fora seria a segunda cópia da regra que
               a cerca existe para impedir. O chip recebe o papel de botão, com
               Enter e Espaço: `role` sem teclado seria menos acessível do que o
               botão sem cor que estava aqui. O tracejado continua sendo o que
               distingue a sugestão do chip sólido de quem já está no contato. */
            <ChipDeEtiqueta
              key={tag}
              tag={tag}
              role="button"
              tabIndex={0}
              aria-label={`${t("Adicionar etiqueta")}: ${tag}`}
              aria-disabled={disabled || noTeto}
              data-testid={`sugestao-${chaveDeComparacaoDeEtiqueta(tag)}`}
              onClick={() => escolherSugestao(tag)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  escolherSugestao(tag);
                }
              }}
              className={cn(
                "border-dashed px-2 py-0.5 text-[10px]",
                disabled || noTeto ? "opacity-50" : "cursor-pointer hover:border-solid",
              )}
            >
              <Plus size={10} weight="bold" aria-hidden />
            </ChipDeEtiqueta>
          ))}
          {textoNovo && (
            <button
              type="button"
              onClick={confirmarDigitado}
              disabled={disabled || noTeto}
              data-testid="criar-etiqueta"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-solid hover:text-foreground disabled:opacity-50"
            >
              <Plus size={10} weight="bold" aria-hidden />
              {t("Criar etiqueta")} “{draft.trim()}”
            </button>
          )}
        </div>
      )}

      {/* Montada só com a escolha em curso: cada abertura nasce com o tom do
          vocabulário pré-marcado, sem estado herdado da abertura anterior. */}
      {escolhaDeCor ? (
        <DialogoDeNovaEtiqueta
          tag={escolhaDeCor.tag}
          corInicial={escolhaDeCor.corInicial}
          onFechar={() => setEscolhaDeCor(null)}
          onConfirmar={confirmarCor}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
