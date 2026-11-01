import { readFile, lstat, open, writeFile, rename, rm } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { AccountApi, Configuration } from 'hostinger-mail-api-sdk';
const purposes = ['owner','clients','talent','interviews','finance','privacy'];
const placeholder = value => !value?.trim() || /^(?:replace[_ -]|your[_ -]|dummy(?:[_ -]|$)|<)/i.test(value.trim());
export function resolveMailboxIds(values, mailboxes) {
  if (!Array.isArray(mailboxes)) throw Error('Provider did not return a mailbox list. No file was changed.');
  return Object.fromEntries(purposes.map(purpose => {
    const upper = purpose.toUpperCase(), key = `HOSTINGER_MAILBOX_${upper}_ID`;
    const address = (values[`${upper}_MAILBOX`] || values[`HOSTINGER_MAILBOX_${upper}_ADDRESS`] || '').trim().toLowerCase();
    if (!address || !address.endsWith('@'+(values.HOSTINGER_MAIL_FROM_DOMAIN || 'overseasjob.in').trim().toLowerCase())) throw Error(`Configure the approved ${purpose} mailbox address first.`);
    const matches = mailboxes.filter(m => typeof m.address === 'string' && m.address.trim().toLowerCase() === address);
    if (matches.length !== 1 || typeof matches[0].resourceId !== 'string' || placeholder(matches[0].resourceId) || /[\r\n@]/.test(matches[0].resourceId) || matches[0].resourceId.length > 255) throw Error(`Provider returned no unique authorized ${purpose} mailbox. No file was changed.`);
    const id = matches[0].resourceId;
    if (!placeholder(values[key]) && values[key] !== id) throw Error(`${key} conflicts with the provider. Review before replacing it.`);
    return [key,id];
  }));
}
async function main() {
  const file = fileURLToPath(new URL('../.env.hostinger', import.meta.url));
  if ((await lstat(file)).isSymbolicLink()) throw Error('Refuse a symlink environment file.');
  const lock = await open(file+'.lock','wx',0o600), temporary = file+'.'+randomUUID()+'.tmp';
  try {
    const original = await readFile(file,'utf8'), values = parse(original);
    if (placeholder(values.HOSTINGER_MAIL_API_TOKEN)) throw Error('Replace HOSTINGER_MAIL_API_TOKEN in private .env.hostinger first.');
    let response;
    try { response = await new AccountApi(new Configuration({accessToken:values.HOSTINGER_MAIL_API_TOKEN})).getCurrentAccount({timeout:30000}); }
    catch { throw Error('Mail account lookup failed. Check the real Mail API token and network access; no file was changed.'); }
    const ids = resolveMailboxIds(values,response.data?.data?.mailboxes);
    let updated = original;
    for (const [key,value] of Object.entries(ids)) {
      const line = key+'='+JSON.stringify(value), pattern = new RegExp('^'+key+'=.*$','m');
      updated = pattern.test(updated) ? updated.replace(pattern,()=>line) : updated+'\n'+line+'\n';
    }
    if (await readFile(file,'utf8') !== original) throw Error('Environment changed during lookup. Retry without concurrent edits.');
    await writeFile(temporary,updated,{mode:0o600,flag:'wx'}); await rename(temporary,file);
    console.log('Saved all six provider-verified mailbox IDs to private .env.hostinger. No messages sent; live hosting environment was not changed.');
  } finally { await lock.close(); await rm(file+'.lock',{force:true}); await rm(temporary,{force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
