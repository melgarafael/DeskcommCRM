"use client";

/**
 * O controle de valor das condições do CONTATO (#3814).
 *
 * As duas condições novas não pedem texto livre: pedem "sim" ou "não" — e a de
 * agenda aceita, opcionalmente, o prazo em dias e o tipo de atendimento. O
 * `value` gravado é um texto só (`sim`, `nao`, `sim|7`, `sim|7|Manutenção`; ver
 * `lerValorDeHorario` em `lib/automation/conditions.ts`), então quem decompõe e
 * remonta é ESTE componente — os dois editores (`RuleEditor`, no formulário, e
 * `PainelDaCaixa`, no desenho) desenham o mesmo controle em vez de manterem
 * cada um a sua cópia.
 *
 * O texto DIGITADO é estado local: enquanto a pessoa digita "12" o valor
 * gravado passa por "1", e derivar o campo do valor faria o cursor pular. O que
 * não passa na faixa (0, 400, "abc") fica visível no campo e NÃO é gravado; ao
 * sair do campo ele volta ao que está gravado, para a tela nunca mostrar um
 * prazo que a regra não tem.
 */
import { useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import {
  CAMPOS_DO_CONTATO,
  DIAS_MAXIMOS_DA_AGENDA,
  lerValorDeHorario,
  montarValorDeHorario,
  type RegraDeHorario,
  type RespostaDeSimNao,
} from "@/lib/automation/conditions";

/**
 * O valor do contato como a pessoa LÊ (cartão do desenho e lista de grupo
 * preservado): `Sim`, `Sim · 7 dias`, `Não · 7 dias · Manutenção`.
 *
 * O jsonb guarda `sim|7|Manutenção`; mostrar isso na tela do cartão seria pedir
 * que o operador lesse o formato do banco.
 */
export function valorDaCondicaoNaTela(valor: string, t: (chave: string) => string): string {
  const regra = lerValorDeHorario(valor);
  if (!regra) return valor;
  const partes = [t(regra.resposta === "sim" ? "Sim" : "Não")];
  if (regra.dias !== null) partes.push(`${regra.dias} ${t("dias")}`);
  if (regra.tipo !== null) partes.push(regra.tipo);
  return partes.join(" · ");
}

export function ValorDaCondicaoDoContato({
  campo,
  valor,
  onChange,
}: {
  campo: string;
  valor: string;
  onChange: (valor: string) => void;
}) {
  const t = useT();
  // Valor que não é do formato (linha recém-criada, ou jsonb antigo) começa em
  // "sim": é a resposta que a maioria das regras quer, e a porta confere ao
  // salvar de qualquer jeito.
  const regra: RegraDeHorario = lerValorDeHorario(valor) ?? {
    resposta: "sim",
    dias: null,
    tipo: null,
  };
  const daAgenda = campo === CAMPOS_DO_CONTATO.horarioMarcado;

  const [diasDigitados, setDiasDigitados] = useState(regra.dias === null ? "" : String(regra.dias));
  const [tipoDigitado, setTipoDigitado] = useState(regra.tipo ?? "");

  const mudar = (patch: Partial<RegraDeHorario>) =>
    onChange(montarValorDeHorario({ ...regra, ...patch }));

  return (
    <div className="flex flex-1 basis-40 flex-wrap items-center gap-2">
      <Select
        value={regra.resposta}
        onValueChange={(v) => mudar({ resposta: v as RespostaDeSimNao })}
      >
        <SelectTrigger className="w-28" aria-label={t("Resposta")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="sim">{t("Sim")}</SelectItem>
          <SelectItem value="nao">{t("Não")}</SelectItem>
        </SelectContent>
      </Select>
      {daAgenda ? (
        <>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={DIAS_MAXIMOS_DA_AGENDA}
            className="w-32"
            value={diasDigitados}
            placeholder={t("nos próximos (dias)")}
            aria-label={t("nos próximos (dias)")}
            onChange={(e) => {
              const bruto = e.target.value;
              setDiasDigitados(bruto);
              const dias = Number(bruto);
              if (bruto.trim() === "") mudar({ dias: null });
              else if (Number.isInteger(dias) && dias >= 1 && dias <= DIAS_MAXIMOS_DA_AGENDA) {
                mudar({ dias });
              }
            }}
            onBlur={() => setDiasDigitados(regra.dias === null ? "" : String(regra.dias))}
          />
          <Input
            className="flex-1 basis-40"
            maxLength={120}
            value={tipoDigitado}
            placeholder={t("do tipo (opcional)")}
            aria-label={t("do tipo (opcional)")}
            onChange={(e) => {
              const bruto = e.target.value;
              setTipoDigitado(bruto);
              mudar({ tipo: bruto.trim() === "" ? null : bruto });
            }}
          />
        </>
      ) : null}
    </div>
  );
}
