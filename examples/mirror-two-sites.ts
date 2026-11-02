// Mirror two i3X sites into one enterprise view and print each site's live state.
//
//   SITE_A_URL=https://site-a.example/v1 SITE_A_TOKEN=… \
//   SITE_B_URL=https://site-b.example/v1 SITE_B_TOKEN=… npx tsx examples/mirror-two-sites.ts

import { UpstreamMirror, LastValueCache, MemoryHistory, MountedModel } from "../src/index";

const model = new MountedModel(), cache = new LastValueCache(), history = new MemoryHistory();
const mirrors = ["A", "B"].map((s) => new UpstreamMirror(
  { id: `site-${s.toLowerCase()}`, url: process.env[`SITE_${s}_URL`]!, token: process.env[`SITE_${s}_TOKEN`]! },
  { model, cache, history }));
for (const m of mirrors) await m.start();

cache.on("change", (id, v) => { if (v.quality !== "Good") console.log(`${id} → ${v.quality} (last value ${JSON.stringify(v.value)})`); });
setInterval(() => console.log(mirrors.map((m, i) => `site ${"AB"[i]}: ${m.connected ? "live" : "down"}`).join(" · "), `${model.objects().length} objects`), 10_000);
process.on("SIGINT", () => { for (const m of mirrors) m.stop(); process.exit(0); });
