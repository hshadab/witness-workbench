// Offline tests for the Witness Workbench core: the quote checker, the
// privilege gate, retrieval, and the prompts. No network, no model, no keys.
//
//   node --test tests/

const test = require("node:test");
const assert = require("node:assert/strict");
const WW = require("../src/core.js");
const RECORD = require("../data/record.json");
const SAMPLE = require("../data/sample-holcomb.json");

// ---- the quote checker ------------------------------------------------

test("a quote in the cited paragraph verifies", () => {
  assert.equal(WW.verifyQuote(RECORD, "em-hys", 3, "Keep it quiet for now.").status, "verified");
});

test("typography does not matter: curly quotes, dashes, a capital", () => {
  const r = WW.verifyQuote(RECORD, "em-hys", 17, "“on the Harborview thing - don't worry about it.”");
  assert.equal(r.status, "verified");
});

test("the right words at the wrong paragraph are a wrong pin cite, with the right one", () => {
  const r = WW.verifyQuote(RECORD, "em-hys", 3, "I told him supply chain issues");
  assert.equal(r.status, "wrong_pin");
  assert.equal(r.foundPara, 54);
});

test("words that are not in the document are rejected", () => {
  const r = WW.verifyQuote(RECORD, "em-hys", 54, "I made up the supply chain story to cover the Cascade shipments.");
  assert.equal(r.status, "not_found");
});

test("one changed word is enough to fail", () => {
  const r = WW.verifyQuote(RECORD, "em-hys", 3, "Keep it secret for now.");
  assert.equal(r.status, "not_found");
});

test("an ellipsis is allowed only if every piece appears, in order, in the same paragraph", () => {
  assert.equal(WW.verifyQuote(RECORD, "em-hys", 54, "Randy is asking ... the line I went with").status, "verified");
  assert.equal(WW.verifyQuote(RECORD, "em-hys", 54, "the line I went with ... Randy is asking").status, "not_found");
});

test("fragments too short to prove anything are refused", () => {
  assert.equal(WW.verifyQuote(RECORD, "em-hys", 3, "Keep it").status, "too_short");
});

test("a cite to a paragraph or document that does not exist is refused", () => {
  assert.equal(WW.verifyQuote(RECORD, "em-hys", 999, "Keep it quiet for now.").status, "bad_cite");
  assert.equal(WW.verifyQuote(RECORD, "no-such-doc", 1, "Keep it quiet for now.").status, "bad_cite");
});

// ---- the gate over a whole run -----------------------------------------

test("sample run: every testimony quote and every evidence quote is checked", () => {
  const { metrics } = WW.assess(RECORD, SAMPLE, {});
  assert.equal(metrics.items, 13);
  assert.equal(metrics.quotes, 34);
  assert.equal(metrics.verified, 33);
  assert.equal(metrics.rejected, 0);
  assert.equal(metrics.held, 1);
});

test("evidence from the privilege-logged email is held, and so is any question that relies on it", () => {
  const { rows, exceptions } = WW.assess(RECORD, SAMPLE, {});
  const t10 = rows.find((r) => r.id === "T10");
  assert.equal(t10.evidence.find((e) => e.doc === "em-si").check, "privileged");
  assert.ok(t10.questions.some((q) => q.hold === "privileged"));
  assert.equal(t10.check, "partial");
  assert.deepEqual(exceptions.map((e) => e.kind), ["privileged"]);
});

test("a planted fabricated quote is caught and queued", () => {
  const { metrics, exceptions } = WW.assess(RECORD, SAMPLE, { inject: true });
  assert.equal(metrics.rejected, 1);
  const planted = exceptions.find((e) => e.injected);
  assert.equal(planted.kind, "not_found");
});

test("deposition summaries never count as evidence", () => {
  const run = JSON.parse(JSON.stringify(SAMPLE));
  run.analysis[0].evidence = [{ doc: "dep-holcomb", para: 32, quote: "Keep it quiet for now." }];
  const row = WW.assess(RECORD, run, {}).rows[0];
  assert.equal(row.evidence[0].check, "not_primary");
});

test("in a live run, a cite outside the excerpts Claude was given is flagged", () => {
  const run = JSON.parse(JSON.stringify(SAMPLE));
  run.retrieved = { T1: [{ doc: "em-hys", para: 3 }] };
  const row = WW.assess(RECORD, run, {}).rows.find((r) => r.id === "T1");
  assert.equal(row.evidence.find((e) => e.para === 3).check, "verified");
  assert.equal(row.evidence.find((e) => e.para === 5).check, "outside_passages");
});

test("a testimony quote that is not in the witness's own summary holds the row", () => {
  const run = JSON.parse(JSON.stringify(SAMPLE));
  run.extraction[0].quote = "a routine and fully authorized arrangement";
  const row = WW.assess(RECORD, run, {}).rows[0];
  assert.equal(row.testimony.status, "not_found");
  assert.equal(row.check, "held");
});

// ---- retrieval -----------------------------------------------------------

test("only contemporaneous primary documents are searchable as evidence", () => {
  const kinds = new Set(WW.chunkRecord(RECORD).map((c) => WW.docById(RECORD, c.doc).kind));
  assert.deepEqual([...kinds].sort(), ["contract", "correspondence", "email", "log"]);
});

test("each email is one chunk, with its paragraph numbers kept", () => {
  const emails = WW.chunkRecord(RECORD).filter((c) => c.doc === "em-hys");
  assert.equal(emails.length, 7);
  assert.ok(emails.every((c) => c.paras.length >= 1));
});

test("retrieval finds all 21 passages the sample analysis relies on", () => {
  const chunks = WW.chunkRecord(RECORD);
  const index = WW.buildIndex(WW.evidencePool(RECORD));
  const witness = WW.docById(RECORD, SAMPLE.witness);
  let hit = 0, total = 0;
  for (const item of SAMPLE.extraction) {
    const got = WW.retrieveFor(index, chunks, item, witness, 7, WW.retrievalOpts(RECORD)).chunks;
    for (const e of SAMPLE.analysis.find((a) => a.id === item.id).evidence) {
      total++;
      if (got.some((c) => c.doc === e.doc && c.paras.includes(e.para))) hit++;
    }
  }
  assert.equal(total, 21);
  assert.equal(hit, 21, `recall ${hit}/${total}`);
});

test("search alone, without the context rules, finds 18 of 21 (the before number)", () => {
  const chunks = WW.chunkRecord(RECORD);
  const index = WW.buildIndex(WW.evidencePool(RECORD));
  const witness = WW.docById(RECORD, SAMPLE.witness);
  let hit = 0;
  for (const item of SAMPLE.extraction) {
    const got = WW.retrieveFor(index, chunks, item, witness, 7).chunks;
    for (const e of SAMPLE.analysis.find((a) => a.id === item.id).evidence)
      if (got.some((c) => c.doc === e.doc && c.paras.includes(e.para))) hit++;
  }
  assert.equal(hit, 18);
});

test("governing clauses are named at intake, not chosen from the answer key", () => {
  const g = RECORD.matter.governing;
  assert.ok(Array.isArray(g) && g.length === 4);
  assert.ok(g.every((r) => r.doc === "eda" && r.label));
});

// ---- prompts ---------------------------------------------------------------

test("prompts fit well under the 256 KB request limit", () => {
  const chunks = WW.chunkRecord(RECORD);
  const index = WW.buildIndex(WW.evidencePool(RECORD));
  const witness = WW.docById(RECORD, SAMPLE.witness);
  const selected = {};
  for (const item of SAMPLE.extraction) selected[item.id] = WW.retrieveFor(index, chunks, item, witness, 7, WW.retrievalOpts(RECORD)).chunks;
  for (const p of [WW.extractPrompt(RECORD, "dep-holcomb", 12), WW.extractPrompt(RECORD, "dep-fong", 12),
    WW.comparePrompt(RECORD, SAMPLE.extraction, selected, "examine")]) {
    assert.ok(Buffer.byteLength(p) < 128 * 1024);
  }
});

test("the preparing-our-witness lens forbids coaching", () => {
  const p = WW.comparePrompt(RECORD, SAMPLE.extraction.slice(0, 1), {}, "defend");
  assert.match(p, /Never suggest that the witness change or shade truthful testimony/);
});

// ---- brief cite check ------------------------------------------------------

test("brief cite check: the sample brief's planted errors are all caught", () => {
  const fs = require("node:fs");
  const brief = fs.readFileSync(require("node:path").join(__dirname, "../data/sample-brief.txt"), "utf8");
  const r = WW.checkBrief(RECORD, brief);
  const by = Object.fromEntries(r.rows.map((x) => [x.cite, x]));
  assert.equal(r.summary.total, 12);
  assert.equal(by["GRN-004217 ¶ 4"].status, "fail");
  assert.equal(by["GRN-004217 ¶ 4"].checks.find((c) => c.kind === "quote").foundPara, 5);
  assert.equal(by["GRN-004226 ¶ 35"].status, "fail");
  assert.equal(by["GRN-004230 ¶ 58"].status, "fail");
  assert.equal(by["Breach Notice ¶ 41"].status, "fail");
  assert.equal(by["GL-PROD-007834 ¶ 2"].status, "hold");
  assert.equal(by["Compl. ¶ 13"].status, "warn");
  assert.equal(by["Termination Notice ¶ 8"].status, "ok");
  assert.equal(by["GRN-004230 ¶ 54"].status, "ok");
});

test("brief cite check: figures compare by value, not by formatting", () => {
  assert.equal(WW.figKey("$630K"), WW.figKey("$630,000"));
  assert.equal(WW.figKey("$1.9 million"), WW.figKey("$1,900,000"));
  assert.notEqual(WW.figKey("$5.2M"), WW.figKey("$5.8M"));
});
