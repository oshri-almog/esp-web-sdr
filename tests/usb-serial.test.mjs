import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../usb-serial.js',import.meta.url),'utf8');
const radioSource=await readFile(new URL('../radio.js',import.meta.url),'utf8');
function load(navigator={},extra={}){
 const c=vm.createContext({navigator,ReadableStream,WritableStream,DOMException,...extra});
 vm.runInContext(source,c);return {get:name=>vm.runInContext(name,c),context:c};
}
const bulk=(endpointNumber,direction,packetSize=64)=>({endpointNumber,direction,type:'bulk',packetSize});
function iface(interfaceNumber,interfaceClass,endpoints=[]){
 const alternate={alternateSetting:0,interfaceClass,endpoints};
 return {interfaceNumber,alternate,alternates:[alternate],claimed:false};
}
const espUsbJtag=()=>[iface(0,2),iface(1,10,[bulk(1,'out'),bulk(2,'in')]),iface(2,0xff,[bulk(3,'out'),bulk(3,'in')])];
const vendorBridge=(packetSize=64)=>[iface(0,0xff,[bulk(2,'in',packetSize),bulk(2,'out',packetSize)])];
function mockDevice(vendorId,productId,interfaces,{version=0x31,onWrite}={}){
 const log=[],inbox=[],waiting=[];
 const d={vendorId,productId,opened:false,configuration:null,configurations:[{interfaces}],log,
  open:async()=>{d.opened=true;log.push('open');},
  close:async()=>{d.opened=false;log.push('close');for(const w of waiting.splice(0))w.reject(new DOMException('closed','AbortError'));},
  selectConfiguration:async()=>{d.configuration=d.configurations[0];},
  claimInterface:async n=>{interfaces.find(i=>i.interfaceNumber===n).claimed=true;log.push(`claim ${n}`);},
  releaseInterface:async n=>{interfaces.find(i=>i.interfaceNumber===n).claimed=false;log.push(`release ${n}`);},
  controlTransferOut:async(setup,data)=>{log.push({...setup,...(data&&{data:[...new Uint8Array(data)]})});return {status:'ok'};},
  controlTransferIn:async setup=>{log.push({...setup});return {status:'ok',data:new DataView(new Uint8Array([version,0]).buffer)};},
  transferIn:()=>new Promise((resolve,reject)=>{if(inbox.length)inbox.shift()(resolve,reject);else waiting.push({resolve,reject});}),
  transferOut:async(endpoint,data)=>{const bytes=[...data];log.push({endpoint,bytes});onWrite?.(bytes);return {status:'ok',bytesWritten:bytes.length};},
  receive(bytes){const deliver=resolve=>resolve({status:'ok',data:new DataView(Uint8Array.from(bytes).buffer)});
   const w=waiting.shift();if(w)deliver(w.resolve);else inbox.push(deliver);},
  fail(e){const w=waiting.shift();if(w)w.reject(e);else inbox.push((_,reject)=>reject(e));}
 };
 return d;
}
const controls=d=>d.log.filter(e=>typeof e==='object'&&'request' in e).map(({requestType,recipient,request,value,index,data})=>
 [requestType,recipient,request,value,index,...(data?[data]:[])]);
async function openPort(device,options={baudRate:2000000}){
 const {get}=load();const port=new (get('UsbSerialPort'))(device);await port.open(options);return {port,get};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('Android Chrome uses WebUSB even when Web Serial exists; desktop keeps Web Serial',()=>{
 const usb={addEventListener(){}},serial={};
 const {get}=load();const serialApi=get('serialApi'),UsbSerial=get('UsbSerial');
 assert.ok(serialApi({usb,serial,userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/149'}) instanceof UsbSerial);
 assert.ok(serialApi({usb,serial,userAgentData:{platform:'Android'},userAgent:''}) instanceof UsbSerial);
 assert.ok(serialApi({usb,userAgent:'Mozilla/5.0 (X11; Linux x86_64)'}) instanceof UsbSerial);
 assert.equal(serialApi({usb,serial,userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}),serial);
 assert.equal(serialApi({serial,userAgent:'Android'}),serial);
 assert.equal(serialApi({userAgent:'Android'}),null);
 const nav={usb,userAgent:'Android'};assert.equal(serialApi(nav),serialApi(nav));
});

test('ESP USB Serial/JTAG opens as CDC-ACM and drives DTR/RTS atomically',async()=>{
 const d=mockDevice(0x303a,0x1001,espUsbJtag());const {port}=await openPort(d);
 assert.deepEqual(d.log.slice(0,3),['open','claim 0','claim 1']);
 assert.deepEqual({...port.getInfo()},{usbVendorId:0x303a,usbProductId:0x1001});
 await port.setSignals({requestToSend:true});await port.setSignals({dataTerminalReady:true});
 await port.setSignals({requestToSend:false});
 assert.deepEqual(controls(d),[
  ['class','interface',0x20,0,0,[0x80,0x84,0x1e,0,0,0,8]],['class','interface',0x22,0,0],
  ['class','interface',0x22,2,0],['class','interface',0x22,3,0],['class','interface',0x22,1,0]]);
 const writer=port.writable.getWriter();await writer.write(new TextEncoder().encode('INFO\n'));writer.releaseLock();
 assert.deepEqual(d.log.at(-1),{endpoint:1,bytes:[...new TextEncoder().encode('INFO\n')]});
 await port.close();
 assert.deepEqual(d.log.slice(-3),['release 0','release 1','close']);
 assert.equal(port.readable,null);assert.equal(port.writable,null);
});

test('received data stays in order across a cancelled reader and is not lost',async()=>{
 const d=mockDevice(0x303a,0x1001,espUsbJtag());const {port}=await openPort(d);
 const first=port.readable;let reader=first.getReader();
 d.receive([1,2]);d.receive([]);d.receive([3]);
 assert.deepEqual([...(await reader.read()).value],[1,2]);
 assert.deepEqual([...(await reader.read()).value],[3]);
 const pending=reader.read();await reader.cancel();assert.equal((await pending).done,true);reader.releaseLock();
 d.receive([4,5]);await tick();
 assert.notEqual(port.readable,first);reader=port.readable.getReader();
 assert.deepEqual([...(await reader.read()).value],[4,5]);
 reader.releaseLock();await port.close();
 await port.open({baudRate:115200});
 assert.deepEqual(controls(d).at(-2),['class','interface',0x20,0,0,[0x00,0xc2,0x01,0,0,0,8]]);
 await port.close();
});

test('data received before a cancel is kept for the next reader',async()=>{
 const d=mockDevice(0x303a,0x1001,espUsbJtag());const {port}=await openPort(d);
 let reader=port.readable.getReader();
 d.receive([1,2]);d.receive([3]);
 assert.deepEqual([...(await reader.read()).value],[1,2]);
 await tick();await tick();await reader.cancel();reader.releaseLock();
 d.receive([4]);await tick();
 reader=port.readable.getReader();
 assert.deepEqual([...(await reader.read()).value],[3]);
 assert.deepEqual([...(await reader.read()).value],[4]);
 reader.releaseLock();await port.close();
});

test('a lost device errors the reader and no new streams are offered',async()=>{
 const d=mockDevice(0x303a,0x1001,espUsbJtag());const {port}=await openPort(d);
 const reader=port.readable.getReader();d.receive([7]);
 assert.deepEqual([...(await reader.read()).value],[7]);
 d.fail(new DOMException('The device was disconnected.','NetworkError'));
 await assert.rejects(reader.read(),/disconnected/);
 assert.equal(port.readable,null);assert.equal(port.writable,null);
 reader.releaseLock();await port.close();assert.equal(d.opened,false);
});

test('CP210x uses AN571 interface requests',async()=>{
 const d=mockDevice(0x10c4,0xea60,vendorBridge());const {port}=await openPort(d);
 await port.setSignals({dataTerminalReady:false,requestToSend:true});
 assert.deepEqual(controls(d),[
  ['vendor','interface',0x00,1,0],['vendor','interface',0x1e,0,0,[0x80,0x84,0x1e,0]],['vendor','interface',0x03,0x800,0],
  ['vendor','interface',0x07,0x300,0],['vendor','interface',0x07,0x302,0]]);
 await port.close();
});

test('CH340 follows the Linux ch341 initialization and divisor',async()=>{
 const {get}=load();const divisor=get('ch341Divisor');
 assert.deepEqual([9600,115200,1000000,2000000].map(divisor),[0xb202,0xcc03,0xfa03,0xfd03]);
 const d=mockDevice(0x1a86,0x7523,vendorBridge(32));const {port}=await openPort(d);
 await port.setSignals({requestToSend:true});
 assert.deepEqual(controls(d),[
  ['vendor','device',0x5f,0,0],['vendor','device',0xa1,0,0],['vendor','device',0x9a,0x1312,0xfd83],
  ['vendor','device',0x9a,0x2518,0xc3],['vendor','device',0xa4,0xffff,0],['vendor','device',0xa4,0xffbf,0]]);
 await port.close();
 const old=mockDevice(0x1a86,0x7523,vendorBridge(32),{version:0x27});await (await openPort(old)).port.close();
 assert.deepEqual(controls(old)[2],['vendor','device',0x9a,0x1312,0xfd03]);
});

test('CH9102 and other CDC-class WCH bridges use CDC-ACM',async()=>{
 const d=mockDevice(0x1a86,0x55d4,[iface(0,2),iface(1,10,[bulk(2,'out',32),bulk(2,'in',32)])]);
 const {port}=await openPort(d);
 assert.equal(controls(d)[0][2],0x20);await port.close();
});

test('FTDI divisors and modem status stripping',async()=>{
 const {get}=load();const divisor=get('ftdiDivisor');
 assert.deepEqual([3000000,2000000,921600,115200].map(b=>({...divisor(b)})),
  [{value:0,index:0},{value:1,index:0},{value:0x8003,index:0},{value:26,index:0}]);
 const d=mockDevice(0x0403,0x6001,vendorBridge());const {port}=await openPort(d);
 assert.deepEqual(controls(d),[
  ['vendor','device',0,0,0],['vendor','device',9,4,0],['vendor','device',2,0,0],
  ['vendor','device',3,1,0],['vendor','device',4,8,0],['vendor','device',1,0x300,0]]);
 const reader=port.readable.getReader();
 d.receive([0x01,0x60]);
 d.receive([0x01,0x60,...Array.from({length:62},(_,i)=>i),0x01,0x60,100,101,102]);
 const {value}=await reader.read();
 assert.deepEqual([...value],[...Array.from({length:62},(_,i)=>i),100,101,102]);
 reader.releaseLock();await port.close();
});

test('dual-channel FTDI bridges use channel B for the UART',async()=>{
 const d=mockDevice(0x0403,0x6010,[iface(0,0xff,[bulk(1,'in',512),bulk(2,'out',512)]),iface(1,0xff,[bulk(3,'in',512),bulk(4,'out',512)])]);
 const {port}=await openPort(d);
 assert.equal(d.log[1],'claim 1');
 assert.deepEqual(controls(d)[3],['vendor','device',3,1,2]);
 await port.close();
});

test('port list contains only supported adapters and keeps port identity',async()=>{
 const devices=[mockDevice(0x303a,0x1001,espUsbJtag()),mockDevice(0x046d,0xc52b,[iface(0,3)]),mockDevice(0x2e8a,0x000a,[iface(0,2),iface(1,10,[bulk(1,'out'),bulk(2,'in')])])];
 const listeners={},requests=[];
 const usb={getDevices:async()=>devices,requestDevice:async o=>{requests.push(o);return devices[0];},addEventListener:(t,f)=>listeners[t]=f};
 const {get}=load();const serial=get('serialApi')({usb,userAgent:'Android'});
 const ports=await serial.getPorts();
 assert.equal(ports.length,2);assert.equal((await serial.getPorts())[0],ports[0]);
 assert.equal(await serial.requestPort(),ports[0]);
 assert.ok(requests[0].filters.some(f=>f.vendorId===0x10c4)&&requests[0].filters.some(f=>f.classCode===2));
 const events=[];serial.addEventListener('connect',e=>events.push(e.target));
 listeners.connect({device:devices[1]});listeners.connect({device:devices[0]});
 assert.deepEqual(events,[ports[0]]);
});

test('the SDR driver synchronizes over a WebUSB port',async()=>{
 const enc=new TextEncoder();let d;
 d=mockDevice(0x303a,0x1001,espUsbJtag(),{onWrite:bytes=>{
  for(const line of new TextDecoder().decode(Uint8Array.from(bytes)).split('\n'))
   if(line.startsWith('SYNC '))setImmediate(()=>{d.receive([...enc.encode('boot log\n')]);d.receive([...enc.encode(line+'\n')]);});
 }});
 const {context}=load({},{performance,setTimeout,clearTimeout,isSecureContext:true,TextEncoder});
 vm.runInContext(radioSource,context);const radio=vm.runInContext('radio',context);
 const port=new (vm.runInContext('UsbSerialPort',context))(d);
 await radio.connectPort(port,2000000);
 await radio.closePort();
 assert.equal(d.opened,false);assert.equal(port.state,'closed');
});

test('esptool-js transport reads, changes baud in place and disconnects over WebUSB',async()=>{
 const {Transport}=await import('../flasher/vendor/esptool-js-0.7.0.js');
 const d=mockDevice(0x10c4,0xea60,vendorBridge());
 const {get}=load();const port=new (get('UsbSerialPort'))(d);
 const transport=new Transport(port,false);
 await transport.connect(115200);transport.readLoop();
 await transport.write(Uint8Array.of(1,2));
 assert.deepEqual(d.log.at(-1),{endpoint:2,bytes:[0xc0,1,2,0xc0]});
 d.receive([0xc0,0x01,0x08,0xc0]);
 assert.deepEqual([...await transport.read(1000)],[0x01,0x08]);
 await transport.changeBaudrate(2000000);
 assert.deepEqual(controls(d).filter(c=>c[2]===0x1e).map(c=>c[5]),[[0x00,0xc2,0x01,0],[0x80,0x84,0x1e,0]]);
 assert.equal(d.log.filter(e=>e==='open').length,1);
 await transport.disconnect();
 assert.equal(d.opened,false);assert.equal(port.readable,null);
});
