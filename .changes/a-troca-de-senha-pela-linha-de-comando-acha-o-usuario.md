---
impacto: nada_mudou
secao: corrigido
titulo: A troca de senha pela linha de comando volta a encontrar o usuário
---

Quem perde o acesso a uma instalação sem SMTP — o estado normal de um self-host
recém-instalado — só tem um caminho de volta: o `reset-password.sh` do kit. Ele
não funcionava para **ninguém**. Não era intermitente nem dependia do e-mail:
qualquer endereço, existente ou não, recebia a mesma resposta seca de "usuário
não encontrado", e a pessoa ficava trancada do lado de fora do próprio sistema.

A causa era uma consulta escrita na sintaxe errada. O script pedia ao servidor de
autenticação um filtro no formato do banco (`email.eq.<endereço>`), e esse
servidor não fala esse formato — ele usa a expressão inteira como texto de busca.
Como nenhum e-mail contém o pedaço `email.eq.`, a busca não achava nada, sempre.

Agora a consulta vai no formato que o servidor entende. E, como a busca dele é por
trecho do endereço, o script passou a exigir o e-mail **inteiro** antes de aceitar
o resultado: pedir `ana@empresa.com` também traz `mariana@empresa.com`, e entregar
a pessoa errada a um comando que TROCA SENHA seria pior que não achar ninguém. Na
dúvida ele não devolve nada — quem chama vê "não encontrado", que é ruim mas se
resolve; a senha de outra pessoa trocada, não.

Quem opera uma VPS não precisa fazer nada além de atualizar. Nenhuma configuração
muda, nenhum arquivo precisa ser editado à mão.
