const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");

let testEnv;
const PROJECT_ID = process.env.GCP_PROJECT || "demo-no-project";
const ALICE_UID = "alice_uid_1";
const BOB_UID = "bob_uid_2";
const CHARLIE_UID = "charlie_uid_3";
const OWNER_UID = "owner_uid_admin";
const OWNER_EMAIL = "arghodeb1381@gmail.com";

const [emulatorHost, emulatorPortStr] = (
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085"
).split(":");
const emulatorPort = parseInt(emulatorPortStr, 10);

function pastDate(msOffset = 2000) {
  return new Date(Date.now() - msOffset);
}

function futureDate(msOffset = 60000) {
  return new Date(Date.now() + msOffset);
}

function makeUserProfile(uid, username, displayName, overrides = {}) {
  const now = pastDate(5000);
  return {
    userId: uid,
    username,
    displayName,
    bio: "Shinobi developer",
    avatarData: "",
    coverData: "",
    accountStatus: "ACTIVE",
    presenceStatus: "ONLINE",
    allowMessagesFrom: "FRIENDS_ONLY",
    showFriendsList: true,
    friendIds: [],
    friendsCount: 0,
    postsCount: 0,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePrivateInfo(uid, email, overrides = {}) {
  const now = pastDate(5000);
  return {
    userId: uid,
    email,
    blockedUserIds: [],
    savedPostIds: [],
    pushNotificationsEnabled: true,
    showOnlineStatus: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

before(async () => {
  const rules = fs.readFileSync("./firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: emulatorHost,
      port: emulatorPort,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

test("Unauthenticated users cannot read or write any collection", async () => {
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  await assertFails(unauthDb.collection("users").where("accountStatus", "==", "ACTIVE").get());
  await assertFails(unauthDb.collection("posts").where("moderationStatus", "==", "ACTIVE").get());
  await assertFails(unauthDb.collection("users").doc(ALICE_UID).set(makeUserProfile(ALICE_UID, "alice", "Alice")));
});

test("User profile creation, PII isolation, shadow updates, and username uniqueness", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID, { email: "alice@example.com", email_verified: true }).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID, { email: "bob@example.com", email_verified: true }).firestore();

  // Valid create
  await assertSucceeds(aliceDb.collection("users").doc(ALICE_UID).set(makeUserProfile(ALICE_UID, "alice_ninja", "Alice")));
  await assertSucceeds(aliceDb.collection("usernames").doc("alice_ninja").set({
    username: "alice_ninja",
    userId: ALICE_UID,
    createdAt: pastDate(2000),
  }));
  await assertSucceeds(aliceDb.collection("users").doc(ALICE_UID).collection("private").doc("info").set(makePrivateInfo(ALICE_UID, "alice@example.com")));

  // PII isolation: Bob cannot read Alice's private info
  await assertFails(bobDb.collection("users").doc(ALICE_UID).collection("private").doc("info").get());
  await assertFails(bobDb.collection("users").doc(ALICE_UID).collection("private").get());

  // Public profile query aligned with rule
  await assertSucceeds(bobDb.collection("users").where("accountStatus", "==", "ACTIVE").get());
  // Unfiltered user query fails
  await assertFails(bobDb.collection("users").get());

  // Alice cannot self-escalate accountStatus or inject ghost field
  await assertFails(aliceDb.collection("users").doc(ALICE_UID).update({ accountStatus: "BANNED", updatedAt: pastDate(1000) }));
  await assertFails(aliceDb.collection("users").doc(ALICE_UID).update({ isVerified: true, updatedAt: pastDate(1000) }));

  // Alice cannot create user with future timestamp
  await assertFails(bobDb.collection("users").doc(BOB_UID).set(makeUserProfile(BOB_UID, "bob_ninja", "Bob", { createdAt: futureDate() })));

  // Bob cannot claim Alice's taken username
  await assertFails(bobDb.collection("usernames").doc("alice_ninja").set({
    username: "alice_ninja",
    userId: BOB_UID,
    createdAt: pastDate(1000),
  }));
});

test("Posts, atomic likes batch, comments, and query filter alignment", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
  const now = pastDate(5000);

  await assertSucceeds(aliceDb.collection("posts").doc("post_1").set({
    authorId: ALICE_UID,
    authorName: "Alice",
    authorUsername: "alice_ninja",
    authorAvatarData: "",
    caption: "Hello Ninja Social!",
    photoDataList: [],
    visibility: "PUBLIC",
    sharedFromPostId: "",
    sharedFromAuthorName: "",
    likesCount: 0,
    commentsCount: 0,
    sharesCount: 0,
    moderationStatus: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  }));

  // Reject @DocumentId `id` inside payload
  await assertFails(aliceDb.collection("posts").doc("post_bad").set({
    id: "post_bad",
    authorId: ALICE_UID,
    authorName: "Alice",
    authorUsername: "alice_ninja",
    authorAvatarData: "",
    caption: "Bad post",
    photoDataList: [],
    visibility: "PUBLIC",
    sharedFromPostId: "",
    sharedFromAuthorName: "",
    likesCount: 0,
    commentsCount: 0,
    sharesCount: 0,
    moderationStatus: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  }));

  // Filtered feed query succeeds; unfiltered query fails
  await assertSucceeds(bobDb.collection("posts").where("moderationStatus", "==", "ACTIVE").get());
  await assertFails(bobDb.collection("posts").get());

  // Bob cannot edit Alice's caption
  await assertFails(bobDb.collection("posts").doc("post_1").update({ caption: "Hacked", updatedAt: pastDate(1000) }));

  // Bob cannot inflate likesCount without atomic like doc
  await assertFails(bobDb.collection("posts").doc("post_1").update({ likesCount: 5, updatedAt: pastDate(1000) }));

  // Atomic like WriteBatch succeeds
  const likeBatch = bobDb.batch();
  likeBatch.set(bobDb.collection("posts").doc("post_1").collection("likes").doc(BOB_UID), {
    postId: "post_1",
    userId: BOB_UID,
    userName: "Bob",
    createdAt: pastDate(1000),
  });
  likeBatch.update(bobDb.collection("posts").doc("post_1"), {
    likesCount: 1,
    updatedAt: pastDate(1000),
  });
  await assertSucceeds(likeBatch.commit());

  // Bob comments & increments commentsCount
  const commentBatch = bobDb.batch();
  commentBatch.set(bobDb.collection("posts").doc("post_1").collection("comments").doc("c1"), {
    postId: "post_1",
    authorId: BOB_UID,
    authorName: "Bob",
    authorAvatarData: "",
    text: "Awesome post!",
    parentCommentId: "",
    replyToAuthorName: "",
    createdAt: pastDate(1000),
    updatedAt: pastDate(1000),
  });
  commentBatch.update(bobDb.collection("posts").doc("post_1"), {
    commentsCount: 1,
    updatedAt: pastDate(1000),
  });
  await assertSucceeds(commentBatch.commit());

  // Filtered comment query succeeds
  await assertSucceeds(aliceDb.collection("posts").doc("post_1").collection("comments").where("postId", "==", "post_1").get());
});

test("Friends gate private messaging and admins cannot snoop private conversations", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
  const charlieDb = testEnv.authenticatedContext(CHARLIE_UID).firestore();
  const ownerDb = testEnv.authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true }).firestore();

  await assertSucceeds(aliceDb.collection("users").doc(ALICE_UID).set(makeUserProfile(ALICE_UID, "alice_ninja", "Alice")));
  await assertSucceeds(bobDb.collection("users").doc(BOB_UID).set(makeUserProfile(BOB_UID, "bob_ninja", "Bob")));

  const convId = `${ALICE_UID}_${BOB_UID}`;
  const now = pastDate(3000);

  // Cannot create conversation before accepted friendship (when allowMessagesFrom == FRIENDS_ONLY)
  await assertFails(aliceDb.collection("conversations").doc(convId).set({
    participantIds: [ALICE_UID, BOB_UID],
    user1Id: ALICE_UID,
    user1Name: "Alice",
    user1AvatarData: "",
    user1Typing: false,
    user2Id: BOB_UID,
    user2Name: "Bob",
    user2AvatarData: "",
    user2Typing: false,
    lastMessageText: "",
    lastMessageSenderId: "",
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  }));

  // Send friend request & accept
  await assertSucceeds(aliceDb.collection("friendships").doc(convId).set({
    participantIds: [ALICE_UID, BOB_UID],
    requesterId: ALICE_UID,
    receiverId: BOB_UID,
    requesterName: "Alice",
    requesterUsername: "alice_ninja",
    requesterAvatarData: "",
    receiverName: "Bob",
    receiverUsername: "bob_ninja",
    receiverAvatarData: "",
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  }));

  // Requester cannot self-accept
  await assertFails(aliceDb.collection("friendships").doc(convId).update({
    status: "ACCEPTED",
    updatedAt: pastDate(1000),
  }));

  // Receiver accepts
  await assertSucceeds(bobDb.collection("friendships").doc(convId).update({
    status: "ACCEPTED",
    updatedAt: pastDate(1000),
  }));

  // Now conversation + message succeed
  await assertSucceeds(aliceDb.collection("conversations").doc(convId).set({
    participantIds: [ALICE_UID, BOB_UID],
    user1Id: ALICE_UID,
    user1Name: "Alice",
    user1AvatarData: "",
    user1Typing: false,
    user2Id: BOB_UID,
    user2Name: "Bob",
    user2AvatarData: "",
    user2Typing: false,
    lastMessageText: "Hey Bob!",
    lastMessageSenderId: ALICE_UID,
    lastMessageAt: pastDate(1000),
    createdAt: pastDate(1000),
    updatedAt: pastDate(1000),
  }));

  await assertSucceeds(aliceDb.collection("conversations").doc(convId).collection("messages").doc("msg_1").set({
    conversationId: convId,
    participantIds: [ALICE_UID, BOB_UID],
    senderId: ALICE_UID,
    senderName: "Alice",
    text: "Hey Bob!",
    photoData: "",
    deliveredTo: [ALICE_UID],
    seenBy: [ALICE_UID],
    deletedBySender: false,
    createdAt: pastDate(900),
    updatedAt: pastDate(900),
  }));

  // Third-party Charlie AND even Owner/Admin cannot read private messages
  await assertFails(charlieDb.collection("conversations").doc(convId).get());
  await assertFails(charlieDb.collection("conversations").doc(convId).collection("messages").get());
  await assertFails(charlieDb.collection("conversations").doc(convId).collection("messages").doc("msg_1").get());
  await assertFails(ownerDb.collection("conversations").doc(convId).get());
  await assertFails(ownerDb.collection("conversations").doc(convId).collection("messages").doc("msg_1").get());
});

test("Admin authorization, email spoofing protection, and moderation actions", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID, { email: "alice@example.com", email_verified: true }).firestore();
  const spoofedOwnerDb = testEnv.authenticatedContext("spoof_uid", { email: OWNER_EMAIL, email_verified: false }).firestore();
  const realOwnerDb = testEnv.authenticatedContext(OWNER_UID, { email: OWNER_EMAIL, email_verified: true }).firestore();
  const now = pastDate(3000);

  // Alice cannot self-promote to admin or update app_config
  await assertFails(aliceDb.collection("admins").doc(ALICE_UID).set({
    userId: ALICE_UID,
    email: "alice@example.com",
    role: "OWNER",
    grantedBy: ALICE_UID,
    createdAt: now,
  }));
  await assertFails(aliceDb.collection("app_config").doc("platform").set({
    registrationEnabled: false,
    maintenanceMode: true,
    maintenanceMessage: "Hacked",
    communityGuidelines: "None",
    latestAnnouncement: "Hacked",
    updatedBy: ALICE_UID,
    updatedAt: now,
  }));

  // Spoofed unverified owner email MUST fail
  await assertFails(spoofedOwnerDb.collection("app_config").doc("platform").set({
    registrationEnabled: false,
    maintenanceMode: true,
    maintenanceMessage: "Spoofed",
    communityGuidelines: "None",
    latestAnnouncement: "Spoofed",
    updatedBy: "spoof_uid",
    updatedAt: now,
  }));

  // Verified owner email succeeds
  await assertSucceeds(realOwnerDb.collection("app_config").doc("platform").set({
    registrationEnabled: true,
    maintenanceMode: false,
    maintenanceMessage: "Scheduled maintenance",
    communityGuidelines: "Be respectful.",
    latestAnnouncement: "Welcome to Ninja Social!",
    updatedBy: OWNER_UID,
    updatedAt: now,
  }));

  // Owner can ban Alice & remove posts
  await assertSucceeds(aliceDb.collection("users").doc(ALICE_UID).set(makeUserProfile(ALICE_UID, "alice_ninja", "Alice")));
  await assertSucceeds(realOwnerDb.collection("users").doc(ALICE_UID).update({
    accountStatus: "BANNED",
    updatedAt: pastDate(1000),
  }));
});
