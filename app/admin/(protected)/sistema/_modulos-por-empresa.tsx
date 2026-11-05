"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { updateModuloDaEmpresa } from "@/app/actions/settings/updateModuloDaEmpresa";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { MENSAGEM_DA_RECUSA_DE_ESCRITA, ehRecusaDeEscrita } from "@/lib/auth/recusa-de-escrita-de-admin";
import type {
  EmpresaDosModulos,
  EstadoDoModuloNaEmpresa,
  ModuloNaEmpresa,
} from "@/lib/instalacao/modulos-por-empresa";

import { MODULOS_NA_TELA } from "./_form";

/** O valor do Select para "nenhuma empresa escolhida" — o Radix não aceita string vazia. */
const NENHUMA = "nenhuma";

/**
 * O BLOCO "POR EMPRESA" (#3868) — a exceção de UMA empresa sobre o módulo da
 * instalação.
 *
 * Três estados, e o do meio é o do produto até hoje:
 *
 *   - `Herda` (sem linha): a empresa segue o interruptor da instalação. Quem nunca
 *     mexer aqui não sente diferença — é o padrão;
 *   - `Ligado`: a empresa tem o módulo (se a instalação também tiver);
 *   - `Desligado`: a empresa não tem, mesmo com a instalação ligada. E NADA é
 *     apagado: os dados do módulo continuam lá e voltam ao religar.
 *
 * A instalação é TETO: módulo desligado em "Módulos" acima não se liga para
 * ninguém, e a linha explica isso em vez de oferecer um interruptor que não faz
 * nada (`bloqueadoPelaInstalacao`).
 *
 * A escolha salva no clique e volta no erro, como os cartões vizinhos — e o
 * registro de quem trocou fica na auditoria (`organization.modulo_updated`).
 */
export function FormularioDeModulosPorEmpresa({
  empresas,
  empresaId,
  modulos,
}: {
  /** `null` = a lista não pôde ser lida; o seletor fica travado em vez de mentir. */
  empresas: readonly EmpresaDosModulos[] | null;
  empresaId: string | null;
  /** `null` = nenhuma empresa escolhida, ou a leitura dela falhou. */
  modulos: readonly ModuloNaEmpresa[] | null;
}) {
  const t = useT();
  const router = useRouter();
  const [estados, setEstados] = useState<ReadonlyMap<string, EstadoDoModuloNaEmpresa>>(
    () => new Map((modulos ?? []).map((m) => [m.modulo, m.estado])),
  );
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();
  const [trocandoDeEmpresa, startTroca] = useTransition();

  function trocarEmpresa(valor: string) {
    const alvo = valor === NENHUMA ? null : valor;
    startTroca(() => {
      router.push(alvo ? `/admin/sistema?empresa=${alvo}#modulos-por-empresa` : "/admin/sistema#modulos-por-empresa");
    });
  }

  function trocar(modulo: ModuloNaEmpresa["modulo"], valor: string) {
    if (!empresaId) return;
    const estado = valor as EstadoDoModuloNaEmpresa;
    const anterior = estados.get(modulo) ?? "herda";
    setErro(null);
    setEstados((atual) => new Map(atual).set(modulo, estado));
    startTransition(async () => {
      const r = await updateModuloDaEmpresa({ organizationId: empresaId, modulo, estado });
      if (!r.ok) {
        // Volta explícita: deixar a tela dizendo "ligado" com a gravação recusada
        // mostraria um módulo que a empresa não tem.
        setEstados((atual) => new Map(atual).set(modulo, anterior));
        setErro(
          t(
            ehRecusaDeEscrita(r.error)
              ? MENSAGEM_DA_RECUSA_DE_ESCRITA[r.error]
              : r.error === "modulo_desligado_na_instalacao"
                ? "Este módulo está desligado nesta instalação. Ligue-o em “Módulos”, acima, antes de dar a alguma empresa."
                : r.error === "organizacao_inexistente"
                  ? "Esta empresa não existe mais. Recarregue a página."
                  : r.error === "modulo_ainda_nao_disponivel"
                    ? "Este módulo ainda não pode ser ligado nesta versão."
                    : "Não deu para salvar. Tente de novo em instantes.",
          ),
        );
      }
    });
  }

  return (
    <Card id="modulos-por-empresa" data-testid="modulos-por-empresa">
      <CardHeader>
        <CardTitle>{t("Módulos por empresa")}</CardTitle>
        <CardDescription>
          {t(
            "Aqui você dá um módulo a uma empresa sem ligá-lo para as outras. Quem ficar em “Herdar” continua com o que a instalação decidiu — e desligar não apaga nada: o que a empresa já tem volta ao religar.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="empresa-dos-modulos" className="text-base">
              {t("Empresa")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t("O módulo ligado acima continua valendo para todas; aqui você abre exceções.")}
            </p>
          </div>
          <Select
            value={empresaId ?? NENHUMA}
            onValueChange={trocarEmpresa}
            disabled={trocandoDeEmpresa || empresas === null}
          >
            <SelectTrigger
              id="empresa-dos-modulos"
              className="w-full sm:w-[280px]"
              aria-label={t("Empresa")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NENHUMA}>{t("Nenhuma (só o padrão da instalação)")}</SelectItem>
              {(empresas ?? []).map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.ativa ? e.nome : `${e.nome} (${t("não está ativa")})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {empresas === null && (
          <p className="text-sm text-destructive" role="alert">
            {t("Não deu para ler a lista de empresas agora. Recarregue a página em instantes.")}
          </p>
        )}

        {empresaId !== null && modulos === null && (
          <p className="text-sm text-destructive" role="alert">
            {t("Não deu para ler os módulos desta empresa agora. Recarregue a página em instantes.")}
          </p>
        )}

        {modulos !== null && (
          <ul className="space-y-3">
            {MODULOS_NA_TELA.filter((linha) => modulos.some((m) => m.modulo === linha.modulo)).map((linha) => {
              const m = modulos.find((x) => x.modulo === linha.modulo);
              if (!m) return null;
              const estado = estados.get(m.modulo) ?? m.estado;
              return (
                <li
                  key={m.modulo}
                  className="flex flex-wrap items-start justify-between gap-4 rounded-lg border p-4"
                  data-testid={`modulo-da-empresa-${m.modulo}`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Label htmlFor={`empresa-${m.modulo}`} className="text-base">
                      {t(linha.rotulo)}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {m.bloqueadoPelaInstalacao
                        ? t(
                            "Desligado nesta instalação: nenhuma empresa tem este módulo, e não dá para ligá-lo só para uma. Ligue-o em “Módulos”, acima.",
                          )
                        : estado === "herda"
                          ? t("Herdando a instalação: é o que vale hoje para esta empresa.")
                          : estado === "ligado"
                            ? t("Ligado só para esta empresa.")
                            : t("Desligado para esta empresa. Nenhum dado foi apagado.")}
                    </p>
                  </div>
                  <Select
                    value={estado}
                    onValueChange={(valor) => trocar(m.modulo, valor)}
                    disabled={pendente || m.bloqueadoPelaInstalacao}
                  >
                    <SelectTrigger
                      id={`empresa-${m.modulo}`}
                      className="w-full sm:w-[200px]"
                      aria-label={t(linha.rotulo)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="herda">{t("Herdar da instalação")}</SelectItem>
                      <SelectItem value="ligado">{t("Ligado")}</SelectItem>
                      <SelectItem value="desligado">{t("Desligado")}</SelectItem>
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">
          {t(
            "Cobrança dos seus clientes, login do Codex, Honorários e Financeiro não entram aqui: os dois primeiros são decisão só desta instalação, e os dois últimos são módulos de tabela, com tela própria.",
          )}
        </p>

        {erro && (
          <p className="text-sm text-destructive" role="alert">
            {erro}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
