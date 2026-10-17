"use client";

import { useState } from "react";

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

function receitasDisponiveis(motor: "mysql" | "postgres"): DefinicaoDeReceita[] {
  return [...RECEITAS.values()].filter((r) => r.motores.includes(motor));
}

export default function ReceitasProntas({ connectionId, motor, canWrite }: Props) {
  const t = useT();
  const query = useReceitasDaConexao(connectionId);
  const [rascunho, setRascunho] = useState<InstanciaDeReceita[]>([]);
  const [editando, setEditando] = useState<InstanciaDeReceita | null>(null);
  const [preview, setPreview] = useState<{
    instancia: { id: string; receita: string; rotulo: string };
    colunas: string[];
    linhas: Record<string, unknown>[];
    linhas_devolvidas: number;
    truncado?: boolean;
  } | null>(null);
  const [previewando, setPreviewando] = useState(false);

  const receitas = query.data?.receitas ?? [];

  const jaCadastradas = new Set(receitas.map((r) => r.receita));
  const opcoes = receitasDisponiveis(motor).filter((r) => !jaCadastradas.has(r.id));

  const salvar = async () => {
    if (!canWrite) return;
    try {
      await salvarReceitas(connectionId, rascunho);
      toast.success(t("Salvo."));
      setEditando(null);
    } catch (err) {
      showApiError(err);
    }
  };

  const adicionar = () => {
    if (!canWrite) return;
    const nova: InstanciaDeReceita = {
      id: crypto.randomUUID(),
      receita: "",
      rotulo: "",
      descricao: "",
      fixos: { prefixo: PREFIXO_PADRAO },
      ativa: true,
    };
    setRascunho([...rascunho, nova]);
    setEditando(nova);
  };

  const editar = (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setEditando(inst);
    setRascunho(rascunho.map((i) => (i.id === inst.id ? inst : i)));
  };

  const remover = async (id: string) => {
    if (!canWrite) return;
    setRascunho(rascunho.filter((i) => i.id !== id));
    if (editando?.id === id) setEditando(null);
    try {
      await salvarReceitas(connectionId, rascunho.filter((i) => i.id !== id));
    } catch (err) {
      showApiError(err);
    }
  };

  const executarPreview = async (inst: InstanciaDeReceita) => {
    if (!canWrite) return;
    setPreviewando(true);
    try {
      const resultado = await previewReceita(connectionId, inst.id, inst.fixos);
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
          const editandoEsta = editando?.id === inst.id;
          const cols =
            inst.fixos && typeof inst.fixos === "object" && "prefixo" in inst.fixos
              ? String((inst.fixos as { prefixo?: string }).prefixo ?? PREFIXO_PADRAO)
              : PREFIXO_PADRAO;

          if (editandoEsta && canWrite) {
            return (
              <Card key={inst.id} className="border border-border p-3 mb-2">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="col-span-1 md:col-span-2">
                    <Label className="text-xs text-muted-foreground">{t("Rótulo")}</Label>
                    <Input
                      value={inst.rotulo}
                      onChange={(e) => {
                        const prox = { ...inst, rotulo: e.target.value };
                        editar(prox);
                        setRascunho(rascunho.map((i) => (i.id === inst.id ? prox : i)));
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Descrição")}</Label>
                    <Input
                      value={inst.descricao}
                      onChange={(e) => {
                        const prox = { ...inst, descricao: e.target.value };
                        editar(prox);
                        setRascunho(rascunho.map((i) => (i.id === inst.id ? prox : i)));
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Prefixo das tabelas")}</Label>
                    <Input
                      value={cols}
                      onChange={(e) => {
                        const valor = e.target.value;
                        if (!PREFIXO_REGEX.test(valor)) return;
                        const prox = { ...inst, fixos: { ...(inst.fixos as object), prefixo: valor } };
                        editar(prox);
                        setRascunho(rascunho.map((i) => (i.id === inst.id ? prox : i)));
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
                        editar(prox);
                        setRascunho(rascunho.map((i) => (i.id === inst.id ? prox : i)));
                      }}
                    />
                    <Label className="text-xs ml-2 text-muted-foreground">{t("Ativa")}</Label>
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <Button size="sm" onClick={salvar}>
                    {t("Salvar")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditando(null)}>
                    {t("Cancelar")}
                  </Button>
                  <Button size="sm" onClick={() => executarPreview(inst)} disabled={previewando}>
                    {previewando ? t("Pré-visualizando…") : t("Pré-visualizar")}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => remover(inst.id)}>
                    {t("Remover")}
                  </Button>
                </div>
                {preview && preview.instancia.id === inst.id && (
                  <div className="mt-3 border-t pt-2">
                    <p className="text-xs text-muted-foreground mb-1">
                      {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas} {t("linhas")}
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
              <div className="flex flex-row items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{inst.rotulo || (receita?.rotulo ?? inst.receita)}</p>
                  <p className="text-xs text-muted-foreground">{inst.descricao || (receita?.descricao ?? "")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("Prefixo:")} <span className="font-mono">{cols}</span>
                  </p>
                </div>
                <div className="flex gap-1">
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
                    <Button size="sm" variant="destructive" onClick={() => remover(inst.id)}>
                      {t("Remover")}
                    </Button>
                  )}
                </div>
              </div>
              {preview && preview.instancia.id === inst.id && (
                <div className="mt-3 border-t pt-2">
                  <p className="text-xs text-muted-foreground mb-1">
                    {t("Pré-visualização (até 5 linhas)")} — {preview.linhas_devolvidas} {t("linhas")}
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
