/**
 * logBuffer.ts
 *
 * Captures server-side console output (log, warn, error, info) into an
 * in-memory circular buffer so it can be served to the frontend Logs page.
 *
 * Call `initLogCapture()` once at server startup.
 * Call `getLogEntries()` to retrieve recent entries.
 */

export interface LogEntry {
  id: number;
  ts: string;        // ISO timestamp
  level: "log" | "warn" | "error" | "info";
  message: string;
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
let nextId = 1;
let captured = false;

function push(level: LogEntry["level"], args: unknown[]) {
  const message = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(" ");

  buffer.push({ id: nextId++, ts: new Date().toISOString(), level, message });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function initLogCapture() {
  if (captured) return;
  captured = true;

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  console.log = (...args: unknown[]) => { orig.log(...args); push("log", args); };
  console.warn = (...args: unknown[]) => { orig.warn(...args); push("warn", args); };
  console.error = (...args: unknown[]) => { orig.error(...args); push("error", args); };
  console.info = (...args: unknown[]) => { orig.info(...args); push("info", args); };
}

export function getLogEntries(opts: {
  since?: number;   // return only entries with id > since
  level?: string;   // filter by level ("log", "warn", "error", "info")
  limit?: number;
}): { entries: LogEntry[]; lastId: number } {
  let entries = buffer.slice();

  if (opts.since != null) {
    entries = entries.filter((e) => e.id > opts.since!);
  }
  if (opts.level && opts.level !== "all") {
    entries = entries.filter((e) => e.level === opts.level);
  }

  const limit = opts.limit ?? 200;
  if (entries.length > limit) {
    entries = entries.slice(entries.length - limit);
  }

  return { entries, lastId: buffer.length > 0 ? buffer[buffer.length - 1].id : 0 };
}
