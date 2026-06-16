import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySpectrumBridge,
  classifySpectrumBridgeWithoutLocalHistory,
  findMatchingConnectorEvent,
  findMatchingPhotonHistoryMessage,
  findMatchingStatusMessage,
  latestLocalOutbound,
  parseJsonLines,
  shouldRestartAfterIncident,
  summarizeIncidentEvidence
} from "../src/spectrum-bridge-diagnostics.mjs";

test("latestLocalOutbound ignores prior state and inbound rows", () => {
  const rows = [
    localRow({ id: 3, text: "newest inbound", is_from_me: false }),
    localRow({ id: 2, text: "new outbound" }),
    localRow({ id: 1, text: "old outbound" })
  ];

  assert.equal(latestLocalOutbound(rows, { afterRowId: 1 }).id, 2);
  assert.equal(latestLocalOutbound(rows, { afterRowId: 2 }), null);
});

test("findMatchingConnectorEvent matches same text and nearby received time", () => {
  const local = localRow({
    text: "Still good?",
    created_at: "2026-05-24T19:30:48.291Z"
  });
  const match = findMatchingConnectorEvent({
    localRow: local,
    spaceId: "any;-;+13307669880",
    eventRecords: [{
      platform: "imessage",
      space_id: "any;-;+13307669880",
      received_at: "2026-05-24T19:30:49.000Z",
      text: "Still good?"
    }]
  });

  assert.equal(match.text, "Still good?");
});

test("findMatchingStatusMessage matches the active probe text in live bridge status", () => {
  const match = findMatchingStatusMessage({
    status: {
      lastMatchedInboundMessage: {
        messageId: "spc-msg-test",
        spaceId: "any;-;+13307669880",
        text: "Wakefield bridge active probe 2026-05-24T20:55:00.000Z abc123"
      }
    },
    spaceId: "any;-;+13307669880",
    text: "Wakefield bridge active probe 2026-05-24T20:55:00.000Z abc123"
  });

  assert.equal(match.messageId, "spc-msg-test");
});

test("findMatchingStatusMessage rejects wrong space or text", () => {
  const status = {
    lastMatchedInboundMessage: {
      messageId: "spc-msg-test",
      spaceId: "any;-;+13307669880",
      text: "expected"
    }
  };

  assert.equal(findMatchingStatusMessage({ status, spaceId: "any;-;+13304421678", text: "expected" }), null);
  assert.equal(findMatchingStatusMessage({ status, spaceId: "any;-;+13307669880", text: "different" }), null);
});

test("classifySpectrumBridge reports stale when local row is newer than running receive loop", () => {
  const result = classifySpectrumBridge({
    status: {
      updatedAt: "2026-05-24T19:30:50.000Z",
      lastInboundAt: "2026-05-24T19:08:48.873Z",
      receiveLoop: {
        state: "running",
        startedAt: "2026-05-24T18:53:12.867Z",
        lastActivityAt: "2026-05-24T19:08:48.873Z",
        lastError: null
      }
    },
    localRows: [localRow({
      id: 319620,
      created_at: "2026-05-24T19:30:48.291Z",
      text: "Still good?"
    })],
    eventRecords: [],
    state: {},
    spaceId: "any;-;+13307669880",
    now: new Date("2026-05-24T19:30:51.000Z")
  });

  assert.equal(result.state, "stale");
  assert.equal(result.reason, "local_message_newer_than_running_spectrum_receive_loop");
  assert.equal(result.latestLocalRow.id, 319620);
});

test("classifySpectrumBridge treats an old status file as stale evidence", () => {
  const result = classifySpectrumBridge({
    status: {
      updatedAt: "2026-05-24T19:00:00.000Z",
      receiveLoop: { state: "running", lastError: null }
    },
    localRows: [localRow({
      id: 319620,
      created_at: "2026-05-24T19:30:48.291Z",
      text: "Still good?"
    })],
    eventRecords: [],
    state: {},
    spaceId: "any;-;+13307669880",
    now: new Date("2026-05-24T19:30:51.000Z")
  });

  assert.equal(result.state, "stale");
  assert.equal(result.reason, "status_file_not_fresh");
  assert.equal(result.statusFreshness.reason, "status_updated_at_too_old");
});

test("classifySpectrumBridge does not let a newer matched row mask an older miss", () => {
  const result = classifySpectrumBridge({
    status: {
      updatedAt: "2026-05-24T19:35:01.000Z",
      lastInboundAt: "2026-05-24T19:34:59.000Z",
      receiveLoop: { state: "running", lastError: null }
    },
    localRows: [
      localRow({
        id: 319622,
        created_at: "2026-05-24T19:34:58.000Z",
        text: "new delivered"
      }),
      localRow({
        id: 319621,
        created_at: "2026-05-24T19:30:48.291Z",
        text: "missed"
      })
    ],
    eventRecords: [{
      platform: "imessage",
      space_id: "any;-;+13307669880",
      received_at: "2026-05-24T19:34:59.000Z",
      text: "new delivered"
    }],
    state: {},
    spaceId: "any;-;+13307669880",
    now: new Date("2026-05-24T19:35:02.000Z")
  });

  assert.equal(result.state, "suspect");
  assert.equal(result.latestLocalRow.id, 319621);
});

test("classifySpectrumBridge marks row healthy when connector event exists", () => {
  const result = classifySpectrumBridge({
    status: {
      updatedAt: "2026-05-24T19:30:50.000Z",
      lastInboundAt: "2026-05-24T19:30:49.000Z",
      receiveLoop: { state: "running", lastError: null }
    },
    localRows: [localRow({
      id: 319620,
      created_at: "2026-05-24T19:30:48.291Z",
      text: "Still good?"
    })],
    eventRecords: [{
      platform: "imessage",
      space_id: "any;-;+13307669880",
      received_at: "2026-05-24T19:30:48.500Z",
      text: "Still good?"
    }],
    state: {},
    spaceId: "any;-;+13307669880",
    now: new Date("2026-05-24T19:30:51.000Z")
  });

  assert.equal(result.state, "healthy");
  assert.equal(result.reason, "matched_connector_event");
  assert.equal(result.stateUpdate.lastHandledLocalRowId, 319620);
});

test("classifySpectrumBridgeWithoutLocalHistory preserves Photon data-plane errors", () => {
  const result = classifySpectrumBridgeWithoutLocalHistory({
    status: {
      updatedAt: "2026-05-24T19:30:50.000Z",
      receiveLoop: {
        state: "running",
        lastErrorAt: "2026-05-24T19:30:49.000Z",
        lastError: "IMessageError: Unknown server error occurred\n    at fromGrpcError"
      }
    },
    localHistory: {
      ok: false,
      skipped: true,
      error: { message: "local iMessage history skipped" }
    },
    now: new Date("2026-05-24T19:30:51.000Z")
  });

  assert.equal(result.state, "suspect");
  assert.equal(result.reason, "local_history_unavailable_data_plane_error");
  assert.equal(result.spectrumError.plane, "data");
  assert.equal(result.receiveLoop.lastError, "IMessageError: Unknown server error occurred");
});

test("parseJsonLines parses imsg JSON lines", () => {
  assert.deepEqual(parseJsonLines('{"id":1}\n{"id":2}\n'), [{ id: 1 }, { id: 2 }]);
});

test("summarizeIncidentEvidence distinguishes Photon history from live stream misses", () => {
  const classification = {
    state: "stale",
    latestLocalRow: summarizeLocalRow(localRow({
      id: 319620,
      created_at: "2026-05-24T19:30:48.291Z",
      text: "Still good?"
    }))
  };
  const deepProbe = {
    listInChat: {
      ok: true,
      value: {
        messages: [{
          messageId: "REMOTE-GUID",
          receivedAt: "2026-05-24T19:30:49.000Z",
          text: "Still good?"
        }]
      }
    }
  };

  assert.equal(
    findMatchingPhotonHistoryMessage({ localRow: classification.latestLocalRow, deepProbe }).messageId,
    "REMOTE-GUID"
  );
  assert.equal(
    summarizeIncidentEvidence({ classification, deepProbe }).conclusion,
    "photon_history_has_message_but_live_stream_missed_it"
  );
});

test("summarizeIncidentEvidence distinguishes messages missing from Photon history", () => {
  const classification = {
    state: "stale",
    latestLocalRow: summarizeLocalRow(localRow({ text: "Still good?" }))
  };
  const deepProbe = {
    listInChat: {
      ok: true,
      value: { messages: [] }
    }
  };

  assert.equal(
    summarizeIncidentEvidence({ classification, deepProbe }).conclusion,
    "local_sender_has_message_but_photon_history_does_not"
  );
});

test("summarizeIncidentEvidence handles deep probes without local history baseline", () => {
  assert.equal(
    summarizeIncidentEvidence({
      classification: {
        state: "suspect",
        latestLocalRow: null
      },
      deepProbe: {
        listInChat: {
          ok: true,
          value: { messages: [] }
        }
      }
    }).conclusion,
    "photon_data_plane_probe_completed_without_local_baseline"
  );
});

test("shouldRestartAfterIncident skips Photon auth and target rejection errors", () => {
  assert.equal(shouldRestartAfterIncident({
    conclusion: "photon_history_probe_failed",
    listInChat: {
      error: { message: "Target not allowed for this project" }
    }
  }), false);
  assert.equal(shouldRestartAfterIncident({
    conclusion: "photon_history_probe_failed",
    listInChat: {
      error: { message: "Authentication failed." }
    }
  }), false);
  assert.equal(shouldRestartAfterIncident({
    conclusion: "photon_history_has_message_but_live_stream_missed_it"
  }), true);
});

function localRow(overrides = {}) {
  return {
    id: 1,
    guid: "LOCAL-GUID",
    created_at: "2026-05-24T19:00:00.000Z",
    text: "hello",
    is_from_me: true,
    chat_guid: "any;-;+16282646604",
    chat_identifier: "+16282646604",
    ...overrides
  };
}

function summarizeLocalRow(row) {
  return {
    id: row.id,
    guid: row.guid,
    createdAt: row.created_at,
    text: row.text,
    isFromMe: row.is_from_me,
    chatGuid: row.chat_guid,
    chatIdentifier: row.chat_identifier
  };
}
