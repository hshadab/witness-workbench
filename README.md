# Witness Workbench

Deposition prep from the record. Given a witness and a case file, it finds what
the witness said under oath, searches the contemporaneous documents for
anything that confirms, contradicts or complicates it, and drafts examination
questions tied to the exhibit. **Nothing reaches a lawyer unless its quote has
been matched, word for word, to the cited paragraph.**

Prototype on a public, fictional case. Not deployed on client data and not legal advice.

## Why

Contradiction finding is now a common feature in litigation AI. What a partner
needs before relying on it is different: proof that every quoted line is really
in the record, a queue for anything that is not, and privileged material kept
out of the work product until a lawyer decides. This prototype is built around
those three things.

## How it works

| Step | Who | What happens |
|---|---|---|
| Ingest | code | 15 case files (Word, email, Excel) into numbered paragraphs. Bates numbers and email sender and date are kept. |
| Testimony | Claude | Reads the witness's deposition summary and extracts sworn assertions, each with an exact quote and paragraph cite, skipping the summarizing lawyer's commentary. Proposes search phrases for each. |
| Search | code | BM25 keyword search over contemporaneous primary documents only: emails, letters, the contract, the QA log. Each email is searched as one message; other documents by section. |
| Compare | Claude | Compares each assertion only with the excerpts retrieved for it. Every piece of evidence must be quoted exactly, with a pin cite. Drafts lock-in and confront questions. |
| Check | code | Deterministic string matching: is this exact text in that paragraph? Wrong pin cites, invented quotes, cites outside the retrieved excerpts, and anything from a privilege-logged document go to a review queue. |
| Review | lawyer | Accept or reject each row. Only accepted, verified rows become the outline. |

The checker is code on purpose. A model asked to confirm its own quotes tends to
agree with itself; string matching gives a yes or no that does not depend on the model.

## Evidence rules

- Testimony comes only from the witness's deposition summary.
- Evidence comes only from contemporaneous documents. Deposition summaries are
  excluded (they mix testimony with a lawyer's analysis), pleadings are excluded
  (allegations), and expert reports are excluded (opinion).
- The client CEO's January 3, 2023 email to outside counsel was produced to the
  other side and is on the privilege log. It stays searchable because it is in
  the production, but any use of it, and any question that relies on it, is
  held until an attorney decides on clawback.

## Measured

On the sample run (witness: Derek Holcomb, 13 sworn assertions):

- **Quote checker:** 33 of 34 quotes verified; the one held item is the
  privileged email. A planted fabricated quote is rejected.
- **Retrieval recall:** search surfaces 18 of the 21 passages the analysis relies on.

Retrieval took three changes to get there, measured at each step:

| Design | Recall |
|---|---|
| Keyword search, one paragraph at a time, all documents | 3 of 21 |
| Each email as one message; evidence limited to contemporaneous documents | 10 of 21 |
| Claude proposes search phrases per assertion; party names kept as search terms | 18 of 21 |

The sample run was prepared during the build by Claude following the same two
instructions the live run sends, and is labeled that way in the page. The
numbers are on one witness and are directional, not a benchmark result.

## Run it

The page is a single HTML file: `dist/witness-workbench.html`. It is published as
a Claude artifact; the two AI steps run on the viewer's own Claude account when
opened in Claude. Opened anywhere else, the sample run, the checker, the
planted-quote test and the outline all still work.

```bash
node --test 'tests/*.test.js'     # 19 offline tests: checker, privilege gate, retrieval, prompts
python3 scripts/build_page.py     # rebuild dist/ from src/ and data/
```

Rebuilding the case record from the source documents (needs pandoc and openpyxl):

```bash
python3 scripts/build_record.py \
  /path/to/harvey-labs/tasks/litigation-dispute-resolution/build-litigation-case-timeline/documents \
  data/record.json
```

## Layout

```
src/core.js            checker, privilege gate, chunking, retrieval, prompts (no DOM)
src/page.html          the interface
data/record.json       the case record: 15 documents, paragraph-numbered
data/sample-holcomb.json   sample run
scripts/               build the record and the page
tests/                 offline tests
dist/                  the built page
```

## Inside a firm

This is a pattern, not a product. Lawyers should not have to open a separate
page. Inside a firm platform such as Legora it maps to a Skill (instructions,
an outline template, and negative examples such as "never paraphrase inside
quotation marks") plus a Tabular Review with one row per sworn assertion and
columns for the confronting exhibit, exact quote, pin cite, verification status
and reviewer sign-off, followed by a verification step before export. The
documents would come from the DMS and the review platform with matter
permissions inherited, and testimony from certified transcripts cited page and line.

## Limits

- The checker proves the words are in the source. It does not prove the source
  supports the inference; that is the lawyer's review.
- Keyword search still misses passages that say the same thing in other words.
- Testimony comes from deposition summaries, not certified transcripts, so cites
  are to summary paragraphs rather than page and line.

## Data

The case record is the document set for the `build-litigation-case-timeline`
task in Harvey's open-source Legal Agent Benchmark
([harvey-labs](https://github.com/harveyai/harvey-labs), MIT licensed), used
unmodified apart from conversion to text. The case and its people are fictional.
Not affiliated with or endorsed by Harvey.

Built by Houman Shadab with Claude as the coding tool.
