const express = require("express");
const multer  = require("multer");
const fetch   = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
const path    = require("path");

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = "claude-sonnet-4-20250514";
const PORT    = process.env.PORT || 3000;

if (!API_KEY) { console.error("ERROR: ANTHROPIC_API_KEY not set."); process.exit(1); }

// ── CORS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-api-key,anthropic-version,anthropic-beta");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Temporary in-memory preview store (cleared per process restart, files never persisted to disk)
const previewStore = new Map();

app.get("/health", (_, res) => res.json({ status: "ok", model: MODEL, version: "1.3" }));

// ── Preview endpoint ──────────────────────────────────────────────
app.get("/api/preview/:filename", (req, res) => {
  const key  = decodeURIComponent(req.params.filename);
  const file = previewStore.get(key);
  if (!file) return res.status(404).send("File not in session");
  res.set("Content-Type", file.mime);
  res.set("Content-Disposition", `inline; filename="${key}"`);
  res.send(file.buffer);
});

// ── Extract ───────────────────────────────────────────────────────
app.post("/api/extract", upload.array("files", 25), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });

    // Store for preview
    files.forEach(f => previewStore.set(f.originalname, { buffer: f.buffer, mime: f.mimetype }));

    const fileNames    = files.map(f => f.originalname);
    const contentParts = [];

    for (const file of files) {
      const b64 = file.buffer.toString("base64");
      contentParts.push({ type: "text", text: `[FILE: "${file.originalname}"]` });
      if (file.mimetype.startsWith("image/")) {
        contentParts.push({ type: "image", source: { type: "base64", media_type: file.mimetype, data: b64 } });
      } else if (file.mimetype === "application/pdf") {
        contentParts.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
      }
    }

    contentParts.push({ type: "text", text: buildExtractionPrompt(fileNames) });

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":    "pdfs-2024-09-25"
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content: contentParts }] })
    });

    if (!apiRes.ok) {
      const err = await apiRes.json();
      return res.status(apiRes.status).json({ error: err.error?.message || "Anthropic API error" });
    }

    const data    = await apiRes.json();
    const rawText = data.content.map(c => c.text || "").join("");

    // Robust JSON extraction — handles truncation & trailing text
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch {
      try {
        const s = rawText.indexOf("{"), e = rawText.lastIndexOf("}");
        if (s === -1 || e === -1) throw new Error("No JSON found");
        parsed = JSON.parse(safeCloseJson(rawText.slice(s, e + 1)));
      } catch (e2) {
        console.error("JSON parse failed:", rawText.slice(0, 800));
        return res.status(500).json({ error: "AI returned malformed JSON — please try again." });
      }
    }

    parsed = applyEntitlementCheck(parsed);
    return res.json(parsed);

  } catch (err) {
    console.error("Extract error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Sanction ─────────────────────────────────────────────────────
app.post("/api/sanction", async (req, res) => {
  try {
    const { extractedData } = req.body;
    if (!extractedData) return res.status(400).json({ error: "No data" });

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, messages: [{ role: "user", content: buildSanctionPrompt(extractedData) }] })
    });
    if (!apiRes.ok) { const e = await apiRes.json(); return res.status(apiRes.status).json({ error: e.error?.message }); }
    const d = await apiRes.json();
    return res.json({ sanction: d.content.map(c => c.text || "").join("") });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`CGHS POC v1.3 on http://localhost:${PORT}`));

// ══════════════════
// ENTITLEMENT CHECK
// MoHFW OM F.No.S.11011/11/2016-CGHS(P)/EHS dated 28 Oct 2022
// ══════════════════
function applyEntitlementCheck(data) {
  try {
    const hospFlag = data.hospitalisation?.is_hospitalisation;
    const isHosp   = hospFlag === true || (typeof hospFlag === "object" && hospFlag?.value === true);

    if (!isHosp) {
      data.entitlement = { checked: false, reason: "Outpatient claim — ward entitlement check not applicable." };
      return data;
    }

    const basicPayRaw = gv(data.claimant?.basic_pay);
    const basicPay    = parseFloat(String(basicPayRaw || "0").replace(/[^0-9.]/g, "")) || 0;
    const wardRaw     = String(gv(data.hospitalisation?.ward_type) || "").toLowerCase().trim();
    const tad         = parseFloat(data.totals?.total_admissible || 0);

    // Determine entitlement
    let entitled, label;
    if (basicPay === 0) {
      entitled = null;
      label    = "Basic pay not available — cannot determine ward entitlement";
    } else if (basicPay <= 36500) {
      entitled = "general";
      label    = `General Ward — Basic Pay ₹${basicPay.toLocaleString("en-IN")} (≤ ₹36,500)`;
    } else if (basicPay <= 50500) {
      entitled = "semi-private";
      label    = `Semi-Private Ward — Basic Pay ₹${basicPay.toLocaleString("en-IN")} (₹36,501–₹50,500)`;
    } else {
      entitled = "private";
      label    = `Private Ward — Basic Pay ₹${basicPay.toLocaleString("en-IN")} (> ₹50,500)`;
    }

    // Ward hierarchy: general < semi-private < private
    const hierarchy = { general: 0, "semi-private": 1, private: 2 };
    const claimedLevel  = hierarchy[wardRaw]  ?? -1;
    const entitledLevel = entitled ? hierarchy[entitled] : -1;

    let wardMatch, wardFlag;
    if (!entitled) {
      wardMatch = "Cannot verify — basic pay not found in documents";
      wardFlag  = "warn";
    } else if (claimedLevel === -1) {
      wardMatch = `Ward type not identified in bills (entitled: ${entitled})`;
      wardFlag  = "warn";
    } else if (claimedLevel > entitledLevel) {
      wardMatch = `⚠ MISMATCH — bill shows ${wardRaw} ward but entitlement is ${entitled} ward only. Amount may need restriction.`;
      wardFlag  = "fail";
      data.entitlement_adjustment_required = true;
    } else {
      wardMatch = `✓ OK — ${wardRaw} ward is within entitlement (${entitled})`;
      wardFlag  = "pass";
    }

    data.entitlement = {
      checked:        true,
      is_hospitalisation: true,
      basic_pay:      basicPay,
      entitled_ward:  entitled,
      entitled_label: label,
      ward_claimed:   wardRaw || "Not identified",
      ward_match:     wardMatch,
      ward_flag:      wardFlag,
      total_admissible_checked: tad,
      om_reference:   "MoHFW OM F.No.S.11011/11/2016-CGHS(P)/EHS dated 28th October 2022"
    };
  } catch (e) {
    data.entitlement = { checked: false, reason: "Error: " + e.message };
  }
  return data;
}

function gv(f) {
  if (f == null) return "";
  if (typeof f === "object" && "value" in f) return f.value;
  return f;
}

function safeCloseJson(s) {
  let opens = 0, arr = 0, inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") opens++; else if (ch === "}") opens--;
    else if (ch === "[") arr++; else if (ch === "]") arr--;
  }
  let r = s.replace(/,\s*$/, "");
  for (let i = 0; i < arr;   i++) r += "]";
  for (let i = 0; i < opens; i++) r += "}";
  return r;
}

function buildExtractionPrompt(fileNames) {
  return `You are an expert at extracting data from Indian government CGHS medical reimbursement documents.

Files uploaded: ${fileNames.map((n,i)=>`${i+1}."${n}"`).join(", ")}

For every field: {"value":"...","conf":"high|med|low","source_file":"filename","source_page":N}
If not found: {"value":"","conf":"low","source_file":"Not found","source_page":0}

IMPORTANT RULES:
1. Detect hospitalisation: if ANY bill has room/bed/ward/OT/ICU/admission/discharge charges, set hospitalisation.is_hospitalisation=true
2. For e-Claim documents: extract basic_pay, pay_level, bank_account, ifsc_code carefully — these are used for entitlement checks
3. Keep JSON compact. Return ONLY the JSON object, nothing before or after it.

JSON structure to return:
{"claimant":{"name":{"value":"","conf":"high","source_file":"","source_page":1},"designation":{"value":"","conf":"high","source_file":"","source_page":1},"department":{"value":"","conf":"high","source_file":"","source_page":1},"cghs_card_no":{"value":"","conf":"high","source_file":"","source_page":1},"crn":{"value":"","conf":"high","source_file":"","source_page":1},"basic_pay":{"value":"","conf":"med","source_file":"","source_page":1},"pay_level":{"value":"","conf":"med","source_file":"","source_page":1},"pfms_vendor_id":{"value":"","conf":"med","source_file":"","source_page":1},"bank_account":{"value":"","conf":"med","source_file":"","source_page":1},"ifsc_code":{"value":"","conf":"med","source_file":"","source_page":1},"bank_name":{"value":"","conf":"med","source_file":"","source_page":1}},"referral":{"patient_name":{"value":"","conf":"high","source_file":"","source_page":1},"relation":{"value":"","conf":"high","source_file":"","source_page":1},"wellness_centre":{"value":"","conf":"high","source_file":"","source_page":1},"referral_id":{"value":"","conf":"med","source_file":"","source_page":1},"referral_date":{"value":"","conf":"high","source_file":"","source_page":1},"valid_upto":{"value":"","conf":"med","source_file":"","source_page":1}},"hospital":{"name":{"value":"","conf":"high","source_file":"","source_page":1},"nabh_nabl":{"value":"","conf":"med","source_file":"","source_page":1}},"hospitalisation":{"is_hospitalisation":false,"ward_type":{"value":"","conf":"med","source_file":"","source_page":1},"admission_date":{"value":"","conf":"med","source_file":"","source_page":1},"discharge_date":{"value":"","conf":"med","source_file":"","source_page":1},"days":{"value":0,"conf":"med","source_file":"","source_page":1}},"bills":[{"bill_no":{"value":"","conf":"high","source_file":"","source_page":1},"bill_date":{"value":"","conf":"high","source_file":"","source_page":1},"procedure":{"value":"","conf":"high","source_file":"","source_page":1},"cghs_rate_sno":{"value":"","conf":"high","source_file":"","source_page":1},"cghs_rate":{"value":0,"conf":"high","source_file":"","source_page":1},"qty":{"value":1,"conf":"high","source_file":"","source_page":1},"amount_claimed":{"value":0,"conf":"high","source_file":"","source_page":1},"amount_admissible":{"value":0,"conf":"high","source_file":"","source_page":1},"remarks":{"value":"","conf":"high","source_file":"","source_page":1},"is_unlisted":false}],"totals":{"total_claimed":0,"total_admissible":0},"flags":{"has_unlisted_procedure":false,"account_verified":true,"referral_valid":true,"nabh_verified":true,"notes":[]}}`;
}

function buildSanctionPrompt(data) {
  const fv = v => (v && typeof v === "object" && "value" in v) ? v.value : (v || "");
  const c = data.claimant||{}, r = data.referral||{}, h = data.hospital||{}, t = data.totals||{};
  const bills = (data.bills||[]).map(b => `${fv(b.bill_no)} ${fv(b.bill_date)}: ${fv(b.procedure)}, claimed ${fv(b.amount_claimed)}, admissible ${fv(b.amount_admissible)}`).join("; ");
  return `Generate a formal CGHS medical reimbursement sanction note in GoI eOffice noting style.
Claimant: ${fv(c.name)}, ${fv(c.designation)}, ${fv(c.department)}
Patient: ${fv(r.patient_name)} (${fv(r.relation)}) | Hospital: ${fv(h.name)} | Centre: ${fv(r.wellness_centre)}
Total Admissible: Rs.${t.total_admissible} | Bills: ${bills}
Format: Note #, Sub:, PUC para, numbered paras 2-6, Submitted for approval please., eOffice footer.
Return ONLY the sanction note text.`;
}
