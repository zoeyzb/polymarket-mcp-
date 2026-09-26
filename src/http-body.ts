import type { IncomingMessage } from "node:http";

export type RequestBodyErrorCode =
  | "invalid_json_body"
  | "request_body_too_large"
  | "request_body_aborted"
  | "request_body_stream_error";

export class RequestBodyError extends Error {
  readonly code:RequestBodyErrorCode;
  readonly status:number;

  constructor(code:RequestBodyErrorCode,status:number,message:string){
    super(message);
    this.name="RequestBodyError";
    this.code=code;
    this.status=status;
  }
}

function errorMessage(error:unknown){
  return error instanceof Error ? error.message : String(error);
}

export async function parseJsonBody(
  req:IncomingMessage,
  maxBytes=1024*1024
):Promise<unknown>{
  const boundedMax=Math.max(1,Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 1024*1024);
  const chunks:Buffer[]=[];
  let total=0;

  try{
    for await (const chunk of req){
      if(req.aborted){
        throw new RequestBodyError("request_body_aborted",400,"request body stream was aborted");
      }
      const buffer=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total+=buffer.length;
      if(total>boundedMax){
        throw new RequestBodyError(
          "request_body_too_large",
          413,
          `request body exceeds ${boundedMax} bytes`
        );
      }
      chunks.push(buffer);
    }
  }catch(error:any){
    if(error instanceof RequestBodyError) throw error;
    if(req.aborted || error?.code==="ECONNRESET" || /aborted|premature close/i.test(errorMessage(error))){
      throw new RequestBodyError("request_body_aborted",400,"request body stream was aborted");
    }
    throw new RequestBodyError(
      "request_body_stream_error",
      400,
      `request body stream failed: ${errorMessage(error)}`
    );
  }

  if(req.aborted){
    throw new RequestBodyError("request_body_aborted",400,"request body stream was aborted");
  }
  if(!chunks.length) return undefined;

  try{
    return JSON.parse(Buffer.concat(chunks,total).toString("utf8"));
  }catch{
    throw new RequestBodyError("invalid_json_body",400,"request body is not valid JSON");
  }
}
