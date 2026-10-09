
export interface TransactionContext {
  run<T>(
    work: (context: TransactionSession) => Promise<T>,
  ): Promise<T>;
}

export interface TransactionSession {
  execute<T = unknown>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<T>;
}