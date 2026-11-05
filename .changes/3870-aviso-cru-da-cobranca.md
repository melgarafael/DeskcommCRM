---
impacto: nada_mudou
secao: corrigido
titulo: O aviso do provedor de cobrança fica gravado como chegou
---

O arquivo dos avisos (`webhook_events_log`) existia para responder "o que o
provedor mandou?" depois de um incidente, mas guardava um corpo montado pelo
CRM: `{}` quando a assinatura não conferia e um `{id,type}` quando conferia.
O aviso original era descartado na leitura, e uma reentrega que falhasse cinco
vezes não deixava rastro nenhum do conteúdo.

Agora o corpo é gravado **byte a byte como chegou**, inclusive quando a
assinatura falha, quando a empresa do cliente não é identificada e quando o
processamento dá erro. O corpo vazio fica vazio (não vira `{}`), o que não é
JSON fica registrado como está com o motivo nomeado na linha, e a reentrega do
mesmo evento continua sendo **uma linha só**. Nada muda na tela nem na
conferência de assinatura; os cabeçalhos da credencial (o token do provedor)
continuam fora do arquivo, e a poda de 7 dias do corpo segue valendo.
