import { Spectrum, attachment, reaction as spectrumReaction } from "spectrum-ts";
import { imessage, read as spectrumRead } from "spectrum-ts/providers/imessage";

const SPECTRUM_TAPBACK_REACTIONS = new Map([
  ["love", "\u2764\uFE0F"],
  ["heart", "\u2764\uFE0F"],
  ["like", "\u{1F44D}"],
  ["thumbsup", "\u{1F44D}"],
  ["thumbs_up", "\u{1F44D}"],
  ["dislike", "\u{1F44E}"],
  ["thumbsdown", "\u{1F44E}"],
  ["thumbs_down", "\u{1F44E}"],
  ["laugh", "\u{1F602}"],
  ["haha", "\u{1F602}"],
  ["emphasize", "\u203C\uFE0F"],
  ["exclaim", "\u203C\uFE0F"],
  ["question", "\u2753"]
]);

export async function createSpectrumApp({ spectrum }) {
  if (!spectrum.projectId || !spectrum.projectSecret) {
    throw new Error("Photon/Spectrum iMessage requires projectId and projectSecret. Set them in config.local.json or PHOTON_PROJECT_ID/PHOTON_SECRET_KEY.");
  }
  return Spectrum({
    projectId: spectrum.projectId,
    projectSecret: spectrum.projectSecret,
    providers: [imessage.config()],
    options: {
      flattenGroups: spectrum.flattenGroups !== false
    },
    telemetry: spectrum.telemetry === true
  });
}

export async function sendSpectrumMessage({
  app,
  target,
  text = "",
  files = [],
  knownSpaces = new Map(),
  photonFallback = null
}) {
  const space = await resolveSpectrumSpace({ app, target, knownSpaces });
  const content = buildSpectrumContent({ text, files });
  if (content.length === 0) {
    throw new Error("iMessage send requires text or at least one attachment.");
  }

  const send = async () => {
    if (target.replyToMessageId && typeof space.getMessage === "function") {
      let original = null;
      try {
        original = await space.getMessage(target.replyToMessageId);
      } catch (error) {
        if (!shouldUsePhotonNativeFallback(error)) {
          throw error;
        }
        const fallback = await sendPhotonReplyFallback({
          photonFallback,
          target,
          text,
          files,
          reason: error
        });
        if (fallback) {
          return fallback;
        }
      }
      if (original) {
        return original.reply(...content);
      }
      const fallback = await sendPhotonReplyFallback({
        photonFallback,
        target,
        text,
        files,
        reason: new Error(`Photon/Spectrum message ${target.replyToMessageId} was not found in ${space.id}.`)
      });
      if (fallback) {
        return fallback;
      }
    }
    return space.send(...content);
  };

  return send();
}

export async function reactToSpectrumMessage({
  app,
  target,
  messageId,
  reaction,
  knownSpaces = new Map(),
  photonFallback = null
}) {
  const cleanedMessageId = spectrumReactionTargetMessageId(messageId);
  if (!cleanedMessageId) {
    throw new Error("Photon/Spectrum reaction requires messageId.");
  }
  const normalizedReaction = normalizeSpectrumReaction(reaction);
  const space = await resolveSpectrumSpace({ app, target, knownSpaces });
  if (typeof space.getMessage !== "function") {
    throw new Error(`Photon/Spectrum space ${space.id} does not expose message lookup for reactions.`);
  }

  let original;
  try {
    original = await space.getMessage(cleanedMessageId);
  } catch (error) {
    if (shouldUsePhotonNativeFallback(error)) {
      const fallback = await sendPhotonReactionFallback({
        photonFallback,
        target,
        messageId: cleanedMessageId,
        reaction,
        reason: error
      });
      if (fallback) {
        return fallback;
      }
    }
    throw new Error(`Photon/Spectrum could not load message ${cleanedMessageId} in ${space.id}: ${error.message}`);
  }
  if (!original) {
    const fallback = await sendPhotonReactionFallback({
      photonFallback,
      target,
      messageId: cleanedMessageId,
      reaction,
      reason: new Error(`Photon/Spectrum message ${cleanedMessageId} was not found in ${space.id}.`)
    });
    if (fallback) {
      return fallback;
    }
    throw new Error(`Photon/Spectrum message ${cleanedMessageId} was not found in ${space.id}.`);
  }

  try {
    if (typeof original.react === "function") {
      await original.react(normalizedReaction);
    } else {
      await space.send(spectrumReaction(normalizedReaction, original));
    }
  } catch (error) {
    if (shouldUsePhotonNativeFallback(error)) {
      const fallback = await sendPhotonReactionFallback({
        photonFallback,
        target,
        messageId: cleanedMessageId,
        reaction,
        reason: error
      });
      if (fallback) {
        return fallback;
      }
    }
    throw error;
  }

  return {
    status: "reacted",
    spaceId: space.id,
    messageId: cleanedMessageId,
    reaction: normalizedReaction
  };
}

export async function readSpectrumMessage({
  space,
  message
}) {
  if (!message?.id) {
    throw new Error("Photon/Spectrum read receipt requires a message.");
  }
  if (!space?.id) {
    throw new Error(`Photon/Spectrum read receipt for ${message.id} requires a space.`);
  }

  if (typeof space.read === "function") {
    await space.read(message);
    return { status: "read", method: "space.read", spaceId: space.id, messageId: message.id };
  }
  if (typeof message.read === "function") {
    await message.read();
    return { status: "read", method: "message.read", spaceId: space.id, messageId: message.id };
  }
  if (typeof space.send === "function") {
    await space.send(spectrumRead(message));
    return { status: "read", method: "space.send(read)", spaceId: space.id, messageId: message.id };
  }
  throw new Error(`Photon/Spectrum space ${space.id} does not expose read receipts.`);
}

export async function startSpectrumTyping({
  app,
  target,
  knownSpaces = new Map()
}) {
  const space = await resolveSpectrumSpace({ app, target, knownSpaces });
  if (typeof space.startTyping !== "function") {
    throw new Error(`Photon/Spectrum space ${space.id} does not expose typing indicators.`);
  }
  await space.startTyping();
  return { status: "started", spaceId: space.id };
}

export async function stopSpectrumTyping({
  app,
  target,
  knownSpaces = new Map()
}) {
  const space = await resolveSpectrumSpace({ app, target, knownSpaces });
  if (typeof space.stopTyping === "function") {
    await space.stopTyping();
  }
  return { status: "stopped", spaceId: space.id };
}

export async function resolveSpectrumSpace({ app, target, knownSpaces = new Map() }) {
  if (target.spaceId && knownSpaces.has(target.spaceId)) {
    return knownSpaces.get(target.spaceId);
  }

  const platform = imessage(app);
  const options = target.phone ? { phone: target.phone } : undefined;
  if (target.spaceId && typeof platform.space?.get === "function") {
    return platform.space.get(target.spaceId, options);
  }

  const to = target.to || target.sender || addressFromSpectrumSpaceId(target.spaceId);
  if (!to) {
    throw new Error("Photon/Spectrum iMessage target requires to, sender, or a known live DM/group spaceId.");
  }

  if (typeof platform.user !== "function") {
    throw new Error("Photon/Spectrum iMessage platform does not expose user lookup.");
  }
  const user = await platform.user(to);
  if (typeof platform.space === "function") {
    return options ? platform.space(user, options) : platform.space(user);
  }
  if (typeof platform.space?.create === "function") {
    return platform.space.create(user, options);
  }
  throw new Error("Photon/Spectrum iMessage platform does not expose space creation.");
}

export function buildSpectrumContent({ text = "", files = [] }) {
  const content = [];
  const cleaned = String(text || "");
  if (cleaned.trim()) {
    content.push(cleaned);
  }
  for (const file of files || []) {
    if (String(file || "").trim()) {
      content.push(attachment(String(file).trim()));
    }
  }
  return content;
}

export function addressFromSpectrumSpaceId(spaceId) {
  const value = String(spaceId || "");
  const match = value.match(/(?:^|;)-;([+A-Za-z0-9@._-]+)$/);
  return match ? match[1] : null;
}

export function normalizeSpectrumReaction(value) {
  const reaction = String(value || "").trim();
  if (!reaction) {
    throw new Error("Photon/Spectrum reaction must be non-empty.");
  }
  const key = reaction.toLowerCase().replace(/[\s-]+/g, "_");
  return SPECTRUM_TAPBACK_REACTIONS.get(key) || reaction;
}

export function spectrumReactionTargetMessageId(messageId) {
  const value = String(messageId || "").trim();
  const reactionIndex = value.indexOf(":reaction:");
  return reactionIndex > 0 ? value.slice(0, reactionIndex) : value;
}

export function shouldUsePhotonNativeFallback(error) {
  return !isPhotonBackpressureError(error);
}

export function isPhotonBackpressureError(error) {
  const message = String(error?.message || error || "");
  return error?.status === 429
    || error?.status === 503
    || error?.code === "RATE_LIMITED"
    || error?.code === "UNAVAILABLE"
    || error?.grpcCode === 8
    || error?.grpcCode === 14
    || /temporarily unavailable|service unavailable|too many requests|rate.?limit|connection dropped|connection closed|socket closed|socket hang up|closed before response|deadline|timed out|timeout/i.test(message);
}

async function sendPhotonReplyFallback({
  photonFallback,
  target,
  text,
  files,
  reason
}) {
  if (!photonFallback?.sendTextReply || !target.replyToMessageId || files.length > 0 || !String(text || "").trim()) {
    return null;
  }
  return photonFallback.sendTextReply({
    target,
    text,
    replyToMessageId: target.replyToMessageId,
    reason
  });
}

async function sendPhotonReactionFallback({
  photonFallback,
  target,
  messageId,
  reaction,
  reason
}) {
  if (!photonFallback?.react) {
    return null;
  }
  return photonFallback.react({
    target,
    messageId,
    reaction,
    reason
  });
}
