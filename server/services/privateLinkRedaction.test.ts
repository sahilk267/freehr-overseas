import {detectOptOut} from "./hostingerMail";
import {describe,it,expect} from 'vitest';
import {redactAvailabilityLinks} from './privateLinkRedaction';
import {normalizeHostingerMailEvent} from './hostingerWebhook';
const id='avi_synthetic',token='A'.repeat(43),url='https://example.test/availability#'+id+'.'+token;
describe('private link quote redaction',()=>{
 it('redacts repeated raw fragments without changing ordinary mail text',()=>{const text=`Available tomorrow. ${url}\nQuoted: ${url}`;expect(redactAvailabilityLinks(text)).not.toContain(token);expect(redactAvailabilityLinks('Available tomorrow.')).toBe('Available tomorrow.');});
 it('recognizes URL/HTML escaped fragment delimiters',()=>{for(const fragment of ['%23','&#35;'])expect(redactAvailabilityLinks('https://example.test/availability'+fragment+id+'.'+token)).not.toContain(token);});
 it('normalizes provider text and subject without retaining quoted capabilities',()=>{const event=normalizeHostingerMailEvent({event:'message.received',data:{message:{id:'synthetic-provider',from:'synthetic@example.test',subject:url,text:'My reply '+url}}});expect(event?.subject).not.toContain(token);expect(event?.text).toContain('My reply');expect(event?.text).not.toContain(token);});
 it('prevents random quoted capability text from becoming an opt-out instruction',()=>{const secret='-STOP-'+'A'.repeat(37),text='Available tomorrow. https://example.test/availability#avi_synthetic.'+secret;expect(detectOptOut(redactAvailabilityLinks(text))).toBe(false);});

});
