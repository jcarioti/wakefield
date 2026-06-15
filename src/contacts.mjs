import fs from "node:fs/promises";
import { contactsPath, appHome, expandHome } from "./paths.mjs";
import { readJson, writeJson } from "./json-store.mjs";

const CONTACT_SCHEMA_VERSION = 1;
const PEOPLE_MAP_FORMAT = "people-v1";

export async function loadContacts({
  home = appHome()
} = {}) {
  const current = await readJson(contactsPath(home), null);
  if (!current) return emptyContacts();
  return normalizeContactsDocument(current);
}

export async function saveContacts(document, {
  home = appHome()
} = {}) {
  const next = normalizeContactsDocument(document);
  next.updatedAt = new Date().toISOString();
  await writeJson(contactsPath(home), next);
  return next;
}

export async function importContactsFile(file, {
  home = appHome(),
  format = "auto"
} = {}) {
  const sourcePath = expandHome(file);
  const raw = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const imported = contactsFromSource(raw, { format, sourcePath });
  const current = await loadContacts({ home });
  const merged = mergeContacts(current.contacts, imported.contacts);
  return saveContacts({
    schemaVersion: CONTACT_SCHEMA_VERSION,
    source: imported.source,
    contacts: merged
  }, { home });
}

export async function upsertContact(contact, {
  home = appHome()
} = {}) {
  const current = await loadContacts({ home });
  const normalized = normalizeContact(contact);
  const contacts = mergeContacts(current.contacts, [normalized]);
  return saveContacts({
    ...current,
    contacts
  }, { home });
}

export async function resolveContact(source, {
  home = appHome()
} = {}) {
  const document = await loadContacts({ home });
  return {
    contact: resolveContactFromList(document.contacts, source),
    contactsPath: contactsPath(home)
  };
}

export function resolveContactFromList(contacts, source = {}) {
  const candidates = sourceIdentityCandidates(source);
  if (candidates.length === 0) return null;
  for (const contact of contacts || []) {
    const normalized = normalizeContact(contact);
    for (const identity of normalized.identities) {
      if (candidates.some((candidate) => identityMatches(identity, candidate))) {
        return contactSummary(normalized);
      }
    }
  }
  return null;
}

export function contactSummary(contact) {
  if (!contact) return null;
  const normalized = normalizeContact(contact);
  return {
    id: normalized.id,
    displayName: normalized.displayName,
    roles: normalized.roles,
    relationships: normalized.relationships,
    preferredReplyConnector: normalized.preferences.preferredReplyConnector || null,
    notes: normalized.notes
  };
}

export function formatContacts(document) {
  const contacts = document.contacts || [];
  if (contacts.length === 0) return "No Wakefield contacts configured.";
  return contacts
    .map((contact) => {
      const roles = contact.roles?.length > 0 ? ` (${contact.roles.join(", ")})` : "";
      const identities = (contact.identities || [])
        .map((identity) => `${identity.connector}:${identity.id || identity.address}`)
        .join(", ");
      return `${contact.id}: ${contact.displayName}${roles}${identities ? ` - ${identities}` : ""}`;
    })
    .join("\n");
}

export function formatContactResolution(result) {
  if (!result.contact) return "No matching Wakefield contact.";
  return `${result.contact.id}: ${result.contact.displayName}`;
}

export function contactsFromSource(raw, {
  format = "auto",
  sourcePath = null
} = {}) {
  const detected = format === "auto" ? detectContactsFormat(raw) : format;
  if (detected === PEOPLE_MAP_FORMAT || isPeopleMap(raw)) return contactsFromPeopleMap(raw, { sourcePath });
  return {
    schemaVersion: CONTACT_SCHEMA_VERSION,
    source: sourcePath ? { path: sourcePath, format: detected } : null,
    contacts: normalizeContactsDocument(raw).contacts
  };
}

function emptyContacts() {
  return {
    schemaVersion: CONTACT_SCHEMA_VERSION,
    updatedAt: null,
    source: null,
    contacts: []
  };
}

function normalizeContactsDocument(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    schemaVersion: CONTACT_SCHEMA_VERSION,
    updatedAt: source.updatedAt || source.updated || null,
    source: source.source || null,
    contacts: (source.contacts || []).map(normalizeContact)
  };
}

function normalizeContact(contact) {
  const source = contact && typeof contact === "object" ? contact : {};
  const id = String(source.id || source.personId || source.displayName || source.display_name || "contact")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "contact";
  return {
    id,
    displayName: String(source.displayName || source.display_name || source.name || id).trim(),
    relationships: asArray(source.relationships),
    roles: asArray(source.roles),
    location: source.location || null,
    identities: normalizeIdentities(source.identities || []),
    preferences: source.preferences && typeof source.preferences === "object" ? source.preferences : {},
    notes: asArray(source.notes),
    source: source.source || null
  };
}

function normalizeIdentities(identities) {
  return asArray(identities)
    .map((identity) => {
      const connector = String(identity.connector || "").trim().toLowerCase();
      const id = identity.id == null ? null : normalizeIdentityValue(connector, identity.id);
      const address = identity.address == null ? null : normalizeIdentityValue(connector, identity.address);
      if (!connector || (!id && !address)) return null;
      return {
        connector,
        id,
        address,
        label: identity.label || null
      };
    })
    .filter(Boolean);
}

function detectContactsFormat(raw) {
  if (isPeopleMap(raw)) return PEOPLE_MAP_FORMAT;
  return "wakefield-contacts-v1";
}

function isPeopleMap(raw) {
  return raw?.people && typeof raw.people === "object" && raw?.identity_resolution;
}

function contactsFromPeopleMap(raw, { sourcePath }) {
  const people = raw.people && typeof raw.people === "object" ? raw.people : {};
  return {
    schemaVersion: CONTACT_SCHEMA_VERSION,
    source: {
      path: sourcePath,
      format: PEOPLE_MAP_FORMAT,
      version: raw.version || null
    },
    contacts: Object.entries(people).map(([id, person]) => normalizeContact({
      id,
      displayName: person.display_name || id,
      relationships: person.relationships || [],
      roles: person.roles || [],
      location: person.location || null,
      notes: person.notes || [],
      identities: [
        ...asArray(person.discord_user_ids).map((value) => ({ connector: "discord", id: value })),
        ...asArray(person.phone_numbers).flatMap((value) => [
          { connector: "imessage", address: value },
          { connector: "sms", address: value }
        ]),
        ...asArray(person.email_addresses).map((value) => ({ connector: "email", address: value }))
      ],
      source: sourcePath ? { path: sourcePath, format: PEOPLE_MAP_FORMAT } : null
    }))
  };
}

function mergeContacts(left, right) {
  const merged = new Map();
  for (const contact of [...left, ...right]) {
    const normalized = normalizeContact(contact);
    const previous = merged.get(normalized.id);
    if (!previous) {
      merged.set(normalized.id, normalized);
      continue;
    }
    merged.set(normalized.id, {
      ...previous,
      ...normalized,
      relationships: uniq([...previous.relationships, ...normalized.relationships]),
      roles: uniq([...previous.roles, ...normalized.roles]),
      notes: uniq([...previous.notes, ...normalized.notes]),
      identities: uniqIdentities([...previous.identities, ...normalized.identities]),
      preferences: {
        ...previous.preferences,
        ...normalized.preferences
      }
    });
  }
  return [...merged.values()].sort((leftContact, rightContact) => leftContact.id.localeCompare(rightContact.id));
}

function sourceIdentityCandidates(source = {}) {
  const connector = String(source.connector || "").trim().toLowerCase();
  const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const candidates = [];
  const push = (candidateConnector, value, field = "id") => {
    if (!candidateConnector || value == null || value === "") return;
    candidates.push({
      connector: String(candidateConnector).trim().toLowerCase(),
      field,
      value: normalizeIdentityValue(candidateConnector, value)
    });
  };

  if (connector === "discord") {
    push("discord", metadata.authorId || metadata.userId || metadata.discordUserId || source.sender);
  } else if (connector === "imessage" || connector === "sms") {
    push("imessage", metadata.sender || source.sender, "address");
    push("sms", metadata.sender || source.sender, "address");
  } else if (connector === "email") {
    push("email", metadata.from || source.sender || metadata.replyTo, "address");
  }

  push(connector, source.sender, connector === "email" || connector === "imessage" || connector === "sms" ? "address" : "id");
  return candidates.filter((candidate) => candidate.value);
}

function identityMatches(identity, candidate) {
  if (identity.connector !== candidate.connector) return false;
  const value = candidate.field === "address" ? identity.address : identity.id;
  return value && value === candidate.value;
}

function normalizeIdentityValue(connector, value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalizedConnector = String(connector || "").trim().toLowerCase();
  if (normalizedConnector === "imessage" || normalizedConnector === "sms") return normalizePhone(text);
  if (normalizedConnector === "email") return emailAddress(text).toLowerCase();
  return text;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(value).trim().startsWith("+")) return `+${digits}`;
  return String(value || "").trim();
}

function emailAddress(value) {
  const text = String(value || "").trim();
  const angle = text.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  const plain = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return (plain?.[0] || text).trim();
}

function asArray(value) {
  if (value == null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function uniq(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function uniqIdentities(identities) {
  const seen = new Set();
  const result = [];
  for (const identity of identities.map((item) => normalizeIdentities([item])[0]).filter(Boolean)) {
    const key = `${identity.connector}:${identity.id || ""}:${identity.address || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(identity);
  }
  return result;
}
