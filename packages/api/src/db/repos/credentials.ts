import type { DatabaseClient } from '../client.ts';

export interface CredentialRow {
  id: number;
  user_id: number;
  credential_id: Uint8Array;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  created_at: string;
}

export interface CredentialsRepo {
  insert(input: {
    userId: number;
    credentialId: Uint8Array;
    publicKey: Uint8Array;
    counter: number;
    transports?: readonly string[] | null;
  }): CredentialRow;
  findByCredentialId(credentialId: Uint8Array): CredentialRow | null;
  findByUserId(userId: number): CredentialRow[];
  updateCounter(credentialId: Uint8Array, counter: number): void;
}

function encodeTransports(transports: readonly string[] | null | undefined): string | null {
  if (!transports || transports.length === 0) return null;
  return transports.join(',');
}

export function createCredentialsRepo(db: DatabaseClient): CredentialsRepo {
  const insertStmt = db.prepare<
    CredentialRow,
    [number, Uint8Array, Uint8Array, number, string | null]
  >(
    `INSERT INTO credentials (user_id, credential_id, public_key, counter, transports)
     VALUES (?, ?, ?, ?, ?)
     RETURNING id, user_id, credential_id, public_key, counter, transports, created_at`,
  );
  const findByCredentialIdStmt = db.prepare<CredentialRow, [Uint8Array]>(
    `SELECT id, user_id, credential_id, public_key, counter, transports, created_at
     FROM credentials WHERE credential_id = ?`,
  );
  const findByUserIdStmt = db.prepare<CredentialRow, [number]>(
    `SELECT id, user_id, credential_id, public_key, counter, transports, created_at
     FROM credentials WHERE user_id = ? ORDER BY id ASC`,
  );
  const updateCounterStmt = db.prepare<unknown, [number, Uint8Array]>(
    'UPDATE credentials SET counter = ? WHERE credential_id = ?',
  );

  return {
    insert(input): CredentialRow {
      const row = insertStmt.get(
        input.userId,
        input.credentialId,
        input.publicKey,
        input.counter,
        encodeTransports(input.transports),
      );
      if (!row) throw new Error('credentials.insert: RETURNING gave no row');
      return row;
    },
    findByCredentialId(credentialId): CredentialRow | null {
      return findByCredentialIdStmt.get(credentialId) ?? null;
    },
    findByUserId(userId): CredentialRow[] {
      return findByUserIdStmt.all(userId);
    },
    updateCounter(credentialId, counter): void {
      updateCounterStmt.run(counter, credentialId);
    },
  };
}
