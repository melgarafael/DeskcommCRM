"use client";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { CAIXAS_DE_EXEMPLO } from "@/lib/cadencias/exemplos";
import type { ConfiguracaoDaCadencia, DiaDaSemana } from "@/lib/cadencias/tipos";
import { EnvelopeSimple, Lightning, StopCircle, Clock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  configuracao: ConfiguracaoDaCadencia;
  somenteLeitura: boolean;
  onMudar: (c: ConfiguracaoDaCadencia) => void;
}

const DIAS: { dia: DiaDaSemana; rotulo: string }[] = [
  { dia: "seg", rotulo: "Seg" },
  { dia: "ter", rotulo: "Ter" },
  { dia: "qua", rotulo: "Qua" },
  { dia: "qui", rotulo: "Qui" },
  { dia: "sex", rotulo: "Sex" },
  { dia: "sab", rotulo: "Sáb" },
  { dia: "dom", rotulo: "Dom" },
];

/** Normaliza o que o usuário digita no formato de tag: minúsculas, hífens. */
function formatarTag(bruto: string): string {
  return bruto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "");
}

export function AbaConfiguracoes({ configuracao: c, somenteLeitura, onMudar }: Props) {
  const t = useT();
  const paradas: { chave: keyof ConfiguracaoDaCadencia["paradas"]; rotulo: string; ajuda: string }[] = [
    { chave: "respondeu", rotulo: "Quando o lead responder", ajuda: "A resposta aparece no CRM e a cadência para para esse lead." },
    { chave: "bounce", rotulo: "Quando o e-mail voltar (bounce)", ajuda: "Endereço inexistente ou caixa cheia. Protege a reputação do domínio." },
    { chave: "descadastro", rotulo: "Quando o lead se descadastrar", ajuda: "Obrigatório pela LGPD: o endereço entra na lista de supressão." },
    { chave: "ganhoOuPerdido", rotulo: "Quando o card for para ganho ou perdido", ajuda: "Não faz sentido seguir prospectando quem já fechou ou saiu." },
  ];

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <fieldset disabled={somenteLeitura} className="mx-auto max-w-3xl space-y-6 p-6">
        <Secao icone={<Lightning size={16} aria-hidden />} titulo={t("Inscrição")}>
          <div className="space-y-2">
            <Label htmlFor="tag-segmento">{t("Tag do segmento")}</Label>
            <Input
              id="tag-segmento"
              value={c.tagDoSegmento}
              placeholder="papel-e-celulose"
              className="max-w-sm font-mono"
              onChange={(e) => onMudar({ ...c, tagDoSegmento: formatarTag(e.target.value) })}
            />
            <p className="text-xs text-text-muted">
              {t("O lead que receber esta tag (por exemplo, vindo do Treg pelo webhook de captação) entra na cadência automaticamente.")}
            </p>
          </div>
          <Linha
            id="so-validado"
            rotulo={t("Só inscrever lead com e-mail validado")}
            ajuda={t("O Treg marca o e-mail como validado. Lead sem essa marca não entra, para não queimar o domínio com bounce.")}
            marcado={c.somenteEmailValidado}
            onMudar={(v) => onMudar({ ...c, somenteEmailValidado: v })}
          />
        </Secao>

        <Secao icone={<EnvelopeSimple size={16} aria-hidden />} titulo={t("Remetente")}>
          <p className="text-sm text-text">
            {t("Cada e-mail sai da caixa do dono do lead. Escolha a caixa usada quando o lead não tem dono ou o dono ainda não conectou a caixa dele.")}
          </p>
          <div className="space-y-2">
            <Label>{t("Caixa padrão")}</Label>
            <Select
              value={c.caixaPadraoId ?? undefined}
              onValueChange={(caixaPadraoId) => onMudar({ ...c, caixaPadraoId })}
            >
              <SelectTrigger className="max-w-md">
                <SelectValue placeholder={t("Escolha uma caixa")} />
              </SelectTrigger>
              <SelectContent>
                {CAIXAS_DE_EXEMPLO.map((cx) => (
                  <SelectItem key={cx.id} value={cx.id}>
                    {cx.nomeDoRemetente} &lt;{cx.endereco}&gt;
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              {t("Use um domínio secundário para prospecção — assim o domínio principal da empresa fica protegido.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="limite">{t("Limite de envios por caixa, por dia")}</Label>
            <Input
              id="limite"
              type="number"
              min={1}
              max={500}
              value={c.limiteDiarioPorCaixa}
              className="w-32"
              onChange={(e) => onMudar({ ...c, limiteDiarioPorCaixa: Number(e.target.value) })}
            />
            <p className="text-xs text-text-muted">
              {t("O que passar do limite fica na fila para o próximo dia útil.")}
            </p>
          </div>
        </Secao>

        <Secao icone={<Clock size={16} aria-hidden />} titulo={t("Janela de envio")}>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="inicio">{t("De")}</Label>
              <Input
                id="inicio"
                type="time"
                value={c.janela.inicio}
                className="w-32"
                onChange={(e) => onMudar({ ...c, janela: { ...c.janela, inicio: e.target.value } })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fim">{t("Até")}</Label>
              <Input
                id="fim"
                type="time"
                value={c.janela.fim}
                className="w-32"
                onChange={(e) => onMudar({ ...c, janela: { ...c.janela, fim: e.target.value } })}
              />
            </div>
            <p className="pb-2 text-xs text-text-muted">{t("Horário de Brasília")}</p>
          </div>
          <div className="space-y-2">
            <Label>{t("Dias da semana")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {DIAS.map(({ dia, rotulo }) => {
                const ativo = c.janela.dias.includes(dia);
                return (
                  <button
                    key={dia}
                    type="button"
                    aria-pressed={ativo}
                    onClick={() =>
                      onMudar({
                        ...c,
                        janela: {
                          ...c.janela,
                          dias: ativo ? c.janela.dias.filter((d) => d !== dia) : [...c.janela.dias, dia],
                        },
                      })
                    }
                    className={cn(
                      "h-9 w-12 rounded-md border text-sm transition",
                      ativo
                        ? "border-accent bg-accent text-accent-foreground"
                        : "border-border bg-surface text-text-muted hover:border-accent",
                    )}
                  >
                    {t(rotulo)}
                  </button>
                );
              })}
            </div>
          </div>
        </Secao>

        <Secao icone={<StopCircle size={16} aria-hidden />} titulo={t("Quando a cadência para")}>
          {paradas.map((p) => (
            <Linha
              key={p.chave}
              id={`parada-${p.chave}`}
              rotulo={t(p.rotulo)}
              ajuda={t(p.ajuda)}
              marcado={c.paradas[p.chave]}
              travado={p.chave === "descadastro"}
              onMudar={(v) => onMudar({ ...c, paradas: { ...c.paradas, [p.chave]: v } })}
            />
          ))}
          <p className="text-xs text-text-muted">
            {t("O vendedor também pode pausar, pular um passo ou tirar o lead da cadência a qualquer momento.")}
          </p>
        </Secao>
      </fieldset>
    </div>
  );
}

function Secao({
  icone,
  titulo,
  children,
}: {
  icone: React.ReactNode;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="space-y-4 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent">
          {icone}
        </span>
        {titulo}
      </h2>
      {children}
    </Card>
  );
}

function Linha({
  id,
  rotulo,
  ajuda,
  marcado,
  travado,
  onMudar,
}: {
  id: string;
  rotulo: string;
  ajuda: string;
  marcado: boolean;
  travado?: boolean;
  onMudar: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label htmlFor={id}>{rotulo}</Label>
        <p className="text-xs text-text-muted">{ajuda}</p>
      </div>
      <Switch id={id} checked={marcado || !!travado} disabled={travado} onCheckedChange={onMudar} />
    </div>
  );
}
