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
export function salesContentFingerprint(value){
  return 'sha256:'+createHash('sha256').update(serializeSalesContent(value)).digest('hex');
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
