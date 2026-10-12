import { isRegisterExplicitlyEnabled } from "./registerGate.ts";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
  }
}

assertEqual(isRegisterExplicitlyEnabled(undefined), false, "undefined");
assertEqual(isRegisterExplicitlyEnabled(null), false, "null");
assertEqual(isRegisterExplicitlyEnabled({}), false, "empty object");
assertEqual(isRegisterExplicitlyEnabled([]), false, "array");

assertEqual(isRegisterExplicitlyEnabled({ register_enabled: true }), true, "boolean true");
assertEqual(isRegisterExplicitlyEnabled({ register_enabled: false }), false, "boolean false");
assertEqual(isRegisterExplicitlyEnabled({ register_enabled: "true" }), false, "string true");
assertEqual(isRegisterExplicitlyEnabled({ register_enabled: "false" }), false, "string false");
assertEqual(isRegisterExplicitlyEnabled({ register_enabled: 1 }), false, "number 1");

assertEqual(isRegisterExplicitlyEnabled({ password_register_enabled: true }), false, "password flag alone");
assertEqual(
  isRegisterExplicitlyEnabled({ password_register_enabled: true, register_enabled: false }),
  false,
  "password flag does not override false",
);
assertEqual(
  isRegisterExplicitlyEnabled({ password_register_enabled: false, register_enabled: true }),
  true,
  "explicit true still wins",
);
