import type { MigrationObject } from '@mikro-orm/core';
import { CreateWallets } from './Migration20261007120001_create_wallets';
import { CreateWagerTransactions } from './Migration20261007120002_create_wager_transactions';
import { CreateWalletLedgerEntries } from './Migration20261007120003_create_wallet_ledger_entries';
import { CreateInboxOutbox } from './Migration20261007120004_create_inbox_outbox';

// Lista explícita das migrations, na ordem em que elas rodam.
// Eu uso lista em vez de procurar arquivos na pasta para não depender de glob nem de caminho.
export const MIGRATIONS: MigrationObject[] = [
  { name: 'Migration20261007120001_create_wallets', class: CreateWallets },
  { name: 'Migration20261007120002_create_wager_transactions', class: CreateWagerTransactions },
  { name: 'Migration20261007120003_create_wallet_ledger_entries', class: CreateWalletLedgerEntries },
  { name: 'Migration20261007120004_create_inbox_outbox', class: CreateInboxOutbox },
];