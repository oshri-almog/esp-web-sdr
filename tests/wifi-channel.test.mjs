import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const script=await readFile(path.resolve('wifi-channels.js'),'utf8');
const sandbox={};
sandbox.globalThis=sandbox;
vm.runInNewContext(script,sandbox,{filename:'wifi-channels.js'});
const wifi=sandbox.espWebSdrWifiChannels;

test('maps standard 2.4 GHz, 5 GHz, and 6 GHz centre frequencies to Wi-Fi channels',()=>{
 assert.equal(wifi.channelAt(2412).channel,1);
 assert.equal(wifi.channelAt(2412).band,'2.4 GHz');
 assert.equal(wifi.channelAt(2484).channel,14);
 assert.equal(wifi.channelAt(5180).channel,36);
 assert.equal(wifi.channelAt(5500).channel,100);
 assert.equal(wifi.channelAt(5955).channel,1);
 assert.equal(wifi.channelAt(5955).band,'6 GHz');
});

test('annotates exact centres and otherwise summarizes channels in the displayed span',()=>{
 assert.equal(wifi.describe(2412,2372,2452),'CH 1 · 2.4 GHz');
 assert.equal(wifi.describe(2430,2410,2420),'CH 1, 2 · 2.4 GHz');
 assert.equal(wifi.describe(5000,4900,5000),'—');
});

test('does not treat nearby non-centre frequencies as a Wi-Fi channel',()=>{
 assert.equal(wifi.channelAt(2412.1),null);
});
