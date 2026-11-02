// Child process for multiprocess.test.ts: imports the REAL db module (migrations + pragmas) and hammers writes.
const { db } = await import("./db.js");
const n = Number(process.argv[2] ?? 1000);
const tag = process.argv[3] ?? "child";
const ins = db.prepare("INSERT INTO audit_log (ts, kind, decision, reason) VALUES (?, 'system', ?, ?)");
const tx = db.transaction((i: number) => {
  ins.run(Date.now(), "multi-1", `${tag}:${i}`);
  ins.run(Date.now(), "multi-2", `${tag}:${i}`);
});
for (let i = 0; i < n; i++) {
  if (i % 3 === 0) tx.immediate(i);
  else ins.run(Date.now(), "single", `${tag}:${i}`);
}
console.log(`done ${n}`);
db.close();
