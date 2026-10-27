"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { marcarCiente, responderAprovacao, type ResultadoDaResposta } from "@/app/actions/aprovacoesDaAgencia";
import { Material, type MaterialDoEnvio } from "@/components/agencia/envios/Material";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { cn } from "@/lib/utils";

/**
 * A tela de aprovações da empresa (SPEC-aprovacoes, SPEC-envios): o que a agência
 * mandou, aberto AQUI (vídeo no player, arte grande, roteiro em texto), com
 * "Aprovar" / "Pedir ajustes" — e, no aviso, "Ciente".
 */
export interface AprovacaoDaTela {
  id: string;
  tipo: "video" | "roteiro" | "arte" | "estrategia" | "outro" | "aviso";
  titulo: string;
  descricao: string | null;
  material: MaterialDoEnvio;
  versao: number;
  situacao: "pendente" | "aprovado" | "ajustes" | "ciente";
  comentario: string | null;
  pedido_em: string;
  respondido_em: string | null;
}

const TIPO: Record<AprovacaoDaTela["tipo"], string> = {
  video: "Vídeo",
  roteiro: "Roteiro",
  arte: "Arte",
  estrategia: "Estratégia do mês",
  outro: "Outro",
  aviso: "Aviso",
};

const ERRO: Record<Exclude<ResultadoDaResposta, { ok: true }>["error"], string> = {
  auth_required: "Entre de novo para responder.",
  no_active_org: "Escolha a empresa antes de responder.",
  forbidden: "Você não tem permissão para responder aprovações.",
  comentario_obrigatorio: "Conte o que precisa mudar.",
  invalid: "Não deu para enviar a resposta.",
  nao_pendente: "Esta aprovação já foi respondida ou cancelada.",
};

export function AprovacoesClient({ aprovacoes, podeResponder, fuso }: { aprovacoes: AprovacaoDaTela[]; podeResponder: boolean; fuso: string }) {
  const t = useT();
  const idioma = useIdioma();
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [ajustando, setAjustando] = useState<string | null>(null);
  const [comentario, setComentario] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const data = (iso: string) =>
    new Date(iso).toLocaleString(tagDeIdioma(idioma), { timeZone: fuso, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const abertas = aprovacoes.filter((a) => a.situacao === "pendente");
  const respondidas = aprovacoes.filter((a) => a.situacao !== "pendente");

  function ciente(id: string) {
    setErro(null);
    startTransition(async () => {
      const r = await marcarCiente(id);
      if (!r.ok) return setErro(t(ERRO[r.error]));
      router.refresh();
    });
  }

  function responder(id: string, decisao: "aprovado" | "ajustes") {
    setErro(null);
    startTransition(async () => {
      const r = await responderAprovacao({ aprovacaoId: id, decisao, comentario: decisao === "ajustes" ? comentario : null });
      if (!r.ok) return setErro(t(ERRO[r.error]));
      setAjustando(null);
      setComentario("");
      router.refresh();
    });
  }

  const cartao = (a: AprovacaoDaTela) => (
    <li key={a.id} className={cn("space-y-2 rounded-md border p-4", a.situacao === "aprovado" && "border-emerald-500/50", a.situacao === "ajustes" && "border-amber-500/50")} data-testid="aprovacao">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{a.titulo}</span>
        <span className="text-xs text-muted-foreground">
          {t(TIPO[a.tipo])}
          {a.versao > 1 ? ` · v${a.versao}` : ""} · {data(a.pedido_em)}
        </span>
      </div>
      <div className={cn(a.material.url && a.material.mime?.startsWith("video/") && "grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]")}>
        <Material m={a.material} titulo={a.titulo} t={t} />
        {a.descricao && <p className="whitespace-pre-line text-sm text-muted-foreground">{a.descricao}</p>}
      </div>
      {a.tipo === "aviso" ? (
        a.situacao === "pendente" ? (
          podeResponder ? (
            <Button type="button" size="sm" disabled={pendente} onClick={() => ciente(a.id)}>
              {t("Ciente")}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{t("Quem responde é alguém da equipe com acesso de atendimento ou acima.")}</p>
          )
        ) : (
          <p className="text-sm">
            <strong>{t("Você marcou que está ciente")}</strong>
            {a.respondido_em ? ` · ${data(a.respondido_em)}` : ""}
          </p>
        )
      ) : a.situacao === "pendente" ? (
        podeResponder ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={pendente} onClick={() => responder(a.id, "aprovado")}>
                {t("Aprovar")}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={pendente} onClick={() => setAjustando(ajustando === a.id ? null : a.id)}>
                {t("Pedir ajustes")}
              </Button>
            </div>
            {ajustando === a.id && (
              <div className="space-y-2">
                <textarea
                  aria-label={t("O que precisa mudar")}
                  rows={3}
                  value={comentario}
                  onChange={(e) => setComentario(e.target.value)}
                  placeholder={t("Conte o que precisa mudar")}
                  className="w-full rounded-md border bg-background p-2 text-sm"
                />
                <Button type="button" size="sm" disabled={pendente || !comentario.trim()} onClick={() => responder(a.id, "ajustes")}>
                  {t("Enviar pedido de ajustes")}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("Quem responde é alguém da equipe com acesso de atendimento ou acima.")}</p>
        )
      ) : (
        <p className="text-sm">
          <strong>{a.situacao === "aprovado" ? t("Aprovado") : t("Ajustes pedidos")}</strong>
          {a.respondido_em ? ` · ${data(a.respondido_em)}` : ""}
          {a.comentario && <span className="block text-muted-foreground">{a.comentario}</span>}
        </p>
      )}
    </li>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Aprovações")}</h1>
        <p className="text-sm text-muted-foreground">{t("O que a agência preparou para a sua empresa: vídeos, roteiros e artes para aprovar, e avisos para você ficar ciente.")}</p>
      </div>
      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      <section className="space-y-2">
        <h2 className="font-semibold">
          {t("Aguardando você")} ({abertas.length})
        </h2>
        {abertas.length === 0 ? <p className="text-sm text-muted-foreground">{t("Nada esperando aprovação agora.")}</p> : <ul className="space-y-3">{abertas.map(cartao)}</ul>}
      </section>
      {respondidas.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">{t("Respondidas")}</h2>
          <ul className="space-y-3">{respondidas.map(cartao)}</ul>
        </section>
      )}
    </div>
  );
}
