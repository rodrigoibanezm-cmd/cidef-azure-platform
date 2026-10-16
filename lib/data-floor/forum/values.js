export function vals(v){return Array.isArray(v)?v:[v];}
export function norm(v){return v==null?null:String(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();}
export function iso(v){if(v==null)return null;if(v instanceof Date&&!Number.isNaN(v.getTime()))return v.toISOString().slice(0,10);const s=String(v).trim();if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);const d=new Date(s);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);}
export function bounds(p){if(!/^\d{4}-\d{2}$/.test(String(p||'')))throw new Error('INVALID_FORUM_PERIOD');const [y,m]=p.split('-').map(Number);return {from:p+'-01',to:p+'-'+String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')};}
