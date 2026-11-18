"use client";
/**
 * O cadastro do catálogo de serviços (#3480, fatia 2): lista, cria, edita e
 * desativa o que as rotas `/api/v1/servicos` já aceitam.
 *
 * ─── O que esta tela NÃO faz, e por quê ────────────────────────────────────
 *
 * - **Editar uma variação.** O `PATCH /api/v1/servicos/[id]` exige a revisão
 *   que quem edita viu, e a resposta montada (`VariacaoDoServico`) não traz a
 *   revisão da variação. Sem ela não há PATCH válido; a variação se desativa e
 *   se cadastra de novo.
 * - **Desativar pela rota de serviço.** O schema do PATCH de serviço não tem
 *   `ativo`. O serviço É um item do catálogo, e desativar um item é o
 *   `PATCH /api/v1/products/[id]` com `{ ativo }` — o mesmo botão da tela de
 *   produtos.
 */
import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { centavosParaTexto } from "@/lib/catalogo/edicao-do-produto";
import {
  TIPOS_DE_SERVICO,
  UNIDADES_POR_TIPO,
  type ServicoMontado,
  type TipoDeServico,
  type UnidadeDeCobranca,
} from "@/lib/catalogo/servicos";
import { formatCents } from "@/lib/money";
import { precoParaCentavos } from "@/lib/schemas/produtos";

const CHAVE = ["catalogo", "servicos"];
const CAMPO = "min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm";

const ROTULO_DO_TIPO: Record<TipoDeServico, string> = {
  hora_marcada: "Hora marcada",
  projeto: "Projeto",
  recorrente: "Plano recorrente",
};

const ROTULO_DA_UNIDADE: Record<UnidadeDeCobranca, string> = {
  sessao: "Por sessão",
  hora: "Por hora",
  valor_fechado: "Valor fechado",
  mes: "Por mês",
  trimestre: "Por trimestre",
  ano: "Por ano",
};

/** `valor_fechado` não tem sufixo: o preço é o inteiro, e "por projeto" soaria como parcela. */
const SUFIXO_DA_UNIDADE: Record<Exclude<UnidadeDeCobranca, "valor_fechado">, string> = {
  sessao: "por sessão",
  hora: "por hora",
  mes: "por mês",
  trimestre: "por trimestre",
  ano: "por ano",
};

interface Rascunho {
  codigo: string;
  nome: string;
  descricao: string;
  tipo: TipoDeServico;
  unidade: UnidadeDeCobranca;
  preco: string;
  prazo: string;
  sinalTipo: "" | "percentual" | "fixo";
  sinalValor: string;
  instrucoes: string;
  iaOferece: boolean;
}

const VAZIO: Rascunho = {
  codigo: "",
  nome: "",
  descricao: "",
  tipo: "hora_marcada",
  unidade: "sessao",
  preco: "",
  prazo: "",
  sinalTipo: "",
  sinalValor: "",
  instrucoes: "",
  iaOferece: true,
};

/**
 * O serviço na tela → o formulário. O preço só vem preenchido sem variações:
 * a resposta traz o "a partir de" (o menor da família), não o preço do próprio
 * principal, e preencher com ele gravaria o preço da variação mais barata no
 * principal ao salvar.
 */
function rascunhoDe(s: ServicoMontado): Rascunho {
  return {
    codigo: s.codigo,
    nome: s.nome,
    descricao: s.descricao ?? "",
    tipo: s.tipo,
    unidade: s.unidade,
    preco: s.variacoes.length === 0 ? centavosParaTexto(s.preco_a_partir_cents) : "",
    prazo: s.prazo_dias_uteis ? String(s.prazo_dias_uteis) : "",
    sinalTipo: s.sinal?.tipo ?? "",
    sinalValor: s.sinal ? (s.sinal.tipo === "fixo" ? centavosParaTexto(s.sinal.valor) : String(s.sinal.valor)) : "",
    instrucoes: s.instrucoes_ia ?? "",
    iaOferece: s.ia_oferece,
  };
}

/**
 * O formulário → o corpo da rota. No create o que está vazio fica de fora; na
 * edição vira `null`, porque é assim que se APAGA prazo, sinal e descrição.
 * A régua de verdade é do servidor (`problemasDoServico`); aqui só se recusa o
 * que nem dá para mandar (texto que não é número).
 */
function corpoDoRascunho(
  r: Rascunho,
  t: (s: string) => string,
  edicao?: { revision: number; precoOriginal: string },
): { corpo: Record<string, unknown> } | { erro: string } {
  const corpo: Record<string, unknown> = {
    codigo: r.codigo.trim(),
    nome: r.nome.trim(),
    tipo: r.tipo,
    unidade: r.unidade,
    ia_oferece: r.iaOferece,
  };
  const vazio = edicao ? null : undefined;
  corpo.descricao = r.descricao.trim() || vazio;
  corpo.instrucoes_ia = r.instrucoes.trim() || vazio;

  if (!edicao || r.preco.trim() !== edicao.precoOriginal) {
    const preco = precoParaCentavos(r.preco);
    if (preco === null) return { erro: t("Preço inválido. Escreva assim: 5.499,00") };
    corpo.preco_cents = preco;
  }

  corpo.prazo_dias_uteis = vazio;
  if (r.tipo === "projeto" && r.prazo.trim() !== "") {
    const prazo = Number(r.prazo.trim());
    if (!Number.isInteger(prazo) || prazo < 1) return { erro: t("O prazo é um número inteiro de dias úteis.") };
    corpo.prazo_dias_uteis = prazo;
  }

  corpo.sinal = vazio;
  if (r.sinalTipo === "percentual") {
    const valor = Number(r.sinalValor.trim().replace(",", "."));
    if (!Number.isFinite(valor) || valor < 1 || valor > 100) return { erro: t("O sinal em percentual vai de 1 a 100.") };
    corpo.sinal = { tipo: "percentual", valor };
  } else if (r.sinalTipo === "fixo") {
    const valor = precoParaCentavos(r.sinalValor);
    if (valor === null || valor < 1) return { erro: t("Sinal inválido. Escreva assim: 50,00") };
    corpo.sinal = { tipo: "fixo", valor };
  }

  if (edicao) corpo.expected_revision = edicao.revision;
  for (const chave of Object.keys(corpo)) if (corpo[chave] === undefined) delete corpo[chave];
  return { corpo };
}

function FormularioDoServico({
  servico,
  aoFechar,
}: {
  /** Ausente = cadastro novo. */
  servico?: ServicoMontado;
  aoFechar: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [inicial] = useState(() => (servico ? rascunhoDe(servico) : VAZIO));
  const [r, setR] = useState<Rascunho>(inicial);
  const id = servico?.id ?? "novo";
  const campo = (nome: string) => `servico-${id}-${nome}`;

  const salvar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) =>
      servico ? apiClient.patch(`/api/v1/servicos/${servico.id}`, corpo) : apiClient.post("/api/v1/servicos", corpo),
    onSuccess: () => {
      toast.success(servico ? t("Serviço atualizado") : t("Serviço cadastrado"));
      void qc.invalidateQueries({ queryKey: CHAVE });
      aoFechar();
    },
    onError: (erro) => {
      showApiError(erro);
      // 409 de revisão: outra pessoa salvou antes. Recarregar traz a versão nova.
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
  });

  function enviar() {
    const saida = corpoDoRascunho(
      r,
      t,
      servico ? { revision: servico.revision ?? 0, precoOriginal: inicial.preco } : undefined,
    );
    if ("erro" in saida) {
      toast.error(saida.erro);
      return;
    }
    salvar.mutate(saida.corpo);
  }

  function trocarTipo(tipo: TipoDeServico) {
    // Cada tipo só aceita a sua família de unidades: trocar o tipo leva a
    // unidade para a primeira compatível, em vez de deixar uma que a rota recusa.
    setR({ ...r, tipo, unidade: UNIDADES_POR_TIPO[tipo].includes(r.unidade) ? r.unidade : UNIDADES_POR_TIPO[tipo][0]! });
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4" data-testid="form-servico">
      <h2 className="text-sm font-semibold">{servico ? t("Editar serviço") : t("Novo serviço")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={campo("nome")}>{t("Nome")}</Label>
          <Input id={campo("nome")} value={r.nome} onChange={(e) => setR({ ...r, nome: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={campo("codigo")}>{t("Código")}</Label>
          <Input id={campo("codigo")} value={r.codigo} onChange={(e) => setR({ ...r, codigo: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={campo("tipo")}>{t("Tipo")}</Label>
          <select
            id={campo("tipo")}
            className={CAMPO}
            value={r.tipo}
            onChange={(e) => trocarTipo(e.target.value as TipoDeServico)}
          >
            {TIPOS_DE_SERVICO.map((tipo) => (
              <option key={tipo} value={tipo}>
                {t(ROTULO_DO_TIPO[tipo])}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={campo("unidade")}>{t("Cobrança")}</Label>
          <select
            id={campo("unidade")}
            className={CAMPO}
            value={r.unidade}
            onChange={(e) => setR({ ...r, unidade: e.target.value as UnidadeDeCobranca })}
          >
            {UNIDADES_POR_TIPO[r.tipo].map((unidade) => (
              <option key={unidade} value={unidade}>
                {t(ROTULO_DA_UNIDADE[unidade])}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={campo("preco")}>{t("Preço")}</Label>
          <Input
            id={campo("preco")}
            inputMode="decimal"
            placeholder="0,00"
            value={r.preco}
            onChange={(e) => setR({ ...r, preco: e.target.value })}
          />
          {servico && servico.variacoes.length > 0 ? (
            <p className="text-xs text-text-muted">{t("Deixe em branco para manter o preço atual deste serviço.")}</p>
          ) : null}
        </div>
        {r.tipo === "projeto" ? (
          <div className="space-y-1">
            <Label htmlFor={campo("prazo")}>{t("Prazo (dias úteis)")}</Label>
            <Input
              id={campo("prazo")}
              type="number"
              min={1}
              value={r.prazo}
              onChange={(e) => setR({ ...r, prazo: e.target.value })}
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={campo("sinal-tipo")}>{t("Sinal")}</Label>
          <select
            id={campo("sinal-tipo")}
            className={CAMPO}
            value={r.sinalTipo}
            onChange={(e) => setR({ ...r, sinalTipo: e.target.value as Rascunho["sinalTipo"], sinalValor: "" })}
          >
            <option value="">{t("Sem sinal")}</option>
            <option value="percentual">{t("Percentual do preço")}</option>
            <option value="fixo">{t("Valor fixo")}</option>
          </select>
        </div>
        {r.sinalTipo ? (
          <div className="space-y-1">
            <Label htmlFor={campo("sinal-valor")}>
              {r.sinalTipo === "percentual" ? t("Sinal (%)") : t("Valor do sinal")}
            </Label>
            <Input
              id={campo("sinal-valor")}
              inputMode="decimal"
              value={r.sinalValor}
              onChange={(e) => setR({ ...r, sinalValor: e.target.value })}
            />
          </div>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor={campo("descricao")}>{t("Descrição")}</Label>
        <Textarea
          id={campo("descricao")}
          rows={2}
          value={r.descricao}
          onChange={(e) => setR({ ...r, descricao: e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={campo("instrucoes")}>{t("Instruções para o agente")}</Label>
        <Textarea
          id={campo("instrucoes")}
          rows={2}
          value={r.instrucoes}
          onChange={(e) => setR({ ...r, instrucoes: e.target.value })}
        />
        <p className="text-xs text-text-muted">{t("Orientam a conversa. O agente não repete este texto ao cliente.")}</p>
      </div>
      <div className="flex items-start gap-2">
        <input
          id={campo("ia-oferece")}
          type="checkbox"
          className="mt-1 size-4"
          checked={r.iaOferece}
          onChange={(e) => setR({ ...r, iaOferece: e.target.checked })}
        />
        <Label htmlFor={campo("ia-oferece")}>{t("O agente pode oferecer este serviço")}</Label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={enviar} disabled={salvar.isPending}>
          {salvar.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
        <Button variant="outline" onClick={aoFechar} disabled={salvar.isPending}>
          {t("Cancelar")}
        </Button>
      </div>
    </section>
  );
}

function NovaVariacao({ paiId, aoFechar }: { paiId: string; aoFechar: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [nome, setNome] = useState("");
  const [codigo, setCodigo] = useState("");
  const [preco, setPreco] = useState("");
  const campo = (n: string) => `variacao-${paiId}-${n}`;

  const salvar = useMutation({
    mutationFn: (corpo: Record<string, unknown>) => apiClient.post("/api/v1/servicos", corpo),
    onSuccess: () => {
      toast.success(t("Variação cadastrada"));
      void qc.invalidateQueries({ queryKey: CHAVE });
      aoFechar();
    },
    onError: (erro) => showApiError(erro),
  });

  function enviar() {
    const centavos = precoParaCentavos(preco);
    if (centavos === null) {
      toast.error(t("Preço inválido. Escreva assim: 5.499,00"));
      return;
    }
    // A variação só tem nome, código e preço: tipo, unidade, prazo e sinal são
    // do principal, e a rota recusa a variação que os mande.
    salvar.mutate({ pai_id: paiId, nome: nome.trim(), codigo: codigo.trim(), preco_cents: centavos });
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="form-variacao">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={campo("nome")}>{t("Nome da variação")}</Label>
          <Input id={campo("nome")} value={nome} onChange={(e) => setNome(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={campo("codigo")}>{t("Código da variação")}</Label>
          <Input id={campo("codigo")} value={codigo} onChange={(e) => setCodigo(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={campo("preco")}>{t("Preço da variação")}</Label>
          <Input
            id={campo("preco")}
            inputMode="decimal"
            placeholder="0,00"
            value={preco}
            onChange={(e) => setPreco(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={enviar} disabled={salvar.isPending}>
          {t("Adicionar variação")}
        </Button>
        <Button size="sm" variant="outline" onClick={aoFechar} disabled={salvar.isPending}>
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );
}

type Pagina = { data: ServicoMontado[]; meta?: { pagina: number; has_more: boolean } };

export function ServicosClient({ podeEditar, moeda }: { podeEditar: boolean; moeda: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [criando, setCriando] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);
  const [variacaoDe, setVariacaoDe] = useState<string | null>(null);

  const consulta = useInfiniteQuery({
    queryKey: CHAVE,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => apiClient.get<Pagina>(`/api/v1/servicos?pagina=${pageParam}`),
    getNextPageParam: (ultima, todas) => (ultima.meta?.has_more ? todas.length + 1 : undefined),
  });

  const alternarAtivo = useMutation({
    // O serviço e a variação são itens do catálogo: desativar é o PATCH do item.
    mutationFn: ({ id, ativo }: { id: string; ativo: boolean }) => apiClient.patch(`/api/v1/products/${id}`, { ativo }),
    onSuccess: (_r, { ativo }) => {
      toast.success(ativo ? t("Reativado") : t("Desativado"));
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (erro) => showApiError(erro),
  });

  const preco = (cents: number, unidade: UnidadeDeCobranca) => {
    if (cents === 0) return t("Grátis");
    return unidade === "valor_fechado"
      ? formatCents(cents, moeda)
      : `${formatCents(cents, moeda)} ${t(SUFIXO_DA_UNIDADE[unidade])}`;
  };

  if (consulta.isPending) return <p className="text-sm text-text-muted">{t("Carregando…")}</p>;
  if (consulta.isError) {
    return (
      <div className="space-y-2 rounded-lg border border-border p-4" role="alert">
        <p className="text-sm">{t("Não consegui carregar os serviços.")}</p>
        <Button size="sm" variant="outline" onClick={() => void consulta.refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  const servicos = consulta.data.pages.flatMap((p) => p.data);

  return (
    <div className="flex flex-col gap-4" data-testid="tela-servicos">
      {podeEditar && !criando ? (
        <div>
          <Button onClick={() => setCriando(true)}>{t("Novo serviço")}</Button>
        </div>
      ) : null}
      {criando ? <FormularioDoServico aoFechar={() => setCriando(false)} /> : null}

      {servicos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center" data-testid="servicos-vazio">
          <p className="font-medium">{t("Nenhum serviço cadastrado ainda")}</p>
          <p className="mt-1 text-sm text-text-muted">
            {t("Enquanto não houver serviço aqui, o agente não tem preço, prazo nem sinal para responder.")}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {servicos.map((s) =>
            editando === s.id ? (
              <li key={s.id}>
                <FormularioDoServico servico={s} aoFechar={() => setEditando(null)} />
              </li>
            ) : (
              <li key={s.id} className="space-y-3 rounded-lg border border-border p-4" data-testid="servico">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium break-words">
                      {s.nome} <span className="text-sm text-text-muted">· {s.codigo}</span>
                    </p>
                    <p className="text-sm text-text-muted">
                      {t(ROTULO_DO_TIPO[s.tipo])} ·{" "}
                      {/* ponytail: "a partir de" sempre que há variação. A resposta
                          não traz o preço do próprio principal, então a regra exata
                          (mais de um preço distinto) não é calculável aqui. */}
                      {s.variacoes.length > 0 ? `${t("a partir de")} ` : ""}
                      {preco(s.preco_a_partir_cents, s.unidade)}
                      {s.prazo_dias_uteis ? ` · ${s.prazo_dias_uteis} ${t("dias úteis")}` : ""}
                      {s.sinal?.cents != null
                        ? ` · ${t("sinal de")} ${formatCents(s.sinal.cents, moeda)}${s.sinal.tipo === "percentual" ? ` (${s.sinal.valor}%)` : ""}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {!s.ativo ? <Badge variant="neutral">{t("Inativo")}</Badge> : null}
                    {!s.ia_oferece ? <Badge variant="warning">{t("O agente não oferece")}</Badge> : null}
                  </div>
                </div>

                {s.variacoes.length > 0 ? (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {s.variacoes.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                        <span className="min-w-0 break-words">
                          {v.nome} <span className="text-text-muted">· {v.codigo}</span>
                          {!v.ativo ? <span className="text-text-muted"> · {t("Inativo")}</span> : null}
                        </span>
                        <span className="flex flex-wrap items-center gap-2">
                          <span>{preco(v.preco_cents, s.unidade)}</span>
                          {podeEditar ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => alternarAtivo.mutate({ id: v.id, ativo: !v.ativo })}
                            >
                              {v.ativo ? t("Desativar") : t("Reativar")}
                            </Button>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {variacaoDe === s.id ? <NovaVariacao paiId={s.id} aoFechar={() => setVariacaoDe(null)} /> : null}

                {podeEditar ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditando(s.id)} disabled={s.revision === null}>
                      {t("Editar")}
                    </Button>
                    {variacaoDe !== s.id ? (
                      <Button size="sm" variant="outline" onClick={() => setVariacaoDe(s.id)}>
                        {t("Nova variação")}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => alternarAtivo.mutate({ id: s.id, ativo: !s.ativo })}>
                      {s.ativo ? t("Desativar") : t("Reativar")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ),
          )}
        </ul>
      )}

      {consulta.hasNextPage ? (
        <div>
          <Button variant="outline" onClick={() => void consulta.fetchNextPage()} disabled={consulta.isFetchingNextPage}>
            {consulta.isFetchingNextPage ? t("Carregando…") : t("Ver mais serviços")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
