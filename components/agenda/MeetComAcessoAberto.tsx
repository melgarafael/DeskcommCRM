"use client";

import { useId, useState, useTransition } from "react";

import {
  definirMeetAberto,
  type ErroMeetAberto,
} from "@/app/actions/settings/definirMeetAberto";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

/**
 * "GOOGLE MEET COM ACESSO ABERTO" — o interruptor da issue #2063 (migration
 * 0579), irmã de `AgendaDosColegas`: mesma tela, mesmo piso `manager`, mesma
 * leitura pela SESSÃO, mesmo `revalidatePath`, mesmo formato de erro.
 *
 * DESLIGADO (o padrão, e o de toda organização que já instalou): nada muda — o
 * Meet da reunião nasce pedindo para participar, como sempre. LIGADO, e só com
 * a conexão que recebeu o escopo opcional `meetings.space.created`, o espaço é
 * criado já aberto por `spaces.create` (lib/agenda/google/sync-executor.ts).
 *
 * ─── Por que o AVISO fica ao lado do interruptor, e não num diálogo ────────
 *
 * Ligar isto é decidir que qualquer pessoa com o LINK entra na reunião sem
 * ser admitida. É a única opção desta tela que troca segurança por
 * conveniência, então o risco se diz no mesmo lugar onde ele se liga: quem
 * lê a frase antes de apertar não precisa de confirmação depois. Um
 * diálogo de confirmação viraria cerimônia para o que se desfaz com o mesmo
 * clique — mas ele ESCONDERIA a frase, e a frase é o que importa.
 *
 * ⚠️ O interruptor NÃO é a autorização: quem grava é
 * `fn_definir_google_meet_acesso_aberto`, no banco. `podeMudar` é cortesia.
 */

/**
 * O AVISO DE RISCO (#2063). Exportado pelo nome porque é ele que se procura
 * na tela — e porque o texto é a mesma frase em todo lugar.
 */
export const AVISO_MEET_ABERTO =
  "⚠ Com o Meet aberto, quem tiver o link da reunião entra sozinho, sem que ninguém o admita. O link é a porta: não o publique onde circula livremente.";

/**
 * A MEIA BOCA DO SELF-HOST (#2063, item 4). No self-host quem conecta o Google
 * é o próprio operador, com o app OAuth dele: sem a Meet API ligada no projeto
 * Google Cloud e sem o escopo na tela de consentimento, o `spaces.create`
 * devolve 403 e a reunião nasce com o Meet "confiável" do Calendar. Esta frase
 * é o aviso disso, e a mesma explicação está na doc de setup.
 */
export const AVISO_SELF_HOST =
  "No self-host, quem conecta o Google usa o próprio app OAuth: ligue a Meet API do Google Cloud e adicione o escopo meetings.space.created na tela de consentimento do seu projeto — sem isso, o Google recusa a criação do espaço aberto e o link sai comum.";

/** A frase de cada recusa. As gerais são as que as irmãs já usam. */
const TEXTO_DO_ERRO: Record<ErroMeetAberto, string> = {
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um gerente ou administrador pode mudar essa regra.",
  mfa: "Confirme a verificação em duas etapas.",
  tente_de_novo: "Outra mudança estava em andamento. Tente de novo.",
  falha: "Não consegui salvar essa mudança agora.",
};

export function MeetComAcessoAberto({
  ligadoInicial,
  podeMudar,
}: {
  /** `organizations.settings.google_meet_acesso_aberto` (migration 0579). */
  ligadoInicial: boolean;
  /** Espelha o piso `manager` da RPC. Cortesia, não autorização. */
  podeMudar: boolean;
}) {
  const t = useT();
  const idDoRotulo = useId();
  const [ligado, setLigado] = useState(ligadoInicial);
  const [erro, setErro] = useState<ErroMeetAberto | null>(null);
  const [salvando, iniciar] = useTransition();

  function aplicar(novo: boolean) {
    setErro(null);
    iniciar(async () => {
      const r = await definirMeetAberto(novo);
      if (!r.ok) {
        setErro(r.erro);
        return;
      }
      // O estado vem do CORPO da action, nunca de um refresh que perca a
      // corrida para os prefetches — mesma régua das duas irmãs.
      setLigado(r.ligado);
    });
  }

  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="meet-acesso-aberto">
      <h2 className="font-semibold">{t("Google Meet com acesso aberto")}</h2>

      <div className="flex items-center gap-3">
        <Switch
          checked={ligado}
          onCheckedChange={aplicar}
          disabled={!podeMudar || salvando}
          aria-labelledby={idDoRotulo}
          data-testid="meet-acesso-aberto-interruptor"
        />
        <span id={idDoRotulo} className="text-sm font-medium">
          {t("O Meet da reunião nasce com o acesso aberto")}
        </span>
      </div>

      <p className="text-sm text-text-muted">
        {t(
          "Com isto ligado, quando um compromisso ganha Meet o espaço já nasce aberto — qualquer pessoa com o link entra sem pedir para participar. Desligado, o Meet continua pedindo: é o comportamento de sempre.",
        )}
      </p>

      {/* O risco declarado AO LADO da opção: é a única troca de segurança por
          conveniência que esta tela faz, e quem lê antes de apertar não
          precisa de confirmação depois. */}
      <p
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        data-testid="meet-acesso-aberto-aviso"
      >
        {t(AVISO_MEET_ABERTO)}
      </p>

      <p className="text-sm text-text-muted" data-testid="meet-acesso-aberto-self-host">
        {t(AVISO_SELF_HOST)}
      </p>

      {!podeMudar && (
        <p className="text-sm text-text-muted">
          {t("Só um gerente ou administrador pode mudar essa regra.")}
        </p>
      )}

      {erro && (
        <p role="alert" className="text-sm text-destructive" data-testid="meet-acesso-aberto-erro">
          {t(TEXTO_DO_ERRO[erro])}
        </p>
      )}
    </section>
  );
}
