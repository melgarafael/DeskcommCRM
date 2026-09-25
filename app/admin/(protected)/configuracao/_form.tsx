"use client";

import Link from "next/link";
import { useState } from "react";

import { CampoEditavel, Origem } from "@/components/admin/CampoDaInstalacao";
import { Card } from "@/components/ui/card";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { MotivoDeDiagnostico } from "@/lib/instalacao/catalogo";

import type { LinhaDaTela } from "./page";

interface Grupo {
  grupo: string;
  titulo: string;
  resumo: string;
  linhas: LinhaDaTela[];
  /**
   * Para onde foi o que NÃO está aqui.
   *
   * A chave do serviço externo de e-mail saiu desta tela para `/admin/email`
   * (DEC-009). Sem este ponteiro, quem procurar por ela aqui — onde ela esteve —
   * conclui que ela sumiu, e "sumiu" é o que o operador entende por "não dá
   * mais para configurar". O ponteiro é o custo de ter mudado o lugar.
   */
  ponteiro?: { href: string; texto: string };
}

const MOTIVO_CURTO: Record<MotivoDeDiagnostico, string> = {
  de_partida: "Necessária para o sistema ligar",
  chave_mestra: "É a chave que protege as outras",
  gravada_na_montagem: "Gravada quando o programa foi montado",
  pareada_com_conteiner: "Tem um par em outro programa do servidor",
  lida_no_boot_de_outro_processo: "Lida por outro programa ao ligar",
};

function CampoDeDiagnostico({ linha, idioma }: { linha: LinhaDaTela; idioma: Idioma }) {
  const t = (s: string) => traduzir(s, idioma);
  const [aberto, setAberto] = useState(false);
  const { definicao, estado } = linha;

  return (
    <div className="space-y-2 border-t border-border/60 py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{t(definicao.rotulo)}</span>
        <Origem fonte={estado.fonte} idioma={idioma} />
      </div>
      <p className="text-sm text-text-muted">{t(definicao.explicacao)}</p>

      {estado.configurado && definicao.natureza === "segredo" && (
        <p className="text-xs text-text-muted">
          {t("Guardado, terminando em")} ••••{estado.last4 ?? ""}
        </p>
      )}

      {/*
        O porquê fica atrás de um clique, não escondido: quem só confere o estado
        não precisa ler; quem quer trocar precisa, e a resposta está aqui em vez
        de num fórum. Campo de texto seria pior que ausência — aceitaria e não
        faria nada.
      */}
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        // `py-1.5` não é estética: sem ele o alvo de toque fica abaixo de 24px de
        // altura e vira difícil de acertar no celular. Medido pela própria
        // bateria E2E (`getBoundingClientRect`), que reprovou 9 destes botões.
        // `inline-flex` porque um `<button>` inline não aplica padding vertical
        // na caixa — o padding sai, a ALTURA não muda, e a medição continua
        // reprovando com o CSS "corrigido".
        className="inline-flex items-center py-1.5 text-xs font-medium text-text-muted underline underline-offset-2 hover:text-foreground"
      >
        {definicao.motivo ? t(MOTIVO_CURTO[definicao.motivo]) : t("Não se troca por aqui")}
        {" · "}
        {aberto ? t("ocultar") : t("por quê?")}
      </button>

      {aberto && definicao.comoTrocar && (
        <p className="rounded-md bg-muted/50 p-3 text-sm text-text-muted">
          {t(definicao.comoTrocar)}
        </p>
      )}
    </div>
  );
}

export function PainelDeConfiguracao({ grupos, idioma }: { grupos: Grupo[]; idioma: Idioma }) {
  const t = (s: string) => traduzir(s, idioma);
  return (
    <div className="space-y-6">
      {grupos.map((g) => (
        <Card key={g.grupo} className="p-5">
          <div className="mb-1">
            <h2 className="text-base font-semibold">{t(g.titulo)}</h2>
            <p className="text-sm text-text-muted">{t(g.resumo)}</p>
          </div>
          {g.ponteiro ? (
            <p className="mt-2 text-sm text-text-muted">
              <Link
                href={g.ponteiro.href}
                data-testid={`ponteiro-${g.grupo}`}
                className="font-medium text-text underline underline-offset-4"
              >
                {t(g.ponteiro.texto)}
              </Link>
            </p>
          ) : null}
          <div className="mt-3">
            {g.linhas.map((linha) =>
              linha.definicao.controle === "edita" ? (
                <CampoEditavel key={linha.definicao.chave} linha={linha} idioma={idioma} />
              ) : (
                <CampoDeDiagnostico key={linha.definicao.chave} linha={linha} idioma={idioma} />
              ),
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}
