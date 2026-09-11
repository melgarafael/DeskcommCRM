"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  conexoesExternasQueryKey,
  removerConexao,
  testarConexao,
  useConexoesExternas,
  type ConexaoExternaRow,
} from "@/hooks/external-db/useConexoesExternas";
import { useT } from "@/hooks/i18n/useT";
import { PencilSimple, Plus, PlugsConnected, Trash } from "@/lib/ui/icons";

import { FormularioDeConexao } from "./FormularioDeConexao";

interface Props {
  initialData: ConexaoExternaRow[];
  canWrite: boolean;
}

function EstadoDaConexao({ conexao }: { conexao: ConexaoExternaRow }) {
  const t = useT();
  if (!conexao.enabled) {
    return <Badge variant="secondary">{t("Desativada")}</Badge>;
  }
  if (conexao.last_test_ok === true) {
    return <Badge variant="success">{t("Conectada")}</Badge>;
  }
  if (conexao.last_test_ok === false) {
    return <Badge variant="error">{t("Falha no último teste")}</Badge>;
  }
  return <Badge variant="outline">{t("Não testada")}</Badge>;
}

export function ListaDeConexoes({ initialData, canWrite }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useConexoesExternas({ initialData });
  const [formAberto, setFormAberto] = useState(false);
  const [emEdicao, setEmEdicao] = useState<ConexaoExternaRow | null>(null);
  const [paraRemover, setParaRemover] = useState<ConexaoExternaRow | null>(null);
  const [testando, setTestando] = useState<string | null>(null);

  const conexoes = data ?? [];

  async function testar(conexao: ConexaoExternaRow) {
    setTestando(conexao.id);
    try {
      const resultado = await testarConexao(conexao.id);
      if (resultado.ok) {
        toast.success(t("Conexão bem-sucedida."));
      } else {
        toast.error(resultado.erro ? t(resultado.erro) : t("Não foi possível conectar."));
      }
      await qc.invalidateQueries({ queryKey: conexoesExternasQueryKey });
    } catch (err) {
      showApiError(err);
    } finally {
      setTestando(null);
    }
  }

  async function remover() {
    if (!paraRemover) return;
    try {
      await removerConexao(paraRemover.id);
      toast.success(t("Conexão removida."));
      await qc.invalidateQueries({ queryKey: conexoesExternasQueryKey });
    } catch (err) {
      showApiError(err);
    } finally {
      setParaRemover(null);
    }
  }

  function abrirNova() {
    setEmEdicao(null);
    setFormAberto(true);
  }

  function abrirEdicao(conexao: ConexaoExternaRow) {
    setEmEdicao(conexao);
    setFormAberto(true);
  }

  if (conexoes.length === 0) {
    return (
      <>
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <PlugsConnected size={28} aria-hidden className="text-muted-foreground" />
          <h2 className="font-medium">{t("Nenhum banco externo conectado ainda")}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t(
              "Quando o seu outro sistema escreve num PostgreSQL, conecte-o aqui e o agente passa a responder com esses dados — pedido, assinatura, matrícula, saldo.",
            )}
          </p>
          {canWrite && (
            <Button className="mt-1" onClick={abrirNova}>
              <Plus size={14} aria-hidden className="mr-2" /> {t("Conectar banco de dados")}
            </Button>
          )}
        </Card>

        {formAberto && (
          <FormularioDeConexao open onOpenChange={setFormAberto} conexao={emEdicao} />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {conexoes.length === 1 ? t("1 conexão") : `${conexoes.length} ${t("conexões")}`}
        </h2>
        {canWrite && (
          <Button size="sm" onClick={abrirNova}>
            <Plus size={14} aria-hidden className="mr-2" /> {t("Nova conexão")}
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {conexoes.map((conexao) => (
          <Card key={conexao.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <Link
                  href={`/app/integracao-dados/${conexao.id}`}
                  className="truncate font-medium hover:underline"
                >
                  {conexao.label}
                </Link>
                <EstadoDaConexao conexao={conexao} />
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {conexao.host}:{conexao.port}/{conexao.database_name} · {conexao.username}
              </p>
              {conexao.last_test_ok === false && conexao.last_test_error && (
                <p className="truncate text-xs text-destructive">{conexao.last_test_error}</p>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href={`/app/integracao-dados/${conexao.id}`}>{t("Explorar")}</Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={testando === conexao.id}
                onClick={() => testar(conexao)}
              >
                {testando === conexao.id ? t("Testando…") : t("Testar")}
              </Button>
              {canWrite && (
                <>
                  <Button variant="ghost" size="icon" aria-label={t("Editar")} onClick={() => abrirEdicao(conexao)}>
                    <PencilSimple size={16} aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("Remover")}
                    onClick={() => setParaRemover(conexao)}
                  >
                    <Trash size={16} aria-hidden />
                  </Button>
                </>
              )}
            </div>
          </Card>
        ))}
      </div>

      {formAberto && <FormularioDeConexao open onOpenChange={setFormAberto} conexao={emEdicao} />}

      <AlertDialog open={paraRemover !== null} onOpenChange={(aberto) => !aberto && setParaRemover(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remover esta conexão?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "A senha guardada é apagada e o agente deixa de enxergar esse banco. O banco de origem não é tocado — só a conexão daqui.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={remover}>{t("Remover")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
