---
impacto: capacidade_nova
secao: adicionado
titulo: Cada organização pode cadastrar o próprio gateway de pagamento
---

Até agora o provedor de pagamento era da INSTALAÇÃO: uma conta de gateway só,
configurada na tela de Cobrança, que existe para o revendedor cobrar as empresas
hospedadas. Quem atende pelo CRM não tinha como receber do próprio cliente — o
dinheiro de uma venda feita na conversa não tinha para onde ir na conta de quem
vendeu.

Cada organização passa a poder cadastrar o **próprio** provedor (Stripe ou
Asaas) com a própria chave. A chave é conferida no provedor antes de ser gravada
e fica cifrada (AES-256-GCM): a tela mostra só os quatro últimos caracteres.
Organização sem configuração própria — ou com a configuração desligada — **não
cobra**, e a tela diz isso: a conta da instalação não é usada no lugar dela,
porque numa instalação de revendedor a venda cairia na conta do revendedor.
Desligar não apaga a credencial, porque cobrança já emitida aponta para ela.

O catálogo de produtos e serviços, o envio da cobrança na conversa e o
comprovante continuam fora: esta etapa entrega a configuração e o resolvedor que
as etapas seguintes vão consumir.
