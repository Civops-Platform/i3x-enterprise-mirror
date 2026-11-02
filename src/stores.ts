// What the mirror writes into, as three small interfaces, and a minimal in-memory
// implementation of each. A host with its own last-value cache, history store or
// address space implements the interface instead.

import { EventEmitter } from "node:events";
import type { ObjectDef, Quality, TypeDef, VQT } from "./types";

export interface MirrorCache {
  /** An attribute exists before its first value, so it reads GoodNoData rather than not found. */
  declare(attributeId: string, upstreamId: string): void;
  set(attributeId: string, value: VQT["value"], quality: Quality, timestamp: string): void;
  /** Quality changes with no new value: the uplink dropped. The last value is kept. */
  mark(attributeId: string, quality: Quality): void;
}

export interface MirrorHistory {
  append(points: VQT[]): void;
}

export interface MirrorModel {
  /** Replace everything mounted from this upstream. */
  mount(upstreamId: string, types: TypeDef[], objects: ObjectDef[]): void;
}

export interface CachedValue { value: VQT["value"]; quality: Quality; timestamp: string }

/**
 * Last values. A value never becomes a different value on its own: losing the
 * uplink can only make it worse-quality, and Bad is never upgraded by a mark.
 */
export class LastValueCache extends EventEmitter implements MirrorCache {
  private values = new Map<string, CachedValue>();
  private declared = new Set<string>();

  declare(attributeId: string, _upstreamId: string) { this.declared.add(attributeId); }

  set(attributeId: string, value: VQT["value"], quality: Quality, timestamp: string) {
    const current = { value, quality, timestamp };
    this.values.set(attributeId, current);
    this.emit("change", attributeId, current);
  }

  mark(attributeId: string, quality: Quality) {
    const prev = this.values.get(attributeId);
    if (!prev) {
      // Never received a value: there is nothing to keep, and null at this quality is the truth.
      this.set(attributeId, null, quality, new Date().toISOString());
      return;
    }
    if (prev.quality === quality || prev.quality === "Bad" || (quality === "Uncertain" && prev.quality !== "Good")) return;
    this.values.set(attributeId, { ...prev, quality });
    this.emit("change", attributeId, { ...prev, quality });
  }

  read(attributeId: string): VQT | null {
    const v = this.values.get(attributeId);
    if (v) return { attributeId, ...v };
    return this.declared.has(attributeId) ? { attributeId, value: null, quality: "GoodNoData", timestamp: new Date().toISOString() } : null;
  }
}

/** A bounded in-memory window per attribute (default 24 h, 10,000 points), kept in time order. */
export class MemoryHistory implements MirrorHistory {
  private series = new Map<string, VQT[]>();
  constructor(private o: { windowMs?: number; maxPerAttribute?: number } = {}) {}

  append(points: VQT[]) {
    const windowMs = this.o.windowMs ?? 24 * 3600_000, maxPer = this.o.maxPerAttribute ?? 10_000;
    for (const p of points) {
      let s = this.series.get(p.attributeId);
      if (!s) { s = []; this.series.set(p.attributeId, s); }
      // Out-of-order points (backfill after an outage) are inserted in place, so reads stay ordered.
      if (s.length && s[s.length - 1].timestamp > p.timestamp) s.splice(s.findIndex((x) => x.timestamp > p.timestamp), 0, p);
      else s.push(p);
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      let drop = 0;
      while (drop < s.length && s[drop].timestamp < cutoff) drop++;
      if (s.length - drop > maxPer) drop = s.length - maxPer;
      if (drop) s.splice(0, drop);
    }
  }

  read(attributeIds: readonly string[], from: string, to: string): VQT[] {
    return attributeIds.flatMap((id) => (this.series.get(id) ?? []).filter((p) => p.timestamp >= from && p.timestamp <= to));
  }
}

/** The mounted address space: every upstream's types and objects, and which upstream owns an element. */
export class MountedModel implements MirrorModel {
  private mounts = new Map<string, { types: TypeDef[]; objects: ObjectDef[] }>();
  private owner = new Map<string, string>();

  mount(upstreamId: string, types: TypeDef[], objects: ObjectDef[]) {
    for (const o of this.mounts.get(upstreamId)?.objects ?? []) this.owner.delete(o.id);
    this.mounts.set(upstreamId, { types, objects });
    for (const o of objects) this.owner.set(o.id, upstreamId);
  }

  objects(): ObjectDef[] { return [...this.mounts.values()].flatMap((m) => m.objects); }
  types(): TypeDef[] { return [...this.mounts.values()].flatMap((m) => m.types); }
  /** The upstream that owns an element, for forwarding a write to it. */
  ownerOf(elementId: string): string | undefined { return this.owner.get(elementId); }
}
