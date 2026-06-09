/**
 * runner.ts — proto service → datagram operations (the single chokepoint).
 *
 * `protoToOperations(service, backend, handlers)` maps each RPC to a runtime
 * {@link Operation}:
 *   - name    = snake_case(method name)         (LogMeal → log_meal)
 *   - summary = a humanized method name          (proto leading comments are not
 *               retained in the codegen'd descriptor; the handlers map may
 *               override per method)
 *   - input   = the request message, validated via proto-es `fromJson` (throws
 *               on bad input — no zod/ajv needed)
 *   - mutates = effect == EFFECT_WRITE           (drives the live SSE push)
 *   - handler = the user handler wrapped with the SINGLE-POINT ACCESS GUARD and,
 *               for writes, a per-call ATOMIC TRANSACTION
 *
 * The access guard and the transaction wrapper live here and ONLY here — that
 * is the "enforced in one place" property the v0 plan requires.
 */

import { type DescMethod, type DescService, type Message, fromJson } from "@bufbuild/protobuf";
import { getOption } from "@bufbuild/protobuf";
import { Access, Effect, access, effect } from "@chamber/proto/chamber/v1/options_pb";
import type { DataHandle } from "./data.js";
import { protoMessageToJsonSchema } from "./jsonschema.js";
import type { Operation, ValidateResult } from "./runtime.js";
import { humanize, snakeCase } from "./strings.js";

/** What a handler receives alongside its validated, decoded request. */
export interface HandlerContext {
  /** The string-free data handle — a write handle inside the action's transaction, else a read handle. */
  data: DataHandle;
}

/**
 * A simple, synchronous user handler over the dataset. The whole body runs
 * inside the per-write atomic transaction (for writes); sqlite transactions are
 * synchronous, so this stays synchronous. This is the v0 shape and remains fully
 * supported.
 */
export type SyncHandler<Req extends Message = Message> = (req: Req, ctx: HandlerContext) => unknown;

/**
 * A two-phase handler that splits NETWORK from the atomic DB write.
 *
 * `prepare(req)` runs FIRST and OUTSIDE any transaction — it may be async and do
 * network I/O (e.g. resolve a nutrition strategy). Its resolved value is then
 * handed to `commit(prepared, req, ctx)`, which runs synchronously INSIDE the
 * per-write atomic transaction and does only DB mutations. This is how an
 * online strategy resolves-then-writes without holding a transaction open across
 * a network call. For reads, `prepare` is skipped and `commit` runs against a
 * read handle.
 */
export interface PreparedHandler<Req extends Message = Message, P = unknown> {
  prepare?: (req: Req) => Promise<P> | P;
  commit: (prepared: P, req: Req, ctx: HandlerContext) => unknown;
}

/** A user handler: either a plain sync function or a two-phase prepare/commit handler. */
export type Handler<Req extends Message = Message> = SyncHandler<Req> | PreparedHandler<Req>;

/** Narrow a {@link Handler} to the two-phase {@link PreparedHandler} shape. */
function isPreparedHandler(h: Handler): h is PreparedHandler {
  return typeof h === "object" && h !== null && typeof (h as PreparedHandler).commit === "function";
}

/** Per-method handler map, keyed by the proto method's `localName` (e.g. `logMeal`). */
export type Handlers = Record<string, Handler>;

/** Optional per-method summary overrides, keyed by `localName`. */
export type Summaries = Record<string, string>;

/** The minimal backend surface the runner needs (matches {@link Backend}). */
export interface RunnerBackend {
  readHandle(): DataHandle;
  writeHandle(): DataHandle;
  transaction<T>(fn: () => T): T;
}

/** Build a `validate` fn that decodes a JSON body into the method's request message via proto-es. */
function makeValidate(method: DescMethod): (body: unknown) => ValidateResult<Message> {
  return (body: unknown) => {
    try {
      // proto-es `fromJson` validates types/shape and applies proto defaults; it
      // throws on anything malformed, so this is our value-validation layer.
      const value = fromJson(method.input, (body ?? {}) as never);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
    }
  };
}

/**
 * Map every RPC in `service` to a runtime {@link Operation}, reading the
 * `chamber.*` options to set `mutates` and to enforce the dataset's access bound.
 */
export function protoToOperations(
  service: DescService,
  backend: RunnerBackend,
  handlers: Handlers,
  summaries: Summaries = {},
): Operation[] {
  const serviceAccess = getOption(service, access);
  const ops: Operation[] = [];

  for (const method of service.methods) {
    const handler = handlers[method.localName];
    if (!handler) throw new Error(`no handler registered for method "${method.localName}"`);

    const methodEffect = getOption(method, effect);
    const mutates = methodEffect === Effect.WRITE;

    const wrapped = (req: Message): unknown => {
      // SINGLE-POINT ACCESS GUARD: a WRITE against a non-READ_WRITE dataset is
      // forbidden, enforced here and nowhere else. Checked before any network
      // resolution so a read-only dataset never even reaches a strategy lookup.
      if (mutates && serviceAccess !== Access.READ_WRITE) {
        throw new Error("forbidden: read-only dataset");
      }

      if (isPreparedHandler(handler)) {
        // Two-phase: resolve OUTSIDE the transaction (may be async / network),
        // then commit the synchronous DB writes INSIDE the atomic transaction.
        const runCommit = (prepared: unknown): unknown => {
          const ctx = { data: mutates ? backend.writeHandle() : backend.readHandle() };
          const doCommit = () => handler.commit(prepared, req, ctx);
          return mutates ? backend.transaction(doCommit) : doCommit();
        };
        if (!handler.prepare) return runCommit(undefined);
        const prepared = handler.prepare(req);
        // Only await when prepare actually returned a promise — a fully sync
        // prepared handler stays synchronous (so sync call sites keep working).
        return prepared instanceof Promise ? prepared.then(runCommit) : runCommit(prepared);
      }

      // Plain sync handler: the whole body runs inside the atomic transaction
      // (for writes), exactly as in v0.
      if (mutates) {
        return backend.transaction(() => handler(req, { data: backend.writeHandle() }));
      }
      return handler(req, { data: backend.readHandle() });
    };

    ops.push({
      name: snakeCase(method.name),
      summary: summaries[method.localName] ?? humanize(method.name),
      jsonSchema: protoMessageToJsonSchema(method.input) as Operation["jsonSchema"],
      validate: makeValidate(method),
      handler: wrapped as Operation["handler"],
      mutates,
    });
  }
  return ops;
}
