/**
 * Exhaustiveness check helper for discriminated unions and switch statements.
 *
 * Place as the `default` case in a switch — the compiler will error if any
 * variant is unhandled because `value` won't narrow to `never`.
 *
 * @example
 * ```ts
 * type Shape = { kind: "circle" } | { kind: "square" };
 * function area(s: Shape) {
 *   switch (s.kind) {
 *     case "circle": return ...;
 *     case "square": return ...;
 *     default: return exhaustive(s.kind);
 *     //                         ^-- compile error if new variant added
 *   }
 * }
 * ```
 */
export function exhaustive(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
