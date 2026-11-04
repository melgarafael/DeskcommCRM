---
impacto: nada_mudou
secao: corrigido
titulo: Salvar o aviso de caso sem configuração salva não apaga mais o WhatsApp da equipe
---

Em Casos › Avisos › "Avisar no WhatsApp", quando ainda não havia configuração
salva, a tela abria com os campos dos números da equipe em branco e o salvamento
mandava esses campos vazios como "esta pessoa não tem número" — e o número
gravado de cada pessoa era apagado do banco. Quem tinha cadastrado o próprio
WhatsApp precisava cadastrar de novo, sem aviso nenhum. O caso mais comum era
remover o destinatário e configurar de novo.

Agora o rascunho da tela parte sempre dos números já gravados, mesmo sem
configuração salva, então a pessoa vê o que está salvando. E o salvamento só
apaga o número de quem a tela efetivamente mostrou: membro que a tela não exibiu
(por exemplo quando a leitura dos números da equipe falha) fica intacto, e a tela
diz que não conseguiu ler em vez de sugerir que ninguém tem número. Limpar o
campo de propósito continua apagando o número daquela pessoa.
