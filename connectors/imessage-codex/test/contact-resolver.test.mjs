import assert from "node:assert/strict";
import test from "node:test";
import {
  createContactResolver,
  formatContactAddress,
  normalizeContactAddress
} from "../src/contact-resolver.mjs";

const contacts = {
  phone_numbers: {
    "+13307669880": "joe"
  },
  people: {
    joe: {
      display_name: "Joe",
      phone_numbers: ["3307669880"]
    },
    terence: {
      display_name: "Terence",
      phone_numbers: ["8018975452"]
    }
  }
};

test("normalizeContactAddress converts US phone numbers to E.164", () => {
  assert.equal(normalizeContactAddress("3307669880"), "+13307669880");
  assert.equal(normalizeContactAddress("(801) 897-5452"), "+18018975452");
  assert.equal(normalizeContactAddress("+1 330 766 9880"), "+13307669880");
});

test("contact resolver identifies people by top-level and person phone maps", () => {
  const resolver = createContactResolver(contacts);
  assert.equal(resolver.resolveAddress("+13307669880").displayName, "Joe");
  assert.equal(resolver.resolveAddress("8018975452").displayName, "Terence");
  assert.equal(resolver.resolveAddress("7632444649"), null);
});

test("formatContactAddress includes resolved name and normalized address", () => {
  const resolver = createContactResolver(contacts);
  assert.equal(formatContactAddress("3307669880", resolver), "Joe <+13307669880>");
  assert.equal(formatContactAddress("+17632444649", resolver), "+17632444649");
});
