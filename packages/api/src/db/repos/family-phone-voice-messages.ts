import type { DatabaseClient } from '../client.ts';

/**
 * Per-device voicemail rows. The agent worker is the first writer
 * (phase 6 voice_message rules); phase 7 PSTN inbound is the next.
 * Inbound rows carry `from_external` instead of `from_device_id`.
 */

export interface FamilyPhoneVoiceMessageRow {
  id: number;
  to_device_id: number;
  from_device_id: number | null;
  from_external: string | null;
  body: string;
  audio_blob: Uint8Array;
  sample_rate: number;
  channels: number;
  duration_ms: number;
  read_at: string | null;
  created_at: string;
}

/** Metadata-only projection (no BLOB) for list endpoints. */
export type FamilyPhoneVoiceMessageMeta = Omit<FamilyPhoneVoiceMessageRow, 'audio_blob'>;

export interface InsertVoiceMessageInput {
  toDeviceId: number;
  fromDeviceId: number | null;
  fromExternal: string | null;
  body: string;
  audio: Uint8Array;
  sampleRate: number;
  channels: number;
  durationMs: number;
}

export interface ListVoiceMessagesFilter {
  toDeviceId?: number;
  unreadOnly?: boolean;
}

export interface FamilyPhoneVoiceMessagesRepo {
  insert(input: InsertVoiceMessageInput): FamilyPhoneVoiceMessageMeta;
  /** Full row including the blob — used by the audio endpoint. */
  findById(id: number): FamilyPhoneVoiceMessageRow | null;
  /** List metadata, most-recent first. Filters as documented above. */
  list(filter: ListVoiceMessagesFilter): FamilyPhoneVoiceMessageMeta[];
  /** Stamp `read_at` on a row. Idempotent — re-marking is a no-op. */
  markRead(id: number, readAt: string): FamilyPhoneVoiceMessageMeta | null;
  /** Delete rows older than `cutoffIso`. Returns the count. Used by retention. */
  deleteOlderThan(cutoffIso: string): number;
}

export function createFamilyPhoneVoiceMessagesRepo(
  db: DatabaseClient,
): FamilyPhoneVoiceMessagesRepo {
  const insertStmt = db.prepare<
    FamilyPhoneVoiceMessageMeta,
    [number, number | null, string | null, string, Uint8Array, number, number, number]
  >(
    `INSERT INTO family_phone_voice_messages
       (to_device_id, from_device_id, from_external, body, audio_blob,
        sample_rate, channels, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, to_device_id, from_device_id, from_external, body,
       sample_rate, channels, duration_ms, read_at, created_at`,
  );
  const findByIdStmt = db.prepare<FamilyPhoneVoiceMessageRow, [number]>(
    `SELECT id, to_device_id, from_device_id, from_external, body,
            audio_blob, sample_rate, channels, duration_ms, read_at,
            created_at
       FROM family_phone_voice_messages WHERE id = ?`,
  );
  const listAllStmt = db.prepare<FamilyPhoneVoiceMessageMeta, []>(
    `SELECT id, to_device_id, from_device_id, from_external, body,
            sample_rate, channels, duration_ms, read_at, created_at
       FROM family_phone_voice_messages
      ORDER BY id DESC`,
  );
  const listByDeviceStmt = db.prepare<FamilyPhoneVoiceMessageMeta, [number]>(
    `SELECT id, to_device_id, from_device_id, from_external, body,
            sample_rate, channels, duration_ms, read_at, created_at
       FROM family_phone_voice_messages
      WHERE to_device_id = ?
      ORDER BY id DESC`,
  );
  const listUnreadStmt = db.prepare<FamilyPhoneVoiceMessageMeta, []>(
    `SELECT id, to_device_id, from_device_id, from_external, body,
            sample_rate, channels, duration_ms, read_at, created_at
       FROM family_phone_voice_messages
      WHERE read_at IS NULL
      ORDER BY id DESC`,
  );
  const listUnreadByDeviceStmt = db.prepare<FamilyPhoneVoiceMessageMeta, [number]>(
    `SELECT id, to_device_id, from_device_id, from_external, body,
            sample_rate, channels, duration_ms, read_at, created_at
       FROM family_phone_voice_messages
      WHERE to_device_id = ?
        AND read_at IS NULL
      ORDER BY id DESC`,
  );
  const markReadStmt = db.prepare<FamilyPhoneVoiceMessageMeta, [string, number]>(
    `UPDATE family_phone_voice_messages
        SET read_at = COALESCE(read_at, ?)
      WHERE id = ?
     RETURNING id, to_device_id, from_device_id, from_external, body,
       sample_rate, channels, duration_ms, read_at, created_at`,
  );
  const deleteOlderThanStmt = db.prepare<unknown, [string]>(
    `DELETE FROM family_phone_voice_messages
      WHERE datetime(created_at) < datetime(?)`,
  );

  return {
    insert(input): FamilyPhoneVoiceMessageMeta {
      const row = insertStmt.get(
        input.toDeviceId,
        input.fromDeviceId,
        input.fromExternal,
        input.body,
        input.audio,
        input.sampleRate,
        input.channels,
        input.durationMs,
      );
      if (!row) throw new Error('family_phone_voice_messages.insert: RETURNING gave no row');
      return row;
    },
    findById(id): FamilyPhoneVoiceMessageRow | null {
      return findByIdStmt.get(id) ?? null;
    },
    list(filter): FamilyPhoneVoiceMessageMeta[] {
      if (filter.toDeviceId !== undefined && filter.unreadOnly === true) {
        return listUnreadByDeviceStmt.all(filter.toDeviceId);
      }
      if (filter.toDeviceId !== undefined) {
        return listByDeviceStmt.all(filter.toDeviceId);
      }
      if (filter.unreadOnly === true) {
        return listUnreadStmt.all();
      }
      return listAllStmt.all();
    },
    markRead(id, readAt): FamilyPhoneVoiceMessageMeta | null {
      return markReadStmt.get(readAt, id) ?? null;
    },
    deleteOlderThan(cutoffIso): number {
      return deleteOlderThanStmt.run(cutoffIso).changes;
    },
  };
}
