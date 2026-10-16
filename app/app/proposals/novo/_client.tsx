"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Search } from "lucide-react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { diaDeHojeLocal } from "@/lib/ai/pacing-knobs";
import { apiClient } from "@/lib/api/client";
import type { ApiSuccess } from "@/lib/api/wrappers";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

export interface LeadOption {
  id: string;
  title: string | null;
  contact_id: string;
  contact: {
    id: string;
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
  } | null;
}

interface NewProposalClientProps {
  initialLeads: LeadOption[];
  preselectedLeadId?: string;
}

/**
 * A validade padrão de uma proposta: HOJE + 15 dias, contando no calendário de
 * quem usa a tela (#2935). A soma acontece em data LOCAL e só então é
 * formatada; `toISOString()` convertia para UTC e, depois das 21h em Brasília,
 * o "hoje + 15" saía com 16 dias.
 */
export function validadePadrao(agora: Date = new Date()): string {
  const d = new Date(agora);
  d.setDate(d.getDate() + 15);
  return diaDeHojeLocal(d);
}

export function NewProposalClient({
  initialLeads,
  preselectedLeadId,
}: NewProposalClientProps) {
  const t = useT();
  const router = useRouter();

  // Data default: 15 dias no futuro, no calendário de quem usa a tela (#2935).
  const dataValidadePadrao = useMemo(() => validadePadrao(), []);

  const [leadId, setLeadId] = useState<string>(() => {
    if (preselectedLeadId && initialLeads.some((l) => l.id === preselectedLeadId)) {
      return preselectedLeadId;
    }
    return "";
  });
  const [buscaLead, setBuscaLead] = useState("");
  const [titulo, setTitulo] = useState("");
  const [validUntil, setValidUntil] = useState(dataValidadePadrao);
  const [condicoes, setCondicoes] = useState("");
  const [criando, setCriando] = useState(false);

  // Filtro de leads para facilitar busca caso haja muitos negócios
  const leadsFiltrados = useMemo(() => {
    const termo = buscaLead.trim().toLowerCase();
    if (!termo) return initialLeads;
    return initialLeads.filter((l) => {
      const leadTitle = (l.title ?? "").toLowerCase();
      // Nome único da função central: remontar a cadeia aqui vira a sétima cópia.
      const contactRotulo = rotuloDoContato(l.contact).toLowerCase();
      const contactPhone = (l.contact?.phone_number ?? "").toLowerCase();
      return (
        leadTitle.includes(termo) ||
        contactRotulo.includes(termo) ||
        contactPhone.includes(termo)
      );
    });
  }, [initialLeads, buscaLead]);

  function getLeadLabel(lead: LeadOption): string {
    const nomeContato = rotuloDoContato(lead.contact);
    const tituloNegocio = lead.title ? `${lead.title} — ` : "";
    return `${tituloNegocio}${nomeContato}`;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!leadId) {
      alert(t("Por favor, selecione o negócio associado à proposta."));
      return;
    }

    const trimmedTitulo = titulo.trim();
    if (!trimmedTitulo) {
      alert(t("Por favor, informe o título da proposta."));
      return;
    }

    setCriando(true);
    try {
      const res = await apiClient.post<ApiSuccess<{ id: string }>>("/api/v1/proposals", {
        lead_id: leadId,
        titulo: trimmedTitulo,
        valid_until: validUntil || undefined,
        condicoes: condicoes.trim() || undefined,
        itens: [],
      });

      // Redireciona para o editor da proposta recém-criada
      router.push(`/app/proposals/${res.data.id}`);
    } catch (err) {
      showApiError(err);
      setCriando(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/app/proposals" className="flex items-center gap-1.5 text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
            <span>{t("Voltar às propostas")}</span>
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{t("Nova Proposta Comercial")}</CardTitle>
          <CardDescription>
            {t(
              "Preencha as informações básicas para iniciar o rascunho da proposta. Os itens, produtos e valores poderão ser adicionados no editor a seguir.",
            )}
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-5">
            {initialLeads.length === 0 ? (
              <div
                role="alert"
                className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
              >
                <p className="font-medium">
                  {t("Nenhum negócio elegível encontrado")}
                </p>
                <p className="mt-1">
                  {t(
                    "Para criar uma proposta, é necessário ter pelo menos um negócio ativo com um contato vinculado na organização.",
                  )}
                </p>
              </div>
            ) : null}

            {/* Seleção do Negócio (Lead) */}
            <div className="space-y-2">
              <Label htmlFor="lead-select">
                {t("Negócio (Lead)")} <span className="text-destructive">*</span>
              </Label>

              {initialLeads.length > 5 ? (
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder={t("Filtrar negócio por título, cliente ou telefone…")}
                    value={buscaLead}
                    onChange={(e) => setBuscaLead(e.target.value)}
                    className="pl-8 text-sm"
                    disabled={criando}
                  />
                </div>
              ) : null}

              <Select
                value={leadId}
                onValueChange={setLeadId}
                disabled={criando || initialLeads.length === 0}
              >
                <SelectTrigger id="lead-select" className="w-full">
                  <SelectValue placeholder={t("Selecione o negócio...")} />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {leadsFiltrados.length === 0 ? (
                    <div className="p-3 text-center text-sm text-muted-foreground">
                      {t("Nenhum negócio encontrado com este filtro.")}
                    </div>
                  ) : (
                    leadsFiltrados.map((lead) => (
                      <SelectItem key={lead.id} value={lead.id}>
                        {getLeadLabel(lead)}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("A proposta será vinculada ao negócio e ao contato correspondente.")}
              </p>
            </div>

            {/* Título da Proposta */}
            <div className="space-y-2">
              <Label htmlFor="titulo-input">
                {t("Título da proposta")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="titulo-input"
                type="text"
                placeholder={t("Ex.: Proposta de Prestação de Serviços, Orçamento Especial")}
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                maxLength={200}
                required
                disabled={criando}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                {t("Identificação que aparecerá para o cliente e na lista de propostas.")}
              </p>
            </div>

            {/* Data de Validade */}
            <div className="space-y-2">
              <Label htmlFor="valid-until-input">{t("Validade da proposta")}</Label>
              <Input
                id="valid-until-input"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                disabled={criando}
              />
              <p className="text-xs text-muted-foreground">
                {t("Data limite até a qual os valores e condições são garantidos.")}
              </p>
            </div>

            {/* Condições e Observações */}
            <div className="space-y-2">
              <Label htmlFor="condicoes-input">{t("Condições de pagamento / Observações")}</Label>
              <Textarea
                id="condicoes-input"
                rows={3}
                placeholder={t(
                  "Ex.: Pagamento em até 3x sem juros no cartão ou 5% de desconto à vista via Pix.",
                )}
                value={condicoes}
                onChange={(e) => setCondicoes(e.target.value)}
                maxLength={4000}
                disabled={criando}
              />
            </div>
          </CardContent>

          <CardFooter className="flex items-center justify-between border-t p-6">
            <Button variant="outline" type="button" asChild disabled={criando}>
              <Link href="/app/proposals">{t("Cancelar")}</Link>
            </Button>

            <Button
              type="submit"
              disabled={criando || !leadId || !titulo.trim() || initialLeads.length === 0}
            >
              {criando ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("Criando proposta…")}
                </>
              ) : (
                t("Criar e abrir editor")
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
