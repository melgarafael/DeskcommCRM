"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

import { acceptWelcome } from "@/app/actions/onboarding/acceptWelcome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FUSO_PADRAO, FUSOS_DO_ONBOARDING } from "@/lib/tempo/fusos";
import { fusoDoNavegador } from "@/lib/tempo/fuso-do-navegador";

export function WelcomeForm({ defaultOrgName, orgId }: { defaultOrgName: string; orgId: string }) {
  const t = useT();
  const [displayName, setDisplayName] = useState(defaultOrgName);
  const [oQueFaz, setOQueFaz] = useState("");
  const [timezone, setTimezone] = useState(FUSO_PADRAO);

  // O fuso do NAVEGADOR (se for um oferecido) vem marcado no lugar de São
  // Paulo: é o mesmo com que a empresa nasceu (`lib/auth/perfil-da-empresa-nova.ts`),
  // e este passo regrava o fuso da empresa com o que estiver marcado. Num
  // efeito, e não no estado inicial, porque o servidor não sabe o fuso do
  // navegador — e a hidratação divergiria.
  useEffect(() => {
    const doNavegador = fusoDoNavegador();
    // Uma leitura só, depois da hidratação, de um valor que só o navegador
    // tem: não há prop nem estado anterior de onde derivar no render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (doNavegador && FUSOS_DO_ONBOARDING.some((f) => f.id === doNavegador))
      setTimezone(doNavegador);
  }, []);
  const [accepted, setAccepted] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="space-y-5 rounded-lg border bg-background p-6"
      action={(formData) => {
        if (!accepted) {
          toast.error(t("Aceite os termos para continuar."));
          return;
        }
        startTransition(async () => {
          const res = await acceptWelcome(formData);
          if (res && !res.ok) {
            toast.error(
              res.error === "organization_changed"
                ? t("A empresa ativa mudou. Recarregue a página antes de continuar.")
                : `Falha: ${res.error}`,
            );
          }
        });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="display_name">{t("Como se chama o seu negócio?")}</Label>
        <Input
          id="display_name"
          name="display_name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          minLength={2}
          maxLength={120}
          required
        />
        <p className="text-xs text-muted-foreground">
          {t(
            "É o nome que aparece para o seu time e nos relatórios. Pode ser clínica, loja, escritório — o que for seu.",
          )}
        </p>
      </div>

      {/*
        A pergunta que faltava no produto inteiro. Sem ela, o funcionário nasce
        se apresentando como atendente de uma "loja online" — era o que os três
        modelos de prompt diziam — e o quadro de clientes nasce com as colunas
        de e-commerce que o gatilho semeia. Os dois defeitos têm a mesma origem:
        uma instalação que nunca pergunta em que ramo entrou.
      */}
      <div className="space-y-2">
        <Label htmlFor="o_que_faz">{t("O que vocês fazem?")}</Label>
        <Input
          id="o_que_faz"
          name="o_que_faz"
          value={oQueFaz}
          onChange={(e) => setOQueFaz(e.target.value)}
          maxLength={280}
          placeholder={t("Ex.: clínica odontológica, ou venda de roupa fitness pelo WhatsApp")}
        />
        <p className="text-xs text-muted-foreground">
          {t(
            "Uma linha basta. É com isso que seu funcionário aprende com quem ele está falando — e que a gente monta o quadro de clientes do seu jeito.",
          )}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="timezone">{t("Onde você atende")}</Label>
        <Select value={timezone} onValueChange={setTimezone}>
          <SelectTrigger id="timezone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FUSOS_DO_ONBOARDING.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {t(f.cidade)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input type="hidden" name="timezone" value={timezone} />
        {/* A org para a qual ESTA aba foi aberta. No submit, o server action
            resolve por ela (validada como membership), não pela org ativa do
            momento — que outra aba pode ter trocado. */}
        <input type="hidden" name="organization_id" value={orgId} />
        <p className="text-xs text-muted-foreground">
          {t("Decide o horário em que seu funcionário pode falar com clientes.")}
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          className="mt-1"
          required
        />
        <span>
          {t("Li e aceito os")}{" "}
          <a className="underline" href="/legal/terms" target="_blank" rel="noreferrer">
            {t("Termos de Uso")}
          </a>{" "}
          {t("e a")}{" "}
          <a className="underline" href="/legal/privacy" target="_blank" rel="noreferrer">
            {t("Política de Privacidade")}
          </a>
          .
        </span>
      </label>

      <div className="flex sm:justify-end">
        <Button type="submit" disabled={pending || !accepted} className="w-full sm:w-auto">
          {pending ? t("Salvando...") : t("Continuar")}
        </Button>
      </div>
    </form>
  );
}
