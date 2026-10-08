import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './mikro-orm.config';

// Script de linha de comando para as migrations.
//   bun run db:migrate   -> aplica todas as pendentes
//   bun run db:rollback  -> desfaz a última migration aplicada
//   bun run db:status    -> mostra o que já rodou e o que está pendente
async function main(): Promise<void> {
  const command = process.argv[2];
  const orm = await MikroORM.init(buildOrmConfig());
  try {
    const migrator = orm.migrator;
    if (command === 'up') {
      const applied = await migrator.up();
      console.log(applied.length === 0 ? 'Nada a aplicar.' : `Aplicadas: ${applied.map((m) => m.name).join(', ')}`);
    } else if (command === 'down') {
      const reverted = await migrator.down();
      console.log(reverted.length === 0 ? 'Nada a desfazer.' : `Desfeitas: ${reverted.map((m) => m.name).join(', ')}`);
    } else if (command === 'status') {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      console.log('Executadas:', executed.map((m) => m.name));
      console.log('Pendentes:', pending.map((m) => m.name));
    } else {
      console.error('Use: bun run src/infra/database/migrate.ts <up|down|status>');
      process.exitCode = 1;
    }
  } finally {
    await orm.close();
  }
}

void main();