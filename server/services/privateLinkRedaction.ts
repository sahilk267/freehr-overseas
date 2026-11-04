/** Remove recognized scoped interview capabilities from incoming quotes before storage/AI context. */
export function redactAvailabilityLinks(value:string){
 return value.replace(/\/(availability|interview-response)(?:#|%23|&#35;)[A-Za-z0-9_-]{4,36}(?:\.|%2e)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gi,(_,path)=>`/${path.toLowerCase()}#[private link redacted]`);
}
