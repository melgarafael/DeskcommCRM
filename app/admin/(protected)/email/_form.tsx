"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { checkSmtp, updateSmtp } from "@/app/actions/settings/smtp";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CampoEditavel, type LinhaDaInstalacao } from "@/components/admin/CampoDaInstalacao";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type { SmtpSecurity } from "@/lib/email/config";
import type { Idioma } from "@/lib/i18n/idiomas";

interface Props {
  readonly host: string;
  readonly porta: number;
  readonly seguranca: SmtpSecurity;
  readonly usuario: string;
  readonly remetente: string;
  readonly nomeDoRemetente: string;
  /**
   * SE existe senha gravada — nunca QUAL. Mesma disciplina de `temSegredoSalvo`
   * em `/admin/google`: devolver o valor o serializaria no payload do RSC a cada
   * render desta tela.
   */
  readonly temSenhaSalva: boolean;
  /** De onde vieram os valores acima: o banco, o `.env` do servidor, ou nada. */
  readonly origem: "database" | "environment" | "none";
  /**
   * Quem entrega o e-mail AGORA. `resend` aqui não é defeito: é a instalação
   * que já mandava e-mail antes desta tela existir, e continua mandando.
   */
  readonly transporte: "smtp" | "resend" | "nenhum";
  /**
   * As chaves do SERVIÇO EXTERNO de envio, vindas do catálogo da instalação
   * (`telaDona: "email"`). Chegam prontas do servidor — valor visível ou os
   * quatro últimos do segredo, nunca o segredo inteiro.
   */
  readonly servicoExterno: readonly LinhaDaInstalacao[];
  readonly idioma: Idioma;
}

export function FormularioDeSmtp({
  host,
  porta,
  seguranca,
  usuario,
  remetente,
  nomeDoRemetente,
  temSenhaSalva,
  origem,
  transporte,
  servicoExterno,
  idioma,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [form, setForm] = useState({
    host,
    port: String(porta),
    security: seguranca,
    username: usuario,
    password: "",
    from_email: remetente,
    from_name: nomeDoRemetente,
  });
  const [ocupado, iniciar] = useTransition();
  /**
   * Só os campos de TEXTO. `security` tem tipo próprio e sai do `<select>` como
   * `string`; escrevê-lo por aqui obrigaria a alargar o estado para `string` e a
   * perder, no formulário, a única garantia que existe de que o valor enviado é
   * um dos três que o banco aceita.
   */
  type CampoDeTexto = Exclude<keyof typeof form, "security">;
  const set = (chave: CampoDeTexto, valor: string) =>
    setForm((atual) => ({ ...atual, [chave]: valor }));
  const setSeguranca = (valor: string) =>
    setForm((atual) => ({ ...atual, security: valor as SmtpSecurity }));

  const testar = () =>
    iniciar(async () => {
      const r = await checkSmtp();
      if (r.ok) {
        toast.success(t("Servidor de e-mail conectado e autenticado."));
        return;
      }
      // Três desfechos, três frases: "não deu" mandaria o operador conferir as
      // quatro coisas de uma vez. É a mesma lição do `dominio_nao_verificado`
      // da Resend — erro que não nomeia a causa vira caça ao fantasma.
      if (r.reason === "not_configured") {
        toast.error(t("Preencha e salve o servidor e o remetente antes de testar."));
      } else if (r.reason === "authentication_failed") {
        toast.error(t("O servidor respondeu, mas recusou o usuário e a senha."));
      } else {
        toast.error(t("Não foi possível falar com o servidor. Confira o endereço, a porta e a segurança."));
      }
    });

  const salvar = () =>
    iniciar(async () => {
      const r = await updateSmtp(form);
      if (!r.ok) {
        toast.error(t(r.error));
        return;
      }
      toast.success(t("Servidor de e-mail salvo."));
      set("password", "");
      router.refresh();
    });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("Servidor de e-mail desta instalação")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Convite de equipe, entrega de dados de LGPD e aviso de prazo saem por aqui. Preencher esta tela é a alternativa a contratar um serviço externo de envio: o e-mail passa a sair pelo seu próprio servidor.",
          )}
        </p>
      </header>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="smtp-host">{t("Endereço do servidor")}</Label>
          <Input
            id="smtp-host"
            data-testid="smtp-host"
            value={form.host}
            onChange={(e) => set("host", e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Normalmente é a palavra smtp seguida do seu domínio. Só o endereço: sem smtp:// na frente e sem a porta no fim.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="smtp-port">{t("Porta")}</Label>
          <Input
            id="smtp-port"
            data-testid="smtp-port"
            inputMode="numeric"
            value={form.port}
            onChange={(e) => set("port", e.target.value)}
            placeholder="587"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="smtp-security">{t("Segurança")}</Label>
          <select
            id="smtp-security"
            data-testid="smtp-security"
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={form.security}
            onChange={(e) => setSeguranca(e.target.value)}
          >
            <option value="starttls">{t("STARTTLS (normalmente a porta 587)")}</option>
            <option value="tls">{t("TLS/SSL (normalmente a porta 465)")}</option>
            <option value="none">{t("Sem criptografia")}</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="smtp-username">{t("Usuário")}</Label>
          <Input
            id="smtp-username"
            data-testid="smtp-username"
            value={form.username}
            onChange={(e) => set("username", e.target.value)}
            placeholder="nao-responda@seudominio.com"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="smtp-password">{t("Senha")}</Label>
          <Input
            id="smtp-password"
            data-testid="smtp-password"
            type="password"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder={temSenhaSalva ? "••••••••" : t("Senha do e-mail")}
          />
          <p className="text-xs text-muted-foreground">
            {temSenhaSalva
              ? t("Já existe uma senha gravada. Deixe em branco para mantê-la, ou digite uma nova para substituir.")
              : t("Ela é guardada cifrada e nunca volta a aparecer nesta tela.")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="smtp-from-email">{t("E-mail que aparece como remetente")}</Label>
          <Input
            id="smtp-from-email"
            data-testid="smtp-from-email"
            type="email"
            value={form.from_email}
            onChange={(e) => set("from_email", e.target.value)}
            placeholder="nao-responda@seudominio.com"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="smtp-from-name">{t("Nome que aparece como remetente")}</Label>
          <Input
            id="smtp-from-name"
            data-testid="smtp-from-name"
            value={form.from_name}
            onChange={(e) => set("from_name", e.target.value)}
            placeholder={t("Nome da sua empresa")}
          />
        </div>

        {/*
          A precedência fica VISÍVEL. Sem isto, quem preencheu as `SMTP_*` no
          arquivo do servidor abre a tela com os campos já cheios, salva, e não
          tem como saber qual das duas fontes passou a valer.
        */}
        {origem === "environment" ? (
          <p
            data-testid="smtp-origem-ambiente"
            className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
          >
            {t(
              "Estes valores vieram do arquivo de configuração do servidor. O que você salvar aqui passa a valer no lugar dele; apagar o que está aqui faz o sistema voltar a usar o arquivo.",
            )}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <span data-testid="smtp-estado" className="text-xs text-muted-foreground">
            {transporte === "smtp"
              ? t("Em uso: o e-mail está saindo por este servidor.")
              : transporte === "resend"
                ? t("O e-mail desta instalação já sai por um serviço externo. Preencher esta tela passa a entrega para o seu servidor.")
                : t("Nenhum caminho de e-mail configurado: os convites aparecem como link para copiar, em vez de chegar na caixa de entrada.")}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              data-testid="smtp-testar"
              disabled={ocupado}
              onClick={testar}
            >
              {t("Testar conexão")}
            </Button>
            <Button type="button" data-testid="smtp-salvar" disabled={ocupado} onClick={salvar}>
              {ocupado ? t("Salvando…") : t("Salvar")}
            </Button>
          </div>
        </div>
      </Card>

      {/*
        O SERVIÇO EXTERNO, na mesma tela e depois do servidor próprio.

        A ordem não é estética: preencher o servidor próprio é a alternativa a
        contratar um serviço, e é o que o produto recomenda a quem instala numa
        VPS. Quem já usa um serviço externo encontra a chave dele aqui embaixo,
        em vez de procurá-la em outra tela — que era o defeito que o DEC-009
        nomeia.

        Os campos são o MESMO componente da tela de Credenciais, lendo a mesma
        linha do banco pela mesma ação de servidor. Uma segunda cópia do
        formulário é como as duas telas começariam a divergir.
      */}
      {servicoExterno.length > 0 ? (
        <Card className="flex flex-col gap-2 p-4" data-testid="email-servico-externo">
          <div>
            <h2 className="text-base font-semibold">{t("Serviço externo de envio")}</h2>
            <p className="text-sm text-muted-foreground">
              {t(
                "A alternativa ao servidor próprio: um serviço que entrega o e-mail por você. Se as duas coisas estiverem configuradas, o servidor próprio tem preferência.",
              )}
            </p>
          </div>
          <div>
            {servicoExterno.map((linha) => (
              <CampoEditavel key={linha.definicao.chave} linha={linha} idioma={idioma} />
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
