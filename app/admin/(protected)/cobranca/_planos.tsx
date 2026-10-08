"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import type { Intervalo } from "@/lib/cobranca/vocabulario";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { novoPlanoSchema } from "@/lib/schemas/cobranca-plano";

/** Um plano de `cobranca_planos` como a tela o recebe (COLUNAS_DO_PLANO). */
export interface PlanoDaTela {
  id: string;
  nome: string;
  preco_cents: number;
  intervalo: Intervalo;
  trial_dias: number;
  max_assentos: number | null;
  max_canais: number | null;
  teto_ia_usd_cents: number | null;
  padrao_no_cadastro: boolean;
  /** false = só o dono atribui (plano negociado): a empresa não o vê nem o escolhe. */
  oferecido_ao_cliente: boolean;
  arquivado_em: string | null;
}

interface Campos {
  nome: string;
  preco: string;
  intervalo: Intervalo;
  trial_dias: string;
  max_assentos: string;
  max_canais: string;
  teto_ia: string;
}

const VAZIO: Campos = { nome: "", preco: "", intervalo: "mes", trial_dias: "14", max_assentos: "", max_canais: "", teto_ia: "" };
const AVISO_DE_CAMPOS =
  "Confira os campos do plano: preço a partir de R$ 5,00, teste grátis de 0 a 90 dias e limites a partir de 1.";

const centavos = (v: string) => Math.round(Number(v.replace(",", ".")) * 100);
const inteiroOuNulo = (v: string) => (v.trim() === "" ? null : Number(v));
const decimal = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/** O corpo que as rotas de plano recebem. Campo de limite vazio = sem limite (null). */
function corpoDoPlano(c: Campos) {
  return {
    nome: c.nome.trim(),
    preco_cents: centavos(c.preco),
    intervalo: c.intervalo,
    trial_dias: Number(c.trial_dias),
    max_assentos: inteiroOuNulo(c.max_assentos),
    max_canais: inteiroOuNulo(c.max_canais),
    teto_ia_usd_cents: c.teto_ia.trim() === "" ? null : centavos(c.teto_ia),
  };
}

function camposDe(p: PlanoDaTela): Campos {
  return {
    nome: p.nome,
    preco: decimal(p.preco_cents),
    intervalo: p.intervalo,
    trial_dias: String(p.trial_dias),
    max_assentos: p.max_assentos === null ? "" : String(p.max_assentos),
    max_canais: p.max_canais === null ? "" : String(p.max_canais),
    teto_ia: p.teto_ia_usd_cents === null ? "" : decimal(p.teto_ia_usd_cents),
  };
}

/**
 * Planos da instalação (spec da cobrança §9, aba Planos): criar, editar,
 * arquivar e marcar o plano do cadastro. Quem recusa de verdade é a rota (e o
 * CHECK); o formulário só evita a ida e volta no erro óbvio.
 */
export function PlanosDaInstalacao({ planos }: { planos: readonly PlanoDaTela[] }) {
  const t = useT();
  const idioma = useIdioma();
  const router = useRouter();
  const [campos, setCampos] = useState<Campos>(VAZIO);
  const [editando, setEditando] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const brl = new Intl.NumberFormat(idioma, { style: "currency", currency: "BRL" });
  const usd = new Intl.NumberFormat(idioma, { style: "currency", currency: "USD" });
  const campo = (k: Exclude<keyof Campos, "intervalo">) => ({
    value: campos[k],
    onChange: (e: ChangeEvent<HTMLInputElement>) => setCampos({ ...campos, [k]: e.target.value }),
  });
  const limite = (n: number | null) => (n === null ? t("sem limite") : String(n));

  async function salvar(e: FormEvent) {
    e.preventDefault();
    const corpo = corpoDoPlano(campos);
    if (!novoPlanoSchema.safeParse(corpo).success) {
      toast.error(t(AVISO_DE_CAMPOS));
      return;
    }
    setSalvando(true);
    try {
      if (editando) await apiClient.patch(`/api/v1/admin/cobranca/planos/${editando}`, corpo);
      else await apiClient.post("/api/v1/admin/cobranca/planos", corpo);
      toast.success(t("Plano salvo."));
      setCampos(VAZIO);
      setEditando(null);
      router.refresh();
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  async function mudar(id: string, corpo: Record<string, unknown>) {
    try {
      await apiClient.patch(`/api/v1/admin/cobranca/planos/${id}`, corpo);
      router.refresh();
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <form onSubmit={salvar} className="space-y-3 rounded-lg border p-4" aria-label={editando ? t("Editar plano") : t("Novo plano")}>
        <h3 className="text-sm font-semibold">{editando ? t("Editar plano") : t("Novo plano")}</h3>
        <div className="space-y-1">
          <Label htmlFor="plano-nome">{t("Nome do plano")}</Label>
          <Input id="plano-nome" maxLength={60} {...campo("nome")} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="plano-preco">{t("Preço (R$)")}</Label>
            <Input id="plano-preco" inputMode="decimal" {...campo("preco")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plano-intervalo">{t("Intervalo de cobrança")}</Label>
            <select
              id="plano-intervalo"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={campos.intervalo}
              onChange={(e) => setCampos({ ...campos, intervalo: e.target.value as Intervalo })}
            >
              <option value="mes">{t("Mensal")}</option>
              <option value="ano">{t("Anual")}</option>
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="plano-trial">{t("Dias de teste grátis")}</Label>
          <Input id="plano-trial" inputMode="numeric" {...campo("trial_dias")} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="plano-assentos">{t("Máximo de pessoas")}</Label>
            <Input id="plano-assentos" inputMode="numeric" {...campo("max_assentos")} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plano-canais">{t("Máximo de números conectados")}</Label>
            <Input id="plano-canais" inputMode="numeric" {...campo("max_canais")} />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="plano-ia">{t("Teto de uso de IA por mês (US$)")}</Label>
          <Input id="plano-ia" inputMode="decimal" {...campo("teto_ia")} />
        </div>
        <p className="text-xs text-muted-foreground">{t("Deixe um limite vazio para não limitar.")}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={salvando}>
            {editando ? t("Salvar alterações") : t("Salvar plano")}
          </Button>
          {editando && (
            <Button type="button" variant="ghost" onClick={() => { setEditando(null); setCampos(VAZIO); }}>
              {t("Cancelar edição")}
            </Button>
          )}
        </div>
      </form>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t("O preço e o intervalo de um plano travam quando alguém o assina: para mudar, arquive e crie outro.")}
        </p>
        {planos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("Nenhum plano ainda. Crie o primeiro no formulário acima: nome, preço, dias de teste grátis e, se quiser, os limites. Depois atribua-o a cada empresa no painel dela, em Tenants.")}
          </p>
        ) : (
          <ul className="space-y-2">
            {planos.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">
                    {p.nome}
                    {p.padrao_no_cadastro && <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs">{t("Plano do cadastro")}</span>}
                    {p.arquivado_em && <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs">{t("Arquivado")}</span>}
                    {!p.oferecido_ao_cliente && <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs">{t("Só você atribui")}</span>}
                  </p>
                  <p className="text-muted-foreground">
                    {brl.format(p.preco_cents / 100)} {p.intervalo === "mes" ? t("por mês") : t("por ano")} · {p.trial_dias} {t("dias de teste")}
                  </p>
                  <p className="text-muted-foreground">
                    {t("Pessoas")}: {limite(p.max_assentos)} · {t("Números conectados")}: {limite(p.max_canais)} · {t("IA")}:{" "}
                    {p.teto_ia_usd_cents === null ? t("sem limite") : usd.format(p.teto_ia_usd_cents / 100)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setEditando(p.id); setCampos(camposDe(p)); }}>
                    {t("Editar")}
                  </Button>
                  {!p.arquivado_em && (
                    <Button size="sm" variant="outline" onClick={() => mudar(p.id, { padrao_no_cadastro: !p.padrao_no_cadastro })}>
                      {p.padrao_no_cadastro ? t("Tirar do cadastro") : t("Usar no cadastro")}
                    </Button>
                  )}
                  {!p.arquivado_em && (
                    <Button size="sm" variant="outline" onClick={() => mudar(p.id, { oferecido_ao_cliente: !p.oferecido_ao_cliente })}>
                      {p.oferecido_ao_cliente ? t("Esconder das empresas") : t("Mostrar às empresas")}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => mudar(p.id, { arquivado: !p.arquivado_em })}>
                    {p.arquivado_em ? t("Desarquivar") : t("Arquivar")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
