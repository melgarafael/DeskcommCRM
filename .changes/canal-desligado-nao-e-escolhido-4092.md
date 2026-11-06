---
impacto: nada_mudou
secao: corrigido
titulo: Abrir conversa pula o canal desligado em vez de recusar a abertura
---

Abrir uma conversa sem escolher canal — o "salvar e iniciar conversa" do
cadastro, o lembrete de tarefa e a ferramenta de início de conversa do agente —
pegava o canal conectado mais antigo da organização sem olhar se o operador o
tinha desligado. Com o número velho desligado e um novo conectado depois, a
abertura era recusada com "este canal está desligado ou fora do ar" mesmo
havendo outro canal pronto para enviar.

A escolha agora pula os canais desligados em todos os degraus e usa o próximo
que pode enviar. A ordem de sempre continua valendo:
**conectado antes de fora do ar, telefone antes de rede social**. Entre os que
podem enviar, o desempate segue o mais antigo. A recusa só acontece quando
nenhum canal pode enviar — e, quando todos estão desligados, ela continua sendo
a mesma, com o convite a reativar a conexão.
