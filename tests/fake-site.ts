// A small i3X 1.0 site server for the tests: the read, history, subscription and
// write endpoints the mirror uses, over a synthetic model (one tank, one alarm,
// one work-order record). It can be taken down (listener closed, every open
// connection cut) and brought back on the same port.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

type Q = "Good" | "Uncertain" | "Bad" | "GoodNoData";
interface Point { value: unknown; quality: Q; timestamp: string }

const NS = "https://example.com/i3x/synthetic/1.0";
export const TOKENS = { mirror: "t-mirror", publisher: "t-publisher", reader: "t-reader" };

export async function fakeSite(o: { publishPriorities?: boolean } = {}) {
  const types = [
    { elementId: "type:tank", displayName: "Tank", namespaceUri: NS, schema: { type: "object", properties: { level: { type: "number" }, temp: { type: "number" } } } },
    { elementId: "type:alarm", displayName: "Alarm", namespaceUri: NS, schema: { type: ["string", "null"] } },
    { elementId: "type:workorder", displayName: "Work order", namespaceUri: NS, schema: { type: "object", properties: { status: { type: "string" }, order: { type: "string" } } } },
    { elementId: "type:folder", displayName: "Folder", namespaceUri: NS, schema: { type: "null" } },
  ];
  const objects = [
    { elementId: "area:north", displayName: "North area", typeElementId: "type:folder", parentId: null },
    { elementId: "tank:t101", displayName: "Tank T-101", typeElementId: "type:tank", parentId: "area:north", metadata: { relationships: { HasParent: ["area:north"], MonitoredBy: ["alarm:t101-high"] } } },
    { elementId: "alarm:t101-high", displayName: "T-101 high level", typeElementId: "type:alarm", parentId: "area:north" },
    { elementId: "wo:1001", displayName: "Work order 1001", typeElementId: "type:workorder", parentId: "area:north" },
  ];
  const priorityByType = { "type:tank": "P1", "type:alarm": "P0", "type:workorder": "P2", "type:folder": "P1" };
  const history = new Map<string, Point[]>();
  const current = new Map<string, Point>();
  const streams = new Set<ServerResponse>();
  const writes: Array<{ token: string | undefined; idempotencyKey: string | undefined; body: unknown }> = [];

  /** The site's own data changing: recorded in history and pushed to open streams. */
  const set = (elementId: string, value: unknown, quality: Q = "Good", timestamp = new Date().toISOString()) => {
    const p = { value, quality, timestamp };
    current.set(elementId, p);
    history.set(elementId, [...(history.get(elementId) ?? []), p]);
    const frame = `id: ${timestamp}\ndata: ${JSON.stringify([{ elementId, ...p }])}\n\n`;
    for (const s of streams) s.write(frame);
  };
  set("tank:t101", { level: 41.5, temp: 18.2 });
  set("alarm:t101-high", "normal");
  set("wo:1001", { status: "open", order: "SO-1" });

  const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const read = (req: IncomingMessage) => new Promise<any>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})); });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token || !Object.values(TOKENS).includes(token)) return json(res, 401, { success: false });
    const u = new URL(req.url!, "http://x");
    const path = u.pathname.replace(/^\/v1/, "");
    const body = req.method === "GET" ? {} : await read(req);
    const known = (id: string) => objects.some((x) => x.elementId === id);
    switch (`${req.method} ${path}`) {
      case "GET /info": return json(res, 200, { success: true, result: { specVersion: "1.0", ...(o.publishPriorities === false ? {} : { "x-nexus": { priorityByType } }) } });
      case "GET /objecttypes": return json(res, 200, { success: true, result: types });
      case "GET /objects": return json(res, 200, { success: true, result: objects });
      case "POST /objects/value":
        return json(res, 200, { success: true, results: body.elementIds.map((id: string) =>
          current.has(id) ? { success: true, elementId: id, result: current.get(id) } : { success: false, elementId: id, responseDetail: { status: 404 } }) });
      case "POST /objects/history":
        return json(res, 200, { success: true, results: body.elementIds.map((id: string) => ({ success: true, elementId: id,
          result: { values: (history.get(id) ?? []).filter((p) => p.timestamp >= body.startTime && p.timestamp <= body.endTime) } })) });
      case "POST /subscriptions": return json(res, 200, { success: true, result: { subscriptionId: "sub-1" } });
      case "POST /subscriptions/register": return json(res, 200, { success: true, result: null });
      case "POST /subscriptions/delete": return json(res, 200, { success: true, result: null });
      case "POST /subscriptions/stream":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": i3x stream open\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      case "PUT /objects/value": {
        writes.push({ token, idempotencyKey: req.headers["idempotency-key"] as string | undefined, body });
        // The site decides: only the publisher may write records.
        const results = body.updates.map((x: any) => !known(x.elementId) ? { success: false, elementId: x.elementId, responseDetail: { status: 404 } }
          : token !== TOKENS.publisher ? { success: false, elementId: x.elementId, responseDetail: { status: 403, title: "Forbidden" } }
          : (set(x.elementId, x.value.value), { success: true, elementId: x.elementId, result: null }));
        return json(res, 200, { success: results.every((r: any) => r.success), results });
      }
    }
    json(res, 404, { success: false });
  };

  let srv: Server;
  const sockets = new Set<Socket>();
  let port = 0;
  const listen = () => new Promise<void>((r) => {
    srv = createServer((req, res) => void handler(req, res));
    srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    srv.listen(port, "127.0.0.1", () => { port = (srv.address() as { port: number }).port; r(); });
  });
  await listen();

  return {
    url: `http://127.0.0.1:${port}/v1`, set, writes, current,
    objectIds: objects.map((x) => x.elementId),
    /** Take the site off the network: no listener, every connection (and stream) cut. */
    down: () => new Promise<void>((r) => { for (const s of streams) s.destroy(); streams.clear(); srv.close(() => r()); for (const s of sockets) s.destroy(); }),
    up: listen,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  };
}
