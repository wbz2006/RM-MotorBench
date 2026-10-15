// Serve motor_bench_host on 3001; playwright-cli run-code --filename this file.
async (page) => {
  page.setDefaultTimeout(5000);
  await page.setViewportSize({width:1280,height:1000});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.sentCommands = []; window.confirm = () => true;
    class TestSocket {
      constructor() {
        this.readyState = 1; window.testSocket = this;
        this.source = 0; this.channels = [0,1,2,3]; this.reverseMask = 0; this.maxRef = 3000; this.ready = true; this.autoConfirm = true;
        this.items = [0,1,2,3].map(channelId => ({channelId,online:true,enabled:false,ref:0,speed:0,torque:0,angle:0,temperature:25}));
        setTimeout(() => {
          this.onopen?.();
          this.emit('inventory',{items:[1,2,3,4].map(motorId=>({kind:2,canBus:1,motorId,outerLoop:2}))});
        },0);
      }
      emit(type,data) { this.onmessage?.({data:JSON.stringify({type,data})}); }
      report(result=0) {
        this.emit('controlReport',{result,source:this.source,channelId:this.source===1?0:255,
          online:true,switchRight:1,ready:this.ready,rocker:0,maxRef:this.source?this.maxRef:0,
          ...(this.source>=2?{channels:this.channels,reverseMask:this.reverseMask,lateral:0,yaw:0}:{}),
        });
      }
      send(text) {
        const cmd=JSON.parse(text);window.sentCommands.push(cmd);
        queueMicrotask(() => {
        if(cmd.type==='bind') this.emit('telemetry',{items:[this.items[cmd.channelId]]});
        if(cmd.type==='controlSource') {
          if(!this.autoConfirm) return;
          this.source=cmd.source;this.channels=cmd.channels??this.channels;
          this.maxRef=cmd.maxRef;this.reverseMask=cmd.reverseMask??0;
          this.items.forEach(item=>{item.enabled=false;item.ref=0;});this.report();
          this.emit('telemetry',{items:this.items});
        }
        if(cmd.type==='chassisEnable') {
          this.items.forEach((item,i)=>{item.enabled=cmd.enable;item.ref=cmd.enable?[1500,-1500,-1500,1500][i]:0;});
          this.emit('telemetry',{items:this.items});this.report();
        }
        if(cmd.type==='stopAll') {
          this.items.forEach(item=>{item.enabled=false;item.ref=0;});this.emit('telemetry',{items:this.items});this.report();
        }
        });
      }
    } window.WebSocket=TestSocket;
  });
  const equal=(a,b,m)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);};
  await page.goto('http://127.0.0.1:3001/');
  await page.locator('.channel[data-ch="3"]').waitFor();
  equal(await page.locator('#controlSource option[value="2"]').count(),1,'Mecanum mode missing');
  equal(await page.locator('#controlSource option[value="3"]').count(),1,'Omni mode missing');
  for (let i=0;i<4;i++) {
    const card=page.locator(`.channel[data-ch="${i}"]`);
    await card.locator('[data-role="motor"]').selectOption(String(i));
    await card.locator('[data-role="bind"]').click();
  }
  await page.locator('#controlSource').selectOption('2');
  equal(await page.locator('.channel[data-ch="0"] [data-role="enable"]').isDisabled(),true,'Unapplied chassis mode must block a web-mode start');
  for(let i=0;i<4;i++) await page.locator(`[data-wheel="${i}"]`).selectOption(String(i));
  await page.locator('[data-reverse="1"]').check();await page.locator('[data-reverse="3"]').check();
  await page.locator('#applySource').click();
  await page.waitForFunction(()=>window.sentCommands.some(c=>c.type==='controlSource'&&c.source===2));
  equal(await page.evaluate(()=>window.sentCommands.filter(c=>c.type==='controlSource').at(-1)),{
    type:'controlSource',source:2,channels:[0,1,2,3],reverseMask:10,maxRef:3000,
  },'Four-wheel mapping and direction request');
  for(let i=0;i<4;i++) equal(await page.locator(`.channel[data-ch="${i}"] [data-role="num"]`).isDisabled(),true,'Chassis mode blocks web setpoint');
  await page.locator('#chassisEnable').click();
  await page.waitForFunction(()=>document.querySelectorAll('.enable.on').length===4);
  equal(await page.evaluate(()=>window.sentCommands.filter(c=>c.type==='chassisEnable').at(-1)),{type:'chassisEnable',enable:true},'Atomic group enable');
  await page.locator('.channel[data-ch="2"] [data-role="enable"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.enable.on').length===0);
  equal(await page.evaluate(()=>window.sentCommands.filter(c=>c.type==='chassisEnable').at(-1)),{type:'chassisEnable',enable:false},'One wheel stop controls the whole chassis');

  await page.locator('[data-wheel="3"]').selectOption('2');
  equal(await page.locator('#chassisEnable').isDisabled(),true,'Editing a live chassis mapping blocks group start');
  const before=await page.evaluate(()=>window.sentCommands.filter(c=>c.type==='controlSource').length);
  await page.locator('#applySource').click();
  equal(await page.evaluate(()=>window.sentCommands.filter(c=>c.type==='controlSource').length),before,'Duplicate wheel rejected locally');
  await page.locator('[data-wheel="3"]').selectOption('3');
  await page.locator('#controlSource').selectOption('3');await page.locator('#applySource').click();
  equal(await page.evaluate(()=>window.sentCommands.filter(c=>c.type==='controlSource').at(-1).source),3,'Omni mode request');
  await page.evaluate(()=>{window.testSocket.ready=false;window.testSocket.report();});
  equal(await page.locator('#chassisEnable').isDisabled(),true,'Unready group cannot be enabled');
  await page.evaluate(()=>{window.testSocket.ready=true;window.testSocket.report();});
  await page.locator('#chassisEnable').click();await page.locator('#chassisStop').click();
  equal(await page.locator('.enable.on').count(),0,'Chassis stop zeros all wheels');

  await page.locator('#controlSource').selectOption('0');await page.locator('#applySource').click();
  for(let i=0;i<4;i++) equal(await page.locator(`.channel[data-ch="${i}"] [data-role="num"]`).isDisabled(),false,'Web mode restored');
  await page.evaluate(()=>{window.testSocket.autoConfirm=false;});
  await page.locator('#controlSource').selectOption('2');await page.locator('#applySource').click();
  equal(await page.locator('#chassisEnable').isDisabled(),true,'Pending configuration blocks group start');
  for(let i=0;i<4;i++) equal(await page.locator(`.channel[data-ch="${i}"] [data-role="enable"]`).isDisabled(),true,'Pending configuration blocks individual start');
  await page.evaluate(()=>window.testSocket.report(1));
  for(let i=0;i<4;i++) equal(await page.locator(`.channel[data-ch="${i}"] [data-role="enable"]`).isDisabled(),true,'Rejected chassis request cannot fall back to a web start');
  await page.evaluate(()=>{window.testSocket.autoConfirm=true;});
  await page.locator('#controlSource').selectOption('0');await page.locator('#applySource').click();
  equal(await page.locator('.channel[data-ch="0"] [data-role="enable"]').isDisabled(),false,'Confirmed web configuration unlocks start');
  equal(errors,[],'Browser errors');
  await page.locator('#controlSource').selectOption('2');
  await page.screenshot({path:'output/playwright/chassis-controls.png',fullPage:true});
  return ['mecanum/omni selection','four-wheel mapping and reversal','group enable and member stop','duplicate mapping rejection','neutral gate','whole-chassis stop','web mode compatibility','unapplied, pending and rejected configurations cannot start motors'];
}
