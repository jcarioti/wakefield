import fs from "node:fs/promises";
import { normalizeAddress } from "./config.mjs";

export async function loadContactResolver(contactsPath) {
  if (!contactsPath) {
    return createContactResolver();
  }
  const data = JSON.parse(await fs.readFile(contactsPath, "utf8"));
  return createContactResolver(data);
}

export function createContactResolver(contacts = {}) {
  const people = contacts.people || {};
  const addressToPersonId = new Map();

  for (const [address, personId] of Object.entries(contacts.phone_numbers || {})) {
    addAddress(addressToPersonId, address, personId);
  }
  for (const [personId, person] of Object.entries(people)) {
    for (const address of person.phone_numbers || []) {
      addAddress(addressToPersonId, address, personId);
    }
    for (const address of person.imessage_addresses || []) {
      addAddress(addressToPersonId, address, personId);
    }
  }

  return {
    resolveAddress(address) {
      const normalized = normalizeContactAddress(address);
      const personId = addressToPersonId.get(normalized);
      const person = personId ? people[personId] : null;
      return person ? {
        personId,
        displayName: person.display_name || personId,
        normalizedAddress: normalized
      } : null;
    }
  };
}

export function formatContactAddress(address, resolver) {
  const raw = String(address || "").trim() || "unknown";
  const resolved = resolver?.resolveAddress?.(raw);
  if (!resolved) {
    return raw;
  }
  return `${resolved.displayName} <${resolved.normalizedAddress}>`;
}

export function normalizeContactAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  if (raw.includes("@")) {
    return normalizeAddress(raw);
  }
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (raw.startsWith("+") && digits) {
    return `+${digits}`;
  }
  return normalizeAddress(raw);
}

function addAddress(addressToPersonId, address, personId) {
  const normalized = normalizeContactAddress(address);
  if (normalized && personId) {
    addressToPersonId.set(normalized, personId);
  }
}
