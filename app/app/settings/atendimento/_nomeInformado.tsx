"use client";
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { definirNomeInformado } from '@/app/actions/settings/definirNomeInformado';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { traduzir } from '@/lib/i18n/dicionario';
import type { Idioma } from '@/lib/i18n/idiomas';

export function NomeInformado({ ligada, podeMudar, idioma }: { ligada: boolean; podeMudar: boolean; idioma: Idioma }) {
  const [valor, setValor] = useState(ligada);
  const [pendente, startTransition] = useTransition();
  const router = useRouter();
  const t = (texto: string) => traduzir(texto, idioma);
  return <Card className="p-6">
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="nome_informado_no_atendimento">{t('Preencher o nome que o cliente informa no atendimento')}</Label>
        <p className="max-w-2xl text-xs text-muted-foreground">{t('Quando o assistente identifica o próprio nome informado por texto e usa a capacidade Anotar dado que o cliente informou, pode preencher o nome vazio da ficha. O apelido do WhatsApp fica separado. Nomes existentes e e-mail continuam exigindo revisão humana. Confira a ficha se o assistente interpretar a mensagem incorretamente.')}</p>
        <p className="text-xs">{valor ? t('Ligado para novas mensagens de atendimento.') : t('Desligado: o nome continua como sugestão para revisão.')}</p>
      </div>
      <Switch id="nome_informado_no_atendimento" checked={valor} disabled={pendente || !podeMudar}
        onCheckedChange={(novo) => startTransition(async () => {
          const r = await definirNomeInformado(novo);
          if (!r.ok) { toast.error(t(r.error ?? 'Não foi possível salvar.')); return; }
          setValor(novo); toast.success(t('Opção salva.')); router.refresh();
        })} />
    </div>
  </Card>;
}
