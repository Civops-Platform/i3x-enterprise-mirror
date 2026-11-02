// The mirror against a fake i3X site (tests/fake-site.ts). Synthetic data only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { UpstreamMirror, LastValueCache, MemoryHistory, MountedModel } from "../src/index";
import { fakeSite, TOKENS } from "./fake-site";

async function until<T>(f: () => T | false | undefined | null, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
}

function setup(url: string, extra: object = {}) {
  const model = new MountedModel(), cache = new LastValueCache(), history = new MemoryHistory();
  const mirror = new UpstreamMirror({ id: "site-a", url, token: TOKENS.mirror, retryMs: 200, ...extra }, { model, cache, history });
  return { model, cache, history, mirror };
}

test("same element ids, structure and relationships; values arrive and stream live", async () => {
  const site = await fakeSite();
  const { model, cache, mirror } = setup(site.url);
  try {
    await mirror.start();
    await until(() => mirror.connected);
    assert.deepEqual(model.objects().map((o) => o.id).sort(), [...site.objectIds].sort(), "the site's own ids");
    const tank = model.objects().find((o) => o.id === "tank:t101")!;
    assert.equal(tank.parentId, "area:north");
    assert.deepEqual(tank.relationships, { MonitoredBy: ["alarm:t101-high"] }, "hierarchy is structure, other relationships are kept");
    assert.equal(model.ownerOf("tank:t101"), "site-a");
    assert.equal(cache.read("tank:t101/level")!.value, 41.5);
    assert.equal(cache.read("alarm:t101-high/value")!.value, "normal", "a scalar type is one attribute, `value`");
    assert.equal(model.types().find((t) => t.id === "type:alarm")!.priority, "P0");

    site.set("tank:t101", { level: 44, temp: 18.4 });
    await until(() => cache.read("tank:t101/level")!.value === 44);
    assert.equal(cache.read("tank:t101/level")!.quality, "Good");
  } finally { mirror.stop(); await site.close(); }
});

test("site down → every mirrored value Uncertain with its last value; back up → gap replayed P0, records, current, history; live again", async () => {
  const site = await fakeSite();
  const { cache, history, mirror } = setup(site.url);
  try {
    await mirror.start();
    await until(() => mirror.connected);

    await site.down();
    await until(() => cache.read("tank:t101/level")!.quality === "Uncertain");
    assert.equal(cache.read("tank:t101/level")!.value, 41.5, "the last value stays visible, marked not live");
    assert.equal(cache.read("wo:1001/status")!.quality, "Uncertain");
    assert.equal(mirror.connected, false);

    // While the uplink is down, the site has an alarm transition, a record change and new readings.
    const tAlarm = new Date().toISOString();
    site.set("alarm:t101-high", "tripped-during-outage", "Good", tAlarm);
    site.set("alarm:t101-high", "normal");
    site.set("wo:1001", { status: "active", order: "SO-OUTAGE" });
    site.set("tank:t101", { level: 47.25, temp: 19 });

    await site.up();
    await until(() => mirror.connected, 10_000);
    assert.deepEqual(mirror.replayLog.map((p) => p.phase), ["P0", "P2", "P1", "P3"], "replay order");
    assert.ok(mirror.replayLog[0].points >= 2, "P0 history replayed");
    const alarms = history.read(["alarm:t101-high/value"], new Date(Date.parse(tAlarm) - 1000).toISOString(), new Date().toISOString());
    assert.ok(alarms.some((p) => p.value === "tripped-during-outage"), "the alarm that came and went during the outage is in the mirror's history");
    assert.equal(cache.read("wo:1001/order")!.value, "SO-OUTAGE");
    assert.deepEqual([cache.read("tank:t101/level")!.value, cache.read("tank:t101/level")!.quality], [47.25, "Good"]);

    site.set("tank:t101", { level: 50, temp: 19.1 });
    await until(() => cache.read("tank:t101/level")!.value === 50);
  } finally { mirror.stop(); await site.close(); }
});

test("pause holds the uplink cut until resume; a site that never publishes priorities is mirrored as P1", async () => {
  const site = await fakeSite({ publishPriorities: false });
  const { cache, mirror, model } = setup(site.url);
  try {
    await mirror.start();
    await until(() => mirror.connected);
    assert.ok(model.types().every((t) => t.priority === "P1"));
    mirror.pause();
    await until(() => cache.read("tank:t101/temp")!.quality === "Uncertain");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(mirror.connected, false, "no reconnect while paused");
    mirror.resume();
    await until(() => mirror.connected);
    assert.deepEqual(mirror.replayLog.map((p) => [p.phase, p.elements]), [["P0", 0], ["P2", 0], ["P1", 4], ["P3", 4]]);
  } finally { mirror.stop(); await site.close(); }
});

test("a host's own classes override; writes go to the site with the caller's credential, and the site decides", async () => {
  const site = await fakeSite({ publishPriorities: false });
  const { mirror, model } = setup(site.url, { priorityByType: { "type:alarm": "P0" } });
  try {
    await mirror.start();
    await until(() => mirror.connected);
    assert.equal(model.types().find((t) => t.id === "type:alarm")!.priority, "P0");

    const body = { updates: [{ elementId: "wo:1001", value: { value: { status: "closed", order: "SO-VIA-ENTERPRISE" } } }] };
    const ok = await mirror.forward("/objects/value", body, `Bearer ${TOKENS.publisher}`, "key-1");
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).success, true);
    assert.deepEqual((site.current.get("wo:1001")!.value as any).order, "SO-VIA-ENTERPRISE");
    assert.deepEqual([site.writes[0].token, site.writes[0].idempotencyKey], [TOKENS.publisher, "key-1"], "the caller's token, not the mirror's");

    const denied = await mirror.forward("/objects/value", body, `Bearer ${TOKENS.reader}`);
    assert.equal(JSON.parse(denied.text).results[0].responseDetail.status, 403, "the site refuses a caller it would refuse directly");
    assert.ok(!site.writes.some((w) => w.token === TOKENS.mirror), "the mirror never writes with its own credential");
  } finally { mirror.stop(); await site.close(); }
});
