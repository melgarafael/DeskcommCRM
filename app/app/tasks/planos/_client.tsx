"use client";
/**
 * TAREFAS › PLANOS — onde o plano nasce, cresce e morre (#1752).
 *
 * ═══ Por que esta tela existe ═══
 *
 * Sem ela, gravar um plano exigia editar `organizations.settings.task_plans`
 * à mão no banco: o motor já lia, mas ninguém numa VPS conseguia CADASTRAR.
 * A tela só fala com a rota `settings/task-plans`, que valida com o mesmo
 * `planosSchema` do motor — o que aparece aqui é exatamente o que
 * `apply_task_plan` vai aplicar, e o que não passa daqui jamais chega ao
 * settings.
 *
 * ═══ O que ela NÃO faz ═══
 *
 * Não aplica o plano a negócio nenhum: aplicar é ação de regra (ou do card do
 * lead, quando ele existir). Aqui se monta a sequência; quem dispara é quem
 * decide o momento — misturar os dois ensinaria o operador a aplicar plano na
 * mão e a confiar na marca de idempotência só metade das vezes.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { usePipelines } from "@/hooks/webhooks/useWebhookSources";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";
import { ArrowBendUpLeft } from "@/lib/ui/icons";
import { camposDeDataDoNegocio } from "@/lib/leads/campos-do-funil";
import { LIMITES_DO_PLANO } from "@/lib/tarefas/limites-do-plano";
import type { PassoDePlano, PlanoDeTarefas } from "@/lib/tarefas/plano";
import type { PrazoDoPasso } from "@/lib/tarefas/prazo-relativo";

/**
 * A chave gravada (pela API) que nenhum funil declara, para o seletor mostrá-la como é.
 * Fora do componente porque dentro do callback do `.some` o TypeScript perde o
 * estreitamento de `prazo.modo` (TS2339 em `prazo.campo`). Enquanto os funis carregam,
 * nada é órfão ainda: mostrar a chave crua ali estourava a largura do passo a 375px.
 */
function chaveOrfa(
  prazo: PrazoDoPasso,
  campos: ReadonlyArray<{ chave: string }>,
  carregando: boolean,
): string | null {
  if (carregando || prazo.modo !== "campo_de_data" || !prazo.campo) return null;
  const campo = prazo.campo;
  return campos.some((c) => c.chave === campo) ? null : campo;
}
import { explicarRecusaDoPlano, frasePrazoDoPasso } from "@/lib/tarefas/recusa-do-plano";
import { PRIORIDADES_DA_TAREFA, type PrioridadeDaTarefa } from "@/lib/tarefas/tipos";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

const CHAVE_DA_CONSULTA = ["settings", "task-plans"] as const;

function rotuloDaPrioridade(t: (s: string) => string, p: string): string {
  if (p === "low") return t("Baixa");
  if (p === "high") return t("Alta");
  if (p === "urgent") return t("Urgente");
  return t("Média");
}

function novoPlano(): PlanoDeTarefas {
  return { id: randomId(), nome: "", descricao: null, passos: [novoPasso()] };
}

function novoPasso(): PassoDePlano {
  return {
    ordem: 1,
    titulo: "",
    descricao: null,
    // O modo de sempre como padrão: quem não mexer no seletor continua com o
    // plano que o produto sempre soube aplicar.
    prazo: { modo: "dias_a_partir_de_hoje", dias: 1 },
    prioridade: "medium",
    atribuir_a: "dono_do_lead",
  };
}

/**
 * O passo como a TELA o entende, inclusive o plano gravado ANTES do modo novo.
 *
 * `settings` antigo tem `vence_em_dias` e nenhum `prazo`; normalizar na LEITURA
 * (em vez de confiar no formato) é o que deixa a tela abrir plano antigo sem
 * quebrar — e o passo legado continua sendo gravado igual, porque o schema do
 * servidor aceita as duas formas.
 */
function prazoNaTela(passo: PassoDePlano): PassoDePlano["prazo"] {
  return passo.prazo ?? { modo: "dias_a_partir_de_hoje", dias: passo.vence_em_dias ?? 0 };
}

/**
 * O prazo de um passo em UMA linha, para o resumo do plano.
 *
 * Campo de data aparece pelo NOME da chave porque é isso que o operador digita
 * e reconhece; o rótulo bonito do campo mora no funil (`pipelines.settings.fields`),
 * que esta tela não carrega — inventar o rótulo aqui seria mostrar um palpite.
 */
function resumoDoPrazo(t: (s: string) => string, prazo: PassoDePlano["prazo"]): string {
  if (prazo.modo === "dias_a_partir_de_hoje") {
    return `${t("Vence em (dias)")} ${prazo.dias}`;
  }
  const dias = Math.abs(prazo.dias);
  if (prazo.dias === 0) {
    return t("Vence no dia do campo «{c}»").replace("{c}", prazo.campo);
  }
  return (prazo.dias < 0 ? t("{n} dia(s) antes do campo «{c}»") : t("{n} dia(s) depois do campo «{c}»"))
    .replace("{n}", String(dias))
    .replace("{c}", prazo.campo);
}

/**
 * Os campos de DATA do negócio de todos os funis, um por chave.
 *
 * O plano não é de um funil só, então a lista é a união. A mesma chave em dois
 * funis é o MESMO campo para o plano (o prazo lê `custom_fields[chave]` do card,
 * seja qual for o funil), e por isso vira uma opção só, com os funis no rótulo.
 */
export function camposDeDataDosFunis(
  funis: ReadonlyArray<{ name: string; settings?: Record<string, unknown> | null }>,
): Array<{ chave: string; rotulo: string }> {
  const porChave = new Map<string, { label: string; funis: string[] }>();
  for (const funil of funis) {
    for (const campo of camposDeDataDoNegocio(funil.settings ?? null)) {
      const visto = porChave.get(campo.key);
      if (visto) visto.funis.push(funil.name);
      else porChave.set(campo.key, { label: campo.label, funis: [funil.name] });
    }
  }
  return [...porChave].map(([chave, { label, funis: nomes }]) => ({
    chave,
    rotulo: `${label} — ${nomes.join(", ")}`,
  }));
}

export function PlanosDeTarefa() {
  const t = useT();
  const qc = useQueryClient();
  const [rascunho, setRascunho] = useState<PlanoDeTarefas | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const q = useQuery({
    queryKey: CHAVE_DA_CONSULTA,
    queryFn: async () =>
      (await apiClient.get<{ data: { planos: PlanoDeTarefas[] } }>(
        "/api/v1/settings/task-plans",
      )).data,
  });

  const salvar = useMutation({
    mutationFn: async (planos: PlanoDeTarefas[]) =>
      (
        await apiClient.patch<{ data: { planos: PlanoDeTarefas[] } }>(
          "/api/v1/settings/task-plans",
          { planos },
        )
      ).data,
    onSuccess: () => {
      // Fechar aqui e não em `guardar`: a mutação é assíncrona, e ler
      // `isError` logo após `mutate()` mediria o estado do turno ANTERIOR.
      setErro(null);
      setRascunho(null);
      void qc.invalidateQueries({ queryKey: CHAVE_DA_CONSULTA });
    },
    // O 422 diz QUAL campo passou do teto; "Dados inválidos." sozinho não
    // deixava a pessoa saber o que corrigir.
    onError: (e: Error) =>
      setErro((e instanceof ApiError ? explicarRecusaDoPlano(e.details, t) : null) ?? e.message),
  });

  // O PATCH substitui a lista INTEIRA. Sem a lista lida (carregando ou com erro),
  // `[]` fingiria "não há planos" e salvar apagaria os que existem: tudo que
  // grava fica desativado até `q.data` chegar.
  const listaLida = q.data !== undefined;
  const planos = q.data?.planos ?? [];

  function guardar() {
    if (!rascunho || !listaLida) return;
    const nome = rascunho.nome.trim();
    if (!nome) {
      setErro(t("Dê um nome ao plano."));
      return;
    }
    if (rascunho.passos.length === 0) {
      setErro(t("O plano precisa de pelo menos um passo."));
      return;
    }
    if (rascunho.passos.some((p) => !p.titulo.trim())) {
      setErro(t("Escreva o título de todos os passos."));
      return;
    }
    const prazoTorto = rascunho.passos.findIndex((p) => {
      const prazo = prazoNaTela(p);
      return (
        !Number.isInteger(prazo.dias) ||
        Math.abs(prazo.dias) > LIMITES_DO_PLANO.venceEmDias ||
        (prazo.modo === "dias_a_partir_de_hoje" && prazo.dias < 0) ||
        (prazo.modo === "campo_de_data" && prazo.campo.trim() === "")
      );
    });
    if (prazoTorto >= 0) {
      const passo = rascunho.passos[prazoTorto];
      setErro(
        passo && prazoNaTela(passo).modo === "campo_de_data"
          ? t("Escolha o campo de data do passo {p}.").replace(
              "{p}",
              String(prazoTorto + 1),
            )
          : frasePrazoDoPasso(t, prazoTorto + 1),
      );
      return;
    }
    const pronto: PlanoDeTarefas = {
      ...rascunho,
      nome,
      descricao: rascunho.descricao?.trim() ? rascunho.descricao.trim() : null,
      // O GET devolve `vence_em_dias` junto do `prazo`, e editar só mexe no
      // `prazo`: regravar o número velho deixaria no settings dois prazos que
      // discordam. Ele sai do `prazo` — e some no modo de campo de data.
      passos: rascunho.passos.map((p, i) => {
        const prazo = prazoNaTela(p);
        return {
          ...p,
          ordem: i + 1,
          prazo,
          vence_em_dias: prazo.modo === "dias_a_partir_de_hoje" ? prazo.dias : undefined,
        };
      }),
    };
    const outraVez = planos.some((p) => p.id === pronto.id);
    salvar.mutate(outraVez ? planos.map((p) => (p.id === pronto.id ? pronto : p)) : [...planos, pronto]);
  }

  function excluir(plano: PlanoDeTarefas) {
    if (!listaLida) return;
    salvar.mutate(planos.filter((p) => p.id !== plano.id));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div>
        <Link
          href="/app/tasks"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-text"
        >
          <ArrowBendUpLeft size={14} aria-hidden />
          {t("Tarefas")}
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Planos de tarefa")}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "Monte a sequência uma vez; a ação Aplicar um plano de tarefas aplica o plano ao negócio.",
            )}
          </p>
        </div>
        <Button
          type="button"
          disabled={!listaLida}
          onClick={() => {
            setErro(null);
            setRascunho(novoPlano());
          }}
        >
          {t("Novo plano")}
        </Button>
      </header>

      {erro ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {erro}
        </p>
      ) : null}

      {rascunho ? (
        <Editor
          plano={rascunho}
          onChange={setRascunho}
          onCancelar={() => {
            setRascunho(null);
            setErro(null);
          }}
          onGuardar={guardar}
          ocupado={salvar.isPending || !listaLida}
        />
      ) : null}

      {q.isLoading ? <Skeleton className="h-40 w-full" /> : null}

      {q.isError && !listaLida ? (
        <Card role="alert" className="space-y-2 p-4 text-sm">
          <p>
            {t(
              "Não foi possível carregar os planos. Para não apagar os que já existem, criar e salvar ficam desativados até a lista carregar.",
            )}
          </p>
          <Button type="button" variant="outline" onClick={() => void q.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </Card>
      ) : null}

      {listaLida && planos.length === 0 && !rascunho ? (
        <Card className="p-4 text-sm text-muted-foreground">
          {t("Nenhum plano cadastrado ainda.")}
        </Card>
      ) : null}

      {planos.map((plano) => (
        <Card key={plano.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate font-medium">{plano.nome}</h2>
              {plano.descricao ? (
                <p className="break-words text-sm text-muted-foreground">{plano.descricao}</p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setErro(null);
                  setRascunho({
                    ...plano,
                    descricao: plano.descricao,
                    passos: plano.passos.map((p) => ({ ...p, prazo: prazoNaTela(p) })),
                  });
                }}
              >
                {t("Editar")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => excluir(plano)}>
                {t("Excluir")}
              </Button>
            </div>
          </div>
          <ol className="space-y-1 text-sm text-muted-foreground">
            {plano.passos.map((passo) => (
              <li key={passo.ordem}>
                {passo.ordem}. {passo.titulo} — {resumoDoPrazo(t, prazoNaTela(passo))}
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}

function Editor({
  plano,
  onChange,
  onCancelar,
  onGuardar,
  ocupado,
}: {
  plano: PlanoDeTarefas;
  onChange: (p: PlanoDeTarefas) => void;
  onCancelar: () => void;
  onGuardar: () => void;
  ocupado: boolean;
}) {
  const t = useT();
  const { data: members } = useAssignableMembers(true);

  // O editor nunca lê `passo.prazo` cru: o plano pode ter vindo do servidor no
  // formato antigo (`vence_em_dias`, sem `prazo`), e o seletor precisa abrir no
  // modo de sempre em vez de estourar.
  const passos = plano.passos.map((p) => ({ ...p, prazo: prazoNaTela(p) }));
  const { data: funisRes, isLoading: carregandoFunis } = usePipelines();
  const camposDeData = camposDeDataDosFunis(funisRes?.data ?? []);

  function mudarPasso(indice: number, campo: Partial<PassoDePlano>) {
    onChange({
      ...plano,
      passos: plano.passos.map((p, i) => (i === indice ? { ...p, ...campo } : p)),
    });
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="space-y-1">
        <Label htmlFor="plano-nome">{t("Nome do plano")}</Label>
        <Input
          id="plano-nome"
          value={plano.nome}
          onChange={(e) => onChange({ ...plano, nome: e.target.value })}
          placeholder={t("Proposta enviada")}
          maxLength={LIMITES_DO_PLANO.nome}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="plano-descricao">{t("Descrição (opcional)")}</Label>
        <Textarea
          id="plano-descricao"
          value={plano.descricao ?? ""}
          onChange={(e) => onChange({ ...plano, descricao: e.target.value })}
          maxLength={LIMITES_DO_PLANO.descricao}
          aria-describedby="plano-descricao-contador"
        />
        <p id="plano-descricao-contador" className="text-right text-xs text-muted-foreground">
          {(plano.descricao ?? "").length}/{LIMITES_DO_PLANO.descricao}
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t("Passos do plano")}</h3>
        {passos.map((passo, indice) => (
          <div key={indice} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {t("Passo")} {indice + 1}
              </span>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange({ ...plano, passos: plano.passos.filter((_, i) => i !== indice) })
                }
              >
                {t("Remover passo")}
              </Button>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`passo-titulo-${indice}`}>{t("Título")}</Label>
              <Input
                id={`passo-titulo-${indice}`}
                value={passo.titulo}
                onChange={(e) => mudarPasso(indice, { titulo: e.target.value })}
                placeholder={t("Ligar para {{contact.name}} sobre {{lead.title}}")}
                maxLength={LIMITES_DO_PLANO.tituloDoPasso}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {/*
                O PRAZO tem duas réguas (#4717 item 4). A de sempre conta os dias
                da APLICAÇÃO do plano; a nova conta da DATA DE UM CAMPO do card —
                é ela que faz "cobrar 7 dias antes da viagem" valer para todo
                negócio, cada um com a sua data. O passo continua um só: quem lê
                o JSON vê `prazo.modo` decidindo de onde o número conta.
              */}
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`passo-modo-${indice}`}>{t("O prazo conta de")}</Label>
                <Select
                  value={passo.prazo.modo}
                  onValueChange={(v) =>
                    mudarPasso(indice, {
                      // Trocar de régua ZERA o número: 7 dias antes (-7) e 7
                      // dias depois (7) são números opostos, e herdar o antigo
                      // inverteria o prazo sem ninguém pedir.
                      prazo:
                        v === "dias_a_partir_de_hoje"
                          ? { modo: "dias_a_partir_de_hoje", dias: 0 }
                          : { modo: "campo_de_data", campo: "", dias: 0 },
                    })
                  }
                >
                  <SelectTrigger id={`passo-modo-${indice}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dias_a_partir_de_hoje">{t("Do dia em que o plano é aplicado")}</SelectItem>
                    <SelectItem value="campo_de_data">{t("De um campo de data do card")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {passo.prazo.modo === "campo_de_data" ? (
                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`passo-campo-${indice}`}>{t("Campo de data")}</Label>
                  {/*
                    Lista, não chave digitada: quem monta o plano não sabe a
                    chave interna do campo, e uma letra trocada virava tarefa sem
                    prazo, em silêncio. Os campos são os de DATA do NEGÓCIO de
                    todos os funis — o plano vale para qualquer card —, como no
                    editor da ação "Gravar a data do atendimento num campo do negócio".
                  */}
                  <Select
                    value={passo.prazo.campo}
                    onValueChange={(v) =>
                      mudarPasso(indice, {
                        prazo: { modo: "campo_de_data", campo: v, dias: passo.prazo.dias },
                      })
                    }
                    disabled={carregandoFunis}
                  >
                    <SelectTrigger id={`passo-campo-${indice}`}>
                      <SelectValue placeholder={t("Escolha o campo")} />
                    </SelectTrigger>
                    <SelectContent>
                      {camposDeData.map((campo) => (
                        <SelectItem key={campo.chave} value={campo.chave}>
                          {campo.rotulo}
                        </SelectItem>
                      ))}
                      {/* Plano gravado pela API com uma chave que nenhum funil declara:
                          mostrada como é, para a pessoa ver e trocar — sumir com
                          ela deixaria o seletor vazio sem dizer por quê. */}
                      {chaveOrfa(passo.prazo, camposDeData, carregandoFunis) ? (
                        <SelectItem value={passo.prazo.campo}>
                          {t("«{c}» (não está em nenhum funil)").replace("{c}", passo.prazo.campo)}
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </Select>
                  {!carregandoFunis && camposDeData.length === 0 ? (
                    <p role="alert" className="text-xs text-destructive">
                      {t("Nenhum funil tem campo de data do negócio. Crie um nas configurações do funil.")}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="min-w-0 space-y-1">
                <Label htmlFor={`passo-prazo-${indice}`}>
                  {passo.prazo.modo === "campo_de_data" ? t("Dias antes (-) ou depois (+)") : t("Vence em (dias)")}
                </Label>
                <Input
                  id={`passo-prazo-${indice}`}
                  type="number"
                  min={passo.prazo.modo === "campo_de_data" ? -LIMITES_DO_PLANO.venceEmDias : 0}
                  max={LIMITES_DO_PLANO.venceEmDias}
                  step={1}
                  value={passo.prazo.dias}
                  onChange={(e) =>
                    mudarPasso(indice, {
                      prazo:
                        passo.prazo.modo === "campo_de_data"
                          ? { modo: "campo_de_data", campo: passo.prazo.campo, dias: Number(e.target.value) }
                          : { modo: "dias_a_partir_de_hoje", dias: Number(e.target.value) },
                    })
                  }
                />
              </div>

              <div className="space-y-1">
                <Label>{t("Prioridade")}</Label>
                <Select
                  value={passo.prioridade}
                  onValueChange={(v) => mudarPasso(indice, { prioridade: v as PrioridadeDaTarefa })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={rotuloDaPrioridade(t, passo.prioridade)} />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORIDADES_DA_TAREFA.map((p) => (
                      <SelectItem key={p} value={p}>
                        {rotuloDaPrioridade(t, p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>{t("Atribuir a")}</Label>
                <Select
                  value={
                    typeof passo.atribuir_a === "object" ? passo.atribuir_a.usuario_id : "dono_do_lead"
                  }
                  onValueChange={(v) =>
                    mudarPasso(indice, {
                      atribuir_a: v === "dono_do_lead" ? "dono_do_lead" : { usuario_id: v },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("Dono do negócio")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dono_do_lead">{t("Dono do negócio")}</SelectItem>
                    {(members ?? []).map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {rotuloDoMembro(m, t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          disabled={plano.passos.length >= LIMITES_DO_PLANO.passos}
          onClick={() => onChange({ ...plano, passos: [...plano.passos, novoPasso()] })}
        >
          {t("Adicionar passo")}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          "O que é salvo aqui é o que o editor de regras oferece na ação Aplicar um plano de tarefas.",
        )}
      </p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancelar}>
          {t("Cancelar")}
        </Button>
        <Button type="button" onClick={onGuardar} disabled={ocupado}>
          {ocupado ? t("Salvando…") : t("Salvar plano")}
        </Button>
      </div>
    </Card>
  );
}
