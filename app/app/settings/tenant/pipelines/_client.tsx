"use client";

import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import type { PipelineConfigPatch } from "@/lib/schemas/settings";
import { camposDoFunil, escopoDoCampo } from "@/lib/leads/campos-do-funil";
import {
  DIAS_MAXIMO_DO_RECORTE,
  DIAS_MINIMO_DO_RECORTE,
  DIAS_PADRAO_DO_RECORTE,
  diasDeRecorte,
} from "@/lib/kanban/recorte-de-encerrados";
import {
  buscarOpcoes,
  exportarOpcoesCsv,
  importarOpcoesCsv,
} from "@/lib/leads/campos-pesquisaveis";
import { modoDeReabertura } from "@/lib/leads/reabertura";
import { CATEGORIAS_DE_PERDA } from "@/lib/schemas/leads";
import { rotuloDoTipo } from "@/lib/schemas/rotulos-do-campo";
import { useMoedaDaOrgAtiva } from "@/hooks/auth/AuthProvider";
import { MOEDA_PADRAO } from "@/lib/money";
import {
  customFieldSchema,
  MAX_CAMPOS_DO_NEGOCIO,
  type CustomFieldDef,
} from "@/lib/schemas/settings";
import {
  mostrarQuandoSchema,
  OPERADORES_DE_MOSTRA,
  type OperadorDeMostra,
} from "@/lib/schemas/mostrar-quando";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";
import { CaretDown, Plus, Trash } from "@/lib/ui/icons";
import { entradaDoInboxDeclarada } from "@/lib/leads/entrada-do-inbox";
import { AgentMappingSection, ancoraDoMapeamento } from "./_mapping";
import { StagesSection, ancoraDasEtapas } from "./_stages";

export interface PipelineRow {
  id: string;
  name: string;
  slug: string;
  vocabulary: Record<string, string> | null;
  settings: Record<string, unknown> | null;
  /** Opcional só para os testes; a página sempre manda (ver `ehFunilPadrao`). */
  is_default?: boolean;
  /** O funil de clientes (#0262): o servidor também lê `entrada_do_inbox` nele. */
  is_client_pipeline?: boolean;
}

/**
 * Os tipos de campo que esta tela oferece — DERIVADOS do schema, nunca
 * reescritos à mão.
 *
 * Quando a lista era digitada aqui, ela encolheu sem ninguém ver: `multiselect`
 * existia em `customFieldSchema`, era gravado pela API e aparecia no dossiê
 * (`components/contacts/CustomFieldsEditor.tsx`), mas faltava nesta lista. O
 * efeito para quem abria a tela era um campo que parecia corrompido — o
 * `<Select>` recebia `value="multiselect"`, nenhum `SelectItem` casava, e o
 * seletor ficava EM BRANCO. Pior: as opções do campo só apareciam para
 * `select`, então um multiselect ficava sem como ser editado, e a saída óbvia
 * (escolher um tipo para "consertar" o branco) transformava a escolha múltipla
 * em escolha única.
 *
 * Derivar do schema faz a divergência deixar de ser possível: tipo novo lá
 * nasce oferecido aqui.
 */
export const TIPOS_DE_CAMPO = customFieldSchema.shape.type.options;

/** Tipos cujo valor sai de uma lista fechada — são os que mostram o campo de opções. */
export function tipoTemOpcoes(tipo: CustomFieldDef["type"]): boolean {
  return tipo === "select" || tipo === "multiselect" || tipo === "searchable_select";
}

/**
 * Uma etapa do funil, do jeito que o editor de `obrigatorio_em` precisa ler.
 *
 * `is_archived` entra porque a lista É COMPLETA de propósito: descartar a etapa
 * arquivada na leitura apagaria silenciosamente a marca que alguém já fez — o
 * save regrava `fields` inteiro, então o que não aparece na tela some do
 * settings. Arquivada fica visível e marcada; ela não recebe card novo, mas
 * também não é apagada por baixo de quem a marcou.
 */
export interface EtapaDoFunil {
  id: string;
  name: string;
  is_archived: boolean;
  /**
   * Etapa de fechamento. Opcional porque o editor de `obrigatorio_em` (#1536)
   * não distingue fechamento de abertura — ele mostra TODAS as etapas, e a
   * marca que alguém já fez não pode sumir por causa de um filtro. Quem
   * ESCOLHE a etapa de entrada do Inbox (#3011) filtra por eles: card não
   * nasce em "Ganho". A página sempre manda os dois.
   */
  is_won?: boolean;
  is_lost?: boolean;
}

/**
 * O item do seletor da entrada do Inbox que significa "a primeira etapa do
 * funil" — o comportamento de sempre, e o valor que DESLIGA o ajuste (#3011).
 *
 * Radix recusa `value=""` em `<SelectItem>`, e "não quero escolher etapa" precisa
 * ser um item como os outros — não um placeholder que some quando a pessoa
 * escolhe algo.
 */
export const ENTRADA_DO_INBOX_PADRAO = "__primeira_etapa__";

/**
 * As etapas que PODEM receber a conversa nova (#3011): abertas, e nem ganho nem
 * perdido.
 *
 * É a mesma lista que `etapaDeEntrada` consulta no banco antes de aceitar a
 * etapa declarada. Oferecer uma etapa que a gravação recusaria faria a tela
 * prometer uma escolha que o fallback desfaz em silêncio — o defeito que este
 * controle existe para acabar.
 */
export function etapasQueRecebemConversa(etapas: EtapaDoFunil[]): EtapaDoFunil[] {
  return etapas.filter((e) => !e.is_archived && e.is_won !== true && e.is_lost !== true);
}

/**
 * A regra `obrigatorio_em` normalizada — NADA MARCADO É AUSÊNCIA, não `{}`.
 *
 * `undefined` e `{}` significam a mesma coisa para `validaCamposExigidos`, mas
 * só o primeiro deixa o settings do funil idêntico ao de antes do #1536: gravar
 * `{ etapas: [], ao_ganhar: false, ao_perder: false }` encheria todo campo de
 * uma chave morta e faria o critério de aceite nº 3 ("sem `obrigatorio_em` o
 * comportamento é o de antes") depender de olhar para dentro do objeto.
 */
export function normalizaObrigatorioEm(
  regra: CustomFieldDef["obrigatorio_em"],
): CustomFieldDef["obrigatorio_em"] {
  const etapas = regra?.etapas ?? [];
  const aoGanhar = regra?.ao_ganhar === true;
  const aoPerder = regra?.ao_perder === true;
  if (etapas.length === 0 && !aoGanhar && !aoPerder) return undefined;
  return {
    ...(etapas.length > 0 ? { etapas } : {}),
    ...(aoGanhar ? { ao_ganhar: true } : {}),
    ...(aoPerder ? { ao_perder: true } : {}),
  };
}

/** Liga/desliga UMA etapa na regra do campo, sem mexer no resto da marca. */
export function comEtapa(
  regra: CustomFieldDef["obrigatorio_em"],
  etapaId: string,
  marcada: boolean,
): CustomFieldDef["obrigatorio_em"] {
  const etapas = new Set(regra?.etapas ?? []);
  if (marcada) etapas.add(etapaId);
  else etapas.delete(etapaId);
  return normalizaObrigatorioEm({ ...regra, etapas: [...etapas] });
}

/** Liga/desliga um dos dois gatilhos de FECHAMENTO (`ao_ganhar`/`ao_perder`). */
export function comGatilho(
  regra: CustomFieldDef["obrigatorio_em"],
  gatilho: "ao_ganhar" | "ao_perder",
  marcado: boolean,
): CustomFieldDef["obrigatorio_em"] {
  return normalizaObrigatorioEm({ ...regra, [gatilho]: marcado });
}

/**
 * Valor do `<Select>` que significa "sem condição" (issue #2728).
 *
 * Radix recusa `value=""` em `<SelectItem>`, e "mostrar sempre" precisa ser um
 * item da lista — não um placeholder que some assim que a pessoa escolhe.
 */
export const SEM_CONDICAO = "__sem_condicao__";

/** O `<Select>` de valor também precisa de item para "ainda não escolhi". */
export const SEM_VALOR_DA_CONDICAO = "__sem_valor_da_condicao__";

/**
 * O operador da condição, resolvendo as DUAS formas que ela pode estar gravada:
 * a da issue (`{campo, contem: "Outro"}`) e a par que o editor escreve
 * (`{campo, operador, valor}`). Sem condição, o padrão é `igual` — é o que o
 * seletor mostra antes de a pessoa montar a regra.
 */
export function operadorDaCondicao(condicao: CustomFieldDef["mostrar_quando"]): OperadorDeMostra {
  if (condicao?.operador) return condicao.operador;
  return OPERADORES_DE_MOSTRA.find((op) => condicao?.[op] !== undefined) ?? "igual";
}

/**
 * O valor da condição como TEXTO: é o que o input devolve, é o que a pessoa
 * digita, e é o que `campoVisivel` compara (`"2"` e `2` casam na régua de
 * número lá).
 */
export function valorDaCondicao(condicao: CustomFieldDef["mostrar_quando"]): string {
  const valor =
    condicao?.operador !== undefined ? condicao?.valor : condicao?.[operadorDaCondicao(condicao)];
  return valor === undefined || valor === null ? "" : String(valor);
}

/**
 * Monta a condição de volta na forma GRAVÁVEL — a que `mostrarQuandoSchema`
 * valida.
 *
 * Sem campo não há condição (a pessoa limpou o seletor, ou escolheu "Sempre
 * mostrar"). Com campo mas sem valor, a condição fica MEIO montada na tela —
 * é o estado de quem está digitando — e `normalizaMostrarQuando` a descarta
 * no save, do mesmo jeito que `obrigatorio_em` sem nenhuma marca é ausência.
 */
export function escreveMostrarQuando(
  condicao: CustomFieldDef["mostrar_quando"],
  mudanca: { campo?: string; operador?: OperadorDeMostra; valor?: string },
): CustomFieldDef["mostrar_quando"] {
  const proximo = {
    campo: mudanca.campo ?? condicao?.campo ?? "",
    operador: mudanca.operador ?? operadorDaCondicao(condicao),
    valor: mudanca.valor ?? valorDaCondicao(condicao),
  };
  const campo = proximo.campo.trim();
  if (campo.length === 0) return undefined;
  // O item "ainda não escolhi" do seletor de valor não é valor: gravá-lo
  // deixava a condição completa casando com nada, e o campo sumia para sempre.
  const valor = proximo.valor === SEM_VALOR_DA_CONDICAO ? "" : proximo.valor.trim();
  return {
    campo,
    operador: proximo.operador,
    ...(valor.length > 0 ? { valor } : {}),
  };
}

/**
 * A condição só grava quando está COMPLETA — o espelho exato de
 * `normalizaObrigatorioEm`: meio montada é ausência, e não um save que
 * recusa a tela inteira com a mensagem de um campo que a pessoa nem terminou
 * de configurar.
 */
export function normalizaMostrarQuando(
  condicao: CustomFieldDef["mostrar_quando"],
): CustomFieldDef["mostrar_quando"] {
  return mostrarQuandoSchema.safeParse(condicao).success ? condicao : undefined;
}

/**
 * Os RÓTULOS cadastrados (issue #1537): `lost_reasons` aceita texto puro E
 * `{ label, categoria }`, e esta caixa é sempre rótulo — o objeto é guardado
 * aqui embaixo, na hora de salvar.
 */
function readLostReasons(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const r = (settings as { lost_reasons?: unknown }).lost_reasons;
  if (!Array.isArray(r)) return [];
  return r
    .map((item) => (typeof item === "string" ? item : (item as { label?: unknown })?.label))
    .filter((v): v is string => typeof v === "string");
}

/** Rótulo → categoria gravada (issue #1537). Sem categoria é ausência, não "". */
function readCategorias(settings: Record<string, unknown> | null): Record<string, string> {
  const saida: Record<string, string> = {};
  if (!settings) return saida;
  const r = (settings as { lost_reasons?: unknown }).lost_reasons;
  if (!Array.isArray(r)) return saida;
  for (const item of r) {
    if (typeof item !== "object" || item === null) continue;
    const { label, categoria } = item as { label?: unknown; categoria?: unknown };
    if (typeof label === "string" && typeof categoria === "string" && categoria.trim()) {
      saida[label.trim()] = categoria.trim();
    }
  }
  return saida;
}


function readWonReasons(settings: Record<string, unknown> | null): string[] {
  const r = (settings as { won_reasons?: unknown } | null)?.won_reasons;
  return Array.isArray(r) ? r.filter((v): v is string => typeof v === "string") : [];
}
export function PipelinesClient({
  pipelines,
  etapas = {},
  podeEditarConfig,
  comandaDisponivel = false,
}: {
  pipelines: PipelineRow[];
  /**
   * As etapas de cada funil por id de funil — o que o editor de `obrigatorio_em`
   * oferece como "exigir ao entrar aqui". Opcional só para os testes que não
   * exercitam esta regra; a página sempre manda.
   */
  etapas?: Record<string, EtapaDoFunil[]>;
  /** Vocabulário/custom fields são admin (a server action recusa o resto). */
  podeEditarConfig: boolean;
  /**
   * O módulo `financeiro` está instalado (#1907)? Sem ele não existe comanda, e o
   * interruptor "abrir comanda ao ganhar" some. Ausente = desligado (falha
   * fechada); a página sempre manda.
   */
  comandaDisponivel?: boolean;
}) {
  const t = useT();
  if (pipelines.length === 0) {
    // ⚠️ NÃO PROMETA UM CAMINHO QUE NÃO EXISTE — nem NEGUE um que existe. Este
    // texto dizia que criar funil "é feito por quem instalou o sistema, direto
    // no banco", e isso ficou falso quando a lista de Funis (`/app/kanban`)
    // ganhou o botão "Novo funil" (POST /api/v1/pipelines, que já cria as
    // etapas iniciais). Mandar o dono procurar quem instalou, quando o botão
    // está a um clique, é o mesmo beco sem saída de antes, no sentido inverso.
    // O link NÃO cita o rótulo do botão: com zero funil vivo a lista mostra
    // "Criar meu primeiro funil", não "Novo funil".
    return (
      <Card className="p-6 text-sm leading-relaxed text-muted-foreground" data-testid="sem-funil-configuracao">
        {t("Você ainda não tem nenhum funil. Enquanto for assim, o agente atende normalmente, mas não tem para onde levar o card de ninguém — não há etapas para onde mover.")}{" "}
        <Link href="/app/kanban" className="font-medium text-foreground underline underline-offset-2" data-testid="link-criar-funil">
          {t("Crie o primeiro na tela Funis")}
        </Link>
        {t(": ele já nasce com etapas, e depois aparece aqui para você escolher a etapa de cada passo.")}
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {pipelines.map((p) => (
        <CardDoFunil
          key={p.id}
          pipeline={p}
          etapas={etapas[p.id] ?? []}
          podeEditarConfig={podeEditarConfig}
          comandaDisponivel={comandaDisponivel}
          ehFunilPadrao={p.id === (pipelines.find((x) => x.is_default) ?? pipelines[0])?.id}
        />
      ))}
    </div>
  );
}

/**
 * O CARD DE UM FUNIL — e o editor dele SÓ MONTA QUANDO EXPANDIDO (issue #3176).
 *
 * ─── O defeito, medido ────────────────────────────────────────────────────
 *
 * A tela montava o editor de TODOS os funis na abertura: vocabulário, motivos,
 * e o editor de campos com as opções de cada campo de lista — num caso real
 * (agência de viagens) 3 funis × listas de 13 a 756 opções, tudo de uma vez. O
 * autor da issue mediu o `Runtime.evaluate` da página passando de 45 s sem
 * resposta, logo depois de carregar.
 *
 * O que muda aqui: o corpo do card (etapas e mapeamento, que o gestor abre a
 * tela para ver) continua visível, e o EDITOR do funil — que é onde as listas
 * longas moram — passa a montar sob demanda, um funil por vez. A contagem de
 * nós do DOM da tela inteira, com o caso de controle da issue, está na
 * evidência do PR: recolhido × expandido.
 */
function CardDoFunil({
  pipeline,
  etapas,
  podeEditarConfig,
  comandaDisponivel,
  ehFunilPadrao,
}: {
  pipeline: PipelineRow;
  etapas: EtapaDoFunil[];
  podeEditarConfig: boolean;
  comandaDisponivel: boolean;
  ehFunilPadrao: boolean;
}) {
  const t = useT();
  const [editorAberto, setEditorAberto] = useState(false);
  // Monta na primeira vez que abre e fica montado: recolher só ESCONDE. Desmontar
  // apagaria em silêncio o que foi editado e ainda não salvo.
  const [editorMontado, setEditorMontado] = useState(false);
  return (
    <Card className="space-y-6 p-6">
      <header>
        <h2 className="text-base font-semibold">{pipeline.name}</h2>
        <p className="text-xs text-muted-foreground">/{pipeline.slug}</p>
      </header>
      {/* As ETAPAS vêm primeiro, e a ordem é a do raciocínio de quem
          configura: primeiro o quadro existe do jeito da sua operação,
          depois se decide o que o assistente faz com ele. Invertido, a
          primeira coisa que o dono da clínica vê é um mapeamento sobre
          colunas de e-commerce que ele nem sabia que dava para trocar. */}
      <StagesSection pipelineId={pipeline.id} ancoraMapeamento={ancoraDoMapeamento(pipeline.id)} />
      <div className="border-t border-border pt-6">
        <AgentMappingSection pipelineId={pipeline.id} ancoraEtapas={ancoraDasEtapas(pipeline.id)} />
      </div>
      {podeEditarConfig && (
        <div className="space-y-4 border-t border-border pt-6">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={editorAberto}
            data-testid={`abrir-editor-${pipeline.id}`}
            onClick={() => {
              setEditorMontado(true);
              setEditorAberto((aberto) => !aberto);
            }}
          >
            <CaretDown
              size={14}
              aria-hidden
              className={editorAberto ? "mr-1 rotate-180" : "mr-1"}
            />
            {editorAberto
              ? t("Recolher")
              : t("Editar vocabulário e campos deste funil")}
          </Button>
          {editorMontado && (
            <div hidden={!editorAberto} data-testid={`area-do-editor-${pipeline.id}`}>
              <PipelineEditor
                pipeline={pipeline}
                etapas={etapas}
                comandaDisponivel={comandaDisponivel}
                ehFunilPadrao={ehFunilPadrao}
              />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Quantas opções a lista aberta monta de cada vez (issue #3176). */
export const OPCOES_POR_PAGINA = 20;

/**
 * Baixa um texto como arquivo `.csv`.
 *
 * `URL.createObjectURL` não existe em todo ambiente (o jsdom dos testes, por
 * exemplo) — e um botão de download não pode derrubar a tela por causa disso.
 * Sem ele o arquivo sai por uma URL `data:`, que carrega o mesmo texto.
 */
function baixarCsv(nome: string, texto: string): void {
  const href =
    typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }))
      : `data:text/csv;charset=utf-8,${encodeURIComponent(texto)}`;
  const ancora = document.createElement("a");
  ancora.href = href;
  ancora.download = nome;
  ancora.click();
  if (href.startsWith("blob:")) URL.revokeObjectURL(href);
}

/**
 * AS OPÇÕES DE UM CAMPO DE LISTA — RECOLHIDAS ATÉ ALGUÉM PEDIR (issue #3176).
 *
 * ─── O defeito que este componente fecha ──────────────────────────────────
 *
 * O editor de Configurações › Funis montava, para CADA campo de lista de CADA
 * funil, o input de opções com a lista INTEIRA no `value` (`"Destino 0, Destino
 * 1, …"` — 756 destinos, apelidos inclusos), a caixa de importação CSV e o
 * botão de importar, tudo de uma vez e para todos os funis na abertura da tela.
 * Numa agência de viagens isso são milhares de linhas de formulário, e o
 * navegador travava (§ o número medido está na evidência do PR).
 *
 * Aqui isso vira: um RESUMO com a contagem (`756 opções · Importar CSV ·
 * Exportar CSV`) e um botão. A busca, a lista paginada, a edição e a importação
 * existem SÓ enquanto a pessoa está olhando aquele campo — e nunca para os
 * outros campos ao mesmo tempo.
 *
 * ─── O que NÃO muda ───────────────────────────────────────────────────────
 *
 * - o input de opções continua o MESMO (rótulos separados por vírgula) e
 *   continua preservando o `value` canônico e os apelidos de todo rótulo que já
 *   existia — é o que impede uma tecla de trocar `maceio-al` por `Maceió (AL)`
 *   e apagar os apelidos de negócios já gravados;
 * - a importação CSV é a MESMA função (`importarOpcoesCsv`) e o MESMO formato
 *   `value,label,apelidos`, sem duplicar o que já existe;
 * - a lista ABERTA mostra as opções por página (`OPCOES_POR_PAGINA`) e só as
 *   que a busca alcança: abrir não é montar as 756 de uma vez.
 */
export function OpcoesDaLista({
  campo,
  indice,
  csv,
  aoMudarCsv,
  aoMudarOpcoes,
}: {
  campo: CustomFieldDef;
  /** Posição do campo no funil (1-based) — é o que distingue os campos nos testes. */
  indice: number;
  /** O texto CSV colado para ESTE campo; "Importar" o transforma em opções e o limpa. */
  csv: string;
  aoMudarCsv: (texto: string) => void;
  aoMudarOpcoes: (options: CustomFieldDef["options"]) => void;
}) {
  const t = useT();
  const [aberta, setAberta] = useState(false);
  const [termo, setTermo] = useState("");
  const [pagina, setPagina] = useState(1);
  const opcoes = campo.options ?? [];
  const apelidos = opcoes.reduce((soma, o) => soma + (o.aliases?.length ?? 0), 0);
  const pesquisavel = campo.type === "searchable_select";
  // A MESMA busca do autocompletar da ficha (`buscarOpcoes`): prefixo primeiro,
  // depois trecho, sem caixa, acento nem espaço a mais. Termo vazio devolve a
  // lista inteira — é o que a pessoa quer ver quando abre — e quem corta o que
  // é MONTADO é a página logo abaixo.
  const encontradas = aberta ? buscarOpcoes(opcoes, termo, opcoes.length) : [];
  const visiveis = encontradas.slice(0, pagina * OPCOES_POR_PAGINA);

  function importar() {
    if (csv.trim() === "") return;
    const r = importarOpcoesCsv(opcoes, csv);
    aoMudarOpcoes(r.opcoes);
    aoMudarCsv("");
    if (r.adicionadas.length > 0) {
      toast.success(
        `${r.adicionadas.length} ${t("opções importadas.")}` +
          (r.ignoradas.length > 0 ? ` ${r.ignoradas.length} ${t("já existiam.")}` : ""),
      );
    } else {
      toast.info(t("Nenhuma opção nova para importar."));
    }
  }

  return (
    <div className="space-y-2 lg:col-span-4" data-testid={`opcoes-campo-${indice + 1}`}>
      <div className="flex flex-wrap items-center gap-2">
        {/* O RESUMO é o que a tela mostra no lugar das opções — e a contagem é
            o número que quem configura precisa ver de relance. */}
        <span className="text-xs text-muted-foreground" data-testid={`resumo-opcoes-${indice + 1}`}>
          {`${opcoes.length} ${t("opções")}`}
          {apelidos > 0 ? ` · ${apelidos} ${t("apelidos")}` : ""}
          {pesquisavel ? ` · ${t("Importar CSV")} · ${t("Exportar CSV")}` : ""}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={aberta}
          aria-label={`${
            aberta ? t("Recolher a lista do campo") : t("Ver e editar a lista do campo")
          } ${indice + 1}`}
          data-testid={`abrir-opcoes-${indice + 1}`}
          onClick={() => setAberta((v) => !v)}
        >
          {aberta ? t("Recolher") : t("Ver opções")}
        </Button>
      </div>
      {aberta && (
        <div
          className="space-y-2 rounded-md border border-border p-2"
          data-testid={`lista-opcoes-${indice + 1}`}
        >
          <Input
            type="search"
            className="h-8 text-xs"
            aria-label={`${t("Buscar opções")} ${indice + 1}`}
            placeholder={t("Buscar")}
            value={termo}
            onChange={(e) => {
              setTermo(e.target.value);
              // Busca nova é lista nova: voltar para a primeira página é o que
              // mantém o resultado da busca à vista, e não no fim da anterior.
              setPagina(1);
            }}
          />
          <ul
            className="flex flex-col divide-y divide-border text-xs"
            data-testid={`opcoes-${indice + 1}`}
          >
            {visiveis.map((o) => (
              <li key={o.value} className="flex flex-wrap items-center gap-x-2 py-1">
                <span>{o.label}</span>
                <span className="text-muted-foreground">{o.value}</span>
                {o.aliases && o.aliases.length > 0 && (
                  <span className="text-muted-foreground">{o.aliases.join(" · ")}</span>
                )}
              </li>
            ))}
          </ul>
          {encontradas.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("Nenhuma opção casa com a busca.")}</p>
          )}
          {encontradas.length > visiveis.length && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={`mais-opcoes-${indice + 1}`}
              onClick={() => setPagina((p) => p + 1)}
            >
              {t("Mostrar mais opções")}
            </Button>
          )}
          <Input
            className="h-8 text-xs"
            aria-label={`${t("Opções do campo")} ${indice + 1}`}
            placeholder={t("Opções, separadas por vírgula")}
            value={opcoes.map((o) => o.label).join(", ")}
            onChange={(e) => {
              // SEM `.filter(Boolean)` aqui, de propósito. O item vazio do
              // fim é o que a vírgula acabou de criar, e ele precisa
              // sobreviver até a pessoa digitar a palavra seguinte.
              // Descartá-lo no mesmo instante apaga o separador da tela —
              // digitar "Dor," some com a vírgula — e a tecla seguinte cola
              // na palavra anterior ("Dor" + "O" vira "DorO"). Com o item
              // vazio preservado, o `join(", ")` reescreve "Dor, " e o
              // cursor continua onde a pessoa parou. O vazio só é descartado
              // no `handleSave`, quando deixa de ser útil. Pelo mesmo
              // motivo só o INÍCIO é aparado (o espaço que o `join(", ")`
              // põe): aparar o fim apagaria o espaço recém-digitado, e
              // "Clareamento" + " " + "D" viraria "ClareamentoD".
              //
              // O input só mostra RÓTULOS, mas a opção é mais que isso: o
              // `value` canônico e os apelidos que a importação CSV trouxe
              // (#2521). Reconstruir tudo como `{ value: label }` faria uma
              // tecla qualquer trocar `maceio-al` por `Maceió (AL)` e apagar
              // os apelidos — e os negócios já gravados com `maceio-al`
              // deixariam de casar com a lista. Por isso o rótulo que JÁ
              // existia (comparado aparado) mantém a opção dele; só o rótulo
              // sem par vira opção nova. O limite: renomear um rótulo
              // importado gera opção nova, porque o texto do meio da edição
              // não casa com nada.
              const options = e.target.value
                .split(",")
                .map((s) => s.trimStart())
                .map((label) => {
                  const existente = opcoes.find(
                    (o) => label.trim() !== "" && o.label.trim() === label.trim(),
                  );
                  return existente ? { ...existente, label } : { value: label, label };
                });
              aoMudarOpcoes(options);
            }}
          />
          {pesquisavel && (
            /* A IMPORTAÇÃO (#2521) — o CSV que a agência já tem (municípios do
               IBGE, destinos, IATA): `value,label,apelidos` por linha, apelidos
               separados por `;`. O que já existe não duplica, e o que foi
               importado fica junto das opções digitadas à mão. O EXPORTAR ao
               lado (#3176) escreve o MESMO dialeto, para a lista poder ser
               editada fora do CRM e reimportada. */
            <div className="flex items-start gap-2">
              <textarea
                aria-label={`${t("Importar opções (CSV)")} ${indice + 1}`}
                className="min-h-16 w-full rounded-md border border-border bg-transparent p-2 text-xs"
                placeholder={t("value,label,apelidos — uma opção por linha")}
                value={csv}
                onChange={(e) => aoMudarCsv(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`${t("Importar opções do campo")} ${indice + 1}`}
                onClick={importar}
              >
                {t("Importar")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid={`exportar-opcoes-${indice + 1}`}
                onClick={() => baixarCsv(`${campo.key}.csv`, exportarOpcoesCsv(opcoes))}
              >
                {t("Exportar CSV")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PipelineEditor({
  pipeline,
  etapas,
  comandaDisponivel,
  ehFunilPadrao,
}: {
  pipeline: PipelineRow;
  etapas: EtapaDoFunil[];
  comandaDisponivel: boolean;
  /**
   * A ficha do contato lê as definições SÓ do funil padrão — a mesma régua de
   * `/api/v1/pipelines/default`: `is_default`, senão o primeiro não arquivado por
   * `position` (a página entrega a lista nessa ordem). Num funil secundário,
   * marcar "Contato" tiraria o campo do card sem pô-lo na ficha: some de toda tela.
   */
  ehFunilPadrao: boolean;
}) {
  const t = useT();
  // O tipo moeda diz a moeda da organização (« Moeda (EUR) »), não « (BRL) » em duro.
  const moeda = useMoedaDaOrgAtiva() ?? MOEDA_PADRAO;
  const v = pipeline.vocabulary ?? {};
  const [lead, setLead] = useState(v.lead ?? "Lead");
  const [deal, setDeal] = useState(v.deal ?? "Deal");
  const [won, setWon] = useState(v.won ?? "Ganho");
  const [lost, setLost] = useState(v.lost ?? "Perdido");
  const [reasonsText, setReasonsText] = useState(readLostReasons(pipeline.settings).join(", "));
  const [wonReasonsText, setWonReasonsText] = useState(readWonReasons(pipeline.settings).join(", "));
  const [categorias, setCategorias] = useState<Record<string, string>>(() =>
    readCategorias(pipeline.settings),
  );
  const [wonRequired, setWonRequired] = useState(
    (pipeline.settings as { won_reason_required?: unknown } | null)?.won_reason_required === true,
  );
  // A comanda do ganho (#1477): opt-in, e o PADRÃO é a chave ausente — só o
  // `true` explícito liga. Ausência aqui renderiza desmarcado, que é o mesmo
  // que o consumidor de `lead.won` lê no banco.
  const [comandaNoGanho, setComandaNoGanho] = useState(
    (pipeline.settings as { comanda_no_ganho?: unknown } | null)?.comanda_no_ganho === true,
  );
  const [retomaComoNovo, setRetomaComoNovo] = useState(
    modoDeReabertura(pipeline.settings) === "novo_negocio",
  );
  // O recorte de encerrados antigos do quadro (#2995): opção POR FUNIL em
  // `settings.ocultar_encerrados_dias`, desligada por padrão. O número relido é
  // o que está gravado (`null` = desligado) e é ele que preenche o campo de
  // dias, para ligar/desligar não exigir digitação; o campo já nasce com a
  // sugestão de 30 dias, que NÃO é gravada enquanto ninguém ligar a opção.
  const diasRelidos = diasDeRecorte(pipeline.settings);
  const [ocultarEncerrados, setOcultarEncerrados] = useState(diasRelidos !== null);
  const [diasDosEncerrados, setDiasDosEncerrados] = useState(
    diasRelidos !== null ? String(diasRelidos) : String(DIAS_PADRAO_DO_RECORTE),
  );
  /**
   * A ENTRADA DAS CONVERSAS DO INBOX (#3011) — quantas fatias da tela o ajuste
   * tem.
   *
   * O ajuste nasceu no banco, com leitura e fallback provados, e sem lugar
   * nenhum para ser ligado: a doutrina (`docs/doctrine/sistema-vivo.md`,
   * invariante 6) pede tela para ver, tela para mudar e aviso visível quando
   * falha. São DOIS estados porque o ajuste tem duas decisões: se ele vale
   * (`ativa`) e QUAL etapa foi escolhida (`stage_id`). Desligar NÃO apaga a
   * etapa — quem desliga e depois religa não escolhe de novo, e é por isso que
   * o valor lembrado é guardado mesmo com o seletor na primeira etapa.
   */
  const entradaInicial = entradaDoInboxDeclarada(pipeline.settings);
  const [entradaAtiva, setEntradaAtiva] = useState(entradaInicial.ativa);
  const [entradaEtapaId, setEntradaEtapaId] = useState<string | null>(entradaInicial.stage_id);
  // O texto CSV de importação de opções (#2521), por chave de campo — vive só
  // enquanto a pessoa cola; "Importar" o transforma em opções e o limpa.
  const [csvDeOpcoes, setCsvDeOpcoes] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<CustomFieldDef[]>(camposDoFunil(pipeline.settings));
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const ok: CustomFieldDef[] = [];
    for (const f of fields) {
      // O item vazio que a vírgula deixou no input segue vivo até aqui — é o
      // preço de NÃO descartá-lo durante a digitação (ver o `onChange` das
      // opções). Ele nunca foi uma opção: `customFieldSchema` exige
      // `label.min(1)`, então filtrá-lo ANTES de validar é o que separa "acabei
      // de digitar uma vírgula" de "quero gravar uma opção em branco". É aqui
      // também que o espaço do FIM de cada opção é aparado: o `onChange` só
      // apara o início, para não apagar o espaço que a pessoa está digitando.
      const limpo = tipoTemOpcoes(f.type)
        ? {
            ...f,
            options: (f.options ?? [])
              .map((o) => ({
                value: o.value.trim(),
                label: o.label.trim(),
                // Os APELIDOS da opção (#2521) sobrevivem ao salvar: o input de
                // opções preserva `value` e apelidos de todo rótulo que já
                // existia (ver o `onChange` dele), e esquecer a chave aqui
                // apagaria o que a importação CSV cadastrou.
                ...(o.aliases && o.aliases.length > 0 ? { aliases: o.aliases } : {}),
              }))
              .filter((o) => o.label !== ""),
          }
        : f;
      // A regra de `obrigatorio_em` é normalizada AQUI, e não só durante a
      // digitação: um campo que chegou do settings com `{}` ou com marca
      // desligada sai sem a chave — é o que mantém o funil idêntico ao de antes
      // do #1536 enquanto ninguém marca nada.
      const { obrigatorio_em: regraBruta, ...semRegra } = limpo;
      const regra = normalizaObrigatorioEm(regraBruta);
      const base = regra ? { ...semRegra, obrigatorio_em: regra } : semRegra;
      // A condição de exibição passa pela MESMA régua (#2728): meio montada é
      // ausência, e não um save recusado com a mensagem de um campo que a
      // pessoa nem terminou de configurar.
      const { mostrar_quando: condicaoBruta, ...semCondicao } = base;
      const condicao = normalizaMostrarQuando(condicaoBruta);
      const comCondicao = condicao ? { ...semCondicao, mostrar_quando: condicao } : semCondicao;
      const parsed = customFieldSchema.safeParse(comCondicao);
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? t("Campo inválido."));
        return;
      }
      ok.push(parsed.data);
    }
    const reasons = reasonsText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // #1537: motivo com categoria vira `{ label, categoria }`; sem categoria
    // continua string pura — formato que todo funil já tem e que o trigger
    // aceita igual.
    const motivosComCategoria = reasons.map((rotulo) => {
      const categoria = categorias[rotulo];
      return categoria ? { label: rotulo, categoria } : rotulo;
    });

    const wonReasons = wonReasonsText
      .split(",")
      .map((s2) => s2.trim())
      .filter((s2) => s2.length > 0);

    // #2995 — o recorte de encerrados antigos do quadro: os dias vêm de um
    // campo de texto, e um número fora da faixa faria o schema recusar o save
    // inteiro com a mensagem genérica de validação. Barrar aqui diz o que está
    // errado — a mesma técnica dos campos logo acima. O `0` é o DESLIGADO, e
    // vai explícito no patch: a action faz merge com o settings do banco, então
    // omitir a chave deixaria o número antigo e a pessoa desligaria a opção
    // para continuar vendo os cards sumirem. (O texto repete a faixa de
    // `DIAS_MINIMO_DO_RECORTE`/`DIAS_MAXIMO_DO_RECORTE`, como o resto da tela
    // repete os limites dos campos: a chave de tradução é o texto renderizado.)
    const diasDigitados = Number(diasDosEncerrados.trim());
    if (
      ocultarEncerrados &&
      (!Number.isInteger(diasDigitados) ||
        diasDigitados < DIAS_MINIMO_DO_RECORTE ||
        diasDigitados > DIAS_MAXIMO_DO_RECORTE)
    ) {
      toast.error(t("Escolha de 1 a 3650 dias para esconder os negócios encerrados do quadro."));
      return;
    }

    const patch: PipelineConfigPatch = {
      vocabulary: { lead, deal, won, lost },
      fields: ok,
      lost_reasons: motivosComCategoria,
      won_reasons: wonReasons,
      won_reason_required: wonRequired,
      comanda_no_ganho: comandaNoGanho,
      reabertura: retomaComoNovo ? "novo_negocio" : "mesmo_registro",
      // A ENTRADA DAS CONVERSAS DO INBOX (#3011) vai no MESMO patch, pela
      // MESMA porta de escrita do settings — a gravação no banco já existe
      // (`updatePipelineConfig`), e a tela só passa a mandar a chave.
      //
      // A chave SÓ entra quando há o que dizer: um funil que nunca declarou
      // etapa nenhuma continua idêntico ao de antes deste ajuste, em vez de
      // ganhar `{ ativa: false }` morto em toda gravação. Quem JÁ declarou e
      // desliga manda a escolha junto (`stage_id` preservado), porque o
      // desligado é uma decisão com memória: religar não obriga a escolher de
      // novo.
      ...(entradaLigada || entradaInicial.ativa || entradaInicial.stage_id
        ? {
            entrada_do_inbox: {
              ativa: entradaLigada,
              ...(entradaEtapaId ? { stage_id: entradaEtapaId } : {}),
            },
          }
        : {}),
      ocultar_encerrados_dias: ocultarEncerrados ? diasDigitados : 0,
    };
    startTransition(async () => {
      const r = await updatePipelineConfig(pipeline.id, patch);
      if (r.ok) toast.success(`${pipeline.name} ${t("atualizado.")}`);
      else if (r.error === "mfa_required") irAoDesafioDeMfa();
      else toast.error(`${t("Erro:")} ${r.error}`);
    });
  }


  const motivosDaCaixa = reasonsText
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // ─── A ENTRADA DAS CONVERSAS DO INBOX (#3011) ──────────────────────────
  // Quem pode ser escolhido, o que está escolhido hoje, e o que fazer quando a
  // escolha deixou de valer. A escolha inválida CONTINUA à mostra no seletor
  // (marcada como indisponível) e o aviso diz para onde as conversas estão indo
  // — é o "aviso visível quando falha" que a doutrina pede, e é o que impede a
  // queda para a primeira etapa de virar silêncio.
  const etapasDeEntrada = etapasQueRecebemConversa(etapas);
  // "Ligado" é terceiro estado: sem etapa escolhida não há o que declarar —
  // um ajuste ligado apontando para lugar nenhum cairia na primeira etapa de
  // qualquer forma, e o seletor diz isso mostrando o item padrão.
  const entradaLigada = entradaAtiva && entradaEtapaId !== null;
  const etapaDeclarada = entradaInicial.stage_id;
  const declaradaVale = etapaDeclarada !== null && etapasDeEntrada.some((e) => e.id === etapaDeclarada);
  const escolhaPerdida = entradaInicial.ativa && !declaradaVale;
  const etapaForaDaLista = etapaDeclarada !== null && !declaradaVale;
  const nomeDaEtapaPerdida = etapaForaDaLista
    ? `${etapas.find((e) => e.id === etapaDeclarada)?.name ?? t("Etapa removida")} (${t("indisponível")})`
    : "";

  return (
    <div className="space-y-4" data-testid={`editor-${pipeline.id}`}>
      <h3 className="text-sm font-semibold">{t("Vocabulário e campos")}</h3>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">{t("Lead")}</Label>
          <Input value={lead} onChange={(e) => setLead(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("Deal")}</Label>
          <Input value={deal} onChange={(e) => setDeal(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("Won")}</Label>
          <Input value={won} onChange={(e) => setWon(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("Lost")}</Label>
          <Input value={lost} onChange={(e) => setLost(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("Motivos de perda (separados por vírgula)")}</Label>
        <Input value={reasonsText} onChange={(e) => setReasonsText(e.target.value)} />
        {/*
          #1537 — a categoria de CADA motivo, não um campo só: é ela que o
          relatório "Perdas" e o filtro do quadro agrupam. Só aparece para
          motivo já escrito na caixa de cima: a lista continua sendo texto e a
          ordem continua sendo a do texto; o que muda é que cada item ganhou
          um campo. `__sem__` porque o Select recusa value="".
        */}
        {motivosDaCaixa.map((motivo) => {
          const opcoes = [
            ...new Set([
              ...CATEGORIAS_DE_PERDA,
              ...(categorias[motivo] ? [categorias[motivo]] : []),
            ]),
          ];
          return (
            <div key={motivo} className="flex items-center gap-2">
              <span className="w-56 truncate text-xs text-muted-foreground">{motivo}</span>
              <Select
                value={categorias[motivo] ?? "__sem__"}
                onValueChange={(valor) =>
                  setCategorias((atual) => {
                    const proximo = { ...atual };
                    if (valor === "__sem__") delete proximo[motivo];
                    else proximo[motivo] = valor;
                    return proximo;
                  })
                }
              >
                <SelectTrigger className="h-8 w-56 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__sem__">{t("Sem categoria")}</SelectItem>
                  {opcoes.map((categoria) => (
                    <SelectItem key={categoria} value={categoria}>
                      {categoria}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("Motivos de ganho (separados por vírgula)")}</Label>
        <Input value={wonReasonsText} onChange={(e) => setWonReasonsText(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {t(
            "Sem motivos cadastrados o motivo de ganho é texto livre. Com a lista, só o que está nela é aceito.",
          )}
        </p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={wonRequired}
            onChange={(e) => setWonRequired(e.target.checked)}
          />
          {t("Exigir motivo de ganho ao fechar como ganho")}
        </label>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={retomaComoNovo}
            onChange={(e) => setRetomaComoNovo(e.target.checked)}
          />
          {t("Negócio encerrado que volta abre um negócio novo")}
        </label>
        <p className="text-xs text-muted-foreground">
          {t(
            "Desligado, arrastar um negócio perdido ou ganho para uma etapa aberta reabre o mesmo negócio. Ligado, o encerrado fica como está e o quadro oferece criar uma nova tentativa com o mesmo contato.",
          )}
        </p>
      </div>

      {/* ─── A ENTRADA DAS CONVERSAS DO INBOX (#3011) ─────────────────────
          O ajuste existia só no BANCO: a etapa declarada já valia, o fallback
          já era provado — e ninguém conseguia ligar, porque nenhum ponto da
          interface mandava a chave. A doutrina
          (`docs/doctrine/sistema-vivo.md`, invariante 6) pede tela para ver,
          tela para mudar e aviso visível quando falha; a issue #3011 pede a
          escolha na edição do funil.

          A escolha sai daqui no patch de `updatePipelineConfig` — a MESMA porta
          de escrita do resto do settings. A gravação no banco não é reescrita
          aqui: a tela só passa a mandar `entrada_do_inbox`.

          SÓ NO FUNIL QUE O SERVIDOR LÊ: `funilDeEntrada`
          (`lib/leads/nascimento-do-lead.ts`) consulta a chave apenas no funil
          `is_default` e no `is_client_pipeline`. Num funil secundário a escolha
          seria salva e nunca usada, e o aviso diria que as conversas caem numa
          etapa dele, onde elas não entram. Não é `ehFunilPadrao`: ele cai em
          `pipelines[0]` sem padrão, e o servidor ali devolve
          `sem_funil_de_entrada`. */}
      {(pipeline.is_default === true || pipeline.is_client_pipeline === true) && (
      <div className="space-y-1">
        <Label className="text-xs">{t("Novas conversas do Inbox entram em…")}</Label>
        <Select
          value={entradaLigada && entradaEtapaId ? entradaEtapaId : ENTRADA_DO_INBOX_PADRAO}
          onValueChange={(valor) => {
            if (valor === ENTRADA_DO_INBOX_PADRAO) {
              // DESLIGAR NÃO ESQUECE A ETAPA: o identificador fica no estado (e
              // vai no patch), então religar é um clique — não uma escolha nova.
              setEntradaAtiva(false);
              return;
            }
            setEntradaAtiva(true);
            setEntradaEtapaId(valor);
          }}
        >
          <SelectTrigger
            aria-label={t("Etapa de entrada das conversas do Inbox")}
            className="h-8 w-72 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ENTRADA_DO_INBOX_PADRAO}>
              {t("Primeira etapa do funil (padrão)")}
            </SelectItem>
            {/* A etapa declarada que DEIXOU DE VALER continua na lista, marcada.
                Tirá-la da tela apagaria a escolha por baixo de quem a fez — e o
                admin não teria como ver onde ela apontava. Ela some no dia em
                que outra etapa é escolhida. */}
            {etapaForaDaLista && (
              <SelectItem value={etapaDeclarada!}>{nomeDaEtapaPerdida}</SelectItem>
            )}
            {etapasDeEntrada.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t(
            "A conversa nova do Inbox vira card nesta etapa. Sem escolha, ela nasce na primeira etapa do funil — o comportamento de sempre.",
          )}
        </p>
        {/* O AVISO VISÍVEL QUANDO FALHA: a etapa gravada deixou de valer e as
            conversas estão caindo na primeira etapa. O fallback do servidor
            já decide isso (e loga `logger.warn`); o que faltava era quem
            configurou FICAR SABENDO. */}
        {escolhaPerdida && (
          <p role="alert" className="text-xs font-medium text-amber-600 dark:text-amber-400">
            {etapaDeclarada === null
              ? t(
                  "Nenhuma etapa escolhida: as conversas novas estão entrando na primeira etapa do funil.",
                )
              : t(
                  "A etapa escolhida não está mais disponível (arquivada, apagada ou fechada): as conversas novas estão entrando na primeira etapa do funil. Escolha outra para voltar a decidir.",
                )}
          </p>
        )}
      </div>
      )}

      {/* ─── O RECORTE DE ENCERRADOS ANTIGOS (#2995) ──────────────────────
          O quadro traz TODO negócio não arquivado — ganhos e perdas de meses
          atrás inclusive — e num funil com histórico longo ele fica ilegível.
          A opção é POR FUNIL e vem DESLIGADA: quem não ligar continua vendo
          exatamente o que via. O corte é por DATA DE ENCERRAMENTO, e não por
          status: negócio aberto nunca sai (por antigo que seja) e encerrado sem
          data de encerramento fica — a data não existe, e inventá-la tiraria do
          quadro um negócio que ninguém sabe quando fechou. Vale só para o que a
          TELA mostra: nenhum negócio é apagado ou arquivado. */}
      <div className="space-y-1">
        <label className="flex flex-wrap items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={ocultarEncerrados}
            onChange={(e) => setOcultarEncerrados(e.target.checked)}
          />
          {t("Esconder do quadro os negócios encerrados há mais de")}
          <Input
            type="number"
            min={DIAS_MINIMO_DO_RECORTE}
            max={DIAS_MAXIMO_DO_RECORTE}
            aria-label={t("Dias de encerrado para esconder do quadro")}
            className="h-8 w-20 text-xs"
            disabled={!ocultarEncerrados}
            value={diasDosEncerrados}
            onChange={(e) => setDiasDosEncerrados(e.target.value)}
          />
          {t("dias")}
        </label>
        <p className="text-xs text-muted-foreground">
          {t(
            "Negócios abertos nunca são escondidos, e negócios encerrados sem data de encerramento ficam no quadro. Nada é apagado ou arquivado: desligar a opção traz todos de volta.",
          )}
        </p>
      </div>

      {/* ─── A COMANDA DO GANHO (#1477) ───────────────────────────────
          Porta do consumidor de `lead.won`. Desligada por padrão, pela régua
          de `docs/doctrine/extensoes.md`: quem não ativar continua com a
          operação inteira, e em loja com checkout o valor do negócio não é
          conta a receber. Sem o módulo `financeiro` instalado (#1907) não
          há comanda, e o interruptor some; o valor salvo no funil fica como
          está, e o consumidor também confere o módulo. */}
      {comandaDisponivel && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={comandaNoGanho}
              onChange={(e) => setComandaNoGanho(e.target.checked)}
            />
            {t("Abrir comanda ao ganhar um negócio neste funil")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Desligado, ganhar não mexe no financeiro: loja com checkout, infoproduto e imobiliária não vivem de conta a receber. Ligado, o arrasto para a etapa de ganho e o botão Ganhar abrem uma comanda com o valor e o contato do negócio.",
            )}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-xs">{t("Campos do lead neste funil")}</Label>
        <p className="text-xs text-muted-foreground">
          {t("Aparecem no dossiê do negócio. No follow-up, você escolhe em qual campo gravar a resposta.")}
        </p>
        {/* `lg:` e não `md:` (#3099): com a barra lateral aberta, a 768px sobram ~380px
            para a linha, e a coluna de 13rem deixava Chave e Rótulo com 46px. Abaixo de
            1024px os campos empilham, como no celular. Os `col-span-4` dos blocos de
            dentro seguem o MESMO corte: um `md:col-span-4` sozinho cria quatro colunas
            implícitas e devolve a linha espremida, mesmo sem o template. */}
        {fields.map((f, i) => (
          <div key={`${f.key}-${i}`} className="grid gap-2 rounded-md border border-border p-2 lg:grid-cols-[1fr_1fr_13rem_auto]">
            <Input
              aria-label={`${t("Chave do campo")} ${i + 1}`}
              placeholder={t("chave (endereco)")}
              value={f.key}
              onChange={(e) => {
                const next = [...fields];
                next[i] = { ...f, key: e.target.value };
                setFields(next);
              }}
            />
            <Input
              aria-label={`${t("Rótulo do campo")} ${i + 1}`}
              placeholder={t("Rótulo (Endereço)")}
              value={f.label}
              onChange={(e) => {
                const next = [...fields];
                next[i] = { ...f, label: e.target.value };
                setFields(next);
              }}
            />
            <Select
              value={f.type}
              onValueChange={(type) => {
                const next = [...fields];
                next[i] = { ...f, type: type as CustomFieldDef["type"] };
                setFields(next);
              }}
            >
              <SelectTrigger
                aria-label={`${t("Tipo do campo")} ${i + 1}`}
                title={rotuloDoTipo(f.type, t, moeda)}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIPOS_DE_CAMPO.map((tipo) => (
                  <SelectItem key={tipo} value={tipo}>
                    {rotuloDoTipo(tipo, t, moeda)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${t("Remover campo")} ${f.label || i + 1}`}
              onClick={() => setFields(fields.filter((_, j) => j !== i))}
            >
              <Trash size={14} aria-hidden />
            </Button>
            {tipoTemOpcoes(f.type) && (
              <OpcoesDaLista
                campo={f}
                indice={i}
                csv={csvDeOpcoes[f.key] ?? ""}
                aoMudarCsv={(texto) => setCsvDeOpcoes((atual) => ({ ...atual, [f.key]: texto }))}
                aoMudarOpcoes={(options) => {
                  const next = [...fields];
                  next[i] = { ...f, options };
                  setFields(next);
                }}
              />
            )}
            {/* ── LISTA PESQUISÁVEL (#2521) ────────────────────────────────
                A válvula "permitir valor novo" e, logo abaixo, o RESUMO com a
                lista recolhida. A caixa de importação CSV e a leitura das
                opções moraram aqui até o #3176 e agora vivem DENTRO do bloco
                recolhido: o que a tela monta antes de a pessoa pedir é o
                resumo, nunca as opções. */}
            {f.type === "searchable_select" && (
              <div className="space-y-1 lg:col-span-4">
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`${t("Permitir valor novo")} ${i + 1}`}
                    checked={f.allow_new === true}
                    onChange={(ev) => {
                      const next = [...fields];
                      next[i] = { ...f, allow_new: ev.target.checked };
                      setFields(next);
                    }}
                  />
                  {t("Permitir valor novo (fora da lista)")}
                </label>
                {/* ── MÚLTIPLA ESCOLHA (#3182) ────────────────────────────────
                    O modo múltiplo da lista pesquisável: o campo grava uma
                    LISTA de valores canônicos e a ficha mostra os escolhidos
                    como chips. Sem esta tela a chave nasceria no schema e
                    ninguém conseguiria ligá-la (#1536 foi o mesmo defeito, com
                    o `obrigatorio_em`). Desmarcar APAGA a chave: o funil que
                    ninguém tocou continua idêntico ao de antes. */}
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`${t("Permitir várias escolhas")} ${i + 1}`}
                    checked={f.multiple === true}
                    onChange={(ev) => {
                      const next = [...fields];
                      // `false` some da definição: desmarcar não deixa uma
                      // chave morta no settings — vale para o valor único
                      // gravado por TODO funil que existe hoje.
                      const { multiple: _apagado, ...semMultiplo } = f;
                      next[i] = ev.target.checked
                        ? { ...f, multiple: true }
                        : (semMultiplo as CustomFieldDef);
                      setFields(next);
                    }}
                  />
                  {t("Permitir várias escolhas")}
                </label>
              </div>
            )}
            {/* ── QUANDO ESTE CAMPO OBRIGA (issue #1536) ────────────────────
                O `obrigatorio_em` nasceu no schema sem nenhuma tela: quem
                operava não conseguia ligar a régua principal do PR. As três
                marcas são as que `campoExigidoNoDestino` lê — etapas de
                entrada, `ao_ganhar` e `ao_perder` — e nada mais, para a tela
                não prometer gatilho que o servidor não pergunta. */}
            <div className="space-y-1 lg:col-span-4">
              <p className="text-xs font-medium">{t("Exigir o preenchimento:")}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {etapas.map((e) => (
                  <label key={e.id} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      aria-label={`${t("Exigir em")} ${e.name} — ${f.label || i + 1}`}
                      checked={f.obrigatorio_em?.etapas?.includes(e.id) ?? false}
                      onChange={(ev) => {
                        const next = [...fields];
                        next[i] = {
                          ...f,
                          obrigatorio_em: comEtapa(f.obrigatorio_em, e.id, ev.target.checked),
                        };
                        setFields(next);
                      }}
                    />
                    {e.name}
                    {e.is_archived ? ` (${t("arquivada")})` : ""}
                  </label>
                ))}
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    aria-label={`${t("Ao ganhar")} — ${f.label || i + 1}`}
                    checked={f.obrigatorio_em?.ao_ganhar === true}
                    onChange={(ev) => {
                      const next = [...fields];
                      next[i] = {
                        ...f,
                        obrigatorio_em: comGatilho(f.obrigatorio_em, "ao_ganhar", ev.target.checked),
                      };
                      setFields(next);
                    }}
                  />
                  {t("Ao ganhar")}
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    aria-label={`${t("Ao perder")} — ${f.label || i + 1}`}
                    checked={f.obrigatorio_em?.ao_perder === true}
                    onChange={(ev) => {
                      const next = [...fields];
                      next[i] = {
                        ...f,
                        obrigatorio_em: comGatilho(f.obrigatorio_em, "ao_perder", ev.target.checked),
                      };
                      setFields(next);
                    }}
                  />
                  {t("Ao perder")}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Sem marca nenhuma este campo nunca é exigido — é o comportamento de sempre. Marcado, ele precisa estar preenchido para o negócio entrar na etapa escolhida ou ser fechado como ganho/perdido.",
                )}
              </p>
            </div>
            {/* ── QUANDO ESTE CAMPO APARECE (issue #2728) ──────────────────
                A condição que a ficha do contato, o dossiê e o painel do inbox
                leem para ESCONDER o campo. Campo + operador + valor, e os
                operadores são exatamente os três que `campoVisivel` aplica —
                a tela não promete nenhum outro. Meio montada, a condição não
                grava (ver `normalizaMostrarQuando`), como `obrigatorio_em`. */}
            <div className="space-y-1 lg:col-span-4">
              <p className="text-xs font-medium">{t("Mostrar só quando:")}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Select
                  value={f.mostrar_quando?.campo || SEM_CONDICAO}
                  onValueChange={(campo) => {
                    const next = [...fields];
                    next[i] = {
                      ...f,
                      mostrar_quando:
                        campo === SEM_CONDICAO
                          ? undefined
                          : escreveMostrarQuando(f.mostrar_quando, { campo }),
                    };
                    setFields(next);
                  }}
                >
                  <SelectTrigger aria-label={`${t("Campo da condição")} ${f.label || i + 1}`}>
                    <SelectValue placeholder={t("Sempre mostrar")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SEM_CONDICAO}>{t("Sempre mostrar")}</SelectItem>
                    {fields
                      .filter((outra, j) => j !== i && outra.key.trim().length > 0)
                      .map((outra) => (
                        <SelectItem key={outra.key} value={outra.key}>
                          {outra.label || outra.key}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {f.mostrar_quando?.campo && (
                  <>
                    <Select
                      value={operadorDaCondicao(f.mostrar_quando)}
                      onValueChange={(op) => {
                        const next = [...fields];
                        next[i] = {
                          ...f,
                          mostrar_quando: escreveMostrarQuando(f.mostrar_quando, {
                            operador: op as OperadorDeMostra,
                          }),
                        };
                        setFields(next);
                      }}
                    >
                      <SelectTrigger
                        aria-label={`${t("Operador da condição")} ${f.label || i + 1}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="igual">{t("é igual a")}</SelectItem>
                        <SelectItem value="contem">{t("contém")}</SelectItem>
                        <SelectItem value="maior_que">{t("é maior que")}</SelectItem>
                      </SelectContent>
                    </Select>
                    {/* O valor vem de lista quando o campo que MANDA na condição
                        é de lista fechada: digitar "Outro" errado deixaria a
                        condição montada e quieta, casando com nada. */}
                    {tipoTemOpcoes(
                      fields.find((o) => o.key === f.mostrar_quando?.campo)?.type ?? "text",
                    ) ? (
                      <Select
                        value={valorDaCondicao(f.mostrar_quando) || SEM_VALOR_DA_CONDICAO}
                        onValueChange={(valor) => {
                          const next = [...fields];
                          next[i] = {
                            ...f,
                            mostrar_quando: escreveMostrarQuando(f.mostrar_quando, { valor }),
                          };
                          setFields(next);
                        }}
                      >
                        <SelectTrigger
                          aria-label={`${t("Valor da condição")} ${f.label || i + 1}`}
                        >
                          <SelectValue placeholder={t("Valor da condição")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SEM_VALOR_DA_CONDICAO}>
                            {t("Valor da condição")}
                          </SelectItem>
                          {fields
                            .find((o) => o.key === f.mostrar_quando?.campo)
                            ?.options?.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        className="w-40"
                        aria-label={`${t("Valor da condição")} ${f.label || i + 1}`}
                        value={valorDaCondicao(f.mostrar_quando)}
                        onChange={(ev) => {
                          const next = [...fields];
                          next[i] = {
                            ...f,
                            mostrar_quando: escreveMostrarQuando(f.mostrar_quando, {
                              valor: ev.target.value,
                            }),
                          };
                          setFields(next);
                        }}
                      />
                    )}
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Escondido, o campo não aparece no formulário nem é validado como obrigatório, e o valor já gravado continua no registro.",
                )}
              </p>
            </div>
            {/* ── A QUE PERTENCE O CAMPO (issue #2791) ──────────────────────
                `negocio` (padrão) é o campo como ele sempre foi: aparece no
                card e no dossiê do negócio, gravado em `crm_leads.custom_fields`.
                `contato` tira o campo do card e o leva para a ficha do contato,
                cujo valor mora em `contacts.custom_fields`. A chave só é
                gravada quando vale `contato` — um funil sem ela continua
                idêntico ao de antes. */}
            {/* Fora do funil padrão o seletor só aparece para DESFAZER uma marca
                "Contato" que já exista (gravada quando este era o padrão). */}
            {(ehFunilPadrao || escopoDoCampo(f) === "contato") && (
              <div className="flex flex-wrap items-center gap-3 lg:col-span-4">
                <span className="text-xs font-medium">{t("Este campo pertence a:")}</span>
                <Select
                  value={escopoDoCampo(f)}
                  onValueChange={(escopo) => {
                    const next = [...fields];
                    const copia = { ...next[i] } as CustomFieldDef;
                    if (escopo === "contato") copia.escopo = "contato";
                    else delete (copia as { escopo?: unknown }).escopo;
                    next[i] = copia;
                    setFields(next);
                  }}
                >
                  <SelectTrigger
                    aria-label={`${t("Escopo do campo")} ${i + 1}`}
                    className="h-8 w-40 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="negocio">{t("Negócio")}</SelectItem>
                    <SelectItem value="contato">{t("Contato")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        ))}
        {/* A cota é do NEGÓCIO (issue #3111): o campo do contato não esconde o botão. */}
        {fields.filter((f) => escopoDoCampo(f) === "negocio").length < MAX_CAMPOS_DO_NEGOCIO && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setFields([
                ...fields,
                { key: `campo_${fields.length + 1}`, label: t("Novo campo"), type: "text" },
              ])
            }
          >
            <Plus size={14} aria-hidden className="mr-1" /> {t("Adicionar campo")}
          </Button>
        )}
      </div>

      <div className="flex sm:justify-end">
        <Button onClick={handleSave} disabled={isPending} className="w-full sm:w-auto">
          {isPending ? t("Salvando…") : t("Salvar vocabulário e campos")}
        </Button>
      </div>
    </div>
  );
}
