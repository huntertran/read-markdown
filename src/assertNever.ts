/**
 * Compile-time exhaustiveness check for a `switch` over a discriminated union: in the `default` branch the
 * value has type `never` only when every `case` is handled, so a new member without a `case` fails type checking.
 * At runtime it does nothing, so an unexpected message is ignored instead of breaking the panel.
 * Pure and import-free: included in both the root and the webview tsconfig.
 */
export function assertNever(value: never): void {
  // Unreachable when the switch is exhaustive; ignoring is the safe behaviour otherwise.
  void value;
}
