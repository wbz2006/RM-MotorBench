async (page) => {
  await page.addInitScript(() => {
    window.confirm = () => true;
    window.sentCommands = [];
    class PreviewSocket {
      static OPEN = 1;
      constructor() {
        this.readyState = 1;
        this.source = 0;
        this.telemetry = {channelId:0,online:true,enabled:false,ref:0,speed:0,torque:0,angle:0,temperature:25};
        setTimeout(() => {
          this.onopen?.();
          this.emit('inventory',{items:[{kind:2,canBus:2,motorId:1,outerLoop:2}]});
          this.report();
        }, 0);
      }
      emit(type,data) { this.onmessage?.({data:JSON.stringify({type,data})}); }
      readings() { this.emit('telemetry',{items:[this.telemetry]}); }
      report() {
        this.emit('controlReport',{result:0,source:this.source,channelId:this.source?0:255,online:true,switchRight:1,ready:true,rocker:0,maxRef:this.source?3000:0});
      }
      send(text) {
        const cmd=JSON.parse(text); window.sentCommands.push(cmd);
        setTimeout(() => {
          if(cmd.type==='listPorts') this.onmessage?.({data:JSON.stringify({type:'ports',ports:[]})});
          if(cmd.type==='bind') this.readings();
          if(cmd.type==='enable') { this.telemetry.enabled=cmd.enable; this.readings(); }
          if(cmd.type==='setRef') { this.telemetry.ref=cmd.ref; this.readings(); }
          if(cmd.type==='controlSource') { this.source=cmd.source; this.telemetry.enabled=false; this.telemetry.ref=0; this.readings(); this.report(); }
        }, 0);
      }
    }
    window.WebSocket=PreviewSocket;
  });
  await page.goto('http://127.0.0.1:3001');
  await page.locator('[data-role="motor"] option[value="0"]').waitFor({state:'attached'});
  await page.locator('[data-role="motor"]').selectOption('0');
  await page.getByRole('button',{name:'绑定',exact:true}).click();
  await page.locator('[data-role="num"]').fill('1500');
  await page.locator('[data-role="num"]').press('Tab');
  page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'使能',exact:true}).click();
  await page.waitForFunction(()=>window.sentCommands.some(c=>c.type==='setRef'&&c.ref===1500));
  await page.locator('#controlSource').selectOption('1');
  await page.getByRole('button',{name:'应用控制方式',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-role="num"]').disabled);
  if(!await page.locator('[data-role="slider"]').isDisabled()) throw Error('Remote mode leaves web speed active');
  await page.locator('#controlSource').selectOption('0');
  await page.getByRole('button',{name:'应用控制方式',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-role="num"]').disabled);
  console.log('PASS: web 1500 rpm, source switch acknowledgement, remote disables web input, switch back restores it');
  await page.screenshot({path:'output/playwright/motor-bench-controls.png',fullPage:true});
}
