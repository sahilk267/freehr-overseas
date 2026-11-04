import {describe,it,expect} from 'vitest';
import {commonAvailability} from './availability';
import {zonedDateTimeToUtc} from '../../shared/dateTime';
const at=(hour:number,minute=0)=>new Date(Date.UTC(2030,0,7,hour,minute));
const window=(a:number,b:number)=>({start:at(a),end:at(b)});
const base={candidate:[window(9,13)],interviewer:[window(10,14)],durationMinutes:45,bufferMinutes:15,now:at(0)};
describe('bounded participant availability proposals',()=>{
 it('intersects both participants with non-overlapping buffered proposals',()=>{const r=commonAvailability(base);expect(r.slots.map(s=>s.start)).toEqual([at(10),at(11),at(12)]);expect(r.reservation).toBe(false);expect(r.participantAcceptance).toBe(false);});
 it('returns no slots for disjoint availability',()=>{expect(commonAvailability({...base,interviewer:[window(14,16)]}).slots).toEqual([]);});
 it('normalizes duplicate and overlapping windows without duplicate slots',()=>{expect(commonAvailability({...base,candidate:[window(9,12),window(10,13),window(9,12)]}).slots).toEqual(commonAvailability(base).slots);});
 it('excludes busy periods including buffer on either edge',()=>{const r=commonAvailability({...base,busy:[{start:at(10,45),end:at(11,15)}]});expect(r.slots[0].start).toEqual(at(11,30));});
 it('allows exact busy-buffer boundary contact',()=>{const r=commonAvailability({...base,busy:[window(9,10)]});expect(r.slots[0].start).toEqual(at(10,15));});
 it('does not generate past or partially expired slots',()=>{expect(commonAvailability({...base,now:at(11,2)}).slots[0].start).toEqual(at(11,5));});
 it('caps results at ten and respects split windows',()=>{const r=commonAvailability({...base,candidate:[window(0,24)],interviewer:[window(0,24)],durationMinutes:15,bufferMinutes:0});expect(r.slots).toHaveLength(10);const split=commonAvailability({...base,candidate:[window(9,11),window(12,13)]});expect(split.slots.map(s=>s.start)).toEqual([at(10),at(12)]);});
 it('rejects invalid ranges, duration, buffer and excessive horizon',()=>{for(const patch of [{candidate:[]},{candidate:[window(12,9)]},{durationMinutes:0},{bufferMinutes:-1},{candidate:[{start:at(0),end:new Date(at(0).getTime()+32*86400000)}]},{busy:[{start:new Date('bad'),end:at(12)}]}])expect(()=>commonAvailability({...base,...patch})).toThrow();});
 it('supports separately converted participant timezones and refuses ambiguous DST times',()=>{const r=commonAvailability({...base,candidate:[{start:zonedDateTimeToUtc('2030-01-07T15:30','Asia/Kolkata'),end:zonedDateTimeToUtc('2030-01-07T18:30','Asia/Kolkata')}],interviewer:[{start:zonedDateTimeToUtc('2030-01-07T10:00','UTC'),end:zonedDateTimeToUtc('2030-01-07T13:00','UTC')}]});expect(r.slots[0].start).toEqual(at(10));expect(()=>zonedDateTimeToUtc('2026-11-01T01:30','America/New_York')).toThrow(/ambiguous/);});
});
