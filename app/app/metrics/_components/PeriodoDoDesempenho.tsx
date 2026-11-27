"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import {
  janelaDoDesempenho,
  type DiasDoPeriodo,
  type JanelaIso,
} from "@/lib/metrics/periodo-do-desempenho";
import { cidadeDoFuso } from "@/lib/tempo/fusos";

type Erro = Extract<ReturnType<typeof janelaDoDesempenho>, { erro: string }>["erro"];

const VAZIO = { de: "", ate: "" };

const MENSAGENS: Record<Erro, string> = {
  incompleto: "Preencha a data inicial e a data final.",
  data: "Informe datas válidas.",
  ordem: "A data inicial deve ser anterior ou igual à data final.",
  limite: "Escolha um período de até 90 dias.",
  fuso: "Este período não pode ser usado no fuso da organização. Escolha outras datas.",
};

interface Props {
  fuso: string;
  aplicado: DiasDoPeriodo | null;
  onApply: (periodo: DiasDoPeriodo, janela: JanelaIso) => void;
  onClear: () => void;
}

export function PeriodoDoDesempenho({ fuso, aplicado, onApply, onClear }: Props) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const [rascunho, setRascunho] = useState<DiasDoPeriodo>(VAZIO);
  const [erro, setErro] = useState<Erro | null>(null);
  const formatar = (data: string) =>
    new Date(`${data}T00:00:00Z`).toLocaleDateString(idioma, { timeZone: "UTC" });

  function aplicar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const resultado = janelaDoDesempenho(rascunho, fuso);
    if ("erro" in resultado) {
      setErro(resultado.erro);
      return;
    }
    setErro(null);
    onApply(rascunho, resultado.janela);
  }

  function limpar() {
    setRascunho(VAZIO);
    setErro(null);
    onClear();
  }

  function editar(campo: keyof DiasDoPeriodo, valor: string) {
    setRascunho((anterior) => ({ ...anterior, [campo]: valor }));
    setErro(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <form
        aria-label={t("Período do desempenho")}
        className="flex flex-wrap items-end gap-2"
        onSubmit={aplicar}
      >
        <label className="flex min-w-32 flex-col gap-1 text-xs text-muted-foreground">
          {t("Data inicial")}
          <Input
            type="date"
            value={rascunho.de}
            onChange={(evento) => editar("de", evento.target.value)}
          />
        </label>
        <label className="flex min-w-32 flex-col gap-1 text-xs text-muted-foreground">
          {t("Data final")}
          <Input
            type="date"
            value={rascunho.ate}
            onChange={(evento) => editar("ate", evento.target.value)}
          />
        </label>
        <Button type="submit">{t("Aplicar")}</Button>
        <Button type="button" variant="outline" onClick={limpar}>
          {t("Limpar")}
        </Button>
      </form>
      {erro && <p role="alert" className="text-sm text-destructive">{t(MENSAGENS[erro])}</p>}
      <p role="status" className="text-sm text-muted-foreground">
        <span className="font-medium">{t("Período exibido")} </span>
        {aplicado ? `${formatar(aplicado.de)} – ${formatar(aplicado.ate)}` : t("Últimos 30 dias")}
        {" · "}{cidadeDoFuso(fuso)}
      </p>
    </div>
  );
}
