'use strict';
// Web Serial port subset over WebUSB. Chrome on Android has no USB Web Serial
// on most devices, but it has WebUSB, so the viewer and installer drive the
// USB serial chips directly: CDC-ACM (ESP USB Serial/JTAG, CH9102/CH343,
// TinyUSB), Silicon Labs CP210x, WCH CH340/CH341 and FTDI.
const USB_SERIAL_VENDORS={ESPRESSIF:0x303a,SILABS:0x10c4,WCH:0x1a86,FTDI:0x0403};
const USB_SERIAL_FILTERS=[...Object.values(USB_SERIAL_VENDORS).map(vendorId=>({vendorId})),{classCode:2}];
// Android before 9 limits one USB request to 16 KiB.
const USB_TRANSFER_SIZE=16384,USB_TRANSFERS_IN_FLIGHT=4;
function usbError(name,message){return typeof DOMException==='function'?new DOMException(message,name):Object.assign(Error(message),{name});}
function usbInterfaces(device){return (device.configuration||device.configurations?.[0])?.interfaces||[];}
function bulkAlternate(iface,interfaceClass){
 return iface.alternates.find(a=>(interfaceClass===undefined||a.interfaceClass===interfaceClass)&&
  a.endpoints.some(e=>e.type==='bulk'&&e.direction==='in')&&a.endpoints.some(e=>e.type==='bulk'&&e.direction==='out'));
}
async function usbCheck(promise,what){const r=await promise;if(r.status!=='ok')throw usbError('NetworkError',`USB ${what} failed (${r.status}).`);return r;}

// Shared bulk transport for one claimed interface. Drivers add control requests.
class UsbBulkDriver {
 constructor(device,iface,alternate){this.device=device;this.iface=iface;this.alternate=alternate;
  this.in=alternate.endpoints.find(e=>e.type==='bulk'&&e.direction==='in');
  this.out=alternate.endpoints.find(e=>e.type==='bulk'&&e.direction==='out');this.claimed=[];this.breakState=false;}
 async claim(iface,alternate){
  if(!iface.claimed)await this.device.claimInterface(iface.interfaceNumber);
  this.claimed.push(iface.interfaceNumber);
  if(alternate&&alternate.alternateSetting!==iface.alternate?.alternateSetting)
   await this.device.selectAlternateInterface(iface.interfaceNumber,alternate.alternateSetting);
 }
 async open(){await this.claim(this.iface,this.alternate);}
 async read(){
  const r=await this.device.transferIn(this.in.endpointNumber,USB_TRANSFER_SIZE);
  if(r.status==='stall'){await this.device.clearHalt('in',this.in.endpointNumber);return new Uint8Array(0);}
  if(r.status!=='ok'||!r.data)return new Uint8Array(0);
  return this.payload(new Uint8Array(r.data.buffer,r.data.byteOffset,r.data.byteLength));
 }
 payload(bytes){return bytes.slice();}
 async write(chunk){
  const bytes=ArrayBuffer.isView(chunk)?new Uint8Array(chunk.buffer,chunk.byteOffset,chunk.byteLength):new Uint8Array(chunk);
  for(let i=0;i<bytes.length;i+=USB_TRANSFER_SIZE){
   const r=await this.device.transferOut(this.out.endpointNumber,bytes.subarray(i,i+USB_TRANSFER_SIZE));
   if(r.status==='stall'){await this.device.clearHalt('out',this.out.endpointNumber);throw usbError('NetworkError','USB write stalled.');}
  }
 }
 async close(){for(const n of this.claimed.splice(0))await this.device.releaseInterface(n).catch(()=>{});}
}

// USB CDC-ACM: SET_LINE_CODING / SET_CONTROL_LINE_STATE / SEND_BREAK.
class CdcAcmDriver extends UsbBulkDriver {
 constructor(device,data,alternate,control){super(device,data,alternate);this.control=control;}
 async open(){if(this.control)await this.claim(this.control);await super.open();}
 request(request,value,data){
  return usbCheck(this.device.controlTransferOut({requestType:'class',recipient:'interface',request,value,
   index:(this.control||this.iface).interfaceNumber},data),'CDC request');
 }
 async configure({baudRate,dataBits,stopBits,parity}){
  const coding=new DataView(new ArrayBuffer(7));
  coding.setUint32(0,baudRate,true);coding.setUint8(4,stopBits===2?2:0);
  coding.setUint8(5,['none','odd','even'].indexOf(parity));coding.setUint8(6,dataBits);
  // Native USB ports ignore the line coding; some reject it, as Linux tolerates.
  try{await this.request(0x20,0,coding.buffer);}catch(e){if(!/stall/.test(e.message))throw e;}
 }
 async signals(s){
  await this.request(0x22,(s.dataTerminalReady?1:0)|(s.requestToSend?2:0));
  if(s.break!==this.breakState){this.breakState=s.break;await this.request(0x23,s.break?0xffff:0);}
 }
}

// Silicon Labs AN571 vendor requests addressed to the UART interface.
class Cp210xDriver extends UsbBulkDriver {
 request(request,value,data){
  return usbCheck(this.device.controlTransferOut({requestType:'vendor',recipient:'interface',request,value,
   index:this.iface.interfaceNumber},data),'CP210x request');
 }
 async open(){await super.open();await this.request(0x00,1);} // IFC_ENABLE
 async configure({baudRate,dataBits,stopBits,parity}){
  const baud=new DataView(new ArrayBuffer(4));baud.setUint32(0,baudRate,true);
  await this.request(0x1e,0,baud.buffer); // SET_BAUDRATE
  await this.request(0x03,(stopBits===2?2:0)|(['none','odd','even'].indexOf(parity)<<4)|(dataBits<<8)); // SET_LINE_CTL
 }
 async signals(s){
  await this.request(0x07,0x300|(s.dataTerminalReady?1:0)|(s.requestToSend?2:0)); // SET_MHS with both masks
  if(s.break!==this.breakState){this.breakState=s.break;await this.request(0x05,s.break?1:0);}
 }
}

// CH340/CH341 divisor, following the Linux ch341 driver.
function ch341Divisor(speed){
 const clock=48000000,clockDivisor=(ps,fact)=>1<<(12-3*ps-fact);
 speed=Math.min(Math.max(speed,Math.ceil(clock/(clockDivisor(0,0)*256))),clock/(clockDivisor(3,0)*2));
 let fact=1,ps=3;
 while(ps>=0&&speed<=Math.floor(clock/(clockDivisor(ps,1)*512)))ps--;
 if(ps<0)throw usbError('NotSupportedError',`CH340 cannot use ${speed} baud.`);
 let clk=clockDivisor(ps,fact),div=Math.floor(clock/(clk*speed));
 if(div<9||div>255){div=Math.floor(div/2);clk*=2;fact=0;}
 if(div<2)throw usbError('NotSupportedError',`CH340 cannot use ${speed} baud.`);
 if(Math.floor(16*clock/(clk*div))-16*speed>=16*speed-Math.floor(16*clock/(clk*(div+1))))div++;
 if(fact===1&&div%2===0){div/=2;fact=0;}
 return ((0x100-div)<<8)|(fact<<2)|ps;
}
class Ch34xDriver extends UsbBulkDriver {
 request(request,value,index){
  return usbCheck(this.device.controlTransferOut({requestType:'vendor',recipient:'device',request,value,index}),'CH340 request');
 }
 async open(){
  await super.open();
  const r=await usbCheck(this.device.controlTransferIn({requestType:'vendor',recipient:'device',request:0x5f,value:0,index:0},2),'CH340 version');
  this.version=r.data.getUint8(0);
  await this.request(0xa1,0,0); // SERIAL_INIT
 }
 async configure({baudRate,dataBits,stopBits,parity}){
  // Bit 7 stops older chips from holding data until a full packet arrives.
  await this.request(0x9a,0x1312,ch341Divisor(baudRate)|(this.version>0x27?0x80:0));
  await this.request(0x9a,0x2518,0xc0|(dataBits-5)|(stopBits===2?0x04:0)|({none:0,odd:0x08,even:0x18}[parity]));
 }
 // Modem control lines are active low. CH34x break needs register
 // read-modify-write and is not used by ESP tooling, so it is ignored.
 async signals(s){await this.request(0xa4,~((s.dataTerminalReady?0x20:0)|(s.requestToSend?0x40:0))&0xffff,0);}
}

// FTDI divisor for the 3 MHz (x8 fractional) baud generator shared by
// FT232R, FT231X and the H series in compatibility mode.
function ftdiDivisor(baudRate){
 let divisor,fraction=0;
 if(baudRate>3500000)throw usbError('NotSupportedError',`FTDI cannot use ${baudRate} baud.`);
 if(baudRate>=2500000)divisor=0; // 3 MBaud
 else if(baudRate>=1750000)divisor=1; // 2 MBaud
 else{
  const eighths=(Math.floor(48000000/baudRate)+1)>>1;fraction=eighths&7;divisor=eighths>>3;
  if(divisor>0x3fff)throw usbError('NotSupportedError',`FTDI cannot use ${baudRate} baud.`);
 }
 const code=[0,3,2,4,1,5,6,7][fraction];
 return {value:divisor|((code&3)<<14),index:code>>2};
}
class FtdiDriver extends UsbBulkDriver {
 constructor(device,iface,alternate,channel){super(device,iface,alternate);this.channel=channel;}
 request(request,value,index=this.channel){
  return usbCheck(this.device.controlTransferOut({requestType:'vendor',recipient:'device',request,value,index}),'FTDI request');
 }
 async open(){
  await super.open();
  await this.request(0x00,0); // SIO_RESET
  await this.request(0x09,4); // latency timer: return short replies within 4 ms
  await this.request(0x02,0); // no flow control
 }
 async configure({baudRate,dataBits,stopBits,parity}){
  const d=ftdiDivisor(baudRate);
  await this.request(0x03,d.value,this.channel?(d.index<<8)|this.channel:d.index);
  this.line=dataBits|(['none','odd','even'].indexOf(parity)<<8)|((stopBits===2?2:0)<<11);
  await this.request(0x04,this.line|(this.breakState?0x4000:0));
 }
 async signals(s){
  await this.request(0x01,0x300|(s.dataTerminalReady?1:0)|(s.requestToSend?2:0));
  if(s.break!==this.breakState){this.breakState=s.break;await this.request(0x04,this.line|(s.break?0x4000:0));}
 }
 // Every USB packet starts with two modem status bytes.
 payload(bytes){
  const size=this.in.packetSize,out=new Uint8Array(Math.max(0,bytes.length-2*Math.ceil(bytes.length/size)));
  for(let i=0,o=0;i<bytes.length;i+=size){const part=bytes.subarray(i+2,i+size);out.set(part,o);o+=part.length;}
  return out;
 }
}

function usbSerialDriver(device){
 const interfaces=usbInterfaces(device),vendor=device.vendorId;
 if(vendor===USB_SERIAL_VENDORS.FTDI){
  // Dual-channel ESP-Prog and devkit bridges use channel A for JTAG and B for UART.
  const iface=interfaces.length>1?interfaces[1]:interfaces[0],alternate=iface&&bulkAlternate(iface);
  if(alternate)return new FtdiDriver(device,iface,alternate,interfaces.length>1?iface.interfaceNumber+1:0);
 }
 const data=interfaces.find(i=>bulkAlternate(i,10));
 if(data)return new CdcAcmDriver(device,data,bulkAlternate(data,10),interfaces.find(i=>i.alternates.some(a=>a.interfaceClass===2)));
 const vendorIface=interfaces.find(i=>bulkAlternate(i,0xff));
 if(vendorIface&&vendor===USB_SERIAL_VENDORS.SILABS)return new Cp210xDriver(device,vendorIface,bulkAlternate(vendorIface,0xff));
 if(vendorIface&&vendor===USB_SERIAL_VENDORS.WCH)return new Ch34xDriver(device,vendorIface,bulkAlternate(vendorIface,0xff));
 return null;
}

class UsbSerialPort {
 constructor(device){
  this.device=device;this.state='closed';this.session=0;this.fatal=null;
  this.signalState={dataTerminalReady:false,requestToSend:false,break:false};
  this.queue=[];this.queued=0;this.waiters=[];this.drain=null;
  this.readableStream=this.writableStream=this.readController=this.writeController=null;
 }
 getInfo(){return {usbVendorId:this.device.vendorId,usbProductId:this.device.productId};}
 get connected(){return !this.fatal;}
 get readable(){
  if(!this.readableStream&&this.state==='opened'&&!this.fatal){
   const stream=new ReadableStream({
    start:c=>{this.readController=c;},
    pull:async c=>{
     for(;;){
      if(this.readableStream!==stream)return;
      if(this.queue.length){const b=this.queue.shift();this.queued-=b.length;this.drain?.();c.enqueue(b);return;}
      if(this.fatal){this.readableStream=null;c.error(this.fatal);return;}
      await new Promise(resolve=>this.waiters.push(resolve));
     }
    },
    cancel:()=>{if(this.readableStream===stream)this.readableStream=null;}
   },{highWaterMark:0}); // pull only for a pending read, so cancel never drops queued data
   this.readableStream=stream;
  }
  return this.readableStream;
 }
 get writable(){
  if(!this.writableStream&&this.state==='opened'&&!this.fatal){
   const release=()=>{if(this.writableStream===stream)this.writableStream=null;};
   const stream=new WritableStream({
    start:c=>{this.writeController=c;},
    write:async chunk=>{try{await this.driver.write(chunk);}catch(e){release();throw e;}},
    close:release,abort:release
   });
   this.writableStream=stream;
  }
  return this.writableStream;
 }
 wake(){for(const resolve of this.waiters.splice(0))resolve();}
 // Keep several IN transfers queued so high baud rates do not overrun the chip.
 async pump(session){
  const inflight=[],limit=Math.max(this.bufferSize,65536);
  try{
   while(session===this.session&&!this.fatal){
    while(inflight.length<USB_TRANSFERS_IN_FLIGHT&&this.queued<limit){
     const p=this.driver.read();p.catch(()=>{});inflight.push(p);
    }
    if(!inflight.length){await new Promise(resolve=>this.drain=resolve);this.drain=null;continue;}
    const bytes=await inflight.shift();
    if(session!==this.session)return;
    if(bytes.length){this.queue.push(bytes);this.queued+=bytes.length;this.wake();}
   }
  }catch(e){if(session===this.session)this.lost(e);}
 }
 lost(e=usbError('NetworkError','The device has been lost.')){
  if(this.fatal)return;
  this.fatal=e;this.wake();this.drain?.();
  if(!this.queue.length&&this.readableStream){this.readController.error(e);this.readableStream=null;}
  if(this.writableStream){this.writeController.error(e);this.writableStream=null;}
 }
 async open(options={}){
  if(this.state!=='closed')throw usbError('InvalidStateError','The port is already open.');
  const baudRate=Number(options.baudRate);
  if(!(baudRate>0))throw TypeError('A positive baudRate is required.');
  this.state='opening';
  try{
   if(!this.device.opened)await this.device.open();
   if(!this.device.configuration)await this.device.selectConfiguration(1);
   this.driver=usbSerialDriver(this.device);
   if(!this.driver)throw usbError('NotSupportedError','This USB device is not a supported serial adapter.');
   await this.driver.open();
   this.line={baudRate,dataBits:options.dataBits||8,stopBits:options.stopBits||1,parity:options.parity||'none'};
   await this.driver.configure(this.line);
   await this.driver.signals(this.signalState);
  }catch(e){
   await this.driver?.close().catch(()=>{});await this.device.close().catch(()=>{});
   this.state='closed';this.driver=null;
   if(e?.name==='SecurityError'||e?.name==='NetworkError')
    throw usbError(e.name,`${e.message} Another app may be using this USB device; close it or unplug and reconnect the board.`);
   throw e;
  }
  this.bufferSize=options.bufferSize||255;this.fatal=null;this.queue=[];this.queued=0;this.state='opened';
  this.pump(++this.session);
 }
 // esptool-js changes the rate in place instead of reopening when available.
 async setBaudRate(baudRate){
  if(this.state!=='opened')throw usbError('InvalidStateError','The port is not open.');
  await this.driver.configure({...this.line,baudRate});this.line.baudRate=baudRate;
 }
 async setSignals(signals={}){
  if(this.state!=='opened')throw usbError('InvalidStateError','The port is not open.');
  for(const k of ['dataTerminalReady','requestToSend','break'])if(signals[k]!==undefined)this.signalState[k]=!!signals[k];
  await this.driver.signals(this.signalState);
 }
 async getSignals(){
  if(this.state!=='opened')throw usbError('InvalidStateError','The port is not open.');
  return {dataCarrierDetect:false,clearToSend:false,ringIndicator:false,dataSetReady:false};
 }
 async close(){
  if(this.state!=='opened')return;
  this.state='closing';this.session++;
  const closed=usbError('AbortError','The port was closed.');
  if(this.readableStream){this.readController.error(closed);this.readableStream=null;}
  if(this.writableStream){this.writeController.error(closed);this.writableStream=null;}
  this.queue=[];this.queued=0;this.wake();this.drain?.();
  await this.driver.close().catch(()=>{});await this.device.close().catch(()=>{});
  this.driver=null;this.state='closed';
 }
 async forget(){await this.close();await this.device.forget?.();}
}

// navigator.serial lookalike: requestPort, getPorts and connect/disconnect events.
class UsbSerial {
 constructor(usb){
  this.usb=usb;this.ports=new Map();this.listeners={connect:new Set(),disconnect:new Set()};
  usb.addEventListener?.('connect',e=>{if(this.supported(e.device))this.emit('connect',this.port(e.device));});
  usb.addEventListener?.('disconnect',e=>{const p=this.ports.get(e.device);if(p){p.lost();this.ports.delete(e.device);this.emit('disconnect',p);}});
 }
 supported(device){return Object.values(USB_SERIAL_VENDORS).includes(device.vendorId)||usbInterfaces(device).some(i=>bulkAlternate(i,10));}
 port(device){let p=this.ports.get(device);if(!p)this.ports.set(device,p=new UsbSerialPort(device));return p;}
 emit(type,target){for(const f of this.listeners[type])f({type,target});}
 addEventListener(type,f){this.listeners[type]?.add(f);}
 removeEventListener(type,f){this.listeners[type]?.delete(f);}
 async requestPort({filters}={}){
  const usbFilters=filters?.length?filters.map(f=>({vendorId:f.usbVendorId,...(f.usbProductId!==undefined&&{productId:f.usbProductId})})):USB_SERIAL_FILTERS;
  return this.port(await this.usb.requestDevice({filters:usbFilters}));
 }
 async getPorts(){return (await this.usb.getDevices()).filter(d=>this.supported(d)).map(d=>this.port(d));}
}

// Android Chrome exposes navigator.serial for Bluetooth, and USB only on a few
// devices, so prefer WebUSB there. Elsewhere the OS serial driver owns the
// device and WebUSB cannot claim it, so use Web Serial.
let usbSerial=null;
function serialApi(nav=globalThis.navigator){
 if(!nav)return null;
 const android=nav.userAgentData?.platform==='Android'||/Android/i.test(nav.userAgent||'');
 if(nav.usb&&(android||!nav.serial)){
  if(usbSerial?.usb!==nav.usb)usbSerial=new UsbSerial(nav.usb);
  return usbSerial;
 }
 return nav.serial||null;
}
