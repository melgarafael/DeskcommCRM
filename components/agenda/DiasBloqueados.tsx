"use client";
/**
 * A tela dos dias fora da rotina — os que FECHAM e os que ABREM.
 *
 * Existe porque `calendar_availability_exceptions` era respeitada pelo motor de
 * horários livres desde a migration 0177 e **não tinha como receber uma linha**:
 * nem rota, nem tela, nem action. Quem precisasse fechar a agenda num feriado
 * marcava um compromisso falso de dia inteiro — que polui a agenda, conta como
 * atendimento e aparece na timeline do lead.
 *
 * ## Por que ABRIR também mora aqui
 *
 * A coluna `is_unavailable` sempre teve os dois sentidos, a rota sempre aceitou
 * os dois (`POST /api/v1/agenda/excecoes` audita `agenda.dia_bloqueado` OU
 * `agenda.dia_aberto`) e a lista abaixo sempre soube rotular o segundo
 * ("aberto excepcionalmente"). Só o formulário não: ele mandava
 * `is_unavailable: true` e dia inteiro, fixos. Metade da capacidade existia no
 * banco, na rota, no motor e na listagem, e não tinha por onde entrar —
 * invariante 6 do Sistema Vivo.
 *
 * Quem paga por isso é quem NÃO trabalha em jornada semanal fixa. Medido numa
 * instalação real (clínica com atendimento em dias irregulares, cada dia numa
 * unidade): a jornada semanal fica vazia de propósito, para todo dia nascer
 * fechado, e cada data de atendimento é uma exceção ABERTA. Essa agenda não
 * tinha como ser montada pela tela — só por SQL.
 *
 * ## Por que FECHAR SÓ ALGUMAS HORAS é um terceiro modo
 *
 * O formulário fechava sempre o dia inteiro, com a justificativa de que "fechar
 * meio dia é o caso de quem ABRE o outro meio". Não é: uma exceção ABERTA
 * SUBSTITUI a jornada do dia (`janelasDoDia`), então para tirar UMA hora do meio
 * de uma jornada 08–19 era preciso abrir duas faixas (08–14 e 15–19) — e errar
 * uma delas apagava o resto do dia em silêncio. Já o fechamento PARCIAL sempre
 * funcionou abaixo da tela: a rota aceita `is_unavailable: true` com faixa, e o
 * motor trata a faixa fechada como um compromisso (DECISÃO 12 de
 * `horarios-livres.ts`, buffer incluído) — o resto do dia segue a jornada.
 *
 * Pedido real numa instalação em 02/11/2026: a dona da agenda tinha um
 * compromisso pessoal numa tarde e queria tirar só aquela hora da oferta, sem
 * inventar um agendamento falso nem fechar o dia.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * Os três gestos da tela. Os dois FECHAR mandam `is_unavailable: true`; o que
 * muda entre eles é só a faixa (o dia inteiro ou a que a pessoa escolheu).
 */
type Modo = "fechar" | "fechar-horas" | "abrir";

type Excecao = {
  id: string;
  exception_date: string;
  is_unavailable: boolean;
  start_minute: number;
  end_minute: number;
  reason: string | null;
};

const DIA_INTEIRO = { start_minute: 0, end_minute: 1440 };

/**
 * Um ano de repetição semanal, e o motivo é o dedo escorregando na data: um
 * "2036" digitado sem querer viraria 520 requisições e 520 linhas para apagar
 * uma a uma. Cinquenta e três cobre o ano inteiro, que é o horizonte de quem
 * publica agenda.
 */
const TETO_DA_REPETICAO = 53;

function ehDiaInteiro(e: Excecao): boolean {
  return e.start_minute === DIA_INTEIRO.start_minute && e.end_minute === DIA_INTEIRO.end_minute;
}

/** "0..1440" vira "o dia todo"; o resto vira "09:00–12:00". */
function faixa(e: Excecao, t: (s: string) => string): string {
  if (ehDiaInteiro(e)) return t("o dia todo");
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${hhmm(e.start_minute)}–${hhmm(e.end_minute)}`;
}

/**
 * As datas de uma repetição SEMANAL, da primeira até o limite, inclusive.
 *
 * Meio-dia UTC de propósito: `new Date("2026-10-01")` nasce à meia-noite UTC e,
 * somado a fusos a oeste, volta um dia ao ser formatado. Ancorar no meio-dia tira
 * o horário de verão e a virada de dia da conta — a aritmética aqui é de DIAS.
 */
function datasSemanais(inicio: string, ate: string, teto: number): string[] {
  const fim = new Date(`${ate}T12:00:00Z`).getTime();
  const datas: string[] = [];
  for (let d = new Date(`${inicio}T12:00:00Z`); d.getTime() <= fim; d.setUTCDate(d.getUTCDate() + 7)) {
    if (datas.length >= teto) break;
    datas.push(d.toISOString().slice(0, 10));
  }
  return datas;
}

/** "14:00" vira 840 — o caminho inverso do `faixa` acima. */
function emMinutos(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function DiasBloqueados({ podeEditar }: { podeEditar: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [data, setData] = useState("");
  const [motivo, setMotivo] = useState("");
  const [modo, setModo] = useState<Modo>("fechar");
  const [de, setDe] = useState("08:00");
  const [ate, setAte] = useState("12:00");
  const [repetirAte, setRepetirAte] = useState("");
  const [resultado, setResultado] = useState<{ criados: number; pulados: number } | null>(null);

  const abrindo = modo === "abrir";
  // Abrir e fechar só algumas horas pedem a faixa; fechar o dia não.
  const comFaixa = modo !== "fechar";
  // O CHECK do banco é `end_minute > start_minute`; barrar aqui troca um 422 por
  // um botão que não deixa errar.
  const faixaInvalida = comFaixa && emMinutos(ate) <= emMinutos(de);

  const query = useQuery({
    queryKey: ["agenda", "excecoes"],
    queryFn: async () =>
      (await apiClient.get<{ data: Excecao[] }>("/api/v1/agenda/excecoes")).data,
  });

  const lista = query.data ?? [];

  const invalidar = () => {
    // A agenda também muda: um dia fechado tira horários da consulta.
    void qc.invalidateQueries({ queryKey: ["agenda"] });
  };

  const criar = useMutation({
    mutationFn: async () => {
      // "Fechar o dia" segue mandando o dia INTEIRO: é o caminho de feriado e
      // férias, e a regressão mais cara seria um dia de férias virar meio dia.
      const faixa = comFaixa
        ? { start_minute: emMinutos(de), end_minute: emMinutos(ate) }
        : DIA_INTEIRO;
      const alvos = repetirAte ? datasSemanais(data, repetirAte, TETO_DA_REPETICAO) : [data];

      // O QUE JÁ EXISTE É PULADO, e não recusado.
      //
      // A tabela não tem unicidade por data — de propósito, porque um dia pode
      // ter duas faixas abertas (manhã num lugar, tarde noutro). Sem esta
      // conferência, repetir duas vezes o mesmo trimestre dobraria cada linha
      // em silêncio, e o dono só descobriria pela lista crescendo.
      const jaTem = new Set(
        lista
          .filter((e) => e.is_unavailable === !abrindo)
          .map((e) => `${e.exception_date}|${e.start_minute}|${e.end_minute}`),
      );
      const novos = alvos.filter(
        (d) => !jaTem.has(`${d}|${faixa.start_minute}|${faixa.end_minute}`),
      );

      // Em série, e não em paralelo: são poucas requisições e o servidor de
      // quem se auto-hospeda é pequeno. Cada dia é uma linha real e uma linha
      // de auditoria — o lote é da tela, não do banco.
      for (const dia of novos) {
        await apiClient.post("/api/v1/agenda/excecoes", {
          exception_date: dia,
          is_unavailable: !abrindo,
          ...faixa,
          ...(motivo.trim() ? { reason: motivo.trim() } : {}),
        });
      }
      return { criados: novos.length, pulados: alvos.length - novos.length };
    },
    onSuccess: (r) => {
      setData("");
      setMotivo("");
      setRepetirAte("");
      setResultado(r);
      invalidar();
    },
    onError: showApiError,
  });

  const remover = useMutation({
    mutationFn: (id: string) => apiClient.delete("/api/v1/agenda/excecoes", { id }),
    onSuccess: invalidar,
    onError: showApiError,
  });

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="dias-bloqueados">
      <h2 className="font-semibold">{t("Dias fora da rotina")}</h2>
      <p className="text-sm text-text-muted">
        {t(
          "Feche um dia (feriado, férias, viagem) ou abra um dia que a sua jornada semanal não cobre. Em dia fechado o sistema deixa de oferecer horários, e o que já estava marcado continua marcado, para você decidir o que fazer com cada um.",
        )}
      </p>

      {podeEditar ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="block text-sm">{t("O que fazer")}</span>
            <select
              aria-label={t("O que fazer")}
              className="mt-1 rounded-md border p-2"
              data-testid="modo-do-dia"
              value={modo}
              onChange={(e) =>
                setModo(
                  e.target.value === "abrir"
                    ? "abrir"
                    : e.target.value === "fechar-horas"
                      ? "fechar-horas"
                      : "fechar",
                )
              }
            >
              <option value="fechar">{t("Fechar o dia")}</option>
              <option value="fechar-horas">{t("Fechar só algumas horas")}</option>
              <option value="abrir">{t("Abrir para atendimento")}</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-sm">{t("Dia")}</span>
            <input
              aria-label={t("Dia")}
              className="mt-1 rounded-md border p-2"
              type="date"
              value={data}
              onChange={(e) => {
                setData(e.target.value);
                setResultado(null);
              }}
            />
          </label>
          {comFaixa ? (
            <>
              <label className="block">
                <span className="block text-sm">{t("Das")}</span>
                <input
                  aria-label={t("Das")}
                  className="mt-1 rounded-md border p-2"
                  type="time"
                  value={de}
                  onChange={(e) => setDe(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="block text-sm">{t("Até")}</span>
                <input
                  aria-label={t("Até")}
                  className="mt-1 rounded-md border p-2"
                  type="time"
                  value={ate}
                  onChange={(e) => setAte(e.target.value)}
                />
              </label>
            </>
          ) : null}
          <label className="block flex-1">
            <span className="block text-sm">{t("Motivo (opcional)")}</span>
            <input
              aria-label={t("Motivo (opcional)")}
              className="mt-1 w-full rounded-md border p-2"
              maxLength={200}
              placeholder={t("Ex.: feriado")}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-sm">{t("Repetir toda semana até (opcional)")}</span>
            <input
              aria-label={t("Repetir toda semana até (opcional)")}
              className="mt-1 rounded-md border p-2"
              type="date"
              min={data || undefined}
              value={repetirAte}
              onChange={(e) => setRepetirAte(e.target.value)}
            />
          </label>
          <Button
            // Alvo de toque generoso: esta tela também é usada no celular.
            className="min-h-11"
            disabled={!data || criar.isPending || faixaInvalida}
            onClick={() => criar.mutate()}
          >
            {abrindo
              ? t("Abrir este dia")
              : comFaixa
                ? t("Fechar estas horas")
                : t("Fechar este dia")}
          </Button>
          {modo === "fechar-horas" ? (
            // O que acontece com o RESTO do dia é a dúvida de quem fecha só um
            // pedaço — e a diferença para "abrir", que substitui a jornada.
            <p className="w-full text-sm text-text-muted" data-testid="explica-fechar-horas">
              {t(
                "Nessas horas a agenda deixa de oferecer horários, para a equipe e para a IA. O resto do dia segue a jornada de sempre.",
              )}
            </p>
          ) : null}
          {faixaInvalida ? (
            <p className="w-full text-sm text-destructive">
              {t("A hora final precisa ser maior que a inicial.")}
            </p>
          ) : null}
          {resultado ? (
            // Dizer QUANTOS, e quantos já existiam, é o que diferencia "repeti
            // sem querer" de "não aconteceu nada".
            <p className="w-full text-sm text-text-muted" data-testid="resultado-do-lote">
              {`${resultado.criados} ${t("dia(s) gravado(s)")}`}
              {resultado.pulados > 0 ? ` · ${resultado.pulados} ${t("já existia(m)")}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      {query.isError ? (
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t("Tentar novamente")}
        </Button>
      ) : query.isLoading ? (
        <p>{t("Carregando…")}</p>
      ) : lista.length === 0 ? (
        <p className="text-sm text-text-muted">{t("Nenhum dia fora da rotina daqui para a frente.")}</p>
      ) : (
        <ul className="space-y-1">
          {lista.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {new Date(`${e.exception_date}T12:00:00`).toLocaleDateString()} · {faixa(e, t)}
                {/* Com o fechamento parcial, "14:00–15:00" sozinho não diz se a
                    faixa foi aberta ou fechada; o dia inteiro fechado já se lê. */}
                {e.is_unavailable
                  ? ehDiaInteiro(e)
                    ? ""
                    : ` · ${t("fechado nessas horas")}`
                  : ` · ${t("aberto excepcionalmente")}`}
                {e.reason ? ` · ${e.reason}` : ""}
              </span>
              {podeEditar ? (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={remover.isPending}
                  onClick={() => remover.mutate(e.id)}
                >
                  {t("Reabrir")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
