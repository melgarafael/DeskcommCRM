"use client";

/**
 * OS LEMBRETES DE TAREFA (#2529) — a metade da tela.
 *
 * Um card próprio, e não mais linhas na tabela de categorias, porque este
 * aviso é de outra natureza: a tabela decide se a ABA ABERTA faz toast e
 * bandeja, e esta decide se um CRON, com o site fechado, procura a pessoa.
 * Misturar os dois na mesma tabela prometeria que desligar a linha da tabela
 * parasse o lembrete — e não pararia: o cron lê o servidor, não o navegador.
 *
 * O padrão renderizado é o do produto (`preferenciaPadraoDeLembrete`), o mesmo
 * que o servidor devolve quando não há nada gravado — os dois lados nascem com
 * o MESMO objeto, então a primeira pintura não diverge (a regra do #690), e a
 * preferência salva entra depois, quando a action responde.
 */
import { useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import { carregarTaskReminderPrefs, updateTaskReminderPrefs } from "@/app/actions/settings/updateTaskReminderPrefs";
import {
  ehAntecedenciaValida,
  preferenciaPadraoDeLembrete,
  type PreferenciaDeLembrete,
} from "@/lib/tarefas/preferencia-de-lembrete";

/** As três antecedências que a tela oferece, na ordem em que se leem. */
const ANTCEDENCIAS: ReadonlyArray<{ min: 15 | 60 | 1440; rotulo: string }> = [
  { min: 15, rotulo: "15 minutos" },
  { min: 60, rotulo: "1 hora" },
  { min: 1440, rotulo: "1 dia" },
];

export function TaskReminderPrefs() {
  const t = useT();
  const telefoneExemplo = useTelefoneExemplo();
  const [pref, setPref] = useState<PreferenciaDeLembrete>(() => preferenciaPadraoDeLembrete());
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void carregarTaskReminderPrefs().then((r) => {
      if (vivo && r.ok) setPref(r.preferencia);
    });
    return () => {
      vivo = false;
    };
  }, []);

  async function salvar(proxima: PreferenciaDeLembrete) {
    setPref(proxima);
    setSalvando(true);
    setErro(null);
    const r = await updateTaskReminderPrefs(proxima);
    if (!r.ok) {
      setErro(r.erro);
      // A gravação recusada volta ao que o SERVIDOR tem, não ao que estava na
      // tela: sem isso, um interruptor que parece ligado e não está seria a
      // mesma mentira do silêncio que esta feature conserta.
      const atual = await carregarTaskReminderPrefs();
      if (atual.ok) setPref(atual.preferencia);
    }
    setSalvando(false);
  }

  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">{t("Lembretes de tarefa")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(
          "O aviso fica na Central do responsável quando o prazo chega perto ou vence, mesmo que ninguém esteja com o site aberto. Se ele ligou o Push e esta instalação tem as chaves do Push (veja o aviso no topo da página), o aviso chega também no aparelho dele.",
        )}
      </p>

      <div className="mt-4 flex items-center justify-between gap-4">
        <Label htmlFor="lembrete-task-due" className="font-normal">
          {t("Avisar quando a tarefa está perto do vencimento")}
        </Label>
        <Switch
          id="lembrete-task-due"
          checked={pref.task_due}
          disabled={salvando}
          onCheckedChange={(on) => void salvar({ ...pref, task_due: on })}
          data-testid="lembrete-task-due"
        />
      </div>

      {pref.task_due ? (
        <div className="mt-3 flex items-center justify-between gap-4 pl-1">
          <Label htmlFor="lembrete-antecedencia" className="text-sm font-normal text-muted-foreground">
            {t("Antecedência do aviso")}
          </Label>
          <select
            id="lembrete-antecedencia"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={pref.antecedencia_min}
            disabled={salvando}
            onChange={(e) => {
              // O `<select>` só oferece as três antecedências válidas; a guarda
              // é do TIPO, não da tela — valor que a régua não aceita não vira
              // chamada nenhuma.
              const min = Number(e.target.value);
              if (ehAntecedenciaValida(min)) void salvar({ ...pref, antecedencia_min: min });
            }}
            data-testid="lembrete-antecedencia"
          >
            {ANTCEDENCIAS.map((a) => (
              <option key={a.min} value={a.min}>
                {t(a.rotulo)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-4">
        <Label htmlFor="lembrete-task-overdue" className="font-normal">
          {t("Avisar quando a tarefa vence sem conclusão")}
        </Label>
        <Switch
          id="lembrete-task-overdue"
          checked={pref.task_overdue}
          disabled={salvando}
          onCheckedChange={(on) => void salvar({ ...pref, task_overdue: on })}
          data-testid="lembrete-task-overdue"
        />
      </div>
      {pref.task_overdue ? (
        <p className="mt-1 pl-1 text-xs text-muted-foreground">
          {t("O aviso de vencimento sai uma vez por tarefa; não se repete a cada rodada.")}
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-4">
        <Label htmlFor="lembrete-whatsapp" className="font-normal">
          {t("Receber também no WhatsApp")}
        </Label>
        <Switch
          id="lembrete-whatsapp"
          checked={pref.whatsapp}
          disabled={salvando}
          onCheckedChange={(on) => void salvar({ ...pref, whatsapp: on, whatsapp_numero: on ? pref.whatsapp_numero : null })}
          data-testid="lembrete-whatsapp"
        />
      </div>
      {pref.whatsapp ? (
        <div className="mt-3 flex items-center justify-between gap-4 pl-1">
          <Label htmlFor="lembrete-whatsapp-numero" className="text-sm font-normal text-muted-foreground">
            {t("Número com DDD, só dígitos")}
          </Label>
          <Input
            id="lembrete-whatsapp-numero"
            className="w-52"
            inputMode="numeric"
            value={pref.whatsapp_numero ?? ""}
            disabled={salvando}
            placeholder={telefoneExemplo.replace(/\D/g, "")}
            onChange={(e) => setPref({ ...pref, whatsapp_numero: e.target.value })}
            onBlur={() => {
              if (pref.whatsapp_numero !== null) void salvar(pref);
            }}
            data-testid="lembrete-whatsapp-numero"
          />
        </div>
      ) : null}

      {erro ? (
        <p className="mt-3 text-sm text-destructive" data-testid="lembrete-erro">
          {t("Não foi possível salvar. Tente de novo.")}
        </p>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        {t(
          "O WhatsApp sai pelo número da empresa, e só quando ele estiver conectado. O aviso vai para o seu contato cadastrado no CRM.",
        )}
      </p>
      <div className="sr-only" aria-live="polite">
        {salvando ? t("Salvando…") : ""}
      </div>
    </Card>
  );
}
