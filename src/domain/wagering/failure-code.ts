// Códigos de falha estáveis. Eu nunca renomeio um código depois de publicado,
// porque o provedor pode estar tomando decisão em cima dele.
export enum FailureCode {
  // Saldo
  InsufficientFunds = 'INSUFFICIENT_FUNDS', // BET sem saldo
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW', // ROLLBACK/REFUND que deixaria o saldo negativo

  // Referência
  ReferenceNotFound = 'REFERENCE_NOT_FOUND', // esgotou as tentativas e a referência nunca chegou
  ReferenceKindInvalid = 'REFERENCE_KIND_INVALID', // tipo da referência não é aceito (ex.: REFUND de um WIN)
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED', // a referência existe, mas não foi aplicada (rejeitada/falhou)
  ReferenceMismatch = 'REFERENCE_MISMATCH', // provider, player, wallet, moeda ou rodada diferentes
  AmountMismatch = 'AMOUNT_MISMATCH', // valor da reversão diferente do valor da referência
  AlreadyReversed = 'ALREADY_REVERSED', // essa referência já foi revertida por esse tipo de operação

  // Wallet
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletCurrencyMismatch = 'WALLET_CURRENCY_MISMATCH', // moeda da transação diferente da moeda da wallet
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH', // playerId da transação não é o dono da wallet

  // Infraestrutura (usado em transações FAILED)
  InternalError = 'INTERNAL_ERROR',
}

// O que o provedor deve fazer ao receber cada código.
export enum ProviderAction {
  Resend = 'RESEND', // pode reenviar a mesma transação depois
  FixPayload = 'FIX_PAYLOAD', // precisa corrigir os dados e enviar como uma transação nova
  GiveUp = 'GIVE_UP', // decisão final, reenviar não muda o resultado
}

const ACTION_BY_CODE: Record<FailureCode, ProviderAction> = {
  [FailureCode.InsufficientFunds]: ProviderAction.GiveUp,
  [FailureCode.ReversalWouldOverdraw]: ProviderAction.GiveUp,
  [FailureCode.ReferenceNotFound]: ProviderAction.FixPayload,
  [FailureCode.ReferenceKindInvalid]: ProviderAction.FixPayload,
  [FailureCode.ReferenceNotProcessed]: ProviderAction.GiveUp,
  [FailureCode.ReferenceMismatch]: ProviderAction.FixPayload,
  [FailureCode.AmountMismatch]: ProviderAction.FixPayload,
  [FailureCode.AlreadyReversed]: ProviderAction.GiveUp,
  [FailureCode.WalletNotFound]: ProviderAction.FixPayload,
  [FailureCode.WalletCurrencyMismatch]: ProviderAction.FixPayload,
  [FailureCode.WalletPlayerMismatch]: ProviderAction.FixPayload,
  [FailureCode.InternalError]: ProviderAction.Resend,
};

// Dado um código, eu respondo o que o provedor deve fazer.
export function providerActionFor(code: FailureCode): ProviderAction {
  return ACTION_BY_CODE[code];
}