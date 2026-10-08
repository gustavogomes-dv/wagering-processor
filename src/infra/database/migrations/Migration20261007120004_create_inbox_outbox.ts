import { Migration } from '@mikro-orm/migrations';

// Quarta migration: inbox (deduplicação de mensagens recebidas) e outbox (eventos a publicar).
export class CreateInboxOutbox extends Migration {
  override up(): void {
    // Inbox: a chave primária (consumidor, mensagem) é a deduplicação persistente.
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id),
        constraint inbox_messages_text_not_blank check (
          btrim(consumer_name) <> '' and btrim(message_id) <> '' and btrim(payload_hash) <> ''
        )
      )
    `);
    this.addSql(`
      create function inbox_messages_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'inbox_messages: rows cannot be deleted' using errcode = 'check_violation';
        end if;
        if new.consumer_name is distinct from old.consumer_name
           or new.message_id is distinct from old.message_id
           or new.payload_hash is distinct from old.payload_hash
           or new.received_at is distinct from old.received_at then
          raise exception 'inbox_messages: identity fields are immutable' using errcode = 'check_violation';
        end if;
        if old.processed_at is not null and new.processed_at is distinct from old.processed_at then
          raise exception 'inbox_messages: processed_at cannot change once set' using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger inbox_messages_guard_trg before update or delete on inbox_messages
        for each row execute function inbox_messages_guard()
    `);
    this.addSql(`
      create trigger inbox_messages_no_truncate_trg before truncate on inbox_messages
        for each statement execute function forbid_truncate()
    `);

    // Outbox: o evento nasce na mesma transação da movimentação e um publisher envia depois.
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        created_at timestamptz not null,
        constraint outbox_messages_text_not_blank check (btrim(aggregate_id) <> '' and btrim(event_type) <> ''),
        constraint outbox_messages_payload_is_object check (jsonb_typeof(payload) = 'object'),
        constraint outbox_messages_attempts_valid check (attempts >= 0)
      )
    `);
    // Índice dos publishers: só as mensagens que ainda não foram publicadas, na ordem em que ocorreram.
    this.addSql(`
      create index outbox_messages_pending_idx on outbox_messages (occurred_at, id)
        where published_at is null
    `);
    this.addSql(`
      create function outbox_messages_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          if old.published_at is null then
            raise exception 'outbox_messages: an unpublished message cannot be deleted'
              using errcode = 'check_violation';
          end if;
          return old;
        end if;
        if new.id is distinct from old.id
           or new.aggregate_id is distinct from old.aggregate_id
           or new.event_type is distinct from old.event_type
           or new.payload is distinct from old.payload
           or new.occurred_at is distinct from old.occurred_at
           or new.created_at is distinct from old.created_at then
          raise exception 'outbox_messages: the event content is immutable' using errcode = 'check_violation';
        end if;
        if old.published_at is not null then
          raise exception 'outbox_messages: a published message cannot change' using errcode = 'check_violation';
        end if;
        if new.attempts < old.attempts then
          raise exception 'outbox_messages: attempts cannot decrease' using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger outbox_messages_guard_trg before update or delete on outbox_messages
        for each row execute function outbox_messages_guard()
    `);
    this.addSql(`
      create trigger outbox_messages_no_truncate_trg before truncate on outbox_messages
        for each statement execute function forbid_truncate()
    `);
  }

  override down(): void {
    this.addSql('drop trigger outbox_messages_no_truncate_trg on outbox_messages');
    this.addSql('drop trigger outbox_messages_guard_trg on outbox_messages');
    this.addSql('drop function outbox_messages_guard()');
    this.addSql('drop table outbox_messages');
    this.addSql('drop trigger inbox_messages_no_truncate_trg on inbox_messages');
    this.addSql('drop trigger inbox_messages_guard_trg on inbox_messages');
    this.addSql('drop function inbox_messages_guard()');
    this.addSql('drop table inbox_messages');
  }
}