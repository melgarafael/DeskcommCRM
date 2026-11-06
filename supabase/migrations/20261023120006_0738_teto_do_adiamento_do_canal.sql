-- manifest: prospecting_campaigns.channel_down_since — desde quando a campanha espera o canal voltar ao `WORKING`. Sem ele o adiamento da reconexão (#3073) não tem TETO: uma sessão presa fora de `WORKING` deixa a campanha "Ativa" sem enviar e sem aviso (STARTING não gera aviso de saúde). Com a coluna, o tick pausa quando a espera passa de TETO_DO_ADIAMENTO_MS; nulo = a campanha não está esperando.
alter table public.prospecting_campaigns
  add column if not exists channel_down_since timestamptz;
