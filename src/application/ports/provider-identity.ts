/**
 * Ponto de extensão para autenticação dos provedores.
 *
 * No desafio, a autenticação ficou fora do timebox. Em produção, esta porta
 * será implementada por um guard ligado ao Identity Provider escolhido.
 */
export interface ProviderIdentityPort {
  assertAllowed(providerId: string): void;
}

/** Implementação local enquanto a API ainda não está ligada a um Identity Provider. */
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  assertAllowed(providerId: string): void {
    if (providerId.trim() === '') throw new Error('providerId is required');
  }
}
