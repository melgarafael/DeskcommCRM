"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { HorarioDaEspera } from "@/lib/followup/espera-no-horario";
import { useT } from "@/hooks/i18n/useT";

const DIAS = [0, 1, 2, 3, 4, 5, 6] as const;

/** O mesmo padrão da faixa de follow-up do agente: dias úteis, horário comercial. */
const HORARIO_PADRAO: HorarioDaEspera = { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };

/**
 * O horário em que a espera pode terminar (`wait.ate_o_horario`).
 *
 * Mesmo desenho e mesmas palavras do editor da faixa de follow-up do agente
 * (`FollowupWindowEditor`): quem já configurou uma reconhece a outra. São
 * escolhas independentes — aquela vale para todos os envios do agente; esta, só
 * para o fim desta espera.
 *
 * O fuso não é perguntado: é o da organização, o mesmo relógio da condição por
 * data e da faixa do agente.
 */
export function HorarioDaEsperaEditor({
  value,
  onChange,
}: {
  value: HorarioDaEspera | null;
  onChange: (value: HorarioDaEspera | null) => void;
}) {
  const t = useT();
  const intervaloInvalido = value !== null && value.end <= value.start;

  function patch(p: Partial<HorarioDaEspera>) {
    if (value === null) return;
    onChange({ ...value, ...p });
  }

  function alternarDia(dia: number) {
    if (value === null) return;
    const ativo = value.weekdays.includes(dia);
    // Ao menos um dia: tirar o último deixaria a espera sem horário possível, e
    // a pessoa só descobriria na hora de publicar.
    if (ativo && value.weekdays.length === 1) return;
    const weekdays = ativo
      ? value.weekdays.filter((d) => d !== dia)
      : [...value.weekdays, dia].sort((a, b) => a - b);
    patch({ weekdays });
  }

  function rotuloDoDia(dia: number): string {
    // Literais de propósito: o gate de espanhol enxerga cada chave usada.
    switch (dia) {
      case 0:
        return t("Dom");
      case 1:
        return t("Seg");
      case 2:
        return t("Ter");
      case 3:
        return t("Qua");
      case 4:
        return t("Qui");
      case 5:
        return t("Sex");
      case 6:
        return t("Sáb");
      default:
        return "";
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3" data-testid="wait-horario">
      <div className="flex items-center gap-2">
        <Switch
          id="wait-horario-ligado"
          checked={value !== null}
          onCheckedChange={(ligado) => onChange(ligado ? HORARIO_PADRAO : null)}
        />
        <Label htmlFor="wait-horario-ligado">{t("Só terminar a espera em horário comercial")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Se a espera vencer fora deste horário, o fluxo continua esperando até a próxima abertura. Vale o fuso da organização.")}
      </p>

      {value !== null ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="wait-horario-inicio">{t("Início")}</Label>
              <Input
                id="wait-horario-inicio"
                type="time"
                value={value.start}
                onChange={(e) => patch({ start: e.target.value })}
                aria-invalid={intervaloInvalido}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wait-horario-fim">{t("Fim")}</Label>
              <Input
                id="wait-horario-fim"
                type="time"
                value={value.end}
                onChange={(e) => patch({ end: e.target.value })}
                aria-invalid={intervaloInvalido}
              />
            </div>
          </div>
          {intervaloInvalido ? <p className="text-xs text-destructive">{t("Campo inválido.")}</p> : null}

          <div>
            <Label className="mb-1 block">{t("Dias")}</Label>
            <div className="flex flex-wrap gap-1">
              {DIAS.map((dia) => {
                const ativo = value.weekdays.includes(dia);
                return (
                  <button
                    key={dia}
                    type="button"
                    aria-pressed={ativo}
                    onClick={() => alternarDia(dia)}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      ativo ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground"
                    }`}
                  >
                    {rotuloDoDia(dia)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
