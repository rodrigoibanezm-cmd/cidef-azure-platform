import { createHash } from 'node:crypto';

// Content identity of the captured JS values, not a database revision or an
// atomic snapshot. Array/Map order is retained: existing resolvers may use it.
export function serializeSalesContent(value){
  if(value===null)return '["null"]';
  if(typeof value!=='object'){
    if(!['string','number','boolean','undefined','bigint'].includes(typeof value))throw new Error('UNSUPPORTED_SALES_CAPTURE_TYPE');
    return JSON.stringify([typeof value,typeof value==='number'&&Object.is(value,-0)?'-0':String(value)]);
  }
  if(value instanceof Date)return JSON.stringify(['date',String(value.getTime())]);
  if(value instanceof Map)return '["map",['+[...value].map(([k,v])=>'['+serializeSalesContent(k)+','+serializeSalesContent(v)+']').join(',')+']]';
  if(Array.isArray(value))return '["array",['+Array.from({length:value.length},(_,i)=>Object.hasOwn(value,i)?serializeSalesContent(value[i]):'["hole"]').join(',')+']]';
  if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new Error('UNSUPPORTED_SALES_CAPTURE_TYPE');
  return '["object",['+Object.keys(value).sort().map(k=>'['+JSON.stringify(k)+','+serializeSalesContent(value[k])+']').join(',')+']]';
}
// Stream the identical canonical representation into SHA-256 without
// materializing one large serialized string in memory.
function* salesContentChunks(value){
  if(value===null){yield '["null"]';return;}
  if(typeof value!=='object'){
    if(!['string','number','boolean','undefined','bigint'].includes(typeof value))throw new Error('UNSUPPORTED_SALES_CAPTURE_TYPE');
    yield JSON.stringify([typeof value,typeof value==='number'&&Object.is(value,-0)?'-0':String(value)]);
    return;
  }
  if(value instanceof Date){yield JSON.stringify(['date',String(value.getTime())]);return;}
  if(value instanceof Map){
    yield '["map",[';
    let first=true;
    for(const [k,v] of value){
      if(!first)yield ',';first=false;
      yield '[';yield* salesContentChunks(k);yield ',';yield* salesContentChunks(v);yield ']';
    }
    yield ']]';return;
  }
  if(Array.isArray(value)){
    yield '["array",[';
    for(let i=0;i<value.length;i++){
      if(i)yield ',';
      if(Object.hasOwn(value,i))yield* salesContentChunks(value[i]);
      else yield '["hole"]';
    }
    yield ']]';return;
  }
  if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new Error('UNSUPPORTED_SALES_CAPTURE_TYPE');
  yield '["object",[';
  let first=true;
  for(const k of Object.keys(value).sort()){
    if(!first)yield ',';first=false;
    yield '[';yield JSON.stringify(k);yield ',';yield* salesContentChunks(value[k]);yield ']';
  }
  yield ']]';
}
export function salesContentFingerprint(value){
  const hash=createHash('sha256');
  for(const chunk of salesContentChunks(value))hash.update(chunk);
  return 'sha256:'+hash.digest('hex');
}

// Only published SALES values need this protection. Mutable built-ins are
// exposed as defensive snapshots; even prototype mutators cannot reach the
// retained value. Normal grouping reads frozen arrays/objects, without cloning
// the facts. No shared/global state or immutable collection framework.
export function freezeSalesValue(value){
  if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
  if(value instanceof Map){
    for(const [k,v] of value){freezeSalesValue(k);freezeSalesValue(v);}
    for(const name of ['set','delete','clear'])Object.defineProperty(value,name,{value(){throw new TypeError('IMMUTABLE_SALES_MAP');}});
  }else if(value instanceof Date){
    for(const name of Object.getOwnPropertyNames(Date.prototype).filter(k=>k.startsWith('set')))Object.defineProperty(value,name,{value(){throw new TypeError('IMMUTABLE_SALES_DATE');}});
  }else{
    for(const [key,item] of Object.entries(value)){
      if(item instanceof Map||item instanceof Date){
        const retained=structuredClone(item);
        Object.defineProperty(value,key,{enumerable:true,get:()=>freezeSalesValue(structuredClone(retained))});
      }else freezeSalesValue(item);
    }
  }
  return Object.freeze(value);
}
