/* CORE START: pure functions, no DOM. Tested under node before publish. */
var WW = (function () {
  "use strict";

  // ---- normalization for quote matching --------------------------------
  // Quote fidelity means the words match. Typography may differ between
  // what a model writes and what the source holds (curly vs straight
  // quotes, dash styles, spacing, a capital at the start of an excerpt),
  // so those are normalized away. Nothing else is.
  function norm(s) {
    return String(s == null ? "" : s)
      .normalize("NFKC")
      .replace(/[‘’‚′`]/g, "'")
      .replace(/[“”„″]/g, '"')
      .replace(/\s*(?:—|–|‒|−|-{2,3})\s*/g, " - ")
      .replace(/\\([\[\]$*_~#.'"])/g, "$1")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function stripOuterQuotes(q) {
    var s = norm(q);
    while (s.length > 1 && /^["']/.test(s) && /["']$/.test(s)) s = s.slice(1, -1).trim();
    return s.replace(/^[.,;:\s]+|[.,;:\s]+$/g, "");
  }

  var MIN_QUOTE_CHARS = 12;

  function docById(record, id) {
    for (var i = 0; i < record.docs.length; i++) if (record.docs[i].id === id) return record.docs[i];
    return null;
  }

  // Find a quote in a text. An ellipsis splits the quote into pieces that
  // must all appear, in order, in the same paragraph.
  function findIn(text, quote) {
    var t = norm(text);
    var parts = stripOuterQuotes(quote).split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean);
    if (!parts.length) return false;
    var at = 0;
    for (var i = 0; i < parts.length; i++) {
      var k = t.indexOf(parts[i], at);
      if (k < 0) return false;
      at = k + parts[i].length;
    }
    return { omission: parts.length > 1 };
  }

  // Verify one quoted excerpt against one pin cite. Deterministic: string
  // matching only, no model involved.
  //   verified    the words are in the cited paragraph
  //   wrong_pin   the words exist in the document, but in another paragraph
  //   not_found   the words are not in the document at all
  //   too_short   too short to prove anything
  //   bad_cite    the document or paragraph does not exist
  function verifyQuote(record, docId, para, quote) {
    var doc = docById(record, docId);
    var n = parseInt(para, 10);
    if (!doc || !(n >= 1 && n <= doc.paras.length)) return { status: "bad_cite" };
    var q = stripOuterQuotes(quote);
    if (q.replace(/\s*(\.\.\.|…)\s*/g, "").length < MIN_QUOTE_CHARS) return { status: "too_short" };
    var hit = findIn(doc.paras[n - 1], quote);
    if (hit) return { status: "verified", omission: hit.omission };
    for (var i = 0; i < doc.paras.length; i++) {
      if (i !== n - 1 && findIn(doc.paras[i], quote)) return { status: "wrong_pin", foundPara: i + 1 };
    }
    return { status: "not_found" };
  }

  // ---- citations -------------------------------------------------------
  function cite(record, docId, para) {
    var d = docById(record, docId);
    if (!d) return docId + " ¶ " + para;
    var c = d.ctx && d.ctx[para - 1];
    var bates = c && c.bates ? " (" + c.bates + ")" : "";
    if (c && c.from) {
      var date = (c.date || "").replace(/^\w{3},\s*/, "").replace(/\s+\d{2}:\d{2}.*$/, "");
      return c.from + " to " + c.to + " email, " + date + bates + " ¶ " + para;
    }
    return d.short + " ¶ " + para;
  }

  // ---- retrieval (BM25 over primary documents) -------------------------
  var STOP = ("a an the and or but if of to in on at by for with from as is was were be been being " +
    "that this these those it its he she they them his her their we our you your i me my not no " +
    "do does did had has have about into over under than then so such any all some more most very " +
    "can could would should will shall may might must also only other which who whom what when where why how " +
    "testified testimony stated asked said").split(" ");
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w] = 1; });

  function tokens(s) {
    return norm(s).replace(/[^a-z0-9$.\s]/g, " ").split(/\s+/).filter(function (w) {
      return w.length > 1 && !STOPSET[w];
    }).map(function (w) { return w.replace(/\.$/, ""); });
  }

  // Testimony comes from the witness's deposition summary. Evidence comes
  // only from contemporaneous primary documents: emails, correspondence,
  // the contract, the QA log. Not the deposition summaries (they mix
  // testimony with the summarizing lawyer's analysis), not the pleadings
  // (allegations, not evidence), not the expert reports (opinion).
  var EVIDENCE_KINDS = { email: 1, correspondence: 1, contract: 1, log: 1 };

  // Chunk by legal unit. An email is retrieved as a whole message, other
  // documents by paragraph (a contract section, a log row, a letter
  // paragraph). Paragraph numbers survive inside each chunk, so every
  // quote can still be pin-cited and checked.
  function chunkRecord(record) {
    var out = [];
    record.docs.forEach(function (d) {
      if (!EVIDENCE_KINDS[d.kind]) return;
      if (d.ctx) {
        var cur = null;
        d.paras.forEach(function (p, i) {
          var c = d.ctx[i], key = c.from + "|" + c.date;
          if (!cur || cur.key !== key) {
            cur = { cid: "C" + (out.length + 1), key: key, doc: d.id, paras: [], text: "", ctx: c };
            out.push(cur);
          }
          cur.paras.push(i + 1);
          cur.text += " " + p;
        });
      } else {
        d.paras.forEach(function (p, i) {
          if (p.length < 40) return;
          out.push({ cid: "C" + (out.length + 1), doc: d.id, paras: [i + 1], text: p });
        });
      }
    });
    return out;
  }

  function evidencePool(record) {
    return chunkRecord(record).map(function (c, i) { return { doc: c.doc, para: i, text: c.text }; });
  }

  // Retrieval for one assertion: the assertion and its testimony
  // paragraph as one query, plus each search phrase Claude proposed at
  // extraction. Union, de-duplicated, capped. Then two context rules a
  // lawyer would apply on any matter:
  //   thread   - an email is read with the message before and after it,
  //              because a reply only makes sense next to what it answers
  //   governing - the contract clauses named at intake (record.matter.
  //              governing) travel with every assertion, because the
  //              dispute turns on them even when the words don't match
  function retrievalOpts(record) {
    var g = (record && record.matter && record.matter.governing) || [];
    return { thread: true, governing: g };
  }
  function retrieveFor(index, chunks, item, witnessDoc, cap, opts) {
    cap = cap || 7; opts = opts || {};
    var sel = [], log = [];
    function add(hits, q) {
      var got = [];
      hits.forEach(function (h) {
        if (sel.indexOf(h.para) < 0 && sel.length < cap) { sel.push(h.para); got.push(chunks[h.para].cid); }
      });
      log.push({ query: q, added: got });
    }
    var ctx = witnessDoc && witnessDoc.paras[item.para - 1] ? witnessDoc.paras[item.para - 1] : "";
    add(retrieve(index, item.claim + " " + item.quote + " " + ctx, 3), "assertion + testimony paragraph");
    (item.search || []).slice(0, 4).forEach(function (ph) { add(retrieve(index, ph, 2), ph); });
    if (opts.thread) {
      var t = [];
      sel.slice().forEach(function (i) {
        if (!chunks[i].ctx) return;
        [i - 1, i + 1].forEach(function (j) {
          if (chunks[j] && chunks[j].doc === chunks[i].doc && sel.indexOf(j) < 0) { sel.push(j); t.push(chunks[j].cid); }
        });
      });
      log.push({ query: "rule: email thread context", added: t });
    }
    if (opts.governing && opts.governing.length) {
      var g = [];
      opts.governing.forEach(function (ref) {
        for (var j = 0; j < chunks.length; j++) {
          if (chunks[j].doc === ref.doc && chunks[j].paras.indexOf(ref.para) >= 0) {
            if (sel.indexOf(j) < 0) { sel.push(j); g.push(chunks[j].cid); }
            break;
          }
        }
      });
      log.push({ query: "rule: governing contract clauses", added: g });
    }
    return { chunks: sel.map(function (i) { return chunks[i]; }), log: log };
  }

  function buildIndex(pool) {
    var df = {}, docs = [], total = 0;
    pool.forEach(function (p) {
      var tk = tokens(p.text), tf = {};
      tk.forEach(function (w) { tf[w] = (tf[w] || 0) + 1; });
      Object.keys(tf).forEach(function (w) { df[w] = (df[w] || 0) + 1; });
      docs.push({ p: p, tf: tf, len: tk.length });
      total += tk.length;
    });
    return { df: df, docs: docs, avg: total / Math.max(1, docs.length), N: docs.length };
  }

  function retrieve(index, query, k) {
    var q = tokens(query), k1 = 1.2, b = 0.5, seen = {};
    q = q.filter(function (w) { if (seen[w]) return false; seen[w] = 1; return true; });
    var scored = index.docs.map(function (d) {
      var s = 0;
      q.forEach(function (w) {
        var f = d.tf[w];
        if (!f) return;
        var idf = Math.log(1 + (index.N - index.df[w] + 0.5) / (index.df[w] + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / index.avg));
      });
      return { p: d.p, s: s };
    }).filter(function (x) { return x.s > 0; });
    scored.sort(function (a, c) { return c.s - a.s; });
    return scored.slice(0, k || 6).map(function (x) {
      return { doc: x.p.doc, para: x.p.para, score: Math.round(x.s * 100) / 100 };
    });
  }

  // ---- prompts ---------------------------------------------------------
  var LENS = {
    examine: {
      label: "Examining an adverse witness",
      qtypes: "For contradicts or qualifies, write 2 to 3 questions in examination order: first lock-in questions (type \"lock-in\") that commit the witness to the testimony without revealing the exhibit, then a confront question (type \"confront\") that puts the exhibit to the witness, quoting it."
    },
    defend: {
      label: "Preparing our own witness",
      qtypes: "For contradicts or qualifies, write 2 to 3 items: the confrontation opposing counsel is likely to use (type \"expected\"), quoting the exhibit, and preparation points for the witness (type \"prep\"), such as documents to review to refresh recollection or areas where the answer must be precise. Never suggest that the witness change or shade truthful testimony."
    }
  };

  function numbered(doc) {
    return doc.paras.map(function (p, i) { return "[¶" + (i + 1) + "] " + p; }).join("\n");
  }

  function extractPrompt(record, witnessId, maxItems) {
    var d = docById(record, witnessId);
    return [
      "You are assisting litigation counsel in " + record.matter.caption + " (" + record.matter.number + ").",
      "Below is a deposition summary with numbered paragraphs. Some paragraphs are the summarizing attorney's own commentary (analysis, significance, strategy, summaries of admissions, exhibit lists). Ignore those. Use only paragraphs that report what the witness said.",
      "",
      "Extract up to " + (maxItems || 12) + " distinct assertions the WITNESS made under oath that bear on the disputed issues (the Cascade shipments, exclusivity, QA rejections, the Year 3 shortfall, notices, and what Harborview was told).",
      "",
      "For each assertion return an object with:",
      "  id: \"T1\", \"T2\", ...",
      "  topic: 3 to 6 words",
      "  claim: one sentence, your paraphrase of what the witness asserted",
      "  quote: an exact excerpt from that one paragraph, 4 to 40 words, copied character for character. Prefer the witness's own quoted words. Never paraphrase inside a quote and never join text from two places.",
      "  para: the paragraph number",
      "  search: 2 to 4 short search phrases (2 to 5 words each) for the record search. Write the words a contemporaneous email, letter, contract clause or log entry would actually contain if it confirmed or contradicted this assertion. Use names, dates and plain business language, not legal terms.",
      "",
      "Reply with only a JSON array of these objects.",
      "",
      "DEPOSITION SUMMARY: " + d.title,
      numbered(d)
    ].join("\n");
  }

  // `selected` maps testimony id -> list of chunks retrieved for it. Each
  // chunk is printed once, with its paragraphs individually cited, and
  // each testimony item lists the excerpts it may use.
  function comparePrompt(record, items, selected, lens) {
    var L = LENS[lens] || LENS.examine;
    var seen = {}, excerpts = [];
    items.forEach(function (it) {
      (selected[it.id] || []).forEach(function (c) {
        if (seen[c.cid]) return;
        seen[c.cid] = 1;
        var d = docById(record, c.doc);
        var head = "<excerpt id=\"" + c.cid + "\" source=\"" + (c.ctx ? cite(record, c.doc, c.paras[0]).replace(/ ¶ \d+$/, "") : d.title) + "\">";
        var body = c.paras.map(function (n) {
          var t = d.paras[n - 1];
          if (t.length > 1400) t = t.slice(0, 1400) + " [...]";
          return "  <p cite=\"" + c.doc + "|" + n + "\">" + t + "</p>";
        }).join("\n");
        excerpts.push(head + "\n" + body + "\n</excerpt>");
      });
    });
    var blocks = items.map(function (it) {
      return "<testimony id=\"" + it.id + "\" topic=\"" + it.topic + "\" may_use=\"" +
        (selected[it.id] || []).map(function (c) { return c.cid; }).join(",") + "\">\n  Assertion: " + it.claim +
        "\n  Quote: \"" + it.quote + "\"\n</testimony>";
    }).join("\n");
    return [
      "You are assisting litigation counsel in " + record.matter.caption + " (" + record.matter.number + "). Our client: " + record.matter.client + ".",
      "Task lens: " + L.label + ".",
      "",
      "Below are RECORD EXCERPTS (contemporaneous emails, letters, contract sections and QA log rows, each paragraph with a cite of the form doc|para), then TESTIMONY items. Each testimony item lists in may_use the excerpts retrieved for it. Compare each assertion ONLY with the paragraphs inside its own may_use excerpts. Do not use outside knowledge.",
      "",
      "For each testimony item return an object:",
      "  id: the testimony id",
      "  status: \"contradicts\" (a passage is inconsistent with the assertion), \"qualifies\" (a passage undercuts, complicates or adds material context), \"consistent\" (passages support it), or \"no_support\" (no passage bears on it)",
      "  materiality: \"high\", \"medium\" or \"low\" for the disputed issues",
      "  evidence: up to 2 objects {doc, para, quote}. doc and para come from the paragraph's cite attribute (\"doc|para\"). quote is an exact excerpt of that one paragraph, 4 to 40 words, copied character for character. Never paraphrase inside a quote. Empty for no_support.",
      "  analysis: 1 to 2 plain sentences explaining the comparison. This is reasoning, not evidence.",
      "  questions: " + L.qtypes + " Each question object is {type, text, exhibit} where exhibit is {doc, para} of the passage it relies on, or null. Empty array for consistent and no_support.",
      "",
      "Reply with only a JSON array of these objects, one per testimony item, in the same order.",
      "",
      "RECORD EXCERPTS",
      excerpts.join("\n"),
      "",
      "TESTIMONY",
      blocks
    ].join("\n");
  }

  // ---- assessment: the gate --------------------------------------------
  var FABRICATED = { doc: "em-hys", para: 54, quote: "I made up the supply chain story to cover the Cascade shipments.", injected: true };

  function assess(record, run, opts) {
    opts = opts || {};
    var privileged = {};
    record.docs.forEach(function (d) { if (d.privileged) privileged[d.id] = true; });
    var byId = {};
    (run.analysis || []).forEach(function (a) { if (a && a.id) byId[a.id] = a; });
    var exceptions = [];
    var m = { items: 0, findings: 0, quotes: 0, verified: 0, rejected: 0, held: 0, privileged: 0 };
    var injectedDone = false;

    var rows = (run.extraction || []).map(function (it) {
      m.items++;
      var a = byId[it.id] || { status: "missing", evidence: [], questions: [], analysis: "" };
      var row = { id: it.id, topic: it.topic, claim: it.claim, quote: it.quote, para: it.para,
        status: a.status, materiality: a.materiality || "", analysis: a.analysis || "",
        testimony: null, evidence: [], questions: [] };

      // Testimony quote: must be in the witness's own summary, at the pin cite.
      m.quotes++;
      var tv = verifyQuote(record, run.witness, it.para, it.quote);
      row.testimony = tv;
      if (tv.status === "verified") m.verified++;
      else {
        m.rejected++;
        exceptions.push({ row: it.id, kind: tv.status, side: "testimony", doc: run.witness, para: it.para,
          quote: it.quote, foundPara: tv.foundPara });
      }

      var ev = (a.evidence || []).slice(0, 3);
      if (opts.inject && !injectedDone && a.status === "contradicts") {
        ev = ev.concat([FABRICATED]); injectedDone = true;
      }
      var allowed = run.retrieved ? (run.retrieved[it.id] || []) : null;
      ev.forEach(function (e) {
        m.quotes++;
        var d = docById(record, e.doc);
        var v;
        if (d && d.kind === "testimony") v = { status: "not_primary" };
        else if (allowed && !allowed.some(function (r) { return r.doc === e.doc && +r.para === +e.para; }))
          v = { status: "outside_passages" };
        else v = verifyQuote(record, e.doc, e.para, e.quote);
        var item = { doc: e.doc, para: +e.para, quote: e.quote, injected: !!e.injected, check: v.status,
          omission: !!v.omission, foundPara: v.foundPara, privileged: !!privileged[e.doc] };
        if (v.status === "verified" && item.privileged) {
          item.check = "privileged"; m.held++; m.privileged++;
          exceptions.push({ row: it.id, kind: "privileged", side: "evidence", doc: e.doc, para: +e.para, quote: e.quote });
        } else if (v.status === "verified") {
          m.verified++;
        } else {
          m.rejected++;
          exceptions.push({ row: it.id, kind: v.status, side: "evidence", doc: e.doc, para: +e.para,
            quote: e.quote, foundPara: v.foundPara, injected: !!e.injected });
        }
        row.evidence.push(item);
      });

      var usable = row.evidence.filter(function (x) { return x.check === "verified"; });
      (a.questions || []).forEach(function (q) {
        if (!q || !q.text) return;
        var ex = q.exhibit && q.exhibit.doc ? { doc: q.exhibit.doc, para: +q.exhibit.para } : null;
        var hold = null;
        if (ex) {
          var match = row.evidence.filter(function (x) { return x.doc === ex.doc && x.para === ex.para; })[0];
          if (match && match.check === "privileged") hold = "privileged";
          else if (privileged[ex.doc]) hold = "privileged";
          else if (!match || match.check !== "verified") hold = "unverified_exhibit";
        }
        row.questions.push({ type: q.type, text: q.text, exhibit: ex, hold: hold });
      });

      var isFinding = row.status === "contradicts" || row.status === "qualifies";
      if (isFinding) m.findings++;
      var fails = row.evidence.some(function (x) { return x.check !== "verified" && x.check !== "privileged"; });
      var holds = row.evidence.some(function (x) { return x.check === "privileged"; });
      if (tv.status !== "verified" || (isFinding && !usable.length) || row.status === "missing") row.check = "held";
      else if (fails || holds) row.check = "partial";
      else row.check = "verified";
      return row;
    });
    return { rows: rows, exceptions: exceptions, metrics: m };
  }


  // ---- record-cite check for a brief -----------------------------------
  // Deterministic. Finds every record cite of the form "(<label> ¶ N)",
  // resolves the label to a record document (by short name or by a Bates
  // number inside an email), and checks what the brief says against the
  // cited paragraph: quoted words word for word, and dollar figures and
  // percentages that appear in the sentence. Whether an unquoted sentence
  // is supported by the page is a judgment, so it is left to the attorney.
  function citeLabels(record) {
    var map = {};
    record.docs.forEach(function (d) {
      map[norm(d.short)] = d.id;
      (d.ctx || []).forEach(function (c) { if (c && c.bates) map[norm(c.bates)] = d.id; });
      (Array.isArray(d.bates) ? d.bates : []).forEach(function (b) { map[norm(b)] = d.id; });
    });
    return map;
  }

  var CITE_RE = /\(([^()]*?)\s*¶\s*(\d+)\)/g;
  var QUOTE_RE = /[“"]([^”"]+)[”"]/g;
  var FIG_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:[KkMm]\b|million\b|thousand\b)?|\b\d+(?:\.\d+)?%/g;

  function figKey(f) {
    var s = String(f).toLowerCase().replace(/\s+/g, "").replace(/,/g, "");
    var m = s.match(/^\$?([\d.]+)(k|m|million|thousand)?%?$/);
    if (!m) return s;
    var v = parseFloat(m[1]);
    if (m[2] === "k" || m[2] === "thousand") v *= 1e3;
    if (m[2] === "m" || m[2] === "million") v *= 1e6;
    return (s.indexOf("%") >= 0 ? "pct:" : "usd:") + Math.round(v);
  }
  function figuresIn(text) {
    return (String(text).match(FIG_RE) || []).map(function (f) { return f.trim(); });
  }

  function checkBrief(record, text) {
    var labels = citeLabels(record), out = [];
    String(text).split(/\n\s*\n/).forEach(function (para, pi) {
      para.split(/(?<=\)\.)\s+/).forEach(function (seg) {
        var cites = [], m;
        CITE_RE.lastIndex = 0;
        while ((m = CITE_RE.exec(seg))) cites.push({ at: m.index, end: m.index + m[0].length, label: m[1].replace(/^(see also|see|cf\.)\s+/i, "").trim(), para: parseInt(m[2], 10), raw: m[0] });
        var quotes = [];
        QUOTE_RE.lastIndex = 0;
        while ((m = QUOTE_RE.exec(seg))) quotes.push({ at: m.index, q: m[1] });
        var prev = 0;
        cites.forEach(function (c) {
          var claim = seg.slice(prev, c.at).trim();
          var mine = quotes.filter(function (q) { return q.at >= prev && q.at < c.at; });
          var bare = claim.replace(QUOTE_RE, " ");
          var r = { briefPara: pi + 1, cite: c.raw.slice(1, -1), claim: claim, label: c.label, para: c.para, checks: [], status: "ok" };
          var docId = labels[norm(c.label)], doc = docId && docById(record, docId);
          var bump = function (st) { var order = { ok: 0, judge: 1, warn: 2, hold: 3, fail: 4 }; if (order[st] > order[r.status]) r.status = st; };
          if (!doc) { r.checks.push({ kind: "cite", result: "fail", note: "No record document matches “" + c.label + "”." }); bump("fail"); }
          else if (!(c.para >= 1 && c.para <= doc.paras.length)) { r.doc = docId; r.checks.push({ kind: "cite", result: "fail", note: doc.short + " has " + doc.paras.length + " paragraphs. ¶ " + c.para + " does not exist." }); bump("fail"); }
          else {
            r.doc = docId;
            if (doc.privileged) { r.checks.push({ kind: "privilege", result: "hold", note: "Cites a document on the privilege log. Do not file until an attorney decides on clawback." }); bump("hold"); }
            if (doc.kind === "pleading") { r.checks.push({ kind: "source", result: "warn", note: "Cites a pleading. That is an allegation, not evidence of the fact." }); bump("warn"); }
            mine.forEach(function (q) {
              var v = verifyQuote(record, docId, c.para, q.q);
              if (v.status === "verified") r.checks.push({ kind: "quote", result: "ok", quote: q.q, note: "Quote matches ¶ " + c.para + " word for word." });
              else if (v.status === "wrong_pin") { r.checks.push({ kind: "quote", result: "fail", quote: q.q, foundPara: v.foundPara, note: "Quote is at ¶ " + v.foundPara + ", not ¶ " + c.para + "." }); bump("fail"); }
              else if (v.status === "too_short") { r.checks.push({ kind: "quote", result: "judge", quote: q.q, note: "Quote too short to prove anything; attorney to confirm." }); bump("judge"); }
              else { r.checks.push({ kind: "quote", result: "fail", quote: q.q, note: "Quoted words are not in " + doc.short + " (checked every paragraph)." }); bump("fail"); }
            });
            var src = doc.paras[c.para - 1], have = {};
            figuresIn(src).forEach(function (f) { have[figKey(f)] = 1; });
            figuresIn(bare).forEach(function (f) {
              if (have[figKey(f)]) r.checks.push({ kind: "figure", result: "ok", note: f + " appears in ¶ " + c.para + "." });
              else { r.checks.push({ kind: "figure", result: "fail", note: f + " does not appear in ¶ " + c.para + "." }); bump("fail"); }
            });
            if (!mine.length) { r.checks.push({ kind: "support", result: "judge", note: "No quotation. Whether ¶ " + c.para + " supports the sentence is the attorney's call." }); bump("judge"); }
          }
          out.push(r);
          prev = c.end;
        });
      });
    });
    var count = function (s) { return out.filter(function (r) { return r.status === s; }).length; };
    return { rows: out, summary: { total: out.length, ok: count("ok"), judge: count("judge"), warn: count("warn"), hold: count("hold"), fail: count("fail") } };
  }

  return { checkBrief: checkBrief, figKey: figKey, norm: norm, verifyQuote: verifyQuote, cite: cite, docById: docById, tokens: tokens,
    evidencePool: evidencePool, chunkRecord: chunkRecord, retrieveFor: retrieveFor, retrievalOpts: retrievalOpts,
    buildIndex: buildIndex, retrieve: retrieve, extractPrompt: extractPrompt,
    comparePrompt: comparePrompt, assess: assess, LENS: LENS, FABRICATED: FABRICATED };
})();
if (typeof module !== "undefined") module.exports = WW;
/* CORE END */
