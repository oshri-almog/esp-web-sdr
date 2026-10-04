'use strict';
// Standard Wi-Fi channel centre frequencies used only for display annotation.
// This is not a regulatory or hardware-capability validator.

const TWO_POINT_FOUR_GHZ_CHANNELS=Object.freeze([
 ...Array.from({length:13},(_,index)=>({channel:index+1,frequencyMHz:2412+index*5,band:'2.4 GHz'})),
 {channel:14,frequencyMHz:2484,band:'2.4 GHz'},
]);
const FIVE_GHZ_CHANNELS=Object.freeze([
 36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165,169,173,177,
].map(channel=>({channel,frequencyMHz:5000+channel*5,band:'5 GHz'})));
const SIX_GHZ_CHANNELS=Object.freeze(
 Array.from({length:59},(_,index)=>1+index*4).map(channel=>({channel,frequencyMHz:5950+channel*5,band:'6 GHz'}))
);
const WIFI_CHANNELS=Object.freeze([...TWO_POINT_FOUR_GHZ_CHANNELS,...FIVE_GHZ_CHANNELS,...SIX_GHZ_CHANNELS]);
const CHANNEL_TOLERANCE_MHZ=.01;

function channelAt(frequencyMHz){
 if(!Number.isFinite(frequencyMHz))return null;
 return WIFI_CHANNELS.find(channel=>Math.abs(channel.frequencyMHz-frequencyMHz)<=CHANNEL_TOLERANCE_MHZ)||null;
}
function channelsInRange(startMHz,stopMHz){
 if(!Number.isFinite(startMHz)||!Number.isFinite(stopMHz))return [];
 const low=Math.min(startMHz,stopMHz),high=Math.max(startMHz,stopMHz);
 return WIFI_CHANNELS.filter(channel=>channel.frequencyMHz>=low&&channel.frequencyMHz<=high);
}
function formatChannels(channels){
 if(!channels.length)return '—';
 const groups=new Map();
 for(const channel of channels){const group=groups.get(channel.band)||[];group.push(channel);groups.set(channel.band,group);}
 return Array.from(groups,([band,group])=>{
  const numbers=group.map(channel=>channel.channel);
  if(numbers.length===1)return `CH ${numbers[0]} · ${band}`;
  if(numbers.length<=4)return `CH ${numbers.join(', ')} · ${band}`;
  return `CH ${numbers[0]}–${numbers[numbers.length-1]} · ${band}`;
 }).join(' / ');
}
function describe(centerMHz,startMHz,stopMHz){
 const exact=channelAt(centerMHz);
 return exact?formatChannels([exact]):formatChannels(channelsInRange(startMHz,stopMHz));
}

globalThis.espWebSdrWifiChannels=Object.freeze({channelAt,channelsInRange,describe});
