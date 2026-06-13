import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readFile } from "node:fs/promises";

import {
  parseTranscriptJson,
  parseTranscriptText,
  readTranscriptFile,
} from "../lib/transcript.mjs";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/sample-transcript.json", import.meta.url),
);

test("readTranscriptFile parses the synthetic segmented fixture", async () => {
  const transcript = await readTranscriptFile(FIXTURE_PATH);

  assert.equal(transcript.title, "Croceum DD Weekly Check-In");
  assert.equal(transcript.occurredAt, "2026-05-28T15:00:00.000Z");
  assert.deepEqual(transcript.participants, [
    { name: "Eric Ip", email: "eric@example.com" },
    { name: "Joyce Huang", email: "joyce@example.com" },
    { name: "Alex Fedorchenko" },
  ]);
  assert.match(
    transcript.text,
    /Eric Ip: Croceum wants the recap.*follow-ups from Atlas memory\./s,
  );
  assert.match(transcript.text, /Joyce Huang: I will review/);
});

test("parseTranscriptJson handles top-level Granola-style sentence arrays", () => {
  const transcript = parseTranscriptJson(
    [
      {
        sentence: "We should keep the demo list clean.",
        startTime: "00:01",
        endTime: "00:03",
        speaker_name: "Eric Ip",
        speaker_id: "speaker_1",
      },
      {
        sentence: "No duplicate ClickUp tasks.",
        startTime: "00:04",
        endTime: "00:05",
        speaker_name: "Eric Ip",
        speaker_id: "speaker_1",
      },
      {
        sentence: "Atlas should keep the receipt.",
        startTime: "00:06",
        endTime: "00:08",
        speaker_name: "Joyce Huang",
        speaker_id: "speaker_2",
      },
    ],
    { filePath: "/tmp/2026-05-28_Croceum_DD_Weekly_Check-In.json" },
  );

  assert.equal(transcript.title, "Croceum DD Weekly Check In");
  assert.equal(transcript.occurredAt, "2026-05-28T00:00:00.000Z");
  assert.deepEqual(transcript.participants, [
    { name: "Eric Ip" },
    { name: "Joyce Huang" },
  ]);
  assert.equal(
    transcript.text,
    [
      "Eric Ip: We should keep the demo list clean. No duplicate ClickUp tasks.",
      "Joyce Huang: Atlas should keep the receipt.",
    ].join("\n"),
  );
});

test("parseTranscriptText parses a pasted JSON string to the same shape as the file path", async () => {
  // The pasted-string path must produce byte-for-byte the same ParsedTranscript
  // as reading the same JSON off disk — this is the Cowork (no-FS) equivalence.
  const fromFile = await readTranscriptFile(FIXTURE_PATH);
  const rawString = await readFile(FIXTURE_PATH, "utf8");
  const fromText = parseTranscriptText(rawString, { filePath: FIXTURE_PATH });

  assert.deepEqual(fromText, fromFile);
});

test("parseTranscriptText accepts a pasted JSON string with no filePath", () => {
  const transcript = parseTranscriptText(
    JSON.stringify({
      title: "Pasted transcript",
      date: "2026-05-28",
      participants: ["Eric Ip", "Joyce Huang"],
      segments: [
        { speaker: "Eric Ip", text: "Let us ship the Cowork paste path." },
        { speaker: "Joyce Huang", text: "Agreed." },
      ],
    }),
  );

  assert.equal(transcript.title, "Pasted transcript");
  assert.equal(transcript.occurredAt, "2026-05-28T00:00:00.000Z");
  assert.deepEqual(transcript.participants, [
    { name: "Eric Ip" },
    { name: "Joyce Huang" },
  ]);
  assert.equal(
    transcript.text,
    ["Eric Ip: Let us ship the Cowork paste path.", "Joyce Huang: Agreed."].join(
      "\n",
    ),
  );
});

test("parseTranscriptText falls back to plain text when the string is not JSON", () => {
  const transcript = parseTranscriptText("Eric: We shipped it. Joyce: Nice.");

  assert.equal(transcript.title, "Meeting transcript");
  assert.equal(transcript.text, "Eric: We shipped it. Joyce: Nice.");
});

test("parseTranscriptText throws on an empty string", () => {
  assert.throws(() => parseTranscriptText("   "), /empty/i);
});

test("parseTranscriptJson handles flat text fields", () => {
  const transcript = parseTranscriptJson({
    title: "Flat transcript",
    date: "2026-05-28",
    participants: ["Eric Ip"],
    text: "Eric: Done.",
  });

  assert.equal(transcript.title, "Flat transcript");
  assert.equal(transcript.occurredAt, "2026-05-28T00:00:00.000Z");
  assert.deepEqual(transcript.participants, [{ name: "Eric Ip" }]);
  assert.equal(transcript.text, "Eric: Done.");
});
