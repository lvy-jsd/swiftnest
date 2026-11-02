/** nix develop --command env SWIFTNEST_SCREEN_E2E=1 pnpm vitest run server/test/live.test.ts */
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { LiveView, type LiveUpdate } from '@swiftnest/api';
import { startScreenFixture } from '../../client/test/fixtures/screenHost.js';

it.skipIf(process.env.SWIFTNEST_SCREEN_E2E!=='1')('headless wlroots: real screenshot, approved agent click, encrypted owner relay, take-over and local stop', async () => {
  const { hub, appUrl, clicks, errors, send, last, close } = await startScreenFixture();
  let viewer:LiveView|undefined;
  try {
    const device=hub.nest.devices()[0]!.device;
    const api=(path:string,method='GET')=>fetch(appUrl+'/swiftnest/api/devices'+path,{method,headers:{authorization:'Bearer owner-session'}});
    expect((await api(`/live?device=${device}`,'POST')).status).toBe(409);
    send({op:'start',settings:{...last().settings,allowLiveView:true}});await expect.poll(()=>last()?.settings.allowLiveView&&last()?.phase==='online').toBe(true);
    const call=async(cap:string,tool:string,args:Record<string,unknown>)=>hub.nest.call(`${device}__${cap}__${tool}`,args,{id:'test-agent'});
    const info=await call('screen','screen_info',{});const displays=(await hub.nest.tasks.wait(info.id,10000)).result?.data as any;expect(displays.backend).toBe('wlroots');
    const task=await call('screen','screen_capture',{maxDimension:640,format:'png'});const captured=await hub.nest.tasks.wait(task.id,10000);expect(captured.state).toBe('succeeded');
    const data=captured.result!.data as any;expect(Buffer.from(data.data,'base64').subarray(1,4).toString()).toBe('PNG');expect(data.width).toBe(640);expect(data.scaleFactor).toBeLessThanOrEqual(1);
    const args={displayId:data.displayId,captureId:data.captureId,x:data.width/2,y:data.height/2};
    const click=await call('input','input_click',args);expect(click.state).toBe('pending_approval');expect(clicks).toHaveLength(0);await hub.nest.tasks.approve(click.id);
    expect((await hub.nest.tasks.wait(click.id,10000)).state).toBe('succeeded');await expect.poll(()=>clicks.length).toBe(1);
    const response=await api(`/live?device=${device}&maxDimension=640`,'POST');expect(response.status).toBe(200);const offer=await response.json();
    const forbidden=new WebSocket(appUrl.replace('http:','ws:')+`/swiftnest/api/devices/live?id=${offer.id}`);
    await new Promise<void>(r=>forbidden.once('error',()=>r()));
    const socket=new WebSocket(appUrl.replace('http:','ws:')+`/swiftnest/api/devices/live?id=${offer.id}`,{headers:{authorization:'Bearer owner-session'}});
    viewer=await LiveView.open(socket,offer);const updates:LiveUpdate[]=[];void(async()=>{for await(const update of viewer!)updates.push(update);})();
    await expect.poll(()=>updates.some(v=>!!v.frame),{timeout:15000,message:errors.join('\n')}).toBe(true);
    await viewer.takeOver();await expect.poll(()=>updates.at(-1)?.control,{timeout:10000}).toBe('owner');
    const blocked=await call('input','input_click',args);expect(blocked.state).toBe('pending_approval');await hub.nest.tasks.approve(blocked.id);expect((await hub.nest.tasks.wait(blocked.id,5000)).error?.code).toBe('OWNER_HAS_CONTROL');expect(clicks).toHaveLength(1);
    await viewer.input('input_click',args);await expect.poll(()=>clicks.length).toBe(2);
    await viewer.handBack();await expect.poll(()=>updates.at(-1)?.control,{timeout:10000}).toBe('ivy');
    const resumed=await call('input','input_click',args);await hub.nest.tasks.approve(resumed.id);expect((await hub.nest.tasks.wait(resumed.id,5000)).state).toBe('succeeded');await expect.poll(()=>clicks.length).toBe(3);
    await viewer.takeOver();await expect.poll(()=>updates.at(-1)?.control,{timeout:10000}).toBe('owner');send({op:'stop-view'});
    await expect.poll(()=>updates.at(-1)?.control,{timeout:10000}).toBe('paused');await expect.poll(()=>last()?.watching===false&&last()?.ownerControl===false,{timeout:10000}).toBe(true);
    expect((await api(`/live?device=${device}`,'POST')).status).toBe(409);
  } catch(error) { throw new Error(String(error)+'\n'+errors.slice(-15).join('\n'),{cause:error}); } finally {
    viewer?.close();await close();
  }
},60000);
