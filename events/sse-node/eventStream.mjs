// Generated from dashboard Events source; SHA-256 601ba2636c275bcf94f3981f1acd6a2fd3b515b2a5b96ce0a6a24dbf3394e737. Do not edit.
export class EventProtocolError extends Error {}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EventProtocolError("Invalid Events frame");
  return value;
}
function instant(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}
export function parseInventoryEvent(value, project) {
  const event = object(value),
    data = object(event.data),
    links = object(event.links);
  const completed = [
    "complete_changed",
    "complete_unchanged",
    "private",
    "not_found",
  ];
  const failed = [
    "incomplete",
    "temporarily_unavailable",
    "unsupported_scope",
    "recovery_exhausted",
  ];
  const valid =
    (event.type === "inventory.refresh.completed" &&
      data.state === "completed" &&
      completed.includes(String(data.outcome))) ||
    (event.type === "inventory.refresh.failed" &&
      data.state === "failed" &&
      failed.includes(String(data.outcome)));
  if (
    !valid ||
    event.version !== 1 ||
    !/^evt_[a-f0-9]{32}$/.test(String(event.id)) ||
    !/^prj_[a-f0-9]{32}$/.test(String(event.project_id)) ||
    (project !== undefined && event.project_id !== project) ||
    !instant(event.occurred_at) ||
    typeof data.refresh_id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.refresh_id) ||
    links.refresh !== `/v2/steam/inventory-refreshes/${data.refresh_id}`
  )
    throw new EventProtocolError("Invalid Events envelope");
  // Deliberately reconstruct documented fields; optional future fields do not become UI data.
  return {
    id: event.id,
    version: 1,
    type: event.type,
    occurred_at: event.occurred_at,
    project_id: event.project_id,
    data: {
      refresh_id: data.refresh_id,
      state: data.state,
      outcome: data.outcome,
    },
    links: { refresh: links.refresh },
  };
}
function frame(name, id, lines, project) {
  let value;
  try {
    value = object(JSON.parse(lines.join("\n")));
  } catch {
    throw new EventProtocolError("Invalid Events JSON");
  }
  if (name === "checkpoint" || name.startsWith("inventory.refresh.")) {
    if (!id || id.length > 512 || !/^[\x21-\x7e]+$/.test(id))
      throw new EventProtocolError("Invalid Events cursor");
    if (name === "checkpoint") {
      if (!instant(value.as_of))
        throw new EventProtocolError("Invalid checkpoint");
      return { kind: "checkpoint", cursor: id, asOf: value.as_of };
    }
    const event = parseInventoryEvent(value, project);
    if (event.type !== name)
      throw new EventProtocolError("Events frame type mismatch");
    return { kind: "event", cursor: id, event };
  }
  if (id !== null)
    throw new EventProtocolError("Control frame cannot advance cursor");
  if (
    name === "stream.authorization_revoked" &&
    value.reason === "authorization_changed"
  )
    return { kind: "revoked" };
  if (
    name === "stream.recovery_required" &&
    ["retention", "restore", "replay_limit"].includes(String(value.reason))
  )
    return { kind: "recovery", reason: String(value.reason) };
  if (
    name === "stream.closing" &&
    ["drain", "lifetime", "slow_consumer"].includes(String(value.reason)) &&
    typeof value.retry_after_ms === "number" &&
    Number.isSafeInteger(value.retry_after_ms) &&
    value.retry_after_ms >= 0 &&
    value.retry_after_ms <= 30000
  )
    return {
      kind: "closing",
      reason: String(value.reason),
      retryAfterMs: value.retry_after_ms,
    };
  throw new EventProtocolError("Unsupported Events frame");
}
/** Incremental UTF-8/CRLF parser. No unbounded line, frame or decoded-chunk buffer. */
export async function* readEventFrames(body, project, signal) {
  const reader = body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "",
    name = "message",
    id = null,
    data = [],
    size = 0;
  function decode(value, stream = false) {
    try {
      return decoder.decode(value, { stream });
    } catch {
      throw new EventProtocolError("Invalid Events UTF-8");
    }
  }
  function line(value) {
    if (!value) {
      const result = data.length ? frame(name, id, data, project) : null;
      name = "message";
      id = null;
      data = [];
      size = 0;
      return result;
    }
    size += value.length;
    if (size > 32768)
      throw new EventProtocolError("Events frame exceeds budget");
    if (value.startsWith(":")) return null;
    const at = value.indexOf(":"),
      field = at < 0 ? value : value.slice(0, at);
    let content = at < 0 ? "" : value.slice(at + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "event") name = content;
    if (field === "data") data.push(content);
    if (field === "id") {
      if (id !== null || content.includes("\0"))
        throw new EventProtocolError("Invalid Events id");
      id = content;
    }
    return null; // comments, retry and unknown optional fields never advance progress.
  }
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      let timer;
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Events stream heartbeat timed out"));
            void reader.cancel().catch(() => undefined);
          }, 45000);
        }),
      ]).finally(() => clearTimeout(timer));
      signal.throwIfAborted();
      if (next.done) {
        pending += decode();
        // A CR is itself a line terminator, including at EOF; an unfinished frame isn't.
        if (pending.endsWith("\r")) {
          const result = line(pending.slice(0, -1));
          if (result) yield result;
        }
        return;
      }
      for (let offset = 0; offset < next.value.length; offset += 4096) {
        pending += decode(next.value.subarray(offset, offset + 4096), true);
        while (true) {
          const match = /[\r\n]/.exec(pending);
          if (
            !match ||
            (pending[match.index] === "\r" &&
              match.index === pending.length - 1)
          )
            break;
          const at = match.index,
            width = pending[at] === "\r" && pending[at + 1] === "\n" ? 2 : 1;
          const value = pending.slice(0, at);
          pending = pending.slice(at + width);
          const result = line(value);
          if (result) {
            signal.throwIfAborted();
            yield result;
          }
        }
        if (pending.length > 32768)
          throw new EventProtocolError("Events line exceeds budget");
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
