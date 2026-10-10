---
impacto: capacidade_nova
secao: adicionado
titulo: Conexões ganha Agendar pausa — a janela de manutenção pausa e retoma sozinha
---

Quem precisa desligar um número por alguns minutos (manutenção, troca de roteador, janela de silêncio) só tinha a pausa manual imediata: a conexão ficava desligada até alguém lembrar de religar, e ninguém sabia quem pausou nem por quê. Agora a Central de Conexões tem Agendar pausa: um diálogo marca início e fim no horário local da organização, escolhe uma conexão ou todas, e a pausa e a retomada acontecem sozinhas no horário marcado. A mensagem que chega durante a janela continua sendo gravada e volta à fila quando a conexão volta. Quando a janela pausa, a Central de avisos abre o aviso de canal pausado, e ele fecha sozinho na retomada, como na pausa manual. Janelas agendadas podem ser listadas e canceladas; o que o operador pausou com a mão não é religado pelo relógio, e duas janelas que se sobrepõem no mesmo canal só o religam no fim da última. Ainda não dá para editar uma janela (cancele e agende de novo), e uma falha do agendador aparece no log do servidor, não na Central. Nada precisa ser feito ao atualizar — a tela nova aparece sozinha em Conexões.

Contribuição de @webtecnica (issue #2388).
