import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readPiSession } from "../src/pi-history.js";
import { mergeEvent } from "../src/store.js";
it("uses the full native image input fingerprint and never overwrites the platform user body with image placeholders", () => {
  const dir = mkdtempSync(join(tmpdir(), "v34-history-"));
  try {
    const file = join(dir, "s.jsonl"), hash = createHash("sha256").update("image bytes").digest("hex");
    writeFileSync(file, [ { type: "session", version: 3, id: "s", cwd: dir }, { type: "message", id: "u", message: { role: "user", content: [{type:"text",text:"look"},{type:"image",data:Buffer.from("image bytes").toString("base64"),mimeType:"image/png"}] } } ].map(x=>JSON.stringify(x)).join("\n"));
    expect(readPiSession(file).userMessages[0]?.inputHash).toBe(createHash("sha256").update(JSON.stringify({text:"look",images:[hash]})).digest("hex"));
    const old: any = { key:"user:u",seq:1,kind:"message",role:"user",text:"look",attachments:[{attachmentId:"img-a"}],source:"platform",recordedAt:"now",parserVersion:"1",availability:"recorded" };
    const merged = mergeEvent(old,{...old,source:"history",text:"look\n[image]",attachments:undefined});
    expect(merged.text).toBe("look"); expect(merged.attachments).toEqual(old.attachments);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
it("reads repeated valid image turns beyond 32 MiB without retaining base64 in the projection", () => {
  const dir=mkdtempSync(join(tmpdir(),"v34-large-history-"));
  try {
    const image=Buffer.alloc(9*1024**2,7).toString("base64"), file=join(dir,"large.jsonl");
    const rows=[{type:"session",version:3,id:"s",cwd:dir},...Array.from({length:3},(_,i)=>({type:"message",id:`u${i}`,parentId:i?`u${i-1}`:null,message:{role:"user",content:[{type:"text",text:`turn-${i}`},{type:"image",mimeType:"image/png",data:image}]}}))];
    writeFileSync(file,rows.map(r=>JSON.stringify(r)).join("\n"));
    const read=readPiSession(file);
    expect(read.userMessages).toHaveLength(3); expect(JSON.stringify(read).length).toBeLessThan(10000);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
