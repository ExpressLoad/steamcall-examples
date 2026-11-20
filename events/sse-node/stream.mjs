import { pathToFileURL } from "node:url";
import { readEventFrames } from "./eventStream.mjs";

const origin = "https://api.steamcall.com";

export async function* streamProjectEvents({
  projectId,
  credential,
  cursor,
  signal = AbortSignal.timeout(120_000),
  transport = fetch,
}) {
  if (!/^prj_[0-9a-f]{32}$/.test(projectId) || !credential) {
    throw new Error(
      "Set STEAMCALL_PROJECT_ID and STEAMCALL_PROJECT_CREDENTIAL.",
    );
  }
  if (cursor !== undefined && !/^[\x21-\x7e]{1,512}$/.test(cursor)) {
    throw new Error("Use a frame id as Last-Event-ID.");
  }

  const headers = {
    Accept: "text/event-stream",
    "X-API-Key": credential,
  };
  if (cursor) headers["Last-Event-ID"] = cursor;

  const response = await transport(
    new URL("/v2/projects/" + projectId + "/events/stream", origin),
    { headers, redirect: "error", signal },
  );
  const mediaType = response.headers.get("content-type")?.split(";")[0];
  if (
    response.status !== 200 ||
    mediaType !== "text/event-stream" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error(
      "Expected an Events stream. HTTP status: " + response.status,
    );
  }

  yield* readEventFrames(response.body, projectId, signal);
}

async function main() {
  const frames = streamProjectEvents({
    projectId: process.env.STEAMCALL_PROJECT_ID,
    credential: process.env.STEAMCALL_PROJECT_CREDENTIAL,
    cursor: process.argv[2],
  });
  for await (const frame of frames) {
    if (frame.kind === "checkpoint") {
      console.log("checkpoint " + frame.cursor);
    } else if (frame.kind === "event") {
      console.log(
        frame.event.type + " " + frame.event.id + " cursor=" + frame.cursor,
      );
    } else if (frame.kind === "closing") {
      console.log("Stream closed. Reconnect with the last applied cursor.");
      return;
    } else if (frame.kind === "recovery") {
      throw new Error(
        "Recovery required. See https://docs.steamcall.com/apis/events/recovery",
      );
    } else if (frame.kind === "revoked") {
      throw new Error(
        "Access revoked. Restore authorization before reconnecting.",
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
