import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import { streamProjectEvents } from "./stream.mjs";

const projectId = "prj_22222222222242228222222222222222";
const otherProjectId = "prj_44444444444444448444444444444444";
const refreshId = "33333333-3333-4333-8333-333333333333";
const event = {
  id: "evt_11111111111141118111111111111111",
  version: 1,
  type: "inventory.refresh.completed",
  occurred_at: "2026-09-12T12:42:08Z",
  project_id: projectId,
  data: {
    refresh_id: refreshId,
    state: "completed",
    outcome: "complete_changed",
  },
  links: { refresh: "/v2/steam/inventory-refreshes/" + refreshId },
};

async function fixture(t, respond) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    respond(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return {
    requests,
    async read(cursor) {
      const frames = [];
      for await (const frame of streamProjectEvents({
        projectId,
        credential: "synthetic-credential",
        cursor,
        signal: AbortSignal.timeout(3000),
        transport: (url, options) => {
          assert.equal(
            url.href,
            "https://api.steamcall.com/v2/projects/" +
              projectId +
              "/events/stream",
          );
          assert.equal(options.redirect, "error");
          return fetch(
            "http://127.0.0.1:" + server.address().port + url.pathname,
            options,
          );
        },
      })) {
        frames.push(frame);
      }
      return frames;
    },
  };
}

function send(res, envelope = event) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  res.write(
    'event: checkpoint\r\nid: first-cursor\r\ndata: {"as_of":"2026-09-12T12:42:08Z"}\r\n\r\n',
  );
  res.write("event: inventory.refresh.completed\r\nid: event-cursor\r\n");
  res.write("data: " + JSON.stringify(envelope) + "\r\n\r\n");
  res.end("event: checkpoint\nid: incomplete\ndata: {}");
}

test("opens one Project stream and resumes from the chosen cursor", async (t) => {
  const { read, requests } = await fixture(t, (_req, res) => send(res));

  const [checkpoint, received, ...unfinished] = await read();
  assert.equal(checkpoint.cursor, "first-cursor");
  assert.deepEqual(received, { kind: "event", cursor: "event-cursor", event });
  assert.deepEqual(unfinished, []);
  assert.deepEqual((await read(checkpoint.cursor))[1], received);
  assert.equal(requests[0].accept, "text/event-stream");
  assert.equal(requests[0]["last-event-id"], undefined);
  assert.equal(requests[1]["last-event-id"], checkpoint.cursor);
  assert.equal(requests[1]["x-api-key"], "synthetic-credential");
});

test("rejects an envelope from another Project", async (t) => {
  const { read } = await fixture(t, (_req, res) =>
    send(res, { ...event, project_id: otherProjectId }),
  );
  await assert.rejects(read(), /Invalid Events envelope/);
});

test("reports an authority refusal and leaves reconnection to the operator", async (t) => {
  const { read, requests } = await fixture(t, (_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await assert.rejects(read("first-cursor"), /HTTP status: 404/);
  assert.equal(requests.length, 1);
});
