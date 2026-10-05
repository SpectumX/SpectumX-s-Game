// Backend: เก็บจำนวนขนมไว้ที่เซิร์ฟเวอร์ + ตรวจสลิปผ่าน Slip2Go
const HALF = 30 * 60 * 1000;
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

async function load(db, pid) {
  const now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO players(pid,treats,regen) VALUES(?,10,?)").bind(pid, now).run();
  const p = await db.prepare("SELECT treats,regen FROM players WHERE pid=?").bind(pid).first();
  if (p.treats >= 10) p.regen = now;
  else {
    const n = Math.floor((now - p.regen) / HALF);
    if (n > 0) { p.treats = Math.min(10, p.treats + n); p.regen = p.treats >= 10 ? now : p.regen + n * HALF; }
  }
  return p;
}
const save = (db, pid, p) => db.prepare("UPDATE players SET treats=?,regen=? WHERE pid=?").bind(p.treats, p.regen, pid).run();
const out = (p, extra = {}) => ({ treats: p.treats, next: p.treats < 10 ? Math.max(0, HALF - (Date.now() - p.regen)) : 0, ...extra });

export async function onRequestPost({ request, env }) {
  const act = new URL(request.url).pathname.split("/").pop();
  let pid, form, body;
  try {
    if (act === "redeem") { form = await request.formData(); pid = form.get("pid"); }
    else { body = await request.json(); pid = body.pid; }
  } catch (e) { return J({ error: "คำขอไม่ถูกต้อง" }, 400); }
  if (!/^[a-z0-9]{16,40}$/.test(pid || "")) return J({ error: "รหัสผู้เล่นไม่ถูกต้อง" }, 400);

  const p = await load(env.DB, pid);

  if (act === "state") { await save(env.DB, pid, p); return J(out(p)); }

  if (act === "feed") {
    if (p.treats < 1) { await save(env.DB, pid, p); return J(out(p, { error: "ขนมหมด" }), 400); }
    p.treats--; await save(env.DB, pid, p); return J(out(p));
  }

  if (act === "redeem") {
    const f = form.get("slip");
    if (!f || typeof f === "string" || f.size > 5e6) return J({ error: "ไฟล์สลิปไม่ถูกต้อง (ไม่เกิน 5MB)" }, 400);
    const fd = new FormData();
    fd.append("file", f);
    fd.append("payload", JSON.stringify({ checkCondition: { checkDuplicate: true } }));
    let base = (env.SLIP2GO_API_URL || "").replace(/\/$/, "");
    if (!base.includes("/api/")) base += "/api/verify-slip/qr-image/info";
    let r, d = {};
    try {
      r = await fetch(base, { method: "POST", headers: { Authorization: "Bearer " + env.SLIP2GO_SECRET }, body: fd });
      d = await r.json();
    } catch (e) { return J({ error: "เชื่อมต่อระบบตรวจสลิปไม่ได้ ลองใหม่อีกครั้ง" }, 502); }
    const data = d.data || {};
    const amount = Number(data.amount);
    const ref = String(data.transRef || data.referenceId || data.transactionId || "");
    const dbg = env.DEBUG ? " | " + JSON.stringify(d).slice(0, 400) : "";
    if (!r.ok || !ref || !(amount >= 10)) return J({ error: "ตรวจสลิปไม่ผ่าน" + dbg }, 400);
    if (env.RECEIVER_HINT && !JSON.stringify(d).includes(env.RECEIVER_HINT)) return J({ error: "สลิปนี้ไม่ได้โอนเข้าบัญชีของเรา" + dbg }, 400);
    try {
      await env.DB.prepare("INSERT INTO slips(ref,pid,amount,at) VALUES(?,?,?,?)").bind(ref, pid, amount, Date.now()).run();
    } catch (e) { return J({ error: "สลิปนี้ถูกใช้แล้ว" }, 400); }
    const added = Math.floor(amount / 10) * 100;
    p.treats += added; await save(env.DB, pid, p);
    return J(out(p, { added }));
  }
  return J({ error: "not found" }, 404);
}
