// Tracing of native calls: the "duckdb-bun:call" tracing channel, debug lines,
// and the SQL text kept for crash reports, all with credentials redacted.
import { tracingChannel } from "node:diagnostics_channel";
import { debug, flags } from "./flags.ts";

/** What a traced native call publishes as the tracing channel's context. */
export interface CallContext {
  /** The contract function, such as "query" or "connect". */
  op: string;
  /** The statement, redacted, only when DUCKDB_BUN_TRACE_SQL=1. */
  sql?: string;
  /** Set by the channel when the call resolves. */
  result?: unknown;
  /** Set by the channel when the call rejects. */
  error?: unknown;
}

export const CALL_CHANNEL = "duckdb-bun:call";

const channel = tracingChannel<object, CallContext>(CALL_CHANNEL);
const subChannels = [channel.start, channel.end, channel.asyncStart, channel.asyncEnd, channel.error];

// Statements that can carry credentials: CREATE SECRET, ATTACH with a
// connection string, and settings or options that name a key, token or password.
// Matched anywhere, also inside identifiers such as s3_secret_access_key; a false
// match only redacts more.
const SENSITIVE = /secret|attach|passw|token|credential|key_id|access_key|account_key|account_name|connection_string/i;

// Single-quoted literals ('' escapes a quote; an unterminated one runs to the
// end) and dollar-quoted strings.
const LITERAL = /'(?:[^']|'')*(?:'|$)|\$([A-Za-z_]\w*)?\$[\s\S]*?(?:\$\1\$|$)/g;

/** Replaces every string literal with '<redacted>' in a statement that can carry credentials. */
export function redactSql(sql: string): string {
  return SENSITIVE.test(sql) ? sql.replace(LITERAL, "'<redacted>'") : sql;
}

/** The context for one call; SQL is redacted and kept only when DUCKDB_BUN_TRACE_SQL=1. */
export function callContext(op: string, sql?: string): CallContext {
  return flags.traceSql && sql !== undefined ? { op, sql: redactSql(sql) } : { op };
}

/**
 * Runs `call` inside the tracing channel when anything subscribes, and logs its
 * outcome and duration when DUCKDB_BUN_DEBUG=1.
 */
export function traced<T>(context: CallContext, call: () => Promise<T>): Promise<T> {
  const subscribed = subChannels.some((sub) => sub.hasSubscribers);
  if (!subscribed && !flags.debug) return call();
  const promise = subscribed ? channel.tracePromise(call, context) : call();
  if (!flags.debug) return promise;
  const started = performance.now();
  const label = context.sql === undefined ? context.op : `${context.op} ${JSON.stringify(context.sql)}`;
  const elapsed = () => `${(performance.now() - started).toFixed(2)}ms`;
  return promise.then(
    (value) => {
      debug(`${label} ok ${elapsed()}`);
      return value;
    },
    (error: unknown) => {
      debug(`${label} error ${elapsed()}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    },
  );
}
