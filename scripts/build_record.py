"""Convert the benchmark case documents into data/record.json: one entry per
document, paragraph-numbered, with Bates numbers, email sender and date, and
the privilege flag. Needs pandoc and openpyxl.

    python3 scripts/build_record.py <documents dir> data/record.json
"""
import json
import quopri
import re
import subprocess
import sys
from pathlib import Path


D = Path(sys.argv[1]); OUT = Path(sys.argv[2])
META = {
 "plaintiff-complaint.docx": ("compl", "Compl.", "Complaint (Feb. 28, 2024)", "pleading"),
 "defendant-answer-counterclaim.docx": ("answer", "Answer & Countercl.", "Answer and Counterclaim (Apr. 15, 2024)", "pleading"),
 "exclusive-distribution-agreement.docx": ("eda", "EDA", "Exclusive Distribution Agreement (Mar. 15, 2020)", "contract"),
 "notice-of-material-breach.docx": ("breach", "Breach Notice", "Notice of Material Breach (Jan. 10, 2023)", "correspondence"),
 "notice-of-termination.docx": ("term", "Termination Notice", "Notice of Termination (Feb. 15, 2023)", "correspondence"),
 "harborview-breach-response.docx": ("resp", "Harborview Resp.", "Harborview Breach Response (Feb. 22, 2023)", "correspondence"),
 "internal-emails-holcomb-yee-stanton.eml": ("em-hys", "Holcomb/Yee/Stanton Emails", "Internal emails: Holcomb, Yee, Stanton", "email"),
 "internal-emails-stanton-fong-qa.eml": ("em-sfq", "Stanton/Fong QA Emails", "Internal emails: Stanton, Fong (QA)", "email"),
 "email-stanton-to-ivers.eml": ("em-si", "Stanton-Ivers Email", "Email, Stanton to Ivers (Jan. 3, 2023)", "email"),
 "qa-rejection-log.xlsx": ("qalog", "QA Rejection Log", "QA Rejection Log (Sept. 2022 to Feb. 2023)", "log"),
 "deposition-summary-holcomb.docx": ("dep-holcomb", "Holcomb Dep. Summ.", "Deposition Summary: Derek Holcomb (Oct. 18, 2024)", "testimony"),
 "deposition-summary-fong.docx": ("dep-fong", "Fong Dep. Summ.", "Deposition Summary: Lisa Fong (Nov. 5, 2024)", "testimony"),
 "expert-report-buckley.docx": ("buckley", "Buckley Rpt.", "Expert Report of Dr. Aaron Buckley", "expert"),
 "expert-report-chakrabarti.docx": ("chakrabarti", "Chakrabarti Rpt.", "Expert Report of Dr. Priya Chakrabarti", "expert"),
 "scheduling-order.docx": ("sched", "Sched. Order", "Scheduling Order (June 3, 2024)", "order"),
}
def clean(s):
    s = s.replace(" "," ").replace("&nbsp;"," ")
    s = re.sub(r"[ \t]+"," ",s)
    return s.strip()
def paras_docx(p):
    t = subprocess.run(["pandoc",str(p),"-t","plain","--wrap=none"],capture_output=True,text=True).stdout
    out=[]
    for b in re.split(r"\n\s*\n", t):
        b = clean(re.sub(r"\s*\n\s*"," ",b))
        if not b or re.fullmatch(r"[-=+|\s]+",b): continue
        out.append(b)
    return out
JUNK = re.compile(r"^(MIME-Version|Content-Type|Content-Transfer-Encoding|Message-ID|X-Mailer|X-Originating-IP|In-Reply-To|References|Return-Path|X-Bates-End|------=)", re.I)
def short_name(h):
    m = re.match(r"\s*\"?([^<\"]+?)\"?\s*<", h or "")
    n = (m.group(1) if m else (h or "")).strip()
    return n.split()[-1] if n else ""
def paras_eml(p):
    txt = quopri.decodestring(p.read_bytes()).decode("utf-8","replace")
    out=[]; ctxs=[]; cur={}
    for b in re.split(r"\n\s*\n", txt):
        lines=[l.strip() for l in b.split("\n") if l.strip()]
        body=[]
        for l in lines:
            m = re.match(r"^(From|To|Cc|Date|Subject|X-Bates-Start|X-Production-Bates):\s*(.*)$", l)
            if m:
                k,v=m.group(1),m.group(2)
                if k=="From": cur={}
                cur[k]=v
                continue
            if JUNK.match(l): continue
            body.append(l)
        if not body: continue
        t = clean(" ".join(body))
        if re.fullmatch(r"-{2,}", t): continue
        bates = cur.get("X-Bates-Start") or (re.search(r"(?:GL|HDP)-PROD-\d+", cur.get("X-Production-Bates","")) or [None])[0]
        if not bates:
            mb = re.search(r"\b(?:GL|HDP)-PROD-\d+\b", t)
            bates = mb.group(0) if mb else None
        ctx = {"from": short_name(cur.get("From")), "to": short_name(cur.get("To")),
               "date": cur.get("Date",""), "subject": cur.get("Subject",""), "bates": bates}
        out.append(t); ctxs.append(ctx)
    # A message's production number may sit on its own line; spread it to the
    # whole message and drop the bare marker line.
    keyof = lambda c: (c["from"], c["date"])
    found = {}
    for t, c in zip(out, ctxs):
        m = re.search(r"\b(?:GL|HDP)-PROD-\d+\b", t)
        if m and keyof(c) not in found: found[keyof(c)] = m.group(0)
    keep_t, keep_c = [], []
    for t, c in zip(out, ctxs):
        if not c["bates"]: c["bates"] = found.get(keyof(c))
        if re.fullmatch(r"\[?(?:GL|HDP)-PROD-\d+\]?", t): continue
        keep_t.append(t); keep_c.append(c)
    return keep_t, keep_c
def paras_xlsx(p):
    import openpyxl
    wb=openpyxl.load_workbook(p,data_only=True); out=[]
    for ws in wb.worksheets:
        rows=list(ws.iter_rows(values_only=True))
        hdr=None
        for r in rows:
            vals=[("" if v is None else str(v)).strip() for v in r]
            if not any(vals): continue
            if hdr is None: hdr=vals; out.append("Columns: "+" | ".join(v for v in vals if v)); continue
            out.append(clean("; ".join(f"{h}: {v}" for h,v in zip(hdr,vals) if v and h)))
    return out
docs=[]
for fn,(id_,short,title,kind) in META.items():
    p=D/fn
    ctx = None
    if fn.endswith(".eml"): ps, ctx = paras_eml(p)
    elif fn.endswith(".xlsx"): ps = paras_xlsx(p)
    else: ps = paras_docx(p)
    bates = sorted(set(re.findall(r"\b(?:GL-PROD|HDP-PROD|GRN)-\d+\b"," ".join(ps)+json.dumps(ctx or []))))
    docs.append({"id":id_,"file":fn,"short":short,"title":title,"kind":kind,
                 "privileged": fn=="email-stanton-to-ivers.eml",
                 "bates":bates,"paras":ps, **({"ctx":ctx} if ctx else {})})
json.dump({"matter":{"caption":"Harborview Distribution Partners, LLC v. Greenleaf Organics, Inc.","court":"D. Or.","number":"No. 3:24-cv-00613-MRH","client":"Greenleaf Organics, Inc. (defendant)","source":"Harvey Legal Agent Benchmark, task litigation-dispute-resolution/build-litigation-case-timeline (public, fictional record)"},
           "privilege_log":[{"doc":"em-si","entry":"Email from M. Stanton (CEO) to N. Ivers (outside counsel, Ashford Kline & Pryor), Jan. 3, 2023, re termination; produced at GL-PROD-007834 in the Sept. 30, 2024 production. Clawback under FRE 502(b) under consideration."}],
           "docs":docs}, OUT.open("w"), ensure_ascii=False, indent=0)
for d in docs: print(f"{d['id']:12} {d['kind']:14} paras={len(d['paras']):3} chars={sum(map(len,d['paras'])):6} bates={d['bates'][:3]}{'...' if len(d['bates'])>3 else ''}")
print("total KB", OUT.stat().st_size//1024)
