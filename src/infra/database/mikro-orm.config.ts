import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { MIGRATIONS } from './migrations';

// Monta a configuração do MikroORM. Eu recebo a URL por parâmetro para os testes
// conseguirem apontar para um banco separado, sem mexer no banco de desenvolvimento.
export function buildOrmConfig(databaseUrl: string = process.env.DATABASE_URL ?? '') {
  if (databaseUrl === '') {
    throw new Error('DATABASE_URL is required');
  }
  return defineConfig({
    clientUrl: databaseUrl,
    // Ainda não tenho entidades mapeadas (isso vem no use case), então eu desligo o aviso.
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: 'mikro_orm_migrations',
      // Cada migration roda em transação e o lote inteiro é tudo ou nada.
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}