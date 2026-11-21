/**
 * Sync add-on data model. Nothing in the core imports this module; the core
 * storage format is unchanged. See docs/sync-design.md.
 */

export type DeviceId = string;

/** Version vector: per-device edit counters for one annotation's note text. */
export type VV = Record<string, number>;

/** Every Highlight field except identity, owning set, creation time and note text. */
export type HighlightMeta = Record<string, unknown>;

export interface SyncHighlightRecord {
  id: string;
  /** Immutable after creation (the core has no "move to set" operation). */
  setId: string;
  created: string;

  // Lifecycle domain (last writer wins).
  deleted: boolean;
  statusTs: number;
  statusBy: DeviceId;

  // Style and structure domain (last writer wins, compared as one unit).
  meta: HighlightMeta;
  metaTs: number;
  metaBy: DeviceId;

  // Note domain (version vector; concurrent edits are kept, never dropped).
  note: string;
  noteContentCJK: string;
  noteVV: VV;
  /** Ordering and display only. Causality comes from noteVV. */
  noteTs: number;
  noteBy: DeviceId;
}

export type SyncSetKind = "manual" | "import" | "ai";

export interface SyncSetRecord {
  id: string;
  name: string;
  kind: SyncSetKind;
  accent: string;
  created: string;
  archived: boolean;
  ts: number;
  by: DeviceId;
}

/** Contents of one device's shard for one PDF. Only that device writes it. */
export interface ShardPayload {
  schema: 1;
  kind: "device-shard";
  docHash: string;
  deviceId: DeviceId;
  writeNonce: string;
  sets: SyncSetRecord[];
  records: SyncHighlightRecord[];
}

export interface NoteVersion {
  note: string;
  noteContentCJK: string;
  noteVV: VV;
  noteTs: number;
  noteBy: DeviceId;
}

export interface MergedHighlight {
  id: string;
  setId: string;
  created: string;
  meta: HighlightMeta;
  metaTs: number;
  metaBy: DeviceId;
  /** Raw lifecycle winner, before the "newer note keeps it alive" rule. */
  deleted: boolean;
  statusTs: number;
  statusBy: DeviceId;
  /** True when the annotation should not be shown. */
  effectiveDeleted: boolean;
  /** Text to show: the primary version, plus stitched concurrent versions. */
  note: string;
  noteContentCJK: string;
  /** The newest concurrent version, copied verbatim on meta-only edits. */
  primaryNote: NoteVersion;
  /** Version vectors of every concurrent version; a new edit supersedes all. */
  noteHeads: VV[];
  hasNoteConflict: boolean;
}

export interface MergedSet extends SyncSetRecord {
  /** Placeholder for highlights whose set metadata has not arrived yet. */
  synthetic?: boolean;
}

export interface MergedState {
  sets: Map<string, MergedSet>;
  highlights: Map<string, MergedHighlight>;
}
