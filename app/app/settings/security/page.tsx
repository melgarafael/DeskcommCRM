import {
  requireAuth,
  isMfaEnrolled,
  resolveActiveOrg,
  exigenciaDeMfa,
} from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { empresaExigeMfa, politicaDaEmpresa, type PapelMinimoDeMfa } from "@/lib/auth/politica-mfa";
import { SecurityClient } from "./_client";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * SEGURANÇA — e, desde esta rodada, o lugar ONDE a verificação em duas etapas
 * se liga e se desliga.
 *
 * A tela existia e não fazia nem uma coisa nem outra: dizia "Ativado/Não
 * ativado" e, quando não ativado, mandava "Faça login novamente para iniciar o
 * enrolamento" — porque o ÚNICO ponto de cadastro do produto era o bloqueador de
 * tela cheia que aparecia sozinho para todo admin. Com o cadastro virando
 * opcional, essa tela passaria a ser um beco: sem um botão aqui, a verificação
 * ficaria inalcançável para quem quisesse usá-la.
 *
 * Desde #1533 ela também é onde a organização escolhe de QUEM é exigido
 * (`mfa_required_min_role`) e com quantos dias de carência (`mfa_grace_days`) —
 * as duas chaves lidas aqui são as MESMAS que o gate do layout lê.
 */
export default async function SecurityPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  const enrolled = await isMfaEnrolled();

  let papelMinimo: PapelMinimoDeMfa = "none";
  let diasDeCarencia = 0;
  if (org) {
    const { data } = await createAdminClient()
      .from("organizations")
      .select("settings")
      .eq("id", org.orgId)
      .maybeSingle();
    const cfg = politicaDaEmpresa(data?.settings);
    // O fallback legado mora aqui, e não na leitura: `mfa_required: true` SEM a
    // chave nova é "admin" — o valor que a tela mostra tem que ser o mesmo que a
    // regra cobra, senão o seletor abriria em "não exigir" por cima de uma
    // organização que exige.
    papelMinimo = cfg.papelMinimo ?? (empresaExigeMfa(data?.settings) ? "admin" : "none");
    diasDeCarencia = cfg.diasDeCarencia;
  }

  // A mesma função que o layout usa para decidir o bloqueio — a tela não pode
  // ter uma segunda noção de "é obrigatório", ou ofereceria desligar o que o
  // layout volta a exigir no próximo carregamento.
  //
  // Aqui vale `exige` (a política alcança esta pessoa, portanto não pode
  // desligar o próprio fator) e não `bloqueia`: durante a carência a pessoa já
  // está obrigada, mesmo sem a tela travada.
  const exigencia = await exigenciaDeMfa(org?.role, user.is_platform_admin, user.id, org?.orgId);
  const obrigatorio = exigencia.exige;
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Segurança", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "A verificação em duas etapas da sua conta, os códigos de recuperação e as sessões abertas.",
            idioma,
          )}
        </p>
      </header>

      <SecurityClient
        mfaEnrolled={enrolled}
        obrigatorio={obrigatorio}
        podeExigirDaEquipe={org?.role === "admin"}
        papelMinimo={papelMinimo}
        diasDeCarencia={diasDeCarencia}
      />
    </div>
  );
}
