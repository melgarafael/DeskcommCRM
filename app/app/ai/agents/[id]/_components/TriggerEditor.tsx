"use client";
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { FUSO_PADRAO } from "@/lib/tempo/fusos";

export interface BusinessHoursValue {
  timezone: string;
  start: string;
  end: string;
  weekdays: number[];
  /**
   * Aviso de fora do horário (#1926) — texto fixo enviado NA HORA quando o
   * cliente escreve fora da janela, uma vez por contato por período fechado.
   * Ausente/vazio = sem aviso (comportamento de antes).
   */
  notice?: string | null;
}

export interface TriggerValue {
  events: ("message")[];
  filters: {
    ignore_groups: boolean;
    ignore_self: boolean;
    keyword_regex: string | null;
    business_hours: BusinessHoursValue | null;
    /**
     * PÚBLICO do agente (#3722). `include_` = só atende quem cumpre;
     * `exclude_` = não atende quem cumpre, e a exclusão vence. Opcionais na
     * INTERFACE porque draft salvo antes desta entrega não tem as chaves — a
     * tela lê com `?? []` e quem grava é o Zod (`lib/ai/agents/validation.ts`),
     * que preenche as quatro.
     */
    include_tags?: string[];
    exclude_tags?: string[];
    include_pipeline_ids?: string[];
    exclude_pipeline_ids?: string[];
  };
  concurrency: "one_per_conversation" | "one_per_contact";
}

interface Props {
  value: TriggerValue;
  onChange: (v: TriggerValue) => void;
  disabled?: boolean;
  organizationTimezone?: string;
  /**
   * Os funis da organização, para o público escolher por FUNIL. Vem por prop
   * pelo mesmo motivo da marcação de escopo (já é server component na página):
   * lista vazia no primeiro render diria "nenhum funil" por engano.
   */
  funis?: readonly { id: string; name: string }[];
}

/** Etiquetas digitadas como lista: separa por vírgula, tira vazio e repetida. */
function listaDeEtiquetas(texto: string): string[] {
  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const crua of texto.split(",")) {
    const nome = crua.trim();
    if (nome === "") continue;
    const chave = nome.toLowerCase();
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    saida.push(nome);
  }
  return saida;
}

/**
 * Campo de etiquetas separadas por vírgula. O TEXTO digitado mora aqui, e a
 * lista sai para o pai a cada tecla: se o campo exibisse a lista já limpa, a
 * vírgula e o espaço do fim sumiriam no meio da digitação e "cliente ativo,
 * contrato" viraria "clienteativocontrato".
 */
function CampoDeEtiquetas({
  id,
  valor,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  valor: readonly string[];
  onChange: (lista: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [texto, setTexto] = React.useState(() => valor.join(", "));
  // O pai pode trocar a lista por fora (o "Descartar alterações" volta ao
  // salvo): se o texto já não descreve `valor`, a tela mostra `valor`, senão
  // ela exibiria o digitado enquanto o salvar grava outra coisa.
  const exibido =
    JSON.stringify(listaDeEtiquetas(texto)) === JSON.stringify(valor)
      ? texto
      : valor.join(", ");
  return (
    <Input
      id={id}
      value={exibido}
      onChange={(e) => {
        setTexto(e.target.value);
        onChange(listaDeEtiquetas(e.target.value));
      }}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
    />
  );
}

/**
 * Lista de funis com caixa de seleção — o "só estes" / "não estes" do público
 * (#3722). Sem `t()` aqui de propósito: os rótulos chegam já traduzidos de quem
 * chama, e o nome do funil é DADO do operador (não se traduz).
 */
function ListaDeFunis({
  id,
  rotulo,
  ajuda,
  funis,
  selecionados,
  onChange,
  disabled,
}: {
  id: string;
  rotulo: string;
  ajuda: string;
  funis?: readonly { id: string; name: string }[];
  selecionados: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  if (!funis || funis.length === 0) return null;
  const marcados = new Set(selecionados);
  return (
    <div className="space-y-1" id={id}>
      <Label>{rotulo}</Label>
      <div className="flex flex-wrap gap-2">
        {funis.map((f) => {
          const marcado = marcados.has(f.id);
          return (
            <label
              key={f.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-2 py-1 text-xs"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={marcado}
                disabled={disabled}
                aria-label={f.name}
                onChange={() =>
                  onChange(
                    marcado ? selecionados.filter((x) => x !== f.id) : [...selecionados, f.id],
                  )
                }
              />
              {f.name}
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{ajuda}</p>
    </div>
  );
}

const WEEKDAYS = [
  { id: 0, label: "Dom" },
  { id: 1, label: "Seg" },
  { id: 2, label: "Ter" },
  { id: 3, label: "Qua" },
  { id: 4, label: "Qui" },
  { id: 5, label: "Sex" },
  { id: 6, label: "Sáb" },
];

export function TriggerEditor({ value, onChange, disabled, organizationTimezone, funis }: Props) {
  const t = useT();
  const defaultTimezone = organizationTimezone ?? FUSO_PADRAO;

  function patchFilters(p: Partial<TriggerValue["filters"]>) {
    onChange({ ...value, filters: { ...value.filters, ...p } });
  }

  const bh = value.filters.business_hours;

  function setBhEnabled(enabled: boolean) {
    patchFilters({
      business_hours: enabled
        ? bh ?? {
            timezone: defaultTimezone,
            start: "08:00",
            end: "20:00",
            weekdays: [1, 2, 3, 4, 5],
          }
        : null,
    });
  }

  function patchBh(p: Partial<BusinessHoursValue>) {
    if (!bh) return;
    patchFilters({ business_hours: { ...bh, ...p } });
  }

  function toggleWeekday(d: number) {
    if (!bh) return;
    const has = bh.weekdays.includes(d);
    const next = has ? bh.weekdays.filter((x) => x !== d) : [...bh.weekdays, d].sort();
    patchBh({ weekdays: next });
  }

  return (
    <div className="space-y-4">
      <div>
        <Label>{t("O que faz ele responder")}</Label>
        <div className="mt-1 flex flex-wrap gap-2">
          {(["message"] as const).map((ev) => {
            const checked = value.events.includes(ev);
            return (
              <label
                key={ev}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-2 py-1 text-xs"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={checked}
                  onChange={() =>
                    onChange({
                      ...value,
                      events: checked
                        ? (value.events.filter((e) => e !== ev) as TriggerValue["events"])
                        : ([...value.events, ev] as TriggerValue["events"]),
                    })
                  }
                  disabled={disabled}
                />
                {/* `message` é o nome do evento no wire; na tela vale o que ele
                    significa para quem lê. */}
                {ev === "message" ? t("Uma mensagem nova do cliente") : ev}
              </label>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex items-center gap-2">
          <Switch
            checked={value.filters.ignore_groups}
            onCheckedChange={(v) => patchFilters({ ignore_groups: v })}
            disabled={disabled}
            id="ignore_groups"
          />
          <Label htmlFor="ignore_groups">{t("Não responder em grupos")}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={value.filters.ignore_self}
            onCheckedChange={(v) => patchFilters({ ignore_self: v })}
            disabled={disabled}
            id="ignore_self"
          />
          <Label htmlFor="ignore_self">{t("Não responder às mensagens que saem do seu próprio número")}</Label>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="keyword_regex">{t("Só responder quando a mensagem falar de algo específico (opcional)")}</Label>
        <Input
          id="keyword_regex"
          value={value.filters.keyword_regex ?? ""}
          onChange={(e) =>
            patchFilters({ keyword_regex: e.target.value.trim() === "" ? null : e.target.value })
          }
          placeholder={t("Ex.: pedido|status|orçamento")}
          disabled={disabled}
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            "Deixe em branco para o agente responder a tudo. Se preencher, ele só entra quando a mensagem contiver uma dessas palavras — separe por barra vertical (|). Aceita expressão regular, para quem já conhece.",
          )}
        </p>
      </div>

      {/* PÚBLICO DO AGENTE (#3722) — quem este agente atende, no MESMO número
          em que outro atende o resto. Ao lado do filtro de palavra-chave
          porque é a mesma família: uma régua de ENTRADA. A diferença é que ela
          olha o CONTATO (etiquetas e funis dos negócios abertos), não o texto
          da mensagem — é o que permite um agente de vendas e um de clientes
          dividirem o número. */}
      <div className="space-y-3 rounded-md border border-border/60 p-3">
        <div>
          <Label>{t("Público do agente")}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              "Em branco, ele atende todo mundo. Preenchido, ele só atende quem cumpre TODOS os critérios — e quem tem um item de \"não atender\" fica de fora mesmo que cumpra os de \"atender\".",
            )}
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="include_tags">{t("Atender só quem tem estas etiquetas")}</Label>
          <CampoDeEtiquetas
            id="include_tags"
            valor={value.filters.include_tags ?? []}
            onChange={(lista) => patchFilters({ include_tags: lista })}
            placeholder={t("Ex.: cliente ativo, contrato")}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="exclude_tags">{t("Não atender quem tem estas etiquetas")}</Label>
          <CampoDeEtiquetas
            id="exclude_tags"
            valor={value.filters.exclude_tags ?? []}
            onChange={(lista) => patchFilters({ exclude_tags: lista })}
            placeholder={t("Ex.: cliente ativo, contrato")}
            disabled={disabled}
          />
        </div>

        <ListaDeFunis
          id="include_pipeline_ids"
          rotulo={t("Atender só quem está nestes funis")}
          ajuda={t("Estar no funil é ter um negócio ABERTO nele. Quem ainda não tem card não entra em \"só estes funis\".")}
          funis={funis}
          selecionados={value.filters.include_pipeline_ids ?? []}
          onChange={(ids) => patchFilters({ include_pipeline_ids: ids })}
          disabled={disabled}
        />
        <ListaDeFunis
          id="exclude_pipeline_ids"
          rotulo={t("Não atender quem está nestes funis")}
          ajuda={t("Estar no funil é ter um negócio ABERTO nele. Quem ainda não tem card NÃO é barrado por esta lista.")}
          funis={funis}
          selecionados={value.filters.exclude_pipeline_ids ?? []}
          onChange={(ids) => patchFilters({ exclude_pipeline_ids: ids })}
          disabled={disabled}
        />

        <p className="text-xs text-muted-foreground">
          {t(
            "Com dois agentes neste número, atende o primeiro na ordem de prioridade que aceita o contato. Se nenhum aceitar, o sistema não responde: a mensagem fica na caixa de entrada para uma pessoa.",
          )}
        </p>
      </div>

      <div className="space-y-1">
        <Label>{t("Quantos atendimentos ao mesmo tempo")}</Label>
        <Select
          value={value.concurrency}
          onValueChange={(v) => onChange({ ...value, concurrency: v as TriggerValue["concurrency"] })}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="one_per_conversation">{t("Um de cada vez por conversa")}</SelectItem>
            <SelectItem value="one_per_contact">{t("Um de cada vez por cliente")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2 rounded-md border border-border/60 p-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={!!bh}
            onCheckedChange={setBhEnabled}
            disabled={disabled}
            id="bh_enabled"
          />
          <Label htmlFor="bh_enabled">{t("Só atender em horário de funcionamento")}</Label>
        </div>
        {bh ? (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="bh_tz">{t("Fuso horário")}</Label>
                <Input
                  id="bh_tz"
                  value={bh.timezone}
                  onChange={(e) => patchBh({ timezone: e.target.value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bh_start">{t("Início")}</Label>
                <Input
                  id="bh_start"
                  type="time"
                  value={bh.start}
                  onChange={(e) => patchBh({ start: e.target.value })}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bh_end">{t("Fim")}</Label>
                <Input
                  id="bh_end"
                  type="time"
                  value={bh.end}
                  onChange={(e) => patchBh({ end: e.target.value })}
                  disabled={disabled}
                />
              </div>
            </div>
            <div>
              <Label className="mb-1 block">{t("Dias")}</Label>
              <div className="flex flex-wrap gap-1">
                {WEEKDAYS.map((d) => {
                  const active = bh.weekdays.includes(d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => toggleWeekday(d.id)}
                      disabled={disabled}
                      className={`rounded-md border px-2 py-1 text-xs ${
                        active
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/60 text-muted-foreground"
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {t(d.label)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bh_notice">{t("Mensagem fora do horário (opcional)")}</Label>
              <Textarea
                id="bh_notice"
                rows={3}
                maxLength={1000}
                value={bh.notice ?? ""}
                onChange={(e) => patchBh({ notice: e.target.value })}
                disabled={disabled}
                placeholder={t(
                  "Ex.: Nosso atendimento funciona de segunda a sexta, das 8h às 18h. Recebemos sua mensagem e respondemos no próximo horário de atendimento.",
                )}
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  "Quando o cliente escrever fora do horário, esta mensagem é enviada na hora — uma vez por cliente por período fechado, e nunca para quem pediu para parar. Deixe em branco para não enviar.",
                )}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
