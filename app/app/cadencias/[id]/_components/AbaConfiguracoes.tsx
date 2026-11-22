"use client";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import type { ConfiguracaoDaCadencia, DiaDaSemana } from "@/lib/cadencias/tipos";
import { EnvelopeSimple, Lightning, StopCircle, Clock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  configuracao: ConfiguracaoDaCadencia;
  somenteLeitura: boolean;
  onMudar: (c: ConfiguracaoDaCadencia) => void;
}

const DIAS: DiaDaSemana[] = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"];

export function AbaConfiguracoes({ configuracao: c, somenteLeitura, onMudar }: Props) {
  const t = useT();
  const rotulos = { seg: t("Seg"), ter: t("Ter"), qua: t("Qua"), qui: t("Qui"), sex: t("Sex"), sab: t("Sáb"), dom: t("Dom") };

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <fieldset disabled={somenteLeitura} className="mx-auto max-w-3xl space-y-6 p-6">
        <Secao icone={<Lightning size={16} aria-hidden />} titulo={t("Inscrição")}>
          <p className="text-sm text-text-muted">{t("Inscreva cada negócio na aba Inscrições e atividade. Tags não inscrevem automaticamente; não há integração com validador de e-mail.")}</p>
          <Label htmlFor="tag-segmento">{t("Identificação do segmento (opcional)")}</Label>
          <Input id="tag-segmento" value={c.tagDoSegmento} onChange={(e) => onMudar({ ...c, tagDoSegmento: e.target.value })} maxLength={80} />
        </Secao>
        <Secao icone={<EnvelopeSimple size={16} aria-hidden />} titulo={t("Remetente")}>
          <p className="text-sm text-text-muted">{t("O envio usa o transporte de e-mail da instalação. A resposta vai para o dono do negócio quando ele tem e-mail cadastrado.")}</p>
          <Label htmlFor="limite">{t("Limite desta cadência a cada 24 horas")}</Label>
          <Input id="limite" type="number" min={1} max={10000} value={c.limiteDiarioPorCaixa} className="w-32" onChange={(e) => onMudar({ ...c, limiteDiarioPorCaixa: Number(e.target.value) })} />
          <p className="text-xs text-text-muted">{t("O teto da instalação também se aplica. Tentativas contam para o limite; ao atingi-lo, a fila aguarda e confere novamente.")}</p>
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
            <div className="space-y-2"><Label htmlFor="fuso">{t("Fuso horário")}</Label><Input id="fuso" value={c.fuso} onChange={(e) => onMudar({ ...c, fuso: e.target.value })} /></div>
          </div>
          <div className="space-y-2">
            <Label>{t("Dias da semana")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {DIAS.map((dia) => {
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
                    {rotulos[dia]}
                  </button>
                );
              })}
            </div>
          </div>
        </Secao>

        <Secao icone={<StopCircle size={16} aria-hidden />} titulo={t("Quando a cadência para")}>
          <Linha id="descadastro" rotulo={t("Quando o destinatário se descadastrar")} ajuda={t("O descadastro interrompe todas as cadências deste contato nesta empresa.")} marcado travado onMudar={() => {}} />
          <Linha id="ganho-perdido" rotulo={t("Quando o card for para ganho ou perdido")} ajuda={t("Conferido antes de executar o próximo passo.")} marcado={c.paradas.ganhoOuPerdido} onMudar={(v) => onMudar({ ...c, paradas: { ...c.paradas, ganhoOuPerdido: v } })} />
          <p className="text-xs text-text-muted">{t("Este módulo não detecta respostas nem devoluções do provedor. A retirada manual está na aba Inscrições e atividade.")}</p>
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
