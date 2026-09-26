export interface DbBackoffOptions {
  baseMs:number;
  maxMs:number;
}

export function createDbBackoff(options:DbBackoffOptions){
  const baseMs=Math.max(100,Math.floor(options.baseMs));
  const maxMs=Math.max(baseMs,Math.floor(options.maxMs));
  let failures=0;
  let retryAtMs=0;
  let delayMs=0;
  let lastError:string|null=null;

  function errorText(error:unknown){
    return error instanceof Error ? error.message : String(error);
  }

  function isQuotaError(error:unknown){
    const msg=errorText(error).toLowerCase();
    return msg.includes("exceeded the quota") ||
      msg.includes("quota exceeded") ||
      msg.includes("upgrade your plan to increase limits");
  }

  return {
    isQuotaError,
    shouldAttempt(now=Date.now()){
      return retryAtMs<=now;
    },
    noteFailure(error:unknown,now=Date.now()){
      if(!isQuotaError(error)) return {opened:false};
      if(retryAtMs>now) return {opened:true,coalesced:true,delayMs,retryAtMs,failures};
      failures+=1;
      delayMs=Math.min(maxMs,baseMs*(2**Math.max(0,failures-1)));
      retryAtMs=now+delayMs;
      lastError=errorText(error);
      return {opened:true,delayMs,retryAtMs,failures};
    },
    noteSuccess(){
      failures=0;
      retryAtMs=0;
      delayMs=0;
      lastError=null;
    },
    status(now=Date.now()){
      return {
        open:retryAtMs>now,
        failures,
        retryAtMs,
        retryAt:new Date(retryAtMs||0).toISOString(),
        delayMs,
        remainingMs:Math.max(0,retryAtMs-now),
        lastError
      };
    }
  };
}
