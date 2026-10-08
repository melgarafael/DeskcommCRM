---
impacto: nada_mudou
secao: corrigido
titulo: Os backups passam a ser legíveis só pelo dono da VPS
---

O backup do kit (`hostgator-setup-kit/backup.sh`) gravava a sessão do WhatsApp
e os anexos dos clientes com permissão de leitura para os demais usuários da
máquina, por mais restrita que fosse a configuração de quem o chamava — e a
sessão do WhatsApp é o pareamento do número inteiro. Conforme o jeito de
chamá-lo, o dump do banco e a pasta `backups/` também saíam com essa permissão.
O `scripts/backup-db.sh` tinha o mesmo problema com o dump dele.

Agora os arquivos dos dois backups saem legíveis só por quem rodou o backup, e a
pasta `backups/` fica fechada para os demais usuários já no próximo backup,
inclusive com os arquivos antigos dentro dela. Se a pasta estiver num disco que
não aceita mudar permissão, o backup avisa e segue. Não é preciso fazer nada.
