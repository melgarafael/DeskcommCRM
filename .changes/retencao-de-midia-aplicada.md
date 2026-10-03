---
impacto: capacidade_nova
secao: adicionado
titulo: A retenção de mídia que a tela oferece passa a ser aplicada de verdade
---

O campo **Retenção de mídia (dias)** existia e nada apagava: a configuração ficava gravada em `organizations.media_retention_days` sem nenhum caminho do produto ler aquilo para tirar arquivo do bucket. Agora a retenção roda — e é opt-in: a organização que já existe só começa a expirar depois de ligar o novo interruptor **Aplicar a retenção de mídia** e confirmar (organização nova já nasce com ele ligado), o piso de 30 dias vale mesmo com valor menor gravado no banco, a mídia retirada some com a transcrição junto e a tela mostra "Mídia apagada pela política de retenção (N dias)" em vez de um 404 mudo. Pedido LGPD em andamento (`lgpd_requests` em `received`/`processing`) suspende a expiração da organização enquanto durar. Templates e avatares continuam intocados.

Contribuição de @webtecnica (#2180).
