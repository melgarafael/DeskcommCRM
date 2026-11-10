"use client";

import { useMemo } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { useContact } from "@/hooks/contacts/useContact";
import { useT } from "@/hooks/i18n/useT";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  atalhosParaExibir,
  type DadosDoAtalho,
  type IconeDeAtalho,
} from "@/lib/leads/atalhos-do-card";
import {
  EnvelopeSimple,
  FileText,
  Globe,
  LinkIcon,
  MapPin,
  Phone,
  Receipt,
  ShoppingCart,
} from "@/lib/ui/icons";

/**
 * OS ATALHOS DO CARD (issue #3487) — a faixa de botões que leva o atendente a
 * OUTRO sistema com o dado do cliente já preenchido: `tel:` abre o softphone do
 * PABX discando, `https://…?cliente={{erp_id}}` abre o app de pedidos no cliente
 * certo. Sem sair do card, sem copiar e colar.
 *
 * ─── O que esta tela NÃO faz ────────────────────────────────────────────────
 *
 * Não valida esquema e não decide nada sobre segurança: quem faz isso é
 * `atalhosParaExibir` (`lib/leads/atalhos-do-card.ts`), a MESMA régua que a
 * gravação usa. Aqui só se desenha o que voltou de lá — e o que voltou de lá já
 * passou pela allowlist de esquema, pela codificação de cada valor e pela
 * resolução de todos os marcadores.
 *
 * ─── Sem dado, sem botão ────────────────────────────────────────────────────
 *
 * Botão desabilitado seria pior que botão nenhum: a faixa mostraria um "Ligar"
 * cinza para quem não tem telefone, e o operador clicaria nele procurando o
 * motivo. A issue é explícita — sem o dado, o botão NÃO aparece — e é por isso
 * que a lista é filtrada antes de qualquer renderização: quando nenhum atalho
 * sobra, o componente devolve `null` e a faixa não existe.
 *
 * ─── O contato só é buscado quando há atalho ────────────────────────────────
 *
 * A lista vem por prop (o quadro, a lista e o calendário já têm o funil em mão),
 * mas o telefone e o e-mail vêm de `contacts` — e um GET por card aberto, em
 * funil sem atalho nenhum, seria rede paga para desenhar nada. O gancho condicional mora num
 * componente INTERNO (`ComContato`) que só é montado quando a lista tem item:
 * a regra dos hooks é respeitada por construção, não por sorte.
 */

const ICONE_DO_ATALHO: Record<IconeDeAtalho, PhosphorIcon> = {
  telefone: Phone,
  carrinho: ShoppingCart,
  link: LinkIcon,
  boleto: Receipt,
  documento: FileText,
  mapa: MapPin,
  email: EnvelopeSimple,
  site: Globe,
};

interface Props {
  /**
   * O que está gravado em `settings.atalhos` — `unknown` DE PROPÓSITO: o valor
   * vem de jsonb e pode estar sujo. Tipá-lo como `AtalhoDoCard[]` prometeria
   * uma garantia que o banco não dá.
   */
  atalhos: unknown;
  /** O negócio: `custom_fields` responde por `{{erp_id}}` e afins. */
  lead?: { id?: string | null; custom_fields?: Record<string, unknown> | null } | null;
  /** O contato do negócio; `null` em negócio sem contato vinculado. */
  contactId?: string | null;
}

/**
 * A faixa, pronta para o card. Devolve `null` quando não há o que desenhar.
 *
 * `lead` é o tipo mínimo, e não o `Lead` inteiro, para o painel do Inbox poder
 * passar a linha dele (que também é um recorte) sem conversão.
 */
export function AtalhosDoNegocio({ atalhos, lead, contactId }: Props) {
  const temAlgum = Array.isArray(atalhos) && atalhos.length > 0;
  if (!temAlgum) return null;
  return <ComContato atalhos={atalhos} lead={lead} contactId={contactId} />;
}

function ComContato({ atalhos, lead, contactId }: Props) {
  const t = useT();
  const { data } = useContact(contactId ?? "");
  const contato = data?.data ?? null;

  const dados = useMemo<DadosDoAtalho>(
    () => ({
      telefone: contato?.phone_number ?? null,
      // O MESMO resolvedor de nome que o resto do produto usa (`name` vence,
      // `display_name` do canal é o fallback, identificador técnico nunca vira
      // nome) — `{{nome}}` no link e o nome no cabeçalho não podem divergir.
      nome:
        nomeDoContato({ name: contato?.name, display_name: contato?.display_name }) ?? null,
      email: contato?.email ?? null,
      // `documento` fica ausente de propósito: o CPF/CNPJ em claro mora no
      // `custom_fields` (o contato só guarda `cpf_hash`), e é `valorDoMarcador`
      // quem procura lá — declarar a chave aqui com `null` só repetiria a
      // resposta errada.
      lead: { id: lead?.id ?? null, campos: lead?.custom_fields ?? null },
      contato: { id: contato?.id ?? null, campos: contato?.custom_fields ?? null },
    }),
    [contato, lead],
  );

  const visiveis = useMemo(() => atalhosParaExibir(atalhos, dados), [atalhos, dados]);
  if (visiveis.length === 0) return null;

  return (
    <ul
      className="flex flex-wrap gap-1.5"
      aria-label={t("Atalhos do negócio")}
      data-testid="atalhos-do-negocio"
    >
      {visiveis.map((atalho) => {
        const Icone = ICONE_DO_ATALHO[atalho.icone];
        return (
          <li key={`${atalho.rotulo}-${atalho.href}`}>
            <a
              href={atalho.href}
              // `http(s)` sai do produto: aba nova e `noopener noreferrer`, que
              // impede a página de destino de mexer nesta (`window.opener`) e de
              // saber de onde veio. `tel:` NÃO abre aba — o sistema entrega o
              // clique ao softphone.
              {...(atalho.externo ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              data-atalho={atalho.icone}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <Icone size={12} weight="regular" aria-hidden className="shrink-0" />
              <span className="truncate">{atalho.rotulo}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
