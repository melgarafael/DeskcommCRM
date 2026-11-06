"use client";
import { useEffect, useId, useState } from "react";
/**
 * CustomFieldsEditor — lê `crm_pipelines.settings.fields[]` e renderiza o
 * input certo por tipo. Usado pelo dossiê e pelo painel do inbox, via
 * `LeadFieldsForm`, e pela ficha do contato (`EditContactDialog`) — é o
 * renderizador ÚNICO dos campos personalizados.
 *
 * Por isso o filtro de `mostrar_quando` (issue #2728) mora AQUI: um ponto só
 * cobre os quatro que renderizam, e o dia em que alguém desenhar as
 * definições por conta própria reprova
 * `tests/unit/campo-condicional-nos-pontos-de-renderizacao.test.ts`.
 */
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { exemploDoCampoDeMoeda, lerCampoDeMoeda, semAMoeda, valorDoCampoDeMoeda } from "@/lib/leads/campo-de-moeda";
import { MOEDA_PADRAO } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { buscarOpcoes, valorCanonico } from "@/lib/leads/campos-pesquisaveis";
import { cn } from "@/lib/utils";
import { camposVisiveis, type MostrarQuando } from "@/lib/schemas/mostrar-quando";
import { mensagemDoCampo } from "@/lib/leads/padrao-do-campo";

import { FileUploadCustomField } from "@/components/kanban/FileUploadCustomField";

export type CustomFieldType =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "date"
  | "select"
  | "multiselect"
  | "searchable_select"
  | "boolean"
  | "email"
  | "phone"
  | "url"
  | "file";

export interface CustomFieldDef {
  key: string;
  label: string;
  type: CustomFieldType;
  required?: boolean;
  options?: Array<{ value: string; label: string; aliases?: string[] }>;
  /**
   * A condição de exibição (issue #2728) — `lib/schemas/mostrar-quando.ts`.
   *
   * Quem decide se o campo aparece é ESTE componente, olhando os valores que
   * ele mesmo está renderizando. Esconder é filtrar a lista: `value` não é
   * mexido, então o que já estava gravado continua dentro do estado do editor
   * e viaja no save — esconder não é limpar.
   */
  mostrar_quando?: MostrarQuando;
  /** O FORMATO do valor (#2730) — ver `lib/leads/padrao-do-campo`. */
  padrao?: string;
  /** A frase do dono para quem digitar fora do formato (#2730). */
  mensagem_padrao?: string;
  /** Só no `searchable_select`: aceita valor fora da lista (issue #2521). */
  allow_new?: boolean;
  /**
   * Só no `searchable_select`: guarda VÁRIOS valores canônicos, em vez de um
   * (issue #3182). O registro vira uma lista e os escolhidos aparecem como
   * chips — assim o negócio "forfait" registra o aéreo da consolidadora A junto
   * do hotel da operadora B, sem o despejo da lista inteira de opções que
   * tornava o `multiselect` inviável com listas longas.
   */
  multiple?: boolean;
}

interface Props {
  fields: CustomFieldDef[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  mode: "lead" | "contact";
  disabled?: boolean;
  className?: string;
  leadId?: string;
}

export function CustomFieldsEditor({ fields, value, onChange, mode, disabled, className, leadId }: Props) {
  const t = useT();
  const [rascunhosDeMoeda, setRascunhosDeMoeda] = useState<Record<string, string>>({});
  // O rascunho do `searchable_select`: enquanto a pessoa digita, o input mostra
  // o TEXTO buscado; o valor gravado no lead é o `value` canônico, resolvido no
  // blur (issue #2521). Sem o rascunho, editar apagaria a opção a cada tecla.
  const [rascunhosDeBusca, setRascunhosDeBusca] = useState<Record<string, string>>({});
  // Os campos cujo último blur RECUSOU o texto (fora da lista, sem `allow_new`).
  // Sem o aviso, o input só voltava ao valor anterior e a pessoa não sabia por quê.
  const [recusados, setRecusados] = useState<Record<string, true>>({});
  // A lista aberta do `searchable_select` e a opção destacada nela. Um campo
  // por vez, porque só um tem o foco. `-1` = nada destacado: sair do campo
  // sem ter escolhido não grava palpite. Só as SETAS mexem no destaque: o
  // mouse sobre uma opção é realce visual (`hover:`), não escolha. Quando o
  // `onMouseEnter` destacava, clicar no campo e sair com Tab gravava a opção
  // que estava sob o ponteiro parado (prova pela tela, 17/10). Pela mesma
  // razão, Enter com o mouse sobre uma opção e sem seta não grava nada.
  const [buscaAberta, setBuscaAberta] = useState<string | null>(null);
  const [destacado, setDestacado] = useState(-1);
  const baseId = useId();
  // A lista é `absolute` e abre para baixo, dentro de containers que rolam
  // (dossiê, diálogo Editar contato): perto do fim, ela nascia fora da área
  // visível, e a opção destacada pelas setas também — Enter gravava o que não
  // se via. Traz a lista à vista ao abrir e a cada tecla, e a opção destacada
  // quando ela muda. `nearest` não mexe em nada que já está visível.
  useEffect(() => {
    if (buscaAberta === null) return;
    const lista = document.getElementById(`${baseId}-${buscaAberta}-opcoes`);
    lista?.scrollIntoView?.({ block: "nearest" });
    if (destacado >= 0) {
      document
        .getElementById(`${baseId}-${buscaAberta}-opcoes-${destacado}`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [baseId, buscaAberta, destacado, rascunhosDeBusca]);
  // O campo é do mesmo caminho do contato: o exemplo segue o país da
  // organização, e não o DDI brasileiro em duro.
  const org = useActiveOrg();
  const telefoneExemplo = perfilDoPais(org?.country).telefoneExemplo;
  // O campo de moeda na moeda da organização (`lib/leads/campo-de-moeda.ts`).
  const moedaDoCampo = org?.currency ?? MOEDA_PADRAO;
  function set(key: string, v: unknown) {
    onChange({ ...value, [key]: v });
  }

  function gravarMoeda(key: string) {
    const draft = rascunhosDeMoeda[key];
    if (draft === undefined) return;
    const raw = semAMoeda(draft, moedaDoCampo);
    const centavos = raw === "" ? null : lerCampoDeMoeda(raw, moedaDoCampo);
    if (centavos !== null) set(key, centavos / 100);
    else if (raw === "") set(key, null);
    setRascunhosDeMoeda((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  /**
   * Os campos que ESTA vez aparecem — o filtro da condição (issue #2728).
   *
   * O filtro é sobre a LISTA, nunca sobre `value`: o que já estava gravado
   * continua dentro do objeto e viaja no save, e o campo volta à tela no
   * instante em que a condição cumpre. Esconder não é limpar.
   */
  const visiveis = camposVisiveis(fields, value);

  return (
    <div className={cn("grid grid-cols-1 gap-4 md:grid-cols-2", className)}>
      {visiveis.map((f) => {
        const v = value[f.key];
        const id = `cf-${f.key}`;

        // ── O PADRÃO DO CAMPO (#2730) ──────────────────────────────────────
        //
        // A MESMA régua da API (`422`) e da gravação pela IA (erro de ensino),
        // decidida em `lib/leads/padrao-do-campo`. Sem `padrao` o veredito é
        // sempre `ok`: o campo livre continua livre e nada abaixo aparece —
        // a régua nova só enxerga quem a configurou.
        //
        // A frase é a DO CAMPO (`mensagem_padrao`), não uma genérica: quem
        // digita "dois" em "Idades das crianças" vê a instrução do dono do
        // funil. Só quando não há instrução é que a genérica (ou a de
        // CONFIGURAÇÃO quebrada, quando o regex nem compila) entra no lugar.
        //
        // Ela fica entre o rótulo e o input — o mesmo lugar do padrão GOV.UK,
        // onde a mensagem de erro pertence ao rótulo e não ao fim do bloco: em
        // `md:grid-cols-2` um elemento irmão DEPOIS do input cairia na célula
        // do campo vizinho.
        const textoDoErro = mensagemDoCampo(f, v, t);

        const labelEl = (
          <>
            <Label htmlFor={id}>
              {f.label}
              {f.required && <span className="ml-1 text-error-fg">*</span>}
            </Label>
            {textoDoErro && (
              <p id={`${id}-erro`} role="alert" className="text-sm text-error-fg">
                {textoDoErro}
              </p>
            )}
          </>
        );

        switch (f.type) {
          case "textarea":
            return (
              <div key={f.key} className="space-y-2 md:col-span-2">
                {labelEl}
                <Textarea
                  id={id}
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "number":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="number"
                  value={typeof v === "number" ? v : ""}
                  onChange={(e) =>
                    set(f.key, e.target.value === "" ? null : Number(e.target.value))
                  }
                  disabled={disabled}
                />
              </div>
            );
          case "currency": {
            const valorNumerico = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : null;
            const formatado =
              valorNumerico !== null && Number.isFinite(valorNumerico)
                ? valorDoCampoDeMoeda(valorNumerico, moedaDoCampo)
                : "";
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="text"
                  inputMode="decimal"
                  value={rascunhosDeMoeda[f.key] ?? formatado}
                  onChange={(e) => setRascunhosDeMoeda((current) => ({ ...current, [f.key]: e.target.value }))}
                  onBlur={() => gravarMoeda(f.key)}
                  onKeyDown={(e) => {
                    // Enter envia o formulário sem tirar o foco. Entrega o
                    // rascunho antes do submit, usando a mesma leitura do blur.
                    if (e.key === "Enter") gravarMoeda(f.key);
                  }}
                  disabled={disabled}
                  placeholder={exemploDoCampoDeMoeda(moedaDoCampo)}
                />
              </div>
            );
          }
          case "date":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="date"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "select":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Select
                  value={typeof v === "string" ? v : ""}
                  onValueChange={(val) => set(f.key, val)}
                  disabled={disabled}
                >
                  <SelectTrigger id={id}>
                    <SelectValue placeholder={t("Selecione…")} />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options?.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          case "multiselect": {
            const current = Array.isArray(v) ? (v as string[]) : [];
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <div className="flex flex-col gap-1">
                  {f.options?.map((o) => {
                    const checked = current.includes(o.value);
                    return (
                      <label key={o.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...current, o.value]
                              : current.filter((x) => x !== o.value);
                            set(f.key, next);
                          }}
                          disabled={disabled}
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          }
          case "searchable_select": {
            // LISTA PESQUISÁVEL (#2521): um input com autocompletar sobre as
            // opções. Grava o `value` CANÔNICO da opção escolhida ("maceio" →
            // "maceio-al"), nunca a grafia digitada — é o que faz o filtro e o
            // relatório de "Maceió" voltarem a bater. `allow_new` deixa passar
            // um valor novo, aparado, quando o funil o permite.
            const opcoes = f.options ?? [];
            // O MODO MÚLTIPLO da lista pesquisável (#3182): o registro é uma
            // LISTA de `value` canônicos e o que já foi escolhido aparece em
            // CHIPS, um por opção. No valor único o registro continua a string
            // de sempre, e nada abaixo muda de comportamento.
            const multiplo = f.multiple === true;
            // Um valor único já gravado (o campo virou múltiplo depois, ou o
            // diálogo de campos exigidos gravou uma escolha só) é uma lista de
            // UM — a mesma leitura de `validarValorPesquisavel`. Sem isso o
            // valor some da ficha e a próxima escolha o sobrescreve.
            const escolhidos = !multiplo
              ? []
              : Array.isArray(v)
                ? (v as unknown[]).filter((x): x is string => typeof x === "string")
                : typeof v === "string" && v.trim() !== ""
                  ? [v]
                  : [];
            const canonico = !multiplo && typeof v === "string" ? v : "";
            const rotuloAtual = opcoes.find((o) => o.value === canonico)?.label ?? canonico;
            const rotuloDe = (valor: string) => opcoes.find((o) => o.value === valor)?.label ?? valor;
            const rascunho = rascunhosDeBusca[f.key];
            const listaId = `${baseId}-${f.key}-opcoes`;
            // A lista é NOSSA, não um `<datalist>`: o navegador refiltra o
            // datalist pelo rótulo e leva acento em conta, e "sao paulo" ou
            // "mcz" não mostravam nada, embora `buscarOpcoes` achasse a opção.
            const resultados = buscarOpcoes(opcoes, rascunho ?? "");
            const aberta = buscaAberta === f.key && resultados.length > 0;
            const limparRascunho = () =>
              setRascunhosDeBusca(({ [f.key]: _limpo, ...resto }) => resto);
            const fechar = () => {
              setBuscaAberta(null);
              setDestacado(-1);
            };
            // O REGISTRO de uma escolha: no valor único a string; no múltiplo a
            // lista com o novo item no fim. Escolher de novo uma opção que já
            // está lá é a MESMA escolha — o chip não duplica.
            const gravar = (valor: string) => {
              if (!multiplo) {
                set(f.key, valor);
                return;
              }
              set(f.key, escolhidos.includes(valor) ? escolhidos : [...escolhidos, valor]);
            };
            const escolher = (valor: string) => {
              gravar(valor);
              limparRascunho();
              setRecusados(({ [f.key]: _limpo, ...resto }) => resto);
              fechar();
            };
            // Sem escolha explícita, o texto digitado vale se casar exatamente
            // (ou se o campo aceita valor novo). Mesma régua no blur e no Enter.
            const resolverRascunho = () => {
              fechar();
              if (rascunho === undefined) return;
              const achado = valorCanonico(opcoes, rascunho);
              if (achado !== null) gravar(achado);
              // Num campo múltiplo o rascunho vazio não é escrita: os chips já
              // escolhidos são o registro, e limpar o texto do input não os apaga.
              else if (rascunho.trim() === "") {
                if (!multiplo) set(f.key, "");
              } else if (f.allow_new === true) gravar(rascunho.trim());
              // Sem casar e sem `allow_new`, o valor não é gravado: o
              // input volta ao que estava, e o aviso abaixo explica.
              else setRecusados((current) => ({ ...current, [f.key]: true }));
              limparRascunho();
            };
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                {/* OS CHIPS (#3182): o que já foi escolhido, um por opção, com
                    o rótulo da lista e um botão para tirar. É o que substitui o
                    despejo da lista INTEIRA de opções na ficha — com 200
                    fornecedores, o registro ocupa o espaço do que foi escolhido,
                    não o da lista. */}
                {multiplo && escolhidos.length > 0 && (
                  <ul className="flex flex-wrap gap-1" aria-label={t("Escolhidos")}>
                    {escolhidos.map((valor) => {
                      const rotulo = rotuloDe(valor);
                      return (
                        <li
                          key={valor}
                          className="flex items-center gap-1 rounded-sm border border-border bg-surface px-2 py-0.5 text-xs"
                        >
                          {rotulo}
                          <button
                            type="button"
                            aria-label={`${t("Remover")} ${rotulo}`}
                            className="text-text-muted hover:text-error-fg"
                            onClick={() => set(f.key, escolhidos.filter((x) => x !== valor))}
                            disabled={disabled}
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="relative">
                  <Input
                    id={id}
                    type="text"
                    role="combobox"
                    aria-expanded={aberta}
                    aria-controls={listaId}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      aberta && destacado >= 0 ? `${listaId}-${destacado}` : undefined
                    }
                    autoComplete="off"
                    placeholder={
                      multiplo ? t("Digite para buscar e acrescentar…") : t("Digite para buscar…")
                    }
                    value={rascunho ?? (multiplo ? "" : rotuloAtual)}
                    onFocus={() => {
                      setBuscaAberta(f.key);
                      setDestacado(-1);
                    }}
                    onChange={(e) => {
                      setRascunhosDeBusca((current) => ({ ...current, [f.key]: e.target.value }));
                      setRecusados(({ [f.key]: _limpo, ...resto }) => resto);
                      setBuscaAberta(f.key);
                      setDestacado(-1);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        if (!aberta) setBuscaAberta(f.key);
                        else setDestacado((i) => Math.min(i + 1, resultados.length - 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setDestacado((i) => Math.max(i - 1, 0));
                      } else if (e.key === "Enter") {
                        // Com a lista aberta (ou texto ainda não resolvido), o
                        // Enter é do CAMPO, nunca do formulário: sem o
                        // preventDefault ele caía na submissão implícita do
                        // <form> de Editar contato e do dossiê, que salvava o
                        // valor VELHO e jogava fora o digitado (prova pela
                        // tela, 17/10). Lista fechada e nada pendente: o Enter
                        // segue para o formulário, como em qualquer input.
                        if (!aberta && rascunho === undefined) return;
                        e.preventDefault();
                        const alvo = aberta ? resultados[destacado] : undefined;
                        if (alvo) escolher(alvo.value);
                        else resolverRascunho();
                      } else if (e.key === "Escape") {
                        fechar();
                      }
                    }}
                    onBlur={() => {
                      // Destacar com as setas e sair com Tab é escolha explícita.
                      const alvo = aberta ? resultados[destacado] : undefined;
                      if (alvo) {
                        escolher(alvo.value);
                        return;
                      }
                      resolverRascunho();
                    }}
                    disabled={disabled}
                  />
                  {aberta && (
                    <ul
                      id={listaId}
                      role="listbox"
                      className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-surface shadow-md"
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      {resultados.map((o, i) => (
                        <li
                          key={o.value}
                          id={`${listaId}-${i}`}
                          role="option"
                          aria-selected={i === destacado}
                          className={cn(
                            "flex min-h-11 cursor-pointer items-center px-3 py-2 text-sm",
                            i === destacado
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-accent/50",
                          )}
                          onClick={() => escolher(o.value)}
                        >
                          {o.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {recusados[f.key] && (
                  <p className="text-xs text-destructive">
                    {t("Esse valor não está na lista. Escolha uma das opções.")}
                  </p>
                )}
                {f.allow_new === true && (
                  <p className="text-xs text-muted-foreground">
                    {t("Este campo aceita um valor novo, fora da lista.")}
                  </p>
                )}
              </div>
            );
          }
          case "boolean":
            return (
              <div key={f.key} className="flex items-center justify-between gap-4 md:col-span-2">
                {labelEl}
                <Switch
                  id={id}
                  checked={Boolean(v)}
                  onCheckedChange={(c) => set(f.key, c)}
                  disabled={disabled}
                />
              </div>
            );
          case "email":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="email"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "phone":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="tel"
                  placeholder={telefoneExemplo}
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
                <p className="text-xs text-muted-foreground">{t("Formato E.164")}</p>
              </div>
            );
          case "file":
            // O anexo é do NEGÓCIO (`crm_lead_attachments.lead_id`): na ficha do
            // contato não há negócio para pendurar o arquivo, então não há upload.
            if (mode === "contact" || !leadId) {
              return (
                <div key={f.key} className="space-y-1">
                  <Label className="text-xs">{f.label}</Label>
                  <p className="text-xs text-muted-foreground">{t("Os anexos ficam no negócio.")}</p>
                </div>
              );
            }
            // Sem `onChange`: a lista mora em `crm_lead_attachments`, nunca em `custom_fields`.
            return (
              <FileUploadCustomField
                key={f.key}
                fieldKey={f.key}
                label={f.label}
                required={f.required}
                leadId={leadId}
                disabled={disabled}
              />
            );
          case "url":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="url"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "text":
          default:
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="text"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
        }
      })}
    </div>
  );
}
