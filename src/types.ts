// The i3X shapes the mirror needs, copied from the i3X 1.0 wire format so the
// package stands alone. Structural: a host's own types fit.

/** One value, with quality and source timestamp, as i3X serves it. */
export interface VQT {
  attributeId: string;
  value: number | string | boolean | null;
  quality: "Good" | "GoodNoData" | "Bad" | "Uncertain";
  timestamp: string;
}

export type Quality = VQT["quality"];

/**
 * Replay class. P0 alarms and quality, P1 current values, P2 records, P3 bulk
 * history. A site that does not publish its classes is mirrored as all P1.
 */
export type PriorityClass = "P0" | "P1" | "P2" | "P3";

export interface AttributeDef {
  name: string;
  dataType: "number" | "integer" | "string" | "boolean" | "object" | "array";
}

/** A type as the site serves it, mounted locally. */
export interface TypeDef {
  id: string;
  name: string;
  namespaceUri: string;
  kind: "mounted";
  attributes: AttributeDef[];
  priority: PriorityClass;
}

/** An object as the site serves it, under the site's own element id. */
export interface ObjectDef {
  id: string;
  name: string;
  typeId: string;
  parentId: string | null;
  /** Non-hierarchical relationships from the site's metadata: { CapturedBy: [id] }. */
  relationships: Record<string, string[]>;
  /** The upstream it came from. */
  upstream: string;
}
