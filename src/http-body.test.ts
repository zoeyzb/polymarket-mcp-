import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { parseJsonBody, RequestBodyError } from "./http-body.js";

function requestFrom(chunks:string[]){
  const stream=new PassThrough() as any;
  queueMicrotask(()=>{
    for(const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream;
}

describe("HTTP JSON input body",()=>{
  it("parses a normal JSON request", async()=>{
    const req=requestFrom(['{"jsonrpc":"2.0","method":"tools/list","id":1}']);
    await expect(parseJsonBody(req,1024)).resolves.toMatchObject({
      jsonrpc:"2.0",
      method:"tools/list",
      id:1
    });
  });

  it("returns a classified error for invalid JSON", async()=>{
    const req=requestFrom(["{bad json"]);
    await expect(parseJsonBody(req,1024)).rejects.toMatchObject({
      name:"RequestBodyError",
      code:"invalid_json_body",
      status:400
    });
  });

  it("rejects oversized request bodies before unbounded buffering", async()=>{
    const req=requestFrom([JSON.stringify({payload:"x".repeat(2048)})]);
    await expect(parseJsonBody(req,256)).rejects.toMatchObject({
      code:"request_body_too_large",
      status:413
    });
  });

  it("converts aborted/reset streams into a stable request_body_aborted error", async()=>{
    const req=new PassThrough() as any;
    const pending=parseJsonBody(req,1024);
    req.write('{"jsonrpc":"2.0",');
    req.aborted=true;
    const error=Object.assign(new Error("aborted"),{code:"ECONNRESET"});
    req.destroy(error);
    await expect(pending).rejects.toMatchObject({
      code:"request_body_aborted",
      status:400
    });
  });

  it("converts unknown input stream failures into request_body_stream_error", async()=>{
    const req=new PassThrough() as any;
    const pending=parseJsonBody(req,1024);
    req.destroy(new Error("input stream exploded"));
    await expect(pending).rejects.toMatchObject({
      code:"request_body_stream_error",
      status:400
    });
  });

  it("exposes stable typed metadata", ()=>{
    const error=new RequestBodyError("invalid_json_body",400,"bad");
    expect(error.name).toBe("RequestBodyError");
    expect(error.code).toBe("invalid_json_body");
    expect(error.status).toBe(400);
  });
});
