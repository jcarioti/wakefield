import assert from "node:assert/strict";
import test from "node:test";
import {
  createPhotonProjectUser,
  createPhotonImessageClients,
  getPhotonMessage,
  listPhotonMessagesInChat,
  listPhotonProjectUsers,
  normalizePhotonMessage,
  normalizePhotonSettableReaction,
  ownerPhotonProjectUser,
  photonMessageTargetFromId,
  photonUserRedirectUrl,
  sendPhotonReaction,
  sendPhotonTextMessage,
  selectPhotonClient
} from "../src/photon-history.mjs";

test("createPhotonImessageClients requests Spectrum cloud tokens and creates a shared Photon client", async () => {
  const requests = [];
  const created = [];
  const closed = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({
      succeed: true,
      data: {
        type: "shared",
        token: "shared",
        expiresIn: 3600
      }
    });
  };
  const createClientImpl = (options) => {
    created.push(options);
    return { close: async () => closed.push(options.address) };
  };

  const clientSet = await createPhotonImessageClients({
    spectrum: {
      projectId: "project-1",
      projectSecret: "secret-1",
      cloudUrl: "https://spectrum.example.test/"
    },
    env: {},
    fetchImpl,
    createClientImpl
  });

  assert.equal(requests[0].url, "https://spectrum.example.test/projects/project-1/imessage/tokens");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, `Basic ${Buffer.from("project-1:secret-1").toString("base64")}`);
  assert.equal(clientSet.tokenType, "shared");
  assert.equal(clientSet.clients[0].phone, "shared");
  assert.deepEqual(created[0], {
    address: "imessage.spectrum.photon.codes:443",
    tls: true,
    token: "shared"
  });

  await clientSet.closeAll();
  assert.deepEqual(closed, ["imessage.spectrum.photon.codes:443"]);
});

test("selectPhotonClient requires a phone when dedicated Photon history has multiple numbers", async () => {
  const clientSet = await createPhotonImessageClients({
    spectrum: {
      projectId: "project-1",
      projectSecret: "secret-1"
    },
    fetchImpl: async () => jsonResponse({
      succeed: true,
      data: {
        type: "dedicated",
        auth: {
          instance_a: "token-a",
          instance_b: "token-b"
        },
        numbers: {
          instance_a: "+15550000001",
          instance_b: "+15550000002"
        },
        expiresIn: 3600
      }
    }),
    createClientImpl: (options) => ({ options, close: async () => {} })
  });

  assert.throws(
    () => selectPhotonClient({ clients: clientSet.clients }),
    /multiple iMessage numbers/
  );
  assert.equal(
    selectPhotonClient({ clients: clientSet.clients, phone: "+15550000002" }).instanceId,
    "instance_b"
  );
  assert.equal(
    selectPhotonClient({ clients: clientSet.clients, phone: "instance_a" }).phone,
    "+15550000001"
  );
});

test("listPhotonProjectUsers reads shared assigned numbers without opening iMessage clients", async () => {
  const requests = [];
  const result = await listPhotonProjectUsers({
    spectrum: {
      projectId: "project-1",
      projectSecret: "secret-1",
      cloudUrl: "https://spectrum.example.test/"
    },
    type: "shared",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        succeed: true,
        data: {
          total: 2,
          users: [{
            id: "user-owner",
            projectId: "project-1",
            type: "shared",
            firstName: "Joe",
            lastName: "Owner",
            email: "joe@example.com",
            phoneNumber: "+13307669880",
            assignedPhoneNumber: "+16282646604",
            meta: { project_owner: true },
            createdAt: "2026-06-18T00:00:00.000Z"
          }, {
            id: "user-friend",
            projectId: "project-1",
            type: "shared",
            firstName: "Sam",
            phoneNumber: "+13307661678",
            assignedPhoneNumber: "+16282646604"
          }]
        }
      });
    }
  });

  assert.equal(requests[0].url, "https://spectrum.example.test/projects/project-1/users/?type=shared");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, `Basic ${Buffer.from("project-1:secret-1").toString("base64")}`);
  assert.equal(result.total, 2);
  assert.equal(result.users[0].displayName, "Joe Owner");
  assert.equal(ownerPhotonProjectUser(result.users).phoneNumber, "+13307669880");
  assert.equal(
    photonUserRedirectUrl(result.users[0], {
      spectrum: { cloudUrl: "https://spectrum.example.test/" },
      msg: "Hey Mira"
    }),
    "https://spectrum.example.test/users/user-owner/redirect?msg=Hey+Mira"
  );
});

test("createPhotonProjectUser reuses Photon shared users by phone number", async () => {
  const requests = [];
  const result = await createPhotonProjectUser({
    spectrum: {
      projectId: "project-1",
      projectSecret: "secret-1"
    },
    phoneNumber: "+13307669880",
    firstName: "Joe",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        succeed: true,
        data: {
          id: "user-owner",
          type: "shared",
          firstName: "Joe",
          phoneNumber: "+13307669880",
          assignedPhoneNumber: "+16282646604"
        }
      });
    }
  });

  assert.equal(requests[0].url, "https://spectrum.photon.codes/projects/project-1/users/");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    type: "shared",
    phoneNumber: "+13307669880",
    firstName: "Joe"
  });
  assert.equal(result.assignedPhoneNumber, "+16282646604");
});

test("listPhotonMessagesInChat pages chat history and normalizes messages for recent batches", async () => {
  const listCalls = [];
  const closed = [];
  const result = await listPhotonMessagesInChat({
    spectrum: {
      projectId: "project-1",
      projectSecret: "secret-1"
    },
    chatGuid: "any;-;+15550000001",
    pageSize: 50,
    pageToken: "older-page",
    before: "2026-05-24T01:00:00.000Z",
    phone: "shared",
    fetchImpl: async () => jsonResponse({
      succeed: true,
      data: {
        type: "shared",
        token: "shared",
        expiresIn: 3600
      }
    }),
    createClientImpl: (options) => ({
      options,
      messages: {
        listInChat: async (chat, callOptions) => {
          listCalls.push({ chat, callOptions });
          return {
            nextPageToken: "next-older-page",
            messages: [
              photonMessage({
                guid: "spc-msg-1",
                text: "Can you send that report?",
                sender: "+15550000001",
                dateCreated: "2026-05-24T00:45:00.000Z"
              }),
              photonMessage({
                guid: "spc-msg-2",
                text: "On it",
                isFromMe: true,
                dateCreated: "2026-05-24T00:46:00.000Z",
                replyTargetGuid: "spc-msg-1"
              }),
              photonMessage({
                guid: "spc-msg-3",
                dateCreated: "2026-05-24T00:47:00.000Z",
                reactionTargetGuid: "spc-msg-2",
                reaction: { kind: "question" }
              }),
              photonMessage({
                guid: "spc-msg-4",
                dateCreated: "2026-05-24T00:48:00.000Z",
                attachments: [{
                  guid: "att-1",
                  fileName: "photo.jpg",
                  mimeType: "image/jpeg",
                  totalBytes: 12345,
                  isSticker: false,
                  transferState: "complete"
                }]
              })
            ]
          };
        }
      },
      close: async () => closed.push(options.address)
    })
  });

  assert.equal(result.chatGuid, "any;-;+15550000001");
  assert.equal(result.phone, "shared");
  assert.equal(result.nextPageToken, "next-older-page");
  assert.equal(listCalls[0].chat, "any;-;+15550000001");
  assert.equal(listCalls[0].callOptions.pageSize, 50);
  assert.equal(listCalls[0].callOptions.pageToken, "older-page");
  assert.equal(listCalls[0].callOptions.before.toISOString(), "2026-05-24T01:00:00.000Z");
  assert.equal(result.messages[0].sender, "+15550000001");
  assert.equal(result.messages[1].sender, "agent");
  assert.deepEqual(result.messages[1].replyTo, { messageId: "spc-msg-1", text: "" });
  assert.equal(result.messages[2].text, "[Reaction: question on spc-msg-2]");
  assert.deepEqual(result.messages[2].reactionTo, { messageId: "spc-msg-2", reaction: "question", text: "" });
  assert.match(result.messages[3].text, /photo\.jpg/);
  assert.equal(result.messages[3].attachments[0].guid, "att-1");
  assert.deepEqual(closed, ["imessage.spectrum.photon.codes:443"]);
});

test("listPhotonMessagesInChat can reuse one Photon client set across catch-up reads", async () => {
  const listCalls = [];
  const closed = [];
  const clientSet = {
    tokenType: "shared",
    clients: [{
      phone: "shared",
      client: {
        messages: {
          listInChat: async (chat, callOptions) => {
            listCalls.push({ chat, callOptions });
            return {
              nextPageToken: null,
              messages: [photonMessage({
                guid: `spc-msg-${listCalls.length}`,
                text: `message ${listCalls.length}`,
                sender: "+15550000001",
                dateCreated: "2026-05-24T00:45:00.000Z"
              })]
            };
          }
        },
        close: async () => closed.push("closed")
      }
    }],
    closeAll: async () => {
      for (const entry of clientSet.clients) {
        await entry.client.close();
      }
    }
  };

  const first = await listPhotonMessagesInChat({
    spectrum: {},
    chatGuid: "any;-;+15550000001",
    clientSet
  });
  const second = await listPhotonMessagesInChat({
    spectrum: {},
    chatGuid: "any;-;+15550000002",
    clientSet
  });

  assert.equal(first.messages[0].messageId, "spc-msg-1");
  assert.equal(second.messages[0].messageId, "spc-msg-2");
  assert.deepEqual(listCalls.map((call) => call.chat), ["any;-;+15550000001", "any;-;+15550000002"]);
  assert.deepEqual(closed, []);
  await clientSet.closeAll();
  assert.deepEqual(closed, ["closed"]);
});

test("normalizePhotonMessage keeps basic event shape even when Photon omits optional fields", () => {
  assert.deepEqual(normalizePhotonMessage({
    guid: "msg-1",
    chatGuids: [],
    content: { attachments: [], formatting: [], mentions: [] },
    dateCreated: new Date("2026-05-24T00:00:00.000Z"),
    isFromMe: false,
    itemType: "normal"
  }, { chatGuid: "any;-;+15550000001" }), {
    platform: "imessage",
    chatType: "dm",
    conversationId: "any;-;+15550000001",
    messageId: "msg-1",
    receivedAt: "2026-05-24T00:00:00.000Z",
    senderId: null,
    sender: "unknown",
    text: "",
    attachments: [],
    replyTo: null,
    reactionTo: null
  });
});

test("normalizePhotonMessage preserves attachment-first inline text order", () => {
  const result = normalizePhotonMessage(photonMessage({
    guid: "msg-attachment-first",
    text: "\uFFFCImage + text text ",
    dateCreated: "2026-05-24T00:01:00.000Z",
    attachments: [{
      guid: "att-1",
      fileName: "IMG_2699.heic",
      mimeType: "image/heic",
      totalBytes: 811445,
      isSticker: false,
      transferState: "finished"
    }]
  }));

  assert.equal(result.text, "[Attachment: IMG_2699.heic (image/heic)]\nImage + text text");
});

test("normalizePhotonMessage preserves text-before-attachment inline order", () => {
  const result = normalizePhotonMessage(photonMessage({
    guid: "msg-text-first",
    text: "Please check this \uFFFC",
    dateCreated: "2026-05-24T00:02:00.000Z",
    attachments: [{
      guid: "att-1",
      fileName: "IMG_2700.heic",
      mimeType: "image/heic",
      totalBytes: 811445,
      isSticker: false,
      transferState: "finished"
    }]
  }));

  assert.equal(result.text, "Please check this\n[Attachment: IMG_2700.heic (image/heic)]");
});

test("normalizePhotonSettableReaction maps tapback aliases and literal emoji", () => {
  assert.deepEqual(normalizePhotonSettableReaction("like"), { kind: "like" });
  assert.deepEqual(normalizePhotonSettableReaction("thumbs down"), { kind: "dislike" });
  assert.deepEqual(normalizePhotonSettableReaction("\u{1F44D}"), { kind: "like" });
  assert.deepEqual(normalizePhotonSettableReaction("\u{1F44C}"), {
    kind: "emoji",
    emoji: "\u{1F44C}"
  });
});

test("photonMessageTargetFromId strips Spectrum reaction and part suffixes", () => {
  assert.deepEqual(photonMessageTargetFromId("spc-msg-1:reaction:20462:0"), {
    guid: "spc-msg-1"
  });
  assert.deepEqual(photonMessageTargetFromId("p:2/spc-msg-1"), {
    guid: "spc-msg-1",
    partIndex: 2
  });
});

test("sendPhotonTextMessage preserves reply target for native Photon fallback", async () => {
  const sends = [];
  const clientSet = {
    tokenType: "shared",
    clients: [{
      phone: "shared",
      client: {
        messages: {
          sendText: async (chatGuid, text, options) => {
            sends.push({ chatGuid, text, options });
            return photonMessage({
              guid: "sent-1",
              text,
              isFromMe: true,
              dateCreated: "2026-05-24T00:50:00.000Z"
            });
          }
        },
        close: async () => {}
      }
    }],
    closeAll: async () => {}
  };

  const sent = await sendPhotonTextMessage({
    spectrum: {},
    chatGuid: "any;-;+15550000001",
    text: "reply",
    replyToMessageId: "p:1/spc-msg-parent",
    clientSet
  });

  assert.deepEqual(sends, [{
    chatGuid: "any;-;+15550000001",
    text: "reply",
    options: {
      replyTo: {
        guid: "spc-msg-parent",
        partIndex: 1
      }
    }
  }]);
  assert.equal(sent.id, "sent-1");
  assert.equal(sent.source, "photon");
});

test("sendPhotonReaction uses native Photon reaction API", async () => {
  const reactions = [];
  const clientSet = {
    tokenType: "shared",
    clients: [{
      phone: "shared",
      client: {
        messages: {
          setReaction: async (chatGuid, messageId, reaction, isSet, options) => {
            reactions.push({ chatGuid, messageId, reaction, isSet, options });
            return photonMessage({
              guid: "reaction-event-1",
              dateCreated: "2026-05-24T00:51:00.000Z",
              reactionTargetGuid: messageId,
              reaction: { kind: "like" }
            });
          }
        },
        close: async () => {}
      }
    }],
    closeAll: async () => {}
  };

  const result = await sendPhotonReaction({
    spectrum: {},
    chatGuid: "any;-;+15550000001",
    messageId: "p:0/spc-msg-1",
    reaction: "like",
    clientSet
  });

  assert.equal(result.status, "reacted");
  assert.equal(result.method, "photon.messages.setReaction");
  assert.deepEqual(reactions, [{
    chatGuid: "any;-;+15550000001",
    messageId: "spc-msg-1",
    reaction: { kind: "like" },
    isSet: true,
    options: { partIndex: 0 }
  }]);
});

test("getPhotonMessage fetches one message by guid for lookup fallback", async () => {
  const gets = [];
  const clientSet = {
    tokenType: "shared",
    clients: [{
      phone: "shared",
      client: {
        messages: {
          get: async (chatGuid, messageId) => {
            gets.push({ chatGuid, messageId });
            return photonMessage({
              guid: messageId,
              text: "found",
              dateCreated: "2026-05-24T00:52:00.000Z"
            });
          }
        },
        close: async () => {}
      }
    }],
    closeAll: async () => {}
  };

  const found = await getPhotonMessage({
    spectrum: {},
    chatGuid: "any;-;+15550000001",
    messageId: "spc-msg-1:reaction:20462:0",
    clientSet
  });

  assert.deepEqual(gets, [{
    chatGuid: "any;-;+15550000001",
    messageId: "spc-msg-1"
  }]);
  assert.equal(found.messageId, "spc-msg-1");
  assert.equal(found.text, "found");
});

test("getPhotonMessage falls back to listInChat when Photon get rejects a direct chat", async () => {
  const calls = [];
  const clientSet = {
    tokenType: "shared",
    clients: [{
      phone: "shared",
      client: {
        messages: {
          get: async (chatGuid, messageId) => {
            calls.push(["get", chatGuid, messageId]);
            throw new Error("chat_guid must not be empty");
          },
          listInChat: async (chatGuid, options) => {
            calls.push(["listInChat", chatGuid, options.pageSize]);
            return {
              nextPageToken: null,
              messages: [
                photonMessage({
                  guid: "spc-msg-1",
                  text: "found from history",
                  dateCreated: "2026-05-24T00:53:00.000Z"
                })
              ]
            };
          }
        },
        close: async () => {}
      }
    }],
    closeAll: async () => {}
  };

  const found = await getPhotonMessage({
    spectrum: {},
    chatGuid: "any;-;+15550000001",
    messageId: "spc-msg-1",
    clientSet
  });

  assert.deepEqual(calls, [
    ["get", "any;-;+15550000001", "spc-msg-1"],
    ["listInChat", "any;-;+15550000001", 100]
  ]);
  assert.equal(found.text, "found from history");
});

function jsonResponse(body, { ok = true, status = 200, statusText = "OK" } = {}) {
  return {
    ok,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function photonMessage({
  guid,
  text = "",
  sender = "+15550000001",
  isFromMe = false,
  dateCreated,
  replyTargetGuid,
  reactionTargetGuid,
  reaction,
  attachments = []
}) {
  return {
    guid,
    chatGuids: ["any;-;+15550000001"],
    content: {
      text,
      attachments,
      formatting: [],
      mentions: []
    },
    dateCreated: new Date(dateCreated),
    isFromMe,
    itemType: "normal",
    appliedReactions: [],
    placedStickers: [],
    sender: isFromMe ? undefined : { address: sender, service: "imessage" },
    replyTargetGuid,
    reactionTargetGuid,
    reaction
  };
}
