import {useEffect,useState} from 'react';
/** Each fragment navigation starts a fresh response session, including links opened in the same tab. */
export function usePrivateCapability(){
 const [capability]=useState(()=>{const m=/^#([A-Za-z0-9_-]{4,36})\.([A-Za-z0-9_-]{43})$/.exec(window.location.hash);return m?{id:m[1],token:m[2]}:null;});
 useEffect(()=>{const changed=()=>{if(window.location.hash)window.location.reload();};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
 return capability;
}
