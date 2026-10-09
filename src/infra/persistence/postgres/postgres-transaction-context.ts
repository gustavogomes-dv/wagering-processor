import type { SqlEntityManager } from '@mikro-orm/postgresql';
import type {
  TransactionContext,
  TransactionSession,
} from '../../../application/ports/transaction-context';

/**
 * Adapter que conecta o contrato da aplicação ao EntityManager transacional
 * do MikroORM.
 *
 * O mesmo EntityManager é repassado para todas as operações do callback.
 * Se qualquer etapa lançar erro, o MikroORM desfaz toda a transação.
 */
export class PostgresTransactionContext implements TransactionContext {
  constructor(private readonly em: SqlEntityManager) {}

   async run<T>(
    work: (context: TransactionSession) => Promise<T>,
  ): Promise<T> {
    return this.em.transactional(async (transactionalEm) => {
      const session: TransactionSession = {
        execute: async <R = unknown>(
          sql: string,
          parameters?: readonly unknown[],
        ): Promise<R> => {
          // Conversão isolada na infraestrutura para compatibilizar
          // o contrato da aplicação com a tipagem do MikroORM.
          const result = await transactionalEm.execute(
            sql,
            parameters ? [...parameters] : [],
          );

          return result as unknown as R;
        },
      };

      return work(session);
    });
  }
}  
