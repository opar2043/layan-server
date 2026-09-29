import { execSync } from "node:child_process";

const port = process.env.PORT || process.argv[2] || "5000";

function pidsOnPort(target) {
  try {
    const out = execSync(`lsof -ti tcp:${target} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

const pids = pidsOnPort(port);
if (pids.length === 0) {
  console.log(`[free-port] port ${port} is free`);
  process.exit(0);
}

console.log(`[free-port] port ${port} busy (pids: ${pids.join(", ")}) — stopping`);

for (const pid of pids) {
  if (pid === String(process.pid)) continue;
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {
    /* already gone */
  }
}

setTimeout(() => {
  for (const pid of pids) {
    if (pid === String(process.pid)) continue;
    try {
      process.kill(Number(pid), 0);
      process.kill(Number(pid), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  console.log(`[free-port] port ${port} released`);
}, 1500);
