#!/usr/bin/env node
import {
  cycleStart,
  cycleStatus,
  sessionOpen,
  lockAcquire,
  cycleArchive,
  cycleComplete
} from "./lib/broker.js";

const [,, cmd, ...rest] = process.argv;

async function main() {
  switch (cmd) {
    case "status": {
      const result = await cycleStatus();
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "start": {
      const feature = rest[0];
      if (!feature) {
        throw new Error("Usage: node cli.js start <feature>");
      }
      const result = await cycleStart({ feature });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "complete": {
      const lockToken = rest[0];
      const sessionToken = rest[1];
      if (!lockToken || !sessionToken) {
        throw new Error("Usage: node cli.js complete <lock_token> <session_token>");
      }
      const result = await cycleComplete({ lock_token: lockToken, session_token: sessionToken });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "archive": {
      const lockToken = rest[0];
      const sessionToken = rest[1];
      if (!lockToken || !sessionToken) {
        throw new Error("Usage: node cli.js archive <lock_token> <session_token>");
      }
      const result = await cycleArchive({ lock_token: lockToken, session_token: sessionToken });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "open-session": {
      const role = rest[0];
      const psk = rest[1];
      if (!role || !psk) {
        throw new Error("Usage: node cli.js open-session <gemini|codex> <psk>");
      }
      const result = await sessionOpen({ role, psk });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "acquire-lock": {
      const sessionToken = rest[0];
      if (!sessionToken) {
        throw new Error("Usage: node cli.js acquire-lock <session_token>");
      }
      const result = await lockAcquire({ session_token: sessionToken });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    default:
      throw new Error("Usage: node cli.js <status|start|open-session|acquire-lock|complete|archive>");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
