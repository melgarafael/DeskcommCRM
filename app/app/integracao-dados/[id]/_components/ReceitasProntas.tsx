"use client";

import { useId, useMemo, useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

import { previewReceita, salvarReceitas, useReceitasDaConexao } from "@/hooks/external-db/useReceitasDaConexao";
import { randomId } from "@/lib/random-id";
import { ApiError } from "@/lib/api/types";
import { useT } from "@/hooks/i18n/useT";
import { RECEITAS, receitaDe } from "@/lib/external-db/receitas/registro";
import type { InstanciaDeReceita } from "@/lib/external-db/receitas/tipos";
import type { DefinicaoDeReceita } from "@/lib/external-db/receitas/tipos";

interface Props {
  connectionId: string;
  /** Só mostra para conexão mysql. */
  motor: "mysql" | "postgres";
  /** Só o administrador edita; os demais só leem. */
  canWrite: boolean;
}

const PREFIXO_PADRAO = "wp_";
const PREFIXO_REGEX = /^[A-Za-z0-9_]{1,20}$/;
const BUSCA_PADRAO = { limite: 5 };

function receitasDisponiveis(motor: "mysql" | "postgres"): DefinicaoDeReceita[] {
  return [...RECEITAS.values()].filter((r) => r.motores.includes(motor));
}

export default function ReceitasProntas({ connectionId, motor, canWrite }: Props) {
  const t = useT();
  const query = useReceitasDaConexao(connectionId);
  const idInputRotulo = useId();
  const idInputDescricao = useId();
  const idInputPrefixo = useId();

  // Uma linha em edição (rascunho local, ainda não salvo). A lista completa
  // sempre deriva do servidor (query.data) + o rascunho em edição, então
  // acompanha o servidor após cada refetch sem setState síncrono em efeito.
  const [rascunho, setRascunho] = useState<InstanciaDeReceita | null>(null);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    instancia: { id: string; receita: string; rotulo: string };
    colunas: string[];
    linhas: Record<string, unknown>[];
    linhas_devolvidas: number;
    truncado?: boolean;
  } | null>(null);
  const [previewando, setPreviewando] = useState(false);

  const lista = useMemo(() => {
    const base = [...(query.data?.receitas ?? [])];
    if (rascunho) {
      const idx = base.findIndex((i) => i.id === rascunho.id);
      if (idx >= 0) base[idx] = rascunho;
      else base.push(rascunho);
    }
    return base;
  }, [query.data, rascunho]);

  const receitas = lista;
  const jaCadastradas = new Set(receitas.map((r) => r.receita));
  const opcoes = receitasDisponiveis(motor).filter((r) => !jaCadastradas.has(r.id));

  const salvar = async () => {
    if (!canWrite) return;
    try {
      await salvarReceitas(connectionId, lista);
      toast.success(t("Salvo."));
      setRascunho(null);
      await query.refetch();
    } catch (err) {
      // 422 de validação do Zod: a rota devolve `details.fieldErrors` com o
      // campo que falhou. Mostra qual campo e por quê, em vez do genérico
      // "Campos inválidos."
      if (err instanceof ApiError && err.code === "validation_failed") {
        const fieldErrors = (err.details as
          | { fieldErrors?: Record<string, string[]> }
          | undefined)?.fieldErrors;
        const campo = fieldErrors ? Object.keys(fieldErrors)[0] : undefined;
        const motivo = fieldErrors && campo ? fieldErrors[campo]?.[0] : undefined;
        if (fieldErrors && campo) {
          const rotuloDoCampo: Record<string, string> = {
            descricao: t("Descrição"),
            rotulo: t("Rótulo"),
          };
          const label = rotuloDoCampo[campo] ?? campo;
          toast.error(
            t("O campo {campo} não pôde ser salvo: {motivo}")
              .replace("{campo}", label)
              .replace("{motivo}", t(motivo ?? "")),
          );
          return;
        }
      }
      showApiError(err);
    }
  };

  const adicionar = () => {
    if (!canWrite) return;
    const primeira = opcoes[0];
    if (!primeira) return;
    const receita = receitaDe(primeira.id);
    const nova: InstanciaDeReceita = {
      id: randomId(),
      receita: primeira.id,
      rotulo: receita?.rotulo ?? primeira.id,
      descricao: "",
      fixos: { prefixo: PREFIXO_PADRAO },
      ativa: true,
    };
    setRascunho(nova);
  };

  const editar = (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setRascunho(inst);
  };

  const remover = async (id: string) => {
    if (!canWrite) return;
    setConfirmandoRemocao(id);
  };

  const confirmarRemocao = async () => {
    if (!confirmandoRemocao) return;
    const prox = lista.filter((i) => i.id !== confirmandoRemocao);
    setConfirmandoRemocao(null);
    try {
      await salvarReceitas(connectionId, prox);
      await query.refetch();
    } catch (err) {
      showApiError(err);
    }
  };

  const cancelarRemocao = () => {
    setConfirmandoRemocao(null);
  };

  const executarPreview = async (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setPreviewando(true);
    try {
      const resultado = await previewReceita(connectionId, inst.id, BUSCA_PADRAO);
      setPreview(resultado);
    } catch (err) {
      showApiError(err);
      setPreview(null);
    } finally {
      setPreviewando(false);
    }
  };

  if (motor !== "mysql") return null;
  if (opcoes.length === 0 && receitas.length === 0) return null;

  // Query falhou: nunca fica em silêncio (Living System, item 1). Mostra mensagem
  // legível com botão para tentar de novo.
  if (query.isError) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("Não foi possível carregar as receitas.")}{" "}
        <Button size="sm" onClick={() => query.refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  return (
    <Card className="border border-border">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm font-semibold">{t("Receitas prontas")}</CardTitle>
        {canWrite && opcoes.length > 0 && (
          <Button size="sm" onClick={adicionar}>
            {t("Adicionar receita")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!query.data && <p className="text-sm text-muted-foreground">{t("Carregando receitas…")}</p>}
        {query.data && receitas.length === 0 && canWrite && (
          <p className="text-sm text-muted-foreground">
            {t("Nenhuma receita cadastrada ainda. Adicione uma para o assistente consultar o banco de origem.")}
          </p>
        )}

        {receitas.map((inst) => {
          const receita = receitaDe(inst.receita);
          const editandoEsta = rascunho?.id === inst.id;
          const cols =
            inst.fixos && typeof inst.fixos === "object" && "prefixo" in inst.fixos
              ? String((inst.fixos as { prefixo?: string }).prefixo ?? PREFIXO_PADRAO)
              : PREFIXO_PADRAO;

          if (editandoEsta && canWrite) {
            return (
              <Card key={inst.id} className="border border-border p-3 mb-2">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="col-span-1 md:col-span-2">
                    <Label htmlFor={idInputRotulo} className="text-xs text-muted-foreground">
                      {t("Rótulo")}
                    </Label>
                    <Input
                      id={idInputRotulo}
                      maxLength={80}
                      value={inst.rotulo}
                      onChange={(e) => {
                        const prox = { ...inst, rotulo: e.target.value };
                        setRascunho(prox);
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={idInputDescricao} className="text-xs text-muted-foreground">
                      {t("Descrição")}
                    </Label>
                    <Input
                      id={idInputDescricao}
                      maxLength={300}
                      value={inst.descricao}
                      onChange={(e) => {
                        const prox = { ...inst, descricao: e.target.value };
                        setRascunho(prox);
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor={idInputPrefixo} className="text-xs text-muted-foreground">
                      {t("Prefixo das tabelas")}
                    </Label>
                    <Input
                      id={idInputPrefixo}
                      value={cols}
                      onChange={(e) => {
                        const valor = e.target.value;
                        if (!PREFIXO_REGEX.test(valor)) return;
                        const prox = { ...inst, fixos: { ...(inst.fixos as object), prefixo: valor } };
                        setRascunho(prox);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("O prefixo aparece antes de _posts no banco do WordPress (padrão wp_).")}
                    </p>
                  </div>
                  <div className="col-span-1 md:col-span-1 flex items-end">
                    <Switch
                      checked={inst.ativa}
                      onCheckedChange={(ativa) => {
                        const prox = { ...inst, ativa };
                        setRascunho(prox);
                      }}
                    />
                    <Label className="text-xs ml-2 text-muted-foreground">{t("Ativa")}</Label>
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <Button size="sm" onClick={salvar}>
                    {t("Salvar")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setRascunho(null)}>
                    {t("Cancelar")}
                  </Button>
                  <Button size="sm" onClick={() => executarPreview(inst)} disabled={previewando}>
                    {previewando ? t("Pré-visualizando…") : t("Pré-visualizar")}
                  </Button>
                  {canWrite && (
                    <>
                      {confirmandoRemocao === inst.id ? (
                        <>
                          <Button size="sm" variant="outline" onClick={confirmarRemocao}>
                            {t("Sim")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelarRemocao}>
                            {t("Não")}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="destructive" onClick={() => remover(inst.id)}>
                          {t("Remover")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {preview && preview.instancia.id === inst.id && (
                  <div className="mt-3 border-t pt-2">
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas} {preview.linhas_devolvidas === 1 ? t("linha") : t("linhas")}
                      {preview.truncado ? ` · ${t("truncado")}` : ""}
                    </p>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {preview.colunas.map((c) => (
                              <TableCell key={c} className="text-xs font-medium">{c}</TableCell>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.linhas.map((linha, i) => (
                            <TableRow key={i}>
                              {preview.colunas.map((c) => (
                                <TableCell key={c} className="text-xs">
                                  {String(linha[c] ?? "")}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </Card>
            );
          }

          return (
            <Card key={inst.id} className="border border-border p-3 mb-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{inst.rotulo || (receita?.rotulo ?? inst.receita)}</p>
                  <p className="text-xs text-muted-foreground min-w-0 break-words">{inst.descricao || (receita?.descricao ?? "")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("Prefixo:")} <span className="font-mono">{cols}</span>
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Badge variant={inst.ativa ? "success" : "secondary"}>
                    {inst.ativa ? t("Ativa") : t("Inativa")}
                  </Badge>
                  {canWrite && (
                    <Button size="sm" variant="outline" onClick={() => editar(inst)}>
                      {t("Editar")}
                    </Button>
                  )}
                  {canWrite && (
                    <Button size="sm" onClick={() => executarPreview(inst)} disabled={previewando}>
                      {previewando ? t("Pré-visualizando…") : t("Pré-visualizar")}
                    </Button>
                  )}
                  {canWrite && (
                    <>
                      {confirmandoRemocao === inst.id ? (
                        <>
                          <Button size="sm" variant="outline" onClick={confirmarRemocao}>
                            {t("Sim")}
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelarRemocao}>
                            {t("Não")}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="destructive" onClick={() => remover(inst.id)}>
                          {t("Remover")}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {preview && preview.instancia.id === inst.id && (
                <div className="mt-3 border-t pt-2">
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas} {preview.linhas_devolvidas === 1 ? t("linha") : t("linhas")}
                    {preview.truncado ? ` · ${t("truncado")}` : ""}
                  </p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {preview.colunas.map((c) => (
                            <TableCell key={c} className="text-xs font-medium">{c}</TableCell>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.linhas.map((linha, i) => (
                          <TableRow key={i}>
                            {preview.colunas.map((c) => (
                              <TableCell key={c} className="text-xs">
                                {String(linha[c] ?? "")}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </CardContent>
    </Card>
  );
}
