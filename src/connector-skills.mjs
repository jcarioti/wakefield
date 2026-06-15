export const WAKEFIELD_CONNECTOR_SKILLS = {
  discord: {
    name: "wakefield-discord",
    prompt: "Use $wakefield-discord for Discord connector routing."
  },
  imessage: {
    name: "wakefield-imessage",
    prompt: "Use $wakefield-imessage for iMessage connector routing."
  }
};

const CONNECTOR_ALIASES = {
  "discord-codex": "discord",
  "imessage-spectrum": "imessage"
};

export function connectorSkill(connectorId) {
  const normalized = CONNECTOR_ALIASES[connectorId] || connectorId;
  return WAKEFIELD_CONNECTOR_SKILLS[normalized] || null;
}

export function connectorSkillPrompt(connectorId) {
  return connectorSkill(connectorId)?.prompt || null;
}
