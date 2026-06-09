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
import { Access, Effect, access, effect } from "../gen/chamber/v1/options_pb.js";
import type { DataHandle } from "./data.js";
import { protoMessageToJsonSchema } from "./jsonschema.js";
import type { Operation, ValidateResult } from "./runtime.js";

/** What a handler receives alongside its validated, decoded request. */
export interface HandlerContext {
  /** The string-free data handle — a write handle inside the action's transaction, else a read handle. */
  data: DataHandle;
}

/** A user handler over the dataset. Synchronous (sqlite transactions are sync). */
export type Handler<Req extends Message = Message> = (req: Req, ctx: HandlerContext) => unknown;

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

/** snake_case a proto method name: `LogMeal` → `log_meal`, `NutritionFor` → `nutrition_for`. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Humanize a method name into a default summary: `NutritionFor` → "Nutrition for". */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
      // forbidden, enforced here and nowhere else.
      if (mutates && serviceAccess !== Access.READ_WRITE) {
        throw new Error("forbidden: read-only dataset");
      }
      if (mutates) {
        // Per-action ATOMIC TRANSACTION: the handler's inserts commit together
        // or roll back together if it throws.
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
